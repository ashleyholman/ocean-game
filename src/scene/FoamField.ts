import * as THREE from 'three';
import { GLSL_COMMON, GLSL_WAVES } from './shaders/lib';
import {
  GLSL_CATS_PAW,
  type CatsPawFieldFrame,
} from '../weather/CatsPawField';
import { MAX_WAVES } from './Waves';
import type { WaveField } from './Waves';

/**
 * Persistent whitewater.
 *
 * Foam that appears and vanishes with a crest is paint. Real foam is *made* by
 * a breaking crest and then outlives it: it drifts, spreads, fragments and
 * fades over seconds to minutes. That history is state, and this is where it
 * lives.
 *
 * THE FIELD IS INDEXED IN GERSTNER PARAMETER SPACE, AND THAT IS THE WHOLE TRICK
 * ----------------------------------------------------------------------------
 * A Gerstner particle moves in a closed orbit about a fixed parameter position:
 * it goes round, not along. So a patch of foam riding on the water is
 * *stationary* in parameter space, however violently it is moving in world
 * space. Storing foam against the undisplaced parameter position `p` therefore
 * means:
 *
 *   - Wave-orbital motion needs no advection. A small uniform ping-pong step is
 *     used only for wind drift and observer travel through the local field.
 *   - Foam automatically rides the orbital motion of the waves it sits on,
 *     because the same displacement that draws the surface also carries the
 *     lookup. It heaves with the swell and surges with the crest for free.
 *   - A presentation-origin jump stops being a problem. It is a phase offset
 *     applied to the same `p`, and a diagnostic reset rebuilds the field there.
 *     Continuous vessel travel is different: the observer moves across this
 *     parameter field, so the history pass carries existing foam backwards by
 *     that frame velocity while new foam is injected on the arriving crests.
 *
 * What genuinely does translate is the slow drift of surface water relative to
 * the wave field — Stokes drift plus the wind's direct drag on the surface.
 * That is a *uniform* translation, so it costs one vec2 offset applied equally
 * to injection and lookup, not a per-texel velocity field.
 *
 * THREE PHYSICAL CHANNELS
 * -----------------------
 *   R  active foam   — the bright, dense, aerated crest of an actual break.
 *                      Short time constant (~0.7 s): this is the event.
 *   G  residual foam — the pale drifting slick it leaves behind. Time constant
 *                      is the sea state's `persistenceSeconds`, seconds to
 *                      minutes.
 *   B  hull turbulence — worked, bubble-laden water left by a moving hull.
 *                        It persists for tens of seconds and drives the
 *                        presentation-only smooth/pale trail in Ocean.
 *
 * Rendering R and G separately is what makes fresh breaks read as violent and
 * old foam read as tired. B is consumed independently as worked water.
 *
 * ONE PING-PONG, ONE INJECTION PASS
 * ---------------------------------
 * Advection and exact exponential decay rewrite the scratch target from the
 * previous target; ambient and hull sources are then additively injected into
 * that same destination. All three physical channels share those two passes.
 */

/**
 * Field levels: a tight window on the hull, near detail, and a coarse level for
 * the middle distance.
 */
export interface FoamQuality {
  hullResolution: number;
  nearResolution: number;
  farResolution: number;
  /** Simulation rate, Hz. Decay is exact at any step, so this is nearly free. */
  updateHz: number;
}

/**
 * Resolution is set by what the *field* has to carry, which is much less than
 * what the foam has to look like. Patch shape, age and streak orientation vary
 * over metres; the reticulation, holes and ragged edges that make foam read as
 * foam are added per pixel by the breakup noise in the ocean shader. That is
 * why the near level is coarse, and it matters because the injection pass
 * evaluates the whole wave sum at every texel — the one place in this system
 * where resolution costs real time.
 *
 * The argument holds for ambient whitewater and fails for the hull. Ambient
 * foam is metres-wide patches; a bow collar is a ~0.6 m ribbon welded to a
 * moving object the camera is usually pointed at, so at 1.5 m per texel it is
 * sub-texel and the grid is the only thing left to draw. Ash saw exactly that
 * — square blocks in the foam at the stem — once the lookup stopped dithering
 * the grid away (see foamLookup.ts). No reconstruction filter fixes it: the
 * detail was never stored.
 *
 * So store it, but only where it is needed. The hull level is 0.375 m per texel
 * over a window sized to the vessel and her near trail, for a fraction of the
 * near level's texel count, because it covers a tiny fraction of its area. It
 * is the same trade a clipmap makes, for the same reason.
 *
 * WK-R13: the ratio BETWEEN adjacent levels is its own artifact, separate from
 * either level's own resolution.
 *
 * A trail is roughly a 1.2 m ribbon. A level whose texel is finer than that
 * knows where inside the texel the foam is and draws a solid ribbon; a level
 * whose texel is coarser can only record how much, and the coverage-to-mask
 * threshold then scatters that amount across the texel as noise-shaped chunks.
 * The right total foam in the wrong arrangement. At the old 0.375 -> 1.5 m step
 * that transition happened all at once, a ship length astern: Ash's "the solid
 * wake breaks up into chunks very distinctly".
 *
 * Two changes, both cheap, because these targets are small and update at
 * `updateHz` rather than per frame:
 *
 *   - the near level goes to 0.75 m, which halves the step to 2x and — since
 *     the widening floor is 0.65 texels — stops widening a 0.6 m wake source at
 *     all, so the two levels now agree in amplitude as well as in kind;
 *   - the hull window doubles at doubled resolution, keeping 0.375 m while
 *     pushing the handover from ~1 ship length astern to ~2.5, over twice the
 *     blend distance.
 *
 * The whole field costs about 5.5 MB across its six targets. Resolution was
 * always the answer here; the compensation arithmetic could only ever decide
 * how bright the wrong arrangement was.
 */
export const FOAM_QUALITY_DESKTOP: FoamQuality = {
  hullResolution: 256,
  nearResolution: 512,
  farResolution: 128,
  updateHz: 24,
};

export const FOAM_QUALITY_MOBILE: FoamQuality = {
  hullResolution: 128,
  nearResolution: 256,
  farResolution: 64,
  updateHz: 12,
};

/** Decay time constant of the bright, actively-breaking channel, seconds. */
export const ACTIVE_TAU = 0.7;

/** Default used only when a caller has no hull policy attached. */
export const HULL_TURBULENCE_DEFAULT_TAU = 24;

/** Thirteen matched port/starboard cuts in the fixed waterline-source budget. */
export const MAX_WATERLINE_WAKE_STATIONS = 13;
export const MAX_WATERLINE_WAKE_POINTS = MAX_WATERLINE_WAKE_STATIONS * 2;

