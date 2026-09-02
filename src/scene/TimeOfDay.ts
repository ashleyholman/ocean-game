import * as THREE from 'three';

import {
  isFibonacciAmbientEnabled,
  isFlatSkyMean,
  isLegacyExposure,
  isSunDomeMeanEnabled,
  skyProjection,
  skySaturation,
} from './colourPipeline';
import {
  SH_COEFFICIENTS,
  fibonacciHemisphere,
  flatProbe,
  shBasis,
} from './skyHarmonics';
import { retinalLuminanceCd, twilightLuminanceCd } from './scotopic';
import type { CloudFieldState } from './SkySystem';

/**
 * Scale on the sky's diffuse fill. See where it is applied in the update.
 *
 * 0.80, chosen by eye. The derivation that produced 0.60 targeted an 8:1
 * key-to-fill against a sky at full radiance; with the sky trimmed to 0.6 the
 * fill it casts is already lower, so less of it needs taking out. 1.0 is the
 * flat, overcast-reading daylight this replaced.
 */
export const DEFAULT_SKY_FILL_SCALE = 0.8;

let skyFillScale = DEFAULT_SKY_FILL_SCALE;

/**
 * Exposure multiplier at a high sun, ramping in from zero at the horizon.
 * 1 restores the metered-only daylight that read as overcast.
 *
 * 2.0, and it can be 2.0 now for a reason worth recording. It was backed off
 * to 1.6 when the sky bleached at 2.0 — the sky had three quarters of its
 * pixels at 250+ in blue and no headroom to be lifted into. Trimming the sky's
 * own radiance to 0.6 gave it that headroom, so the lift no longer has to be
 * the compromise: the sky holds its blue and the sunlit subject still climbs.
 * The two controls are a PAIR, and neither number means much alone.
 */
export const DEFAULT_DAYLIGHT_EXPOSURE_LIFT = 2.0;

let daylightExposureLift = DEFAULT_DAYLIGHT_EXPOSURE_LIFT;

export function getDaylightExposureLift(): number {
  return daylightExposureLift;
}

/** Live; the 4 s adaptation carries it in smoothly. */
export function setDaylightExposureLift(lift: number): void {
  daylightExposureLift = Math.min(Math.max(lift, 1), 3);
}


export function getSkyFillScale(): number {
  return skyFillScale;
}

/** Live; takes effect on the next lighting update. */
export function setSkyFillScale(scale: number): void {
  skyFillScale = Math.min(Math.max(scale, 0), 1.5);
}


/**
 * Presentation-only lighting derived from externally supplied astronomical
 * directions. This class deliberately owns no clock, orbit, date or location.
 *
 * The CPU port of the atmospheric model in `shaders/lib.ts` means the
 * directional light, ambient fill and auto-exposure all agree with the sky the
 * player is actually looking at, without a GPU readback.
 */

// Rayleigh scattering per unit air mass (real sea-level optical depths),
// plus Mie scattering and absorption. Must match GLSL_SKY.
const BETA_R = [0.0403, 0.0977, 0.2334] as const;
/**
 * Spectral projection of Rayleigh-scattered light onto the display primaries.
 * Must match GLSL_SKY.
 *
 * BETA_R above is the extinction authority: band-integrated optical depths,
 * which is what transmittance (and therefore the sunset) must use. But the
 * colour of the in-scattered light is a different projection: the sky's
 * broad blue spectrum still excites the red display primary through the
 * colour-matching overlap, which a three-band model has no way to know from a
 * wavelength sample.
 *
 * Derived, not tuned — see `tools/derive-sky-projection.mjs`.
 */

const BETA_M = 0.057;
/** Mie in-scatter, split from Mie extinction. Must match GLSL_SKY. */
const BETA_M_SCAT = 0.010;
const BETA_M_ABS = 0.0075;
const SUN_BELOW = 150.0;
const MULTI = 0.175;
/** Spectral weight exponent of the multi-scatter term. Must match GLSL_SKY. */
const MULTI_SPECTRAL_POW = 1.7;
/**
 * Effective air-mass ceiling for the VIEW path of the in-scatter integral
 * only — transmittance is untouched. Must match GLSL_SKY.
 *
 * With the raw Kasten-Young air mass (~38 at the horizon) the view-path
 * saturation (1 - exp(-betaE * am)) reaches 1 in every channel a dozen
 * degrees above the horizon, which is what painted the wide white band. A
 * real spherical-shell atmosphere never behaves like the flat-slab model
 * there: most of a grazing path crosses thin high air. Compressing the
 * effective path keeps the red channel unsaturated until the last few
 * degrees, which is where the photographs put the pale band.
 */
const AM_VIEW_CAP = 13.0;
/** Overall sky-dome radiance gain. Must match GLSL_SKY. */
const SKY_GAIN = 0.79;
/**
 * Auto-exposure: gain and adaptation strength. See the meter in `update`.
 *
 * K is set so that established daylight lands the zenith near — but not on —
 * display white in the blue channel, which is where a real midday sky sits: a
 * deep saturated blue that is still one of the brighter things in frame.
 */
const EXPOSURE_K = 0.63;
const EXPOSURE_ADAPT = 0.34;
/**
 * Adaptation clamps. Their RATIO is the total gain the meter is allowed to
 * apply across a whole day — about nine stops-worth of range, which is what
 * keeps a night dark while a sunset horizon still has somewhere to go.
 */
export const EXPOSURE_MIN = 0.42;
export const EXPOSURE_MAX = 5.2;
/**
 * Share of the authored airglow the night sky gets. Must match GLSL_SKY.
 *
 * See the long note there: at 1.0 this floor sat above everything meant to
 * light a night — a full moon moved the ambient by 1.21x — which is most of
 * why the world spans 6.5 stops noon-to-night against reality's eighteen.
 */
const NIGHT_BASE_GAIN = 0.25;
/**
 * How hard a low sun holds the warm recolouring on for the low sky in its own
 * azimuth, regardless of how much warm flux is left. Must match GLSL_SKY.
 *
 * Once the disc is on the horizon there is no unreddened source left to fill
 * that part of the sky: everything arriving there has crossed the long, low,
 * reddened path. The flux ratio alone does not say so — it falls as the warm
 * single-scatter term dies, handing the band back to the cool ozone-blue
 * multi-scatter illuminant, which is the sky turning BLUE again with the disc
 * still on the water. Measured at 2 deg elevation in the sun's azimuth, linear
 * blue rose 0.18 -> 0.22 -> 0.30 across sun +1 -> 0 -> -1 while red fell.
 */
const SUNSET_HOLD = 0.75;
/** Ozone, Chappuis band. Must match BETA_O3 in GLSL_SKY. */
const BETA_O3 = [0.022, 0.035, 0.004] as const;

const BETA_E = [
  BETA_R[0] + BETA_M + BETA_M_ABS,
  BETA_R[1] + BETA_M + BETA_M_ABS,
  BETA_R[2] + BETA_M + BETA_M_ABS,
] as const;

/** Rayleigh scale height, metres. Must match ATMO_H in GLSL_SKY. */
const ATMO_H = 8400;

/**
 * The one unit conversion in the whole lighting system.
 *
 * Turns the transmitted sun magnitude — dimensionless, the same
 * `sunTint * transmittance` the sky and ocean use — into three.js light units.
 * Nothing else in the world lighting path carries a gain: the probe publishes
 * at intensity 1, the material factory has no exception, and the sky and ocean
 * keep their own native scale. If some surface needs another constant, that is
 * a bug report rather than a number.
 *
 * WHAT REPLACED WHAT
 * ------------------
 * This used to be `pow(sunMag, 0.52) * 8.0`. The compression was a good lie for
 * the raft era and it is documented as one: a faithful magnitude collapses far
 * faster than the old two-colour ambient fill did at low sun, so the
 * golden-hour sail went mauve under a cool fill that out-voted it. The exponent
 * bought back the warmth by bending the light source.
 *
 * The cost was that the sun-to-sky ratio then depended on elevation, so no
 * single calibration could hold: whatever balance you tuned at noon was wrong
 * at four in the afternoon, and every attempt to light the hull slid around
 * with time of day for that reason. It also silently invalidated
 * `OCEAN_PER_DECK_IRRADIANCE`, whose own comment records that it "drifts below
 * about 10 degrees ... so this is the high-sun ratio" — that drift *was* this
 * exponent.
 *
 * With the fill now a real cosine convolution of a real sky, the lie is no
 * longer needed: a warm low sun keeps its warmth because the transmitted colour
 * is physical and the exposure curve does the rest. Linear also makes the ocean
 * constant an exact conversion at every elevation rather than a high-sun
 * approximation.
 *
 * CALIBRATION
 * -----------
 * Set so the measured clear-sky ratio of direct sun irradiance to the probe's
 * sky irradiance on an upward face lands in the 5-6:1 band a real clear sky
 * gives. Measured, not guessed — `sim.worldLightingDiagnostics()` reports both
 * halves. Clouds off, swept by solar elevation:
 *
 *     elevation   75    60    45    30    15     8
 *     ratio      5.65  5.70  5.79  5.90  6.08  6.28
 *
 * (Measured after the hue-preserving display transform landed. The same sweep
 * under ACES read 5.33 to 5.96 — the sky's spectral projection changed, the
 * flatness did not, which is the property this constant exists to protect.)
 *
 * The flatness is the point, and it is the thing the old exponent could not
 * do. Under `pow(sunMag, 0.52)` this ratio moved with elevation, so the sun and
 * the sky changed their relationship over the course of an afternoon and no
 * single number could balance them. Here it holds to within 6% from overhead
 * down to a hand's breadth off the horizon, which is why the hull can now be
 * judged at one time of day and trusted at another.
 */
export const SUN_IRRADIANCE_SCALE = 9.0;

/**
 * Sun radiance in the sky and ocean shaders' own linear units (`uSunPower`).
 *
 * Exported so `OCEAN_PER_DECK_IRRADIANCE` can be derived from it rather than
 * measured against it. See that constant.
 */
export const SUN_SKY_POWER = 21;

/**
 * Moon radiance in the sky and ocean shaders' own linear units (`uMoonPower`),
 * at full phase and high elevation.
 *
 * 1.0, up from 0.070, and this is Part B of
 * docs/graphics/NIGHT_VISIBILITY_SPEC.md in one number.
 *
 * THE FAULT. Measured on `ambientRadiance` at -25 degrees sun, a full moon at
 * 40 degrees changed the night ambient by 1.79x. Reality is 100-300x. Moonlit
 * and moonless nights were very nearly the same picture, which the spec called
 * the most obviously wrong thing left in the sky.
 *
 * THE VALUE. Sky in-scatter is linear in this, and the display transform's
 * chroma stretch renormalises to the same luminance, so the ambient response is
 * linear too and the number can be solved for rather than hunted. At 0.070 the
 * moon contributed 0.792x the airglow floor; an order of magnitude on the total
 * therefore needs 0.796, and 1.0 is that rounded up to a number worth writing
 * down. It measures 12.3x, which leaves the acceptance gate at 10x a margin
 * rather than a coincidence.
 *
 * WHAT IT IS NOT. It is not a physical ratio to `SUN_SKY_POWER` — 1:21 against
 * reality's 1:450 000 — and no attempt is made to pretend otherwise. This scene
 * spans about 8.5 stops from noon to midnight where the world spans eighteen,
 * so every night value in it is a compressed one. What Part B fixes is the
 * moon's relation to the AIRGLOW, which is a ratio the compression should have
 * preserved and did not.
 */
export const MOON_SKY_POWER = 1.0;

