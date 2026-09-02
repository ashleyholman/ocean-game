/**
 * Presentation-only policy for hull-sourced water effects.
 *
 * This module converts physical/observed inputs into renderer gains. It owns no
 * history and has no route back to the vessel, WaveField, or canonical world
 * state. WK1 uses only the stern terms; later rounds extend the same result
 * graph for the bow and spray rather than growing preset-specific tables.
 */

/**
 * Classic displacement hull speed — 1.34 kn·√LWL(ft) for the schooner's
 * 14.3 m waterline — used to non-dimensionalise the stern drive.
 *
 * This deliberately equals the sailing thread's `SAILING_HULL_SPEED_MPS`
 * (`SailingForceEvidence.ts`). The agreement is pinned by test rather than by
 * import so the render bundle does not depend on an evidence harness. The
 * "5.875 m/s hull-speed bound" in the S2/S3 documents is this same number
 * times the polar's stated 1.25 surfing allowance, not a competing hull
 * speed. Above 4.7 m/s — the Southern reference reach solves at 5.29 m/s —
 * the stern drive deliberately saturates through the `speedFraction` clamp
 * below rather than extrapolating V² into surfing states.
 */
export const WAKE_POLICY_HULL_SPEED_MPS = 4.7;

/**
 * Recovery-round visual numbers, still provisional until Ash accepts the
 * reference-state A/B. Keep them named here so that review changes policy,
 * never sea-state presets or contact geometry.
 *
 * The rates are sized from dwell time, not per se. A texel on the track sits
 * inside the moving stern source for roughly 2·radius/V seconds at ~0.6 mean
 * profile weight, so the density a pass of the ship leaves behind is about
 * rate × 1.2·radius/V. The WK1 rates deposited ~0.1–0.4 — sparse
 * threshold-crossings against the breakup noise, which read as blotches, not
 * a band (and the pre-R1 advection blur then erased even those). These rates
 * put the stern R deposit near saturation at the moderate polar speed, the B
 * deposit near 1, and G at a pale fraction that ages out over the sea's own
 * persistence.
 */
const ACTIVE_FOAM_RATE_AT_HULL_SPEED = 6.0;
const RESIDUAL_FOAM_RATE_AT_HULL_SPEED = 1.8;
const TURBULENCE_RATE_AT_HULL_SPEED = 5.5;
/**
 * The pale worked-water band is the wake's long-lived signature and B is its
 * only carrier: G deliberately rides the sea's own persistence (5–6 s in the
 * moderate preset), so it cannot be the 100 m component. 45 s at 3.5 m/s is a
 * ~150 m e-fold — the deliberate beautiful-lie end of the design's 20–40 s
 * band, chosen after the trail survived R1 and still read short.
 */
const CALM_TURBULENCE_TAU_SECONDS = 45;
const ROUGH_TURBULENCE_TAU_SECONDS = 24;
const BUBBLE_HAZE_GAIN = 0.5;
const WHITECAP_SUPPRESSION_GAIN = 0.45;
/**
 * Fraction of B fed back into the renderer's residual-foam coverage, so the
 * worked band keeps a sparse fleck texture after G has aged out instead of
 * being haze alone. Kept well below 1: the band should read pale and worked,
 * never as a solid white lane.
 */
const TRAIL_FOAM_FLOOR_GAIN = 0.28;
/**
 * Bias of stern R/G injection toward the ends of the resolved stern cut. The
 * white water of a real wake rides the two quarter-wave shoulders with a
 * darker churned core between them; the B band stays full-width. 0 is a flat
 * profile; 1 concentrates strongly at the rails.
 */
const STERN_RAIL_BIAS = 0.55;

export interface WakeTrailPolicyInput {
  /** Current speed through water. Current is absent today, so this is |encounter velocity|. */
  speedThroughWaterMps: number;
  /** Monahan ambient whitecap fraction for the current wind. */
  ambientWhitecapCoverage: number;
  /** Ten-metre wind speed, used to shorten the trail as mixing rises. */
  windSpeedMps: number;
  /** Resolved horizontal width of this frame's stern waterline cut. */
  sternWidthM: number;
  /** False when the contact adapter has no complete two-sided stern cut. */
  sternSourceAvailable: boolean;
}

export interface WakeTrailPolicyResult {
  /** Additive field-density rates, per second, for R/G/B respectively. */
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
  /** Radius of the stern segment source before texel-footprint filtering. */
  sourceRadiusM: number;
  /** Exact exponential-decay time constant for FoamField's B channel. */
  turbulenceTauSeconds: number;
  /** Small lit albedo contribution at B = 1. */
  bubbleHaze: number;
  /** Fraction of instantaneous ambient breaking suppressed at B = 1. */
  whitecapSuppression: number;
  /** Residual-foam coverage contributed per unit B — the band's fleck floor. */
  trailFoamFloor: number;
  /** 0..1 concentration of stern R/G at the cut's ends (the foam rails). */
  railBias: number;
  /** Diagnostic 0..1 measure of how much the ambient sea masks the hull wake. */
  seaMask: number;
}