/** One stern segment injected into R/G/B in the existing whitewater pass. */
export interface FoamHullWakeSource {
  enabled: boolean;
  portX: number;
  portZ: number;
  starboardX: number;
  starboardZ: number;
  radiusM: number;
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
  turbulenceTauSeconds: number;
  /** 0..1 concentration of R/G toward the segment ends; B stays full-width. */
  railBias: number;
}

/** Matched port/starboard hull-side polylines injected as continuous shear. */
export interface FoamWaterlineWakeSource {
  enabled: boolean;
  /** Number of live matched cuts; points are interleaved port/starboard. */
  stationCount: number;
  readonly points: readonly Readonly<{ x: number; z: number }>[];
  radiusM: number;
  /** Short astern sweep from the live waterline, in render metres. */
  tearX: number;
  tearZ: number;
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
}

export interface FoamFieldUpdateOptions {
  windDir: THREE.Vector2;
  windSpeed: number;
  generation: number;
  persistenceSeconds: number;
  gustiness: number;
  /** WX3 spatial field. Absent/zero preserves the established foam pixels. */
  catsPaw?: Readonly<CatsPawFieldFrame>;
  streak: number;
  windAdvection: number;
  /** Observer/ship velocity through water in the local wave frame. */
  observerVelocity?: { x: number; z: number };
  noiseTime: number;
  frozen: boolean;
  /** Absent is exactly equivalent to a disabled, all-zero hull source. */
  hullWake?: Readonly<FoamHullWakeSource>;
  /** WK2+ continuous hull waterline; absent is a zero-count, zero-rate source. */
  waterlineWake?: Readonly<FoamWaterlineWakeSource>;
}

/** Exact leaky-integrator decay, shared by implementation and contract tests. */
export function foamDecayFactor(dtSeconds: number, tauSeconds: number): number {
  if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
    throw new RangeError(`foam decay dt must be finite and non-negative, got ${dtSeconds}`);
  }
  if (!Number.isFinite(tauSeconds) || tauSeconds <= 0) {
    throw new RangeError(`foam decay tau must be finite and positive, got ${tauSeconds}`);
  }
  return Math.exp(-dtSeconds / tauSeconds);
}

/**
 * Physical translation of stored field contents over one step.
 *
 * The observer term is deliberately negative: a vessel whose course has a
 * positive-X leeway component leaves old water on negative X. Keeping this as
 * a small pure seam gives the course-vs-heading sign a headless regression.
 */
export function foamFieldAdvectionStep(
  dtSeconds: number,
  windDir: Readonly<{ x: number; y: number }>,
  windSpeedMps: number,
  windAdvection: number,
  observerVelocity: Readonly<{ x: number; z: number }> | undefined,
  out: { x: number; z: number },
): { x: number; z: number } {
  const driftSpeed = windAdvection * windSpeedMps;
  out.x = windDir.x * driftSpeed * dtSeconds - (observerVelocity?.x ?? 0) * dtSeconds;
  out.z = windDir.y * driftSpeed * dtSeconds - (observerVelocity?.z ?? 0) * dtSeconds;
  return out;
}

/**
 * Quantise one level's scroll to whole texels, carrying the sub-texel
 * remainder in that level's origin.
 *
 * The advection pass copies the previous target through a bilinear sample.
 * Offset by a whole number of texels that sample lands exactly on texel
 * centres and the copy is lossless; offset by a fraction it is a blur, and a
 * blur applied 24 times a second is numerical diffusion. A hull trail one or
 * two texels wide smears into invisibility within seconds of sailing — while
 * its decay constant promises tens of seconds — so sub-texel scrolling is not
 * an approximation here, it deletes the feature. (Ambient foam never showed
 * it: broad patches, re-injected in place, and a wind drift of ~0.005
 * texels/step.)
 *
 * So: shift by `round((remainder + step) / texel)` texels, and keep what is
 * left in `remainder`, which doubles as the level's origin — the parameter
 * position of the texture centre. Injection and lookup both read that origin,
 * so motion stays continuous while the copy stays exact. |remainder| never
 * exceeds half a texel.
 */
export function quantizeFoamFieldScroll(
  stepX: number,
  stepZ: number,
  texelSizeM: number,
  remainder: { x: number; y: number },
  outShiftTexels: { x: number; y: number },
): void {
  const totalX = remainder.x + stepX;
  const totalZ = remainder.y + stepZ;
  const shiftX = Math.round(totalX / texelSizeM);
  const shiftZ = Math.round(totalZ / texelSizeM);
  outShiftTexels.x = shiftX;
  outShiftTexels.y = shiftZ;
  remainder.x = totalX - shiftX * texelSizeM;
  remainder.y = totalZ - shiftZ * texelSizeM;
}

/**
 * World extent of each level, metres, edge to edge.
 *
 * The lookup fades out well inside each half-extent so the toroidal wrap is
 * never on screen: the near level fades by 170 m against a 192 m half-extent,
 * the far level by 700 m against 768 m. Past that a statistical term takes
 * over, which is the honest representation anyway — at 700 m a foam patch is
 * sub-pixel and what the eye reads is coverage, not shape.
 */
export const FOAM_NEAR_EXTENT = 384;
export const FOAM_FAR_EXTENT = 1536;

/**
 * World extent of the hull level, metres, edge to edge.
 *
 * 96 m fades out by 42.5 m against a 48 m half-extent, which covers the
 * schooner (15.5 m stem to transom) and roughly two and a half boat lengths of
 * trail behind her.
 *
 * It was 48 m, and the note here said widening it "would buy trail at the
 * direct expense of the collar detail it exists for". That was true only
 * because widening was assumed to mean spreading the same 128 texels thinner.
 * Doubling the resolution with it holds 0.375 m per texel exactly, so the
 * collar detail is untouched and the handover simply happens further astern,
 * over twice the blend distance, where the eye is no longer on it. The cost is
 * a megabyte.
 */
export const FOAM_HULL_EXTENT = 96;

const INJECT_VERT = /* glsl */ `
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Whitecap generation.
 *
 * The breaking indicator is the determinant of the horizontal Gerstner
 * Jacobian. That is not a proxy — it is the physics. A deep-water wave breaks
 * when its crest particles are accelerated downwards faster than gravity can
 * hold them, and the downward crest acceleration in units of g is exactly
 * `B = Σ aᵢkᵢ sin φᵢ`, which is exactly the trace of the Jacobian perturbation.
 * So `J → 0` and `crest overturning` are the same event, and the threshold is
 * calibrated once on the CPU against observed whitecap coverage rather than
 * dialled in by eye (`spectrum.ts`, `breakingThreshold`).
 *
 * Three modulations on top, each of which the sea states need to be
 * distinguishable:
 *
 *  - WIND GATE. Waves break because the wind is driving them. Large swell under
 *    a dead calm does not whitecap however big it is, and this is the term that
 *    makes `GLASSY_LONG_SWELL` and `POST_STORM_SWELL` behave.
 *  - FORWARD FACE. Breaking happens on the downwind face of a crest, so the
 *    generator is weighted by the *signed* slope along the wind rather than by
 *    slope magnitude. Using the magnitude puts a symmetric ring of foam round
 *    every crest, which is one of the clearest tells of painted-on foam.
 *  - GUSTS. Slow, large-scale modulation so breaking comes in patches rather
 *    than evenly everywhere, which is what a real sea surface does.
 */
const INJECT_FRAG = /* glsl */ `
precision highp float;