/**
 * The moon's direct irradiance scale, DERIVED from the sun's.
 *
 * One moon, two renderers, one number — the same rule that makes the lamp's
 * gain on the water `FLAME_INTENSITY x OCEAN_PER_DECK_IRRADIANCE`. Before this,
 * the moon had a sky power of 0.070 and a hand-set directional intensity of
 * 0.34, two independent dials for one body, and they disagreed: the ratio of
 * direct light to sky power was 4.86 for the moon against 0.37 for the sun,
 * thirteen times out. The moon's lamp was doing work its sky should have done.
 *
 * The atmosphere and the geometry are the same for both bodies, so the
 * conversion from "power the dome scatters" to "irradiance the light throws" is
 * the same conversion, scaled by how much less power the moon has.
 *
 * The number this produces at full moon is 0.36 against the old hand-set 0.34 —
 * within 6%. The direct moonlight was always about right; it was the sky that
 * was eleven times too dim, which is exactly why moonlit nights looked wrong
 * while moonlit SURFACES did not.
 */
export const MOON_IRRADIANCE_SCALE =
  (SUN_IRRADIANCE_SCALE * MOON_SKY_POWER) / SUN_SKY_POWER;

/**
 * The moon's marginal contribution to `ambientRadiance` at `MOON_SKY_POWER`,
 * full phase and high elevation, as a multiple of the moonless airglow floor.
 *
 * MEASURED, and used only to derive the moon's penalty on star visibility below
 * — a sky brightened by this much costs 2.5*log10 of it in limiting magnitude,
 * which is the standard relation and not a fit. Kept as a constant rather than
 * recomputed per frame because the honest live version needs a second ambient
 * pass over 24 sky samples, and this round is not permitted to measure what
 * that would cost.
 */
export const MOON_AMBIENT_RATIO_PEAK = 11.3;

/**
 * The sky power the moon had before Part B — the A/B's other arm.
 *
 * REVIEW_QUEUE 3.2 asks whether the moon is now too strong, and until this
 * existed the question had no second arm to photograph: `MOON_SKY_POWER` is one
 * authored constant, and a queue line whose only evidence is "it used to be
 * 0.070" is a line nobody can answer by looking. The switch moves the SKY power
 * alone and leaves `MOON_IRRADIANCE_SCALE` where it ships, which is exactly the
 * change Part B made — the direct moonlight went from a hand-set 0.34 to a
 * derived 0.36 and was never the fault. So the two arms differ by the measured
 * 1.79x against 12.14x on `ambientRadiance`, and by nothing else.
 *
 * Default is the shipping arm, and the OFF path is the same multiplication by
 * the same constant, so nothing moves until somebody asks it to.
 */
export const LEGACY_MOON_SKY_POWER = 0.07;

let legacyMoonlightEnabled = false;

/** REVIEW_QUEUE 3.2's A/B: true restores the pre-Part-B moon sky power. */
export function setLegacyMoonlight(enabled: boolean): void {
  legacyMoonlightEnabled = enabled;
}

export function isLegacyMoonlight(): boolean {
  return legacyMoonlightEnabled;
}

/** The moon's sky power on the arm that is currently selected. */
export function moonSkyPower(): number {
  return legacyMoonlightEnabled ? LEGACY_MOON_SKY_POWER : MOON_SKY_POWER;
}

/** Mean apparent angular radius of the Sun, radians (about 0.266 degrees). */
const SUN_ANGULAR_RADIUS = 0.00465;
/** Disc quadrature points, and the number refreshed on an ordinary frame. */
const SUN_DISC_SAMPLE_COUNT = 16;
const SUN_DISC_SLICE = 4;
/** A discontinuous presentation jump rebuilds the whole disc immediately. */
const SUN_DISC_SNAP_SECONDS = 1.0;

/**
 * Equal-weight, centrally symmetric points over the apparent solar disc.
 *
 * Eight golden-angle points and their antipodes make a straight cloud edge
 * through the disc integrate to exactly one half, independent of its angle.
 * The pair order interleaves inner and outer radii so each four-point refresh
 * covers two complete, widely separated pairs instead of one local clump.
 */
const SUN_DISC_SAMPLES: ReadonlyArray<readonly [number, number]> = (() => {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const pairOrder = [0, 4, 1, 5, 2, 6, 3, 7] as const;
  const samples: Array<readonly [number, number]> = [];
  for (const pair of pairOrder) {
    const radius = Math.sqrt((pair + 0.5) / (SUN_DISC_SAMPLE_COUNT / 2));
    const angle = pair * goldenAngle;
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    samples.push([x, y], [-x, -y]);
  }
  return samples;
})();

/** Earth radius, metres. Must match EARTH_R in GLSL_SKY. */
const EARTH_R = 6371000;
/**
 * Soft ceiling on the reach of the multi-scatter source region, metres. Must
 * match MULTI_REACH_MAX in GLSL_SKY. The single-scatter path scale must not be
 * used here: it blows up hyperbolically as the view ray flattens, which laid a
 * hard bright strip along the horizon on the sunset side and a dark one
 * opposite. The multiply-scattered field is a broad diffuse volume, so its
 * azimuthal memory saturates.
 */
const MULTI_REACH_MAX = 240000;
/** Soft ceiling on single-scatter sample placement, metres. Must match GLSL_SKY. */
const SAMPLE_REACH_MAX = 400000;

function multiReach(dirY: number): number {
  const s = scatterPathScale(dirY);
  return (MULTI_REACH_MAX * s) / (s + MULTI_REACH_MAX);
}

/**
 * Disc-integrated lunar brightness relative to full moon.
 *
 * Illuminated area alone overstates a partial moon: the lunar opposition
 * effect makes a half-lit disc much less than half as bright as a full one.
 * The cubic approximation preserves that perceptual ordering while reaching
 * an exact zero at new moon, so no halo or glitter survives without a source.
 */
export function moonPhaseBrightness(illuminatedFraction: number): number {
  const f = Math.min(Math.max(illuminatedFraction, 0), 1);
  return f * f * f;
}

/** Kasten-Young-like relative air mass: 1.0 at the zenith, ~40 at the horizon. */
function airMass(cosZenith: number): number {
  const c = Math.max(cosZenith, 0);
  return 1 / (c + 0.025 * Math.exp(-11 * c));
}

/**
 * Distance along a view ray at which it reaches one scale height, with the
 * Earth falling away beneath it. Must match scatterPathScale in GLSL_SKY.
 */
function scatterPathScale(dirY: number): number {
  const s = Math.max(dirY, 0);
  return EARTH_R * (Math.sqrt(s * s + (2 * ATMO_H) / EARTH_R) - s);
}

/**
 * Air mass along a sun ray leaving altitude `z` with the sun at
 * sin(elevation) = `eps` relative to that point's own local horizontal.
 * Must match sunAirMassAt in GLSL_SKY; reduces to the sea-level formula at
 * z = 0.
 */
function sunAirMassAt(z: number, eps: number): number {
  const dip = Math.sqrt((2 * Math.max(z, 0)) / EARTH_R);
  const down = Math.min(eps, 0);
  const zTan = Math.max(z - 0.5 * EARTH_R * down * down, 0);
  return (
    airMass(Math.max(eps, 0)) * Math.exp(-zTan / ATMO_H) +
    Math.max(-(eps + dip), 0) * SUN_BELOW
  );
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// --- cloud layer -------------------------------------------------------------
// CPU mirror of the cloud block in GLSL_SKY, so the ambient fill, the
// hemispheric reflection mean and the exposure meter respond to the same
// clouds the dome draws. Every constant must match GLSL_SKY.

/** Cloud slab base altitude, metres. Must match CLOUD_BASE in GLSL_SKY. */
const CLOUD_BASE = 1100;
/** Cloud slab midline altitude, metres. Must match CLOUD_MID in GLSL_SKY. */
const CLOUD_MID = 0.5 * (1100 + 3300);
/** Cloud slab thickness, metres. Must match CLOUD_THICK in GLSL_SKY. */
const CLOUD_THICK = 3300 - 1100;
/** Volume extinction per metre. Must match CLOUD_EXTINCT in GLSL_SKY. */
const CLOUD_EXTINCT = 0.0062;
/** In-scatter gain on sunlight. Must match CLOUD_SUN_GAIN in GLSL_SKY. */
const CLOUD_SUN_GAIN = 1.95;
/** Noise-domain scale of the 2D organisation field. Must match GLSL_SKY. */
const CLOUD_SCALE_X = 0.00077;
const CLOUD_SCALE_Y = 0.00099;
/** Must match CLOUD_CELL_M / CLOUD_SHADOW_RISE in GLSL_SKY. */
const CLOUD_CELL_M = 0.5 * (1 / 0.00077 + 1 / 0.00099);
/** Evolution-axis noise units per metre. Must match CLOUD_EVO_SCALE in GLSL_SKY. */
const CLOUD_EVO_SCALE = 1 / CLOUD_CELL_M;
/** Convective boil of the lump field. Must match CLOUD_BOIL in GLSL_SKY. */
const CLOUD_BOIL_X = 0.35;
const CLOUD_BOIL_Y = 1.9;
const CLOUD_BOIL_Z = -0.55;
/**
 * Mean and deviation gain of the weather-map fbm. Must match GLSL_SKY.
 *
 * The 3D basis that makes the field evolve carries 14 % less spread than the
 * 2D one it replaces, at the same mean; this restores it, so the coverage and
 * region constants stay at the values they were tuned to.
 */
const CLOUD_FBM_MEAN = 0.469;
const CLOUD_FBM_GAIN = 1.158;
/** Wind shear across the slab, metres. Must match CLOUD_SHEAR in GLSL_SKY. */
const CLOUD_SHEAR_X = 700;
const CLOUD_SHEAR_Y = 420;
/** Must match CLOUD_REGION_SCALE / CLOUD_REGION_SWING in GLSL_SKY. */
const CLOUD_REGION_SCALE = 0.2;
const CLOUD_REGION_SWING = 0.5;
/**
 * The 3D shape field and its height gradient — the silhouette authority.
 * Must match CLOUD_SHAPE_FREQ / CLOUD_GRAD_* / CLOUD_EDGE / CLOUD_DENSITY in
 * GLSL_SKY. See the long note there for why the threshold is applied to a 3D
 * field rather than to a 2D one times a height profile.
 */
const CLOUD_SHAPE_FREQ_X = 0.00095;
const CLOUD_SHAPE_FREQ_Y = 0.00161;
const CLOUD_SHAPE_FREQ_Z = 0.00095;
const CLOUD_GRAD_BASE = 0.06;
const CLOUD_GRAD_KNEE = 0.18;
const CLOUD_GRAD_END = 1.6;
const CLOUD_EDGE = 0.075;
const CLOUD_DENSITY = 1.35;
/** Traverse reach and sun-march geometry. Must match GLSL_SKY. */
const CLOUD_REACH = 17000;
const CLOUD_SUN_STEP = 105;
const CLOUD_SUN_GROWTH = 1.72;
/** Must match CLOUD_LUMP_FREQ / CLOUD_ERODE_* in GLSL_SKY. */
const CLOUD_LUMP_FREQ = 0.00222;
/** Must match CLOUD_WARP in GLSL_SKY. */
const CLOUD_WARP = 0.85;
const CLOUD_ERODE_BASE = 0.45;
const CLOUD_ERODE_TOP = 1.70;
/**
 * Steps of the CPU traverse, and samples up its sun ray.
 *
 * DELIBERATELY FEWER than the dome compiles with, which is a change from the
 * mirror's old rule, and it is legitimate now for a reason worth writing down.
 * Under the old march, optical depth was normalised by the step COUNT — the
 * column was walked at a fixed distance and its geometric length was a fiction
 * — so the number of samples was part of the layer's OPACITY and a mirror that
 * marched differently was lit by a different sky. The traverse integrates
 * honestly: tau is density times extinction times the metres actually crossed,
 * so halving the step count changes how finely the integral is resolved and
 * not what it converges to.
 *
 * This consumer is a hemisphere MEAN over fixed sample sets, evaluated on the
 * CPU every frame. It wants the same field, not the same resolution of it, and
 * 48 steps times a sun march times sixty directions is several milliseconds of
 * JavaScript per frame for a number that feeds an ambient fill.
 *
 * The shared FIELD constants above are still enforced by
 * tests/shader-source.test.ts, which is where the real desync risk lives.
 */
const CLOUD_MARCH_CPU = 14;
const CLOUD_SUN_STEPS_CPU = 4;
/** Transmission below this is visually and numerically opaque. */
const CLOUD_TRANSMISSION_FLOOR = 1e-3;
const CLOUD_OPAQUE_TAU = -Math.log(CLOUD_TRANSMISSION_FLOOR);
/** Octaves of the 3D shape field on the CPU. Must match CLOUD_SHAPE_OCTAVES. */
const CLOUD_SHAPE_OCTAVES_CPU = 5;
const CLOUD_OCTAVES_CPU = 4;

function fractf(x: number): number {
  return x - Math.floor(x);
}

/**
 * CPU mirror of cloudFbm in GLSL_SKY (m = mat2(1.62, 1.18, -1.18, 1.62)).
 *
 * `w` is the evolution axis — a third noise coordinate, not a phase — and it
 * doubles with the domain so that fine structure turns over faster than coarse
 * structure. See the GLSL for the argument; the deviation gain restores the
 * distribution the 2D basis had, which every constant downstream was tuned
 * against.
 */
function cloudFbm(px: number, py: number, w: number): number {
  let v = 0;
  let a = 0.5;
  let x = px;
  let y = py;
  let z = w;
  for (let i = 0; i < CLOUD_OCTAVES_CPU; i++) {
    v += a * vnoise3(x, y, z);
    const nx = 1.62 * x - 1.18 * y;
    const ny = 1.18 * x + 1.62 * y;
    x = nx;
    y = ny;
    z *= 2;
    a *= 0.5;
  }
  return CLOUD_FBM_MEAN + (v - CLOUD_FBM_MEAN) * CLOUD_FBM_GAIN;
}

/** Henyey-Greenstein phase function. Must match hg in GLSL_SKY. */
function hg(mu: number, g: number): number {
  const g2 = g * g;
  return (
    (1 - g2) /
    (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5))
  );
}

