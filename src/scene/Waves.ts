/**
 * The single source of truth for the sea surface.
 *
 * The same Gerstner sum is evaluated in two places:
 *   - on the GPU, in the ocean vertex shader (see `shaders/lib.ts`, GLSL_WAVES)
 *   - on the CPU, here, for raft buoyancy
 *
 * PARAMETER SPACE — the contract that keeps them identical
 * -------------------------------------------------------
 * Per-wave phase is advanced once per simulation step in double precision and
 * uploaded verbatim, so the shader never sees absolute time or absolute world
 * position — only a bounded parameter position plus a wrapped phase:
 *
 *     phase[i] = ( k[i]*(d[i] . origin) - omega[i]*t + seed[i] )  mod 2pi
 *     phi_i(p) = k[i]*(d[i] . p) + phase[i]
 *
 * `origin` is the presentation origin of the **local render frame**. The
 * renderer is raft-centred and the raft never leaves local (0, 0), so in
 * production it is fixed at (0, 0); the diagnostic harness is the only thing
 * that moves it. It is a phase offset, not a position: canonical travel lives
 * in `PlanetaryWorld` (see ADR-002). Every consumer expresses `p` in *local
 * render coordinates*: the same coordinates three.js objects are positioned in.
 * `sample(x, z)` takes local render coordinates; the ocean disc, drawn at its
 * own local position, adds that centre through the `uWaveOrigin` uniform. One
 * space, one clock, no per-consumer conventions.
 *
 * Anchoring to the render origin rather than to the raft is deliberate. It lets
 * anything — the raft, a debug probe, a marker, a future second floating
 * object — sample the surface at the position it is drawn at, with no
 * conversion to get wrong. Getting that conversion wrong is exactly the bug
 * this contract exists to prevent.
 *
 * WHERE THE COMPONENTS COME FROM
 * ------------------------------
 * They are no longer hand-written. `src/ocean/` holds a physical sea-state
 * model — wind speed and development, primary and secondary swell — and a
 * JONSWAP discretisation that turns it into the component table below. This
 * file owns evaluation and phase; it does not decide what the sea is.
 *
 * PHASE CONTINUITY UNDER PARAMETER CHANGE
 * ---------------------------------------
 * Phase stays a pure function of the current time and each slot's stored seed
 * offset — never an accumulator — so it carries no drift however long the
 * session runs and `setTime()` can jump anywhere exactly.
 *
 * Morphing a sea state without popping is then a matter of *re-seeding* rather
 * than of integrating. Change a slot's frequency and `-omega*t` jumps by
 * `delta_omega * t`, which at ten minutes in is several radians: the wave
 * teleports. So `applySeaState(state, continuous)` solves for the seed offset
 * that leaves the slot's total phase exactly where it already was, and stores
 * that. The wave keeps its phase and changes only its rate, and the field is
 * still reproducible from absolute time — the offsets are part of the state.
 */

import type { SeaState, SlotBudget } from '../ocean/seaState';
import {
  MAX_WAVES as SEA_MAX_WAVES,
  SLOTS_DEFAULT,
  bandSteepness,
  resolveSeaState,
} from '../ocean/seaState';
import { findSeaState, PRODUCTION_SEA_STATE } from '../ocean/presets';
import {
  allLayers,
  breakingThresholdComposite,
  coxMunkSlopeVariance,
  effectiveGrowthWind,
  layerOf,
  safeCompositeQ,
} from '../ocean/spectrum';
import type { LayerMask, SeaLayer, WaveComponent } from '../ocean/spectrum';

const GRAVITY = 9.81;
const TWO_PI = Math.PI * 2;