${GLSL_COMMON}
${GLSL_WAVES}
${GLSL_CATS_PAW}

uniform vec2  uFieldOrigin;
uniform float uFieldExtent;
uniform float uTexelSize;
uniform vec2  uWindDir;
uniform float uWindSpeed;
/** Whitecap transition band, (T - k0 s, T + k1 s). See WaveField.breakBand. */
uniform vec2  uBreakBand;
uniform float uGeneration;
uniform float uGustiness;
uniform float uNoiseTime;
uniform float uDeltaTime;
uniform float uStreak;
/** (active, residual) decay time constants, seconds. */
uniform vec3  uTau;
/** Stern waterline segment and additive R/G/B density rates per second. */
uniform vec2  uHullWakePort;
uniform vec2  uHullWakeStarboard;
uniform float uHullWakeRadius;
uniform vec3  uHullWakeRate;
uniform float uHullWakeRailBias;
/** WK2+ matched port/starboard hull-side polylines, swept briefly astern. */
uniform vec2  uWaterlineWakePoints[MAX_WATERLINE_WAKE_POINTS];
uniform float uWaterlineWakeStationCount;
uniform float uWaterlineWakeRadius;
uniform vec2  uWaterlineWakeTear;
uniform vec3  uWaterlineWakeRate;
/** Unexpanded (min x, max x, min z, max z) of points plus track tear. */
uniform vec4  uWaterlineWakeBounds;

varying vec2 vUv;

float distanceToWakeSegment(vec2 samplePoint, vec2 a, vec2 b) {
  vec2 segment = b - a;
  float length2 = max(dot(segment, segment), 1e-8);
  float along = clamp(dot(samplePoint - a, segment) / length2, 0.0, 1.0);
  return length(samplePoint - (a + segment * along));
}

// Distance to the short parallelogram swept astern from one hull-side
// segment.  An interior sample is on the source (distance zero); outside, the
// nearest of the four continuous edges wins.  This preserves the collar's
// track-aligned tear without returning to disconnected point stamps.
float distanceToSweptWakeSegment(
  vec2 samplePoint,
  vec2 a,
  vec2 b,
  vec2 sweep
) {
  vec2 side = b - a;
  float determinant = side.x * sweep.y - side.y * sweep.x;
  if (abs(determinant) > 1e-6) {
    vec2 offset = samplePoint - a;
    float sideFraction =
      (offset.x * sweep.y - offset.y * sweep.x) / determinant;
    float sweepFraction =
      (side.x * offset.y - side.y * offset.x) / determinant;
    if (
      sideFraction >= 0.0 && sideFraction <= 1.0 &&
      sweepFraction >= 0.0 && sweepFraction <= 1.0
    ) {
      return 0.0;
    }
  }

  float distanceToSource = distanceToWakeSegment(samplePoint, a, b);
  distanceToSource = min(
    distanceToSource,
    distanceToWakeSegment(samplePoint, a + sweep, b + sweep)
  );
  distanceToSource = min(
    distanceToSource,
    distanceToWakeSegment(samplePoint, a, a + sweep)
  );
  return min(
    distanceToSource,
    distanceToWakeSegment(samplePoint, b, b + sweep)
  );
}

