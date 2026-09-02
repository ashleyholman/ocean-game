/**
 * Sea-state spectrum -> discrete Gerstner components.
 *
 * The renderer and the buoyancy solver both evaluate a sum of Gerstner
 * components. This module is what decides *which* components: it turns a
 * physical description of a sea (wind speed, development, swell height, peak
 * period, direction, spread) into the component table `WaveField` uploads.
 *
 * Everything here is deterministic — no RNG, only hashes keyed by slot index —
 * so the same `SeaState` produces bit-identical components on every device and
 * every run. That is what lets a preset be a reproducible test case rather than
 * an impression.
 *
 * THE COMPOSITIONAL POLICY — why this is not a spectral sampler any more
 * ----------------------------------------------------------------------
 * The previous discretiser sampled the spectrum statistically: equal-m₁ bins,
 * stratified directions across the full cos^2s fan. That is the honest way to
 * approximate a Gaussian sea, and it is exactly why it read as ski moguls: a
 * sum of many similar-amplitude components at the same scale with a wide
 * directional fan IS an egg-carton interference field. Statistically correct,
 * perceptually wrong.
 *
 * This version spends the same energy budget through a fixed *compositional
 * policy* instead. The spectrum still sets the budget — Hs is exact to float
 * precision, group structure still comes from real sideband spacing — but the
 * discretisation is a composition:
 *
 *   - CARRIER: each system concentrates a fixed share of its variance in one
 *     dominant component at the spectral peak on the mean heading. This is
 *     what gives the sea a legible dominant wave train with coherent crests.
 *   - SIDEBANDS: pairs at fp ± j·σf, *on (nearly) the carrier's heading*.
 *     Same direction + near frequency = amplitude modulation = groups and
 *     sets. (Near frequency + different directions = moguls. The distinction
 *     is the whole fix.)
 *   - FAN / LADDER: the stated directional spread is expressed across *scale*,
 *     not fanned at one scale: progressively shorter components get
 *     progressively wider headings, one or two per scale step, each scale
 *     clearly separated from its neighbours. Cross-hatch reads as chaos;
 *     a fan at one scale reads as bumps.
 *   - BOUND HARMONIC: one phase-locked second harmonic per carrier (Stokes
 *     bound wave), which peaks the crests, flattens the troughs, and can lean
 *     the crest forward. It advances at 2ω of its carrier — NOT at its own
 *     free dispersion — and is therefore geometry of the carrier wave, not an
 *     independent wave. It carries Q = 0 (no horizontal displacement), so it
 *     cannot fold and does not perturb the inverse solve.
 *
 * Slot *roles* are static per system (carrier is always slot 0, bound harmonic
 * always the last slot), and every role's frequency, direction and weight is a
 * continuous function of the physical inputs, so morphing a sea state moves
 * every component smoothly. No sorting, no data-dependent slot counts.
 *
 * References for the empirical constants are in `docs/ocean/OCEAN_SEA_STATE_SPEC.md` §3.
 * The composition itself is art direction, stated once, here, as policy — the
 * hand-tuned component list this prototype shipped with (six waves, one
 * dominant, directions widening as wavelengths shorten) is its ancestor and
 * its benchmark.
 */

const G = 9.81;
const TWO_PI = Math.PI * 2;

/**
 * Shortest wavelength the geometry carries, metres.
 *
 * Deliberately device-independent. The mobile mesh has 0.42 m near-field ring
 * spacing, so 3.5 m is still eight samples per wavelength there. Below this the
 * fragment detail-noise octaves take over (their base scale is 2.4 m), so the
 * handoff is near-contiguous. Making this a per-device number would make the
 * raft float differently on a phone, which is not a trade worth any amount of
 * GPU time.
 */
export const MIN_WAVELENGTH = 3.5;

/** One discrete Gerstner component, in the form `WaveField` consumes. */
export interface WaveComponent {
  /** Metres, crest to crest. */
  wavelength: number;
  /** Metres. Half the crest-to-trough height of this component alone. */
  amplitude: number;
  /** Unit direction of travel, XZ plane. */
  dirX: number;
  dirZ: number;
  /** Deterministic phase offset, radians. Ignored for bound harmonics. */
  seedPhase: number;
  /** Which physical system produced it. */
  band: WaveBand;
  /**
   * Index into the full component table of the carrier this slot is a
   * phase-locked harmonic of, or -1 for a free wave. A bound slot's phase is
   * always exactly `2·(carrier phase) + boundPhase`; `WaveField` enforces
   * that by construction (ω = 2ω_carrier, seed derived from the carrier's).
   */
  boundTo: number;
  /**
   * Phase of a bound harmonic relative to twice its carrier's phase.
   * −π/2 aligns the harmonic's peak with the carrier's crest (the symmetric
   * Stokes profile: peaked crest, flat trough); more negative leans the crest
   * forward, toward the direction of travel.
   */
  boundPhase: number;
  /** Which member of the compositional policy this slot is. */
  role: ComponentRole;
}

export type WaveBand = 'wind' | 'primary' | 'secondary';

/**
 * The compositional role of a slot — see the policy note at the top of this
 * file. Carried on the component so a diagnostic can isolate one layer of the
 * composition without re-deriving the slot layout and guessing at indices.
 */
export type ComponentRole = 'carrier' | 'sideband' | 'fan' | 'ladder' | 'bound';