export interface WakeTrailAppearanceGains {
  bubbleHaze: number;
  whitecapSuppression: number;
  trailFoamFloor: number;
}

export function createWakeTrailPolicyResult(): WakeTrailPolicyResult {
  return {
    activeFoamRatePerSecond: 0,
    residualFoamRatePerSecond: 0,
    turbulenceRatePerSecond: 0,
    sourceRadiusM: 0.55,
    turbulenceTauSeconds: CALM_TURBULENCE_TAU_SECONDS,
    bubbleHaze: BUBBLE_HAZE_GAIN,
    whitecapSuppression: WHITECAP_SUPPRESSION_GAIN,
    trailFoamFloor: TRAIL_FOAM_FLOOR_GAIN,
    railBias: STERN_RAIL_BIAS,
    seaMask: 0,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function smoothstep(value: number, low: number, high: number): number {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative, got ${value}`);
  }
}

/**
 * Resolve WK1's stern policy into a caller-owned stable result.
 *
 * The exact-zero branch is deliberate. WK0 measured 0.675 m/s p95 bow entry
 * speed while anchored, proving that contact violence is not a command to make
 * a wake. The only WK1 drive is speed through water; zero means zero injection
 * even while waves continue to move against the hull.
 */
export function resolveWakeTrailPolicy(
  input: Readonly<WakeTrailPolicyInput>,
  out: WakeTrailPolicyResult,
): WakeTrailPolicyResult {
  assertFiniteNonNegative(input.speedThroughWaterMps, 'speed through water');
  assertFiniteNonNegative(input.ambientWhitecapCoverage, 'ambient whitecap coverage');
  assertFiniteNonNegative(input.windSpeedMps, 'wind speed');
  assertFiniteNonNegative(input.sternWidthM, 'stern width');

  // Monahan W is about 0.2% in the moderate reference and 6% in Southern
  // rough. The ramp therefore leaves ordinary sailing alone and progressively
  // narrows/dims the hull source only once ambient whitewater can mask it.
  const seaMask = smoothstep(input.ambientWhitecapCoverage, 0.005, 0.06);
  const windMixing = smoothstep(input.windSpeedMps, 4, 18);
  const mixing = Math.max(seaMask, windMixing * 0.7);
  const seaVisibility = 1 - 0.35 * seaMask;

  out.seaMask = seaMask;
  out.turbulenceTauSeconds =
    CALM_TURBULENCE_TAU_SECONDS +
    (ROUGH_TURBULENCE_TAU_SECONDS - CALM_TURBULENCE_TAU_SECONDS) * mixing;
  out.bubbleHaze = BUBBLE_HAZE_GAIN * seaVisibility;
  out.whitecapSuppression = WHITECAP_SUPPRESSION_GAIN;
  out.trailFoamFloor = TRAIL_FOAM_FLOOR_GAIN * seaVisibility;
  out.railBias = STERN_RAIL_BIAS;

  // The resolved cut breathes from 0.14 to 3.07 m in WK0. A non-zero floor
  // keeps the source resolvable when a wave leaves only a narrow two-sided cut;
  // the measured width still broadens it, and rough-sea masking narrows it.
  const speedFraction = clamp(
    input.speedThroughWaterMps / WAKE_POLICY_HULL_SPEED_MPS,
    0,
    1.25,
  );
  out.sourceRadiusM = clamp(
    (0.55 + 0.12 * Math.min(input.sternWidthM, 3.2) + 0.12 * speedFraction) *
      (1 - 0.22 * seaMask),
    0.45,
    1.15,
  );

  if (input.speedThroughWaterMps === 0 || !input.sternSourceAvailable) {
    out.activeFoamRatePerSecond = 0;
    out.residualFoamRatePerSecond = 0;
    out.turbulenceRatePerSecond = 0;
    return out;
  }

  // A displacement hull's stern energy scales with V^2. Cap the extrapolation
  // just above hull speed so diagnostic/tow states cannot paint the field.
  const speedDrive = Math.min(speedFraction * speedFraction, 1.4);
  const maskedDrive = speedDrive * (1 - 0.45 * seaMask);
  out.activeFoamRatePerSecond =
    ACTIVE_FOAM_RATE_AT_HULL_SPEED * maskedDrive;
  out.residualFoamRatePerSecond =
    RESIDUAL_FOAM_RATE_AT_HULL_SPEED * maskedDrive;
  out.turbulenceRatePerSecond =
    TURBULENCE_RATE_AT_HULL_SPEED * maskedDrive;
  return out;
}

/** Apply the master and the three B-channel visual levers into caller-owned output. */
export function gateWakeTrailAppearance(
  policy: Readonly<WakeTrailPolicyResult>,
  masterEnabled: boolean,
  bubbleHazeEnabled: boolean,
  whitecapSuppressionEnabled: boolean,
  trailFoamFloorEnabled: boolean,
  out: WakeTrailAppearanceGains,
): WakeTrailAppearanceGains {
  out.bubbleHaze =
    masterEnabled && bubbleHazeEnabled ? policy.bubbleHaze : 0;
  out.whitecapSuppression =
    masterEnabled && whitecapSuppressionEnabled
      ? policy.whitecapSuppression
      : 0;
  out.trailFoamFloor =
    masterEnabled && trailFoamFloorEnabled ? policy.trailFoamFloor : 0;
  return out;
}

/**
 * WK2's first bow/wet-shell numbers, pending Ash's embodied-camera checkpoint.
 * The onset and saturation are physical policy; the presentation gains are
 * named here so visual review changes one policy rather than presets/shaders.
 */
export const BOW_COLLAR_ONSET_SPEED_MPS = 0.8;
/**
 * Re-derived from dwell time, which R2 did for the stern and not for here.
 *
 * A texel's deposit is rate x 1.2 x radius / V, so the bow's smaller source
 * radius (0.61 m against the stern's 1.02 m) costs it a third of its dwell
 * before any rate is chosen. The WK2 numbers ignored that and were read
 * straight across from the stern, which left the collar depositing 0.74 in R
 * against the stern's 1.19 and — the one that mattered — **0.18 in B against
 * 1.09, a factor of six**. B is the worked-water band, so the collar had
 * nothing binding it together between threshold crossings and read as
 * disconnected islands.
 *
 * These target the collar at roughly the stern's R and G (a bow collar is
 * fresh breaking water, if anything whiter than mid-trail) and at 45% of its
 * B, which is the one place the stern genuinely should dominate: a transom
 * churns water, a stem shears past it.
 */
const BOW_COLLAR_ACTIVE_RATE = 6.5;
const BOW_COLLAR_RESIDUAL_RATE = 2.2;
const BOW_COLLAR_TURBULENCE_RATE = 3.0;
/**
 * Seconds of smear given to each point source, to bridge the gap between
 * injection steps rather than to model transport.
 */
const BOW_COLLAR_RESIDENCE_SECONDS = 0.1;
const WET_BAND_BASE_HEIGHT_M = 0.46;
const WET_BAND_SPEED_HEIGHT_M = 0.14;
const WET_BAND_DARKENING = 0.28;
const WET_BAND_ROUGHNESS_SCALE = 0.58;
const BOW_MOUND_NORMAL_STRENGTH = 0.11;

export interface WakeBowPolicyInput {
  speedThroughWaterMps: number;
  ambientWhitecapCoverage: number;
  windSpeedMps: number;
  /** Number of actual bow-side intersections published by WakeSources. */
  bowWaterlinePointCount: number;
}

export interface WakeBowPolicyResult {
  /** Smooth onset-to-hull-speed drive, 0..1. */
  collarDrive: number;
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
  sourceRadiusM: number;
  /** Length of each point source's smear astern along the track. */
  tearLengthM: number;
  wetBandHeightM: number;
  wetBandDarkening: number;
  wetBandRoughnessScale: number;
  /** Normal-only analytic candidate; zero below collar onset. */
  moundNormalStrength: number;
  moundAcrossRadiusM: number;
  moundAlongRadiusM: number;
  seaMask: number;
}

export interface WakeBowAppearanceGains {
  collarEnabled: boolean;
  wetBandEnabled: boolean;
  wetBandHeightM: number;
  wetBandDarkening: number;
  wetBandRoughnessScale: number;
  moundNormalStrength: number;
  moundAcrossRadiusM: number;
  moundAlongRadiusM: number;
}

export function createWakeBowPolicyResult(): WakeBowPolicyResult {
  return {
    collarDrive: 0,
    activeFoamRatePerSecond: 0,
    residualFoamRatePerSecond: 0,
    turbulenceRatePerSecond: 0,
    sourceRadiusM: 0.48,
    tearLengthM: 0,
    wetBandHeightM: WET_BAND_BASE_HEIGHT_M,
    wetBandDarkening: WET_BAND_DARKENING,
    wetBandRoughnessScale: WET_BAND_ROUGHNESS_SCALE,
    moundNormalStrength: 0,
    moundAcrossRadiusM: 0.9,
    moundAlongRadiusM: 1.6,
    seaMask: 0,
  };
}

/** Resolve WK2's continuous bow collar and wet-shell presentation policy. */
export function resolveWakeBowPolicy(
  input: Readonly<WakeBowPolicyInput>,
  out: WakeBowPolicyResult,
): WakeBowPolicyResult {
  assertFiniteNonNegative(input.speedThroughWaterMps, 'speed through water');
  assertFiniteNonNegative(input.ambientWhitecapCoverage, 'ambient whitecap coverage');
  assertFiniteNonNegative(input.windSpeedMps, 'wind speed');
  assertFiniteNonNegative(input.bowWaterlinePointCount, 'bow waterline point count');

  const seaMask = smoothstep(input.ambientWhitecapCoverage, 0.005, 0.06);
  const drive = smoothstep(
    input.speedThroughWaterMps,
    BOW_COLLAR_ONSET_SPEED_MPS,
    WAKE_POLICY_HULL_SPEED_MPS,
  );
  const seaVisibility = 1 - 0.38 * seaMask;
  const sourceAvailable = input.bowWaterlinePointCount >= 1;

  out.seaMask = seaMask;
  out.collarDrive = drive;
  out.sourceRadiusM = clamp(
    (0.48 + 0.16 * drive) * (1 - 0.16 * seaMask),
    0.4,
    0.72,
  );
  // The smear runs ASTERN ALONG THE TRACK, not downwind.
  //
  // It was the wind, at CrestSpray's droplet coupling, which is the right
  // model for water thrown clear into the air and the wrong one for foam in
  // the water. A bow collar is entrained air and waterline shear: it is left
  // behind in the surface the hull passed through, so relative to the ship it
  // streams aft along the track. Coupling it to the wind lifted the whole
  // collar sideways off the hull by up to 1.8 m on a reach — foam sitting
  // beside the ship instead of coming from it. R3 fixed exactly this for the
  // breakup grain (uWakeStreakDir) and missed the injection.
  //
  // Residence stays short: this bridges the gap between injection steps, and
  // the foam field supplies all the history after that.
  out.tearLengthM = clamp(
    input.speedThroughWaterMps * BOW_COLLAR_RESIDENCE_SECONDS,
    0,
    1.8,
  );
  out.wetBandHeightM = WET_BAND_BASE_HEIGHT_M + WET_BAND_SPEED_HEIGHT_M * drive;
  out.wetBandDarkening = WET_BAND_DARKENING * (1 - 0.18 * seaMask);
  out.wetBandRoughnessScale = WET_BAND_ROUGHNESS_SCALE;
  out.moundNormalStrength =
    BOW_MOUND_NORMAL_STRENGTH * drive * (1 - 0.72 * seaMask);
  out.moundAcrossRadiusM = 0.9 + 0.28 * drive;
  out.moundAlongRadiusM = 1.6 + 0.62 * drive;

  if (!sourceAvailable || drive === 0) {
    out.activeFoamRatePerSecond = 0;
    out.residualFoamRatePerSecond = 0;
    out.turbulenceRatePerSecond = 0;
    return out;
  }

  out.activeFoamRatePerSecond = BOW_COLLAR_ACTIVE_RATE * drive * seaVisibility;
  out.residualFoamRatePerSecond =
    BOW_COLLAR_RESIDUAL_RATE * drive * seaVisibility;
  out.turbulenceRatePerSecond =
    BOW_COLLAR_TURBULENCE_RATE * drive * seaVisibility;
  return out;
}

/**
 * WK-R4: the ship's own wave pattern — transverse stern waves plus divergent
 * shoulder wavelets inside the exact Kelvin wedge, rendered as fragment
 * normals only.
 *
 * The deferral argument ("subtle at her Froude numbers") was honest below
 * ~2.6 m/s and wrong above it: at the 3.5–4.1 m/s Ash actually sails,
 * Fr = 0.30–0.35 and the transverse wavelength is 7.9–10.8 m — most of a
 * waterline — which on any real displacement hull is a prominent feature.
 * Onset therefore begins where the honest argument ends.
 */
export const GRAVITY_MPS2 = 9.81;

/** Deep-water transverse wake wavelength, λ = 2πV²/g. */
export function kelvinTransverseWavelengthM(speedMps: number): number {
  return (2 * Math.PI * speedMps * speedMps) / GRAVITY_MPS2;
}

/** The Kelvin half-angle asin(1/3) ≈ 19.47°, a deep-water constant. */
export const KELVIN_HALF_ANGLE_RAD = Math.asin(1 / 3);

const PATTERN_ONSET_MPS = 1.2;
const PATTERN_FULL_MPS = 2.6;
/** Maximum extra surface slope the pattern may add, at full drive on glass. */
const PATTERN_SLOPE_MAX = 0.3;
/** Turn-rate fade band: an analytic steady pattern is only true on a straight run. */
const PATTERN_TURN_FADE_START_RAD_PER_S = 0.035;
const PATTERN_TURN_FADE_END_RAD_PER_S = 0.14;

export interface WakePatternPolicyInput {
  speedThroughWaterMps: number;
  ambientWhitecapCoverage: number;
  /** Magnitude of the vessel's yaw rate, rad/s, presentation-smoothed. */
  turnRateRadPerSec: number;
}

export interface WakePatternPolicyResult {
  wavelengthM: number;
  /** Slope amplitude for the fragment normal; exactly zero disables the block. */
  normalStrength: number;
  wedgeLengthM: number;
  seaMask: number;
}

export function createWakePatternPolicyResult(): WakePatternPolicyResult {
  return {
    wavelengthM: 0,
    normalStrength: 0,
    wedgeLengthM: 0,
    seaMask: 0,
  };
}

export function resolveWakePatternPolicy(
  input: Readonly<WakePatternPolicyInput>,
  out: WakePatternPolicyResult,
): WakePatternPolicyResult {
  assertFiniteNonNegative(input.speedThroughWaterMps, 'speed through water');
  assertFiniteNonNegative(input.ambientWhitecapCoverage, 'ambient whitecap coverage');
  assertFiniteNonNegative(input.turnRateRadPerSec, 'turn rate magnitude');

  const seaMask = smoothstep(input.ambientWhitecapCoverage, 0.005, 0.06);
  const onset = smoothstep(
    input.speedThroughWaterMps,
    PATTERN_ONSET_MPS,
    PATTERN_FULL_MPS,
  );
  const drive = clamp(
    input.speedThroughWaterMps / WAKE_POLICY_HULL_SPEED_MPS,
    0,
    1,
  );
  const turnFade =
    1 -
    smoothstep(
      input.turnRateRadPerSec,
      PATTERN_TURN_FADE_START_RAD_PER_S,
      PATTERN_TURN_FADE_END_RAD_PER_S,
    );

  out.seaMask = seaMask;
  out.wavelengthM = kelvinTransverseWavelengthM(input.speedThroughWaterMps);
  // The pattern drowns under ambient sea energy long before the foam does —
  // 0.85 rather than the trail's 0.45 — and declines to lie through turns.
  out.normalStrength =
    PATTERN_SLOPE_MAX * onset * drive * (1 - 0.85 * seaMask) * turnFade;
  out.wedgeLengthM = clamp(out.wavelengthM * 8, 30, 160);
  return out;
}

/** Gate all WK2 features through the master and their independent toggles. */
export function gateWakeBowAppearance(
  policy: Readonly<WakeBowPolicyResult>,
  masterEnabled: boolean,
  collarEnabled: boolean,
  wetBandEnabled: boolean,
  moundEnabled: boolean,
  out: WakeBowAppearanceGains,
): WakeBowAppearanceGains {
  out.collarEnabled =
    masterEnabled &&
    collarEnabled &&
    policy.activeFoamRatePerSecond > 0;
  out.wetBandEnabled = masterEnabled && wetBandEnabled;
  out.wetBandHeightM = policy.wetBandHeightM;
  out.wetBandDarkening = policy.wetBandDarkening;
  out.wetBandRoughnessScale = policy.wetBandRoughnessScale;
  out.moundNormalStrength =
    masterEnabled && moundEnabled ? policy.moundNormalStrength : 0;
  out.moundAcrossRadiusM = policy.moundAcrossRadiusM;
  out.moundAlongRadiusM = policy.moundAlongRadiusM;
  return out;
}

// ---------------------------------------------------------------------------
// WK3 — episodic water: bow entry spray, and the overtop cue's sizing
// ---------------------------------------------------------------------------

/** Density of sea water, kg/m³. Shared by the two WK3 energy scales. */
const RHO_SEA_WATER = 1025;

/**
 * The entry that counts as "one unit of driving the bow in", in watts.
 *
 * A bow throws water because it is *displacing* water fast, so the honest
 * sizing quantity is a power: the mass rate being shoved aside times the
 * square of the speed it is being shoved at,
 *
 *     P = ½ · ρ · (dV/dt)⁺ · v²
 *
 * with dV/dt the bow third's immersion rate and v its peak wet-contact normal
 * closing speed. Both factors are measured contact kinematics and the product
 * is zero if either is — which is the point. Entry speed alone is not an
 * emitter command (WK0-F1); neither is immersion rate, because a bow can sink
 * gently into a big swell all day.
 *
 * 20 kW is the CURRENT_MODERATE polar reach's own p95, measured over 90 s at
 * 60 Hz on this branch's polar (3.694 m/s): dV/dt⁺ p95 21.0 m³/s, bow peak
 * entry p95 1.520 m/s, entry-power p95 20 206 W. So a drive of 1.0 means
 * "as hard as the top 5% of ordinary moderate sailing", which is the only
 * reference in this file that a person can hold in their head.
 */
export const SPRAY_ENTRY_POWER_REFERENCE_W = 20000;

/**
 * Way through the water below which no entry is drawn, and where it saturates.
 *
 * WK0-F1 measured 0.675 m/s p95 (1.595 m/s max) bow normal entry speed at
 * anchor in CURRENT_MODERATE. This round measured the same case's entry
 * *power*: p95 5 860 W, max 22 931 W — 29% of the moderate reach's p95 and
 * more than its own maximum. So the volume-rate term does not rescue the
 * anchor case either: an anchored hull heaving in a wind sea genuinely is
 * displacing water hard, and only way through the water separates "she is
 * driving her bow in" from "she is bobbing".
 *
 * That is also the physical claim being drawn. The cue is a sheet thrown out
 * and left behind by a stem *moving through* the water; a moored bow throws
 * water straight up and takes it back. The simplification — that a pitching
 * anchored bow throws nothing at all — is deliberate and is in the ledger.
 */
export const SPRAY_WAY_ONSET_MPS = 1.0;

/**
 * Entry drive at which an event fires, calm sea and rough sea.
 *
 * Measured event rates on this branch (120 s, hysteresis 0.5, refractory 1.5 s):
 *
 * | state                     | mask | arm 0.8 | arm 1.0 | arm 2.4 | arm 3.0 |
 * |---------------------------|-----:|--------:|--------:|--------:|--------:|
 * | CURRENT_MODERATE, anchored| 0.00 |       0 |       0 |       0 |       0 |
 * | GLASSY_LONG_SWELL 1.08 m/s| 0.00 |       0 |       0 |       0 |       0 |
 * | CURRENT_MODERATE 3.69 m/s | 0.00 |  ~0.11/s|  0.092/s|       — |  0.025/s|
 * | SOUTHERN_OCEAN 5.42 m/s   | 1.00 |       — |  0.175/s| ~0.115/s|  0.092/s|
 *
 * The 3× ratio between the two ends is not a taste: it is what makes the rate
 * come out the *same* in moderate and in a gale — roughly one burst every nine
 * seconds — so the hull's own punctuation keeps its rhythm while the sea's
 * violence grows around it. That is design §5's "storm = punctuation, not
 * fountain" expressed as a number rather than as an intention.
 */
export const SPRAY_ARM_DRIVE_CALM = 0.5;
export const SPRAY_ARM_DRIVE_ROUGH = 1.5;

/**
 * Fraction of the arm threshold the drive must fall back below to re-arm.
 *
 * Hysteresis, not a timer. One entry is one excursion of the drive, and
 * without a release band the wobble on the way past the threshold is counted
 * as several entries.
 */
export const SPRAY_RELEASE_FRACTION = 0.5;

/**
 * Hard floor on the interval between two events, seconds.
 *
 * This is the rate *ceiling*, and it exists because an event system whose rate
 * is unbounded in a storm is the classic failure of this kind of feature. It
 * is deliberately set well above the natural spacing so it never suppresses a
 * real entry: the measured rates above peak at 0.225/s (EXTREME_DEBUG), and
 * 1.5 s caps the rate at 0.667/s — three times the worst measured sea, and
 * still a hard bound no sea can cross.
 */
export const SPRAY_MINIMUM_INTERVAL_SECONDS = 1.5;

/**
 * Longest a single tear may stay open, seconds.
 *
 * A bound, not a schedule. A tear normally closes because the drive fell back
 * below `SPRAY_RELEASE_FRACTION` of the arm — the sea closes it — and this cap
 * only exists so that a drive pinned high by a pathological state cannot hold
 * one open forever. Half a second is about as long as a stem is still going
 * *in* before it starts coming out again.
 *
 * Together with `SPRAY_MINIMUM_INTERVAL_SECONDS` this is the sustained droplet
 * bound: at most 0.5 s of shedding in every 1.5 s, so the long-run droplet rate
 * cannot exceed a third of `SPRAY_DROPLETS_PER_SECOND_MAX`.
 */
export const SPRAY_TEAR_MAX_SECONDS = 0.5;

/** Droplets per second shed by the weakest and the strongest live tear. */
const SPRAY_DROPLETS_PER_SECOND_MIN = 450;
const SPRAY_DROPLETS_PER_SECOND_MAX = 1800;

/**
 * The hard ceiling on droplets per second this policy can ask for, averaged
 * over any interval longer than one refractory period.
 *
 * Named and exported because it is the round's actual bound, and a bound that
 * is only implied by three other constants is a bound nobody can check.
 * 1800 × 0.5 / 1.5 = 600 droplets a second into a 16 384-droplet desktop
 * pool whose members live under two seconds. This was raised after Ash's first
 * live walk-through could not see the shipping cue at all and clarified that a
 * bow plunge should be a conspicuous ejection, not fine punctuation. The event
 * remains bounded and episodic, but a real one now has enough water to read
 * immediately from the foredeck.
 */
export const SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX =
  (SPRAY_DROPLETS_PER_SECOND_MAX * SPRAY_TEAR_MAX_SECONDS) /
  SPRAY_MINIMUM_INTERVAL_SECONDS;

/**
 * Drive, as a multiple of the arm threshold, at which an event is full strength.
 *
 * Four rather than a smaller number because the drive's upper tail is long: the
 * Southern reach's p99 is 16.8 against a p95 of 2.9. Saturating at 4× the arm
 * leaves the difference between "she put her nose in" and "she buried it"
 * visible instead of clamping the top decile flat.
 */
const SPRAY_SATURATION_MULTIPLE = 4;

/** Fraction of the relative flow the thrown sheet keeps as it leaves the stem. */
const SPRAY_THROW_ALONG_FRACTION = 0.7;
/** Fraction of the closing speed that ends up as lift off the surface. */
const SPRAY_THROW_LIFT_FRACTION = 1.15;

/**
 * How far the entry sheet is folded outboard, as a fraction of the throw.
 *
 * A stem does not throw water straight ahead; it splits it and the sheet
 * leaves along the flare, outboard and up. Sign is set by test, not here.
 */
const SPRAY_THROW_OUTBOARD_FRACTION = 0.85;

/**
 * Coarseness bias handed to the droplet-size draw, 0 = spume, 1 = heavy drops.
 *
 * High, and this is the single number that decides whether the cue reads as
 * bow spray or as fog. `CrestSpray` sizes a droplet's drag time constant as
 * vt/g, so a 100 µm droplet forgets its launch in three frames and simply
 * joins the wind, while a 2 mm one holds its throw for a quarter second and
 * falls out. Sea spume is overwhelmingly the former and is drawn with a cubed
 * variate. Water torn off a stem is a sheet coming apart — much coarser — and
 * given the fine distribution it would blow away downwind the instant it was
 * born instead of arcing out from the bow.
 */
const SPRAY_ENTRY_COARSENESS = 0.82;

/** Per-droplet opacity weight for hull spray, relative to sea spume's. */
const SPRAY_ENTRY_OPACITY = 1.35;

export interface WakeSprayPolicyInput {
  speedThroughWaterMps: number;
  ambientWhitecapCoverage: number;
  /** Rate at which the bow third is burying itself, m³/s. Negative is emerging. */
  bowImmersionRateM3PerSec: number;
  /** Peak wet-contact normal closing speed in the bow third, m/s. */
  bowPeakEntrySpeedMps: number;
}

export interface WakeSprayPolicyResult {
  /** Exactly 0 at rest, 1 at hull speed. WK0-F1's second, separate fact. */
  wayGate: number;
  /** Entry power in watts, before the way gate. Diagnostic. */
  entryPowerW: number;
  /** Dimensionless drive; 1.0 is the moderate reach's p95 entry. */
  entryDrive: number;
  /** Drive at which an event fires. */
  armThreshold: number;
  /** Drive below which the detector re-arms. */
  releaseThreshold: number;
  minimumIntervalSeconds: number;
  /** The bound: events per second this policy can never exceed. */
  eventCeilingPerSecond: number;
  seaMask: number;
}

export function createWakeSprayPolicyResult(): WakeSprayPolicyResult {
  return {
    wayGate: 0,
    entryPowerW: 0,
    entryDrive: 0,
    armThreshold: SPRAY_ARM_DRIVE_CALM,
    releaseThreshold: SPRAY_ARM_DRIVE_CALM * SPRAY_RELEASE_FRACTION,
    minimumIntervalSeconds: SPRAY_MINIMUM_INTERVAL_SECONDS,
    eventCeilingPerSecond: 1 / SPRAY_MINIMUM_INTERVAL_SECONDS,
    seaMask: 0,
  };
}

/**
 * Resolve WK3's entry drive and its firing thresholds.
 *
 * Pure and history-free, exactly like the WK1/WK2 resolvers: the immersion
 * rate arrives already differenced, because the differencing needs a previous
 * frame and this module owns no history. `HullSprayEventDetector` owns it.
 */
export function resolveWakeSprayPolicy(
  input: Readonly<WakeSprayPolicyInput>,
  out: WakeSprayPolicyResult,
): WakeSprayPolicyResult {
  assertFiniteNonNegative(input.speedThroughWaterMps, 'speed through water');
  assertFiniteNonNegative(
    input.ambientWhitecapCoverage,
    'ambient whitecap coverage',
  );
  assertFiniteNonNegative(
    input.bowPeakEntrySpeedMps,
    'bow peak entry speed',
  );
  if (!Number.isFinite(input.bowImmersionRateM3PerSec)) {
    throw new RangeError(
      `bow immersion rate must be finite, got ${input.bowImmersionRateM3PerSec}`,
    );
  }

  const seaMask = smoothstep(input.ambientWhitecapCoverage, 0.005, 0.06);
  const wayGate = smoothstep(
    input.speedThroughWaterMps,
    SPRAY_WAY_ONSET_MPS,
    WAKE_POLICY_HULL_SPEED_MPS,
  );
  // Emerging is not entering. Only the burying half of the cycle drives spray.
  const immersionRate = Math.max(input.bowImmersionRateM3PerSec, 0);
  const entryPowerW =
    0.5 *
    RHO_SEA_WATER *
    immersionRate *
    input.bowPeakEntrySpeedMps *
    input.bowPeakEntrySpeedMps;

  out.seaMask = seaMask;
  out.wayGate = wayGate;
  out.entryPowerW = entryPowerW;
  out.entryDrive = (entryPowerW / SPRAY_ENTRY_POWER_REFERENCE_W) * wayGate;
  out.armThreshold =
    SPRAY_ARM_DRIVE_CALM +
    (SPRAY_ARM_DRIVE_ROUGH - SPRAY_ARM_DRIVE_CALM) * seaMask;
  out.releaseThreshold = out.armThreshold * SPRAY_RELEASE_FRACTION;
  out.minimumIntervalSeconds = SPRAY_MINIMUM_INTERVAL_SECONDS;
  out.eventCeilingPerSecond = 1 / SPRAY_MINIMUM_INTERVAL_SECONDS;
  return out;
}

export interface WakeSprayBurstSizingInput {
  entryDrive: number;
  armThreshold: number;
  /** Peak wet-contact normal closing speed at the entry site, m/s. */
  entrySpeedMps: number;
  /** Horizontal speed of the hull relative to the water at the entry site. */
  relativeFlowMps: number;
  seaMask: number;
}

export interface WakeSprayBurstSizing {
  /** 0..1 size of this event. */
  strength: number;
  /** Shedding rate while the tear is open. Never a per-frame count. */
  dropletsPerSecond: number;
  /** Speed the sheet leaves the stem at, along the flow, m/s. */
  throwSpeedMps: number;
  /** Speed the sheet is squeezed up the surface at, m/s. */
  liftSpeedMps: number;
  /** Fraction of the throw folded outboard along the flare. */
  outboardFraction: number;
  /** Droplet-size bias handed to the emitter: 0 spume, 1 heavy drops. */
  coarseness: number;
  /** Per-droplet opacity weight. */
  opacity: number;
}

export function createWakeSprayBurstSizing(): WakeSprayBurstSizing {
  return {
    strength: 0,
    dropletsPerSecond: 0,
    throwSpeedMps: 0,
    liftSpeedMps: 0,
    outboardFraction: SPRAY_THROW_OUTBOARD_FRACTION,
    coarseness: SPRAY_ENTRY_COARSENESS,
    opacity: SPRAY_ENTRY_OPACITY,
  };
}

/**
 * Size a live tear this frame.
 *
 * Called every frame a tear is open, with the *current* drive, so the shedding
 * follows how hard she is going in right now. Every output is a monotone
 * non-decreasing function of the drive, which is what the round's monotonicity
 * gate is actually about.
 */
export function sizeWakeSprayBurst(
  input: Readonly<WakeSprayBurstSizingInput>,
  out: WakeSprayBurstSizing,
): WakeSprayBurstSizing {
  const arm = Math.max(input.armThreshold, 1e-6);
  const strength = clamp(
    (input.entryDrive / arm - 1) / (SPRAY_SATURATION_MULTIPLE - 1),
    0,
    1,
  );
  // The hull's spray thins as the sea's own violence rises, but far less than
  // the foam does: this water is in the air, above the plane the ambient
  // whitecaps occupy, so it is not competing for the same pixels the way the
  // collar and the pattern are. 0.25 against the trail's 0.45 and the Kelvin
  // pattern's 0.85.
  const seaVisibility = 1 - 0.25 * input.seaMask;

  out.strength = strength;
  out.dropletsPerSecond =
    (SPRAY_DROPLETS_PER_SECOND_MIN +
      (SPRAY_DROPLETS_PER_SECOND_MAX - SPRAY_DROPLETS_PER_SECOND_MIN) *
        strength) *
    seaVisibility;
  out.throwSpeedMps =
    SPRAY_THROW_ALONG_FRACTION * Math.max(input.relativeFlowMps, 0);
  out.liftSpeedMps =
    SPRAY_THROW_LIFT_FRACTION * Math.max(input.entrySpeedMps, 0);
  out.outboardFraction = SPRAY_THROW_OUTBOARD_FRACTION;
  out.coarseness = SPRAY_ENTRY_COARSENESS;
  out.opacity = SPRAY_ENTRY_OPACITY * seaVisibility;
  return out;
}

/**
 * Depth and speed at which water coming aboard is a full wash, for a vessel of
 * this freeboard.
 *
 * `OvertopSpray`'s original curve was `min(1, speed·0.55 + depth·2.2)`, which
 * is the same shape with the references 1/2.2 = 0.4545 m and 1/0.55 = 1.818
 * m/s hidden inside two coefficients. Those were hand-fitted to a raft and are
 * meaningless on a 15.5 m schooner: at her measured overtop peaks (depth
 * 0.151 m, speed 1.329 m/s in the WK-R-F1 reference) the raft curve evaluates
 * to 1.063 and clamps, so a marginal 0.3%-of-frames crossing would have been
 * drawn as a full green-water wash.
 *
 * Freeboard is the only scale in the problem that both vessels have:
 *
 * - depth reference = the freeboard itself. Water standing as deep over the
 *   rail as the rail is above the waterline is, by any reading, a burying.
 * - speed reference = √(2·g·freeboard), the speed a body reaches falling one
 *   freeboard. It is the natural velocity scale for water dropping inboard,
 *   and it costs nothing to derive.
 *
 * The schooner's freeboard is 1.6969 m (mean outer crown 3.9969 − design
 * waterline 2.3000), giving 1.697 m and 5.771 m/s.
 */
export function overtopReferencesFromFreeboard(freeboardM: number): {
  depthReferenceM: number;
  speedReferenceMps: number;
} {
  assertFiniteNonNegative(freeboardM, 'freeboard');
  const depthReferenceM = Math.max(freeboardM, 0.05);
  return {
    depthReferenceM,
    speedReferenceMps: Math.sqrt(2 * GRAVITY_MPS2 * depthReferenceM),
  };
}

/**
 * How hard the water is coming aboard: 0 = a lick, 1 = a proper wash.
 *
 * The form is unchanged from the raft's — a clamped sum of a depth term and a
 * speed term — so a caller that passes the raft's own references gets the raft's
 * own numbers back exactly.
 */
export function overtopEventStrength(
  depthM: number,
  speedMps: number,
  depthReferenceM: number,
  speedReferenceMps: number,
): number {
  return clamp(
    depthM / Math.max(depthReferenceM, 1e-6) +
      speedMps / Math.max(speedReferenceMps, 1e-6),
    0,
    1,
  );
}