void main() {
  // Parameter-space position of this texel. Injection and lookup use the same
  // transform, so the drift offset folded into uFieldOrigin cancels.
  vec2 p = uFieldOrigin + (vUv - 0.5) * uFieldExtent;

  // lodRadius 0: the field is a physical quantity, not a view-dependent one,
  // so it is generated from the full, unfaded wave sum. A crest that breaks
  // 300 m away has still broken.
  WaveResult w = evaluateWaves(p, 0.0);

  // The threshold is in trace space and calibrated against Monahan coverage,
  // so this ramp is the whole whitecap decision. The band is supplied in units
  // of the indicator's own standard deviation (WaveField.breakBand): fixed
  // fractions of the threshold were only constant-in-sigma by accident at the
  // calibration state, and micro chop could widen the credited area without
  // any physics changing.
  float breaking = smoothstep(uBreakBand.x, uBreakBand.y, w.compression);

  // Forward face: positive where the surface tilts down along the wind.
  vec2 slope = slopeFromGradient(w.gradient, w.invJacobian);
  float facing = clamp(0.35 + 0.9 * dot(slope, uWindDir), 0.0, 1.4);

  // Wind gate. Below about 4 m/s nothing breaks at all however steep it looks;
  // by 12 m/s the wind is fully able to drive a break.
  float windGate = smoothstep(3.5, 11.0, uWindSpeed);

  // One spatial gust authority. Positive physical amplitude replaces the old
  // foam-local patch noise and drives the gate from local wind speed. The
  // ratio keeps patches legible after the gate saturates, but is one response
  // to that same speed rather than a second noise field.
  float gust = 1.0;
  if (uCatsPawGustExcessMps > 0.0) {
    float localWindSpeed = catsPawLocalWindSpeed(p, uWindSpeed);
    windGate = smoothstep(3.5, 11.0, localWindSpeed);
    gust = clamp(localWindSpeed / max(uWindSpeed, 3.5), 0.4, 1.8);
  } else if (uGustiness > 0.001) {
    // Exact pre-WX3 pixel path for the zero-amplitude A/B. Retained only as
    // the off arm; it is not evaluated beside the shared field.
    float g = vnoise(p * 0.010 + uWindDir * uNoiseTime * 0.06);
    gust = mix(1.0, 0.25 + 1.9 * g, uGustiness);
  }

  float rate = breaking * facing * windGate * gust * uGeneration;

  // Streaking. Foam pulled into wind-aligned windrows: sample an anisotropic
  // noise stretched along the wind, so the *injection* is already streaky and
  // the streaks then age and drift with the rest of the field. Orienting the
  // sample rather than the field means a wind shift rotates future streaks
  // while the ones already on the water keep their direction, which is what
  // actually happens.
  if (uStreak > 0.001) {
    vec2 along = uWindDir;
    vec2 across = vec2(-along.y, along.x);
    vec2 s = vec2(dot(p, along) * 0.020, dot(p, across) * 0.145);
    float rows = vnoise(s + vec2(uNoiseTime * 0.05, 0.0));
    rate *= mix(1.0, 0.35 + 1.5 * rows, uStreak);
  }

  // Injection is normalised by each channel's own time constant.
  //
  // Without this, a leaky integrator's steady state is rate*tau, so doubling
  // the persistence would double how *white* the sea is rather than how long
  // its foam lasts — and the coverage would stop agreeing with the wind speed
  // that the breaking threshold was calibrated against. Dividing by tau makes
  // the steady state equal the drive itself: each channel settles at the local
  // time-average of the breaking indicator, in 0..1, whatever tau is. The
  // control then means exactly what it says.
  // Preserve the established ambient R/G arithmetic exactly. A disabled hull
  // source adds a literal zero to those channels, which is the WK1 off-path
  // contract; B is born at zero.
  vec2 ambientInjected = rate * uDeltaTime / uTau.xy;
  vec3 injected = vec3(ambientInjected.x, ambientInjected.y * 0.85, 0.0);

  if (dot(abs(uHullWakeRate), vec3(1.0)) > 0.0) {
    vec2 segment = uHullWakeStarboard - uHullWakePort;
    float segmentLength2 = max(dot(segment, segment), 1e-8);
    float along = clamp(dot(p - uHullWakePort, segment) / segmentLength2, 0.0, 1.0);
    float distanceToSource = length(p - (uHullWakePort + segment * along));

    // A sub-texel line must neither disappear between texel centres nor turn
    // into a full-strength far-level slab. Widen to the footprint and reduce
    // the deposit by the SQUARE of the radius ratio.
    //
    // Squared, because widening a disc source is a two-dimensional act and the
    // established single ratio only ever compensated one of those dimensions.
    // What the linear ratio preserved was the ribbon's PEAK coverage: the along
    // -track integral of the widened profile grows with R while the amplitude
    // falls as 1/R, so the value accumulated at a texel the track crosses came
    // out level-independent. Its WIDTH did not. The ribbon was laid down R wide
    // at full strength instead of r wide, and R is the texel, so each coarser
    // level drew the same trail proportionally wider and just as bright.
    //
    // At the shipping levels, with a 0.6 m source radius:
    //
    //   level  texel     R      linear    squared   over-deposit
    //   hull   0.375 m   0.60   1.000     1.000       1x
    //   near   0.75 m    0.60   1.000     1.000       1x
    //   far    12 m      7.80   0.077     0.0059     13x
    //
    // Thirteen times the foam, spread over a 16 m band, is the "ginormous
    // square patch" that appeared from nowhere ten ship lengths astern. The
    // near level used to sit at 1.5 m texels and take 1.6x — the smaller
    // expansion a ship length astern — but at WK-R13's 0.75 m the widening
    // floor of 0.65 texels no longer reaches a 0.6 m source at all, so the two
    // inner levels now agree exactly and that seam has no step left in it. The
    // correction still governs the far level, and still governs the near level
    // for the smallest sources the bow policy resolves. The field should hold
    // the area-average of the true coverage over a texel — a 1.2 m ribbon
    // through a 12 m texel is a tenth of it, not all of it — and the squared
    // ratio is what makes the deposit conserve foam AREA across the levels
    // rather than peak brightness.
    //
    // Ambient injection is untouched: it never widens, so it never compensated.
    float sourceRadius = max(uHullWakeRadius, uTexelSize * 0.65);
    float radiusRatio = min(uHullWakeRadius / max(sourceRadius, 1e-4), 1.0);
    float footprintWeight = radiusRatio * radiusRatio;
    float source = (1.0 - smoothstep(sourceRadius * 0.25, sourceRadius, distanceToSource))
                 * footprintWeight;
    // The white water rides the two quarter-wave shoulders; the churned core
    // between them is darker. Bias R/G toward the segment ends, roughly
    // energy-neutral about a flat profile, while B keeps the full band —
    // worked water spans the whole beam. When the breathing cut narrows below
    // a texel the rails merge back into one line on their own.
    float rail = 1.0 + uHullWakeRailBias
               * (smoothstep(0.35, 0.9, abs(along * 2.0 - 1.0)) - 0.35);
    vec3 hullInjected = uHullWakeRate * (source * uDeltaTime);
    hullInjected.rg *= rail;
    injected += hullInjected;
  }

  float waterlineBoundsMargin = max(uWaterlineWakeRadius, uTexelSize * 0.65);
  if (
    uWaterlineWakeStationCount > 0.5 &&
    dot(abs(uWaterlineWakeRate), vec3(1.0)) > 0.0 &&
    p.x >= uWaterlineWakeBounds.x - waterlineBoundsMargin &&
    p.x <= uWaterlineWakeBounds.y + waterlineBoundsMargin &&
    p.y >= uWaterlineWakeBounds.z - waterlineBoundsMargin &&
    p.y <= uWaterlineWakeBounds.w + waterlineBoundsMargin
  ) {
    float waterlineSource = 0.0;
    // Squared for the reason given at the stern source above: widening a source
    // to its texel footprint is two-dimensional, so compensating it linearly
    // preserves the ribbon's peak and lets its width grow with the texel.
    float sourceRadius = max(uWaterlineWakeRadius, uTexelSize * 0.65);
    float radiusRatio = min(
      uWaterlineWakeRadius / max(sourceRadius, 1e-4),
      1.0
    );
    float footprintWeight = radiusRatio * radiusRatio;

    // A single complete cut is unusual but remains an honest source rather
    // than disappearing merely because there is no adjacent hull station.
    if (uWaterlineWakeStationCount < 1.5) {
      for (int sideIndex = 0; sideIndex < 2; sideIndex++) {
        vec2 sourcePoint = uWaterlineWakePoints[sideIndex];
        float distanceToSource = distanceToWakeSegment(
          p,
          sourcePoint,
          sourcePoint + uWaterlineWakeTear
        );
        float pointSource = (
          1.0 - smoothstep(sourceRadius * 0.22, sourceRadius, distanceToSource)
        ) * footprintWeight;
        waterlineSource = max(waterlineSource, pointSource);
      }
    }

    for (int i = 0; i < MAX_WATERLINE_WAKE_STATIONS - 1; i++) {
      if (float(i + 1) >= uWaterlineWakeStationCount) continue;
      int a = i * 2;
      int b = (i + 1) * 2;
      float portDistance = distanceToSweptWakeSegment(
        p,
        uWaterlineWakePoints[a],
        uWaterlineWakePoints[b],
        uWaterlineWakeTear
      );
      float starboardDistance = distanceToSweptWakeSegment(
        p,
        uWaterlineWakePoints[a + 1],
        uWaterlineWakePoints[b + 1],
        uWaterlineWakeTear
      );
      float distanceToSource = min(portDistance, starboardDistance);
      float segmentSource = (
        1.0 - smoothstep(sourceRadius * 0.22, sourceRadius, distanceToSource)
      ) * footprintWeight;
      // Max, not sum: resampling density must not make the source brighter.
      waterlineSource = max(waterlineSource, segmentSource);
    }
    injected += uWaterlineWakeRate * (waterlineSource * uDeltaTime);
  }

  // Additive colour blending must not accumulate alpha in the RGBA16F target.
  gl_FragColor = vec4(injected, 0.0);
}
`;

/**
 * Age the field and carry it downwind.
 *
 * These are one pass because they are one operation on the same texels: what a
 * patch of foam does between two updates is get older and move. Sampling the
 * previous field at an offset is the move; multiplying by exp(-dt/tau) is the
 * ageing, and it is exact at any step, so the decay is independent of the
 * update rate.
 *
 * The offset wraps, because the source is repeat-wrapped. Foam that leaves the
 * downwind edge of the window re-enters at the upwind edge — which is a lie,
 * but a lie about water 190 m away that is already faded out by the lookup, and
 * one whose scale is set by how far foam can travel before it decays: about
 * sixteen metres of a 384 m window at the roughest preset.
 */
const ADVECT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uPrevious;
uniform vec3 uDecay;
uniform vec2 uScroll;
/**
 * Edge of this level's window, in uv-from-centre, over which surviving foam is
 * crushed to nothing. Beyond 0.5 there is no such band and the term is inert.
 *
 * Every level is a torus: what scrolls off one edge re-enters on the opposite
 * one. It is plainly not harmless for the hull level: 96 m is twenty-six seconds
 * at tow speed against B's 45 s time constant, so half of the trail
 * survives the trip round and sails back through the window as a second,
 * parallel wake — which is exactly what Ash saw, a ghost every window off to one
 * side.
 *
 * WK-R10: the near level got no such band because it was argued safe, and the
 * argument was wrong. Its own note read "384 m against a trail whose B channel
 * e-folds in about 160 m, so anything that comes back around has been
 * multiplied by 2^-9". Those two numbers are inconsistent: 384 m at a 160 m
 * e-fold is exp(-2.4), which is **nine per cent**, not 2^-9's two tenths of
 * one per cent. 2^-9 would need a 62 m e-fold. Nine per cent of a trail that
 * WK-R6 then widened from the bow third to the whole waterline, routed into
 * coverage by the trail foam floor, is a legible second streak — and because the
 * near lookup only fades in from 0.443 (170 m), the ghost re-enters unseen at
 * 192 m and then sails INWARD into view. Ash reported it at about 100 m.
 *
 * So no level is allowed to carry what it cannot hold, and the band is placed
 * per level strictly OUTSIDE that level's own lookup fade — where the field is
 * already contributing exactly nothing, which is what makes it free. Nothing
 * reaches any wrap alive, whatever the persistence or the injected area does
 * next. This is a structural rule now, not a per-level judgement call.
 */
uniform vec2 uEdgeKill;
varying vec2 vUv;
void main() {
  vec3 previous = texture2D(uPrevious, vUv - uScroll).rgb;
  vec2 fromCentre = abs(vUv - 0.5);
  float edge = max(fromCentre.x, fromCentre.y);
  float keep = 1.0 - smoothstep(uEdgeKill.x, uEdgeKill.y, edge);
  gl_FragColor = vec4(previous * uDecay * keep, 1.0);
}
`;