/** CPU mirror of hash31 in GLSL_COMMON. */
function hash31(px: number, py: number, pz: number): number {
  let x = fractf(px * 0.1031);
  let y = fractf(py * 0.1031);
  let z = fractf(pz * 0.1031);
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d;
  y += d;
  z += d;
  return fractf((x + y) * z);
}

/** CPU mirror of vnoise3 in GLSL_COMMON. */
function vnoise3(px: number, py: number, pz: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash31(ix, iy, iz);
  const b = hash31(ix + 1, iy, iz);
  const c = hash31(ix, iy + 1, iz);
  const d = hash31(ix + 1, iy + 1, iz);
  const e = hash31(ix, iy, iz + 1);
  const g = hash31(ix + 1, iy, iz + 1);
  const h = hash31(ix, iy + 1, iz + 1);
  const k = hash31(ix + 1, iy + 1, iz + 1);
  const lo = (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
  const hi = (e + (g - e) * ux) + ((h + (k - h) * ux) - (e + (g - e) * ux)) * uy;
  return lo + (hi - lo) * uz;
}

/**
 * CPU mirror of cloudLumps in GLSL_SKY — a warped fbm, deliberately NOT a
 * billow (abs) basis; see the GLSL for why the fold had to go.
 */
function cloudLumps(px: number, py: number, pz: number, oct2: number): number {
  const w = vnoise3(px * 0.53 + 4.7, py * 0.53 + 9.1, pz * 0.53 + 2.3) - 0.5;
  px += w * CLOUD_WARP;
  py += w * -0.72 * CLOUD_WARP;
  pz += w * 0.41 * CLOUD_WARP;
  let v = vnoise3(px, py, pz);
  if (oct2 > 0.01) {
    v += oct2 * 0.5 * vnoise3(px * 2.03 + 17.3, py * 2.03 + 5.1, pz * 2.03 + 11.7);
  }
  v /= 1 + 0.5 * oct2;
  // Normalised against the measured spread — must match GLSL_SKY.
  return Math.min(Math.max((v - 0.23) * 1.85, 0), 1);
}

/**
 * The coverage threshold at a point, including the regional modulation that
 * gives the sky clumps and lanes instead of one uniform cloud size. Must match
 * cloudCoverAt in GLSL_SKY.
 */
function cloudCoverAt(
  cover: number,
  q0x: number,
  q0y: number,
  evo: number,
): number {
  return (
    cover +
    (cloudFbm(
      q0x * CLOUD_REGION_SCALE + 53.1,
      q0y * CLOUD_REGION_SCALE + 17.9,
      evo * CLOUD_REGION_SCALE,
    ) -
      0.47) *
      CLOUD_REGION_SWING
  );
}

/**
 * CPU mirror of cloudShape in GLSL_SKY: the 3D field the coverage threshold is
 * applied to, and therefore the thing that gives a cloud a top.
 */
function cloudShape(
  px: number,
  py: number,
  pz: number,
  evo: number,
  minimumShape: number,
): number {
  let x = px;
  let y = py + evo;
  let z = pz;
  let v = 0;
  let a = 0.5;
  let accumulatedWeight = 0;
  const totalWeight = 1 - Math.pow(0.5, CLOUD_SHAPE_OCTAVES_CPU);
  // Column-major mat3(0, 1.6, 1.2, -1.6, 0.72, -0.96, -1.2, -0.96, 1.28):
  // two times a rotation, so the octaves neither grid up nor drift in scale.
  for (let i = 0; i < CLOUD_SHAPE_OCTAVES_CPU; i++) {
    v += a * vnoise3(x, y, z);
    accumulatedWeight += a;
    // Noise is in [0, 1]. If even every remaining octave returning one cannot
    // reach the density threshold, this point is provably empty. This is an
    // exact bound, not a lower-octave approximation, and makes clear-sky rays
    // cheap enough for finite-disc integration.
    const maximum =
      (v + totalWeight - accumulatedWeight) / totalWeight;
    if (maximum <= minimumShape) return 0;
    const nx = -1.6 * y - 1.2 * z;
    const ny = 1.6 * x + 0.72 * y - 0.96 * z;
    const nz = 1.2 * x - 0.96 * y + 1.28 * z;
    x = nx;
    y = ny;
    z = nz;
    a *= 0.5;
  }
  return v / totalWeight;
}

/** Must match cloudGradient in GLSL_SKY. */
function cloudGradient(h: number): number {
  return (
    smoothstep(0, CLOUD_GRAD_BASE, h) *
    (1 - smoothstep(CLOUD_GRAD_KNEE, CLOUD_GRAD_END, h))
  );
}

/**
 * Density at one point in the slab. Must match cloudDensity in GLSL_SKY: the
 * threshold is applied to a genuinely 3D field times a height gradient, which
 * is what makes the isosurface a surface in space rather than a contour on a
 * map extruded upward.
 */
function cloudDensity(
  wpx: number,
  wpy: number,
  wpz: number,
  h: number,
  threshold: number,
  detail: number,
  evolve: number,
): number {
  const grad = cloudGradient(h);
  if (grad <= 0) return 0;
  const lean = h - 0.5;
  const sx = (wpx + CLOUD_SHEAR_X * lean) * CLOUD_SHAPE_FREQ_X;
  const sy = wpy * CLOUD_SHAPE_FREQ_Y;
  const sz = (wpz + CLOUD_SHEAR_Y * lean) * CLOUD_SHAPE_FREQ_Z;
  const minimumShape = threshold / grad;
  if (minimumShape >= 1) return 0;
  let d =
    cloudShape(
      sx,
      sy,
      sz,
      evolve * CLOUD_SHAPE_FREQ_Y,
      Math.max(minimumShape, 0),
    ) *
      grad -
    threshold;
  if (d <= 0) return 0;
  d = Math.min(d / CLOUD_EDGE, 1);
  if (detail > 0.01) {
    const boil = evolve * CLOUD_LUMP_FREQ;
    const qx = (wpx + CLOUD_SHEAR_X * lean) * CLOUD_LUMP_FREQ + CLOUD_BOIL_X * boil;
    const qy = wpy * CLOUD_LUMP_FREQ + CLOUD_BOIL_Y * boil;
    const qz = (wpz + CLOUD_SHEAR_Y * lean) * CLOUD_LUMP_FREQ + CLOUD_BOIL_Z * boil;
    const bite = (1 - cloudLumps(qx, qy, qz, detail)) * detail;
    d = Math.max(
      d - bite * (CLOUD_ERODE_BASE + (CLOUD_ERODE_TOP - CLOUD_ERODE_BASE) * h) * (1 - d),
      0,
    );
  }
  return d * CLOUD_DENSITY;
}

/**
 * Control points of the twilight limiting-magnitude curve: sun elevation in
 * degrees against the faintest visible magnitude. Values follow the shape of
 * Crumey's twilight fits — bright stars shortly after sunset, the full dark
 * limit only past astronomical twilight. Piecewise-linear and monotone.
 */
const LIMIT_POINTS: ReadonlyArray<readonly [number, number]> = [
  [2, -6],
  [0, -1],
  [-2, 0.6],
  [-4, 1.6],
  [-6, 2.3],
  [-9, 3.3],
  [-12, 4.5],
  [-15, 5.4],
  [-18, 6.2],
];

export function limitingMagnitudeFromSunElevation(
  sunElevationDeg: number,
): number {
  const points = LIMIT_POINTS;
  if (sunElevationDeg >= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (sunElevationDeg <= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [e1, m1] = points[i];
    if (sunElevationDeg >= e1) {
      const [e0, m0] = points[i - 1];
      const t = (sunElevationDeg - e0) / (e1 - e0);
      return m0 + (m1 - m0) * t;
    }
  }
  return last[1];
}

export class TimeOfDay {
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  readonly moonDirection = new THREE.Vector3(0, -1, 0);

  /** Derived conventional horizon coordinates, for diagnostics only. */
  solarAzimuthRad: number | null = null;
  solarElevationRad = Math.PI / 2;
  lunarAzimuthRad: number | null = null;
  lunarElevationRad = -Math.PI / 2;

  /** Colour of direct sunlight after atmospheric extinction (linear). */
  readonly sunLightColor = new THREE.Color();
  sunLightIntensity = 0;

  readonly moonLightColor = new THREE.Color();
  moonLightIntensity = 0;

  /** Hemisphere fill, sampled from the sky model (linear). */
  readonly ambientSkyColor = new THREE.Color();
  readonly ambientGroundColor = new THREE.Color();
  ambientIntensity = 0;
  /**
   * Unnormalised averaged sky radiance. Surfaces that must actually go dark
   * after sunset use this rather than the normalised colour, which keeps its
   * full chroma however little light is left.
   */
  readonly ambientRadiance = new THREE.Vector3();
  /**
   * Display-stage exposure multiplier for daylight, 1 at and below the
   * horizon. See where it is computed, and its consumer in main.
   */
  daylightLift = 1;

  /**
   * Cosine-weighted upper-hemisphere sky radiance, in raw sky units.
   *
   * This is what a wide specular lobe integrates towards, and it is the
   * ocean's substitute for "sample the sky in the mirror direction" once
   * roughness has made that direction statistical. Distinct from
   * `ambientRadiance`, whose flat average over-weights the bright horizon
   * band — the cosine weight is exactly what makes the mean *blue*.
   */
  readonly hemisphericRadiance = new THREE.Vector3();
  /**
   * The sky's order-2 harmonic projection, RGB interleaved per coefficient.
   * The sea's rough reflection converges to this rather than to a single
   * whole-dome average; see scene/skyHarmonics.ts.
   */
  readonly skySh = new Float32Array(SH_COEFFICIENTS * 3);
  private readonly shScratch: number[] = new Array(SH_COEFFICIENTS).fill(0);
  /** Cached sky radiance per probe direction; a slice is refreshed per frame. */
  private readonly probeCache = new Float32Array(PROBE_SAMPLES.length * 3);
  private probeCursor = 0;
  private probeInitialised = false;

  /**
   * Direct-sun cloud transmission at fixed points over the finite solar disc.
   * Four interleaved points are refreshed per ordinary frame; the whole cache
   * is rebuilt on first use and after presentation jumps.
   */
  private readonly sunDiscCache = new Float32Array(SUN_DISC_SAMPLE_COUNT);
  private sunDiscSlice = 0;
  private sunDiscInitialised = false;
  private readonly sunDiscTangent = new THREE.Vector3();
  private readonly sunDiscBitangent = new THREE.Vector3();
  private readonly sunDiscDirection = new THREE.Vector3();

  /** 0 during the day, 1 once the sun is well down. Drives stars and airglow. */
  nightFactor = 0;
  /** Auto-exposure, low-passed so it never steps. */
  exposure = 1;
  /**
   * The field luminance the exposure meter actually metered this frame, in raw
   * sky radiance units — the brighter of the diffuse fill and the softened
   * horizon ring, before any clamp, lift or low-pass.
   *
   * Published rather than left local so the graphics diagnostics can report
   * what closed the camera exposure. It changes no radiance and no exposure;
   * it is the same number the meter already used. The optional observer does
   * NOT consume this compressed value; `retinalLuminance` below exists because
   * Part B proved that would order moonlight incorrectly.
   */
  adaptationLuminance = 0;
  /**
   * What the observer's eye is adapted to, in real cd/m2 — the modelled world,
   * not the rendered one. Drives the opt-in scotopic operator and its
   * diagnostics; see scene/scotopic.ts.
   *
   * Distinct from `adaptationLuminance` on purpose. That is the exposure
   * meter's input and it reads the sky this renderer actually drew, in this
   * renderer's compressed units. This is what a person standing on the deck
   * would be adapted to. They were the same quantity until Part B raised the
   * moon and the compression pulled them apart.
   */
  retinalLuminance = twilightLuminanceCd(90);

  /** Sunlit fraction of the lunar disc, 0..1, supplied by astronomy. */
  moonIlluminatedFraction = 0.5;
  /**
   * Disc-integrated lunar brightness relative to full moon. Steeply
   * non-linear in phase (opposition surge): a quarter moon is roughly a
   * tenth of a full one, not half.
   */
  moonPhaseBright = 1;

  /**
   * Naked-eye limiting magnitude for the current sky: continuous in sun
   * elevation (Crumey-style twilight fits) less a bright-moon penalty.
   * Daylight parks it at -6 — no catalogue star qualifies.
   */
  limitingMagnitude = -6;

  /**
   * Extra sky-glow, in magnitudes, over the twilight arch's centre. Stars
   * near the sunset point need the sky this much darker before they show;
   * zero once true night makes the dome uniform.
   */
  twilightArchPenaltyMag = 0;
  /** Unit vector toward the sunset point on the horizon (render space). */
  readonly twilightArchDirection = new THREE.Vector3(0, 0, 1);

  sunPower = SUN_SKY_POWER;
  moonPower = 0;

  /**
   * Fraction of direct sun / moon light the cloud layer passes. The sun is
   * integrated over its finite disc; the much dimmer moon keeps one point ray.
   * Gates the glitter, the water's direct-sun terms and the directional lights,
   * so an overcast sky cannot leave a bright sun lane on the sea. 1 with clouds
   * off; breathes as gaps and tufts drift across the luminary.
   */
  sunCloudTransmittance = 1;
  moonCloudTransmittance = 1;

  readonly sunTint = new THREE.Color(1.0, 0.985, 0.955);
  readonly moonTint = new THREE.Color(0.72, 0.80, 1.0);

  private exposureInitialised = false;
  private readonly scratch = new THREE.Vector3();
  private readonly transmittance: [number, number, number] = [0, 0, 0];
  private readonly cloudCol: [number, number, number] = [0, 0, 0];
  /** Separate from `cloudCol` so `cloudLayer` cannot alias `skyWithClouds`. */
  private readonly cloudLayerSky: [number, number, number] = [0, 0, 0];
  /** Scratch for the cloud march: nothing on this path may allocate. */
  private readonly cloudAmbient: [number, number, number] = [0, 0, 0];

  /**
   * Cloud-layer state, shared with SkySystem each frame. Opacity stays 0
   * until `setCloudState` is called, so a bare TimeOfDay is the clear-sky
   * model — which is also what keeps the diagnostic "Clouds" toggle honest:
   * zeroing the sky's opacity removes clouds from these means too.
   */
  private cloudCover = 0.5;
  private cloudOpacity = 0;
  private cloudOffsetX = 0;
  private cloudOffsetZ = 0;
  private cloudEvolve = 0;

  /**
   * Adopt the sky's current cloud state; called by the frame loop.
   *
   * `field` carries the whole cloud clock — both decks' drift and both decks'
   * evolution — because the mirror's entire purpose is to light the scene from
   * the clouds that are on screen, and a mirror that had the positions but not
   * the shapes would agree only at the instant the session started.
   */
  setCloudState(cover: number, opacity: number, field: CloudFieldState): void {
    this.cloudCover = cover;
    this.cloudOpacity = opacity;
    this.cloudOffsetX = field.offsetX;
    this.cloudOffsetZ = field.offsetZ;
    this.cloudEvolve = field.evolve;
  }

  /**
   * Forget everything this object has integrated or amortized.
   *
   * Three separate pieces of history live here, and none of them was reachable
   * from `resetSimulation`:
   *
   * - **The exposure low-pass.** `exposure` has a four-second time constant
   *   and a first-frame latch. It never returns to where it started, so a
   *   session's exposure climbs monotonically and a scene staged twice renders
   *   through two different exposures — measured at 1.244669 against 1.244759,
   *   a few parts in ten thousand, and cumulative.
   * - **The sky probe's round robin.** Only `PROBE_SLICE` of the 256 probe
   *   directions are re-marched per ordinary frame; `probeCursor` says which.
   *   Two stagings refresh different slices, so the ambient fill and the
   *   order-2 harmonics differ. Exactly the shape of the cloud tile
   *   scheduler's bug, in a second place.
   * - **The solar disc's round robin.** Same again, four of sixteen samples
   *   per frame, feeding `sunCloudTransmittance`.
   *
   * Clearing the two `Initialised` latches also rewinds both cursors, because
   * a full refresh always restarts them at zero. Nothing is recomputed here:
   * the next `refreshFromAstronomy` snaps all three to the instant it is given.
   */
  resetAdaptation(): void {
    this.exposureInitialised = false;
    this.probeInitialised = false;
    this.probeCursor = 0;
    this.sunDiscInitialised = false;
    this.sunDiscSlice = 0;
  }

  /**
   * Consume one already-transformed astronomical frame. `presentationDtSeconds`
   * affects only exposure adaptation; it cannot advance canonical astronomy.
   */
  refreshFromAstronomy(
    presentationDtSeconds: number,
    sunDirection: THREE.Vector3,
    solarAzimuthRad: number | null,
    solarElevationRad: number,
    moonDirection: THREE.Vector3,
    lunarAzimuthRad: number | null,
    lunarElevationRad: number,
    moonIlluminatedFraction = 0.5,
  ): void {
    this.sunDirection.copy(sunDirection).normalize();
    this.moonDirection.copy(moonDirection).normalize();
    this.solarAzimuthRad = solarAzimuthRad;
    this.solarElevationRad = solarElevationRad;
    this.lunarAzimuthRad = lunarAzimuthRad;
    this.lunarElevationRad = lunarElevationRad;

    const sunElevationDeg = solarElevationRad * (180 / Math.PI);
    const moonElevationDeg = lunarElevationRad * (180 / Math.PI);
    this.nightFactor = smoothstep(-1.0, -9.0, sunElevationDeg);

    this.moonIlluminatedFraction = Math.min(
      Math.max(moonIlluminatedFraction, 0),
      1,
    );
    const f = this.moonIlluminatedFraction;
    this.moonPhaseBright = moonPhaseBrightness(f);

    // Moonlight ramps in only once the sun stops washing it out, and scales
    // with the real phase: a crescent's night is nearly moonless.
    const moonVisible =
      smoothstep(-2.0, -10.0, sunElevationDeg) *
      smoothstep(-4, 3, moonElevationDeg);
    this.moonPower = moonSkyPower() * moonVisible * this.moonPhaseBright;

    // Limiting magnitude: piecewise-linear in sun elevation, continuous and
    // monotone as the sky darkens, minus a penalty when a bright moon is up.
    const base = limitingMagnitudeFromSunElevation(sunElevationDeg);
    // DERIVED, not tuned, and Part B now knows the input because the brightening
    // is the thing this round set.
    //
    // The exponent is 1.25, not 2.5, and the difference is the whole reason this
    // is a derivation rather than a fit. 2.5*log10(B) is how a SURFACE
    // brightness changes in magnitudes. Detecting a faint star against that
    // surface is background-limited, so the threshold flux goes as sqrt(B) and
    // the cost is 1.25*log10(B). Checked against the real sky: a full moon
    // brightens the zenith by about 23x, which at 1.25 gives 1.70 magnitudes and
    // takes a 6.2 sky to 4.5 — which is what a full moon actually does. At 2.5
    // it would give 3.4 magnitudes and 2.8, which is far too harsh.
    //
    // The old 1.2-magnitude penalty was a hand-set number standing in for a sky
    // brightening that was not happening: the moon moved the ambient by 1.79x,
    // worth 0.30 magnitudes, and was charged 1.2. It now moves it by 12.3x and
    // is charged 1.36.
    const moonPenalty =
      1.25 * Math.log10(1 + this.moonSkyBrightening(moonElevationDeg, moonVisible));
    this.limitingMagnitude = Math.max(base - moonPenalty, -6);

    // Twilight arch: the glow over the sunset point costs stars there ~3
    // magnitudes at civil dusk, fading out by true night. Direction is the
    // sun's azimuth pinned to the horizon.
    this.twilightArchPenaltyMag =
      3.0 *
      smoothstep(0.5, -2.5, sunElevationDeg) *
      smoothstep(-15, -7, sunElevationDeg);
    const horiz = Math.hypot(this.sunDirection.x, this.sunDirection.z);
    if (horiz > 1e-6) {
      this.twilightArchDirection.set(
        this.sunDirection.x / horiz,
        0,
        this.sunDirection.z / horiz,
      );
    }

    // What the OBSERVER is adapted to, in real cd/m2, modelled from the sun's
    // elevation and the moon rather than read off the rendered sky. See the
    // block comment in scene/scotopic.ts for why this is not the exposure
    // meter's input: a camera meters what is in front of it, an eye adapts to
    // where it is standing, and this pipeline compresses the two light sources
    // by different factors so one compressed scalar cannot order both.
    this.retinalLuminance = retinalLuminanceCd({
      sunElevationDeg,
      moonElevationDeg,
      moonPhaseBrightness: this.moonPhaseBright,
      moonVisibility: moonVisible,
    });

    this.sunCloudTransmittance = this.sunDiscCloudTransmittance(
      presentationDtSeconds,
    );
    this.moonCloudTransmittance = this.cloudTransmittance(this.moonDirection);

    this.lightTransmittance(this.sunDirection, this.transmittance);
    const t = this.transmittance;

    // Direct sun: colour is the transmitted spectrum, intensity its magnitude.
    let r = t[0] * this.sunTint.r;
    let g = t[1] * this.sunTint.g;
    let b = t[2] * this.sunTint.b;
    const sunMag = Math.max(r, g, b);
    if (sunMag > 1e-6) {
      this.sunLightColor.setRGB(r / sunMag, g / sunMag, b / sunMag, THREE.LinearSRGBColorSpace);
    }
    // Fade the disc out as it drops below the sea, matching the sky model.
    const belowFade = smoothstep(-4.0, 0.4, sunElevationDeg);
    // LINEAR in the transmitted magnitude. See SUN_IRRADIANCE_SCALE.
    this.sunLightIntensity =
      sunMag * SUN_IRRADIANCE_SCALE * belowFade * this.sunCloudTransmittance;

    this.lightTransmittance(this.moonDirection, this.transmittance);
    const m = this.transmittance;
    const moonMag = Math.max(m[0] * 0.72, m[1] * 0.8, m[2]) || 1;
    this.moonLightColor.setRGB(
      (m[0] * this.moonTint.r) / moonMag,
      (m[1] * this.moonTint.g) / moonMag,
      (m[2] * this.moonTint.b) / moonMag,
      THREE.LinearSRGBColorSpace,
    );
    // Same shape as the sun's two lines above, and deliberately so: the
    // transmitted magnitude times an irradiance scale. The scale is the sun's,
    // reduced by the moon's share of sky power, so the two bodies cannot drift
    // apart. See MOON_IRRADIANCE_SCALE.
    this.moonLightIntensity =
      moonMag *
      MOON_IRRADIANCE_SCALE *
      moonVisible *
      this.moonPhaseBright *
      this.moonCloudTransmittance;

    // Cosine-weighted hemisphere mean for the ocean's rough reflection lobe.
    //
    // ORDERED BEFORE THE AMBIENT FILL, which it did not use to be, because
    // under `?fibonacciAmbient=1` the fill IS this reduction. The move is
    // numerically inert with the switch off: the two blocks share only
    // `this.scratch` and `this.transmittance`, both pure scratch, and neither
    // reads the other's accumulators. The byte-identity test is what holds that
    // claim rather than this comment.
    let hr = 0;
    let hg = 0;
    let hb = 0;
    let hw = 0;
    // Refresh part of the cached sky, then reduce the WHOLE cache. Only the
    // first half touches the atmosphere; the second is 256 dot products and is
    // not worth amortising.
    const full =
      !this.probeInitialised || presentationDtSeconds >= PROBE_SNAP_SECONDS;
    const refreshCount = full ? PROBE_SAMPLES.length : PROBE_SLICE;
    for (let k = 0; k < refreshCount; k++) {
      const i = full
        ? k
        : (this.probeCursor + k) % PROBE_SAMPLES.length;
      const s = PROBE_SAMPLES[i];
      this.scratch.set(s[0], s[1], s[2]);
      // Also a mean, and an order-2 harmonic projection could not carry the
      // lobe even if it were sampled well enough to see it.
      this.skyWithClouds(this.scratch, this.transmittance, true);
      this.probeCache[i * 3] = this.transmittance[0];
      this.probeCache[i * 3 + 1] = this.transmittance[1];
      this.probeCache[i * 3 + 2] = this.transmittance[2];
    }
    this.probeCursor = full
      ? 0
      : (this.probeCursor + PROBE_SLICE) % PROBE_SAMPLES.length;
    this.probeInitialised = true;

    // One reduction serves two consumers: the cosine-weighted whole-dome mean,
    // and the order-2 harmonic projection that gives the sea a reflection which
    // varies with direction instead of one grey number everywhere.
    this.skySh.fill(0);
    const dOmega = (2 * Math.PI) / PROBE_SAMPLES.length;
    for (let i = 0; i < PROBE_SAMPLES.length; i++) {
      const s = PROBE_SAMPLES[i];
      const r = this.probeCache[i * 3];
      const g = this.probeCache[i * 3 + 1];
      const b = this.probeCache[i * 3 + 2];
      const w = s[1]; // cos(zenith angle) — the sample's y component
      hr += r * w;
      hg += g * w;
      hb += b * w;
      hw += w;
      shBasis(s[0], s[1], s[2], this.shScratch);
      for (let c = 0; c < SH_COEFFICIENTS; c++) {
        const basis = this.shScratch[c] * dOmega;
        this.skySh[c * 3] += r * basis;
        this.skySh[c * 3 + 1] += g * basis;
        this.skySh[c * 3 + 2] += b * basis;
      }
    }
    this.hemisphericRadiance.set(hr / hw, hg / hw, hb / hw);
    // A/B: collapse the probe to its own l=0 term, which reconstructs the flat
    // whole-dome mean in every direction through the same shader code.
    if (isFlatSkyMean()) flatProbe(this.skySh, this.hemisphericRadiance);

    // Ambient fill: average the sky over some directions rather than guessing.
    // Clouds included — an overcast day's fill is grey because the sky's mean
    // is grey, and this is the mean.
    let ar = 0;
    let ag = 0;
    let ab = 0;
    if (isFibonacciAmbientEnabled()) {
      // THE FILL AS AN ACTUAL MEAN. Seven directions on three rings cannot
      // estimate the mean of a sky that contains a three-degree aureole; they
      // play a lottery whose prize is drawn as the sun crosses a ring. This
      // arm reads the cosine-weighted 256-direction Fibonacci mean that the
      // harmonic probe has been computing all along, one variable away, and
      // which is within 2 percent of a converged 8192-direction integral where
      // the seven-sample set is out by up to 4.65x.
      //
      // Note what is NOT here: no new sky evaluation. The seven the other arm
      // runs every frame stop, and nothing replaces them.
      ar = this.hemisphericRadiance.x;
      ag = this.hemisphericRadiance.y;
      ab = this.hemisphericRadiance.z;
    } else {
      const samples = AMBIENT_SAMPLES;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        this.scratch.set(s[0], s[1], s[2]);
        // domeMean: seven directions cannot point-sample a three-degree aerosol
        // lobe. See addInscatter.
        this.skyWithClouds(this.scratch, this.transmittance, true);
        ar += this.transmittance[0];
        ag += this.transmittance[1];
        ab += this.transmittance[2];
      }
      ar /= samples.length;
      ag /= samples.length;
      ab /= samples.length;
    }

    // The sky's DIFFUSE FILL, scaled by the key-to-fill control.
    //
    // Measured at a 72.9 degree sun before this existed: sky irradiance on a
    // horizontal surface (mean radiance x pi) was 4.08 against the sun's
    // 19.67, a key-to-fill ratio of 4.8:1. A real clear day runs 7-10:1 —
    // direct ~860 W/m^2 on horizontal at that elevation against ~100-150 of
    // diffuse sky. Ours had roughly twice the fill it should, which is
    // exactly the signature of an overcast render: shadows never deepen,
    // nothing reads as struck by sunlight, and a cloudless noon still feels
    // grey. Hence a scale, not a rewrite of the sky.
    //
    // Deliberately applied HERE and only to ambientRadiance, so every fill
    // consumer inherits it at once — water body, hull, deck, sails — while
    // hemisphericRadiance and the SH probe are left alone. Under
    // `?fibonacciAmbient=1` the two become one measurement of the sky and this
    // policy scale apart, which is the point rather than an accident: a fill
    // and a mirrored sky differ in what you DO with the mean, not in how you
    // estimate it. Dimming the reflection as well is what Ocean's
    // sky-reflection gain is for, and doing it here too would darken the same
    // photons twice.
    // `skyFillScale` is a clear-DAY key-to-fill policy, not a night-darkening
    // control. Let the existing astronomical night ramp retire it after the
    // Sun is below the horizon. At nightFactor=0 this is bit-for-bit the daylight
    // look Ash chose; at full night the pre-round fill is restored so the
    // world does not lose another 0.32 stop after the meter has already opened.
    const effectiveSkyFillScale =
      skyFillScale + (1 - skyFillScale) * this.nightFactor;
    this.ambientRadiance.set(
      ar * effectiveSkyFillScale,
      ag * effectiveSkyFillScale,
      ab * effectiveSkyFillScale,
    );

    const ambMag = Math.max(ar, ag, ab, 1e-5);
    this.ambientSkyColor.setRGB(ar / ambMag, ag / ambMag, ab / ambMag, THREE.LinearSRGBColorSpace);
    // Bounce off the water is dim, cool and desaturated.
    this.ambientGroundColor.setRGB(
      0.10 + 0.18 * (ar / ambMag),
      0.16 + 0.20 * (ag / ambMag),
      0.26 + 0.22 * (ab / ambMag),
      THREE.LinearSRGBColorSpace,
    );
    // A small floor only, so the raft keeps a readable silhouette at night;
    // everything else darkens honestly with `ambientRadiance`.
    this.ambientIntensity = Math.min(2.6, 0.035 + ambMag * 6.0);

    // Auto-exposure from the sky's own luminance. The scene physically loses
    // about 5.5 stops between sunset and early night. Fully compensating for
    // that — the naive `k / lum` — would hold the image at a constant
    // brightness and night would never arrive. Raising it to a fractional
    // power compensates only partially, so roughly 3.5 stops of the fall
    // survive into the picture.
    //
    // The fill average alone meters the DARK half of a sunset: its samples sit
    // at 26 deg elevation and above, where a post-sunset sky has already lost
    // several stops, while the band along the horizon is still the brightest
    // thing in frame. Metering only the dark part opens the exposure until the
    // band pins against display white, and ACES has no hue left to give up
    // there — the measured sunset horizon came out cream (238,217,183) with a
    // linear ratio that should have rendered orange. A horizon ring is where a
    // photographer meters a sunset and where the eye's adaptation actually
    // lands, so the meter takes the brighter of the two readings, softened.
    let hor = 0;
    for (let i = 0; i < HORIZON_SAMPLES.length; i++) {
      const s = HORIZON_SAMPLES[i];
      this.scratch.set(s[0], s[1], s[2]);
      // Eight samples on one ring: a moon setting through 4 degrees would
      // otherwise step the exposure meter as it crossed each of them.
      this.skyWithClouds(this.scratch, this.transmittance, true);
      hor +=
        0.2126 * this.transmittance[0] +
        0.7152 * this.transmittance[1] +
        0.0722 * this.transmittance[2];
    }
    hor /= HORIZON_SAMPLES.length;
    const fill = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    const lum = Math.max(fill, HORIZON_METER_WEIGHT * hor);
    this.adaptationLuminance = lum;
    // Ceiling raised 2.3 -> 3.0 with the airglow floor cut to a quarter. The
    // old ceiling was already within 1.16x of where a moonless night sat, so
    // any deepening below it stopped being met by the meter and simply drove
    // the picture dark — which is the wrong half of "the world got darker".
    // Dark adaptation is the real thing being modelled here, and an eye given
    // two more stops of night keeps adapting; the constant sources it is
    // adapting *to* — the lamp, the stars, the moon — rise in the picture as
    // it does, which is exactly the effect a lantern is supposed to have.
    // One adaptation curve, all day. There is no daylight plateau any more:
    // the plateau existed to hold the sky out of the ACES shoulder, and the
    // display transform no longer has a shoulder that costs colour, so the
    // meter is free to be a meter again.
    //
    // E = EXPOSURE_K / lum^EXPOSURE_ADAPT. A full compensation (exponent 1)
    // would hold the picture at constant brightness and night would never
    // arrive; a third of it lets roughly two-thirds of the real fall reach the
    // screen, which is about what dark adaptation does. Clamped at both ends:
    // the floor stops a brilliant sunset horizon from closing the world down,
    // the ceiling is where a moonless night stops opening up.
    let target: number;
    if (isLegacyExposure()) {
      // Pre-round meter: an adaptation curve below +5 deg sun, pinned to a
      // fixed 0.335 in established daylight to hold the sky out of the ACES
      // shoulder. Present only under ?legacyColour=1.
      const curve = Math.min(
        3.0,
        Math.max(0.3, 0.55 * Math.pow(0.29 / (lum + 0.0008), 0.34)),
      );
      target = curve + (0.335 - curve) * smoothstep(5, 15, sunElevationDeg);
    } else {
      target = Math.min(
        EXPOSURE_MAX,
        Math.max(
          EXPOSURE_MIN,
          EXPOSURE_K * Math.pow(1 / (lum + 0.0008), EXPOSURE_ADAPT),
        ),
      );
    }
    // DAYLIGHT LIFT, applied AFTER the clamp — and the order is the whole
    // trick, so it must not be "tidied" into the expression above.
    //
    // The meter cannot do what daylight needs, and the arithmetic is worth
    // recording because the obvious fix does not survive it. Measured at
    // midday the meter sits at 4.78; a moonless night DEMANDS about 22 and is
    // held at the 5.2 ceiling. So both ends of the day are already pinned near
    // the same number and the meter has quietly become a constant. Worse, no
    // re-tuning of K or the exponent can fix that: E = K·lum^-a is monotone
    // DECREASING in luminance, so the meter always hands the darker scene MORE
    // gain. Asking it for "brighter noon, unchanged midnight" asks it to
    // invert, and it cannot — raising the ceiling to free the day raises the
    // night through the same clamp.
    //
    // So the lift is not metering at all; it is a statement about what the
    // picture is FOR. A photograph of a brilliant day is not exposed to hold
    // the sky under white — it lets the sky go over-range and puts the subject
    // up where the eye reads sunlight. That is a look policy, it belongs
    // outside the meter, and being outside the clamp is what keeps it away
    // from the night: the ramp is zero below the horizon by construction, so
    // dusk, night and moonlight are bit-for-bit what they were.
    //
    // The default is Ash's own number, arrived at empirically with the manual
    // exposure bias before this existed: 2x in the afternoon read as day.
    // NOT folded into `target`. The meter's clamp range is a contract - its
    // MIN:MAX ratio is the total gain it may apply across a day, and a test
    // pins the day < sunset < night ordering that follows from it. This lift
    // deliberately inverts that ordering, which is exactly why it does not
    // belong inside the meter: it is a display policy, and it is applied
    // alongside the other exposure biases where `toneMappingExposure` is
    // assembled. Kept here only because this is where the sun's elevation is
    // already known.
    this.daylightLift =
      1 + (daylightExposureLift - 1) * smoothstep(0, 25, sunElevationDeg);

    if (!this.exposureInitialised) {
      this.exposure = target;
      this.exposureInitialised = true;
    } else {
      // ~4 s time constant, frame-rate independent: no visible stepping.
      this.exposure +=
        (1 - Math.exp(-presentationDtSeconds / 4.0)) *
        (target - this.exposure);
    }
  }

  /** Transmittance along a light ray reaching sea level from `dir`. */
  lightTransmittance(dir: THREE.Vector3, out: [number, number, number]): void {
    const am = airMass(dir.y) + Math.max(-dir.y, 0) * SUN_BELOW;
    out[0] = Math.exp(-BETA_E[0] * am);
    out[1] = Math.exp(-BETA_E[1] * am);
    out[2] = Math.exp(-BETA_E[2] * am);
  }

  /** CPU mirror of `skyRadiance()` in GLSL_SKY. */
  skyRadiance(
    dir: THREE.Vector3,
    out: [number, number, number],
    domeMean = false,
  ): void {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    this.addInscatter(
      dir,
      this.sunDirection,
      this.sunTint,
      this.sunPower,
      out,
      // The sun has the moon's aerosol-lobe sampling fault too, and it is NOT
      // fixed by default: this one moves daylight. See isSunDomeMeanEnabled.
      domeMean && isSunDomeMeanEnabled(),
    );
    this.addInscatter(
      dir,
      this.moonDirection,
      this.moonTint,
      this.moonPower,
      out,
      domeMean,
    );

    const h = Math.min(1, Math.max(0, dir.y));
    const f = Math.pow(h, 0.55);
    const n = this.nightFactor * NIGHT_BASE_GAIN;
    out[0] += (0.0102 + (0.0027 - 0.0102) * f) * n;
    out[1] += (0.0163 + (0.0046 - 0.0163) * f) * n;
    out[2] += (0.0318 + (0.0111 - 0.0318) * f) * n;

    // Overall dome gain: the day exposure plateau is fixed, so this is what
    // actually deepens the daytime sky on screen. Ambient fill and the water's
    // reflection read the same function, so the whole scene agrees.
    out[0] *= SKY_GAIN;
    out[1] *= SKY_GAIN;
    out[2] *= SKY_GAIN;

    const saturation = skySaturation();
    if (saturation === 1) return;
    // Legacy chroma stretch; present only under ?legacyColour=1. Must match
    // GLSL_SKY.
    const lum = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    const safeLum = Math.max(lum, 1e-6);
    let ratioLum = 0;
    for (let c = 0; c < 3; c++) {
      out[c] = Math.pow(Math.max(out[c] / safeLum, 1e-4), saturation);
      ratioLum += [0.2126, 0.7152, 0.0722][c] * out[c];
    }
    const renorm = lum / Math.max(ratioLum, 1e-6);
    for (let c = 0; c < 3; c++) out[c] *= renorm;
  }

  /** CPU mirror of `skyWithClouds()` in GLSL_SKY: base sky plus cloud layer. */
  skyWithClouds(
    dir: THREE.Vector3,
    out: [number, number, number],
    domeMean = false,
  ): void {
    this.skyRadiance(dir, out, domeMean);
    if (this.cloudOpacity <= 0.001) return;
    // Premultiplied, so this is an over rather than a mix.
    const a = this.cumulusDeck(dir, out, this.cloudCol);
    if (a <= 0) return;
    for (let c = 0; c < 3; c++) out[c] = out[c] * (1 - a) + this.cloudCol[c];
  }

  /**
   * The cloud layer toward `dir`: premultiplied radiance into `out`, opacity
   * returned.
   *
   * PUBLIC because the world radiance probe needs the cloud deck as a layer
   * rather than as a shadow. Gating the sky by transmittance alone models cloud
   * as a pure absorber, which gets overcast exactly backwards: a solid deck at
   * noon is one of the BRIGHTEST skies there is, and treating it as an absorber
   * renders it as night. The probe composites this the same way `skyWithClouds`
   * does — `sky * (1 - a) + col` — so the light on the hull and the sky over it
   * are the same cloud.
   *
   * `cloudTransmittance` remains the right function for the direct sun, which
   * genuinely is attenuated rather than scattered toward the viewer. Two
   * quantities, one cloud field, one march.
   */
  cloudLayer(dir: THREE.Vector3, out: [number, number, number]): number {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (this.cloudOpacity <= 0.001) return 0;
    this.skyRadiance(dir, this.cloudLayerSky);
    return this.cumulusDeck(dir, this.cloudLayerSky, out);
  }

  /**
   * CPU mirror of the LOW deck in GLSL_SKY, at mean fidelity. The one
   * deliberate difference: the derivative-based resolution fades (cloudRes,
   * puffAmp's and fineAmp's Nyquist terms) are 1 here — they exist to stop a
   * rasterised pixel point-sampling sub-pixel cloud cells, and this consumer
   * is a hemisphere mean whose sampling is governed by its fixed sample sets
   * instead. Everything else matches term for term, march included, so the
   * ambient fill, the rough reflection and the exposure meter respond to the
   * very clouds the dome draws — including their drift. Writes the layer's
   * PREMULTIPLIED radiance into `col` and returns its opacity.
   */
  private cumulusDeck(
    dir: THREE.Vector3,
    skyHere: [number, number, number],
    col: [number, number, number],
  ): number {
    col[0] = 0;
    col[1] = 0;
    col[2] = 0;
    if (this.cloudOpacity <= 0.001 || dir.y < 0.004) return 0;
    const horizonFade = smoothstep(0.006, 0.03, dir.y);
    if (horizonFade <= 0.001) return 0;

    const invY = 1 / Math.max(dir.y, 0.016);
    const t = CLOUD_MID * invY;
    const tEnter = CLOUD_BASE * invY;
    const seg = Math.min(CLOUD_THICK * invY, CLOUD_REACH);
    // NOT capped at CLOUD_STEP_MAX, unlike the shader. That cap is an
    // anti-grain device for a rasterised pixel, and combining it with this
    // consumer's much lower step count would cap the mirror's REACH as well as
    // its resolution — fourteen steps of 150 m covers 2.1 km of a 17 km grazing
    // ray, so the mirror would report thin cloud along the horizon while the
    // dome drew a solid deck. Same volume, own resolution.
    const dt = seg / CLOUD_MARCH_CPU;
    const evo = this.cloudEvolve * CLOUD_EVO_SCALE;

    // Organisation sampled at the segment's two ends and interpolated, matching
    // GLSL_SKY. The derivative-based detail fade is 1 here for the same reason
    // it always was: this consumer is a hemisphere mean, not a rasterised pixel.
    const coverAt = (tt: number): number =>
      cloudCoverAt(
        this.cloudCover,
        (dir.x * tt + this.cloudOffsetX) * CLOUD_SCALE_X,
        (dir.z * tt + this.cloudOffsetZ) * CLOUD_SCALE_Y,
        evo,
      );
    const coverNear = coverAt(tEnter);
    const coverFar = coverAt(tEnter + seg);

    // Per-cloud sun geometry — same sunAirMassAt the sky uses, at altitude.
    const sun = this.sunDirection;
    const azLen = Math.hypot(sun.x + 1e-6, sun.z);
    const sunAzX = (sun.x + 1e-6) / azLen;
    const sunAzZ = sun.z / azLen;
    const yLocal = sun.y + (dir.x * sunAzX + dir.z * sunAzZ) * (t / EARTH_R);
    const cloudDip = Math.sqrt((2 * CLOUD_MID) / EARTH_R);
    const amSun = sunAirMassAt(CLOUD_MID, yLocal);
    const sunT0 = Math.exp(-BETA_E[0] * amSun);
    const sunT1 = Math.exp(-BETA_E[1] * amSun);
    const sunT2 = Math.exp(-BETA_E[2] * amSun);
    const sunUp = smoothstep(-0.012, 0.004, yLocal + cloudDip);
    const mT = Math.max(sunT0, Math.max(sunT1, sunT2));
    const sunGain = (this.sunPower * Math.pow(mT, 0.42) * sunUp) / Math.max(mT, 1e-5);
    const sunLight = [
      this.sunTint.r * sunT0 * sunGain,
      this.sunTint.g * sunT1 * sunGain,
      this.sunTint.b * sunT2 * sunGain,
    ];
    const sunClimb = Math.min(Math.max(1 / Math.max(yLocal + cloudDip, 0.12), 1), 6);

    // Multiple-scattering octaves; constant along the ray, so hoisted.
    const mu = Math.min(1, Math.max(-1, dir.dot(sun)));
    const iso = 0.25 / Math.PI;
    const phase0 = iso + (hg(mu, 0.8) - iso) * 0.8;
    const phase1 = iso + (hg(mu, 0.42) - iso) * 0.45;

    const skyLum =
      0.2126 * skyHere[0] + 0.7152 * skyHere[1] + 0.0722 * skyHere[2];
    const moonGain = this.moonPower * 0.9;
    const lit = this.cloudAmbient;
    lit[0] = skyLum * 1.3 + skyHere[0] * 0.16 + this.moonTint.r * moonGain;
    lit[1] = skyLum * 1.3 + skyHere[1] * 0.16 + this.moonTint.g * moonGain;
    lit[2] = skyLum * 1.3 + skyHere[2] * 0.16 + this.moonTint.b * moonGain;
    const litLum = 0.2126 * lit[0] + 0.7152 * lit[1] + 0.0722 * lit[2];

    let transmit = 1;
    for (let i = 0; i < CLOUD_MARCH_CPU; i++) {
      const s = (i + 0.5) * dt;
      const tt = tEnter + s;
      const wx = dir.x * tt + this.cloudOffsetX;
      const wy = dir.y * tt;
      const wz = dir.z * tt + this.cloudOffsetZ;
      const h = (wy - CLOUD_BASE) / CLOUD_THICK;
      const threshold =
        coverNear + (coverFar - coverNear) * (s / Math.max(seg, 1));
      const dens = cloudDensity(
        wx,
        wy - CLOUD_BASE,
        wz,
        h,
        threshold,
        1,
        this.cloudEvolve,
      );
      if (dens <= 0.002) continue;

      // The sun march, geometric steps, detail off — matching GLSL_SKY.
      let tauSun = 0;
      let ss = CLOUD_SUN_STEP;
      let sx = wx;
      let sy = wy - CLOUD_BASE;
      let sz = wz;
      for (let j = 0; j < CLOUD_SUN_STEPS_CPU; j++) {
        sx += sun.x * ss;
        sy += sun.y * ss;
        sz += sun.z * ss;
        const sh = sy / CLOUD_THICK;
        if (sh > 1) break;
        tauSun += cloudDensity(sx, sy, sz, sh, threshold, 0, this.cloudEvolve) * ss;
        ss *= CLOUD_SUN_GROWTH;
      }
      tauSun = tauSun * CLOUD_EXTINCT * sunClimb;

      // Decay rates recalibrated for the traverse's honest optical depth — must
      // match GLSL_SKY, where the note explains why the old ones flattened
      // every cloud in the sky.
      const ms =
        phase0 * Math.exp(-tauSun) +
        phase1 * 0.55 * Math.exp(-tauSun * 0.42) +
        iso * 0.9 * Math.exp(-tauSun * 0.16);
      const powder =
        1 - 0.32 * Math.exp(-tauSun * 3) * (1 - Math.exp(-dens * 2.4));
      // Sky occlusion from the cloud ABOVE the sample, not from its height —
      // must match GLSL_SKY, where the long note explains why a height-only
      // proxy inverts the overcast/broken relation the means are tested on.
      const tauUp = dens * Math.max(1 - h, 0) * CLOUD_THICK * CLOUD_EXTINCT;
      const skyOcc = 0.18 + 0.82 * Math.exp(-tauUp * 0.35);

      const sunGainStep = ms * CLOUD_SUN_GAIN * powder;
      const aStep = 1 - Math.exp(-dens * CLOUD_EXTINCT * dt);
      const weight = transmit * aStep;
      for (let c = 0; c < 3; c++) {
        // Hue retained on skyOcc SQUARED, brightness on skyOcc — must match
        // GLSL_SKY, where the note explains why the linear form inverts the
        // overcast/broken relation these means are tested on.
        const ambient = (litLum + (lit[c] - litLum) * skyOcc * skyOcc) * skyOcc;
        col[c] += weight * (sunLight[c] * sunGainStep + ambient);
      }
      transmit *= 1 - aStep;
      if (transmit < 0.01) break;
    }
    if (transmit >= 0.999) return 0;

    const haze = Math.exp(-t * 0.000042);
    const fade = Math.min(
      Math.max(this.cloudOpacity * haze * horizonFade, 0),
      1,
    );
    col[0] *= fade;
    col[1] *= fade;
    col[2] *= fade;
    return (1 - transmit) * fade;
  }

  /**
   * Transmittance of the cloud slab along a light ray from the observer
   * toward `dir` — the same field, the same profile and the same march the
   * drawn layer uses, minus its view-side cues: the haze and the horizon fade
   * model what the layer LOOKS like from here, not what it blocks. The
   * distance fades on the puff/fine modulations are likewise omitted — they
   * are anti-aliasing for a rasterised view ray, and this is one line through
   * a smooth field. Low elevations cross more slab, which the path scale
   * carries, and the sample rides the drift offset, so gaps and tufts pass
   * across the sun in real time.
   *
   * It marches for the same reason the layer does: with a height-varying
   * density, the optical depth of a column is no longer a function of the 2D
   * field alone, and a sun that dims by a law the sky does not draw is worse
   * than one that does not dim at all.
   */
  /**
   * Fraction of light from `dir` that survives the cloud layer.
   *
   * PUBLIC, and deliberately the only cloud-shadowing function in the world
   * lighting path.
   *
   * The sun and the sky used to be gated by two different pieces of code: this
   * CPU march for the directional lights, and the GLSL cloud block for anything
   * evaluated in a shader — with a comment upstream describing this file as a
   * "CPU mirror of the cloud block in GLSL_SKY" and nothing anywhere enforcing
   * the mirror. Two models can disagree, and the disagreement has a specific
   * ugly shape: the sun reading "behind cloud" while the probe still fills the
   * hull with clear-sky blue, or the reverse. Neither looks like a bug. Both
   * look like the lighting is subtly wrong.
   *
   * So `WorldRadianceSource` samples this same function over a coarse
   * directional grid and hands the result to its shader as a texture. The
   * direct light averages exact directions over the solar disc and the probe
   * asks for a smooth field; every answer comes out of this one march. Same
   * volume, own resolution — the pattern the cloud mirror already uses against
   * the dome.
   */
  cloudTransmittance(dir: THREE.Vector3): number {
    if (this.cloudOpacity <= 0.001) return 1;
    return this.cumulusTransmittanceToward(dir);
  }

  /**
   * One-sample cloud transmission above a water point, for moving sun pools.
   *
   * This is deliberately not the directional-light authority: that remains
   * `cloudTransmittance`, integrated across the slab and over the solar disc.
   * It is the CPU mirror of the ocean shader's bounded presentation sample so
   * deterministic tests and diagnostics can ask the same cheap spatial
   * question the water asks. The point is horizontal metres from the observer,
   * matching the sky deck's observer-relative cloud domain.
   *
   * The sample sits halfway along the bounded slab traverse and turns its
   * density into optical depth over that geometric path. Above about seven
   * degrees this is the slab's altitude midline; lower down it remains inside
   * the existing 17 km reach rather than sampling a fictitious point beyond
   * the traverse. Detail erosion is zero: one broad shape sample is the
   * budget, not a disguised second cloud march.
   */
  sunPoolTransmittanceAt(
    waterXFromObserverM: number,
    waterZFromObserverM: number,
    dir: THREE.Vector3 = this.sunDirection,
  ): number {
    if (this.cloudOpacity <= 0.001 || dir.y < 0.004) return 1;

    const invY = 1 / Math.max(dir.y, 0.016);
    const pathM = Math.min(CLOUD_THICK * invY, CLOUD_REACH);
    const sampleT = CLOUD_BASE * invY + pathM * 0.5;
    const cloudX =
      waterXFromObserverM + dir.x * sampleT + this.cloudOffsetX;
    const cloudZ =
      waterZFromObserverM + dir.z * sampleT + this.cloudOffsetZ;
    const sampleY = dir.y * sampleT - CLOUD_BASE;
    const height = sampleY / CLOUD_THICK;
    const threshold = cloudCoverAt(
      this.cloudCover,
      cloudX * CLOUD_SCALE_X,
      cloudZ * CLOUD_SCALE_Y,
      this.cloudEvolve * CLOUD_EVO_SCALE,
    );
    const density = cloudDensity(
      cloudX,
      sampleY,
      cloudZ,
      height,
      threshold,
      0,
      this.cloudEvolve,
    );
    const alpha = 1 - Math.exp(-density * CLOUD_EXTINCT * pathM);
    return 1 - Math.min(Math.max(alpha * this.cloudOpacity, 0), 1);
  }

  /**
   * Disc-integrated direct sunlight rather than one point ray.
   *
   * The Sun is effectively at infinity, but it is not a point: each apparent
   * point on its 0.53-degree disc supplies a slightly different direction.
   * Averaging TRANSMITTANCE over those directions makes partial cloud cover a
   * partial light level. Averaging optical depth first would be wrong because
   * irradiance is linear in transmission, not in tau.
   *
   * This cache deliberately has no random or rotating jitter. Four stable
   * points change per frame, so a stationary cloud field and Sun cannot shimmer
   * merely because the estimator changed its pattern.
   */
  /**
   * How much brighter the moon makes the whole sky than a moonless one, as a
   * multiple of the airglow floor. Feeds the star-visibility penalty only.
   *
   * `MOON_AMBIENT_RATIO_PEAK` was measured at 40 degrees elevation, and the
   * elevation term rescales it. The exponent is a TWO-POINT FIT, not a law: the
   * marginal ambient measures 11.31x the airglow at 40 degrees and 6.88x at 10,
   * a ratio of 0.61, and sin^0.4 normalised at 40 degrees reproduces 0.60. Plain
   * sine — the right law for illuminance landing on the ground, and what the
   * retinal model uses — gives 0.27 and badly over-corrects, because sky
   * in-scatter accumulates along the whole view path rather than on one surface.
   */
  private moonSkyBrightening(
    moonElevationDeg: number,
    moonVisible: number,
  ): number {
    const sinElevation = Math.max(
      Math.sin(moonElevationDeg * (Math.PI / 180)),
      0,
    );
    const elevation =
      Math.pow(sinElevation, 0.4) / Math.pow(Math.sin(40 * (Math.PI / 180)), 0.4);
    return (
      MOON_AMBIENT_RATIO_PEAK *
      moonVisible *
      this.moonPhaseBright *
      this.nightFactor *
      elevation
    );
  }

  protected sunDiscCloudTransmittance(presentationDtSeconds: number): number {
    if (this.cloudOpacity <= 0.001) {
      this.sunDiscCache.fill(1);
      this.sunDiscInitialised = false;
      return 1;
    }

    const full =
      !this.sunDiscInitialised ||
      presentationDtSeconds >= SUN_DISC_SNAP_SECONDS;

    // A stable sun-local frame. The tangent is horizontal except at the
    // zenith, where solar azimuth is undefined and any tangent is equivalent.
    const sun = this.sunDirection;
    this.sunDiscTangent.set(-sun.z, 0, sun.x);
    if (this.sunDiscTangent.lengthSq() < 1e-12) {
      this.sunDiscTangent.set(1, 0, 0);
    } else {
      this.sunDiscTangent.normalize();
    }
    this.sunDiscBitangent
      .crossVectors(sun, this.sunDiscTangent)
      .normalize();

    const start = full ? 0 : this.sunDiscSlice * SUN_DISC_SLICE;
    const count = full ? SUN_DISC_SAMPLE_COUNT : SUN_DISC_SLICE;
    for (let i = start; i < start + count; i++) {
      const sample = SUN_DISC_SAMPLES[i];
      const radial = Math.hypot(sample[0], sample[1]);
      const angle = radial * SUN_ANGULAR_RADIUS;
      const tangentScale = Math.sin(angle) / radial;
      this.sunDiscDirection
        .copy(sun)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(this.sunDiscTangent, sample[0] * tangentScale)
        .addScaledVector(this.sunDiscBitangent, sample[1] * tangentScale);
      this.sunDiscCache[i] = this.sunDiscPointTransmittance(
        this.sunDiscDirection,
      );
    }

    if (full) {
      this.sunDiscInitialised = true;
      this.sunDiscSlice = 0;
    } else {
      this.sunDiscSlice =
        (this.sunDiscSlice + 1) % (SUN_DISC_SAMPLE_COUNT / SUN_DISC_SLICE);
    }

    let transmission = 0;
    for (let i = 0; i < SUN_DISC_SAMPLE_COUNT; i++) {
      transmission += this.sunDiscCache[i];
    }
    return transmission / SUN_DISC_SAMPLE_COUNT;
  }

  /** One exact solar-disc point; protected for deterministic quadrature tests. */
  protected sunDiscPointTransmittance(dir: THREE.Vector3): number {
    return this.cloudTransmittance(dir);
  }

  private cumulusTransmittanceToward(dir: THREE.Vector3): number {
    if (dir.y < 0.004) return 1;
    const invY = 1 / Math.max(dir.y, 0.016);
    const tEnter = CLOUD_BASE * invY;
    const seg = Math.min(CLOUD_THICK * invY, CLOUD_REACH);
    // NOT capped at CLOUD_STEP_MAX, unlike the shader. That cap is an
    // anti-grain device for a rasterised pixel, and combining it with this
    // consumer's much lower step count would cap the mirror's REACH as well as
    // its resolution — fourteen steps of 150 m covers 2.1 km of a 17 km grazing
    // ray, so the mirror would report thin cloud along the horizon while the
    // dome drew a solid deck. Same volume, own resolution.
    const dt = seg / CLOUD_MARCH_CPU;
    const evo = this.cloudEvolve * CLOUD_EVO_SCALE;
    const coverAt = (tt: number): number =>
      cloudCoverAt(
        this.cloudCover,
        (dir.x * tt + this.cloudOffsetX) * CLOUD_SCALE_X,
        (dir.z * tt + this.cloudOffsetZ) * CLOUD_SCALE_Y,
        evo,
      );
    const coverNear = coverAt(tEnter);
    const coverFar = coverAt(tEnter + seg);

    let tau = 0;
    let opaque = false;
    for (let i = 0; i < CLOUD_MARCH_CPU; i++) {
      const s = (i + 0.5) * dt;
      const tt = tEnter + s;
      const wy = dir.y * tt;
      const h = (wy - CLOUD_BASE) / CLOUD_THICK;
      const threshold =
        coverNear + (coverFar - coverNear) * (s / Math.max(seg, 1));
      tau +=
        cloudDensity(
          dir.x * tt + this.cloudOffsetX,
          wy - CLOUD_BASE,
          dir.z * tt + this.cloudOffsetZ,
          h,
          threshold,
          1,
          this.cloudEvolve,
        ) *
        CLOUD_EXTINCT *
        dt;
      if (tau >= CLOUD_OPAQUE_TAU) {
        opaque = true;
        break;
      }
    }
    // Every early-exited ray gets the SAME residual. Keeping its arbitrary
    // overshoot would let two already-opaque columns reverse their ordering by
    // a few ten-thousandths as cover changes, despite density being monotone.
    const alpha = 1 - (opaque ? CLOUD_TRANSMISSION_FLOOR : Math.exp(-tau));
    return 1 - Math.min(Math.max(alpha * this.cloudOpacity, 0), 1);
  }

  /**
   * `domeMean` replaces the aerosol phase function by its own normalisation.
   *
   * WHY IT EXISTS. `ambientRadiance` is a SEVEN-sample average of the sky, at
   * the zenith, a ring at 26 degrees and a ring at 54. The aerosol lobe is
   * g = 0.94 for a high source, which is about 43 at the light's own direction
   * and 0.11 a mere 25 degrees off it — a factor of four hundred inside a few
   * degrees. Point-sampling that with seven directions is not an estimate of a
   * mean, it is a lottery, and Part B turned the lottery up: with the moon at
   * its old strength the prize was small, but at MOON_SKY_POWER the measured
   * fill jumps from 12x the airglow to 45x as the moon crosses 26 degrees, and
   * back down, and up again at 54 and at the zenith. The whole scene's fill
   * would pulse fourfold as the moon tracked across the sky.
   *
   * WHY THIS IS THE FIX. The Mie phase function integrates to 1 over the
   * sphere. A mean over the dome of a normalised phase function is therefore
   * just that normalisation — 1/(2 pi) over a hemisphere the lobe sits entirely
   * inside — and using it is an UNBIASED estimator with zero variance, where
   * seven point samples are a high-variance one. The dome you actually look at
   * is unaffected and keeps its real aureole; only the means change.
   *
   * WHY ONLY THE MOON. The sun has exactly the same artefact — measured, the
   * daylight fill spikes 2.4x as the sun crosses 26 degrees elevation — and it
   * is NOT fixed here, because fixing it would move daylight and Part A's
   * "daylight is bit-identical" clause is not Part B's to spend. It is a real
   * bug, it predates both parts, and it is written up in the Part B report.
   */
  private addInscatter(
    dir: THREE.Vector3,
    lightDir: THREE.Vector3,
    tint: THREE.Color,
    power: number,
    out: [number, number, number],
    domeMean = false,
  ): void {
    if (power <= 0) return;
    const mu = Math.min(1, Math.max(-1, dir.dot(lightDir)));
    const amViewRaw = airMass(dir.y);
    // Soft-saturating path compression; see AM_VIEW_CAP.
    const amView = amViewRaw / (1 + amViewRaw / AM_VIEW_CAP);

    // Two-segment in-scatter integral along the view path, each segment
    // charged the sun transmittance at its own position and weighted by the
    // attenuated mass it carries — mirrors viewPathInscatter in GLSL_SKY.
    // Evaluating the transmittance at the observer instead is what made the
    // sunset peak several degrees early and hand the sky back to the blue
    // multi-scatter term while the disc was still up.
    // Soft ceiling on sample PLACEMENT only; the air mass carried is
    // untouched. Mirrors SAMPLE_REACH_MAX in GLSL_SKY.
    const sRaw = scatterPathScale(dir.y);
    const s1 = (SAMPLE_REACH_MAX * sRaw) / (sRaw + SAMPLE_REACH_MAX);
    const azProj = (dir.x * lightDir.x + dir.z * lightDir.z) / EARTH_R;
    const up = Math.max(dir.y, 0);
    const sa = s1 * 0.23;
    const amSunA = sunAirMassAt(
      sa * up + (sa * sa) / (2 * EARTH_R),
      lightDir.y + sa * azProj,
    );
    const sb = s1 * 0.9;
    const amSunB = sunAirMassAt(
      sb * up + (sb * sb) / (2 * EARTH_R),
      lightDir.y + sb * azProj,
    );
    const pathInscatter = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const be = BETA_E[c];
      const half1 = Math.exp(-be * amView * 0.5);
      pathInscatter[c] =
        (1 - half1) * Math.exp(-be * amSunA) +
        (half1 - Math.exp(-be * amView)) * Math.exp(-be * amSunB);
    }

    const phaseR = 0.0596831 * (1 + mu * mu);
    // Elevation-dependent aerosol lobe — mirrors GLSL_SKY: tight at high sun
    // (no haze ring), broad at low sun (the golden-hour wash).
    const lowSun = smoothstep(0.25, 0.03, lightDir.y);
    const g = 0.94 + (0.8 - 0.94) * lowSun;
    const g2 = g * g;
    const phaseM = domeMean
      ? 1 / (2 * Math.PI)
      : (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5));
    // The old 1.2 low-sun boost is gone: it compensated for the sunset lag now
    // fixed properly in the view-path integral. Must match GLSL_SKY.
    const mieScat = BETA_M_SCAT;

    const tintArr = [tint.r, tint.g, tint.b] as const;

    // Mirrors multiIlluminant() in GLSL_SKY, evaluated at the local sun
    // elevation of the multi-scatter source region along this view ray — the
    // twilight arch and the Earth's shadow, from geometry rather than from a
    // fitted azimuthal weight.
    const epsMulti = lightDir.y + multiReach(dir.y) * azProj;
    const below = Math.max(-epsMulti, 0);
    const amAir = Math.min(airMass(epsMulti), 11);
    const amOzone = amAir + below * 90;
    const dim = Math.exp(-0.085 * amAir) * Math.exp(-below * 26);

    const beamMax = Math.max(
      pathInscatter[0],
      pathInscatter[1],
      pathInscatter[2],
    );

    // Both terms resolved for all three channels before the recolouring, which
    // needs their luminances — mirrors `recycled` in GLSL_SKY. Only the
    // illuminant is recoloured; the scattering weight stays blue.
    const luma = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const proj = skyProjection();
    const single = [0, 0, 0];
    const multiWeight = [0, 0, 0];
    const illum = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const be = BETA_E[c];
      const tView = Math.exp(-be * amView);
      const scat = (proj[c] * phaseR + mieScat * phaseM) / be;
      single[c] = scat * pathInscatter[c];
      illum[c] = dim * Math.exp(-BETA_O3[c] * amOzone);
      multiWeight[c] =
        Math.pow(BETA_R[c] / be, MULTI_SPECTRAL_POW) * (1 - tView) * MULTI;
    }
    const beamHue = pathInscatter.map((v) => v / Math.max(beamMax, 1e-6));
    const beamScale = luma(illum) / Math.max(luma(beamHue), 1e-5);
    // The flux ratio alone hands the band back to blue below about +2 deg as
    // the warm term dies; a low sun holds the recolouring on for the low sky
    // regardless of flux — mirrors `sunsetHold` in GLSL_SKY.
    const warmFlux = luma(single);
    const fluxShare =
      warmFlux /
      (warmFlux +
        luma([
          multiWeight[0] * illum[0],
          multiWeight[1] * illum[1],
          multiWeight[2] * illum[2],
        ]) +
        1e-7);
    const sunsetHold =
      SUNSET_HOLD *
      smoothstep(0.16, -0.02, lightDir.y) *
      smoothstep(0.25, 0.02, dir.y) *
      smoothstep(-0.15, 0.55, mu);
    const recycled = Math.min(fluxShare + sunsetHold, 0.95);

    for (let c = 0; c < 3; c++) {
      const warmIllum = beamHue[c] * beamScale;
      const multi =
        multiWeight[c] * (illum[c] + (warmIllum - illum[c]) * recycled);
      out[c] += (single[c] + multi) * tintArr[c] * power;
    }
  }
}