function wrapTwoPi(value: number): number {
  const wrapped = value % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

/**
 * Slots reserved in the shader's uniform arrays. States shorter than this leave
 * the remaining slots at zero amplitude, which the shader skips, so the wave
 * field can be swapped without recompiling the ocean material.
 */
export const MAX_WAVES = SEA_MAX_WAVES;

/**
 * Shortest component the fragment stage's residual term evaluates per pixel.
 * Anything shorter contributes only its variance to roughness.
 *
 * This is a *cost* valve, not a correctness one, and it is set to include
 * everything on desktop. Measured at 3200x1800, the whole residual loop costs
 * 2.1 ms of a 29 ms frame with all 48 components, and 0.4 ms with a 9 m cut —
 * so the saving is small and the cost of the cut is not: between roughly 30 m
 * and 200 m the geometry has already faded short components out while the pixel
 * footprint can still resolve them, and turning their slope into roughness
 * there washes the mid-distance out to a pale sheet.
 *
 * Mobile takes the cut, because a phone's fill rate is the binding constraint
 * and its lower vertex density has already coarsened that band anyway.
 */
export const RESIDUAL_MIN_WAVELENGTH_DESKTOP = 1.2;
export const RESIDUAL_MIN_WAVELENGTH_MOBILE = 9.0;

/**
 * Least share of the Cox–Munk total that is always below the geometry's reach.
 *
 * Mean square slope accumulates about evenly per octave of wavenumber from the
 * spectral peak to the capillary cut-off. The components stop at 3.5 m (1.1 m
 * with micro chop) and the capillary end is near 5 mm, so roughly nine octaves
 * of slope are permanently out of the geometry's reach against the two or three
 * it resolves. Three quarters is the conservative reading of that ratio, and it
 * is what keeps a large swell from ever emptying the shading's roughness budget.
 * See `unresolvedSlopeVariance` for what happens without it.
 */
export const UNRESOLVED_MIN_SHARE = 0.75;

export interface SurfaceSample {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  /** Water particle velocity at the surface, m/s. */
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  /**
   * Determinant of the horizontal Gerstner Jacobian. 1 is undisturbed spacing,
   * below 1 is horizontal compression, and 0 would be a fold.
   */
  jacobian: number;
  /**
   * Trace of the Jacobian perturbation: the downward crest acceleration in
   * units of g, scaled by Q. This is the breaking indicator the whitecap
   * threshold and the spray emitter key off. See `breakingThreshold`.
   */
  compression: number;
}

export function createSurfaceSample(): SurfaceSample {
  return {
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    jacobian: 1,
    compression: 0,
  };
}

/**
 * The surface at an *undisplaced parameter* point, plus where that point is
 * drawn. The forward evaluation, with no inverse solve.
 *
 * `SurfaceSample` answers "what is visible at this world position", which is the
 * question buoyancy asks, and it pays a seven-iteration Newton solve to answer
 * it. Whitewater asks the opposite question — "this parcel of water is
 * breaking; where is it on screen" — and inverting a displacement only to
 * re-apply it is both wasteful and wrong at the margins.
 *
 * It is also the space the answer belongs in. A Gerstner particle orbits about a
 * fixed parameter position, so a breaking ridge is a stationary curve in `p`
 * however violently it is moving in world space, and `FoamField` stores its
 * whitewater against exactly this coordinate for exactly that reason. A crest
 * feature traced here therefore lands on the same water the foam shader
 * whitened, by construction rather than by tuning.
 */
export interface SeedSample {
  /** Where this parameter point is drawn, in local render coordinates. */
  x: number;
  z: number;
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  jacobian: number;
  /** The breaking indicator. Same definition, same units as `SurfaceSample`. */
  compression: number;
}

export function createSeedSample(): SeedSample {
  return {
    x: 0,
    z: 0,
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    jacobian: 1,
    compression: 0,
  };
}

export class WaveField {
  /** Number of active components; the shader always loops MAX_WAVES. */
  count = 0;

  /** (dirX, dirZ, amplitude, k) per wave — uploaded straight to the shader. */
  readonly waveA = new Float32Array(MAX_WAVES * 4);
  /** (Q, phase, lodFadeStart, lodFadeEnd) per wave. */
  readonly waveB = new Float32Array(MAX_WAVES * 4);

  /**
   * Fragment-only wavelength-ordered view of the active canonical components.
   * Vertex displacement, buoyancy and slot identity continue to use waveA/B.
   * residualWaveB.x stores prefix slope energy before this sorted component;
   * Q is irrelevant to the residual-gradient stage.
   */
  readonly residualWaveA = new Float32Array(MAX_WAVES * 4);
  readonly residualWaveB = new Float32Array(MAX_WAVES * 4);
  residualActiveCount = 0;
  residualTotalSlopeEnergy = 0;

  /** Global amplitude multiplier, exposed to the debug panel. */
  amplitude = 1.0;

  /** Sum of component amplitudes at `amplitude === 1`; the theoretical crest. */
  amplitudeSum = 0;

  /** Significant wave height of the resolved sea, metres. */
  significantHeight = 0;

  /**
   * Sum of Q*A*k. The surface can fold where this exceeds 1, but only where the
   * components happen to align — a several-sigma event, see `safeGlobalQ`.
   * Measured every time the sea changes, never assumed.
   */
  steepnessSum = 0;

  /** Mean square slope carried by the resolved components, `Σ(ak)²/2`. */
  meanSquareSlope = 0;

  /**
   * Roughness the fragment shader must supply statistically: the Cox–Munk total
   * for this wind minus what the geometry already resolves. Replaces a
   * hand-tuned constant with a derived one that tracks the sea state.
   */
  unresolvedSlopeVariance = 0;

  /** Compression above which the surface is breaking. See `breakingThresholdComposite`. */
  breakingThreshold = 0.3;

  /** The global Gerstner Q before the per-band steepness fraction. */
  globalQ = 1;

  /**
   * Largest single term of the breaking indicator (the dominant carrier's
   * `Q·a·k`) and the standard deviation of the rest. Together they describe
   * the carrier-plus-Gaussian distribution the whitecap threshold is
   * calibrated against; the diagnostics and tests read them to reproduce the
   * calibration independently.
   */
  breakingDominant = 0;
  breakingSigmaRest = 0;

  /**
   * Standard deviation of the breaking indicator under its calibrated
   * carrier-plus-Gaussian model: the dominant carrier contributes half its
   * squared amplitude (a sinusoid's variance), the rest is Gaussian.
   */
  get breakingSigma(): number {
    return Math.sqrt(
      0.5 * this.breakingDominant * this.breakingDominant +
        this.breakingSigmaRest * this.breakingSigmaRest,
    );
  }

  /**
   * Transition band of the whitecap decision, in indicator units.
   *
   * Expressed as threshold ± k·sigma rather than as fixed fractions of the
   * threshold. The exceedance calibration pins where the threshold IS; this
   * band only shapes the smoothstep around it, and a band fixed in absolute
   * units (the old 0.80T..1.25T) silently widened the credited area whenever
   * micro chop widened the indicator's distribution — foam quantity tracked a
   * debug control instead of the physics. k0/k1 are calibrated once so the
   * shipping CURRENT_MODERATE state (T/sigma = 2.810) reproduces the exact
   * old band and stays pixel-identical: k0 = 0.2·2.810, k1 = 0.25·2.810.
   */
  breakBand(out: [number, number]): [number, number] {
    const sigma = this.breakingSigma;
    const lo = this.breakingThreshold - 0.562 * sigma;
    const hi = this.breakingThreshold + 0.702 * sigma;
    out[0] = lo;
    out[1] = Math.max(hi, lo + 1e-5);
    return out;
  }

  /**
   * Derived slope amplitude for the fragment detail-noise octaves.
   *
   * The noise chain's job is to carry the slope variance of the real sea that
   * the discrete components deliberately do not resolve, so its amplitude is
   * *derived* from that unresolved variance rather than hand-set per preset:
   * `κ·√(unresolved)`, with κ calibrated once so the shipping moderate ocean
   * reproduces its pre-round detail amplitude (0.105). Presets multiply this
   * by a dimensionless gain (`roughness.detailStrength`, default 1) instead of
   * overwriting it, so the texture tracks the wind across every weather state.
   */
  detailAmplitude = 0.105;

  state: SeaState;

  /** Residual of the last horizontal inverse solve, metres. Measured, not assumed. */
  lastSolveResidual = 0;
  /** Largest inverse-displacement residual seen over this field's lifetime. */
  maximumSolveResidual = 0;

  private readonly dirX = new Float64Array(MAX_WAVES);
  private readonly dirZ = new Float64Array(MAX_WAVES);
  private readonly baseAmp = new Float64Array(MAX_WAVES);
  private readonly k = new Float64Array(MAX_WAVES);
  private readonly omega = new Float64Array(MAX_WAVES);
  private readonly q = new Float64Array(MAX_WAVES);
  private readonly seedPhase = new Float64Array(MAX_WAVES);
  /** Phase accumulated in double precision, wrapped to [0, 2pi). */
  private readonly phase = new Float64Array(MAX_WAVES);
  /** Carrier index a slot is a phase-locked harmonic of, or -1 for free waves. */
  private readonly boundTo = new Int32Array(MAX_WAVES).fill(-1);
  /** Bound harmonic's phase offset relative to twice its carrier's phase. */
  private readonly boundPhase = new Float64Array(MAX_WAVES);
  /** Which diagnostic layer each slot belongs to. See `SeaLayer`. */
  private readonly layer: Array<Exclude<SeaLayer, 'detail'>> = new Array(MAX_WAVES).fill('swell');
  private readonly residualOrder = new Int32Array(MAX_WAVES).fill(-1);
  private readonly residualSortScratch = new Int32Array(MAX_WAVES);

  /**
   * Diagnostic layer mute. Applied to the emitted amplitudes only, at the very
   * end of `applySeaState` — every derived quantity above it (Q, the breaking
   * threshold, the unresolved slope band that sizes the detail noise) is
   * computed from the WHOLE sea first. So a muted layer shows the remaining
   * ones exactly as they appear in the real composition, rather than as a
   * different, smaller sea that happens to contain them.
   *
   * All true in every normal path; only the ocean lab moves it.
   */
  layerMask: LayerMask = allLayers();

  private simTime = 0;
  private originX = 0;
  private originZ = 0;
  private lodSpacing = 0.027;
  private budget: SlotBudget;
  private dominantPeriodValue = 0;
  private frameHeadingDeg = 0;

  constructor(
    state: SeaState = findSeaState(PRODUCTION_SEA_STATE),
    budget: SlotBudget = SLOTS_DEFAULT,
  ) {
    this.budget = budget;
    this.state = state;
    this.applySeaState(state);
  }

  /** Deterministic simulation time, seconds. */
  get time(): number {
    return this.simTime;
  }

  get originWorldX(): number {
    return this.originX;
  }

  get originWorldZ(): number {
    return this.originZ;
  }

  /** Peak period of the highest-energy wave system, seconds. */
  get dominantPeriod(): number {
    return this.dominantPeriodValue;
  }

  /**
   * Rotation from the sea state's local tangent headings into render axes.
   * Set from the transported frame so a course change turns the whole sea
   * coherently. It is a presentation rotation and carries no position.
   */
  setFrameHeadingDeg(deg: number): void {
    if (Math.abs(deg - this.frameHeadingDeg) < 1e-9) return;
    this.frameHeadingDeg = deg;
    this.applySeaState(this.state, true);
  }

  get frameHeading(): number {
    return this.frameHeadingDeg;
  }

  /**
   * Mute or unmute diagnostic layers. Continuous, so a layer fades in and out
   * of an already-running sea without resetting a single phase.
   */
  setLayerMask(mask: Partial<LayerMask>): void {
    this.layerMask = { ...this.layerMask, ...mask };
    this.applySeaState(this.state, true);
  }

  /**
   * Adopt a sea state.
   *
   * `continuous` keeps each slot's accumulated phase, so a morphing transition
   * neither pops nor resets. Without it, phase is rebuilt from absolute time,
   * which is the deterministic path every test and capture uses.
   */
  applySeaState(state: SeaState, continuous = false): void {
    // Snapshot the phase every slot is currently at, so a continuous change can
    // put it back exactly. See the note on phase continuity in the file header.
    const previousPhase = continuous ? Float64Array.from(this.phase) : undefined;
    const previousCount = this.count;

    this.state = state;
    const spectrum = resolveSeaState(state, this.budget, this.frameHeadingDeg);
    const components = spectrum.components;
    const n = Math.min(components.length, MAX_WAVES);
    this.count = n;
    this.amplitudeSum = spectrum.amplitudeSum;
    this.significantHeight = spectrum.significantHeight;
    this.dominantPeriodValue = spectrum.dominantPeriod;
    this.meanSquareSlope = spectrum.meanSquareSlope;

    this.waveA.fill(0);
    this.waveB.fill(0);
    for (let i = n; i < MAX_WAVES; i++) {
      this.dirX[i] = 0;
      this.dirZ[i] = 0;
      this.baseAmp[i] = 0;
      this.k[i] = 0;
      this.omega[i] = 0;
      this.q[i] = 0;
      this.phase[i] = 0;
      this.boundTo[i] = -1;
      this.boundPhase[i] = 0;
    }

    // First pass: geometry. Every slot gets its dispersion omega here; bound
    // harmonics are re-slaved to twice their carrier's omega below, which is
    // what makes them the *shape of the carrier wave* rather than a free wave
    // that happens to start aligned.
    for (let i = 0; i < n; i++) {
      const c: WaveComponent = components[i];
      this.dirX[i] = c.dirX;
      this.dirZ[i] = c.dirZ;
      this.baseAmp[i] = c.amplitude;
      this.k[i] = TWO_PI / c.wavelength;
      this.omega[i] = Math.sqrt(GRAVITY * this.k[i]);
      this.seedPhase[i] = c.seedPhase;
      this.boundTo[i] = c.boundTo;
      this.boundPhase[i] = c.boundPhase;
      this.layer[i] = layerOf(c.band, c.role);
    }

    // Crest sharpness.
    //
    // Q = 1 is the physically correct trochoid: circular Lagrangian particle
    // orbits of radius A. The surface folds where Sum(Q A k sin phi) exceeds 1.
    // The composed field is carrier-dominated, deliberately, so the cap treats
    // the top terms deterministically and only the long tail statistically —
    // see `safeCompositeQ`. That lets the dominant crests run visibly steeper
    // than the old all-Gaussian bound allowed while making the no-fold
    // guarantee stronger, because it no longer pretends the carrier is
    // Gaussian. Bound harmonics carry Q = 0: they are vertical profile only,
    // cannot fold, and leave the inverse solve's conditioning untouched.
    const steepnessTerms: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.boundTo[i] >= 0) continue;
      steepnessTerms.push(bandSteepness(state, components[i].band) * this.baseAmp[i] * this.k[i]);
    }
    const qLimit = safeCompositeQ(steepnessTerms);
    this.globalQ = qLimit;

    let steepnessSum = 0;
    for (let i = 0; i < n; i++) {
      const q = this.boundTo[i] >= 0 ? 0 : bandSteepness(state, components[i].band) * qLimit;
      this.q[i] = q;
      steepnessSum += q * this.baseAmp[i] * this.k[i];
    }

    // Slave each bound harmonic to its carrier: omega is exactly twice the
    // carrier's (NOT the free-dispersion omega of a wave half the length), and
    // the seed is derived so that phase ≡ 2·(carrier phase) + boundPhase at
    // every time and origin. The lock is algebraic, not integrated, so it can
    // never drift.
    for (let i = 0; i < n; i++) {
      const carrier = this.boundTo[i];
      if (carrier < 0) continue;
      this.omega[i] = 2 * this.omega[carrier];
      this.seedPhase[i] = wrapTwoPi(2 * this.seedPhase[carrier] + this.boundPhase[i]);
    }

    // Backstop. The inverse solve's two fixed-point steps are a guaranteed
    // contraction only while this stays below 1, and beyond that they are
    // merely a good starting guess for Newton. Newton's basin is far wider, and
    // the residual is measured every sample, but a hard ceiling keeps the
    // conditioning bounded no matter what a lab slider is set to.
    const LIMIT = 1.25;
    if (steepnessSum > LIMIT) {
      const scale = LIMIT / steepnessSum;
      for (let i = 0; i < n; i++) this.q[i] *= scale;
      this.globalQ *= scale;
      steepnessSum = LIMIT;
    }
    this.steepnessSum = steepnessSum;

    // The breaking indicator's actual distribution: its largest single term
    // (the dominant carrier) plus the standard deviation of everything else.
    // The whitecap threshold is calibrated against exactly this, not against a
    // Gaussian the composed field deliberately is not.
    let dominant = 0;
    let restVariance = 0;
    for (let i = 0; i < n; i++) {
      const t = this.q[i] * this.baseAmp[i] * this.k[i];
      if (t > dominant) {
        restVariance += 0.5 * dominant * dominant;
        dominant = t;
      } else {
        restVariance += 0.5 * t * t;
      }
    }
    this.breakingDominant = dominant;
    this.breakingSigmaRest = Math.sqrt(restVariance);
    // WX2 KNOWINGLY LEFT THIS ON THE SEA'S WIND. Two winds exist now (see
    // `seaState.ts`'s header) and this file only ever sees one of them, because
    // it is handed a sea state and nothing else. That turns out to be the right
    // one anyway: the threshold is calibrated against Monahan coverage *for this
    // sea*, so it belongs with the sea. And `generatingWind.speedMps` is
    // `max(wind now, developed wind)` while the wind is freshening, so it
    // answers a fresh breeze immediately, which is what breaking does.
    this.breakingThreshold = breakingThresholdComposite(
      dominant,
      this.breakingSigmaRest,
      state.generatingWind.speedMps,
      state.whitewater.thresholdBias,
    );

    // Roughness the shading must supply statistically: the Cox–Munk total for
    // this wind (seen through the same validity ceiling as the growth laws)
    // minus what the geometry already resolves.
    //
    // THE SUBTRACTION NEEDS A FLOOR, AND THE FLOOR IS PHYSICS, NOT SAFETY
    //
    // Left unbounded this goes to exactly zero whenever the resolved components
    // carry more slope than Cox–Munk allots to the wind — which a big swell
    // under a light wind does easily, and which the ocean lab reaches with one
    // slider. At zero the derived detail amplitude is zero too, so the fragment
    // stage loses BOTH its ripple geometry and its statistical roughness at
    // once: `alphaGlitter` and `alphaReflect` fall to their floors and the sea
    // becomes a polished mirror draped over the swell. That is the reported
    // "weird blobby glass ocean" — smooth, rounded, unmistakably not water —
    // and it appears at a primary swell of about 3.7 m over a 6 m/s wind.
    //
    // Zero is not a defensible answer, because the subtraction is comparing
    // different bands. Cox–Munk's mean square slope accumulates roughly evenly
    // per octave of wavenumber from the spectral peak up to the capillary
    // cut-off near 5 mm. The geometry resolves down to MIN_WAVELENGTH — 3.5 m,
    // or 1.1 m with micro chop — so between the shortest component drawn and
    // the capillary end there are still some nine octaves of real slope that no
    // component can ever carry, against two or three the components do carry.
    // At least three quarters of the total therefore lives below the resolution
    // floor no matter what the swell is doing, and a 60 m swell contributes
    // nothing whatever to the band Cox–Munk's wind regression describes.
    //
    // Hence a floor at `UNRESOLVED_MIN_SHARE` of the Cox–Munk total rather than
    // at zero. Every shipping preset already sits well above it (the lowest is
    // Crossing seas at 0.83), so this changes nothing that exists and stops the
    // collapse that a lab slider — or a future weather state — can drive into.
    //
    // WX2 KNOWINGLY LEFT THIS ONE TOO, and less comfortably than the threshold
    // above. Cox–Munk is a *present-wind* regression on sun glitter, so of the
    // two winds it wants the wind now — and while the wind is freshening it
    // gets it, because the sea's record carries `max(wind now, developed wind)`.
    // On a dying wind it does not: the statistical roughness stays up with the
    // water rather than falling with the air. Re-pointing it means plumbing the
    // present wind into `applySeaState`, which is a change to the CPU/GPU parity
    // contract and not this round's to make. Reported in the WX2 handover.
    const coxMunk = coxMunkSlopeVariance(
      effectiveGrowthWind(state.generatingWind.speedMps),
    );
    this.unresolvedSlopeVariance = Math.max(
      coxMunk - spectrum.meanSquareSlope,
      coxMunk * UNRESOLVED_MIN_SHARE,
    );

    // Detail-noise amplitude, derived from the unresolved band.
    //
    // κ = 0.92, raised from the 0.62 that merely reproduced the pre-round
    // hand-set amplitude. The new value is derived rather than tasted: at 0.62
    // the five drawn octaves carried a slope variance of about 0.013 against
    // an unresolved band of 0.029 at the production sea — the geometry was
    // DRAWING LESS THAN HALF of the roughness it had already decided the
    // components could not carry, and handing the rest to a specular lobe.
    // That is the wrong home for it twice over: the lobe cannot make a
    // highlight at midday's 2 % Fresnel (it peaks below display white, which
    // is why the noon sea had no sparkle at all), and a drawn facet can.
    //
    // Slope variance goes as amplitude squared, so consuming the whole band
    // needs κ scaled by √(0.029/0.013) ≈ 1.49 — hence 0.92. This moves
    // roughness from statistics into geometry and invents none: the total is
    // still the Cox–Munk figure, and `uUnresolvedSlopeVariance` simply falls
    // to near zero in the near field while the Nyquist fades hand each octave
    // back to the lobe as it stops being resolvable.
    //
    // The cap rises with it, 0.22 → 0.30, so a storm's larger band is not
    // clipped back to the old ceiling the moment the coefficient can use it.
    this.detailAmplitude = Math.min(0.92 * Math.sqrt(this.unresolvedSlopeVariance), 0.30);

    // Diagnostic layer mute, last of all — see `layerMask`. Zeroing the
    // amplitude rather than skipping the slot keeps slot identity intact, so
    // the mask can be toggled mid-transition without shifting anything.
    for (let i = 0; i < n; i++) {
      if (!this.layerMask[this.layer[i]]) this.baseAmp[i] = 0;
    }

    this.writeStaticUniforms();
    this.setLodSpacing(this.lodSpacing);

    if (previousPhase) {
      // Re-seed each free slot so its total phase is exactly what it was an
      // instant ago, whatever changed about its frequency, direction or the
      // origin. Phase is then continuous through any parameter change, and
      // `setTime()` still replays exactly from absolute time — the offsets are
      // part of the state, not an accumulator.
      const t = this.simTime;
      for (let i = 0; i < n; i++) {
        if (this.boundTo[i] >= 0) continue;
        const target = i < previousCount ? previousPhase[i] : this.freshPhase(i);
        const spatial =
          this.k[i] * (this.dirX[i] * this.originX + this.dirZ[i] * this.originZ);
        this.seedPhase[i] = wrapTwoPi(target - spatial + this.omega[i] * t);
        this.phase[i] = target;
      }
      // Bound harmonics stay locked to their carrier rather than to their own
      // past: the carrier's phase is continuous, so the lock is continuous
      // too, and a lean that changes mid-morph keeps taking effect instead of
      // being frozen at whatever it was when the morph began.
      for (let i = 0; i < n; i++) {
        const carrier = this.boundTo[i];
        if (carrier < 0) continue;
        this.seedPhase[i] = wrapTwoPi(2 * this.seedPhase[carrier] + this.boundPhase[i]);
        this.phase[i] = wrapTwoPi(2 * this.phase[carrier] + this.boundPhase[i]);
      }
      this.writePhaseUniforms();
    } else {
      this.refreshPhases();
    }
  }

  /** Phase a slot would have from absolute time with its declared seed. */
  private freshPhase(i: number): number {
    const spatial = this.k[i] * (this.dirX[i] * this.originX + this.dirZ[i] * this.originZ);
    return wrapTwoPi(spatial - this.omega[i] * this.simTime + this.seedPhase[i]);
  }

  private writeStaticUniforms(): void {
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * 4;
      this.waveA[o + 0] = this.dirX[i];
      this.waveA[o + 1] = this.dirZ[i];
      this.waveA[o + 2] = this.baseAmp[i];
      this.waveA[o + 3] = this.k[i];
      this.waveB[o + 0] = this.q[i];
    }
  }

  /** Rebuild the render-only table without touching canonical slot identity. */
  private rebuildResidualTable(): void {
    let count = 0;
    for (let canonical = 0; canonical < MAX_WAVES; canonical++) {
      const offset = canonical * 4;
      if (this.waveA[offset + 2] <= 0 || this.waveA[offset + 3] <= 0) continue;
      this.residualSortScratch[count++] = canonical;
    }

    // Forty-eight entries do not justify allocating or calling a general sort
    // during a sea-state morph. Insertion sort is stable, allocation-free, and
    // makes canonical slot identity the deterministic tie-break for equal k.
    for (let i = 1; i < count; i++) {
      const canonical = this.residualSortScratch[i];
      const k = this.waveA[canonical * 4 + 3];
      let j = i - 1;
      while (j >= 0) {
        const previous = this.residualSortScratch[j];
        const previousK = this.waveA[previous * 4 + 3];
        if (previousK < k || (previousK === k && previous < canonical)) break;
        this.residualSortScratch[j + 1] = previous;
        j--;
      }
      this.residualSortScratch[j + 1] = canonical;
    }

    this.residualWaveA.fill(0);
    this.residualWaveB.fill(0);
    this.residualOrder.fill(-1);
    let prefixEnergy = 0;
    for (let sorted = 0; sorted < count; sorted++) {
      const canonical = this.residualSortScratch[sorted];
      const source = canonical * 4;
      const target = sorted * 4;
      this.residualOrder[sorted] = canonical;
      this.residualWaveA[target] = this.waveA[source];
      this.residualWaveA[target + 1] = this.waveA[source + 1];
      this.residualWaveA[target + 2] = this.waveA[source + 2];
      this.residualWaveA[target + 3] = this.waveA[source + 3];
      this.residualWaveB[target] = prefixEnergy;
      this.residualWaveB[target + 1] = this.waveB[source + 1];
      this.residualWaveB[target + 2] = this.waveB[source + 2];
      this.residualWaveB[target + 3] = this.waveB[source + 3];

      const slope = this.waveA[source + 2] * this.waveA[source + 3];
      prefixEnergy += 0.5 * slope * slope;
    }
    this.residualActiveCount = count;
    // Match the float uniform and Float32 prefix entries the shader receives.
    this.residualTotalSlopeEnergy = Math.fround(prefixEnergy);
  }

  /**
   * Level-of-detail fade radii. A component is faded out once the ocean mesh
   * can no longer sample it above roughly four points per wavelength; past that
   * radius it would only alias, and at those distances its contribution is
   * already sub-pixel. What is lost from the geometry is picked up by the
   * fragment shader's residual slope and statistical roughness.
   */
  setLodSpacing(spacingPerMetre: number): void {
    this.lodSpacing = spacingPerMetre;
    for (let i = 0; i < MAX_WAVES; i++) {
      const o = i * 4;
      if (i >= this.count || this.k[i] <= 0) {
        // Unused slot: amplitude is zero, so the shader skips it regardless.
        this.waveB[o + 2] = 1e9;
        this.waveB[o + 3] = 1e9;
        continue;
      }
      const wavelength = TWO_PI / this.k[i];
      const rFade = wavelength / (4.5 * Math.max(spacingPerMetre, 1e-5));
      this.waveB[o + 2] = rFade * 0.7;
      this.waveB[o + 3] = rFade * 1.35;
    }
    this.rebuildResidualTable();
  }

  /** Change the device slot budget. Rebuilds the component table. */
  setSlotBudget(budget: SlotBudget): void {
    this.budget = budget;
    this.applySeaState(this.state);
  }

  /**
   * Presentation origin of the local render frame, in the shared parameter
   * space. This scrolls procedural phase only: it is never geographic position
   * and is never a second voyage state — `PlanetaryWorld` remains the sole
   * authority for where the vessel actually is. Production advances it from
   * the current through-water velocity so a vessel kept at local (0, 0) still
   * encounters spatially different water; diagnostics may also set it directly.
   */
  setOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.refreshPhases();
  }

  /** Jump to an exact simulation time. Deterministic and free of accumulation. */
  setTime(t: number): void {
    this.simTime = t;
    this.refreshPhases();
  }

  /** When true, `advance()` is a no-op — used for spatial-parity inspection. */
  frozen = false;

  /**
   * Advance time and observer travel through the instantaneous local wave field
   * in one operation. The optional velocity is in metres per ordinary physics
   * second, never astronomical/world-clock seconds. Updating both before one
   * phase rebuild keeps encounter motion on the same fixed substep as buoyancy.
   */
  advance(
    dt: number,
    observerVelocityX = 0,
    observerVelocityZ = 0,
  ): void {
    if (this.frozen) return;
    this.simTime += dt;
    this.originX += observerVelocityX * dt;
    this.originZ += observerVelocityZ * dt;
    this.refreshPhases();
  }

  /**
   * Rebuild phase from absolute time.
   *
   * Deliberately *not* an accumulator: phase is a pure function of the current
   * simulation time and each slot's stored seed offset, so it carries no drift
   * however long the session runs and `setTime()` can jump anywhere exactly.
   * Continuity across a parameter change is supplied by re-seeding the offsets
   * in `applySeaState()`, which is a change of state rather than of method.
   */
  private refreshPhases(): void {
    const t = this.simTime;
    for (let i = 0; i < this.count; i++) {
      const spatial = this.k[i] * (this.dirX[i] * this.originX + this.dirZ[i] * this.originZ);
      this.phase[i] = wrapTwoPi(spatial - this.omega[i] * t + this.seedPhase[i]);
    }
    this.writePhaseUniforms();
  }

  private writePhaseUniforms(): void {
    for (let i = 0; i < MAX_WAVES; i++) this.waveB[i * 4 + 1] = this.phase[i];
    for (let sorted = 0; sorted < this.residualActiveCount; sorted++) {
      const canonical = this.residualOrder[sorted];
      this.residualWaveB[sorted * 4 + 1] = this.waveB[canonical * 4 + 1];
    }
  }

  /**
   * Invert the horizontal Gerstner displacement: find the seed point whose
   * displaced position is (x, z).
   *
   * Two fixed-point steps first, because `s -> x - D(s)` is a guaranteed
   * contraction (the Q normalisation holds `sum(Q A k) < 1`) and gets us into
   * Newton's basin from any start; then Newton on `s + D(s) - x = 0` with the
   * analytic 2x2 Jacobian, which converges quadratically. Plain fixed-point
   * needs far too many steps once the horizontal displacement approaches a raft
   * length, which it does at the steepness the extreme state uses.
   *
   * The final residual is recorded, not assumed.
   */
  private seedX = 0;
  private seedZ = 0;

  private solveSeed(x: number, z: number): void {
    let sx = x;
    let sz = z;
    const amp = this.amplitude;
    let residual = 0;

    for (let iter = 0; iter < 7; iter++) {
      let dx = 0;
      let dz = 0;
      let jxx = 0;
      let jxz = 0;
      let jzz = 0;

      for (let i = 0; i < this.count; i++) {
        const a = this.baseAmp[i] * amp;
        if (a === 0) continue;
        const dX = this.dirX[i];
        const dZ = this.dirZ[i];
        const ph = this.k[i] * (dX * sx + dZ * sz) + this.phase[i];
        const qa = this.q[i] * a;
        const c = Math.cos(ph);
        const s = Math.sin(ph);
        dx += qa * dX * c;
        dz += qa * dZ * c;
        // d/ds of (Q*A*d*cos(k*d.s + ph)) = -Q*A*k*d*d*sin(...)
        const qak = qa * this.k[i] * s;
        jxx -= qak * dX * dX;
        jxz -= qak * dX * dZ;
        jzz -= qak * dZ * dZ;
      }

      const rx = sx + dx - x;
      const rz = sz + dz - z;
      residual = Math.hypot(rx, rz);
      if (residual < 1e-8) break;

      const a11 = 1 + jxx;
      const a22 = 1 + jzz;
      const det = a11 * a22 - jxz * jxz;
      if (iter < 2 || Math.abs(det) < 1e-6) {
        // Contraction step. Also the fallback if the Jacobian ever degenerates,
        // which the Q normalisation is supposed to prevent.
        sx = x - dx;
        sz = z - dz;
        continue;
      }
      sx -= (a22 * rx - jxz * rz) / det;
      sz -= (a11 * rz - jxz * rx) / det;
    }

    this.seedX = sx;
    this.seedZ = sz;
    this.lastSolveResidual = residual;
    this.maximumSolveResidual = Math.max(this.maximumSolveResidual, residual);
  }

  /**
   * Invert the horizontal displacement alone: the parameter-space seed whose
   * displaced position is (x, z).
   *
   * The foam field is indexed by seed position, so a hull-sourced injection
   * must store against the seed of the water at the hull, not the hull's world
   * position — the difference is the local orbital displacement, which in a
   * seaway swings the stamp around the stern with every passing wave. Same
   * solver `sample()` uses; this exposes the seed instead of the surface.
   */
  invertDisplacement(x: number, z: number, out: { x: number; z: number }): void {
    this.solveSeed(x, z);
    out.x = this.seedX;
    out.z = this.seedZ;
  }

  /**
   * Sample the surface at a local-render-space point.
   *
   * Returns the height, normal, water particle velocity and horizontal Jacobian
   * of the surface point that is *visible* at (x, z) — the horizontal
   * displacement is inverted first, so this is the same point the eye sees at
   * that position.
   */
  sample(x: number, z: number, out: SurfaceSample): void {
    this.solveSeed(x, z);
    const sx = this.seedX;
    const sz = this.seedZ;

    let height = 0;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let jxx = 0;
    let jzz = 0;
    let jxz = 0;
    const amp = this.amplitude;

    for (let i = 0; i < this.count; i++) {
      const a = this.baseAmp[i] * amp;
      if (a === 0) continue;
      const dX = this.dirX[i];
      const dZ = this.dirZ[i];
      const w = this.omega[i];
      const ph = this.k[i] * (dX * sx + dZ * sz) + this.phase[i];
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      const ak = a * this.k[i];
      const qak = this.q[i] * ak;

      height += a * s;
      nx -= dX * ak * c;
      nz -= dZ * ak * c;
      ny -= qak * s;

      jxx += qak * dX * dX * s;
      jzz += qak * dZ * dZ * s;
      jxz += qak * dX * dZ * s;

      // d/dt of the Lagrangian particle position; dphi/dt = -omega.
      const qaw = this.q[i] * a * w;
      vx += qaw * dX * s;
      vz += qaw * dZ * s;
      vy -= a * w * c;
    }

    const inv = 1 / Math.hypot(nx, ny, nz);
    out.height = height;
    out.normalX = nx * inv;
    out.normalY = ny * inv;
    out.normalZ = nz * inv;
    out.jacobian = (1 - jxx) * (1 - jzz) - jxz * jxz;
    out.compression = jxx + jzz;
    // Frozen water is not moving water. The orbital velocity is the time
    // derivative of the surface, so if time is stopped it must read zero —
    // otherwise damping chases a velocity the surface is not having, and the
    // raft settles displaced from its own waterline by c*v/(rho*g*A), which is
    // eleven centimetres on the frozen test wave. That made the spatial-parity
    // stills look like a flotation failure.
    const moving = this.frozen ? 0 : 1;
    out.velocityX = vx * moving;
    out.velocityY = vy * moving;
    out.velocityZ = vz * moving;
  }

  /** Height only — cheaper when orientation and velocity are not needed. */
  sampleHeight(x: number, z: number): number {
    this.solveSeed(x, z);
    const sx = this.seedX;
    const sz = this.seedZ;
    let height = 0;
    const amp = this.amplitude;
    for (let i = 0; i < this.count; i++) {
      const a = this.baseAmp[i] * amp;
      if (a === 0) continue;
      const ph = this.k[i] * (this.dirX[i] * sx + this.dirZ[i] * sz) + this.phase[i];
      height += a * Math.sin(ph);
    }
    return height;
  }

  /**
   * Full forward evaluation at a parameter point. See `SeedSample`.
   *
   * This is a line-for-line mirror of the shader's `evaluateWaves` at
   * `lodRadius = 0` — the same clamp on the determinant, the same push of the
   * parameter-space gradient through the inverse Jacobian to get a world slope.
   * That matters more than it looks: `sample()` builds its normal by the older
   * approximation (`ny -= Q a k sin φ`), which agrees to first order and
   * diverges exactly at compressed crests, which is the only place this function
   * is ever called. Whitewater decisions made here have to be the decisions the
   * foam shader made, so the arithmetic is the shader's, not the neighbouring
   * method's.
   *
   * Costs one pass over the components, against the seven-plus that `sample()`
   * spends inverting the displacement first.
   */
  sampleSeed(px: number, pz: number, out: SeedSample): void {
    let dx = 0;
    let dz = 0;
    let height = 0;
    let gx = 0;
    let gz = 0;
    let jxx = 0;
    let jzz = 0;
    let jxz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    const amp = this.amplitude;

    for (let i = 0; i < this.count; i++) {
      const a = this.baseAmp[i] * amp;
      if (a === 0) continue;
      const dX = this.dirX[i];
      const dZ = this.dirZ[i];
      const ph = this.k[i] * (dX * px + dZ * pz) + this.phase[i];
      const s = Math.sin(ph);
      const c = Math.cos(ph);
      const ak = a * this.k[i];
      const qa = this.q[i] * a;
      const qak = qa * this.k[i];

      dx += qa * dX * c;
      dz += qa * dZ * c;
      height += a * s;

      gx += dX * ak * c;
      gz += dZ * ak * c;

      jxx += qak * dX * dX * s;
      jzz += qak * dZ * dZ * s;
      jxz += qak * dX * dZ * s;

      const qaw = qa * this.omega[i];
      vx += qaw * dX * s;
      vz += qaw * dZ * s;
      vy -= a * this.omega[i] * c;
    }

    const a11 = 1 - jxx;
    const b = -jxz;
    const a22 = 1 - jzz;
    const det = a11 * a22 - b * b;
    // Clamped exactly as the shader clamps it — an unbounded inverse near a fold
    // is a NaN, not a steep wave.
    const safeDet = Math.max(det, 0.1);
    const ixx = a22 / safeDet;
    const ixz = -b / safeDet;
    const izz = a11 / safeDet;
    const slopeX = ixx * gx + ixz * gz;
    const slopeZ = ixz * gx + izz * gz;
    const inv = 1 / Math.hypot(slopeX, 1, slopeZ);

    out.x = px + dx;
    out.z = pz + dz;
    out.height = height;
    out.normalX = -slopeX * inv;
    out.normalY = inv;
    out.normalZ = -slopeZ * inv;
    out.jacobian = det;
    out.compression = jxx + jzz;
    // Same reasoning as `sample()`: frozen water is not moving water.
    const moving = this.frozen ? 0 : 1;
    out.velocityX = vx * moving;
    out.velocityY = vy * moving;
    out.velocityZ = vz * moving;
  }

  /**
   * The undisplaced-parameter evaluation, i.e. exactly what the shader computes
   * for a vertex seeded at (px, pz). Used by the harness to prove CPU/GPU parity
   * without going through the inverse solve.
   */
  evaluateSeed(px: number, pz: number, out: { x: number; y: number; z: number }): void {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    const amp = this.amplitude;
    for (let i = 0; i < this.count; i++) {
      const a = this.baseAmp[i] * amp;
      if (a === 0) continue;
      const ph = this.k[i] * (this.dirX[i] * px + this.dirZ[i] * pz) + this.phase[i];
      const qa = this.q[i] * a * Math.cos(ph);
      dx += qa * this.dirX[i];
      dz += qa * this.dirZ[i];
      dy += a * Math.sin(ph);
    }
    out.x = px + dx;
    out.y = dy;
    out.z = pz + dz;
  }

  /** Longest active wavelength, metres. 0 when the sea is flat. */
  get longestWavelength(): number {
    let longest = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.baseAmp[i] <= 0 || this.k[i] <= 0) continue;
      longest = Math.max(longest, TWO_PI / this.k[i]);
    }
    return longest;
  }

  /** Per-component report for the ocean lab's overlays and the test harness. */
  describeComponents(): Array<{
    wavelength: number;
    amplitude: number;
    periodSeconds: number;
    headingDeg: number;
    steepness: number;
    /** Slot index in the uniform table (stable across the report's filtering). */
    slot: number;
    /** Carrier slot this component is a phase-locked harmonic of, or -1. */
    boundTo: number;
    /** Current phase, radians in [0, 2π). Diagnostic only. */
    phase: number;
  }> {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      if (this.baseAmp[i] <= 0) continue;
      const heading = (Math.atan2(this.dirX[i], -this.dirZ[i]) * 180) / Math.PI;
      out.push({
        wavelength: TWO_PI / this.k[i],
        amplitude: this.baseAmp[i] * this.amplitude,
        periodSeconds: TWO_PI / this.omega[i],
        headingDeg: (heading + 360) % 360,
        steepness: this.q[i] * this.baseAmp[i] * this.k[i],
        slot: i,
        boundTo: this.boundTo[i],
        phase: this.phase[i],
      });
    }
    return out;
  }
}