/**
 * One resolution of the field, double-buffered.
 *
 * Advection has to read the whole field to write the whole field, so it cannot
 * be done in place. The pair costs 320 kB across both levels.
 */
interface Level {
  targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /** Index of the target holding the current field. The other is scratch. */
  read: 0 | 1;
  extent: number;
  resolution: number;
  /** Band, in uv-from-centre, over which this level kills recirculating foam. */
  edgeKill: THREE.Vector2;
  /**
   * Parameter position of the texture centre — the sub-texel scroll remainder
   * from `quantizeFoamFieldScroll`, never more than half a texel from zero.
   * Injection and the ocean lookup both subtract it, so the window stays on
   * the observer while the advection copy stays texel-exact.
   */
  origin: THREE.Vector2;
  /** Scratch for the whole-texel shift, in texels. */
  shiftTexels: THREE.Vector2;
}

export class FoamField {
  readonly nearExtent = FOAM_NEAR_EXTENT;
  readonly farExtent = FOAM_FAR_EXTENT;

  /**
   * Per-level window centres, in parameter space.
   *
   * Parameter space is the render frame and the vessel sits at its origin, so
   * these stay within half a texel of zero: encounter motion is applied to the
   * field contents as whole-texel shifts, and the sub-texel remainder lives
   * here (see `quantizeFoamFieldScroll`). They are fields rather than
   * constants because the lookup's fade is keyed on distance from them, and a
   * window centred anywhere other than on the observer fades the whole
   * persistent field out of the frame — which is exactly what used to happen,
   * see `drift` below.
   */
  get nearOrigin(): THREE.Vector2 {
    return this.levels[0].origin;
  }

  get farOrigin(): THREE.Vector2 {
    return this.levels[1].origin;
  }

  get hullOrigin(): THREE.Vector2 {
    return this.levels[2].origin;
  }

  /**
   * Metres of sea per near-level texel — 0.75 m at the desktop resolution.
   *
   * Read rather than assumed, because the mobile profile halves the resolution
   * and doubles this. Any diagnostic that quotes a lookup offset in metres has
   * to quote it against the level it will actually run on.
   */
  get nearTexelSizeM(): number {
    return this.levels[0].extent / this.levels[0].resolution;
  }

  /** Metres of sea per hull-level texel — 0.375 m at the desktop resolution. */
  get hullTexelSizeM(): number {
    return this.levels[2].extent / this.levels[2].resolution;
  }

  /**
   * Total distance the surface has drifted relative to the wave field.
   *
   * Diagnostic only, and deliberately so. This used to *be* the window centre:
   * injection and lookup shared it, so the pair stayed consistent and the foam
   * genuinely rode the drifting water. What it also did was walk the window
   * away from the raft at the Stokes-plus-wind rate — 1.35 m/s in the Southern
   * preset — while the lookup faded each level out by distance from that
   * centre. The near level was gone 81 seconds after a reset and the far level
   * within nine minutes, and since the offset was wrapped into [0, 1536) rather
   * than about zero, a fresh warm-up usually started most of a wrap out. The
   * whole persistent whitewater system was therefore invisible in ordinary
   * play, and no amount of foam gain could bring it back: the fade had already
   * multiplied it by zero. Drift is now applied where it belongs, to the
   * contents, by the advection pass.
   */
  readonly drift = new THREE.Vector2();

  private readonly levels: Level[];
  private readonly injectMaterial: THREE.ShaderMaterial;
  private readonly advectMaterial: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();
  private readonly quality: FoamQuality;