/**
 * Ring at 4 degrees elevation, for the exposure meter only. Deliberately not
 * part of the ambient fill: this ring is where the sunset's energy is, and
 * feeding it into the fill would light the raft from the horizon.
 */
const HORIZON_SAMPLES: ReadonlyArray<readonly [number, number, number]> = (() => {
  const samples: Array<readonly [number, number, number]> = [];
  const y = Math.sin((4 * Math.PI) / 180);
  const r = Math.cos((4 * Math.PI) / 180);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    samples.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return samples;
})();

/**
 * How much of the horizon ring's mean luminance the exposure meter honours.
 * The meter takes the larger of this and the fill average, so the ring only
 * ever *closes down* the exposure, and only when the horizon is genuinely the
 * bright part of the frame — which is the sunset and nothing else.
 */
const HORIZON_METER_WEIGHT = 0.5;

/**
 * Zenith plus two rings — the fill estimator that ships, and the last set of
 * fixed directions left in this file.
 *
 * KEPT ONLY AS THE OFF ARM of `?fibonacciAmbient=1`. Measured against a
 * converged 8192-direction integral of the quantity it is trying to be, this
 * set is out by 4.65x at a 26 degree sun, 3.14x at 53 and 2.11x at 88 — the
 * three elevations where a sample sits — and 3 to 15 percent high in between.
 * Rings are the fault: a bright thing in the sky spikes the whole scene's fill
 * as it crosses one and drops back between them. See colourPipeline.ts and
 * docs/graphics/AMBIENT_SET_ROUND.md.
 *
 * Do not add an eighth direction here. More rings is more rings.
 */