/**
 * The four perceptually distinct layers a composed sea is built from, in
 * descending scale. This is a *diagnostic* grouping, not a physical one: it
 * exists so the lab can mute one layer at a time and settle what the eye is
 * actually reading, which is otherwise guesswork across 48 slots and a
 * fragment-shader texture that has no slot at all.
 *
 *  - `swell`   carriers, sidebands and bound harmonics of both swell systems.
 *  - `riders`  the swell fan: the crossed rungs that texture the swell faces.
 *  - `windSea` the whole wind band, carrier through ladder.
 *  - `detail`  the fragment detail-noise normals. NOT geometry: it displaces
 *              nothing, the raft cannot feel it, and it holds no slot here.
 */
export type SeaLayer = 'swell' | 'riders' | 'windSea' | 'detail';

/** Which layer a component belongs to. `detail` is never geometry. */
export function layerOf(band: WaveBand, role: ComponentRole): Exclude<SeaLayer, 'detail'> {
  if (band === 'wind') return 'windSea';
  return role === 'fan' ? 'riders' : 'swell';
}

export type LayerMask = Record<SeaLayer, boolean>;

export function allLayers(): LayerMask {
  return { swell: true, riders: true, windSea: true, detail: true };
}

/** Deterministic, well-distributed offset in [0, 1) for index/stream/seed. */
function hash(index: number, stream: number, seed: number): number {
  let h = Math.imul(index + 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(stream + 0xc2b2ae35, 0x27d4eb2f);
  h ^= Math.imul(seed + 0x165667b1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Absolute error below 1.15e-9 over the whole range — far tighter than
 * anything downstream of it needs.
 */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Complementary normal CDF via Abramowitz & Stegun 7.1.26. */
function normalCdfComplement(z: number): number {
  const x = z / Math.SQRT2;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 - sign * y);
}

/** Circular spread in degrees for a peak exponent: σ_θ = √(2/(s+1)). */
export function spreadDegreesFor(sMax: number): number {
  return (Math.sqrt(2 / (sMax + 1)) * 180) / Math.PI;
}

/** Peak spreading exponent for a target circular spread in degrees. */
export function spreadExponentForDegrees(spreadDeg: number): number {
  const sigma = Math.max((spreadDeg * Math.PI) / 180, 0.01);
  return Math.max(2 / (sigma * sigma) - 1, 0.5);
}

export interface SystemSpec {
  /** Significant wave height of this system alone, metres. */
  significantHeight: number;
  /** Peak period, seconds. */
  peakPeriod: number;
  /** Heading the waves travel *towards*, radians, in the local render frame. */
  headingRad: number;
  /** Peak directional spreading exponent. Large is narrow and organised. */
  spreadExponent: number;
  /**
   * JONSWAP peakedness. In the compositional policy this modulates how fast
   * the wind ladder's energy decays away from the peak: a young, peaky sea
   * keeps its energy near the dominant chop; a developed sea spreads it down
   * the ladder.
   */
  gamma: number;
  /**
   * Waves per group. Set for swell: sideband spacing is `fp / groupWaves`, so
   * the sets are as long as this says they are. Undefined for a wind sea,
   * which uses the broad-band ladder layout instead — chop does not come in
   * sets, which is correct physics, not a limitation.
   */
  groupWaves?: number;
  /**
   * 0..1 groupiness of a swell system (the same control that sets
   * `groupWaves`). Here it sizes the sideband *depth*: at 0 the sidebands
   * carry no energy and the composition converges to the reference ocean's
   * pure crossed hierarchy; at 0.5 the sideband weights apply as written.
   */
  groupiness?: number;
  /**
   * 0..1 crest sharpness of this system (the same control `WaveField` maps to
   * Gerstner Q). Here it sizes the bound second harmonic and its forward lean.
   */
  sharpness: number;
  /**
   * 0..1: how far real geometry is allowed below MIN_WAVELENGTH, plus an art
   * boost on the short rungs so they read. See `RoughnessParams.microChop`.
   */
  microChop?: number;
  /** How many component slots this system may use. */
  slots: number;
  /** Stream id so two systems with identical parameters still differ. */
  seed: number;
  band: WaveBand;
}

/**
 * The compositional policy: the one global set of taste parameters.
 *
 * These are tuned ONCE, against the pre-round shipping ocean (commit 1765bb7)
 * at sunset, and then every sea state — preset or mid-morph weather state —
 * inherits them. Do not tune presets around them; if a class of states looks
 * wrong, the policy is where the fix goes.
 *
 * All weights are relative variance shares within one system; the emitted set
 * is renormalised so the system's Hs is exact regardless of what these sum to.
 */
export const COMPOSITION = {
  /** Carrier's variance weight. 1.0 against the sideband/fan weights below
   *  puts ≈51 % of a swell's variance in its dominant component (the old
   *  hand-tuned ocean ran its carrier at 64 %, with zero sidebands). */
  carrierWeight: 1.0,

  /** Per-member variance weights of swell sideband pairs 1..3. Sidebands ride
   *  the carrier's heading, so they modulate it into sets rather than
   *  crossing it — and that is ALL they may do. The directional audit against
   *  1765bb7 found the first calibration ([0.24, 0.13, 0.07]) had quietly
   *  inverted the old ocean's geometry: 38 % of variance sat within ±16° of
   *  the carrier while the crossed riders got 18 % — where the old ocean put
   *  0 % on-heading and 36 % crossed. Worse, the outer pairs sit far enough
   *  from the peak (±26 %, ±39 % of fp) that at those weights they read as
   *  separate shorter trains from the same direction — "waves within waves" —
   *  instead of fusing into the group envelope. The taper below keeps the
   *  j=1 pair strong (sets stay deep: modulation depth ≈ 0.7) and drops the
   *  outer pairs to envelope-shaping trace amounts. */
  swellSidebandWeights: [0.13, 0.05, 0.02],
  /** Sideband depth per unit groupiness. The weights above apply as written
   *  at groupiness 0.5; at 0 the sidebands vanish and the composition IS the
   *  reference ocean's pure crossed hierarchy — the old table is the
   *  low-groupiness limit of the policy, not a separate look. */
  sidebandDepthPerGroupiness: 2.0,
  sidebandDepthMax: 1.25,
  /** The lower (longer-wave) member of each pair carries this fraction of the
   *  upper's weight. JONSWAP cuts off hard below the peak and falls softly
   *  above it, so the long side of the pair is the weak side — and the long
   *  side is also the "hills under hills" side: energy at 1.3–2.7× the
   *  carrier wavelength on the carrier's own heading undulates the whole
   *  field under the dominant train, which no amount of crossing fixes. */
  swellSidebandLowSide: 0.55,
  /** Sideband heading offset, as a fraction of σ_θ per pair index. Small and
   *  alternating: enough to finite-crest the train, not enough to cross it. */
  sidebandFanFraction: 0.16,

  /**
   * The swell fan: distinct, well-separated scales that carry the stated
   * directional spread. Ratios are of the carrier wavelength and deliberately
   * non-harmonic; angles are in units of σ_θ, alternating sides.
   *
   * This is the old hand-tuned ocean's table restated as policy, now to the
   * *angles* as well as the scales. Relative to its 62 m carrier the old
   * ocean ran: 34 m at 62 % amplitude crossing +51°, 19.5 m at 36 % crossing
   * −44°, 10.4 m at 18 % crossing +34°, 5.6 m at −62° — every rider strongly
   * crossed, nothing on the carrier heading. At its stated σ_θ (~34°) those
   * are the σ_θ-multiples below. The riders are what make water look
   * *worked*, and they must CROSS the swell to read as riders at all; energy
   * on the carrier heading — however spread across scale — reads as one
   * direction's wave stack, not as an ocean.
   */
  swellFan: [
    { ratio: 0.55, weight: 0.335, angle: +1.5 }, // the old 34 m rider
    { ratio: 0.31, weight: 0.13, angle: -1.3 }, // the old 19.5 m
    { ratio: 0.42, weight: 0.05, angle: -1.9 }, // old 5.6 m's wide crossing, at a scale that survives the floor
    { ratio: 0.17, weight: 0.045, angle: +1.05 }, // the old 10.4 m
  ],

  /** Wind-sea sideband weights (pairs 1..3). The wind sea keeps a legible
   *  dominant chop train too — just a less dominant one than a swell's. */
  windSidebandWeights: [0.28, 0.16, 0.10],
  /** Wind sideband spacing: JONSWAP falls softly above the peak and cuts hard
   *  below it, so the upper sidebands sit wider than the lower. */
  windSidebandSpacingHigh: 0.20,
  windSidebandSpacingLow: 0.11,

  /** Wind ladder: wavelength ratio per step and first-step variance weight.
   *  One component per scale step, alternating fan side — never a pair of
   *  equal components at one scale, which is the mogul recipe. The first-step
   *  weight is deliberately generous for the same reason as the swell fan's:
   *  the ladder IS the local chop, and starving it reads as perpetual calm. */
  ladderRatio: 0.72,
  ladderWeight0: 0.60,
  /** Ladder heading span, in units of σ_θ: from this at the top step... */
  ladderAngleNear: 0.50,
  /** ...to this at the bottom. Spread widens as scale shrinks (Mitsuyasu). */
  ladderAngleFar: 1.25,

  /** Cap on bound-harmonic amplitude as a fraction of its carrier's. Stokes
   *  second order is ½·(ak)·a; beyond ~0.2·a the expansion is out of its
   *  validity range and the crest reads as a spike rather than a peak. */
  boundHarmonicMax: 0.20,
  /** Radians of forward crest lean at sharpness 1. Applied on top of the −π/2
   *  that aligns the harmonic peak with the carrier crest. */
  boundLean: 0.55,

  /** Amplitude fade-in span above the geometric floor, as a ratio. A
   *  component fades in over [floor, floor·this] so ladder rungs slide under
   *  the floor smoothly during morphs instead of popping. Wide enough that a
   *  rung sweeping down-scale at the fastest plausible morph rate takes
   *  several steps to retire. */
  floorFadeRatio: 1.6,

  /** How far `microChop = 1` lowers the geometric floor: to this fraction of
   *  MIN_WAVELENGTH (~1.1 m). The mesh LOD fades these rungs out of geometry
   *  within ~15 m of the camera anyway — exactly the embodied zone they exist
   *  for — and hands their slope back to shading beyond it. */
  microFloorFraction: 0.32,
  /** Art boost multiplier on ladder-rung weights below `microBandTop` at
   *  microChop = 1. Physics gives centimetre amplitudes down here; the boost
   *  buys visible parallax without meaningfully denting the carrier (Hs is
   *  renormalised, so the energy comes out of everything else's √). */
  microBoost: 2.6,
  /** Wavelength below which the micro boost ramps in, metres. */
  microBandTop: 9,
} as const;

/** Deep-water wavelength of a component at frequency f. */
function wavelengthOf(f: number): number {
  return G / (TWO_PI * f * f);
}

/** Geometric floor for a system: MIN_WAVELENGTH, lowered by its microChop. */
export function geometricFloor(microChop: number | undefined): number {
  const micro = Math.min(Math.max(microChop ?? 0, 0), 1);
  return MIN_WAVELENGTH * (1 - (1 - COMPOSITION.microFloorFraction) * micro);
}

/** Smooth amplitude gate for the resolved band: 0 at the floor, 1 above the fade span. */
function resolvedGate(wavelength: number, floor: number): number {
  const hi = floor * COMPOSITION.floorFadeRatio;
  const t = Math.min(Math.max((wavelength - floor) / (hi - floor), 0), 1);
  return t * t * (3 - 2 * t);
}

/** One free-wave role in a system's layout. */
interface Role {
  wavelength: number;
  weight: number;
  angleOffset: number;
  role: ComponentRole;
}

/**
 * The static slot layout of one system.
 *
 * Everything here is a continuous function of the physical inputs and the slot
 * index — no sorting, no data-dependent counts — so a morph moves every slot
 * smoothly and slot identity survives any parameter change. Direction and
 * wavelength jitters are keyed by slot index and band only (NOT by the state
 * seed), so a mid-transition seed handoff cannot make the geometry jump; the
 * per-state seed feeds only the phases.
 */
function layoutRoles(spec: SystemSpec, n: number): Role[] {
  const roles: Role[] = [];
  const fp = 1 / Math.max(spec.peakPeriod, 0.2);
  const lambdaP = wavelengthOf(fp);
  const sigmaTheta = Math.sqrt(2 / (spec.spreadExponent + 1));
  const stream = spec.band === 'wind' ? 101 : spec.band === 'primary' ? 211 : 307;
  const jitter = (i: number, salt: number): number => hash(i, salt, stream) - 0.5;

  // Carrier. The tiny heading jitter keeps its direction distinct from any
  // other system's without being visible.
  roles.push({
    wavelength: lambdaP,
    weight: COMPOSITION.carrierWeight,
    angleOffset: jitter(0, 5) * 0.05 * sigmaTheta,
    role: 'carrier',
  });

  const pairs = Math.max(0, Math.min(3, Math.floor((n - 2) / 2)));
  const isSwell = spec.groupWaves !== undefined && spec.groupWaves > 0;

  // Swell sideband depth follows groupiness continuously: shallow-set swells
  // spend almost their whole rider budget on the crossed fan, exactly like
  // the reference ocean did.
  const sidebandDepth = isSwell
    ? Math.min(
        COMPOSITION.sidebandDepthPerGroupiness *
          Math.min(Math.max(spec.groupiness ?? 0.5, 0), 1),
        COMPOSITION.sidebandDepthMax,
      )
    : 1;

  for (let j = 1; j <= pairs; j++) {
    const weights = isSwell
      ? COMPOSITION.swellSidebandWeights
      : COMPOSITION.windSidebandWeights;
    const w = weights[j - 1] * sidebandDepth;
    const lowSide = isSwell ? COMPOSITION.swellSidebandLowSide : 1;
    const spacingHigh = isSwell ? j / spec.groupWaves! : j * COMPOSITION.windSidebandSpacingHigh;
    const spacingLow = isSwell ? j / spec.groupWaves! : j * COMPOSITION.windSidebandSpacingLow;
    const side = j % 2 === 0 ? -1 : 1;
    const fan = COMPOSITION.sidebandFanFraction * sigmaTheta * j;
    // Upper sideband (shorter), then lower (longer). Headings alternate about
    // the carrier so the modulation stays a modulation of one train.
    roles.push({
      wavelength: wavelengthOf(fp * (1 + spacingHigh)),
      weight: w,
      angleOffset: side * fan + jitter(j * 2 - 1, 7) * 0.06 * sigmaTheta,
      role: 'sideband',
    });
    roles.push({
      wavelength: wavelengthOf(fp * Math.max(1 - spacingLow, 0.35)),
      weight: w * lowSide,
      angleOffset: -side * fan + jitter(j * 2, 7) * 0.06 * sigmaTheta,
      role: 'sideband',
    });
  }

  const freeSlots = Math.max(n - 1 - (n >= 2 ? 1 : 0) - pairs * 2, 0);

  if (isSwell) {
    // Fan: fixed policy scales, cycled if the budget ever exceeds the table.
    for (let m = 0; m < freeSlots; m++) {
      const fan = COMPOSITION.swellFan[m % COMPOSITION.swellFan.length];
      roles.push({
        wavelength: lambdaP * fan.ratio * (1 + jitter(m, 11) * 0.10),
        weight: fan.weight,
        angleOffset: fan.angle * sigmaTheta + jitter(m, 13) * 0.08 * sigmaTheta,
        role: 'fan',
      });
    }
  } else {
    // Ladder: one component per scale step from the peak down to the floor.
    // A young, peaky sea (large gamma) keeps its energy near the peak.
    const decay = Math.min(Math.max(0.55 - 0.02 * (spec.gamma - 1), 0.40), 0.60);
    const micro = Math.min(Math.max(spec.microChop ?? 0, 0), 1);
    let w = COMPOSITION.ladderWeight0;
    for (let m = 1; m <= freeSlots; m++) {
      const side = m % 2 === 0 ? -1 : 1;
      const depth = freeSlots > 1 ? (m - 1) / (freeSlots - 1) : 0;
      const span = COMPOSITION.ladderAngleNear +
        (COMPOSITION.ladderAngleFar - COMPOSITION.ladderAngleNear) * depth;
      const wavelength =
        lambdaP * Math.pow(COMPOSITION.ladderRatio, m) * (1 + jitter(m, 17) * 0.12);
      // Micro-chop art boost: physics leaves centimetres of amplitude down
      // here; visible parallax is bought deliberately, and only when asked.
      const ramp = Math.min(
        Math.max((COMPOSITION.microBandTop - wavelength) / (COMPOSITION.microBandTop - 1), 0),
        1,
      );
      const boost = 1 + micro * (COMPOSITION.microBoost - 1) * ramp;
      roles.push({
        wavelength,
        weight: w * decay * boost,
        angleOffset: side * span * sigmaTheta + jitter(m, 19) * 0.10 * sigmaTheta,
        role: 'ladder',
      });
      w *= decay;
    }
  }

  return roles;
}

/**
 * Discretise one system into exactly `spec.slots` components.
 *
 * Always emits the full slot count — a system with no energy emits its whole
 * layout at zero amplitude — because slot *identity* is what makes a smooth
 * transition possible: slot 30 must be the primary swell's fifth role whether
 * or not the swell is currently switched on. (The previous discretiser
 * short-circuited when the spectral support collapsed, which silently shifted
 * every later slot; that identity bug is fixed by never short-circuiting.)
 *
 * Amplitudes are normalised against the *ungated* weight sum, then each slot
 * applies its own floor gate. Two consequences, both load-bearing:
 *
 *   - `Σa²/2 = (Hs/4)² · (gated fraction)`: a system whose roles all resolve
 *     delivers its Hs exactly; a system sliding under the floor delivers only
 *     the fraction of its energy the geometry can honestly carry, and the
 *     remainder flows to the unresolved band that drives the detail noise —
 *     the accounting in `WaveField.unresolvedSlopeVariance` picks it up with
 *     no further bookkeeping.
 *   - Each slot's amplitude depends on its OWN gate only. Normalising against
 *     the gated sum instead (the obvious choice, and the first thing tried)
 *     props the last survivors of a collapsing sea up with the whole system's
 *     budget and then drops the final one from centimetres to zero in a step.
 */
function composeSystem(spec: SystemSpec, out: WaveComponent[]): void {
  const n = spec.slots;
  if (n <= 0) return;
  const base = out.length;

  const hasBound = n >= 2;
  const roles = layoutRoles(spec, n);
  const freeCount = Math.min(roles.length, hasBound ? n - 1 : n);

  const m0 = (Math.max(spec.significantHeight, 0) / 4) ** 2;

  const floor = geometricFloor(spec.microChop);

  let weightSum = 0;
  for (let i = 0; i < freeCount; i++) weightSum += Math.max(roles[i].weight, 0);
  const scale = weightSum > 1e-12 && m0 > 1e-18 ? Math.sqrt((2 * m0) / weightSum) : 0;

  for (let i = 0; i < freeCount; i++) {
    const role = roles[i];
    const angle = spec.headingRad + role.angleOffset;
    const gate = resolvedGate(role.wavelength, floor);
    out.push({
      wavelength: Math.max(role.wavelength, floor),
      amplitude: Math.sqrt(Math.max(role.weight * gate, 0)) * scale,
      dirX: Math.sin(angle),
      dirZ: -Math.cos(angle),
      seedPhase: hash(i, 3, spec.seed) * TWO_PI,
      band: spec.band,
      boundTo: -1,
      boundPhase: 0,
      role: role.role,
    });
  }

  if (!hasBound) return;

  // Bound second harmonic of the carrier. Stokes second order puts its
  // amplitude at ½·(ka)·a; `sharpness` scales it and the policy caps it.
  const carrier = out[base];
  const kc = TWO_PI / carrier.wavelength;
  const halfWavelength = carrier.wavelength / 2;
  const gateB = resolvedGate(halfWavelength, floor);
  const stokesRatio = Math.min(0.5 * kc * carrier.amplitude, COMPOSITION.boundHarmonicMax);
  const sharp = Math.min(Math.max(spec.sharpness, 0), 1);
  const boundAmp = stokesRatio * carrier.amplitude * sharp * gateB;

  out.push({
    wavelength: Math.max(halfWavelength, floor),
    amplitude: boundAmp,
    dirX: carrier.dirX,
    dirZ: carrier.dirZ,
    seedPhase: 0,
    band: spec.band,
    boundTo: base,
    boundPhase: -Math.PI / 2 - COMPOSITION.boundLean * sharp,
    role: 'bound',
  });

  // Fold the bound harmonic's small variance back in so the system's resolved
  // energy is unchanged by it. The harmonic's amplitude relation to its
  // carrier shifts by the same (sub-percent) factor, which is far inside the
  // Stokes expansion's own slack.
  if (boundAmp > 0) {
    let liveVariance = 0;
    for (let i = base; i < out.length - 1; i++) {
      liveVariance += 0.5 * out[i].amplitude * out[i].amplitude;
    }
    if (liveVariance > 1e-18) {
      const total = liveVariance + 0.5 * boundAmp * boundAmp;
      const trim = Math.sqrt(liveVariance / total);
      for (let i = base; i < out.length; i++) out[i].amplitude *= trim;
    }
  }
}

// --- wind-sea growth --------------------------------------------------------

/** Fully-developed dimensionless energy and peak frequency (JONSWAP limits). */
const EPSILON_FULL = 3.64e-3;
const NU_FULL = 0.13;
/**
 * Dimensionless fetch at full development.
 *
 * Derived rather than quoted: it is the fetch at which the growth law
 * `ε = 1.6e-7 X̂` actually reaches its own cap. Using the commonly quoted
 * 2.14e4 instead leaves `maturity = 1` about 3 % short of the
 * Pierson-Moskowitz height, so "fully developed" would not quite be.
 */
const FETCH_FULL = EPSILON_FULL / 1.6e-7;

/**
 * Fetch-limited wind sea (Hasselmann et al. 1973).
 *
 *   ν̂p = 3.5 X̂^-0.33   (floored at 0.13)
 *   ε   = 1.6e-7 X̂      (capped at 3.64e-3)
 *   Tp  = U₁₀ / (g ν̂p)   Hs = 4 (U₁₀²/g) √ε
 *
 * `maturity` in 0..1 is mapped to dimensionless fetch as `X̂ = X̂_full · m^2.5`,
 * which makes the control perceptually even rather than crowding all the
 * interesting behaviour into the bottom of its range.
 *
 * The practical consequence is the one that matters visually: a young sea at
 * the same wind speed is *shorter and steeper*, not merely smaller. Raising the
 * wind over calm water roughens the surface long before it builds a large sea.
 */
export function windSeaFromWind(
  windSpeedMps: number,
  maturity: number,
): { significantHeight: number; peakPeriod: number; fetchNondim: number } {
  const u = Math.max(windSpeedMps, 0);
  const m = Math.min(Math.max(maturity, 0), 1);
  if (u < 1e-3 || m < 1e-4) {
    return { significantHeight: 0, peakPeriod: 1, fetchNondim: 0 };
  }
  const fetch = FETCH_FULL * Math.pow(m, 2.5);
  const nu = Math.max(3.5 * Math.pow(Math.max(fetch, 1e-6), -0.33), NU_FULL);
  const epsilon = Math.min(1.6e-7 * fetch, EPSILON_FULL);
  return {
    significantHeight: 4 * ((u * u) / G) * Math.sqrt(epsilon),
    peakPeriod: Math.max(u / (G * nu), 0.5),
    fetchNondim: fetch,
  };
}

/** Fully-developed significant height, `Hs∞ ≈ 0.0246 U₁₀²`. Uncertain to ±5 %. */
export function fullyDevelopedHeight(windSpeedMps: number): number {
  return 4 * ((windSpeedMps * windSpeedMps) / G) * Math.sqrt(EPSILON_FULL);
}

/** Fully-developed peak period, `Tp∞ ≈ 0.784 U₁₀`. */
export function fullyDevelopedPeriod(windSpeedMps: number): number {
  return windSpeedMps / (G * NU_FULL);
}

/**
 * JONSWAP peakedness of a wind sea at a given development. Young fetch-limited
 * seas are narrow and peaky; a fully developed sea relaxes to Pierson–Moskowitz.
 */
export function windSeaGamma(maturity: number): number {
  const m = Math.min(Math.max(maturity, 0), 1);
  return 1.0 + 4.0 * (1 - m) * (1 - m);
}

/**
 * Peak directional spreading exponent of a wind sea (Mitsuyasu's wave-age law
 * `s_max = 11.5 (U₁₀/c_p)^-2.5`, clamped to Goda's engineering range).
 *
 * A young sea driven hard by the wind is broad — its energy is still spread
 * across a wide fan. As it matures the dominant waves align with the wind and
 * the spread narrows.
 */
export function windSeaSpreadExponent(windSpeedMps: number, peakPeriod: number): number {
  const cp = (G * peakPeriod) / TWO_PI;
  if (cp <= 1e-4 || windSpeedMps <= 1e-4) return 3;
  const inverseWaveAge = windSpeedMps / cp;
  return Math.min(Math.max(11.5 * Math.pow(inverseWaveAge, -2.5), 3), 14);
}

// --- validity ceiling -------------------------------------------------------

/**
 * The edge of the empirical package's validity, m/s.
 *
 * 32 m/s ≈ 62 kn is the threshold of hurricane force, and roughly where every
 * relation this model rests on stops being a measurement: the JONSWAP growth
 * laws, Cox–Munk, and the air–sea drag they assume (which itself saturates
 * near 30–35 m/s — beyond that, extra wind tears the sea into spray rather
 * than building taller waves). The *presentation* of a stronger storm is
 * atmosphere work — spray, visibility, streaks, sound — which keeps scaling
 * with the raw wind; the wave-growth inputs saturate here instead of
 * extrapolating a 50 m sea the representation cannot carry.
 */
export const WIND_VALIDITY_CEILING = 32;

/**
 * Wind speed as the wave-growth laws should see it.
 *
 * Identity below 24 m/s, then a smooth (C¹) saturation that never exceeds
 * 32 m/s. The weather system may hand in any wind it likes; whitecap coverage,
 * gust streaks, spray and foam channels take the raw value, wave growth takes
 * this one.
 */
export function effectiveGrowthWind(windSpeedMps: number): number {
  const KNEE = 24;
  const SPAN = WIND_VALIDITY_CEILING - KNEE;
  const u = Math.max(windSpeedMps, 0);
  if (u <= KNEE) return u;
  return KNEE + SPAN * Math.tanh((u - KNEE) / SPAN);
}

/**
 * Whitecap coverage fraction from wind speed.
 *
 * Monahan & O'Muircheartaigh (1980) robust fit `W = 3.84e-6 U₁₀^3.41`, rolled
 * off towards a 10 % asymptote. Shipborne measurements at sustained 25 m/s find
 * coverage levels off around 10 % rather than following the power law to the
 * 22 % it predicts, so the roll-off matters at the top of the range. It
 * reproduces Monahan to within 1 % relative below 16 m/s.
 *
 * The soft-saturation *shape* is a construction, not an empirical law.
 *
 * This is used only to *calibrate* the breaking threshold against something
 * real. The foam itself is generated from surface geometry, not from this.
 */
export function whitecapCoverage(windSpeedMps: number): number {
  const raw = 3.84e-6 * Math.pow(Math.max(windSpeedMps, 0), 3.41);
  // Soft-max rather than an exponential roll-off. An exponential departs from
  // the power law far too early — it is already 9 % low at 14 m/s, well inside
  // the range where Monahan is the measurement. This form is within 0.5 % at
  // 10 m/s, 1.5 % at 12 and 4 % at 14, and still asymptotes to the observed
  // ceiling. The residual error is far inside the near-order-of-magnitude
  // scatter of the underlying whitecap datasets.
  return raw / Math.sqrt(1 + (raw / WHITECAP_CEILING) ** 2);
}

/**
 * Observed ceiling on whitecap coverage.
 *
 * The Monahan power law predicts 22 % at 25 m/s; shipborne measurement in
 * sustained storm winds finds it levels off around 10 % instead. The ceiling is
 * empirical, the *shape* of the approach to it is a construction.
 */
const WHITECAP_CEILING = 0.105;

export interface SpectrumRequest {
  systems: readonly SystemSpec[];
}

export interface Spectrum {
  components: WaveComponent[];
  /** Significant height of the combined sea, metres. */
  significantHeight: number;
  /** Sum of component amplitudes — the theoretical maximum crest. */
  amplitudeSum: number;
  /** Peak period of the highest-energy system, seconds. */
  dominantPeriod: number;
  /**
   * Mean square slope carried by the resolved components, `Σ(a k)²/2`.
   *
   * The fragment shader subtracts it from the Cox–Munk total to get the
   * roughness it must supply statistically, which replaces a hand-tuned fudge
   * factor with a derived one.
   */
  meanSquareSlope: number;
}

/**
 * Build the full component table for a sea.
 *
 * Slot order is stable: system order, then role index within each system. Role
 * `j` of a system is always the same member of its composition — carrier,
 * sideband, fan/ladder rung, bound harmonic — whatever its height, period or
 * spread are. That is what allows a sea state to be morphed by moving each
 * slot's parameters gradually rather than by rebuilding the table and
 * resetting every phase.
 */
export function buildSpectrum(request: SpectrumRequest): Spectrum {
  const components: WaveComponent[] = [];
  for (const system of request.systems) composeSystem(system, components);

  let variance = 0;
  let amplitudeSum = 0;
  let meanSquareSlope = 0;
  for (const c of components) {
    variance += 0.5 * c.amplitude * c.amplitude;
    amplitudeSum += c.amplitude;
    const ak = c.amplitude * (TWO_PI / c.wavelength);
    meanSquareSlope += 0.5 * ak * ak;
  }

  // Dominant period is the peak of whichever system carries the most energy,
  // not of the largest single component — that is the quantity a mariner would
  // quote and the one the diagnostic harness uses to size its capture windows.
  let bestEnergy = -1;
  let dominantPeriod = 0;
  for (const system of request.systems) {
    if (system.slots <= 0) continue;
    const energy = system.significantHeight * system.significantHeight;
    if (energy > bestEnergy) {
      bestEnergy = energy;
      dominantPeriod = system.peakPeriod;
    }
  }

  return {
    components,
    significantHeight: 4 * Math.sqrt(variance),
    amplitudeSum,
    dominantPeriod,
    meanSquareSlope,
  };
}

/**
 * Cox–Munk total mean square slope for a clean sea surface.
 * `mss = 0.003 + 5.12e-3 U₁₀`, ±0.004.
 */
export function coxMunkSlopeVariance(windSpeedMps: number): number {
  return 0.003 + 5.12e-3 * Math.max(windSpeedMps, 0);
}

/**
 * Whitecap threshold for a near-Gaussian sea, calibrated against Monahan.
 *
 * The breaking indicator is `C = Σ Q aᵢkᵢ sin φᵢ` — the downward crest
 * acceleration in units of g, scaled by the Gerstner Q. When no single term
 * dominates it is close to Gaussian with standard deviation `Q √mss`, and
 * requiring the fraction of the surface above the threshold to equal the
 * observed whitecap coverage `W` gives it in closed form:
 *
 *     C_crit = Q √mss · Φ⁻¹(1 − W)
 *
 * The compositional field is deliberately NOT Gaussian — the carrier is a
 * dominant deterministic term — so `WaveField` uses
 * `breakingThresholdComposite` instead; this closed form remains as the
 * `dominant → 0` limit and as the reference the tests pin.
 */
export function breakingThreshold(
  meanSquareSlope: number,
  globalQ: number,
  windSpeedMps: number,
  bias: number,
): number {
  const coverage = Math.min(Math.max(whitecapCoverage(windSpeedMps), 1e-6), 0.45);
  const sigma = globalQ * Math.sqrt(Math.max(meanSquareSlope, 1e-12));
  const threshold = sigma * normalQuantile(1 - coverage);
  // Bias is an artistic trim in units of sigma, so it means the same thing at
  // every sea state instead of being a raw offset that swamps calm water.
  //
  // The sign matters and was wrong once: this is a threshold in *trace* space,
  // where a higher value is harder to break. A negative bias must therefore
  // *lower* it.
  return Math.max(threshold + bias * sigma, 1e-4);
}

/**
 * Fraction of the surface whose breaking indicator exceeds `threshold`, for a
 * field with one dominant sinusoidal term of amplitude `dominant` plus a
 * Gaussian remainder of standard deviation `sigmaRest`:
 *
 *     P(C > c) = (1/2π) ∫ Φ̄((c − d·sinθ)/σᵣ) dθ
 *
 * Midpoint rule over θ; the integrand is smooth and 2π-periodic, for which the
 * midpoint rule converges spectrally, so 64 points is far more than enough.
 */
export function breakingExceedance(
  dominant: number,
  sigmaRest: number,
  threshold: number,
): number {
  const d = Math.max(dominant, 0);
  // Floor sigma so the σᵣ → 0 (pure carrier) limit stays smooth for the
  // bisection in `breakingThresholdComposite`.
  const sr = Math.max(sigmaRest, 0.02 * d + 1e-9);
  const K = 64;
  let sum = 0;
  for (let i = 0; i < K; i++) {
    const theta = ((i + 0.5) / K) * TWO_PI;
    sum += normalCdfComplement((threshold - d * Math.sin(theta)) / sr);
  }
  return sum / K;
}

/**
 * Whitecap threshold for the compositional (carrier-dominated) field.
 *
 * Same calibration target as `breakingThreshold` — the fraction of the surface
 * above the threshold equals the observed whitecap coverage — but solved
 * against the actual carrier-plus-Gaussian distribution by bisection instead
 * of assuming the whole sum is Gaussian. With a dominant carrier the Gaussian
 * assumption under-counts the tails badly enough to be visible as foam in the
 * wrong places at the wrong rate.
 *
 * `bias` is an artistic trim in units of the field's total standard deviation
 * `√(d²/2 + σᵣ²)`, so it means the same thing at every sea state.
 */
export function breakingThresholdComposite(
  dominant: number,
  sigmaRest: number,
  windSpeedMps: number,
  bias: number,
): number {
  const coverage = Math.min(Math.max(whitecapCoverage(windSpeedMps), 1e-6), 0.45);
  const sigmaTotal = Math.sqrt(0.5 * dominant * dominant + sigmaRest * sigmaRest);
  if (sigmaTotal <= 1e-12) return 1e-4;

  let lo = 0;
  let hi = dominant + 8 * Math.max(sigmaRest, 0.02 * dominant + 1e-9);
  for (let iter = 0; iter < 60; iter++) {
    const mid = 0.5 * (lo + hi);
    if (breakingExceedance(dominant, sigmaRest, mid) > coverage) lo = mid;
    else hi = mid;
  }
  const threshold = 0.5 * (lo + hi);
  return Math.max(threshold + bias * sigmaTotal, 1e-4);
}

/**
 * The largest Q that keeps folding out of reach, for a near-Gaussian sum.
 *
 * Kept as the reference/limit form; `WaveField` uses `safeCompositeQ`, which
 * knows the sum is carrier-dominated. See that function.
 */
export function safeGlobalQ(meanSquareSlope: number, nSigma = 4.5): number {
  const sigma = Math.sqrt(Math.max(meanSquareSlope, 1e-12));
  return Math.min(1, 1 / (nSigma * sigma));
}

/**
 * The largest global Q that keeps folding out of reach for a *composed* field.
 *
 * `Q = 1` is the physically correct trochoid. Folding needs
 * `Σ Q·sᵢ·aᵢkᵢ·sin φᵢ > 1`. The all-Gaussian bound (`safeGlobalQ`) is the right
 * model when no term dominates, but the composition deliberately makes the top
 * few terms dominant, and a Gaussian treats their occasional alignment as far
 * rarer than it is. So the bound is split: the top three terms are taken at
 * their deterministic worst (all aligned at full amplitude), the remainder is
 * taken statistically at `nSigma` standard deviations, and the sum of the two
 * is held at `margin` below the fold:
 *
 *     Q · (t₁+t₂+t₃ + nSigma·√(Σᵢ₌₄ tᵢ²/2)) ≤ margin
 *
 * The deterministic part is conservative for the carriers (they are at their
 * worst simultaneously only for an instant per beat cycle); the statistical
 * part is the same argument as before for the long tail. Net effect: dominant
 * carriers are allowed to run visibly steeper than the all-Gaussian bound
 * permitted, and the fold guarantee is *stronger* where it matters, because it
 * no longer pretends the carrier is Gaussian.
 *
 * `terms` are the per-component `sᵢ·aᵢ·kᵢ` products of the FREE components
 * (bound harmonics carry Q = 0 and are excluded by the caller).
 */
export function safeCompositeQ(
  terms: readonly number[],
  nSigma = 3.2,
  margin = 0.95,
): number {
  const sorted = [...terms].sort((a, b) => b - a);
  let top = 0;
  for (let i = 0; i < Math.min(3, sorted.length); i++) top += sorted[i];
  let restVariance = 0;
  for (let i = 3; i < sorted.length; i++) restVariance += 0.5 * sorted[i] * sorted[i];
  const denom = top + nSigma * Math.sqrt(restVariance);
  if (denom <= 1e-9) return 1;
  return Math.min(1, margin / denom);
}