  private accumulator = 0;
  private warmed = false;
  private readonly breakBandScratch: [number, number] = [0, 0];
  private readonly advectionStep = { x: 0, z: 0 };

  constructor(waves: WaveField, quality: FoamQuality) {
    this.quality = quality;

    // Half float where it exists — an 8-bit field stalls its exponential decay
    // at 1/255 and leaves a permanent haze of stale foam. It is a graceful
    // fallback rather than a requirement, because that haze is faint.
    const type = THREE.HalfFloatType;
    const makeTarget = (resolution: number): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(resolution, resolution, {
        // WebGL has no portable renderable RGB16F target. RGBA16F is the
        // compatible migration from RG16F and leaves A as an explicit, stable
        // bookkeeping channel while B stores hull turbulence.
        format: THREE.RGBAFormat,
        type,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.RepeatWrapping,
        wrapT: THREE.RepeatWrapping,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    const make = (
      resolution: number,
      extent: number,
      edgeKill: THREE.Vector2,
    ): Level => ({
      targets: [makeTarget(resolution), makeTarget(resolution)],
      read: 0,
      extent,
      resolution,
      origin: new THREE.Vector2(),
      shiftTexels: new THREE.Vector2(),
      edgeKill,
    });
    // Every level gets a band, placed strictly outside the point where its OWN
    // lookup fade in `persistentFoamField` has already reached zero. Starting
    // one any earlier punches a dark ring through the crossfade, because the
    // level still carries real weight inside its fade. Placed correctly the
    // band costs nothing visible and makes recirculation impossible for all
    // three, which is what stops the next change to persistence or to injected
    // area quietly reopening R5-3.
    //
    // near and hull fade out at 0.443; far fades out at 0.456.
    const NEAR_EDGE_KILL = new THREE.Vector2(0.45, 0.49);
    const FAR_EDGE_KILL = new THREE.Vector2(0.462, 0.49);
    const HULL_EDGE_KILL = new THREE.Vector2(0.45, 0.49);

    // Ordered by age, not by scale: index 0 and 1 stay near and far so that
    // `readLevel`'s published 0 | 1 contract, and every diagnostic built on it,
    // keep meaning what they meant. The levels are independent of one another
    // and of their order — each carries the same quantity over its own window —
    // so nothing but the getters below cares.
    this.levels = [
      make(quality.nearResolution, FOAM_NEAR_EXTENT, NEAR_EDGE_KILL),
      make(quality.farResolution, FOAM_FAR_EXTENT, FAR_EDGE_KILL),
      make(quality.hullResolution, FOAM_HULL_EXTENT, HULL_EDGE_KILL),
    ];

    this.injectMaterial = new THREE.ShaderMaterial({
      vertexShader: INJECT_VERT,
      fragmentShader: INJECT_FRAG,
      defines: { NUM_WAVES: MAX_WAVES },
      uniforms: {
        // Shared by reference with the ocean material, so the field is always
        // generated from exactly the components being drawn and sampled.
        uWaveA: { value: waves.waveA },
        uWaveB: { value: waves.waveB },
        uWaveAmp: { value: waves.amplitude },
        uWaveOrigin: { value: new THREE.Vector2() },
        uResidualMaxK: { value: 1e9 },
        uFieldOrigin: { value: new THREE.Vector2() },
        uFieldExtent: { value: FOAM_NEAR_EXTENT },
        uTexelSize: { value: 1 },
        // A PLACEHOLDER, AND DELIBERATELY NOT A PLAUSIBLE WIND.
        //
        // WX2 killed the 6 m/s that used to sit here. `update()` writes both of
        // these from the frame's present wind before the field is ever stepped,
        // so the only life these values have is between construction and the
        // first step — but 6 m/s at due east read exactly like a real wind, and
        // a publish path that broke would have substituted it silently. Zero
        // wind is a state that shows: no gust patches, no windrows, no
        // generation gate. `uWindDir` stays a unit vector because it is used as
        // a direction rather than a velocity.
        uWindDir: { value: new THREE.Vector2(1, 0) },
        uWindSpeed: { value: 0 },
        uBreakBand: { value: new THREE.Vector2(0.56, 0.88) },
        uGeneration: { value: 1 },
        uGustiness: { value: 0.3 },
        uCatsPawGustExcessMps: { value: 0 },
        uCatsPawOriginCycles: { value: new THREE.Vector3() },
        uCatsPawAxisXCyclesPerM: { value: new THREE.Vector3() },
        uCatsPawAxisZCyclesPerM: { value: new THREE.Vector3() },
        uNoiseTime: { value: 0 },
        uDeltaTime: { value: 1 / 30 },
        uStreak: { value: 0.3 },
        uTau: { value: new THREE.Vector3(ACTIVE_TAU, 7, HULL_TURBULENCE_DEFAULT_TAU) },
        uHullWakePort: { value: new THREE.Vector2() },
        uHullWakeStarboard: { value: new THREE.Vector2() },
        uHullWakeRadius: { value: 0.55 },
        uHullWakeRate: { value: new THREE.Vector3() },
        uHullWakeRailBias: { value: 0 },
        uWaterlineWakePoints: {
          value: Array.from(
            { length: MAX_WATERLINE_WAKE_POINTS },
            () => new THREE.Vector2(),
          ),
        },
        uWaterlineWakeStationCount: { value: 0 },
        uWaterlineWakeRadius: { value: 0.48 },
        uWaterlineWakeTear: { value: new THREE.Vector2() },
        uWaterlineWakeRate: { value: new THREE.Vector3() },
        uWaterlineWakeBounds: { value: new THREE.Vector4() },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.injectMaterial.defines = {
      ...this.injectMaterial.defines,
      MAX_WATERLINE_WAKE_POINTS,
      MAX_WATERLINE_WAKE_STATIONS,
    };

    this.advectMaterial = new THREE.ShaderMaterial({
      vertexShader: INJECT_VERT,
      fragmentShader: ADVECT_FRAG,
      uniforms: {
        uPrevious: { value: null },
        uDecay: { value: new THREE.Vector3(1, 1, 1) },
        uScroll: { value: new THREE.Vector2() },
        uEdgeKill: { value: new THREE.Vector2(1, 2) },
      },
      depthTest: false,
      depthWrite: false,
      // Writes the whole target from the previous one, so it neither blends
      // with nor needs a clear of whatever the scratch buffer last held.
      blending: THREE.NoBlending,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.advectMaterial);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /**
   * The field as it stands.
   *
   * A getter, not a fixed texture: the levels ping-pong, so whoever samples
   * this has to re-read it. `Ocean.attachFoam` is called every frame for that
   * reason.
   */
  get nearTexture(): THREE.Texture {
    return this.levels[0].targets[this.levels[0].read].texture;
  }

  get farTexture(): THREE.Texture {
    return this.levels[1].targets[this.levels[1].read].texture;
  }

  get hullTexture(): THREE.Texture {
    return this.levels[2].targets[this.levels[2].read].texture;
  }

  /** Wipe all foam history. */
  clear(renderer: THREE.WebGLRenderer): void {
    const previous = renderer.getRenderTarget();
    const previousClear = new THREE.Color();
    renderer.getClearColor(previousClear);
    const previousAlpha = renderer.getClearAlpha();
    for (const level of this.levels) {
      // Both halves: the scratch buffer becomes the field on the next step, so
      // stale content in it is history that was supposed to be wiped.
      for (const target of level.targets) {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
      }
    }
    renderer.setRenderTarget(previous);
    renderer.setClearColor(previousClear, previousAlpha);
    this.drift.set(0, 0);
    for (const level of this.levels) level.origin.set(0, 0);
    this.warmed = false;
    this.accumulator = 0;
  }

  /**
   * Read the field back for diagnostics. Half-float targets read as raw 16-bit
   * words, so the caller gets decoded floats rather than a buffer whose type
   * silently disagrees with the texture's.
   *
   * The stride is four: WK1 migrated the targets from RG16F to RGBA16F so B can
   * carry hull turbulence. A is deliberately ignored; the advect pass pins it
   * to one and the additive inject pass preserves it.
   */
  readLevel(
    renderer: THREE.WebGLRenderer,
    level: 0 | 1,
  ): {
    width: number;
    height: number;
    active: Float32Array;
    residual: Float32Array;
    turbulence: Float32Array;
  } {
    const target = this.levels[level].targets[this.levels[level].read];
    const { width, height } = target;
    const raw = new Uint16Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
    const active = new Float32Array(width * height);
    const residual = new Float32Array(width * height);
    const turbulence = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      active[i] = decodeHalf(raw[i * 4]);
      residual[i] = decodeHalf(raw[i * 4 + 1]);
      turbulence[i] = decodeHalf(raw[i * 4 + 2]);
    }
    return { width, height, active, residual, turbulence };
  }

  /** True while the field has not yet reached its steady state. */
  get needsWarmup(): boolean {
    return !this.warmed;
  }

  /**
   * Advance the field.
   *
   * `frozen` holds the history still without stopping it being drawn, which is
   * how the lab inspects a single foam pattern from several angles.
   */
  update(
    renderer: THREE.WebGLRenderer,
    waves: WaveField,
    dt: number,
    options: FoamFieldUpdateOptions,
  ): void {
    if (options.frozen) return;

    const step = 1 / this.quality.updateHz;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < 4) {
      this.simulate(renderer, waves, step, options, true);
      this.accumulator -= step;
      steps++;
    }
    if (steps >= 4) this.accumulator = 0;
  }

  /**
   * Run the field forward to its steady state.
   *
   * Foam has a memory measured in tens of seconds, so a field starting from
   * zero is visibly wrong for as long as its own longest time constant. Every
   * reset pays that cost up front instead of showing a clean sea that slowly
   * grows foam.
   *
   * Two things this has to get right. The step is coarse — the field is only
   * ever asked for two time constants of history, and exponential decay is
   * exact at any step, so a 40-iteration warm-up is indistinguishable from a
   * 1000-iteration one at a fraction of the cost. And the *wave field must
   * advance with it*: injecting forty times at a single instant would pile
   * forty copies of one frozen crest pattern into the field rather than a
   * history of crests that came and went. The wave clock is restored exactly
   * afterwards, so nothing outside this call can tell it moved.
   */
  warmUp(
    renderer: THREE.WebGLRenderer,
    waves: WaveField,
    options: FoamFieldUpdateOptions,
  ): void {
    const STEPS = 40;
    const seconds = Math.min(options.persistenceSeconds * 2.2 + 4, 40);
    const step = seconds / STEPS;

    const restoreTime = waves.time;
    const wasFrozen = waves.frozen;
    waves.frozen = false;
    // Start `seconds` in the past and walk forward to now, so the field ends at
    // exactly the instant the caller is about to draw.
    for (let i = STEPS; i > 0; i--) {
      waves.setTime(restoreTime - i * step);
      // A reset has no ship-track history to reconstruct. Injecting the current
      // stern forty times would invent one stationary white disc, not a wake.
      this.simulate(renderer, waves, step, options, false);
    }
    waves.setTime(restoreTime);
    waves.frozen = wasFrozen;

    this.warmed = true;
    this.accumulator = 0;
  }

  private simulate(
    renderer: THREE.WebGLRenderer,
    waves: WaveField,
    dt: number,
    options: FoamFieldUpdateOptions,
    allowHullWake: boolean,
  ): void {
    // Slow uniform drift of surface water relative to the wave field: Stokes
    // drift plus the wind's direct drag. It moves the foam, not the window the
    // foam is stored in — see `drift`.
    const driftSpeed = options.windAdvection * options.windSpeed;
    const windStepX = options.windDir.x * driftSpeed * dt;
    const windStepZ = options.windDir.y * driftSpeed * dt;
    // Existing water/foam moves downwind in an Earth-local frame and backwards
    // past an observer travelling through it. New injection below is evaluated
    // at the current wave origin, so both halves meet in the same local space.
    foamFieldAdvectionStep(
      dt,
      options.windDir,
      options.windSpeed,
      options.windAdvection,
      options.observerVelocity,
      this.advectionStep,
    );
    const stepX = this.advectionStep.x;
    const stepZ = this.advectionStep.z;
    this.drift.x += windStepX;
    this.drift.y += windStepZ;

    const previousTarget = renderer.getRenderTarget();
    // The whole point of this field is that it remembers. `render()` clears its
    // target by default, which would wipe the history before every pass and
    // leave exactly one frame of injection — foam with no persistence at all,
    // which is the thing this system exists to stop being.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    const residualTau = Math.max(options.persistenceSeconds, 0.4);
    const advect = this.advectMaterial.uniforms;
    const turbulenceTau = Math.max(
      options.hullWake?.turbulenceTauSeconds ?? HULL_TURBULENCE_DEFAULT_TAU,
      1,
    );
    (advect.uDecay.value as THREE.Vector3).set(
      foamDecayFactor(dt, ACTIVE_TAU),
      foamDecayFactor(dt, residualTau),
      foamDecayFactor(dt, turbulenceTau),
    );

    const u = this.injectMaterial.uniforms;
    u.uWaveAmp.value = waves.amplitude;
    (u.uWaveOrigin.value as THREE.Vector2).set(0, 0);
    (u.uWindDir.value as THREE.Vector2).copy(options.windDir);
    u.uWindSpeed.value = options.windSpeed;
    waves.breakBand(this.breakBandScratch);
    (u.uBreakBand.value as THREE.Vector2).set(
      this.breakBandScratch[0],
      this.breakBandScratch[1],
    );
    u.uGeneration.value = options.generation;
    u.uGustiness.value = options.gustiness;
    const catsPaw = options.catsPaw;
    u.uCatsPawGustExcessMps.value = catsPaw?.gustExcessMps ?? 0;
    if (catsPaw) {
      (u.uCatsPawOriginCycles.value as THREE.Vector3).set(
        catsPaw.originCycles.x,
        catsPaw.originCycles.y,
        catsPaw.originCycles.z,
      );
      (u.uCatsPawAxisXCyclesPerM.value as THREE.Vector3).set(
        catsPaw.axisXCyclesPerM.x,
        catsPaw.axisXCyclesPerM.y,
        catsPaw.axisXCyclesPerM.z,
      );
      (u.uCatsPawAxisZCyclesPerM.value as THREE.Vector3).set(
        catsPaw.axisZCyclesPerM.x,
        catsPaw.axisZCyclesPerM.y,
        catsPaw.axisZCyclesPerM.z,
      );
    }
    u.uStreak.value = options.streak;
    u.uNoiseTime.value = options.noiseTime;
    u.uDeltaTime.value = dt;
    (u.uTau.value as THREE.Vector3).set(ACTIVE_TAU, residualTau, turbulenceTau);

    const hullWake = options.hullWake;
    const hullWakeEnabled = allowHullWake && hullWake?.enabled === true;
    (u.uHullWakeRate.value as THREE.Vector3).set(
      hullWakeEnabled ? hullWake.activeFoamRatePerSecond : 0,
      hullWakeEnabled ? hullWake.residualFoamRatePerSecond : 0,
      hullWakeEnabled ? hullWake.turbulenceRatePerSecond : 0,
    );
    if (hullWake) {
      (u.uHullWakePort.value as THREE.Vector2).set(hullWake.portX, hullWake.portZ);
      (u.uHullWakeStarboard.value as THREE.Vector2).set(
        hullWake.starboardX,
        hullWake.starboardZ,
      );
      u.uHullWakeRadius.value = Math.max(hullWake.radiusM, 0.01);
      u.uHullWakeRailBias.value = Math.min(Math.max(hullWake.railBias, 0), 1);
    }

    const waterlineWake = options.waterlineWake;
    const waterlineWakeEnabled =
      allowHullWake && waterlineWake?.enabled === true;
    const waterlineStationCount = waterlineWakeEnabled
      ? Math.min(
          Math.max(Math.floor(waterlineWake?.stationCount ?? 0), 0),
          MAX_WATERLINE_WAKE_STATIONS,
        )
      : 0;
    u.uWaterlineWakeStationCount.value = waterlineStationCount;
    (u.uWaterlineWakeRate.value as THREE.Vector3).set(
      waterlineWakeEnabled
        ? waterlineWake?.activeFoamRatePerSecond ?? 0
        : 0,
      waterlineWakeEnabled
        ? waterlineWake?.residualFoamRatePerSecond ?? 0
        : 0,
      waterlineWakeEnabled
        ? waterlineWake?.turbulenceRatePerSecond ?? 0
        : 0,
    );
    if (waterlineWake) {
      const points = u.uWaterlineWakePoints.value as THREE.Vector2[];
      let minimumX = Number.POSITIVE_INFINITY;
      let maximumX = Number.NEGATIVE_INFINITY;
      let minimumZ = Number.POSITIVE_INFINITY;
      let maximumZ = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < waterlineStationCount * 2; i++) {
        const point = waterlineWake.points[i];
        points[i].set(point.x, point.z);
        minimumX = Math.min(
          minimumX,
          point.x,
          point.x + waterlineWake.tearX,
        );
        maximumX = Math.max(
          maximumX,
          point.x,
          point.x + waterlineWake.tearX,
        );
        minimumZ = Math.min(
          minimumZ,
          point.z,
          point.z + waterlineWake.tearZ,
        );
        maximumZ = Math.max(
          maximumZ,
          point.z,
          point.z + waterlineWake.tearZ,
        );
      }
      const radius = Math.max(waterlineWake.radiusM, 0.01);
      u.uWaterlineWakeRadius.value = radius;
      (u.uWaterlineWakeTear.value as THREE.Vector2).set(
        waterlineWake.tearX,
        waterlineWake.tearZ,
      );
      if (waterlineStationCount > 0) {
        (u.uWaterlineWakeBounds.value as THREE.Vector4).set(
          minimumX,
          maximumX,
          minimumZ,
          maximumZ,
        );
      }
    }

    for (const level of this.levels) {
      const source = level.targets[level.read];
      const destination = level.targets[level.read ^ 1];
      renderer.setRenderTarget(destination);

      // Age and advect the existing field into the scratch buffer. The scroll
      // is quantised to whole texels of this level, with the sub-texel
      // remainder carried in the level's origin, so the bilinear copy lands
      // exactly on texel centres and cannot blur — see
      // `quantizeFoamFieldScroll` for why a fractional scroll is fatal here.
      // The near field therefore shifts four texels for every one of the far
      // field's — the same physical speed, which is the point.
      quantizeFoamFieldScroll(
        stepX,
        stepZ,
        level.extent / level.resolution,
        level.origin,
        level.shiftTexels,
      );
      advect.uPrevious.value = source.texture;
      (advect.uScroll.value as THREE.Vector2).set(
        level.shiftTexels.x / level.resolution,
        level.shiftTexels.y / level.resolution,
      );
      (advect.uEdgeKill.value as THREE.Vector2).copy(level.edgeKill);
      this.quad.material = this.advectMaterial;
      renderer.render(this.scene, this.camera);

      // Then add this step's breaking on top of it, evaluated at the true
      // parameter position of each texel of the shifted grid.
      (u.uFieldOrigin.value as THREE.Vector2).copy(level.origin);
      u.uFieldExtent.value = level.extent;
      u.uTexelSize.value = level.extent / level.resolution;
      this.quad.material = this.injectMaterial;
      renderer.render(this.scene, this.camera);

      level.read = (level.read ^ 1) as 0 | 1;
    }

    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
  }

  /** Bytes of GPU memory held by the field. Both halves of each level. */
  get memoryBytes(): number {
    let total = 0;
    // resolution² × RGBA × half-float bytes × two ping-pong targets.
    for (const level of this.levels) total += level.resolution * level.resolution * 4 * 2 * 2;
    return total;
  }

  dispose(): void {
    for (const level of this.levels) for (const target of level.targets) target.dispose();
    this.injectMaterial.dispose();
    this.advectMaterial.dispose();
    this.quad.geometry.dispose();
  }
}

/** IEEE 754 binary16 -> number. Used only by the diagnostic readback. */
function decodeHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}