const AMBIENT_SAMPLES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [0.9, 0.436, 0],
  [-0.9, 0.436, 0],
  [0, 0.436, 0.9],
  [0, 0.436, -0.9],
  [0.6, 0.8, 0.0],
  [-0.6, 0.8, 0.0],
];

/**
 * Directions the sky is projected along, for both the whole-dome mean and the
 * harmonic probe.
 *
 * 256, and the count is not arbitrary. A cumulus field is high-variance, so a
 * cosine-weighted mean of it is a Monte-Carlo estimate whose error is what the
 * sea's rough reflection converges to. Measured against a 6000-direction
 * reference of the same function, the worst-case error over cloud covers 0.15
 * to 0.95 runs: 48 samples 35%, 96 samples 22%, 160 samples 10%, 256 samples
 * 5%. The set this replaced was THIRTEEN, on three rings, and came in at 49%
 * under heavy cloud and 154% under a clear sky.
 */
const PROBE_SAMPLES = fibonacciHemisphere(256);

/**
 * Directions re-evaluated per frame.
 *
 * 256 sky evaluations every frame costs about 1.6 ms of CPU, which this scene
 * cannot spare for a quantity that changes on cloud-drift timescales. So the
 * radiances are cached per direction and a slice refreshed each frame.
 *
 * SIXTEEN, not sixty-four. At 64 the amortised cost measured +0.45 ms per frame
 * against the thirteen-sample set this replaced — enough to push the frame past
 * the adaptive-resolution controller's threshold, which then dropped the render
 * scale to a quarter of native and started hunting. The draw itself was
 * unchanged (0.33 ms against 0.32 ms at 1280x720); the whole regression was
 * here. At 16 the cost is about 0.10 ms, which is where the old sample set sat,
 * and the full 256-direction accuracy is kept.
 *
 * The price is latency: a full cycle is 16 frames, about 270 ms. The only
 * consumer is the sea's reflection target, on a cloud field that takes minutes
 * to move and a sun that advances 0.03 degrees in that time even at 30x world
 * speed. A discontinuous jump (the time slider, a capture harness) bypasses the
 * rotation entirely; see the `full` branch.
 */
const PROBE_SLICE = 16;

/** Presentation delta above which the cache is rebuilt rather than rotated. */
const PROBE_SNAP_SECONDS = 1.0;
