import * as THREE from 'three';
import {
  GLSL_CATS_PAW,
  type CatsPawFieldFrame,
} from '../weather/CatsPawField';
import {
  GLSL_COMMON,
  GLSL_LOG_DEPTH_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_VERTEX,
  GLSL_LOG_DEPTH_VERTEX,
  GLSL_SKY,
  GLSL_SKY_RADIANCE_LUT_UV,
  GLSL_WAVES,
} from './shaders/lib';
import { GLSL_SKY_PROBE } from './skyHarmonics';
import {
  MAX_WAVES,
  RESIDUAL_MIN_WAVELENGTH_DESKTOP,
  RESIDUAL_MIN_WAVELENGTH_MOBILE,
} from './Waves';
import type { WaveField } from './Waves';
import { SUN_IRRADIANCE_SCALE, SUN_SKY_POWER } from './TimeOfDay';
import { FOAM_FAR_EXTENT, FOAM_HULL_EXTENT, FOAM_NEAR_EXTENT } from './FoamField';
import {
  FOAM_LOOKUP_JITTER_TEXELS,
  FOAM_LOOKUP_SMOOTHING,
  type FoamLookup,
} from './foamLookup';
import {
  FOAM_WAKE_STREAK_FRAME,
  FOAM_WIND_STREAK_FRAME,
  advanceFoamStreakFrame,
  createFoamStreakFrame,
  publishFoamStreakFrame,
  type FoamStreakFrame,
} from './foamStreakFrame';
import type { FoamQuality } from './FoamField';
import { FLAME_INTENSITY } from './Lamp';
import {
  CLEAR_DEEP_OCEAN,
  LEGACY_FLAT_BACKSCATTER,
  waterBodyReflectance,
} from './oceanOptics';
import { isLegacyWaterHue, onColourPipelineChange } from './colourPipeline';
import type { OceanOpticsProfile } from './oceanOptics';
import type { InteriorCutoutVolume } from './interiorCutoutVolume';
import {
  createDetailGradientTextureData,
  createFaithfulDetailGradientTextureData,
  detailSkewNormalisation,
  type DetailGradientTextureStyle,
} from '../ocean/detailGradientTexture';
import { rejectWhereInterior } from './interiorStencil';

/** The two live implementations compared by the interior-cutout benchmark. */
export type InteriorCutoutMode = 'stencil' | 'shader';

/**
 * The sea surface.
 *
 * Topology is a radial disc centred on the **observer**: ring radii grow
 * exponentially so the near field gets sub-metre resolution while the rim still
 * reaches 20 km, past the geometric horizon. The disc is never rotated and never
 * snapped — wave phase comes from the parameter space, so the sliding vertices
 * are invisible and there is no tile to spot.
 *
 * THE CENTRE IS THE OBSERVER, NOT THE SUBJECT
 * -------------------------------------------
 * The disc used to be centred on the raft, which is right up to about 80 m and
 * wrong past it. At the far end of the camera's range the camera is 1374 m from
 * the raft and 267 m up, so the water *nearest the camera* is the water
 * *furthest from the raft* — 20 m triangles with every Gerstner component past
 * its LOD fade, a flat mirror plate laid directly under the lens. The centre
 * therefore blends towards the camera's ground point as the camera pulls away
 * (see `main.ts`), which puts the resolution where the pixels are. Below 80 m
 * the blend is exactly zero and this is bit-for-bit the raft-centred disc.
 *
 * Everything keyed on `vLodRadius` is consequently keyed on *distance from the
 * observer*, which is what a level of detail should have been keyed on all
 * along. Anything that belongs to the foam field takes that field's own window
 * (see the fragment stage). Vessel and wave shadows are geometry-driven and
 * therefore need no subject-centred mask or position uniform at all.
 *
 * Detail runs down a chain: displaced geometry -> per-pixel residual wave
 * gradient -> procedural detail gradient -> statistical roughness. Each level
 * hands off to the next as it becomes sub-pixel, which is what stops the
 * distant water shimmering or going mirror-glassy.
 *
 * ONE COORDINATE, USED CONSISTENTLY
 * ---------------------------------
 * Everything procedural on this surface — the residual wave gradient, the
 * detail octaves, the foam field, the foam breakup — is evaluated at the
 * **undisplaced parameter position**, the same `p` the vertex wave phase used.
 *
 * That is not a tidiness preference, it is what makes the surface correct.
 * Water parcels live at parameter positions: a Gerstner particle orbits a fixed
 * `p` rather than travelling. So anything that rides on the water — ripples,
 * foam, streaks — is stationary in `p` and must be looked up there. Evaluating
 * one layer at the displaced position and another at the undisplaced position
 * misregisters them by the horizontal displacement, which is tens of
 * centimetres in a moderate sea and a raft length in a steep one, and it makes
 * detail slide across the water instead of moving with it.
 *
 * GRADIENTS, NOT SLOPES
 * ---------------------
 * Each layer contributes a height gradient measured in parameter space. They
 * are summed and converted to a world-space slope exactly once, through the
 * inverse horizontal Jacobian. Adding parameter-space gradients directly to a
 * world slope is only valid for a height field, and this surface is displaced
 * horizontally by design — most at the crests, which is where the foam and the
 * specular highlights are.
 */

export interface OceanQuality {
  rings: number;
  sectors: number;
  detailOctaves: number;
  cloudOctaves: number;
  /**
   * Steps of the view march through the cloud slab. The sky dome compiles with
   * the same number — it is the layer's shape, not a look-alike approximation
   * of it, so a sea that marched differently from the sky above it would be
   * reflecting and hazing towards a cloudscape that does not exist.
   */
  cloudMarch: number;
  /** Octaves of the 3D shape field, and samples up the sun ray per lit sample. */
  cloudShapeOctaves: number;
  cloudSunSteps: number;
  /**
   * Whether the atmospheric-haze lookup includes the cloud layer. Clouds are
   * never in the MIRROR sample at any quality — see the reflection stage —
   * so this only buys cloud-tinted haze near the horizon, which mobile skips.
   */
  cloudsInHaze: boolean;
  foamBreakupOctaves: number;
  /** Shortest wavelength the per-pixel residual term evaluates. */
  residualMinWavelength: number;
}

/** Independent presentation gains for WK1's persistent B-channel trail. */
export interface WakeTrailAppearance {
  bubbleHaze: number;
  whitecapSuppression: number;
  /** Residual-foam coverage per unit B: the aged fleck floor of the band. */
  trailFoamFloor: number;
}

/** WK2's removable, presentation-only normal mound at the resolved stem. */
export interface BowMoundAppearance {
  centreX: number;
  centreZ: number;
  forwardX: number;
  forwardZ: number;
  normalStrength: number;
  acrossRadiusM: number;
  alongRadiusM: number;
}

/** WK-R4's analytic Kelvin-wedge pattern, fragment normals only. */
export interface ShipWakePatternAppearance {
  /** Seed-space anchor (the inverted stem midpoint). */
  originX: number;
  originZ: number;
  /** Course direction the wedge trails away from; normalised by the setter. */
  dirX: number;
  dirZ: number;
  /** Hull centreline direction for the attached near-field bow wave. */
  hullForwardX: number;
  hullForwardZ: number;
  /** Live stem-to-stern waterline span and the active vessel's half-beam. */
  hullLengthM: number;
  halfBeamM: number;
  /** Finite forward-shoulder cut and crown span of the live bow front. */
  bowShoulderCentreX: number;
  bowShoulderCentreZ: number;
  bowShoulderHalfWidthM: number;
  bowCrownHalfWidthM: number;
  wavelengthM: number;
  /**
   * Slope amplitude of the NEAR-field bow pressure front; exactly zero is the
   * exact off-path.
   */
  normalStrength: number;
  /**
   * Slope amplitude of the FAR-field stationary-phase Kelvin pattern, which is
   * a separate model with a separate switch. Exactly zero is its off-path, and
   * it is zero by default — see `WakePresentationController`.
   */
  kelvinStrength: number;
  wedgeLengthM: number;
}

/**
 * Diagnostic animation models for the unresolved normal-detail band.
 *
 * `directional` is the shipping baseline. The other two deliberately keep the
 * same expected slope variance, so switching modes compares motion rather than
 * silently roughening or polishing the sea.
 */
export type DetailMotionMode = 'directional' | 'counterflow' | 'evolving';

/**
 * Live, energy-neutral shape controls for the detail band — both 0 in the
 * shipping look. See `Ocean.setDetailShape`.
 */
export interface OceanDetailShape {
  /** 0 = the 0.55-per-octave falloff; 1 = the DETAIL_MID_SHIFT_TABLE tilt. */
  midShift: number;
  /** 0 = the symmetric field; 1 = crest skew at DETAIL_SKEW_MAX. */
  crestSkew: number;
}

/**
 * The shipping detail shape.
 *
 * `crestSkew: 0` — REJECTED ON SIGHT, and the rejection is a design fault in
 * the skew, not a taste call. The weight is `max(1 + s·v, 0)`, so at the
 * strength that visibly sharpens a crest the clamp also drives whole
 * low-value regions to exactly zero gradient. Those become flat dead patches
 * ringed by the surviving steep edges, which is precisely the "warts /
 * lumpy cake mix" Ash saw: a hard clamp cannot sharpen crests without
 * flattening troughs into scabs. A skew that survives has to redistribute
 * slope smoothly (a monotone warp of the value, no clamp) rather than
 * subtract it. Kept at 0 until that exists.
 *
 * `midShift: 1` stands — Ash judged it "slightly increasing the scale of the
 * surface details", which is the intended direction, and kept it at 100%.
 */
export const DEFAULT_OCEAN_DETAIL_SHAPE: OceanDetailShape = {
  midShift: 1,
  crestSkew: 0,
};

/**
 * Shipping strength of the wave sky-occlusion, as a multiple of the derived
 * geometry. 1 is the derivation taken at face value.
 */
export const DEFAULT_WAVE_OCCLUSION_STRENGTH = 1;

/**
 * How steeply the below-horizon reflection block ramps in: a reflected ray
 * pointing 1/6 of a unit below the horizon (about 9.6 degrees) is fully
 * blocked. Steep, because the thing doing the blocking is the back of the
 * very next wave and it is not far away.
 */
const HORIZON_BLOCK_SHARPNESS = 6;

/**
 * How much radiance a fully-below-horizon reflected ray loses. Not 1: some of
 * what it meets is the lit back of another wave, which is dim but not black,
 * and the sea's own inter-reflection is not modelled anywhere else.
 */
export const DEFAULT_HORIZON_BLOCK = 0.8;

/**
 * Lognormal sparkle width, in units of the detail field's own RMS. 0 restores
 * the plain GGX mean — every build before this one.
 *
 * 1.1 puts the brightest one per cent of facets around fifteen times their
 * mean radiance, which is what carries a midday glint over display white and
 * into the tone curve's bleach, while the mean is preserved exactly.
 */
export const DEFAULT_SPARKLE_STRENGTH = 1.1;

/**
 * Luminance the water contrast curve pivots about: tones above it brighten,
 * tones below it darken, and this one holds still. Set near the daylight
 * sea's own mid-tone so the control opens the range symmetrically instead of
 * dragging the whole surface up or down.
 */
const WATER_CONTRAST_PIVOT = 0.28;

/** Shipping water contrast, chosen by eye. 1 is off. */
export const DEFAULT_WATER_CONTRAST = 1.15;

/**
 * Roughness lift on the grazing Fresnel's incidence cosine. 1.0 means the
 * visible microfacets are taken to be tilted by a full alphaReflect toward
 * the viewer, which is the right order for a wind-roughened sea; 0 is the
 * plain macro-normal Schlick that turned the distance into a sky mirror.
 */
export const DEFAULT_GRAZING_SLOPE_LIFT = 1.0;

/**
 * Compile-time counterfactuals used by the ocean GPU probe.
 *
 * These deliberately change the image. Their purpose is to remove shader
 * regions completely so the tile-safe whole-draw timer can recover each
 * region's marginal cost even though WebGL cannot put timer queries inside one
 * fragment shader invocation.
 */
/**
 * Structural variants of the residual-wave loop. Unlike the other profile
 * settings these are meant to be pixel-identical to shipping — they change how
 * the 48-slot scan executes, not what it computes. `branchless` replaces the
 * per-pixel-divergent continues/branches with selects; `texture` fetches the
 * wave parameters with texelFetch instead of uniform-array reads; `rolled`
 * hides the loop bound behind a uniform so the compiler cannot unroll.
 */
export type OceanResidualLoopMode =
  | 'shipping'
  | 'active'
  | 'branchless'
  | 'texture'
  | 'rolled';

/** Two RGBA8 passes used by the residual category-distribution probe. */
export type OceanResidualCategoryMode = 'off' | 'a' | 'b';

/** Lossless RGBA8 pass used by the detail live-octave probe. */
export type OceanDetailCategoryMode = 'off' | 'categories';

/** Procedural reference stack and the texture-backed detail representations. */
export type OceanDetailRepresentation =
  | 'analytic'
  | 'prefiltered'
  | 'cached-256'
  | 'cached-512'
  | 'cached-768'
  | 'cached-1024'
  | 'cached-2048'
  | 'hybrid';

/** User-approved production detail representation. */
export const DEFAULT_OCEAN_DETAIL_REPRESENTATION: OceanDetailRepresentation =
  'cached-1024';

type FaithfulDetailCacheResolution = 256 | 512 | 768 | 1024 | 2048;

export interface OceanProfileSettings {
  vertexWaveSlots: number;
  residualWaveSlots: number;
  residualPhaseEnabled: boolean;
  residualLoopMode: OceanResidualLoopMode;
  detailOctaves: number;
  detailRepresentation: OceanDetailRepresentation;
  detailTextureStyle: DetailGradientTextureStyle;
  foamEnabled: boolean;
  flatFragment: boolean;
}

const DETAIL_MOTION_UNIFORM: Record<DetailMotionMode, number> = {
  directional: 0,
  counterflow: 1,
  evolving: 2,
};

/**
 * Steps of the view march through the cloud slab, and the SAME number on every
 * device — see the note on `cloudMarch` for why the sea and the sky must agree.
 *
 * 192 rather than a per-device figure because the step count is not really a
 * device budget, it is the elevation at which the march stops under-sampling.
 * `seg = CLOUD_THICK / sin(elev)` stretches as the view drops; the low sky —
 * which is most of what is visible from a raft — was banding there at 96 and
 * still improving at 192. Above twenty degrees 96 was already converged, so the
 * extra steps buy nothing at the zenith and everything at the horizon.
 *
 * At 192 the CLOUD_STEP_MAX cap no longer binds anywhere. It did at 96, and an
 * earlier draft of this note said so — "below about twenty degrees the step
 * length hits CLOUD_STEP_MAX" — which stopped being true the moment the count
 * doubled: the longest step any ray can take is now CLOUD_REACH / 192 = 88.5 m
 * against a 150 m cap. The cap becomes live again below about 114 steps, which
 * `?cloudMarch=` can reach, and `tests/shader-source.test.ts` is what notices.
 *
 * The cost is close to linear in the count but the bake is amortized over sixty
 * frames at roughly one tile each, which is what makes it affordable: measured
 * at 2560x1440, the whole bake is ~8.2 ms per frame at 192 against ~5.9 at 96.
 * Mobile bakes a quarter as many tiles, so it pays proportionally less.
 *
 * `?cloudMarch=` in main.ts overrides this for on-device measurement.
 */
export const CLOUD_MARCH_STEPS = 192;

export const OCEAN_QUALITY_DESKTOP: OceanQuality = {
  rings: 288,
  sectors: 288,
  /**
   * Five, not three. The stack's job is to DRAW the slope the pixel can
   * resolve and hand the rest to the specular lobe as statistics, and at three
   * octaves the split was badly placed for anything close to the camera: the
   * finest cell was 0.48 m and only 16% of the sea's unresolved slope variance
   * was ever drawn, leaving a lobe 12.5 deg wide to be broken up by a normal
   * that swung 5.5 deg. A lobe wider than the texture that has to modulate it
   * smooths straight over it — which is why a lantern two metres away lit a
   * flat coloured disc instead of a sparkling patch, and why the near daylight
   * sea read faintly glassy.
   *
   * Five puts the finest cell at 9.6 cm — short gravity ripple, the scale that
   * actually texturises water at arm's length — and moves the split to 9.2 deg
   * drawn against a 10.2 deg lobe. Comparable scales is where sparkle contrast
   * peaks. Six was measured too (4.3 cm, ratio 1.58) and is left on the table:
   * it also narrows the lobe enough to visibly change the daylight sun glitter,
   * which is a bigger decision than this one.
   *
   * Costs nothing beyond the near field: each octave's Nyquist fade retires it
   * once a pixel spans half its cell, so octaves 3 and 4 are dead past roughly
   * ten metres and the variance they were carrying is handed back to the lobe
   * per pixel, exactly as the far field had it before.
   */
  detailOctaves: 5,
  cloudOctaves: 3,
  cloudMarch: CLOUD_MARCH_STEPS,
  cloudShapeOctaves: 5,
  cloudSunSteps: 5,
  // The dome and the reflected-sky cache already carry the clouds. Marching
  // the volume again for atmospheric perspective made an ocean pixel's cost
  // depend on whether its view ray happened to point above the cloud layer's
  // horizon cutoff. A steep face passing the embodied eye flips a large block
  // of pixels across that cutoff and can turn each one into a 192-step cloud
  // march. Gas-only haze is stable with wave geometry and leaves clouds in the
  // two places where their shape is actually visible.
  cloudsInHaze: false,
  foamBreakupOctaves: 3,
  residualMinWavelength: RESIDUAL_MIN_WAVELENGTH_DESKTOP,
};

export const OCEAN_QUALITY_MOBILE: OceanQuality = {
  rings: 160,
  sectors: 160,
  /** One more than before, for the same reason desktop gained two. */
  detailOctaves: 3,
  cloudOctaves: 2,
  cloudMarch: CLOUD_MARCH_STEPS,
  cloudShapeOctaves: 4,
  cloudSunSteps: 3,
  cloudsInHaze: false,
  foamBreakupOctaves: 1,
  residualMinWavelength: RESIDUAL_MIN_WAVELENGTH_MOBILE,
};

const INNER_SCALE = 8.68;
const OUTER_RADIUS = 20000;

/**
 * Observer-distance window for spatial cloud sunlight, metres.
 *
 * A one-point cloud sample is appropriate while a cloud cell spans many
 * pixels. Once pixels integrate kilometres of water, the established scalar
 * solar-disc transmission is the better statistic. The end is a hard exact
 * bypass as well as the end of the smooth hand-off, so the far horizon keeps
 * its pre-WX3 lighting and pays no cloud-field sample cost.
 */
export const SUN_POOL_FADE_START_M = 1800;
export const SUN_POOL_FADE_END_M = 3200;

/**
 * Ratio between the ocean shader's irradiance scale and three.js's light units.
 *
 * DERIVED, and now exactly right at every solar elevation rather than only at
 * high sun.
 *
 * Both renderers light from the same transmitted sun magnitude. The ocean
 * multiplies it by `uSunPower`; the DirectionalLight multiplies it by
 * `SUN_IRRADIANCE_SCALE`. The conversion between them is therefore the ratio of
 * those two constants and nothing else — 21 / 9 — with the magnitude itself
 * cancelling out.
 *
 * It used to be a measurement: 2.30, taken at 60 degrees, with its own comment
 * admitting it "drifts below about 10 degrees ... so this is the high-sun
 * ratio". That drift was the `^0.52` compression the DirectionalLight carried
 * and the ocean did not, which meant the sea and the deck disagreed about how
 * bright the sun was by an amount that depended on the time of day. Linearising
 * the sun removed the exponent, and with it the drift, and with that the need
 * to measure this at all.
 *
 * The number barely moves — 2.30 to 2.333 — which is the point: this was
 * always trying to be 21/9.
 */
const OCEAN_PER_DECK_IRRADIANCE = SUN_SKY_POWER / SUN_IRRADIANCE_SCALE;

// The mean-radiance → irradiance conversion (formerly a module constant,
// OCEAN_AMBIENT_GAIN = 5.6) now lives on the optics profile as
// `ambientIrradianceGain`, so the ocean, the hull's reflected sea, and the
// lab's live A/B all read one mutable policy value. See DERIVED_BODY_OPTICS
// in oceanOptics.ts for why π is the honest value and 5.6 the shipping one.

/**
 * The lantern's irradiance on the water at one metre, in the shader's own
 * units — the same scale `uSunPower` (21) and the moon's power (0.07) live on.
 *
 * DERIVED, not chosen. One flame cannot be two brightnesses: the number that
 * lights the planks and the number that lights the sea have to come from the
 * same emitter, or the reflection and the raft drift apart and no amount of
 * eye-tuning makes them agree again. So this is the flame's own intensity
 * carried across the measured scale gap above, and nothing else.
 *
 * (Hand-tuned by eye first, at 3.0. Deriving it lands on 4.37 — the eye was
 * about a third of a stop low, which is worth knowing about the eye.)
 *
 * What is still NOT modelled here: this is a constant, and the world it sits
 * in spans only 6.5 stops from noon to deep night where the real one spans
 * about eighteen. A constant lamp on a compressed axis cannot be right at both
 * ends. See GRAPHICS_TODO.
 */
const LAMP_WATER_GAIN = FLAME_INTENSITY * OCEAN_PER_DECK_IRRADIANCE;

/**
 * Peak fraction of the sky hemisphere the hull removes, on her centreline.
 *
 * Chosen by eye off a ladder, but the range it was chosen from is not arbitrary.
 * The falloff is inverse-square about the waterline axis, so water alongside her
 * — three metres or so off the centreline — receives roughly half of this, and
 * a hull with two metres of freeboard genuinely covers something like that
 * fraction of the cosine-weighted hemisphere for water hard against it.
 *
 * An earlier value of 0.45 was justified by an offsetting error: the sea beside
 * a hull is also lit by light bouncing off the hull's own topsides, and that
 * return path is not modelled, so under-occluding was said to cancel it. That
 * argument does not survive contact with THIS vessel. Her topsides are tar —
 * see the world-lighting round — and a near-black hull returns almost nothing
 * to cancel against. With the excuse withdrawn, the honest value is higher.
 *
 * Judge any change to this at a grazing sunset, not overhead. That is where the
 * sky's share of the water's brightness is largest (81 per cent measured beside
 * her at a 38 degree sun, and higher still at grazing) and therefore where this
 * term does the most, for good or ill.
 *
 * 0.45 rather than the 0.75 first landed. At 0.75 the drop measured 13 per cent
 * at a 38 degree sun and 23.7 per cent at dusk over three times the area — too
 * heavy by eye at twilight. Most of that asymmetry was the mirror term, now
 * split out below; this value covers the diffuse share alone.
 */
const VESSEL_SKY_OCCLUSION = 0.45;

/**
 * Sky the hull replaces where the mirror ray actually meets her topsides.
 *
 * Higher than the AO because it is a different quantity. AO is a fraction of a
 * hemisphere lost; this is a mirror pointed at tar instead of at sky, and tar
 * returns almost nothing. It is not 1.0 only because the hull's own faint
 * radiance is never added back, so a full occlusion would read as a hole.
 */
const VESSEL_MIRROR_OCCLUSION = 0.85;

/**
 * Lattice period of the detail noise, in cells.
 *
 * The noise hash is taken modulo this, so the field is exactly periodic with
 * this period *in the space each octave is sampled in*. Turning that into a
 * period in metres is the subtle part — see `detailWrapPeriod`.
 */
const NOISE_PERIOD = 256.0;
/** Four base-time periods make every supported octave's temporal rate wrap exactly. */
const DETAIL_TIME_WRAP = NOISE_PERIOD * 4;
/** Cells per second through the temporal axis of the evolving 3D field. */
const DETAIL_EVOLUTION_RATE = 0.32;

/**
 * Foam field density units to rendered coverage.
 *
 * Chosen by eye against the live sea, not fitted. 3.2 for the first storm-sea
 * round, then 2.5 once the spray had somewhere to show, and now 1.2 for the
 * production whitewater look. The value the original gain replaced was
 * measured — against a persistent field whose lookup was being multiplied by
 * zero for all but the first ninety seconds of a rough sea, using a
 * bright-desaturated pixel count that the noon sun triggers on a third of an
 * unfoamed frame. It arrived at 3.1, which is within noise of where the eye
 * lands, entirely by luck.
 *
 * It costs 0.196 ms of a 9.4 ms ocean pass on an M2 at 2560×1353, against
 * 0.110 ms at 0.4, so the whole usable range spans under 0.1 ms and this number
 * is a look decision alone. See `runWhitewaterCostBenchmark`.
 */
export const FOAM_COVERAGE_GAIN = 1.2;

/**
 * Surface extinction of a fully loaded gale, per metre.
 *
 * Scaled by `CrestSpray.activity` into `Ocean.setSaltLoading`, so a sea that is
 * not tearing its crests apart carries no salt at all. Sized against the
 * embodied eye, which is the view the layer exists for: the near water stays
 * clean and the distance goes progressively, because obscuring contrast with
 * range is the whole job and a layer that touched the foreground would just be a
 * lowered exposure.
 *
 * Chosen by eye: 0.6 of the first pass's value, then 3.5x that once the spray
 * beneath it was carrying its share.
 */
export const SALT_DENSITY_FULL = 0.00385;

/**
 * Per-octave ripple headings, radians about the wind. Alternating sides and
 * growing offset: adjacent octaves shear against each other, which is what
 * makes the summed detail pattern boil rather than slide.
 *
 * Six entries, which is `MAX_DETAIL_OCTAVES`; a quality tier reads a prefix.
 */
const DETAIL_SCROLL_ANGLES = [0.45, -0.75, 1.3, -1.95, 2.62, -3.05] as const;

/**
 * Ceiling on the octave stack, and the size of the scroll uniform array.
 *
 * Not a quality knob: the Nyquist fade retires each octave the moment a pixel
 * stops resolving it, so the cost of the fine end is paid only within a few
 * metres of the camera and the far field never evaluates them at all.
 */
const MAX_DETAIL_OCTAVES = 6;

/**
 * Per-octave amplitude trims at mid-band shift 1, before renormalisation.
 *
 * The shipping stack's 0.55 amplitude falloff against a sqrt(5) frequency step
 * grows drawn SLOPE by 1.23x per octave, which lands 64 % of the drawn detail
 * at 21 cm and below and only 28 % in the 0.3–1.1 m window — the band where
 * photographed chop carries its sharp crests. This table tilts the drawn
 * spectrum toward that window: at detail scale 2.4 m the slope-variance shares
 * move from roughly 7/11/17/26/39 % (coarse to fine) to 6/18/30/28/18 %.
 *
 * The absolute numbers are a candidate for the eye, not physics; what is
 * structural is the renormalisation in `updateUniforms`, which scales the
 * whole table so the stack's total drawn slope variance is invariant at every
 * shift — the control moves energy between octaves and can never brighten or
 * flatten the sea as a side effect. Entry 5 only matters if a six-octave
 * quality tier ever ships; it continues the fine-end de-emphasis.
 */
const DETAIL_MID_SHIFT_TABLE = [0.90, 1.27, 1.33, 1.05, 0.68, 0.55] as const;

/**
 * Crest-skew strength at slider 1, in units of the noise value.
 *
 * Measured against the analytic field (value range ±0.77, sigma 0.204): at 6.0
 * the crest-side gradients run up to ~3.8x while the deepest troughs clamp
 * flat, retiring about 19 % of the field's gradient energy into the crests.
 * Beyond this the clamp dominates and the field reads as isolated scratches
 * rather than sharpened chop.
 */
const DETAIL_SKEW_MAX = 6.0;

/**
 * Per-octave detail gains for a mid-band shift, renormalised to hold the
 * stack's total drawn slope variance exactly where the unshifted stack put it.
 *
 * Writes `MAX_DETAIL_OCTAVES` entries: the active octaves get their
 * renormalised gain, the rest get 1 (the shader's loop never reads them, but a
 * stale value there would be a trap for any future tier change).
 *
 * The renormalisation runs over the ACTIVE octave count, so each quality tier
 * is independently energy-neutral — a mobile three-octave stack is not
 * normalised against variance only a desktop five-octave stack draws.
 *
 * Pure and exported so the invariant can be pinned by test rather than
 * inferred from a screenshot; slope RMS per octave scales by 0.55·√5 ≈ 1.23,
 * which is the weight the sum must use.
 */
export function writeDetailOctaveGains(
  out: number[],
  midShift: number,
  octaveCount: number,
): void {
  const active = Math.max(0, Math.min(octaveCount, MAX_DETAIL_OCTAVES));
  let referenceVariance = 0;
  let shiftedVariance = 0;
  let bandRms = 1;
  for (let o = 0; o < active; o++) {
    const raw = 1 + (DETAIL_MID_SHIFT_TABLE[o] - 1) * midShift;
    out[o] = raw;
    referenceVariance += bandRms * bandRms;
    shiftedVariance += raw * bandRms * (raw * bandRms);
    bandRms *= 0.55 * OCTAVE_SCALE;
  }
  const norm = Math.sqrt(referenceVariance / Math.max(shiftedVariance, 1e-9));
  for (let o = 0; o < MAX_DETAIL_OCTAVES; o++) {
    out[o] = o < active ? out[o] * norm : 1;
  }
}

/** Frequency ratio between detail octaves: the norm of [[2,1],[-1,2]]. */
const OCTAVE_SCALE = Math.sqrt(5);

/**
 * Spatial period, in metres, over which the whole detail stack repeats exactly.
 *
 * The octave transform below is the integer matrix [[2,1],[-1,2]]. Being
 * integer, it maps the noise lattice onto itself, so a shift that is a whole
 * number of lattice periods in octave 0 is *also* a whole number of lattice
 * periods in every later octave. That makes this single wrap exact for the
 * entire stack.
 *
 * The previous rotation-by-31.8-degrees with a 2.17 frequency ratio had neither
 * property: each octave repeated over a different, irrational distance
 * (614.4 m, 283.1 m, 130.5 m), and the code wrapped the origin at a flat 256 m
 * that matched none of them. Shifting the origin by what the code believed was
 * a no-op moved every octave to an unrelated part of the noise field, which is
 * exactly the normal-detail popping the coupling report recorded.
 */
function detailWrapPeriod(detailScale: number): number {
  return NOISE_PERIOD * detailScale;
}

function buildRadialDisc(rings: number, sectors: number): THREE.BufferGeometry {
  const K = Math.log(OUTER_RADIUS / INNER_SCALE + 1);
  const vertexCount = (rings + 1) * sectors;
  const positions = new Float32Array(vertexCount * 3);

  let v = 0;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const r = INNER_SCALE * (Math.exp(K * t) - 1);
    // Deterministic per-ring angular jitter breaks up the spoke pattern a
    // regular radial grid would otherwise show in the specular highlights.
    const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const offset = (jitter - 0.5) * ((Math.PI * 2) / sectors) * 0.8;
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2 + offset;
      positions[v * 3 + 0] = Math.cos(a) * r;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(a) * r;
      v++;
    }
  }

  const indices = new Uint32Array(rings * sectors * 6);
  let n = 0;
  for (let i = 0; i < rings; i++) {
    const row = i * sectors;
    const next = (i + 1) * sectors;
    for (let j = 0; j < sectors; j++) {
      const j2 = (j + 1) % sectors;
      const a = row + j;
      const b = row + j2;
      const c = next + j;
      const d = next + j2;
      indices[n++] = a;
      indices[n++] = b;
      indices[n++] = c;
      indices[n++] = b;
      indices[n++] = d;
      indices[n++] = c;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), OUTER_RADIUS * 1.1);
  return geometry;
}

const VERTEX_SHADER = /* glsl */ `
precision highp float;

${GLSL_WAVES}

#include <shadowmap_pars_vertex>
${GLSL_LOG_DEPTH_PARS_VERTEX}

uniform vec2 uDetailOrigin;

varying vec3 vWorldPos;
varying float vLodRadius;
varying float vHeight;
/** Undisplaced parameter position: where the water parcel drawn here lives. */
varying highp vec2 vParam;
/** The same position with the presentation origin pre-wrapped for the noise. */
varying highp vec2 vDetail;
varying vec2 vGradient;
varying vec3 vInvJ;
varying float vJacobian;
varying float vCompression;

void main() {
  vec2 p = position.xz;
  // LOD is a distance from the disc centre; wave phase is a position in the
  // shared parameter space. They are different quantities and must not be
  // conflated.
  float lodRadius = length(p);

  vec2 param = p + uWaveOrigin;
  WaveResult w = evaluateWaves(param, lodRadius);

  vec3 local = vec3(p.x + w.displacement.x, w.displacement.y, p.y + w.displacement.z);
  vec4 world = modelMatrix * vec4(local, 1.0);

  vWorldPos = world.xyz;
  vLodRadius = lodRadius;
  vHeight = w.displacement.y;
  vParam = param;
  // p is local to the observer-centred disc, so it changes when a distant
  // camera moves the disc centre. param adds that centre back. Sampling the
  // detail/foam-breakup domain from p made the persistent foam stay put in
  // vParam while its grain slid underneath a moving camera: the wake marquee.
  vDetail = param + uDetailOrigin;
  vGradient = w.gradient;
  vInvJ = w.invJacobian;
  vJacobian = w.jacobian;
  vCompression = w.compression;

  // Shadow coordinates must follow the displaced surface, not the flat radial
  // disc.  The same world position is also written by the depth-only caster
  // below, so the receiver and caster agree down to the Gerstner evaluation.
  vec4 worldPosition = world;
  #include <shadowmap_vertex>

  gl_Position = projectionMatrix * viewMatrix * world;
  ${GLSL_LOG_DEPTH_VERTEX}
}
`;

/**
 * Depth-only twin of the production vertex path. Retained, but OFF by default.
 *
 * It was built so one wave crest could shade the next, and three's stock depth
 * material would have cast a flat disc under a rough sea. Both of those are
 * true. What is also true is that a shadow map is the wrong instrument for this
 * surface, and turning it on produced a worse picture than having no wave
 * shadows at all:
 *
 *  - **The map cannot resolve what it is shadowing.** The caster is the
 *    vertex-displaced Gerstner swell. The receiver shades with that PLUS the
 *    per-pixel residual gradient PLUS the procedural detail gradient. The
 *    ripples that make the glitter are simply not in the map, so the map can
 *    never shadow them; the statistical Smith term in `ggxSpecular` is what
 *    covers that scale, and it already does.
 *  - **The bias cannot be made to work at a low sun.** A 13.7 mm texel on a sea
 *    lit from 2 degrees spans 38 cm of depth; the offset available was 3.6 cm.
 *    The whole box filled with acne. It is sufficient only above roughly 21
 *    degrees of elevation, on a flat sea — and above 21 degrees crests barely
 *    shadow anything, so the term is only trustworthy where it is not needed.
 *  - **The box is the wrong shape for the job.** At 2 degrees a 3 m crest casts
 *    an 86 m shadow, but the box is 28 m wide. Shadows cast from anything
 *    outside that band are missing no matter what the bias is set to.
 *
 * Sea-on-sea occlusion is a real effect and is still wanted. It belongs to an
 * analytic horizon march over the wave field, which is unbounded, needs no
 * depth bias, and agrees with the surface the pixel actually shades.
 */
/**
 * The caster carries the log-depth chunks because the receiver does.
 *
 * `logarithmicDepthBuffer: true` defines `USE_LOGARITHMIC_DEPTH_BUFFER` on
 * every program in the renderer, but only materials whose GLSL includes the
 * chunks act on it — the trap TERR-112 documents. This material was written
 * before that wiring and was the one custom material left out of it, so under
 * `?depth=log` it encoded depth by one rule while every other caster in the
 * scene encoded it by another.
 *
 * It is INERT today, three times over, and is wired anyway because the next
 * person to arm the sea as a caster should not have to rediscover this:
 *
 *  * The define does not exist in production. Absent `?depth=log` all four
 *    snippets compile to nothing and the program is unchanged.
 *  * `mesh.castShadow` is false by default (see `setSunShadowCasting`), so the
 *    material does not render at all in the ordinary frame.
 *  * The Sun's shadow camera is ORTHOGRAPHIC, and `logdepthbuf_fragment`
 *    writes plain `gl_FragCoord.z` for a non-perspective projection — the same
 *    value the fixed-function pipeline writes. It would only diverge in a
 *    PERSPECTIVE shadow camera, i.e. the lantern's cube faces, which the sea
 *    is excluded from by layer.
 */
const SHADOW_VERTEX_SHADER = /* glsl */ `
precision highp float;

${GLSL_WAVES}

${GLSL_LOG_DEPTH_PARS_VERTEX}

void main() {
  vec2 p = position.xz;
  float lodRadius = length(p);
  vec2 param = p + uWaveOrigin;
  WaveResult w = evaluateWaves(param, lodRadius);
  vec3 local = vec3(
    p.x + w.displacement.x,
    w.displacement.y,
    p.y + w.displacement.z
  );
  gl_Position = projectionMatrix * modelViewMatrix * vec4(local, 1.0);
  ${GLSL_LOG_DEPTH_VERTEX}
}
`;

const SHADOW_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_LOG_DEPTH_PARS_FRAGMENT}

void main() {
  ${GLSL_LOG_DEPTH_FRAGMENT}
  // r185 shadow maps are real depth textures; this colour is never sampled.
  gl_FragColor = vec4(1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_COMMON}
${GLSL_CATS_PAW}
${GLSL_SKY}
${GLSL_SKY_PROBE}
${GLSL_WAVES}

// Three's PCF shadow chunk rotates its taps with PI2. ShaderMaterial does not
// include the common chunk automatically, so provide the one macro it needs.
#ifndef PI2
#define PI2 6.283185307179586
#endif
#include <shadowmap_pars_fragment>
${GLSL_LOG_DEPTH_PARS_FRAGMENT}

uniform bool receiveShadow;

/** Irradiance reflectance of the water column, Rw = bb/(a+bb). */
uniform vec3  uWaterRw;
uniform vec3  uWaterAmbient;
/** (bodySkyGain, bodySunGain) from the ocean optics profile. */
uniform vec2  uBodyGains;
/** (foamSkyGain, foamSunGain) from the ocean optics profile. */
uniform vec2  uFoamGains;
uniform float uRoughnessScale;
uniform float uReflectLobeRatio;
uniform float uGrazingRolloff;
/**
 * Wave-scale sky occlusion: (1/rmsHeight, sin of the horizon a trough sees,
 * strength). The sea has never occluded itself — only the hull took a bite
 * out of the sky — which left every parcel of water, crest and trough alike,
 * lit by the identical hemisphere. See the openness block in main().
 */
uniform vec3  uWaveOcclusion;
/**
 * (sharpness, strength) of the below-horizon reflection block. See where
 * belowHorizon is computed: the sky-sampling fold used to hand every downward
 * reflected ray the bright horizon band.
 */
uniform vec2  uHorizonBlock;
/** Lognormal sparkle width. 0 is the plain GGX mean, i.e. every prior build. */
uniform float uSparkleStrength;
/**
 * Straight multiplier on the mirrored sky. 1 is Fresnel's own answer.
 *
 * An ART control, and honest about it: below 1 the water reflects less than
 * physics says it should. The physical lever for the same complaint is
 * grazingRolloff, which cuts the grazing Fresnel that makes the distance a
 * mirror in the first place — but it bottoms out at f90 = 0.3, so the far
 * field still takes a third of the sky however far it is pushed. This is the
 * one that goes all the way down.
 */
uniform float uReflectionGain;
/**
 * (exponent, pivot) of the water's own contrast curve — the spread between
 * its darkest and lightest blues.
 *
 * Applied to the finished water colour BEFORE glitter and foam are added, so
 * it stretches the sea's own tones without touching a sparkle or a whitecap.
 * The scale is a power of LUMINANCE applied as one common factor to all three
 * channels, so like the display transform it moves brightness only and
 * carries hue and saturation through untouched: no amount of contrast can
 * turn the water a different colour. 1 is a no-op exactly.
 */
uniform vec2  uWaterContrast;
/**
 * How far the surface's own roughness lifts the incidence cosine used by the
 * grazing Fresnel. 0 restores plain Schlick on the macro normal, i.e. the
 * far-field sky mirror. See where NdVRough is computed.
 */
uniform float uGrazingSlopeLift;

/** Measured RMS of the detail noise VALUE field. See measureDetailNoiseMoments. */
const float DETAIL_VALUE_SIGMA = 0.204;
uniform vec2  uWindDir;
uniform float uWindStrength;
uniform float uDetailAmp;
uniform float uDetailFreq;
uniform float uDetailWrap;
/**
 * Per-octave amplitude trim on the detail stack, all 1 in the shipping look.
 * The mid-band shift control reshapes the drawn spectrum through these while
 * the CPU renormalises them so the stack's total slope variance is invariant —
 * energy moves between octaves, never in or out of the budget.
 */
uniform float uDetailOctaveGain[6];
/**
 * Crest skew of the detail field, as (N, N·s): each drawn detail gradient is
 * weighted by max(N + N·s·value, 0). Positive s concentrates slope on the
 * high side of the noise — peaked crests, flattened troughs, the Stokes
 * asymmetry applied statistically. N is the measured normalisation that keeps
 * the weighted field's expected slope variance at exactly 1, so the variance
 * bookkeeping below needs no skew term. (1, 0) is the shipping shader.
 */
uniform vec2  uDetailSkew;
/** Decode range of the value channel in uDetailFaithfulMap's B. */
uniform float uDetailValueRange;
/** Sub-pixel screen offset used only to supersample the normal-detail field. */
uniform vec2  uTemporalDetailJitter;
uniform sampler2D uDetailGradientMap;
uniform vec2 uDetailGradientRange;
uniform sampler2D uDetailFaithfulMap;
uniform float uDetailFaithfulRange;
/**
 * Per-octave scroll offset, in each octave's own noise domain, wrapped by the
 * lattice period on the CPU.
 *
 * The shipping baseline tries to avoid a rigid decal by giving every octave a
 * different heading and phase speed. Each octave is nevertheless still a
 * frozen contour field under translation, and LOD can retire the finer fields
 * until one trackable downwind pattern remains. The laboratory modes below
 * expose balanced counterflow and true temporal evolution for direct visual
 * comparison. All offsets are CPU-computed and wrapped exactly, so none of the
 * modes inherits the old period-mismatch pop.
 */
uniform vec2  uDetailScroll[6];
/** 0 directional, 1 balanced counterflow, 2 evolving in place. */
uniform int   uDetailMotionMode;
/** Wrapped coordinate along the evolving field's independent time axis. */
uniform float uDetailMorphTime;
uniform float uHazeDistance;
/**
 * Airborne salt loading. See the block that consumes these near the end of the
 * fragment; the short version is that uSaltDensity is the only one the frame
 * moves, and it is the sea state's spray intensity gated by wind and gusts.
 */
uniform float uSaltDensity;
/** Height above the mean surface at which the mist thins to 1/e, metres. */
uniform float uSaltScaleHeight;
/** How far upwind the air at a pixel was loaded, metres. */
uniform float uSaltFetch;
/** Well-mixed background, and the local enhancement per unit active foam. */
uniform float uSaltFloor;
uniform float uSaltGain;
/** In-scatter weights: sky in the view direction, and the sun's forward lobe. */
uniform float uSaltAmbient;
uniform float uSaltSunGain;
uniform float uCrestScale;
uniform float uMoonSpecular;
/**
 * Cloud-slab transmittance toward the sun and moon, from the CPU's ported
 * cloud field. Gates every direct-light term — glitter, body sun, crest
 * scatter, foam — because an overcast sky must not leave a bright sun lane
 * on the sea while the disc itself is hidden.
 */
uniform float uSunCloudTrans;
uniform float uMoonCloudTrans;
/**
 * WX3 presentation blend. Zero is the exact historical scalar path; one uses
 * one broad slab sample near the observer and returns to the scalar before the
 * far horizon. Weather-neutral and diagnostic runtimes publish zero.
 */
uniform float uSunPoolStrength;
/**
 * Lantern flame in world space, and its 0..1 emission level.
 *
 * Emission, deliberately, and not the three.js PointLight's intensity: that
 * number is in the deck renderer's units and exists to light planks and cloth.
 * Feeding it here tied the sea's response to the deck's, so trimming one
 * silently retuned the other. The water's own scale is uLampGain, below.
 */
uniform vec3  uLampWorld;
uniform float uLampEmission;
/** Lamp radiance on the water at one metre, in this shader's radiance units. */
uniform float uLampGain;
/** Independent live A/B switches for the two geometry shadow maps. */
uniform float uSunShadowEnabled;
uniform float uLampShadowEnabled;
/**
 * The vessel's hull axis at the waterline, in world space, and its effective
 * radius. Drives sky occlusion only — see vesselSkyVisibility.
 */
uniform vec3  uVesselAoA;
uniform vec3  uVesselAoB;
uniform float uVesselAoRadius;
/** Peak fraction of the sky the hull removes alongside her. 0 disables. */
uniform float uVesselAoStrength;
/** How much sky the tarred topsides replace where the mirror ray meets them. */
uniform float uVesselMirrorOcclusion;
/** A/B: 1 tests the mirror direction, 0 reuses the old hemisphere average. */
uniform float uVesselDirectionalMirror;
/** A/B: 1 restores the wide skirt — unsquared falloff, no lobe coverage. */
uniform float uVesselOcclusionWide;
/** Metres of world per shadow-map texel — converts a penumbra into taps. */
uniform float uSunShadowTexelWorld;
/** Live A/B: variable penumbra, or three's fixed-width five-tap filter. */
uniform float uSunSoftShadow;
/** Cox-Munk slope variance the geometry does NOT already resolve. */
uniform float uUnresolvedSlopeVariance;
/** Equirectangular, linear-HDR gas-sky radiance for the current frame. */
uniform sampler2D uSkyRadianceLut;

#ifdef OCEAN_INTERIOR_VOLUME_CUTOUT
/** Displaced ocean world position -> active vessel-local coordinates. */
uniform mat4 uInteriorWorldToLocal;
/** Sampled swept half-breadth: x is placed z, y is height. */
uniform sampler2D uInteriorHalfBreadthMap;
/** (zMin, zMax, yMin, yMax), ballast to weather deck, in local metres. */
uniform vec4 uInteriorCutoutBounds;
uniform vec2 uInteriorCutoutGridSize;
/** Keeps the cut safely inside the moulded shell and its planking. */
uniform float uInteriorCutoutMargin;

float interiorHalfBreadth(vec2 zy) {
  vec2 uv = vec2(
    (zy.x - uInteriorCutoutBounds.x) /
      (uInteriorCutoutBounds.y - uInteriorCutoutBounds.x),
    (zy.y - uInteriorCutoutBounds.z) /
      (uInteriorCutoutBounds.w - uInteriorCutoutBounds.z)
  );
  vec2 cell = min(
    floor(clamp(uv, 0.0, 1.0) * uInteriorCutoutGridSize),
    uInteriorCutoutGridSize - 1.0
  );
  vec2 invSize = 1.0 / uInteriorCutoutGridSize;
  return texture2D(
    uInteriorHalfBreadthMap,
    (cell + 0.5) * invSize
  ).r;
}
#endif

${GLSL_SKY_RADIANCE_LUT_UV}

vec3 oceanSkyRadiance(vec3 direction) {
#ifdef SKY_RADIANCE_LUT
  return texture2D(uSkyRadianceLut, skyRadianceLutUv(direction)).rgb;
#else
  return skyRadiance(direction);
#endif
}

vec3 oceanSkyWithClouds(vec3 direction) {
  vec3 base = oceanSkyRadiance(direction);
  vec4 cl = cloudLayer(direction, base);
  return base * (1.0 - cl.a) + cl.rgb;
}

// --- whitewater -------------------------------------------------------------
uniform sampler2D uFoamNear;
uniform sampler2D uFoamFar;
uniform sampler2D uFoamHull;
/**
 * Per-level window centres. Each level scrolls its contents by whole texels
 * and carries the sub-texel remainder here, so the two levels' origins differ
 * by up to half of their own texel — they must be subtracted per level, not
 * shared.
 */
uniform vec2  uFoamNearOrigin;
uniform vec2  uFoamFarOrigin;
uniform vec2  uFoamHullOrigin;
uniform float uFoamNearExtent;
uniform float uFoamFarExtent;
uniform float uFoamHullExtent;
uniform float uFoamStrength;
uniform float uFoamBreakup;
uniform float uFoamCoverageGain;
/**
 * The two breakup frames, each HELD CONSTANT. .xy is the unit direction the
 * grain stretches along, .z its anisotropy.
 *
 * A frame rotates q, and q is measured from the noise lattice origin up to
 * a 614 m wrap away, so any continuous motion of a frame slides the whole
 * pattern by |x| * dtheta through foam that is standing still. These therefore
 * never move: the CPU latch releases one frame to another and the shader
 * cross-fades the two evaluated PATTERNS. See scene/foamStreakFrame.ts.
 */
uniform vec3  uFoamWindFrameA;
uniform vec3  uFoamWindFrameB;
uniform float uFoamWindFrameBlend;
/**
 * Foam-field reconstruction A/B. See scene/foamLookup.ts for why the sample
 * displacement is the wrong cure for a grid artifact and the warp is the right
 * one. Jitter 0.9 with smoothing 0 is the exact legacy lookup.
 */
uniform float uFoamLookupJitter;
uniform float uFoamLookupSmoothing;
uniform float uDebugView;
/** Independent WK1 A/B gains. Zero is an exact presentation off-path. */
uniform float uWakeBubbleHaze;
uniform float uWakeWhitecapSuppression;
uniform float uWakeTrailFoamFloor;
/**
 * The track frame: where B is strong the foam breakup stretches along the
 * hull's course instead of along the wind, so the trail's grain runs down the
 * track. Latched exactly like the wind frame above, and for the same reason —
 * this one was the faster of the two marquees, because it was published from
 * the instantaneous through-water velocity, which wanders with every yaw and
 * with the orbital water motion under her.
 *
 * An already-laid trail still carries only the currently latched course's
 * grain — the accepted lie the live uniform also told, now told stably. A grain
 * direction recorded per texel with the foam is the honest fix.
 */
uniform vec3  uFoamWakeFrameA;
uniform vec3  uFoamWakeFrameB;
uniform float uFoamWakeFrameBlend;
/** WK2 normal-only bow mound. Strength zero is an exact off-path. */
uniform vec2  uBowMoundCentre;
uniform vec2  uBowMoundForward;
uniform float uBowMoundNormalStrength;
uniform vec2  uBowMoundRadii;
/** WK-R4 ship wave pattern. Strength zero is an exact off-path. */
uniform vec2  uShipWakeOrigin;
uniform vec2  uShipWakeDir;
uniform vec2  uShipWakeHullForward;
uniform float uShipWakeHullLength;
uniform float uShipWakeHalfBeam;
uniform vec2  uShipWakeBowShoulderCentre;
uniform float uShipWakeBowShoulderHalfWidth;
uniform float uShipWakeBowCrownHalfWidth;
uniform float uShipWakeLambda;
uniform float uShipWakeStrength;
/** Far-field Kelvin amplitude. Independent of the near field's; zero is off. */
uniform float uShipWakeKelvinStrength;
uniform float uShipWakeLength;
/** Live-crest transition band, in indicator units: (T - k0 s, T + k1 s). */
uniform vec2  uBreakBand;
uniform float uWhitecapCoverage;
uniform float uSprayHint;

/** 1.0 in production. The buoyancy harness turns the sea to glass to inspect
 *  what is actually under it; nothing else ever changes it. */
uniform float uOpacity;

/**
 * 1.0 when this draw ends at the 8-bit canvas, 0.0 when it ends in a
 * linear-HDR buffer that something else will present.
 *
 * The dither below is written AFTER colorspace_fragment, which is the only
 * correct place for it and also the one place three's render-target rule does
 * not reach: aimed offscreen, three compiles tone mapping and the sRGB encode
 * out of this shader but the dither survives and lands on a raw radiance. At
 * night's ~5x exposure that is roughly 26 sRGB codes of static instead of one.
 * So the presenter clears this and applies the dither itself, at the real point
 * of quantisation. See render/ScenePresentPass.ts.
 */
uniform float uQuantiseDither;

varying vec3 vWorldPos;
varying float vLodRadius;
varying float vHeight;
varying highp vec2 vParam;
varying highp vec2 vDetail;
varying vec2 vGradient;
varying vec3 vInvJ;
varying float vJacobian;
varying float vCompression;

/** Roughly 2100 K, matching Lamp.ts's LAMP_COLOR. */
const vec3 LAMP_TINT = vec3(1.0, 0.55, 0.22);
/**
 * Hard reach, metres — the same number the lamp's PointLight uses on the deck.
 * The window below drives the radiance to exactly zero there, so "the refuge is
 * the raft, not the sea" is enforced by construction rather than by tuning.
 */
const float LAMP_RANGE = 7.5;
/**
 * Effective emitter radius, metres: the glass globe, not the flame inside it —
 * the whole globe lights up, and it is the globe the water reflects.
 */
const float LAMP_RADIUS = 0.055;
/**
 * Near-surface scatter, as a reflectance added alongside the water column's own
 * Rw: the flame lights the bubble-laden top centimetre and the fine spray haze
 * standing over it, and near a raft in a seaway that film is not clean water.
 * It is far whiter than Rw's cobalt, which is why it is added rather than
 * folded in.
 *
 * Kept SMALL, and the reason is worth stating because getting it wrong is how
 * the coloured carpet came back. This is a Lambert term, and Lambert on water
 * near its peak is inherently low-contrast: a cosine barely moves for the few
 * degrees a wave face swings, so however much texture the normal carries, a
 * diffuse term renders it as a smooth wash. At 0.05 it was ten times the
 * physical body term, pure lamp tint, and flattest of all directly under the
 * flame where dot(N, L) pins to 1 — an orange disc with no structure in it.
 * Structure on water is specular; the glitter lobe above is what carries it,
 * and this only keeps the water between the glints from being pure black.
 */
const float LAMP_SCATTER = 0.008;

/**
 * Fraction of the shadow map's half-width over which the term returns to lit.
 *
 * The sea is unbounded and the map is not, so there is always a border. The
 * only question is whether the border is a step or a ramp.
 */
const float SUN_SHADOW_EDGE_FADE = 0.12;

/**
 * Angular RADIUS of the solar disc, radians. Half of 0.53 degrees.
 *
 * This is the whole reason a shadow has a soft edge at all: the sun is not a
 * point, so the boundary between "sees all of it" and "sees none of it" has a
 * width, and that width grows with how far the blocker is from what it lands
 * on. A hull at the waterline throws a near-crisp edge; her masthead throws one
 * an order of magnitude softer. Rendering both at the same crispness is what
 * makes a cast shadow read as a decal.
 */
const float SUN_ANGULAR_RADIUS = 0.00465;

const float SUN_POOL_FADE_START_M = 1800.0;
const float SUN_POOL_FADE_END_M = 3200.0;

/**
 * Direct-sun transmission above this water point.
 *
 * This is ONE density sample halfway along the cloud slab's bounded traverse,
 * not a volume march. It reads the same coverage field, drift offset and
 * evolution axis as the drawn cloud deck. The exact bypasses come first so
 * neutral weather, disabled clouds and the far horizon retain both their
 * arithmetic and avoid the field-sample cost.
 */
float sunPoolCloudTransmittance(vec2 waterFromObserver) {
  if (
    uSunPoolStrength <= 0.0 ||
    uCloudOpacity <= 0.001 ||
    uSunDir.y < 0.004 ||
    vLodRadius >= SUN_POOL_FADE_END_M
  ) return uSunCloudTrans;

  float invY = 1.0 / max(uSunDir.y, 0.016);
  float pathM = min(CLOUD_THICK * invY, CLOUD_REACH);
  float sampleT = CLOUD_BASE * invY + pathM * 0.5;
  vec2 cloudXZ = waterFromObserver
    + uSunDir.xz * sampleT
    + uCloudOffset;
  float sampleY = uSunDir.y * sampleT - CLOUD_BASE;
  float height = sampleY * (1.0 / CLOUD_THICK);
  float evo = uCloudEvolve * CLOUD_EVO_SCALE;
  float threshold = cloudCoverAt(cloudXZ * CLOUD_SCALE, evo);
  vec3 cloudPoint = vec3(cloudXZ.x, sampleY, cloudXZ.y);
  float density = cloudDensity(cloudPoint, height, threshold, 0.0);
  float alpha = 1.0 - exp(-density * CLOUD_EXTINCT * pathM);
  float localTrans = 1.0 - clamp(alpha * uCloudOpacity, 0.0, 1.0);
  float spatialWeight = uSunPoolStrength * (
    1.0 - smoothstep(SUN_POOL_FADE_START_M, SUN_POOL_FADE_END_M, vLodRadius)
  );
  return mix(uSunCloudTrans, localTrans, spatialWeight);
}

/** Taps in the variable-width filter. Five (three's default) is not enough. */
#define SUN_SOFT_SHADOW_TAPS 12

/**
 * Penumbra half-width for this pixel, in shadow-map texels.
 *
 * A blocker search is the textbook way to get this, and it is unavailable: the
 * map is bound as a sampler2DShadow, which returns a comparison result rather
 * than a depth, so there is nothing to search. But this scene does not need one.
 * The receiver is a plane and the blocker is one compact vessel, and for that
 * pair the blocker's height is not unknown — it is implied by how far downwind
 * the pixel sits. Shadow cast by something h metres up lands h/tan(elevation)
 * away, so reading it backwards gives h from the distance, exactly, with no
 * texture reads at all.
 *
 * The approximation this makes is that the sea is flat. A crest riding up into
 * the shadow is treated as though it were at mean level, which slightly
 * overstates its penumbra. That error is a few centimetres on a metre-scale
 * quantity and it buys a blocker search for four instructions.
 */
float sunPenumbraTexels() {
  vec3 axis = uVesselAoB - uVesselAoA;
  float t = clamp(
    dot(vWorldPos - uVesselAoA, axis) / max(dot(axis, axis), 1e-4),
    0.0,
    1.0
  );
  vec2 offset = vWorldPos.xz - (uVesselAoA + axis * t).xz;
  vec2 sunFlat = normalize(uSunDir.xz + vec2(1e-6));
  // Only the anti-sunward component: the lit side has no blocker behind it.
  float alongLight = max(dot(offset, -sunFlat), 0.0);
  // cos(elevation) is the horizontal length of a unit sun direction.
  float slant = alongLight / max(length(uSunDir.xz), 1e-3);
  float widthMetres = slant * SUN_ANGULAR_RADIUS;
  // Floored at half a texel so the waterline contact stays crisp without
  // aliasing, and capped so twelve taps still cover the disc they sample.
  return clamp(widthMetres / max(uSunShadowTexelWorld, 1e-5), 0.5, 14.0);
}

/** Variable-width PCF. Three's own is a fixed five-tap radius. */
float softSunShadow(vec4 coord4, float bias, float radiusTexels, vec2 mapSize) {
#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  vec3 coord = coord4.xyz / coord4.w;
  coord.z += bias;
  if (coord.z > 1.0) return 1.0;
  float radius = radiusTexels / mapSize.x;
  float phi = interleavedGradientNoise(gl_FragCoord.xy) * PI2;
  float sum = 0.0;
  for (int i = 0; i < SUN_SOFT_SHADOW_TAPS; i++) {
    vec2 tap = vogelDiskSample(i, SUN_SOFT_SHADOW_TAPS, phi) * radius;
    sum += texture(directionalShadowMap[0], vec3(coord.xy + tap, coord.z));
  }
  return sum / float(SUN_SOFT_SHADOW_TAPS);
#else
  return 1.0;
#endif
}

/**
 * The first directional shadow is the Sun; it contains the vessel's depth.
 *
 * Three's getShadow returns a hard 1.0 the instant the coordinate leaves the
 * map, with no transition. That matters far more here than in a normal scene:
 * the receiver is a plane stretching to the horizon, so the frustum wall is a
 * plane crossing it, and a plane crossing a plane is a perfectly straight line
 * on screen. Worse, the box's long axis is the light, so those lines converge
 * on the sun and appear exactly where the eye is already looking — down the
 * glitter path. A twenty-metre box drew a dead-straight edge across a kilometre
 * of water because the answer changed by a whole shadow rather than by nothing.
 *
 * Fading to lit over the last band of the map is what every cascaded
 * implementation does, and it is the honest answer rather than a cosmetic one:
 * outside the map we do not know whether the surface is occluded, and "lit" is
 * the only value that can be blended towards without inventing an occluder.
 */
float sunSurfaceVisibility() {
  // Tri-state, because "how much of the direct sun does this shadow actually
  // remove?" cannot be answered by dimming a light: uSunPower also drives the
  // sky's inscatter, so turning it down darkens the reflection the shadow is
  // supposed to leave alone, and the answer comes out flattering. -1 forces
  // full occlusion through exactly the terms this function gates, which is the
  // only honest reference frame for that measurement.
  if (uSunShadowEnabled < -0.5) return 0.0;
  if (uSunShadowEnabled < 0.5) return 1.0;
  float visibility = 1.0;
#if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
  if (!receiveShadow) return 1.0;
  DirectionalLightShadow sunShadow = directionalLightShadows[0];
  // Distance to the nearest wall, in map units, on all three axes at once —
  // the depth axis included, so the far plane cannot draw a line either.
  vec3 coord = vDirectionalShadowCoord[0].xyz / vDirectionalShadowCoord[0].w;
  vec3 toWall = min(coord, 1.0 - coord);
  float fade = smoothstep(
    0.0,
    SUN_SHADOW_EDGE_FADE,
    min(min(toWall.x, toWall.y), toWall.z)
  );
  // Outside, or in the outermost sliver: skip the sixteen PCF taps entirely.
  // On a wide ocean view that is most of the screen.
  if (fade <= 0.0) return 1.0;
  visibility = uSunSoftShadow > 0.5
    ? softSunShadow(
        vDirectionalShadowCoord[0],
        sunShadow.shadowBias,
        sunPenumbraTexels(),
        sunShadow.shadowMapSize
      )
    : getShadow(
        directionalShadowMap[0],
        sunShadow.shadowMapSize,
        sunShadow.shadowIntensity,
        sunShadow.shadowBias,
        sunShadow.shadowRadius,
        vDirectionalShadowCoord[0]
      );
  visibility = mix(1.0, visibility, fade);
#endif
  return visibility;
}

/**
 * Fraction of the SKY this patch of water can still see, with the hull in the
 * way. Ambient occlusion, and deliberately not a second shadow.
 *
 * The sun is one direction, so "blocked?" is a yes/no and a depth map answers
 * it — that is sunSurfaceVisibility above. The sky is a source spread over the
 * whole hemisphere, and the honest question is what FRACTION of it a hull two
 * metres away covers. Nothing in the direct-light path can answer that, and it
 * is not a small correction here: measured on the sunset glitter path, only 39
 * per cent of the water's brightness is direct sun. The rest is reflected sky,
 * and until now the water touching her planking reflected a whole unobstructed
 * one, which is most of why she reads as sitting ON the sea rather than in it.
 *
 * The hull is modelled as a capsule about the waterline centreline, and the
 * occlusion as its solid angle falling off with the inverse square of distance
 * — bounded at the axis, exact in the far field, and about eight instructions.
 * This is an approximation of a real quantity, unlike the circular raftAO mask
 * it replaces: that one darkened the DIRECT sun by proximity alone, so the sea
 * dimmed on the sunward side of the hull where it should have been brightest.
 * Occluding the sky by a hull's silhouette has no such contradiction in it,
 * and the alternative is a screen-space pass costing orders of magnitude more.
 *
 * Applied to the sky-driven terms only: reflection, the water body's ambient
 * share, and the foam's. NOT the sun, which owns a real depth map and would be
 * double-counted. NOT the lantern, which hangs on the vessel doing the
 * occluding and must not be dimmed by it.
 */
float vesselSkyVisibility() {
  if (uVesselAoStrength <= 0.0) return 1.0;
  vec3 axis = uVesselAoB - uVesselAoA;
  float t = clamp(
    dot(vWorldPos - uVesselAoA, axis) / max(dot(axis, axis), 1e-4),
    0.0,
    1.0
  );
  vec3 offset = vWorldPos - (uVesselAoA + axis * t);
  float r2 = uVesselAoRadius * uVesselAoRadius;
  // Squared, so the tail is 1/d^4 rather than 1/d^2.
  //
  // The solid angle of a sphere really does fall off as 1/d^2, and that is what
  // this was. The trouble is what 1/d^2 looks like: still a tenth of full
  // strength three hull-widths out, which reads as a wide grey disc following
  // her about rather than as contact. Squaring keeps the peak where it belongs
  // and pulls the skirt in to roughly a beam's width — occlusion you notice
  // under her and nowhere else. It is a deliberate departure from the analytic
  // falloff, made because the analytic one is also standing in for interreflection
  // that is not modelled, and over-reaching was the more visible error.
  float falloff = r2 / (r2 + dot(offset, offset));
  if (uVesselOcclusionWide < 0.5) falloff *= falloff;
  return 1.0 - uVesselAoStrength * falloff;
}

/**
 * Closest approach between a ray and the hull's axis segment.
 * Returns (distance at closest approach, how far along the ray that happened).
 */
vec2 rayToAxisApproach(vec3 origin, vec3 dir, vec3 a, vec3 b) {
  vec3 v = b - a;
  vec3 w = origin - a;
  float bb = dot(dir, v);
  float cc = max(dot(v, v), 1e-4);
  float dd = dot(dir, w);
  float ee = dot(v, w);
  float det = cc - bb * bb;
  float alongRay;
  float alongAxis;
  if (det < 1e-5) {
    alongRay = 0.0;
    alongAxis = clamp(ee / cc, 0.0, 1.0);
  } else {
    alongRay = max((bb * ee - cc * dd) / det, 0.0);
    alongAxis = clamp((ee - bb * dd) / det, 0.0, 1.0);
  }
  return vec2(
    length((origin + dir * alongRay) - (a + v * alongAxis)),
    alongRay
  );
}

/**
 * Occlusion of the MIRROR direction by the hull. Not the same question as AO.
 *
 * vesselSkyVisibility above answers "what fraction of the hemisphere is gone",
 * which is exactly right for a diffuse integral and exactly wrong for a mirror.
 * The reflection term samples ONE direction, and whether the hull stands in
 * that direction has nothing to do with how much of the sky it covers on
 * average. Applying the average to both was a real error, and it hid at noon:
 * looking down, Fresnel is about 0.03 and the body dominates, so nobody sees
 * it. At dusk you look across, Fresnel climbs, the reflection becomes almost
 * the whole pixel, and a hemisphere average smears a grey wash over water whose
 * mirror ray is pointed at open sky.
 *
 * Asking the honest question is also the better picture: what comes back is her
 * hull genuinely reflected in the water alongside — tight, correctly placed,
 * and moving with the eye the way a reflection should.
 *
 * The strength is separate from, and higher than, the AO's. This is not a
 * fraction of a hemisphere; it is "you are looking at tarred topsides instead
 * of sky", and tar returns very little.
 */
float vesselMirrorVisibility(vec3 mirrorDir, float lobeAlpha) {
  if (uVesselMirrorOcclusion <= 0.0) return 1.0;
  vec2 approach = rayToAxisApproach(vWorldPos, mirrorDir, uVesselAoA, uVesselAoB);
  // Soft-edged: a hull is not a capsule, and the margin covers the difference
  // between this stand-in and her actual topsides.
  float hit = 1.0 - smoothstep(
    uVesselAoRadius * 0.75,
    uVesselAoRadius * 1.9,
    approach.x
  );
  // How much of the reflection LOBE she actually fills.
  //
  // A bare ray test says a hull fifty metres downrange occludes as completely
  // as one alongside, because a ray either meets the capsule or does not. That
  // is true of a mirror and false of water: the sea is rough, so the reflection
  // is a lobe of finite width, and a hull far enough away covers only a sliver
  // of it. Without this the term paints a halo out to the horizon — which is
  // exactly what it did.
  //
  // Her angular radius is radius/range; the lobe's is roughly its GGX alpha.
  // The ratio is the fraction of reflected directions she stands in, which
  // falls off as 1/range and takes the halo in with it.
  float angularRadius = uVesselAoRadius / max(approach.y, 0.5);
  float coverage = uVesselOcclusionWide > 0.5
    ? 1.0
    : clamp(angularRadius / max(lobeAlpha, 0.05), 0.0, 1.0);
  return 1.0 - uVesselMirrorOcclusion * hit * coverage;
}

/** The first shadow-casting point light is the vessel's lantern. */
float lampSurfaceVisibility() {
  if (uLampShadowEnabled < 0.5) return 1.0;
  float visibility = 1.0;
#if defined(USE_SHADOWMAP) && NUM_POINT_LIGHT_SHADOWS > 0
  PointLightShadow lampShadow = pointLightShadows[0];
  visibility = receiveShadow
    ? getPointShadow(
        pointShadowMap[0],
        lampShadow.shadowMapSize,
        lampShadow.shadowIntensity,
        lampShadow.shadowBias,
        lampShadow.shadowRadius,
        vPointShadowCoord[0],
        lampShadow.shadowCameraNear,
        lampShadow.shadowCameraFar
      )
    : 1.0;
#endif
  return visibility;
}

#ifndef DETAIL_OCTAVES
#define DETAIL_OCTAVES 3
#endif
#ifndef FOAM_BREAKUP_OCTAVES
#define FOAM_BREAKUP_OCTAVES 3
#endif

// Gradient noise with a periodic hash domain, so the scroll offsets can be
// wrapped exactly and the surface never pops during long drift.
vec3 noisedPeriodic(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec2 i00 = mod(i, NOISE_PERIOD);
  vec2 i10 = mod(i + vec2(1.0, 0.0), NOISE_PERIOD);
  vec2 i01 = mod(i + vec2(0.0, 1.0), NOISE_PERIOD);
  vec2 i11 = mod(i + vec2(1.0, 1.0), NOISE_PERIOD);

  vec2 ga = hash22(i00);
  vec2 gb = hash22(i10);
  vec2 gc = hash22(i01);
  vec2 gd = hash22(i11);

  float va = dot(ga, f - vec2(0.0, 0.0));
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float val = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * (va - vb - vc + vd);
  vec2 d = ga
    + u.x * (gb - ga)
    + u.y * (gc - ga)
    + u.x * u.y * (ga - gb - gc + gd)
    + du * (vec2(u.y, u.x) * (va - vb - vc + vd) + vec2(vb, vc) - va);

  return vec3(val, d);
}

/**
 * Periodic 3D gradient noise, returning value and the two SPATIAL derivatives.
 *
 * Time is the third coordinate, not an offset in the first two. Advancing it
 * therefore changes the contour field without transporting that field across
 * the water. Eight lattice corners make this roughly twice the cost of the 2D
 * path, which is why it is an explicit laboratory mode rather than silently
 * replacing the shipping baseline.
 */
vec3 noisedPeriodic3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec3 i000 = mod(i + vec3(0.0, 0.0, 0.0), NOISE_PERIOD);
  vec3 i100 = mod(i + vec3(1.0, 0.0, 0.0), NOISE_PERIOD);
  vec3 i010 = mod(i + vec3(0.0, 1.0, 0.0), NOISE_PERIOD);
  vec3 i110 = mod(i + vec3(1.0, 1.0, 0.0), NOISE_PERIOD);
  vec3 i001 = mod(i + vec3(0.0, 0.0, 1.0), NOISE_PERIOD);
  vec3 i101 = mod(i + vec3(1.0, 0.0, 1.0), NOISE_PERIOD);
  vec3 i011 = mod(i + vec3(0.0, 1.0, 1.0), NOISE_PERIOD);
  vec3 i111 = mod(i + vec3(1.0, 1.0, 1.0), NOISE_PERIOD);

  vec3 g000 = -1.0 + 2.0 * hash33(i000);
  vec3 g100 = -1.0 + 2.0 * hash33(i100);
  vec3 g010 = -1.0 + 2.0 * hash33(i010);
  vec3 g110 = -1.0 + 2.0 * hash33(i110);
  vec3 g001 = -1.0 + 2.0 * hash33(i001);
  vec3 g101 = -1.0 + 2.0 * hash33(i101);
  vec3 g011 = -1.0 + 2.0 * hash33(i011);
  vec3 g111 = -1.0 + 2.0 * hash33(i111);

  float v000 = dot(g000, f - vec3(0.0, 0.0, 0.0));
  float v100 = dot(g100, f - vec3(1.0, 0.0, 0.0));
  float v010 = dot(g010, f - vec3(0.0, 1.0, 0.0));
  float v110 = dot(g110, f - vec3(1.0, 1.0, 0.0));
  float v001 = dot(g001, f - vec3(0.0, 0.0, 1.0));
  float v101 = dot(g101, f - vec3(1.0, 0.0, 1.0));
  float v011 = dot(g011, f - vec3(0.0, 1.0, 1.0));
  float v111 = dot(g111, f - vec3(1.0, 1.0, 1.0));

  float x00 = mix(v000, v100, u.x);
  float x10 = mix(v010, v110, u.x);
  float x01 = mix(v001, v101, u.x);
  float x11 = mix(v011, v111, u.x);
  float y0 = mix(x00, x10, u.y);
  float y1 = mix(x01, x11, u.y);
  float val = mix(y0, y1, u.z);

  vec3 gx00 = mix(g000, g100, u.x);
  vec3 gx10 = mix(g010, g110, u.x);
  vec3 gx01 = mix(g001, g101, u.x);
  vec3 gx11 = mix(g011, g111, u.x);
  vec3 gy0 = mix(gx00, gx10, u.y);
  vec3 gy1 = mix(gx01, gx11, u.y);
  vec3 grad = mix(gy0, gy1, u.z);

  float weightX = mix(
    mix(v100 - v000, v110 - v010, u.y),
    mix(v101 - v001, v111 - v011, u.y),
    u.z
  );
  float weightY = mix(x10 - x00, x11 - x01, u.z);
  vec2 d = grad.xy + vec2(du.x * weightX, du.y * weightY);
  return vec3(val, d);
}

/** Scalar periodic noise in [0,1], for foam breakup. */
float fnoisePeriodic(vec2 p) {
  return noisedPeriodic(p).x + 0.5;
}

/**
 * Octave transform: the integer matrix [[2,1],[-1,2]].
 *
 * Determinant 5, so it scales by sqrt(5) = 2.236 per octave and rotates by
 * 26.6 degrees — enough decorrelation that the octaves cross-hatch instead of
 * combing into stripes along one axis. Being *integer*, it maps the noise
 * lattice onto itself, which is what keeps the whole stack exactly periodic
 * under a single wrap. A general rotation would not.
 */
const mat2 OCTAVE_M = mat2(2.0, -1.0, 1.0, 2.0);

/**
 * Take the grid out of a magnified bilinear lookup.
 *
 * Bilinear reconstruction is continuous but its *gradient* is not: it jumps
 * across every texel boundary, and those jumps are what the eye assembles into
 * a diamond lattice when a 1.5 m field is blown up across the foreground.
 * Warping the within-texel fraction by a quintic whose derivative vanishes at
 * both ends makes the reconstruction C1 there, so the jumps — and the lattice
 * that is only their level sets — are gone.
 *
 * The sample does not move. Strength 0 returns uv through the early exit rather
 * than through arithmetic that only rounds to it, which is what lets the legacy
 * A/B arm claim to be the established render exactly.
 */
vec2 smoothTexelUv(vec2 uv, float resolution, float strength) {
  if (strength <= 0.0) return uv;
  vec2 t = uv * resolution - 0.5;
  vec2 base = floor(t);
  vec2 f = t - base;
  vec2 warped = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return (base + 0.5 + mix(f, warped, strength)) / resolution;
}

/**
 * Read R/G foam and B hull turbulence once for every consumer below.
 *
 * The square-window fades are the established whitewater lookup, moved ahead of
 * normal detail so the wake can flatten that detail without paying a second
 * pair of texture fetches. They are deliberately measured on the *unwarped* uv:
 * the warp never leaves the texel it started in, so it has nothing to say about
 * a window edge 170 m away, and keeping the fade arithmetic untouched keeps it
 * identical across both arms of the A/B.
 */
/**
 * How far into a level's window a sample is, as a rounded square.
 *
 * The established metric was max(off.x, off.y) — the Chebyshev distance, whose
 * iso-lines are literal axis-aligned squares. Every level handover therefore
 * happened along a straight line ruled across the sea, and where the wake trail
 * crossed one it changed character along that line: the square outline around
 * the widened trail, and the straight edge on the far patch beyond it.
 *
 * The fourth-power norm keeps almost all of the window — its ball is contained
 * in the old square, so the toroidal wrap is strictly safer than before, and
 * along the axes the fade edges are unchanged — while rounding the corners
 * enough that no handover has a straight edge to be seen along.
 */
float windowEdge(vec2 offsetFromCentre) {
  vec2 q = offsetFromCentre * offsetFromCentre;
  // Floored rather than raised: pow() of an exact zero is undefined on some
  // drivers, and dead centre of a window is a position samples actually take.
  return pow(max(dot(q, q), 1e-20), 0.25);
}

/**
 * Cubic B-spline reconstruction of the hull foam level, in four bilinear taps.
 *
 * The standard Sigg-Hadwiger factorisation: each pair of B-spline weights is
 * folded into one hardware-filtered fetch placed off-centre, so a 4x4 kernel
 * costs four samples rather than sixteen.
 *
 * This is a SMOOTHING reconstruction, not an interpolating one — it does not
 * pass through the texel values — and that is exactly what is wanted here. The
 * artifact being removed is the level set of a C0 interpolant snapping to the
 * texel lattice under a threshold; an interpolating cubic would keep the
 * lattice and add ringing to it.
 */
vec3 foamHullBSpline(vec2 uv) {
  float resolution = float(FOAM_HULL_RESOLUTION);
  vec2 coord = uv * resolution - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);

  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (-f3 + 3.0 * f2 - 3.0 * f + 1.0) / 6.0;
  vec2 w1 = (3.0 * f3 - 6.0 * f2 + 4.0) / 6.0;
  vec2 w2 = (-3.0 * f3 + 3.0 * f2 + 3.0 * f + 1.0) / 6.0;
  vec2 w3 = f3 / 6.0;

  vec2 lo = w0 + w1;
  vec2 hi = w2 + w3;
  // The two fetch positions, each weighted so the pair reproduces its half of
  // the kernel exactly. lo is never zero: w1 alone is at least 1/6.
  vec2 uvLo = (base + (w1 / lo) - 0.5) / resolution;
  vec2 uvHi = (base + (w3 / hi) + 1.5) / resolution;

  vec3 a = texture2D(uFoamHull, vec2(uvLo.x, uvLo.y)).rgb;
  vec3 b = texture2D(uFoamHull, vec2(uvHi.x, uvLo.y)).rgb;
  vec3 c = texture2D(uFoamHull, vec2(uvLo.x, uvHi.y)).rgb;
  vec3 d = texture2D(uFoamHull, vec2(uvHi.x, uvHi.y)).rgb;
  return mix(mix(a, b, hi.x), mix(c, d, hi.x), hi.y);
}

vec3 persistentFoamField(
  vec2 parameterPosition,
  vec2 detailPosition,
  out float nearFade,
  out float farFade
) {
  // Only the legacy arm pays for this noise evaluation. See foamLookup.ts:
  // displacing the sample is what shredded the wake, so the replacement sets
  // the jitter to zero and the branch — uniform, therefore fully coherent —
  // drops a gradient noise fetch from every ocean fragment in the frame.
  vec2 jitterOffset = vec2(0.0);
  if (uFoamLookupJitter > 0.0) {
    jitterOffset = noisedPeriodic(
      mod(detailPosition, uDetailWrap) * (2.0 * uDetailFreq)
    ).yz * uFoamLookupJitter;
  }
  vec2 nearUv = (parameterPosition - uFoamNearOrigin) / uFoamNearExtent + 0.5
              + jitterOffset / float(FOAM_NEAR_RESOLUTION);
  vec2 farUv = (parameterPosition - uFoamFarOrigin) / uFoamFarExtent + 0.5
             + jitterOffset / float(FOAM_FAR_RESOLUTION);
  vec2 hullUv = (parameterPosition - uFoamHullOrigin) / uFoamHullExtent + 0.5
              + jitterOffset / float(FOAM_HULL_RESOLUTION);
  // Resolved into locals so each fetch stays one grep-able call: the fill-cost
  // guard in wake-trail.test.ts counts these, and one persistent-field read per
  // level is the contract it protects.
  vec2 nearFetch = smoothTexelUv(nearUv, float(FOAM_NEAR_RESOLUTION), uFoamLookupSmoothing);
  vec2 farFetch = smoothTexelUv(farUv, float(FOAM_FAR_RESOLUTION), uFoamLookupSmoothing);
  vec3 foamNear = texture2D(uFoamNear, nearFetch).rgb;
  vec3 foamFar = texture2D(uFoamFar, farFetch).rgb;

  vec2 nearOff = abs(nearUv - 0.5);
  vec2 farOff = abs(farUv - 0.5);
  vec2 hullOff = abs(hullUv - 0.5);
  float nearEdge = windowEdge(nearOff);
  float farEdge = windowEdge(farOff);
  float hullEdge = windowEdge(hullOff);
  nearFade = 1.0 - smoothstep(0.286, 0.443, nearEdge);
  farFade = 1.0 - smoothstep(0.280, 0.456, farEdge);
  // Same proportional fade as the levels above, so the hull window is gone by
  // 42.5 m of its 48 m half-extent and its toroidal wrap is never on screen.
  float hullFade = 1.0 - smoothstep(0.286, 0.443, hullEdge);

  // The hull level is the only one that is ever magnified hard enough for its
  // reconstruction to be legible, and it is the only one gated by a branch.
  //
  // Both facts come from its window: 48 m across, so it covers a sliver of the
  // screen and the overwhelming majority of ocean fragments can skip the fetch
  // outright — which is what pays for the four taps the ones inside it spend.
  // Those four are a cubic B-spline. Plain bilinear is C0 with a discontinuous
  // gradient at every texel boundary, and a coverage threshold laid over it
  // snaps to that lattice: at 0.375 m texels seen from the rail that is the
  // hard 45-degree sawtooth running the length of the foam alongside the hull.
  // smoothTexelUv was the cheap approximation of this fix and could only ever
  // be a compromise between the lattice and a grid of plateaus; a B-spline is
  // C2 with no lattice to snap to, at the cost of about half a texel of
  // softness — 19 cm of sea, against a staircase that reads as a metre.
  vec3 foamHull = vec3(0.0);
  if (hullFade > 0.0) {
    foamHull = foamHullBSpline(hullUv);
  }

  // Innermost wins where it exists. Every level carries the same quantity from
  // the same sources over its own window, so this crossfade blends agreeing
  // values at differing sharpness rather than compositing rival answers.
  vec3 outer = mix(foamFar * farFade, foamNear, nearFade);
  return mix(outer, foamHull, hullFade);
}

/**
 * Gradient of a small analytic mound centred just ahead of the actual stem.
 * This changes only the rendered normal. Vertex displacement, WaveField and
 * the surface sampled by buoyancy remain untouched.
 */
vec2 bowMoundGradient(vec2 parameterPosition) {
  if (uBowMoundNormalStrength <= 0.0) return vec2(0.0);
  // The setter publishes a unit vector. Reject the overwhelming majority of
  // ocean fragments before paying for the Gaussian exponential.
  vec2 forward = uBowMoundForward;
  vec2 acrossDirection = vec2(-forward.y, forward.x);
  vec2 delta = parameterPosition - uBowMoundCentre;
  float along = dot(delta, forward);
  float across = dot(delta, acrossDirection);
  float alongRadius = max(uBowMoundRadii.y, 0.05);
  float acrossRadius = max(uBowMoundRadii.x, 0.05);
  if (
    abs(along) > alongRadius * 3.5 ||
    abs(across) > acrossRadius * 3.5
  ) return vec2(0.0);
  float shape = exp(-0.5 * (
    along * along / (alongRadius * alongRadius) +
    across * across / (acrossRadius * acrossRadius)
  ));
  return -shape * uBowMoundNormalStrength * (
    forward * (along / alongRadius) +
    acrossDirection * (across / acrossRadius)
  );
}

/**
 * Foam breakup noise, evaluated in ONE fixed streak frame.
 *
 * frame.xy is the unit along-direction, frame.z the anisotropy. Returns the
 * octave stack in .x and the finer erosion layer in .y. Both come from the same
 * anisotropically stretched coordinate, so a caller that wants a different
 * grain in two places must blend two evaluations of this — which is the only
 * safe way to do it. Interpolating the frame ITSELF and taking one sample looks
 * equivalent and is not: it slides the sample by |q| * dtheta, and |q| here is
 * a position measured from the noise lattice's origin, so any frame that moves
 * — with time, with a decaying field, or with a live uniform — scrolls the
 * whole pattern across water that is standing still.
 *
 * That applies to frame.z as well as to frame.xy: the anisotropy scales the
 * along axis, so a stretch that drifts is a marquee down the frame's own axis.
 * Both components are held constant together by the CPU latch.
 */
vec2 foamBreakupNoise(vec2 q, vec3 frame) {
  vec2 alongDirection = frame.xy;
  vec2 across = vec2(-alongDirection.y, alongDirection.x);
  vec2 s = vec2(
    dot(q, alongDirection) * mix(1.0, 0.34, frame.z),
    dot(q, across)
  );

  float n = 0.0;
  float a = 0.62;
  float total = 0.0;
  for (int o = 0; o < FOAM_BREAKUP_OCTAVES; o++) {
    n += a * fnoisePeriodic(s);
    total += a;
    s = OCTAVE_M * s;
    a *= 0.52;
  }
  return vec2(
    n / max(total, 1e-4),
    fnoisePeriodic(OCTAVE_M * OCTAVE_M * s * 1.9)
  );
}

/**
 * One latched frame, including the cross-fade off its predecessor.
 *
 * The blend runs between two evaluated PATTERNS. Both frames are constant for
 * the whole dissolve, so nothing travels: one grain fades out where it stands
 * while the other fades in where it stands.
 *
 * Idle is the overwhelmingly common case and is an exact test, not a tolerance
 * — advanceFoamStreakFrame publishes a strictly positive blend the instant a
 * release begins and exactly zero otherwise. The branch is uniform-driven, so
 * it is coherent across the whole draw and the second stack costs nothing
 * except while a frame is actually changing.
 */
vec2 foamBreakupFramed(vec2 q, vec3 frameA, vec3 frameB, float blend) {
  vec2 value = foamBreakupNoise(q, frameA);
  if (blend > 0.0) {
    // Smoothstep rather than the raw ramp: a linear cross-fade of two
    // independent noise fields spends its middle at reduced contrast, and
    // easing the ends keeps the dissolve's least convincing part brief.
    value = mix(value, foamBreakupNoise(q, frameB), smoothstep(0.0, 1.0, blend));
  }
  return value;
}

/**
 * How fast the attached shoulder crest fans outboard as it runs aft, as a
 * gradient in abeam per astern. Declared here because the near-field's own
 * bounding reject needs it before the crest is built.
 */
const float SHOULDER_FAN_SLOPE = 0.17;

/**
 * Finite near-field bow pressure front and its attached shoulder waves.
 *
 * The stationary-phase Kelvin solution below is a FAR-field point-source
 * abstraction. A real working bow is a distributed pressure body: water rises
 * across a curved front ahead of the stem, then the attached sheet peels around
 * two finite shoulders. The CPU therefore supplies the most-forward live cut
 * and a broad cut two renderer stations aft. This function joins them as a
 * rounded pressure front and continues one crest down either shoulder until
 * the Kelvin field becomes authoritative. There is deliberately no rendered
 * cone apex.
 *
 * Surface-shading only: a normal gradient plus a small instantaneous breaking
 * coverage signal. It changes no displaced surface, contact, buoyancy or force
 * path.
 */
vec2 shipBowNearFieldGradient(
  vec2 parameterPosition,
  float pixelFootprint,
  out float breakingCoverage
) {
  breakingCoverage = 0.0;
  if (uShipWakeStrength <= 0.0) return vec2(0.0);
  vec2 forward = uShipWakeHullForward;
  vec2 starboard = vec2(-forward.y, forward.x);
  vec2 delta = parameterPosition - uShipWakeOrigin;
  float astern = -dot(delta, forward);
  float abeam = dot(delta, starboard);
  float absAbeam = abs(abeam);
  float hullLength = max(uShipWakeHullLength, 4.0);
  float lambda = max(uShipWakeLambda, 0.5);
  float shoulderHalfWidth = clamp(
    uShipWakeBowShoulderHalfWidth,
    0.35,
    max(uShipWakeHalfBeam * 1.10, 0.5)
  );
  float frontLead = clamp(lambda * 0.11, 0.75, 1.15);
  float frontWidth = max(
    clamp(lambda * 0.075, 0.45, 0.75),
    pixelFootprint * 0.75
  );
  float shoulderWidth = max(
    clamp(lambda * 0.050, 0.32, 0.58),
    pixelFootprint * 0.75
  );

  // Reject on BOTH axes before paying for a single exponential, exactly as the
  // bow mound above does and for the same reason: without an abeam bound this
  // runs the whole profile for every ocean fragment in an unbounded transverse
  // strip, which at deck height is most of the lower frame.
  //
  // The forward bound is derived from the crest rather than assumed. The front
  // centre stands frontLead ahead of the tip and a Gaussian is at its STEEPEST
  // one sigma further forward again, so a fixed cut anywhere inside
  // frontLead + frontWidth slices the crest at maximum slope and leaves a
  // straight seam across open water ahead of the stem. 3.5 sigma clears it.
  float forwardReach = frontLead + frontWidth * 3.5;
  // The outermost feature is the shoulder crest, which starts at the measured
  // shoulder and fans aft. hullLength * 0.08 is the floor shoulderAstern is
  // clamped to below, so using it here can only over-estimate the reach.
  float abeamReach = shoulderHalfWidth * 1.12 + 0.16
    + max(astern - hullLength * 0.08, 0.0) * SHOULDER_FAN_SLOPE
    + shoulderWidth * 6.0;
  if (
    astern < -forwardReach ||
    astern >= hullLength * 0.76 ||
    absAbeam > abeamReach
  ) return vec2(0.0);

  vec2 shoulderDelta = uShipWakeBowShoulderCentre - uShipWakeOrigin;
  float shoulderAstern = max(
    -dot(shoulderDelta, forward),
    hullLength * 0.08
  );
  float crownHalfWidth = clamp(
    uShipWakeBowCrownHalfWidth,
    0.12,
    shoulderHalfWidth * 0.82
  );

  // A rounded front across the finite crown. The centre lies a fraction of a
  // wavelength ahead of the last wet cut; its ends sweep aft to the measured
  // shoulder cut. Normalising the implicit-function gradient turns the signed
  // value into an approximate physical distance, keeping crest width even as
  // the arc turns through the bow.
  float frontU = clamp(absAbeam / shoulderHalfWidth, 0.0, 1.0);
  float frontEllipseRoot = sqrt(max(1.0 - frontU * frontU, 0.0));
  float frontAstern = -frontLead + (shoulderAstern + frontLead)
    * (1.0 - frontEllipseRoot);
  float frontDerivative =
    (shoulderAstern + frontLead) * frontU
    / (max(frontEllipseRoot, 0.18) * shoulderHalfWidth);
  vec2 frontDistanceGradient =
    -forward - sign(abeam) * starboard * frontDerivative;
  float frontGradientLength = max(length(frontDistanceGradient), 1.0);
  float fromFront = (astern - frontAstern) / frontGradientLength;
  vec2 frontNormalDirection = frontDistanceGradient / frontGradientLength;
  float invFrontWidth2 = 1.0 / (frontWidth * frontWidth);
  float frontCrest = exp(-0.5 * fromFront * fromFront * invFrontWidth2);
  float frontTroughWidth = frontWidth * 1.40;
  float fromFrontTrough = fromFront - frontWidth * 1.55;
  float frontTrough = exp(
    -0.5 * fromFrontTrough * fromFrontTrough /
    (frontTroughWidth * frontTroughWidth)
  );
  float frontProfileDerivative =
    -fromFront * invFrontWidth2 * frontCrest
    + 0.30 * fromFrontTrough /
      (frontTroughWidth * frontTroughWidth) * frontTrough;
  float frontLateral = 1.0 - smoothstep(
    shoulderHalfWidth * 0.90,
    shoulderHalfWidth * 1.12,
    absAbeam
  );
  vec2 frontGradient = frontNormalDirection
    * (frontProfileDerivative * frontWidth)
    * (uShipWakeStrength * 2.25 * frontLateral);

  // The same crest leaves the measured shoulder almost longitudinally and
  // reaches the Kelvin cusp around the aft shoulder. This is a continuation of
  // the broad bow front, not another point wave and not a periodic decal.
  float shoulderAlong = astern - shoulderAstern;
  float shoulderCrestAbeam = shoulderHalfWidth + 0.16
    + max(shoulderAlong, 0.0) * SHOULDER_FAN_SLOPE;
  float fromShoulder = absAbeam - shoulderCrestAbeam;
  float invShoulderWidth2 = 1.0 / (shoulderWidth * shoulderWidth);
  float shoulderCrest = exp(
    -0.5 * fromShoulder * fromShoulder * invShoulderWidth2
  );
  float shoulderTroughWidth = shoulderWidth * 1.35;
  float fromShoulderTrough = fromShoulder - shoulderWidth * 1.65;
  float shoulderTrough = exp(
    -0.5 * fromShoulderTrough * fromShoulderTrough /
    (shoulderTroughWidth * shoulderTroughWidth)
  );
  float shoulderProfileDerivative =
    -fromShoulder * invShoulderWidth2 * shoulderCrest
    + 0.34 * fromShoulderTrough /
      (shoulderTroughWidth * shoulderTroughWidth) * shoulderTrough;
  float shoulderTip = smoothstep(-0.55, 0.45, shoulderAlong);
  float shoulderLateral = smoothstep(
    crownHalfWidth * 0.85,
    shoulderHalfWidth * 0.95,
    absAbeam
  );
  float shoulderTail = 1.0 - smoothstep(
    hullLength * 0.46,
    hullLength * 0.74,
    astern
  );
  vec2 shoulderDistanceGradient =
    sign(abeam) * starboard + SHOULDER_FAN_SLOPE * forward;
  vec2 shoulderGradient = shoulderDistanceGradient
    * (shoulderProfileDerivative * shoulderWidth)
    * (
      uShipWakeStrength * 2.10
      * shoulderTip * shoulderLateral * shoulderTail
    );

  // The sheet only breaks once it has SEPARATED, which is at and aft of the
  // shoulders. The pressure mound ahead of the stem is clear rising water and
  // gets no breaking term at all.
  //
  // R9 also whitened the front, biased outboard by a smoothstep that reached
  // full strength at 0.88 of the shoulder half-width — where frontLateral is
  // already cutting the front off. The result was a narrow high-coverage band
  // on each side, forward of the stem, at a fixed separation: two white lines
  // straddling the bow that slid sideways as the resolved tip cut jumped
  // between hull stations. There is no bow wave that looks like that.
  float breakResolve = 1.0 - smoothstep(
    shoulderWidth * 0.35,
    shoulderWidth * 1.75,
    pixelFootprint
  );
  breakingCoverage = exp(
    -0.5 * fromShoulder * fromShoulder /
    max(shoulderWidth * shoulderWidth * 0.42, 1e-4)
  ) * shoulderTip * shoulderLateral * shoulderTail * breakResolve
    * (uShipWakeStrength * 0.58);

  return frontGradient + shoulderGradient;
}

/**
 * The ship's own wave pattern: real Kelvin geometry, as a fragment-normal
 * perturbation only. No vertex moves; WaveField, buoyancy and the surface the
 * physics samples never see this, and the wake stays strictly one-way.
 *
 * WK-R4 built this as two independent PLANE waves — sin(k*astern) for the
 * transverse system and a fixed 35.26-degree sin() for the divergent one, with
 * the cusp painted on as a Gaussian. Straight parallel crests at one
 * wavelength cannot compress or fan, because nothing in that arithmetic varies
 * with position, so the pattern read as corduroy rather than as a wake. Ash's
 * note was that it should "compress at the point of the bow and then fan out
 * diagonally", which is exactly what the real pattern does and exactly what
 * two plane waves cannot do.
 *
 * The real pattern is not two systems. Waves that hold station against a hull
 * moving at V must satisfy k(theta) = k0*sec^2(theta), k0 = g/V^2, where theta
 * is the wave's heading off the track. Every one of them contributes, and the
 * surface is their interference integral. Stationary phase picks out the two
 * headings that actually reach a given point, and — this is the part worth
 * knowing — that condition is merely a QUADRATIC in tan(theta):
 *
 *     2*Y*t^2 + X*t + Y = 0,   t = tan(theta), X astern, Y abeam, in 1/k0
 *
 * so both branches are closed form. No integral, no root-finding, no baked
 * texture. Its discriminant X^2 - 8*Y^2 also *derives* the wedge — real roots
 * need |Y/X| <= 1/(2*sqrt(8)) = tan(19.47 deg) — instead of the constant being
 * asserted as it was before. The small root is the transverse branch, the
 * large one the divergent branch, and they merge where the discriminant
 * vanishes, which is the cusp line. One family, two ends, joined.
 *
 * Everything is in units of 1/k0, and the pattern is therefore exactly
 * self-similar: the same shape at every speed, scaled by the one length V^2/g
 * the CPU policy already publishes as lambda.
 */
vec2 shipWakePatternGradient(vec2 parameterPosition, float pixelFootprint) {
  if (uShipWakeKelvinStrength <= 0.0) return vec2(0.0);
  vec2 forward = uShipWakeDir;
  vec2 starboard = vec2(-forward.y, forward.x);
  vec2 delta = parameterPosition - uShipWakeOrigin;
  float astern = -dot(delta, forward);
  if (astern < 0.0 || astern > uShipWakeLength) return vec2(0.0);
  float lambda = max(uShipWakeLambda, 0.5);
  float abeam = dot(delta, starboard);
  float absAbeam = abs(abeam);

  // A carrier finer than a few pixels is sparkle, not waves; fade it out on
  // the same footprint the whitewater terms use.
  float alias = 1.0 - smoothstep(lambda * 0.08, lambda * 0.25, pixelFootprint);
  if (alias <= 0.0) return vec2(0.0);

  // Normalised coordinates. lambda is 2*pi*V^2/g, so k0 = 2*pi/lambda and
  // X, Y are the dimensionless coordinates the whole solution lives in.
  float k0 = 6.2831853 / lambda;
  float X = astern * k0;
  float Y = absAbeam * k0;

  // The wedge, derived rather than asserted.
  float disc = X * X - 8.0 * Y * Y;
  if (disc <= 0.0) return vec2(0.0);
  float root = sqrt(disc);
  float denom = X + root;

  // Numerically stable roots of 2*Y*t^2 + X*t + Y = 0. Taking the transverse
  // branch as c/q rather than the textbook formula is what keeps it exact on
  // the centreline, where 4*Y cancels and the naive form is 0/0: it tends to
  // -Y/X, i.e. theta -> 0 and phase -> X, the pure transverse wave of
  // wavelength lambda. The divergent root runs off to -infinity there, which
  // is correct — and harmless, because the depth weight below kills it.
  float tTransverse = -2.0 * Y / max(denom, 1e-5);
  float tDivergent = clamp(-denom / max(4.0 * Y, 1e-5), -1e4, 0.0);

  // Havelock weight for a source at normalised depth: a real hull does not
  // radiate arbitrarily short waves, and exp(-k*d) with k = sec^2(theta) is
  // both the physical reason and the thing that makes the sum converge. It is
  // what sets how feathered the divergent arms look.
  const float SOURCE_DEPTH = 0.22;
  // Stationary phase is a saddle-point approximation and it fails where the
  // two saddles merge — at the cusp, where the true envelope is Airy rather
  // than 1/sqrt. Flooring the curvature bounds that singularity into a bright
  // caustic line, which is the right look for the right reason: the cusp IS
  // the brightest feature of a real wake.
  const float CURVATURE_FLOOR = 0.6;

  vec2 gradient = vec2(0.0);
  for (int branch = 0; branch < 2; branch++) {
    float t = branch == 0 ? tTransverse : tDivergent;
    float sec2 = 1.0 + t * t;
    float weight = exp(-SOURCE_DEPTH * sec2);
    if (weight < 2e-3) continue;
    float sec = sqrt(sec2);
    float phase = sec * (X + Y * t);
    // d2(phase)/d(theta)^2 at the stationary point.
    float curvature = sec * (X * (2.0 * t * t + 1.0) + Y * t * (5.0 + 6.0 * t * t));
    float amplitude = weight * inversesqrt(max(abs(curvature), CURVATURE_FLOOR));
    // The saddle contributes with a +/- pi/4 twist by the sign of its curvature.
    float twist = curvature >= 0.0 ? 0.7853982 : -0.7853982;
    // Envelope theorem: the phase is stationary in theta, so the spatial
    // gradient is just d(phase)/d(X,Y) at fixed theta — no dt/dX term.
    gradient += (-amplitude * sin(phase + twist)) * vec2(sec, t * sec);
  }

  // The ideal Kelvin support ends on a straight cusp ray, but a finite hull
  // does not present that mathematical boundary as a material seam. Fade the
  // added pattern over a wavelength-scaled strip measured in metres. The
  // ambient ocean/detail stack is deliberately untouched on both sides, so
  // its facets continue through this handoff and visually interact with it.
  // Pixel footprint only broadens the strip when perspective can no longer
  // resolve its physical width; it can never sharpen the transition again.
  float cuspDistanceM = astern * 0.35355339 - absAbeam;
  float cuspFeatherM = max(
    clamp(lambda * 0.18, 1.25, 3.5),
    pixelFootprint * 1.5
  );
  float cuspFade = smoothstep(0.0, cuspFeatherM, cuspDistanceM);
  // Stationary phase is not authoritative in the finite-hull near field. Fade
  // it in only as the distributed bow front above fades out, so the analytic
  // point-source apex is never rendered under the hull.
  float farFieldAuthority = smoothstep(
    uShipWakeHullLength * 0.36,
    uShipWakeHullLength * 0.68,
    astern
  );
  float tail = 1.0 - smoothstep(uShipWakeLength * 0.6, uShipWakeLength, astern);
  // Brings the stationary-phase amplitude back to the order the strength lever
  // was calibrated against, so PATTERN_SLOPE_MAX keeps meaning a slope.
  //
  // Larger than it looks because the saddle amplitude carries a 1/sqrt of the
  // phase curvature, which is of order X: the unmasked saddle solution grows
  // toward its invalid near field, so the constant has to be set by the honest
  // mid-field instead. Measured against the plane-wave version it replaced, at
  // ~20 m astern of the moderate reference.
  const float GRADIENT_NORM = 5.5;
  float envelope = uShipWakeKelvinStrength * GRADIENT_NORM
    * farFieldAuthority * cuspFade * tail * alias;

  // astern increases along -forward, and Y is |abeam|, so the abeam component
  // carries the mirror's sign. This is what makes the two halves of the
  // pattern reflections of one another rather than copies.
  return (-gradient.x * forward + gradient.y * sign(abeam) * starboard) * envelope;
}

void main() {
#ifdef OCEAN_INTERIOR_VOLUME_CUTOUT
  // The inverse vessel transform makes pitch, roll and heave free. Almost all
  // ocean pixels leave through these bounds; only the ship footprint pays the
  // sampled swept-hull lookup. The discard must remain in a separately compiled
  // variant: merely putting it behind a uniform would still mark the stencil
  // arm as a may-discard pipeline and invalidate the performance comparison.
  vec3 interiorLocal =
    (uInteriorWorldToLocal * vec4(vWorldPos, 1.0)).xyz;
  if (
    interiorLocal.z >= uInteriorCutoutBounds.x &&
    interiorLocal.z <= uInteriorCutoutBounds.y &&
    interiorLocal.y >= uInteriorCutoutBounds.z &&
    interiorLocal.y <= uInteriorCutoutBounds.w
  ) {
    float interiorWidth = interiorHalfBreadth(interiorLocal.zy);
    if (abs(interiorLocal.x) < max(interiorWidth - uInteriorCutoutMargin, 0.0)) {
      discard;
    }
  }
#endif
  ${GLSL_LOG_DEPTH_FRAGMENT}
#ifdef OCEAN_PROFILE_DETAIL_CATEGORIES
  float categoryFootprint = max(fwidth(vParam.x), fwidth(vParam.y));
  vec3 detailCategories = vec3(0.0);
  mat2 categoryJq = mat2(uDetailFreq, 0.0, 0.0, uDetailFreq);
  for (int o = 0; o < DETAIL_OCTAVES; o++) {
    float cellSize = 1.0 / length(vec2(categoryJq[0].x, categoryJq[0].y));
    float fade = 1.0 - smoothstep(
      0.20 * cellSize,
      0.50 * cellSize,
      categoryFootprint
    );
    if (fade >= 1.0) detailCategories.x += 1.0;
    else if (fade > 0.002) detailCategories.y += 1.0;
    else detailCategories.z += 1.0;
    categoryJq = OCTAVE_M * categoryJq;
  }
  // One integer count per RGBA8 level; alpha is the exact ocean mask.
  gl_FragColor = vec4(detailCategories / 255.0, 1.0);
#elif defined(OCEAN_PROFILE_RESIDUAL_CATEGORIES_A) || defined(OCEAN_PROFILE_RESIDUAL_CATEGORIES_B)
  float categoryFootprint = max(fwidth(vParam.x), fwidth(vParam.y));
  vec4 residualCategoryA;
  vec3 residualCategoryB;
  residualWaveCategories(
    vLodRadius,
    categoryFootprint,
    residualCategoryA,
    residualCategoryB
  );
  // One integer count per RGBA8 level. Pass B's alpha is an exact ocean mask;
  // the offscreen target is cleared to transparent black before rendering.
  #ifdef OCEAN_PROFILE_RESIDUAL_CATEGORIES_A
    gl_FragColor = residualCategoryA / 255.0;
  #else
    gl_FragColor = vec4(residualCategoryB / 255.0, 1.0);
  #endif
#elif defined(OCEAN_PROFILE_FLAT)
  gl_FragColor = vec4(0.02, 0.05, 0.08, uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
#else
  // Per-pixel footprint in PARAMETER space, including grazing-angle stretch.
  //
  // Parameter space, not world space, because every length this is compared
  // against lives in parameter space: the detail-noise cells, the residual
  // wavelengths, the foam breakup cells. The two spaces differ by the wave
  // compression, and they differ most at the crests — a compressed crest packs
  // more parameter distance into each world metre, and so into each pixel —
  // which means a world-space footprint under-reports the frequency actually
  // crossing the pixel exactly where the surface is most disturbed. Measured
  // on the world position, every Nyquist fade below kept its noise alive right
  // on the crest lines, where it rendered as per-pixel speckle instead of
  // being folded into roughness. vParam is interpolated across the displaced
  // triangles, so its screen derivative carries both the perspective stretch
  // and the crest compression with no extra arithmetic.
  float footprint = max(fwidth(vParam.x), fwidth(vParam.y));

  // WX3 presentation forcing. A literal zero amplitude takes no arithmetic
  // path at all, preserving the established normal, glint and whitecap pixels.
  // Positive amplitude yields one local wind speed shared by the roughness and
  // active-whitecap readers; the persistent field samples the same function.
  float catsPawRoughnessScale = 1.0;
  float catsPawWhitecapDrive = 1.0;
  if (uCatsPawGustExcessMps > 0.0) {
    float localCatsPawWind = catsPawLocalWindSpeed(vParam, uWindStrength);
    float catsPawWindRatio = clamp(
      localCatsPawWind / max(uWindStrength, 3.5),
      0.4,
      1.8
    );
    catsPawRoughnessScale = sqrt(clamp(catsPawWindRatio, 0.55, 1.7));
    catsPawWhitecapDrive = catsPawWindRatio;
  }

  // The field lookup has to precede the whitewater stack. B changes only the
  // wake's foam/haze presentation, never the ocean detail, WaveField geometry,
  // or any surface the hull samples.
  float foamNearFade = 0.0;
  float foamFarFade = 0.0;
  vec3 persistentFoam = vec3(0.0);
#ifndef OCEAN_PROFILE_DISABLE_FOAM
  persistentFoam = persistentFoamField(vParam, vDetail, foamNearFade, foamFarFade);
#endif
  float wakeTurbulence = clamp(persistentFoam.b, 0.0, 1.0);

  // --- detail gradient, in parameter space ------------------------------
  // Jitter the detail lookup inside this pixel without moving the geometry,
  // foam, residual swell, silhouette, or anything else in the scene. Screen
  // derivatives turn a sub-pixel offset into the matching parameter-space
  // displacement, so successive temporal samples integrate the nonlinear
  // specular response over the pixel footprint rather than low-pass filtering
  // unrelated neighbouring water parcels.
  vec2 detailSample = vDetail
    + dFdx(vDetail) * uTemporalDetailJitter.x
    + dFdy(vDetail) * uTemporalDetailJitter.y;
  // The variance of the octaves too fine to draw is folded back into roughness
  // so nothing is silently discarded.
  vec2 detailGrad = vec2(0.0);
  float variance = 0.0;
  // Finest RESOLVED octave's noise value, and how strongly it is drawn. The
  // sparkle term below rides these, so it costs no extra fetch and inherits
  // the same Nyquist fade: once a pixel spans the sparkle cells it stops
  // sparkling and the plain lobe mean takes over, which is correct — a pixel
  // holding a thousand glints IS its average.
  float sparkleValue = 0.0;
  float sparkleFade = 0.0;
  {
    // Wrapping here rather than on the vertex position keeps the noise
    // coordinate small at large diagnostic origins without a seam: the stack is
    // exactly periodic over uDetailWrap, so this is an identity.
    vec2 base = mod(detailSample, uDetailWrap) * uDetailFreq;
    mat2 jq = mat2(uDetailFreq, 0.0, 0.0, uDetailFreq);
    float amp = uDetailAmp;

#ifdef OCEAN_DETAIL_PREFILTERED
    // The replacement candidate collapses the visible detail spectrum into
    // three sampled bands sourced from two packed periodic gradient fields.
    // Hardware mip selection integrates every band over the pixel footprint,
    // avoiding five procedural noise evaluations and their point-sampled
    // glitter. Reusing the coarse field at the micro scale is decorrelated by
    // both the integer octave transform and an independent scroll/seed.
    float coarseEnergy = 0.0;
    float middleEnergy = 0.0;
    float microEnergy = 0.0;
    vec2 middleBase = OCTAVE_M * (OCTAVE_M * base);
    vec2 microBase = OCTAVE_M * middleBase;
    for (int o = 0; o < DETAIL_OCTAVES; o++) {
      float cellSize = 1.0 / length(vec2(jq[0].x, jq[0].y));
      float fade = 1.0 - smoothstep(0.20 * cellSize, 0.50 * cellSize, footprint);
      // Deliberately stop drawing the finest bands as discrete normals. Their
      // energy remains in variance below, where it broadens the reflection
      // lobe instead of resolving as isolated white pixels.
      float representationWeight = 0.0;
      if (o == 0) representationWeight = 1.0;
      else if (o == 1) representationWeight = 1.0;
      else if (o == 2) representationWeight = 0.95;
      else if (o == 3) representationWeight = 0.80;
      else if (o == 4) representationWeight = 0.50;
      float drawFade = fade * representationWeight;
      // The mid-band gain applies here too; the collapsed bands carry no
      // per-sample value, so the crest skew deliberately does not.
      float slopeScale = amp * uDetailOctaveGain[o] / max(cellSize, 1e-4);
      float drawnEnergy = drawFade * slopeScale;
      if (o < 2) coarseEnergy += drawnEnergy * drawnEnergy;
      else if (o == 2) middleEnergy += drawnEnergy * drawnEnergy;
      else microEnergy += drawnEnergy * drawnEnergy;
      float lost = (1.0 - drawFade) * slopeScale;
      variance += lost * lost * 0.5;
      jq = OCTAVE_M * jq;
      amp *= 0.55;
    }

    vec4 packedCoarse = texture2D(
      uDetailGradientMap,
      fract((base + uDetailScroll[0]) / NOISE_PERIOD)
    );
    vec4 packedMiddle = texture2D(
      uDetailGradientMap,
      fract((middleBase + uDetailScroll[2]) / NOISE_PERIOD)
    );
    vec4 packedMicro = texture2D(
      uDetailGradientMap,
      fract((microBase + uDetailScroll[3] + vec2(91.7, 37.3)) / NOISE_PERIOD)
    );
    vec2 coarseGradient =
      (packedCoarse.xy * 2.0 - 1.0) * uDetailGradientRange.x;
    vec2 middleGradient =
      (packedMiddle.zw * 2.0 - 1.0) * uDetailGradientRange.y;
    vec2 microGradient =
      (packedMicro.xy * 2.0 - 1.0) * uDetailGradientRange.x;
    detailGrad = coarseGradient * sqrt(coarseEnergy)
               + middleGradient * sqrt(middleEnergy)
               + microGradient * sqrt(microEnergy);
#elif defined(OCEAN_DETAIL_CACHED) || defined(OCEAN_DETAIL_HYBRID)
    // Unlike the rejected three-band candidates, this map is a sampled copy of
    // noisedPeriodic itself. Every octave keeps its original coordinate,
    // independent scroll, amplitude and Nyquist fade. The cached variant only
    // replaces hash/interpolation arithmetic with a filtered texture lookup.
    for (int o = 0; o < DETAIL_OCTAVES; o++) {
      float cellSize = 1.0 / length(vec2(jq[0].x, jq[0].y));
      float fade = 1.0 - smoothstep(0.20 * cellSize, 0.50 * cellSize, footprint);
      float representationWeight = 1.0;
#ifdef OCEAN_DETAIL_HYBRID
      // Preserve A exactly through the broad and middle octaves. Only the two
      // finest bands trade explicit normal swing for slope variance, which is
      // the controlled lever for the clipped near-camera white points.
      if (o == 3) representationWeight = 0.70;
      else if (o == 4) representationWeight = 0.35;
#endif
      float drawFade = fade * representationWeight;
      float gainedAmp = amp * uDetailOctaveGain[o];
      if (drawFade > 0.002) {
        vec2 nd;
        float ndValue;
#ifdef OCEAN_DETAIL_HYBRID
        if (o < 3) {
          vec3 nd3 = noisedPeriodic(base + uDetailScroll[o]);
          nd = nd3.yz;
          ndValue = nd3.x;
        } else {
          vec4 texel = texture2D(
            uDetailFaithfulMap,
            fract((base + uDetailScroll[o]) / NOISE_PERIOD)
          );
          nd = (texel.xy * 2.0 - 1.0) * uDetailFaithfulRange;
          ndValue = (texel.z * 2.0 - 1.0) * uDetailValueRange;
        }
#else
        vec4 texel = texture2D(
          uDetailFaithfulMap,
          fract((base + uDetailScroll[o]) / NOISE_PERIOD)
        );
        nd = (texel.xy * 2.0 - 1.0) * uDetailFaithfulRange;
        ndValue = (texel.z * 2.0 - 1.0) * uDetailValueRange;
#endif
        float crest = max(uDetailSkew.x + uDetailSkew.y * ndValue, 0.0);
        detailGrad += (nd * jq) * (drawFade * gainedAmp * crest);
        sparkleValue = ndValue;
        sparkleFade = drawFade;
      }
      float slopeScale = gainedAmp / max(cellSize, 1e-4);
      float lost = (1.0 - fade) * slopeScale;
      variance += lost * lost * 0.5;
#ifdef OCEAN_DETAIL_HYBRID
      // Energy removed from a still-resolvable micro normal is not discarded;
      // it broadens the reflection statistically. Keeping this term separate
      // from the established Nyquist fade preserves that fade's current shape.
      float filtered =
        fade * sqrt(max(1.0 - representationWeight * representationWeight, 0.0)) *
        slopeScale;
      variance += filtered * filtered * 0.5;
#endif
      base = OCTAVE_M * base;
      jq = OCTAVE_M * jq;
      amp *= 0.55;
    }
#else
    for (int o = 0; o < DETAIL_OCTAVES; o++) {
      float cellSize = 1.0 / length(vec2(jq[0].x, jq[0].y));
      // Band-limit at Nyquist, exactly as the residual swell does. The old
      // window ran to 1.0 cells of footprint — ONE sample per noise cell,
      // twice Nyquist — so a mid-distance pixel kept drawing gradient noise
      // it could not resolve. Against the bright low-sky reflection that
      // renders as granular static crawling over every reflective patch.
      // Ending at half a cell hands the energy to the variance term below,
      // which widens the reflection lobe instead: pre-filtered, stable.
      float fade = 1.0 - smoothstep(0.20 * cellSize, 0.50 * cellSize, footprint);
      if (fade > 0.002) {
        vec3 nd;
        if (uDetailMotionMode == 1) {
          // Equal-strength fields at the SAME scale move in opposite
          // directions. A per-octave seed keeps this from becoming a mirrored
          // standing pattern; 1/sqrt(2) preserves the original slope variance.
          vec2 seed = vec2(67.31, 149.73) + float(o) * vec2(43.17, 71.53);
          vec3 forwardField = noisedPeriodic(base + uDetailScroll[o]);
          vec3 reverseField = noisedPeriodic(base - uDetailScroll[o] + seed);
          nd = (forwardField + reverseField) * 0.70710678;
        } else if (uDetailMotionMode == 2) {
          // Move through a third, temporal dimension: contours form and
          // dissolve at fixed parameter positions with no horizontal velocity.
          // Rates approximate the shortening turnover time of finer bands and
          // are rational so DETAIL_TIME_WRAP is an exact no-pop cycle.
          float temporalRate = 1.0;
          if (o == 1) temporalRate = 1.5;
          else if (o == 2) temporalRate = 2.25;
          else if (o == 3) temporalRate = 3.25;
          else if (o == 4) temporalRate = 4.75;
          else if (o == 5) temporalRate = 7.0;
          // 1.0203 matches the measured RMS spatial gradient of the 2D field;
          // mode changes therefore preserve roughness to within sampling error.
          nd = noisedPeriodic3(vec3(
            base,
            uDetailMorphTime * temporalRate + float(o) * 53.0
          )) * 1.0203;
        } else {
          nd = noisedPeriodic(base + uDetailScroll[o]);
        }
        // nd.yz is d(noise)/d(q). Pushing it back to parameter space needs the
        // transpose of d(q)/d(param), which is what a row-vector product does.
        // The crest weight rides nd.x — the same field's own value — so slope
        // concentrates on the noise's high side when the skew is engaged.
        float crest = max(uDetailSkew.x + uDetailSkew.y * nd.x, 0.0);
        detailGrad += (nd.yz * jq) * (fade * amp * uDetailOctaveGain[o] * crest);
        sparkleValue = nd.x;
        sparkleFade = fade;
      }
      float lost = (1.0 - fade) * amp * uDetailOctaveGain[o] / max(cellSize, 1e-4);
      variance += lost * lost * 0.5;

      base = OCTAVE_M * base;
      jq = OCTAVE_M * jq;
      amp *= 0.55;
    }
#endif
  }

  if (uCatsPawGustExcessMps > 0.0) {
    detailGrad *= catsPawRoughnessScale;
    variance *= catsPawRoughnessScale * catsPawRoughnessScale;
  }

  // Hull-sourced water is still the same wind-roughened ocean. Preserve the
  // complete resolved detail gradient and its retired high-frequency variance
  // through the wake; only foam/haze and the additive Kelvin gradient below
  // distinguish worked water from its surroundings.

  // Pick up the swell the mesh was too coarse to displace, so the mid and far
  // ocean keeps its structure instead of flattening into a mirror plate.
  float swellVariance;
  vec2 swellGrad = residualWaveGradient(vParam, vLodRadius, footprint, swellVariance);
  variance += swellVariance;

  float bowWaveBreakingCoverage;
  vec2 bowWaveGradient = shipBowNearFieldGradient(
    vParam,
    footprint,
    bowWaveBreakingCoverage
  );

  // One conversion, after everything has been summed. See the file header.
  vec2 slope = slopeFromGradient(
    vGradient + swellGrad + detailGrad + bowMoundGradient(vParam)
      + bowWaveGradient
      + shipWakePatternGradient(vParam, footprint),
    vInvJ
  );
  vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 toCam = cameraPosition - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec3 viewDir = -V;

  float NdV = max(dot(N, V), 0.0);

  // --- roughness --------------------------------------------------------
  // Cox-Munk gives the total slope variance of a wind-roughened sea. What the
  // shading has to supply is the part nothing else has already drawn, so the
  // CPU subtracts both the resolved Gerstner components and the detail octaves
  // — the octaves are real geometry too, and counting their slope again here
  // was double-counting. The variance term adds back only what this pixel's own
  // footprint forced it to drop.
  //
  // VARIANCES add; standard deviations do not. The old
  // sqrt(2 s2) + sqrt(2 var) inflated the width by up to sqrt(2), which alone
  // widened the daylight glare well past anything Cox-Munk predicts.
  //
  // Two consumers, two widths. The glitter lobe gets the honest facet width;
  // the mean-reflection lobe gets a fraction of it, because most of the slope
  // variance is centimetre ripple that widens a highlight without much moving
  // the mean reflected direction.
  // The per-pixel lost-variance terms are PARAMETER-space gradient variances,
  // and had those gradients been drawn they would have passed through the same
  // inverse Jacobian as every drawn gradient — so their variance must too.
  // E[|J^-1 g|^2] for an isotropic gradient g is half the squared Frobenius
  // norm: exactly 1.0 on undisturbed water, growing where crests compress the
  // parameter grid. This is the other half of the parameter-space footprint
  // above: the fades retire detail earlier at a crest, and this hands the
  // retired energy to the lobe at the width it would actually have had there.
  // uUnresolvedSlopeVariance is already a world-slope statistic (Cox-Munk
  // minus what the geometry resolves) and takes no correction. Bounded by the
  // safeDet clamp upstream and the alpha clamps below.
  float jGain = 0.5 * (vInvJ.x * vInvJ.x + 2.0 * vInvJ.y * vInvJ.y + vInvJ.z * vInvJ.z);
  // Specular anti-aliasing, measured rather than modelled. Whatever slope
  // structure survives the fades above is still drawn at one sample per pixel,
  // and the derivative hardware can see exactly how far this pixel's slope
  // sits from its neighbours'. That spread is unresolvable by construction —
  // nothing inside one pixel can display it — so it belongs in the lobe with
  // the rest of the sub-pixel variance. It is already a slope variance in
  // sigma2's own units, and it vanishes wherever the surface really is smooth
  // across the quad, so the resolved near field pays nothing. The min() bounds
  // pathological quads; the alpha clamps below bound the rest.
  vec2 dSx = dFdx(slope);
  vec2 dSy = dFdy(slope);
  float slopeJitter2 = min(0.25 * (dot(dSx, dSx) + dot(dSy, dSy)), 0.30);
  float sigma2 = uUnresolvedSlopeVariance + variance * jGain + slopeJitter2;
  float alphaGlitter = clamp(sqrt(2.0 * sigma2) * uRoughnessScale, 0.060, 0.45);
  float alphaReflect = clamp(alphaGlitter * uReflectLobeRatio, 0.040, 0.28);

  // --- geometry-driven direct-light occlusion ---------------------------
  // No circular raft fade and no analytic hull volume. The Sun samples the
  // directional depth map rendered from real vessel + displaced-ocean meshes;
  // the lantern samples its vessel-only cube depth map below.
  float directSunVisibility = sunSurfaceVisibility();
  // The hull's bite out of the sky hemisphere. One evaluation, reused by every
  // sky-driven term below so they cannot drift apart.
  float skyVisibility = vesselSkyVisibility();

  // --- the lantern, as a light rather than a wash ------------------------
  // Sun and moon are directions. The lamp is a POSITION two metres away, and
  // that difference is the whole fix: a per-pixel light direction means the
  // half-vector changes across every ripple inside the pool, so each facet
  // either catches the flame or does not. That is what a lantern over water
  // looks like — a shimmering column broken and re-formed by the swell — and
  // it is what the old additive pool could not be at any brightness. That pool
  // modulated on clamp(N.y) alone, the one component of a water normal that
  // barely varies, and sat forty times above the sea's own night radiance: a
  // pedestal that erased the surface it was meant to reveal.
  vec3  lampL = vec3(0.0, 1.0, 0.0);
  vec3  lampRadiance = vec3(0.0);
  float alphaLamp = alphaGlitter;
  if (uLampEmission > 0.001) {
    vec3 toLamp = uLampWorld - vWorldPos;
    float lampD2 = max(dot(toLamp, toLamp), 0.25);
    float lampD = sqrt(lampD2);
    lampL = toLamp / lampD;
    // Inverse square normalised to 1 at one metre, windowed to zero at the
    // lamp's range exactly as three.js windows the deck's PointLight.
    float win = clamp(1.0 - pow(lampD / LAMP_RANGE, 4.0), 0.0, 1.0);
    if (win > 0.0) {
      // The cube-depth lookup sees the actual posed hull. Its shadow camera
      // uses a vessel-only layer so this does not redraw the ocean six times.
      // Crucially, fragments outside the 7.5 m light volume never sample the
      // cube either: on a wide ocean view that is nearly the whole screen.
      float lampShadow = lampSurfaceVisibility();
      lampRadiance = LAMP_TINT
        * (uLampEmission * uLampGain * lampShadow * win * win / lampD2);
      // The flame is a sphere, not a point. Widening the lobe by the emitter's
      // angular radius is the whole sphere-light approximation, and it costs
      // nothing: GGX's D is normalised, so a wider lobe spreads the same energy
      // and drops the peak on its own. Without it, a 0.06 lobe multiplied by an
      // inverse square at arm's length puts fireflies on the crests by the raft.
      alphaLamp = min(alphaGlitter + LAMP_RADIUS / (2.0 * lampD), 0.6);
    }
  }

  // --- reflection -----------------------------------------------------
  // The TRUE reflected ray, not a ray bent to the horizon. Roughness widens
  // the lobe, and a wide lobe's average tends towards the cosine-weighted sky
  // mean — which the CPU supplies as a harmonic probe — so the blend below is the
  // physically honest version of what the old horizon bend was reaching for.
  // The bend replaced every pixel's direction with the same bright pale
  // horizon band: it both bleached the mid-distance and erased the per-pixel
  // directional variation that makes water read as textured. It also
  // structurally masks LOD ridging: as footprint folds structure into the
  // variance term, alphaReflect grows and distant pixels sample an
  // increasingly pre-averaged sky, so normal perturbations stop mattering
  // exactly where they become sub-pixel.
  // --- how much sky this parcel of water can actually see ----------------
  // A trough does not see the sky a crest sees: the waves around it stand
  // between, and what they put in the sky's place is more dark water. The
  // shader has always modelled the hull's bite out of the hemisphere and
  // never the sea's own, so every parcel was lit by an identical sky and the
  // near field rendered as a flat wash — measured at a 5-95 luminance spread
  // of 10 levels against 79 in a reference photograph of the same sea under
  // the same sun.
  //
  // The geometry: a parcel sitting below the mean surface, in a field
  // whose neighbours rise at RMS slope s, has its horizon lifted to roughly
  // atan(k·s). The cosine-weighted fraction of a hemisphere above a uniform
  // horizon at elevation e is 1 - sin^2(e), which is what this returns. The
  // CPU supplies sin(e) at full depth; the depth ramp is per-pixel.
  //
  // Deliberately keyed on vHeight — the DISPLACED wave height, not the
  // detail noise — because occlusion is a wave-scale effect. Centimetre
  // ripples do not shadow each other's sky at any angle that matters.
  float waveOpenness;
  {
    float hNorm = vHeight * uWaveOcclusion.x;
    float depth = clamp(0.5 - 0.5 * hNorm, 0.0, 1.0);
    float sinE = uWaveOcclusion.y * depth;
    waveOpenness = clamp(mix(1.0, 1.0 - sinE * sinE, uWaveOcclusion.z), 0.0, 1.0);
  }
  // These occlusion/contrast controls were tuned to shape a bright daylight
  // sea. Stacked over a night whose source radiance is orders of magnitude
  // lower, they erase the reflected horizon and push the remaining swell into
  // display black. Retire only those look controls through the existing
  // astronomical night ramp; uNight=0 preserves day and sunset exactly.
  float nightLookRestore = clamp(uNight, 0.0, 1.0);
  waveOpenness = mix(waveOpenness, 1.0, nightLookRestore);

  vec3 R = reflect(viewDir, N);
  // How far below the horizon this reflection actually pointed, BEFORE the
  // fold below rescues it. That fold is a sampling guard — the sky function
  // has nothing to return below the horizon — but it silently turned every
  // downward ray into an upward one, and the sky just above the horizon is
  // the brightest, palest band there is. So every wave face angled away from
  // the viewer was being handed the horizon glare instead of what it really
  // faces, which is the back of the next wave. That is the pale, overwhelming
  // far field. Keep the fold for sampling, then take back the radiance it
  // was never entitled to.
  float belowHorizon = clamp(-R.y * uHorizonBlock.x, 0.0, 1.0);
  R.y = abs(R.y) * 0.92 + 0.02; // never sample below the horizon
  // The GAS sky only — clouds are deliberately not in the mirror sample.
  // Their radiance reaches the water through the cloud-aware sky probe
  // (and uWaterAmbient), never as drawn shapes, because a wavy surface
  // cannot draw them acceptably at any sampling rate: far away the reflected
  // ray sweeps whole cells per pixel and the layer renders as per-pixel
  // static in the clouds' colour; near by it is resolvable but each swell
  // maps the coverage threshold's level-sets into closed rings around every
  // bump — cores, powder rims, translucent fringes — which reads as an oil
  // slick, not as water under a sky. The gas sky's angular gradients are
  // orders of magnitude gentler, which is why the clouds-off reflection
  // reads as smooth and coherent. Clouds still tint the haze below, where
  // the view ray samples them at dome rates.
  vec3 skySpec = oceanSkyRadiance(R);
  // Two reasons to blend toward the hemisphere mean, with two ceilings. The
  // material lobe (alphaReflect) is a look decision and keeps its 0.55 cap.
  // The sampling term is not a look decision: fwidth(R) is the angular spread
  // between this pixel's reflected ray and its neighbours', and radiance
  // features narrower than that spread — the horizon gradient, the sun's
  // aureole — cannot be drawn by point samples, only impersonated by noise.
  // skyProbe() is the converged answer, and it carries the cloud layer, so this
  // is also where cloud radiance enters the reflection: as the overcast
  // grey-out of a rough sea. Its ceiling sits below 1 so the water never loses
  // all directional life.
  float rJitter = length(fwidth(R));
  float lobeBlend = max(clamp(alphaReflect * 1.6, 0.0, 0.55),
                        smoothstep(0.02, 0.20, rJitter) * 0.85);
  // The wide-lobe limit is the sky averaged about R, NOT one average of the
  // whole dome. That distinction is the difference between a sea that reflects
  // the sky it faces and a sea painted with the mean of a cloudy hemisphere:
  // measured at 62% cover the whole-dome mean is (1.31, 1.41, 1.71), ratios
  // 0.77 : 0.82 : 1.0, which is grey, and it supplied 94% of the far water's
  // red channel. The probe keeps the cloud layer's contribution — that part was
  // right, an overcast sea IS grey — while letting a pixel facing clear zenith
  // reflect clear zenith. Order 2 cannot resolve anything sharper than a
  // hemisphere-scale gradient, so it cannot bring back the per-pixel static
  // that drawing the clouds through the mirror direction would.
  // The mirror asks a directional question; the hemisphere average is kept only
  // as the A/B's other arm. See vesselMirrorVisibility.
  // The wave openness multiplies the mirror too: a trough's reflected ray is
  // as likely to meet the back of the next wave as the sky, and that wave is
  // far darker than what it hides.
  float reflectionVisibility = (uVesselDirectionalMirror > 0.5
    ? vesselMirrorVisibility(R, alphaReflect)
    : skyVisibility) * waveOpenness
    * (1.0 - uHorizonBlock.y * belowHorizon * (1.0 - nightLookRestore));
  vec3 reflection =
    mix(skySpec, skyProbe(R), lobeBlend) * reflectionVisibility * uReflectionGain;

  // Schlick with a roughness-limited F90: a wind-roughened sea never reaches
  // mirror grazing reflectance — slope statistics, shadowing and multi-bounce
  // suppress the flat-surface grazing spike. Without this cap the far field,
  // whose per-pixel normal has been statistically flattened, turns into a
  // uniform sky mirror.
  // 0.55 is the pre-round grazing rolloff the readable navy night was judged
  // under. The harder daylight value is what sharpens a bright horizon, but at
  // night it suppresses one of the sea's last remaining sources of structure.
  float effectiveGrazingRolloff = mix(
    uGrazingRolloff,
    0.55,
    nightLookRestore
  );
  float f90 = 1.0
    - effectiveGrazingRolloff * clamp(alphaReflect * 2.4, 0.0, 0.7);
  // Schlick on the MACRO normal is wrong for a rough sea at grazing, and it is
  // wrong in the direction that ruins the distance. As range grows the Nyquist
  // fades retire the detail and flatten this pixel's normal, so NdV runs to
  // zero, so Fresnel runs to f90 and the far sea turns into a sky mirror —
  // washed out, horizon line barely distinguishable. It becomes a mirror
  // BECAUSE we stopped drawing its roughness, which is exactly backwards.
  //
  // A real sea does not present a flat plane at grazing incidence. It presents
  // the faces of waves, tilted toward the viewer, and those meet the eye at a
  // far steeper angle than the macroscopic one. The visible microfacets are
  // tilted by something like the surface's own RMS slope, which alphaReflect
  // already carries — so lift the incidence cosine by it. A glassy sea (small
  // alpha) still mirrors at grazing, as it should; a rippled one keeps its
  // colour to the horizon, as the reference photographs do.
  float NdVRough = clamp(
    NdV + alphaReflect * uGrazingSlopeLift * (1.0 - nightLookRestore),
    0.0,
    1.0
  );
  float fresnel = 0.0204 + (f90 - 0.0204) * pow(1.0 - NdVRough, 5.0);

  // --- sun and moon glitter -------------------------------------------
  vec3 sunT = lightTransmittance(uSunDir);
  vec3 sunRadiance = uSunTint * sunT * uSunPower;
  // The glitter path must die WITH the disc: a golden streak on the water
  // while the sun is below the sea horizon is light with no source — the
  // old -0.055 gate kept it burning three degrees into dusk. The twilight
  // arch still reflects through the sky-reflection term, which is the glow
  // the water should keep.
  float sunVisible = smoothstep(-0.012, 0.008, uSunDir.y);
  // Behind cloud as well as below horizon: one gate, every direct-sun term.
  // The cloud field is observer-relative on the dome, so the water sample is
  // too. This keeps the pool directly below the gap the observer can see.
  sunVisible *= sunPoolCloudTransmittance(
    vWorldPos.xz - cameraPosition.xz
  );

  // Microfacet Fresnel is F(V·H), the half-vector angle — not F(N·V). The
  // difference is the daylight ocean: at noon from a steep view V·H is small
  // and F ≈ 0.02-0.04, a tenth of the old macrosurface grazing value, which
  // is what confines the glare to a sparkle pool. On the sunset sun-facing
  // path V and L are both near-horizontal, H is near-vertical, V·H stays
  // grazing — and the path keeps its full punch.
  vec3 Hs = normalize(V + uSunDir);
  float fresnelSun = 0.0204 + 0.9796 * pow(1.0 - max(dot(V, Hs), 0.0), 5.0);

  // --- sparkle ----------------------------------------------------------
  // GGX returns the MEAN radiance of the facets inside this pixel. The eye
  // reads their VARIANCE. That distinction is the whole of "why is there no
  // brilliant daylight sparkle": the facets that would mirror an overhead sun
  // have to tilt about 19 degrees, the drawn surface only carries about 4
  // degrees of slope, and the statistical lobe standing in for the rest peaks
  // BELOW display white at midday's 2 % Fresnel — so it renders as a dull
  // sheen at every lobe width. Narrowing the lobe makes it worse, not better,
  // because a narrow lobe puts even less energy that far off-axis.
  //
  // So restore the variance instead of the mean. A lognormal multiplier is
  // the honest way to do it: for g ~ N(0,1), E[exp(a·g − a²/2)] = 1 EXACTLY,
  // so this scatters the same energy into rare brilliant points and many dark
  // ones without adding a photon. Lognormal is also the right shape — glint
  // intensity distributions on water are close to it — and the detail field's
  // value is near-Gaussian once divided by its measured RMS.
  //
  // Fades out with the octave that feeds it, so distant water returns to the
  // plain mean, which is correct: a pixel holding a thousand glints IS its
  // average.
  float sparkle = 1.0;
  if (uSparkleStrength > 0.001) {
    float a = uSparkleStrength * sparkleFade;
    float g = sparkleValue / DETAIL_VALUE_SIGMA;
    sparkle = exp(a * g - 0.5 * a * a);
  }

  vec3 spec = sunRadiance * ggxSpecular(N, V, uSunDir, alphaGlitter)
    * fresnelSun * sunVisible * directSunVisibility * sparkle;

  // A lunar path reads silver-white, not like a second sunset. Atmospheric
  // extinction still attenuates it, but its scalar luminance must not reuse
  // the Sun's red/yellow spectral colouring. uMoonPower already contains the
  // real illuminated-fraction brightness, including an exact zero at new moon.
  vec3 moonT = lightTransmittance(uMoonDir);
  float moonTransmission = dot(moonT, vec3(0.2126, 0.7152, 0.0722));
  vec3 moonRadiance = vec3(moonTransmission) * uMoonPower * uMoonSpecular;
  float moonVisible = smoothstep(-0.03, 0.03, uMoonDir.y) * uMoonCloudTrans;
  vec3 Hm = normalize(V + uMoonDir);
  float fresnelMoon = 0.0204 + 0.9796 * pow(1.0 - max(dot(V, Hm), 0.0), 5.0);
  spec += moonRadiance * ggxSpecular(N, V, uMoonDir, max(alphaGlitter * 0.8, 0.05))
    * fresnelMoon * moonVisible;

  // The lantern's glitter. Identical machinery to the sun's, and the dominant
  // term of the three the lamp contributes: at night the sea is almost purely
  // specular — the body sits at 2e-4 and is going nowhere — so a reflected
  // flame is by far the brightest thing a lantern can put on the water. The
  // geometry helps too. A flame half a metre up seen from a raft puts both V
  // and L near horizontal, which keeps V·H grazing and Fresnel high, so the
  // reflection stays strong right through the pool.
  //
  // No sunVisible-style gate is needed: uLampEmission already ramps the flame
  // in and out over two seconds, and it is the only source in the scene that
  // cannot be occluded by cloud or horizon.
  vec3 Hl = normalize(V + lampL);
  float fresnelLamp = 0.0204 + 0.9796 * pow(1.0 - max(dot(V, Hl), 0.0), 5.0);
  spec += lampRadiance * ggxSpecular(N, V, lampL, alphaLamp) * fresnelLamp;

  // --- body -------------------------------------------------------------
  // Upwelling column radiance: irradiance reflectance Rw = bb/(a+bb) times
  // the downwelling irradiance. Diffuse sky and direct sun enter separately,
  // so the body is cobalt under a high sun and collapses warm-dark at sunset
  // through the sun term's own elevation factor — no time-of-day switch.
  // The sky share is occluded by the waves; the SUN share deliberately is
  // not. The sun is a single direction, either blocked or not, and that
  // question belongs to directSunVisibility — folding a hemisphere-openness
  // term into it would shadow the sun with waves that are nowhere near its
  // line, which is how a sea ends up dark on the side facing the light.
  vec3 bodyIrradiance = uWaterAmbient * uBodyGains.x * skyVisibility * waveOpenness
    + sunRadiance * max(uSunDir.y, 0.0) * uBodyGains.y
      * sunVisible * directSunVisibility;
  vec3 body = uWaterRw * bodyIrradiance;

  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5));
  float backLit = pow(max(dot(V, -sunFlat), 0.0), 4.0);
  float crestN = vHeight * uCrestScale;
  float sss = backLit * clamp(crestN * 1.6, 0.0, 1.0)
    * sunVisible * directSunVisibility;
  body += vec3(0.030, 0.088, 0.092) * sss * sunT * uSunPower * 0.020;

  // The lantern on the body, through one Lambert term and two reflectances: the
  // water column's own Rw on the sun's gain, because this is the same water
  // under the same kind of direct light, plus the near-surface scatter above.
  //
  // The Lambert is where the texture in this term comes from. A flame half a
  // metre up puts lampL nearly horizontal over water a few metres out, and a
  // near-horizontal light grazing a wave field is the classic raking light:
  // dot(N, lampL) swings hard between a face tilted towards the lamp and one
  // tilted away, where the old pool's clamp(N.y) barely moved at all.
  //
  // Inside the Fresnel mix rather than on top of the finished pixel, so a
  // grazing view is handed the reflection instead — which is what a grazing
  // view of water actually shows, and what the old pool overrode at every
  // angle. This keeps the pool reading as water between the glints; the glitter
  // above is what makes it read as *lit* water.
  body += (uWaterRw * uBodyGains.y + LAMP_SCATTER) * lampRadiance * max(dot(N, lampL), 0.0);

  vec3 water = mix(body, reflection, fresnel);
  // Water contrast, before glitter and foam so neither is crushed or blown.
  float waterContrast = mix(uWaterContrast.x, 1.0, nightLookRestore);
  if (abs(waterContrast - 1.0) > 0.001) {
    float wl = dot(water, vec3(0.2126, 0.7152, 0.0722));
    water *= pow(max(wl, 1e-4) / uWaterContrast.y, waterContrast - 1.0);
  }
  vec3 color = water + spec;

  // Fine entrained bubbles remain after the white raft has faded. This is a
  // small lit albedo contribution, not foam texture and not wave displacement:
  // it makes the B-channel band pale without inventing a new surface for
  // buoyancy or dimming the swell that continues through it.
  float wakeBubbleAlpha = clamp(wakeTurbulence * uWakeBubbleHaze, 0.0, 0.35);
  if (wakeBubbleAlpha > 0.001) {
    vec3 bubbleIrradiance =
      uWaterAmbient * uFoamGains.x * skyVisibility * 0.42
      + sunRadiance * uFoamGains.y * sunVisible * directSunVisibility
        * max(dot(N, uSunDir), 0.0) * 0.16
      + uMoonTint * uMoonPower * moonVisible
        * max(dot(N, uMoonDir), 0.0) * 0.12
      + lampRadiance * uFoamGains.y * max(dot(N, lampL), 0.0) * 0.20;
    color += vec3(0.58, 0.64, 0.66) * bubbleIrradiance * wakeBubbleAlpha;
  }

#ifdef OCEAN_DEBUG_VIEW
  // Intermediates the whitewater chain would otherwise keep to itself. Declared
  // out here so the debug block at the end of main can see them, and zeroed so
  // a foam-disabled build still compiles. See Ocean.setDebugView.
  float dbgField = 0.0;
  float dbgResidual = 0.0;
  float dbgTurbulence = 0.0;
  float dbgNearFade = 0.0;
  float dbgCoverage = 0.0;
  float dbgAlpha = 0.0;
#endif

  // ======================================================================
  // WHITEWATER
  // ======================================================================
#ifndef OCEAN_PROFILE_DISABLE_FOAM
  // Three contributions, in order of how far away they matter:
  //
  //   1. the persistent field, which carries real history — where a crest
  //      actually broke, how long ago, and how far it has drifted since;
  //   2. an instantaneous term for the crest that is breaking *right now*,
  //      which the field's finite resolution cannot render sharply enough;
  //   3. a statistical term past the field's extent, because at 700 m a foam
  //      patch is sub-pixel and what the eye reads is coverage, not shape.

  // 1. Persistent field. Both levels are indexed in parameter space, so the
  //    lookup rides the wave orbit and the presentation origin cancels.
  //    The +0.5 must match the injection pass's (vUv - 0.5) exactly, or foam
  //    is drawn half a field away from where it was generated.
  //
  //    The lookup is jittered by a fraction of a texel before sampling. A
  //    bilinearly-filtered isolated texel is a rhombus — four straight edges,
  //    four sharp corners, smooth radial interior — and where foam is sparse
  //    that is exactly what one hot texel becomes on screen. It reads
  //    unmistakably as a rotated quad decal lying on the water, which is the
  //    single most damaging thing foam can look like. Perturbing the sample
  //    position with the same noise field that breaks the foam up destroys the
  //    texel geometry without blurring the field or costing a second fetch.
  //
  //    The multiplier on the jitter noise is 2 * uDetailFreq rather than a
  //    literal, for the reason given at uDetailWrap: only an integer multiple
  //    of the detail frequency survives the mod as an identity. Two rather
  //    than one because the near field's texels are 1.5 m and jitter coarser
  //    than a texel cannot break its shape up.
  //    Each level is faded out by how far the sample is from the centre of its
  //    own texture, in that texture's UV, and not by distance from the disc
  //    centre. Two things follow from that.
  //
  //    The window each texture is valid over is centred on its own level
  //    origin (uFoamNearOrigin/uFoamFarOrigin), and injection covers exactly
  //    that window: outside it the repeat wrap is a tiled copy of water that
  //    is not there, so the fade is what keeps the seam off screen. Keyed on
  //    the UV, the fade is nailed to the window it is protecting and the seam
  //    cannot arrive.
  //
  //    That makes this fade completely unforgiving about where the window is.
  //    The shared origin used to carry the accumulated surface drift, so the
  //    window walked away from the raft at the Stokes-plus-wind rate and this
  //    fade dutifully multiplied the entire persistent field by zero a minute
  //    and a half into any rough sea. Each origin now stays within half a
  //    texel of the observer — it holds only the sub-texel remainder of the
  //    whole-texel content scroll — and the drift is applied to the field's
  //    contents instead. See FoamField.quantizeFoamFieldScroll and
  //    FoamField.drift.
  //
  //    And with the disc centred on the observer rather than the raft, a
  //    radius-keyed fade would put near-field foam around the *camera*, where
  //    there is no foam texture, and none around the raft, where there is.
  //
  //    Chebyshev rather than Euclidean because the window is a square: the
  //    circle inscribed in it throws away the corners for nothing.
  // 0.286 and 0.443 of the near extent are 110 m and 170 m; 0.280 and 0.456 of
  // the far extent are 430 m and 700 m. The same fades, re-expressed.
  float nearFade = foamNearFade;
  float farFade = foamFarFade;
  vec2 field = persistentFoam.rg;

#ifdef OCEAN_DEBUG_VIEW
  dbgField = field.x;
  dbgResidual = field.y;
  dbgTurbulence = persistentFoam.b;
  dbgNearFade = nearFade;
#endif

  // 2. The break happening now. The Jacobian determinant *is* the breaking
  //    indicator — a wave breaks when its crest particles accelerate downwards
  //    faster than gravity holds them, and that acceleration is exactly the
  //    Jacobian's departure from 1. The threshold is calibrated on the CPU
  //    against observed whitecap coverage, not chosen by eye.
  //
  //    The transition band uBreakBand is expressed in units of the breaking
  //    indicator's own standard deviation (computed on the CPU), not as fixed
  //    fractions of the threshold: micro chop widens the indicator's
  //    distribution, and a band fixed in absolute units silently grew the
  //    credited area with it. Constant-in-sigma keeps the transition the same
  //    probability width in every sea state.
  //
  //    Faded on the pixel footprint, not on distance. What this term supplies
  //    is a *sharp* crest edge the field's 1.5 m texels cannot hold, so the
  //    honest question is whether this pixel can still resolve one — and once
  //    the footprint is metres across the answer is no, whether that is because
  //    the water is far away or because it is being seen at a grazing angle
  //    from a hundred metres up. Keyed on radius it also faded around the wrong
  //    centre once the disc started following the camera.
  float live = smoothstep(uBreakBand.x, uBreakBand.y, vCompression);
  live *= clamp(0.25 + 1.0 * dot(slope, uWindDir), 0.0, 1.3);
  live *= catsPawWhitecapDrive;
  live *= 1.0 - smoothstep(1.3, 7.0, footprint);
  // Only the instantaneous ambient break is suppressed. Hull-injected R/G is
  // already in the persistent field and stays white at the stern, while an unrelated crest
  // crossing the worked band is quieter.
  live *= 1.0 - clamp(
    wakeTurbulence * uWakeWhitecapSuppression,
    0.0,
    0.85
  );

  float fresh0 = field.x + live * 0.55 + bowWaveBreakingCoverage;
  float residual = field.y;

  // 3. Statistical far field. Keeps the sea state legible all the way to the
  //    horizon instead of the ocean going smooth exactly where a real one
  //    becomes a field of white.
  //    Keyed on the far field's window for the same reason its fade is: this
  //    term exists to take over exactly where that texture stops being valid.
  //    Its ramp uses the SAME edges as farFade, so field coverage hands off
  //    to statistical coverage exactly — the old offset edges double-counted
  //    in one band and dipped ~26% in the next, which read as hard-edged
  //    square patches at the window edge from altitude.
  float farStat = uWhitecapCoverage * (1.0 - farFade);
  residual += farStat;

  // The worked band keeps a sparse aged-foam fleck texture after G has decayed,
  // instead of being haze alone. Routed through residual, it inherits the
  // breakup, ageing and albedo of old foam — no parallel foam path to drift.
  residual += wakeTurbulence * uWakeTrailFoamFloor;

  // Coverage, calibrated against the field's own statistics rather than eyed in.
  //
  // The field stores a time-averaged breaking fraction, so its absolute scale
  // is small and arbitrary; what is not arbitrary is the *fraction of the
  // surface* that should read as white, which Monahan pins to the wind speed.
  //
  // The gain is measured, not chosen, and it is a uniform because the earlier
  // measurement of it cannot be trusted. That pass counted bright desaturated
  // water pixels — a test the noon sun passes on 35% of an unfoamed Southern
  // frame — over a persistent field that the lookup was fading to zero anyway.
  // See Ocean.setFoamCoverageGain for what replaced it.
  float coverage = clamp((fresh0 * 1.35 + residual) * uFoamCoverageGain, 0.0, 1.6);

#ifdef OCEAN_DEBUG_VIEW
  dbgCoverage = coverage;
#endif

  if (coverage > 0.004 && uFoamStrength > 0.001) {
    // --- breakup ------------------------------------------------------
    // Foam is not a wash, it is a reticulated raft of bubbles with holes at
    // every scale. Thresholding multi-octave noise against the coverage gives
    // that for free, and it gives the *right* time behaviour too: as coverage
    // decays, the threshold rises past more and more of the noise and a solid
    // patch breaks into islands and then into specks. Fragmentation falls out
    // of the decay rather than being animated.
    // uDetailFreq, not a literal 0.42. uDetailWrap is 256 detail cells, so
    // mod(vDetail, uDetailWrap) * uDetailFreq lands on a whole number of
    // noise periods and the wrap is an identity. Any other multiplier — 0.42 is
    // right for exactly one sea state, the one whose detail scale happens to be
    // 2.381 — leaves a remainder, and the remainder is a straight axis-aligned
    // discontinuity through the foam every uDetailWrap metres. 614 m at the
    // default scale: a grid, visible from the air, in the breakup, the relief
    // and the sample jitter alike.
    vec2 q = mod(vDetail, uDetailWrap) * uDetailFreq;
    // Streaks: stretch the breakup along the wind so old foam reads as
    // windrows rather than as blobs — except inside the hull trail, where the
    // grain follows the track: wake foam is sheared by the hull's passage,
    // not combed by the wind. B is the trail's own mask, so ambient foam
    // keeps its windrows untouched.
    //
    // Blended as two VALUES, not as one rotated sample position. Rotating the
    // sample moves it by |q| * dtheta, and |q| runs to a full noise period
    // from the lattice origin — hundreds of cells. B decays over tens of
    // seconds, so an angle interpolated on B swung that lever continuously and
    // dragged the entire breakup pattern sideways through a foam patch whose
    // own outline was standing still: a marquee, fast where |q| was large,
    // slow where it was small, reversing across the wrap, and creased along
    // the B contour where the clamp below saturates. Two fixed frames have no
    // such term. Each one's pattern is nailed to the water, and B only decides
    // how much of each is showing.
    //
    // WK-R11: that reasoning was right and the frames were not fixed. Both were
    // live uniforms — the wind's, re-published every frame from a direction
    // that wanders with the gust process, and the track's, from the
    // instantaneous through-water velocity. Blending the results of two moving
    // frames is still two marquees; it merely stops them being a third. Each
    // frame is now HELD by the CPU latch and only ever released to another
    // constant frame through a cross-fade of the evaluated patterns.
    float wakeGrain = clamp(wakeTurbulence * 2.0, 0.0, 0.85);
    vec2 breakup = foamBreakupFramed(
      q, uFoamWindFrameA, uFoamWindFrameB, uFoamWindFrameBlend
    );
    // Open water takes the false side of a branch that is coherent across
    // whole tiles of it, so ambient foam pays exactly what it paid before and
    // only the trail itself carries the second stack.
    if (wakeGrain > 0.004) {
      vec2 trackGrain = foamBreakupFramed(
        q, uFoamWakeFrameA, uFoamWakeFrameB, uFoamWakeFrameBlend
      );
      breakup = mix(breakup, trackGrain, wakeGrain);
    }
    float n = breakup.x;

    // Widen the threshold with the pixel footprint. A hard threshold on noise
    // finer than a pixel is the classic foam sparkle; widening it converges to
    // the mean instead, which is the correct pre-filtered answer.
    //
    // Measured in *cells* rather than metres, because a cell is what the noise
    // has and the sea state sets its size. 0.216 is 0.09 x 2.4, so this is the
    // same widening at the 2.4 m default detail scale and the right one at the
    // 1.8-3.4 m the presets actually span.
    float breakCell = max(1.0 / max(uDetailFreq, 1e-4), 1e-4);
    float w = clamp(0.09 + 0.33 * footprint / breakCell, 0.09, 0.85);
    // The floor at 0.34 is what stops dense foam becoming a sheet. Driving the
    // threshold to zero would make every pixel of a saturated patch pass, which
    // is a painted rectangle; holding it inside the noise's own range means even
    // the heaviest whitewater keeps holes in it, which is what a bubble raft is.
    float threshold = mix(0.88, 0.34, clamp(coverage, 0.0, 1.0));
    float mask = smoothstep(threshold - w, threshold + w, n);

    // A second, finer erosion. One octave stack thresholded once gives blobs
    // with clean edges; a second cut at a different scale puts holes inside the
    // holes, which is most of the difference between "foam" and "white paint".
    //
    // Pre-filtered on the footprint like the cut above, and for a sharper
    // reason: two applications of OCTAVE_M and a further 1.9 put this layer's
    // cells at a twentieth of the breakup's, which is 12 cm at the default sea
    // state. A hard threshold on 12 cm noise is guaranteed sub-pixel at any
    // distance a camera ever sees foam from, and sub-pixel hard thresholds are
    // per-pixel sparkle that no amount of MSAA can touch — MSAA is a geometry
    // technique and this is a shading discontinuity inside one triangle.
    const float FINE_RATIO = 5.0 * 1.9;
    // Measured standard deviation of fnoisePeriodic about its 0.5 mean. See
    // tools/../scratch: 400k samples give 0.176 for one octave and 0.114 for
    // the weighted three-octave stack above.
    const float FINE_SIGMA = 0.176;
    float fineCell = breakCell / FINE_RATIO;
    float fineW = clamp(0.16 + 0.16 * footprint / fineCell, 0.16, 0.75);
    float fineLevel = 0.36 - 0.35 * clamp(coverage, 0.0, 1.0);
    float fineCut = smoothstep(fineLevel - fineW, fineLevel + fineW, breakup.y);
    // A smoothstep erodes only while its band is NARROW compared with the
    // spread of the noise it cuts. Past that it stops making holes and starts
    // shading — a smooth grey ramp across a third of the distribution,
    // multiplied into the mask — and at this layer's 12 cm cells the band
    // never gets below 0.9 sigma, so it has always been shading and never
    // erosion. That smooth multiplicative field, laid over the coarse islands,
    // is the oil-slick / wood-grain marbling in the wake trail.
    //
    // Converging to the mean is what pre-filtering a threshold actually means,
    // and it is the honest answer here: the layer contributes its average
    // erosion and no pattern. The ramp is kept rather than the layer deleted
    // so that moving FINE_RATIO to a scale a camera can resolve brings a real
    // cut back automatically instead of silently doing nothing.
    float fineMean = smoothstep(fineLevel - fineW, fineLevel + fineW, 0.5);
    float fineResolve =
      1.0 - smoothstep(FINE_SIGMA * 0.30, FINE_SIGMA * 1.00, fineW);
    mask *= mix(fineMean, fineCut, fineResolve);

    // Fresh foam is dense and survives the erosion; old foam is what breaks up.
    //
    // This is the share of the coverage above that is *not* the residual slick,
    // so it has to be built from the same terms with the same gain. It was
    // built with a literal 40.0 — the gain from before the coverage line was
    // recalibrated to 3.1 — which made the numerator about thirteen times the
    // denominator and pinned freshness at 1 for anything but nearly pure
    // residual. Every whitecap in every sea therefore rendered at the fresh
    // albedo with alpha never below 0.65, and foam could not visibly age.
    // Including the live crest term as well: a crest breaking in this frame is
    // the freshest whitewater there is, and reading it as an old slick because
    // the persistent field has not caught up yet is backwards.
    float fresh = clamp((fresh0 * 1.35 * uFoamCoverageGain) / max(coverage, 1e-3), 0.0, 1.0);
    float alpha = clamp(mix(mask, mask * 0.35 + 0.65, fresh) * clamp(coverage * 1.6, 0.0, 1.0), 0.0, 1.0);
    alpha *= uFoamStrength;

#ifdef OCEAN_DEBUG_VIEW
    dbgAlpha = alpha;
#endif

    if (alpha > 0.001) {
      // --- shading ----------------------------------------------------
      // Foam is a dense scattering medium: essentially Lambertian with a high
      // albedo, no specular of its own, and thin at its edges where it is only
      // a few bubbles deep. Fresh foam is whiter and more opaque than old.
      // Aged foam is duller than a fresh whitecap but it is still a raft of
      // bubbles: 0.52 was mid-grey, and mid-grey lit by mean sky irradiance
      // sits BELOW the water behind it wherever the water is showing the
      // bright low sky — which is the whole mid-distance. That inversion,
      // fragmented by the breakup noise, is the "TV static" of dark grains
      // crawling over rough water.
      vec3 albedo = mix(vec3(0.74, 0.77, 0.80), vec3(0.93, 0.95, 0.96), fresh);

      // Relief. Without it foam is a flat sticker; with it, low sun rakes
      // across the bubble structure and it reads as a solid, textured object.
      // 2 * uDetailFreq, for the wrap-identity reason given at q above.
      vec3 nd = noisedPeriodic(mod(vDetail, uDetailWrap) * (2.0 * uDetailFreq));
      float reliefFade = 1.0 - smoothstep(0.6, 2.5, footprint);
      vec3 foamN = normalize(vec3(-nd.y * 0.55 * reliefFade, 1.0, -nd.z * 0.55 * reliefFade));
      float lambert = max(dot(foamN, uSunDir), 0.0);

      // Split irradiance: sky from above, sun along its own direction. Keeping
      // them separate is what makes foam warm at sunset and blue-grey at dusk
      // instead of a single grey that only changes brightness.
      //
      // The sun term takes sunRadiance as-is: it already contains the solar
      // transmittance, and the old second sunT factor squared it — which at
      // noon left whitecaps dimmer than the glare around them, and at sunset
      // annihilated the warm term entirely. One transmittance, honest gain.
      vec3 skyIrradiance = uWaterAmbient * uFoamGains.x * skyVisibility;
      vec3 sunIrradiance = sunRadiance * uFoamGains.y * sunVisible
                         * lambert * directSunVisibility;
      vec3 moonIrradiance = uMoonTint * uMoonPower * 0.35 * moonVisible
                          * max(dot(foamN, uMoonDir), 0.0);
      // The lantern reaches the foam too, and this is where it lands hardest:
      // a bubble raft is a high-albedo Lambertian target, so a whitecap two
      // metres from an open flame is the brightest thing the lamp touches. It
      // was lit by mean sky and moon alone, and simply did not notice that the
      // lamp existed. It now shares the same geometry-shadowed radiance as the
      // water body and glitter, with no late contact-mask special case.
      vec3 lampIrradiance = lampRadiance * uFoamGains.y * max(dot(foamN, lampL), 0.0);

      vec3 foamColor = albedo * (skyIrradiance + sunIrradiance + moonIrradiance + lampIrradiance);

      // Translucency at thin edges: where the mask is only just above the
      // threshold the foam is a few bubbles deep and the water shows through.
      float thin = 1.0 - smoothstep(threshold, threshold + w * 1.6, n);
      foamColor = mix(foamColor, mix(foamColor, color, 0.55), thin * (1.0 - fresh * 0.6));

      // Foam kills most of the specular — a bubble raft has no mirror in it —
      // but as a bounded composite, not a subtraction: the old scheme of
      // subtracting spec * alpha * 0.85 could undershoot the foam's own colour
      // and render whitecaps *darker* than the blown water they sit on.
      // The foam also stands in front of whatever sky the water was about to
      // mirror, and a wet bubble raft is glossy at grazing angles: crediting
      // it with a share of that reflection keys its brightness to the same
      // sky that lights the water, so decayed foam can dim but never invert
      // below the surface it sits on.
      vec3 foamFinal = foamColor + spec * 0.10 + reflection * fresnel * 0.55;
      color = mix(color, foamFinal, alpha);
    }
  }
#endif

  // The old contact circle is gone. Direct shadows now live at their sources:
  // real hull + wave geometry in the Sun map, and real vessel geometry in the
  // lantern cube map. Ambient/environment light remains unshadowed until a
  // general-purpose AO solution earns its frame cost.

  // --- atmospheric perspective ------------------------------------------
  // Blend towards the sky in the *same* view direction, so the horizon
  // dissolves correctly instead of meeting a flat fog colour. Production uses
  // gas-only haze: the dome and reflected-sky cache already carry the clouds,
  // while marching them here makes cost depend catastrophically on wave
  // steepness. CLOUDS_IN_HAZE remains solely for the diagnostic A/B capture.
#ifdef CLOUDS_IN_HAZE
  vec3 hazeColor = oceanSkyWithClouds(viewDir);
#else
  vec3 hazeColor = oceanSkyRadiance(viewDir);
#endif
  float transmit = exp(-dist / uHazeDistance);
  // Hold back a little so the horizon line stays readable rather than vanishing.
  //
  // Only from near the water, though. The hold-back is a 7% step in radiance
  // across the disc's rim, and at 9.9 m of eye height that rim *is* the horizon
  // — the step is the horizon line, and without it the sea dissolves into the
  // sky with nothing to say where one ends. From 267 m up the true horizon is
  // 58 km away and the rim is at 20 km, so the same step draws a hard false
  // horizon 0.86 degrees below the eye with open sea visibly continuing past
  // it. Ramping the hold-back out with altitude keeps the line where it is real
  // and removes it where it is a lie.
  float holdBack = mix(0.93, 1.0, smoothstep(20.0, 150.0, cameraPosition.y));
  color = mix(hazeColor * holdBack, color, transmit);

  // --- airborne salt loading ---------------------------------------------
  //
  // The shallow, wind-aligned mist a gale hangs over the water: the finest
  // fraction of everything the breaking crests throw up, too small to fall out,
  // driven along by the wind and never quite settling. It is the layer that can
  // legitimately take the distance away, and the reason a storm sea reads as
  // dangerous rather than merely large.
  //
  // Three things keep it from being the grey fog plane the brief rules out.
  //
  // It is a VOLUME. Density falls exponentially with height above the mean
  // surface, and the optical depth of a straight ray through an exponential
  // layer has a closed form — so this integrates a real column of air whose
  // thickness depends on where the eye is and where it is looking. From the
  // deck, a horizon ray runs the length of the layer and is heavily obscured
  // while a ray to the nearby trough barely clips it. There is no altitude at
  // which the camera crosses a surface.
  //
  // It is LOCATED. Air is loaded by the crests that broke upwind of it, so the
  // drive is the foam field's active channel sampled a fetch length upwind of
  // this pixel. That single lookup buys everything: the mist is denser downwind
  // of breaking groups because the field is, it gusts because the injection
  // gusts, it builds and clears with the sea state because the field does, and
  // it cannot exist over water that is not breaking. A constant here would have
  // needed all four faked separately and would have been fog.
  //
  // It is LIT LIKE WATER. In-scatter is the sky in the view direction plus a
  // hard forward-scattering sun lobe, the same Mie behaviour that makes the
  // spray sprites flare towards the sun and go dim away from it. Grey fog is
  // what you get from an achromatic constant; this glares downsun and stays
  // legible upsun.
  if (uSaltDensity > 1e-5) {
    float H = max(uSaltScaleHeight, 0.5);
    float y0 = max(vWorldPos.y, 0.0);
    float y1 = max(cameraPosition.y, 0.0);
    float dy = y1 - y0;
    // The integral degenerates as the ray goes horizontal; the limit is the
    // constant-density case, which is what the branch supplies.
    float column = abs(dy) < 0.05
      ? dist * exp(-y0 / H)
      : dist * (H / dy) * (exp(-y0 / H) - exp(-y1 / H));

    vec2 saltUv = (vParam - uWindDir * uSaltFetch - uFoamFarOrigin) / uFoamFarExtent + 0.5;
    float saltEdge = max(abs(saltUv.x - 0.5), abs(saltUv.y - 0.5));
    float saltFade = 1.0 - smoothstep(0.280, 0.456, saltEdge);
    float breaking = texture2D(uFoamFar, saltUv).r * saltFade;
    // Outside the field's window there is no measurement, so this falls back to
    // the well-mixed background rather than to zero. That is both the honest
    // answer — aerosol at this wind is mixed across far more than 700 m — and
    // the necessary one, since past 700 m is exactly where the layer does its
    // work.
    float drive = uSaltFloor + uSaltGain * breaking;

    // Modulating the horizontal drive by its value at the far end of the ray
    // rather than integrating it along the path. For the near-horizontal rays
    // that matter this is where most of the optical depth is, and marching the
    // foam field per pixel to do better would cost more than the whole effect.
    float saltTransmit = exp(-uSaltDensity * drive * column);

    vec3 sunT = lightTransmittance(uSunDir);
    float mu = clamp(dot(viewDir, uSunDir), -1.0, 1.0);
    // Mie forward lobe, same shape the spray sprites use.
    float forward = 0.25 + 2.4 * pow(max(mu, 0.0), 3.0);
    vec3 saltColor = hazeColor * uSaltAmbient
                   + uSunTint * sunT * uSunPower * uSaltSunGain * forward
                     * smoothstep(-0.012, 0.008, uSunDir.y);

    color = mix(saltColor, color, saltTransmit);
  }

  gl_FragColor = vec4(max(color, vec3(0.0)), uOpacity);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // One-LSB screen-space dither at the single point of quantisation. The
  // deep-blue palette lives where adjacent 8-bit codes are visibly far
  // apart; without this the smooth water and sky gradients posterise into
  // flat steps, and any sub-pixel shading noise flickers between exactly two
  // codes at each step's boundary — the "8-bit palette" static. A static
  // hash, not a temporal one: the cure for banding must not shimmer.
  gl_FragColor.rgb += (hash21(gl_FragCoord.xy) - 0.5) * (uQuantiseDither / 255.0);

#ifdef OCEAN_DEBUG_VIEW
  // Diagnostic outputs, written last so they bypass tone mapping, the colour
  // transform and the dither — a measured quantity must arrive at the readback
  // as the number the shader computed, not as its photograph.
  //
  // Mode 1 is the silhouette: flat white wherever the ocean drew, which gives
  // the metrics an exact water/sky mask. Everything downstream that says "of
  // water pixels" is counted against it, so it has to be a mask and not a
  // colour-similarity guess — at the horizon, hazed water and low sky are the
  // same colour, which is precisely where the occlusion measurement lives.
  if (uDebugView > 0.5) {
    vec3 dbg = vec3(0.0);
    if (uDebugView < 1.5)      dbg = vec3(1.0);
    else if (uDebugView < 2.5) dbg = vec3(dbgAlpha);
    else if (uDebugView < 3.5) dbg = vec3(dbgCoverage / 1.6);
    else if (uDebugView < 4.5) dbg = vec3(dbgField, dbgResidual, dbgTurbulence) * 4.0;
    else if (uDebugView < 5.5) dbg = vec3(dbgNearFade);
    else {
      // The breakup grain ALONE, drawn everywhere regardless of coverage.
      //
      // The grain is the only part of the foam that is not stored anywhere: it
      // is re-derived per pixel from vDetail and the streak frame. That makes
      // it the one layer that can slide over water standing still, and this
      // view is the instrument for seeing whether it does. Anything that moves
      // here while the camera, the sea and the field are all frozen is a live
      // input to a lookup that should have none.
      vec2 q = mod(vDetail, uDetailWrap) * uDetailFreq;
      dbg = uDebugView < 6.5
        ? vec3(foamBreakupFramed(q, uFoamWindFrameA, uFoamWindFrameB, uFoamWindFrameBlend).x)
        : vec3(foamBreakupFramed(q, uFoamWakeFrameA, uFoamWakeFrameB, uFoamWakeFrameBlend).x);
    }
    gl_FragColor = vec4(dbg, 1.0);
  }
#endif
#endif
}
`;

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  /**
   * The presentation budget this ocean was built to.
   *
   * Kept so a capture can assert the tier it was actually taken at: the ring
   * grid is baked into the geometry at construction and the octave count can
   * be lowered afterwards by the profile probe, so neither the tier's geometry
   * nor its intent is recoverable from the live material alone. See
   * `render/renderTier.ts`.
   */
  readonly quality: OceanQuality;
  /** Displaced depth twin used only while the Sun's shadow map is rendered. */
  readonly shadowMaterial: THREE.ShaderMaterial;
  /** Spacing in metres per metre of radius — drives the wave LOD fade. */
  readonly lodSpacing: number;

  private readonly waves: WaveField;
  private readonly maximumDetailOctaves: number;
  private readonly waveTexA: THREE.DataTexture;
  private readonly waveTexB: THREE.DataTexture;
  private readonly detailGradientTextures: Partial<
    Record<DetailGradientTextureStyle, THREE.DataTexture>
  > = {};
  private readonly faithfulDetailGradientTextures: Partial<
    Record<FaithfulDetailCacheResolution, THREE.DataTexture>
  > = {};
  private profileSettingsValue: OceanProfileSettings;
  /** A/B scaffolding for the water body's spectral shape. */
  private readonly opticsProfile: OceanOpticsProfile;
  private readonly unsubscribeWaterHue: () => void;
  private residualCategoryModeValue: OceanResidualCategoryMode = 'off';
  private detailCategoryModeValue: OceanDetailCategoryMode = 'off';
  private interiorCutoutModeValue: InteriorCutoutMode = 'stencil';
  private interiorCutoutTexture?: THREE.DataTexture;

  /**
   * The two held breakup frames and the target feeding the wake's.
   *
   * Both latches advance once per `update()`, off the presentation clock, so
   * the grain's stability does not depend on which of the wake controller and
   * the ocean happens to run first in a frame: a target that arrives a frame
   * late is a frame late into a release that takes seconds.
   */
  private readonly windStreakFrame = createFoamStreakFrame();
  private readonly wakeStreakFrame = createFoamStreakFrame();
  private readonly wakeStreakTarget = new THREE.Vector2(0, 0);
  /** Previous `update()` elapsed, for the latch's dt. Negative until seeded. */
  private previousElapsedSeconds = -1;

  private static createWaveParameterTexture(data: Float32Array): THREE.DataTexture {
    const texture = new THREE.DataTexture(
      data,
      MAX_WAVES,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  /** Allocate the diagnostic texture only when its shader variant is selected. */
  private ensureDetailGradientTexture(style: DetailGradientTextureStyle): void {
    let texture = this.detailGradientTextures[style];
    if (!texture) {
      const detailGradientData = createDetailGradientTextureData(512, style);
      texture = new THREE.DataTexture(
        detailGradientData.data,
        detailGradientData.size,
        detailGradientData.size,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      texture.userData.detailGradientRange = [
        detailGradientData.coarseDecodeRange,
        detailGradientData.fineDecodeRange,
      ];
      this.detailGradientTextures[style] = texture;
    }
    const range = texture.userData.detailGradientRange as [number, number];
    this.material.uniforms.uDetailGradientMap.value = texture;
    (this.material.uniforms.uDetailGradientRange.value as THREE.Vector2).set(
      range[0],
      range[1],
    );
  }

  /** Lazily allocate a sampled copy of the shipping analytic gradient field. */
  private ensureFaithfulDetailGradientTexture(
    resolution: FaithfulDetailCacheResolution,
  ): void {
    let texture = this.faithfulDetailGradientTextures[resolution];
    if (!texture) {
      const data = createFaithfulDetailGradientTextureData(resolution);
      texture = new THREE.DataTexture(
        data.data,
        data.size,
        data.size,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.colorSpace = THREE.NoColorSpace;
      texture.needsUpdate = true;
      texture.userData.detailGradientRange = data.decodeRange;
      texture.userData.detailValueRange = data.valueDecodeRange;
      this.faithfulDetailGradientTextures[resolution] = texture;
    }
    this.material.uniforms.uDetailFaithfulMap.value = texture;
    this.material.uniforms.uDetailFaithfulRange.value =
      texture.userData.detailGradientRange as number;
    this.material.uniforms.uDetailValueRange.value =
      texture.userData.detailValueRange as number;
  }
  private readonly breakBandScratch: [number, number] = [0, 0];
  private detailMotionModeValue: DetailMotionMode = 'directional';

  constructor(
    waves: WaveField,
    quality: OceanQuality,
    foamQuality: FoamQuality,
    skyUniforms: Record<string, THREE.IUniform>,
    profile: OceanOpticsProfile = CLEAR_DEEP_OCEAN,
  ) {
    this.waves = waves;
    this.quality = quality;
    this.maximumDetailOctaves = quality.detailOctaves;
    this.profileSettingsValue = {
      vertexWaveSlots: MAX_WAVES,
      residualWaveSlots: MAX_WAVES,
      residualPhaseEnabled: true,
      residualLoopMode: 'active',
      detailOctaves: quality.detailOctaves,
      detailRepresentation: 'analytic',
      detailTextureStyle: 'spectral',
      foamEnabled: true,
      flatFragment: false,
    };

    // Wave parameters as textures, for the `texture` residual loop probe. The
    // textures wrap the SAME Float32Arrays the uWaveA/uWaveB uniforms upload
    // from, so a texelFetch returns bit-identical values; only the access path
    // differs. Kept resident even outside the texture probe — 1.5 KB, uploaded
    // only while a compiled variant actually samples them.
    this.waveTexA = Ocean.createWaveParameterTexture(waves.waveA);
    this.waveTexB = Ocean.createWaveParameterTexture(waves.waveB);
    const rw = waterBodyReflectance(profile);

    const geometry = buildRadialDisc(quality.rings, quality.sectors);

    const K = Math.log(OUTER_RADIUS / INNER_SCALE + 1);
    this.lodSpacing = Math.max(K / quality.rings, (Math.PI * 2) / quality.sectors);
    waves.setLodSpacing(this.lodSpacing);

    const uniforms: Record<string, THREE.IUniform> = {
      // ShaderMaterial only receives the renderer's shadow arrays when it opts
      // into lights and supplies the light uniform records. The ocean still
      // performs all radiometry itself; these records exist solely for the
      // directional shadow texture, matrix and filtering parameters.
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
      ...skyUniforms,
      uWaveA: { value: waves.waveA },
      uWaveB: { value: waves.waveB },
      uResidualWaveA: { value: waves.residualWaveA },
      uResidualWaveB: { value: waves.residualWaveB },
      uResidualActiveCount: { value: waves.residualActiveCount },
      uResidualTotalSlopeEnergy: { value: waves.residualTotalSlopeEnergy },
      uWaveTexA: { value: this.waveTexA },
      uWaveTexB: { value: this.waveTexB },
      uResidualSlotCount: { value: MAX_WAVES },
      uWaveAmp: { value: waves.amplitude },
      uWaveOrigin: { value: new THREE.Vector2() },
      uResidualMaxK: { value: (Math.PI * 2) / quality.residualMinWavelength },
      uWaterRw: { value: new THREE.Vector3(rw[0], rw[1], rw[2]) },
      uWaterAmbient: { value: new THREE.Vector3(1, 1, 1) },
      uBodyGains: { value: new THREE.Vector2(profile.bodySkyGain, profile.bodySunGain) },
      uFoamGains: { value: new THREE.Vector2(profile.foamSkyGain, profile.foamSunGain) },
      uWaveOcclusion: { value: new THREE.Vector3(1, 0, 1) },
      uHorizonBlock: {
        value: new THREE.Vector2(HORIZON_BLOCK_SHARPNESS, DEFAULT_HORIZON_BLOCK),
      },
      uSparkleStrength: { value: DEFAULT_SPARKLE_STRENGTH },
      uReflectionGain: { value: 1 },
      uWaterContrast: { value: new THREE.Vector2(DEFAULT_WATER_CONTRAST, WATER_CONTRAST_PIVOT) },
      uGrazingSlopeLift: { value: DEFAULT_GRAZING_SLOPE_LIFT },
      uRoughnessScale: { value: profile.roughnessScale },
      uReflectLobeRatio: { value: profile.reflectLobeRatio },
      uGrazingRolloff: { value: profile.grazingRolloff },
      // The same placeholder, and the same reason. See `FoamField`'s copy:
      // `update()` publishes both from the frame's present wind, and a
      // plausible-looking 6 m/s standing in for a wind that failed to arrive is
      // a fault nobody would ever see. Zero is a fault anybody would.
      uWindDir: { value: new THREE.Vector2(1, 0) },
      uWindStrength: { value: 0 },
      uCatsPawGustExcessMps: { value: 0 },
      uCatsPawOriginCycles: { value: new THREE.Vector3() },
      uCatsPawAxisXCyclesPerM: { value: new THREE.Vector3() },
      uCatsPawAxisZCyclesPerM: { value: new THREE.Vector3() },
      uDetailAmp: { value: 0.105 },
      uDetailScroll: {
        value: Array.from({ length: MAX_DETAIL_OCTAVES }, () => new THREE.Vector2()),
      },
      uDetailFreq: { value: 1 / 2.4 },
      uDetailWrap: { value: detailWrapPeriod(2.4) },
      uTemporalDetailJitter: { value: new THREE.Vector2() },
      uDetailGradientMap: { value: null },
      uDetailGradientRange: { value: new THREE.Vector2(1, 1) },
      uDetailFaithfulMap: { value: null },
      uDetailFaithfulRange: { value: 1 },
      uDetailValueRange: { value: 1 },
      uDetailOctaveGain: { value: [1, 1, 1, 1, 1, 1] },
      uDetailSkew: { value: new THREE.Vector2(1, 0) },
      uDetailOrigin: { value: new THREE.Vector2() },
      uDetailMotionMode: { value: DETAIL_MOTION_UNIFORM.directional },
      uDetailMorphTime: { value: 0 },
      uHazeDistance: { value: profile.hazeDistanceM },
      uSaltDensity: { value: 0 },
      // 9 m of scale height is chosen against the phenomenon rather than by
      // eye: photographs of a full gale show the mist thinning out somewhere
      // around the height of a crest, and this sea's crests run 4 to 5 m. Well
      // below the embodied eye, so the observer is inside the layer looking
      // along it, which is the geometry that makes it obscure the distance
      // without fogging the sky.
      uSaltScaleHeight: { value: 9.0 },
      uSaltFetch: { value: 55.0 },
      uSaltFloor: { value: 0.25 },
      uSaltGain: { value: 3.5 },
      uSaltAmbient: { value: 0.9 },
      uSaltSunGain: { value: 0.06 },
      uCrestScale: { value: 1 / Math.max(waves.amplitudeSum, 1e-4) },
      uMoonSpecular: { value: profile.moonSpecularGain },
      uSunCloudTrans: { value: 1 },
      uMoonCloudTrans: { value: 1 },
      uSunPoolStrength: { value: 0 },
      uUnresolvedSlopeVariance: { value: 0.01 },
      uFoamNear: { value: null },
      uFoamFar: { value: null },
      uFoamHull: { value: null },
      uFoamNearOrigin: { value: new THREE.Vector2() },
      uFoamFarOrigin: { value: new THREE.Vector2() },
      uFoamHullOrigin: { value: new THREE.Vector2() },
      uFoamNearExtent: { value: FOAM_NEAR_EXTENT },
      uFoamFarExtent: { value: FOAM_FAR_EXTENT },
      uFoamHullExtent: { value: FOAM_HULL_EXTENT },
      uFoamLookupJitter: { value: FOAM_LOOKUP_JITTER_TEXELS },
      uFoamLookupSmoothing: { value: FOAM_LOOKUP_SMOOTHING },
      uLampWorld: { value: new THREE.Vector3() },
      uLampEmission: { value: 0 },
      uLampGain: { value: LAMP_WATER_GAIN },
      uSunShadowEnabled: { value: 1 },
      uLampShadowEnabled: { value: 1 },
      uVesselAoA: { value: new THREE.Vector3() },
      uVesselAoB: { value: new THREE.Vector3() },
      // Overwritten with the active vessel's half-beam; this is only a sane
      // default for the frames before the first update.
      uVesselAoRadius: { value: 2.5 },
      uVesselAoStrength: { value: VESSEL_SKY_OCCLUSION },
      uVesselMirrorOcclusion: { value: VESSEL_MIRROR_OCCLUSION },
      uVesselDirectionalMirror: { value: 1 },
      uVesselOcclusionWide: { value: 0 },
      // Overwritten from the live shadow camera; this is only a sane default
      // for the frames before the first update.
      uSunShadowTexelWorld: { value: 28 / 2048 },
      uSunSoftShadow: { value: 1 },
      uInteriorWorldToLocal: { value: new THREE.Matrix4() },
      uInteriorHalfBreadthMap: { value: null },
      uInteriorCutoutBounds: { value: new THREE.Vector4() },
      uInteriorCutoutGridSize: { value: new THREE.Vector2(1, 1) },
      uInteriorCutoutMargin: { value: 0 },
      uFoamStrength: { value: 1 },
      uFoamBreakup: { value: 0.5 },
      uFoamWindFrameA: { value: new THREE.Vector3(1, 0, 0.3) },
      uFoamWindFrameB: { value: new THREE.Vector3(1, 0, 0.3) },
      uFoamWindFrameBlend: { value: 0 },
      uBreakBand: { value: new THREE.Vector2(0.56, 0.88) },
      uWhitecapCoverage: { value: 0.01 },
      uSprayHint: { value: 0 },
      uOpacity: { value: 1 },
      uQuantiseDither: { value: 1 },
      uFoamCoverageGain: { value: FOAM_COVERAGE_GAIN },
      uWakeBubbleHaze: { value: 0 },
      uWakeWhitecapSuppression: { value: 0 },
      uWakeTrailFoamFloor: { value: 0 },
      uFoamWakeFrameA: { value: new THREE.Vector3(1, 0, 0.3) },
      uFoamWakeFrameB: { value: new THREE.Vector3(1, 0, 0.3) },
      uFoamWakeFrameBlend: { value: 0 },
      uBowMoundCentre: { value: new THREE.Vector2() },
      uBowMoundForward: { value: new THREE.Vector2(0, 1) },
      uBowMoundNormalStrength: { value: 0 },
      uBowMoundRadii: { value: new THREE.Vector2(0.9, 1.6) },
      uShipWakeOrigin: { value: new THREE.Vector2() },
      uShipWakeDir: { value: new THREE.Vector2(0, 1) },
      uShipWakeHullForward: { value: new THREE.Vector2(0, 1) },
      uShipWakeHullLength: { value: 14.3 },
      uShipWakeHalfBeam: { value: 2.5 },
      uShipWakeBowShoulderCentre: { value: new THREE.Vector2(0, -2.4) },
      uShipWakeBowShoulderHalfWidth: { value: 2 },
      uShipWakeBowCrownHalfWidth: { value: 0.65 },
      uShipWakeLambda: { value: 8 },
      uShipWakeStrength: { value: 0 },
      uShipWakeKelvinStrength: { value: 0 },
      uShipWakeLength: { value: 60 },
      uDebugView: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      lights: true,
      defines: {
        // Fixed slot count so the sea state can be swapped without a shader
        // recompile; unused slots carry zero amplitude and are skipped.
        NUM_WAVES: MAX_WAVES,
        NUM_VERTEX_WAVES: MAX_WAVES,
        NUM_RESIDUAL_WAVES: MAX_WAVES,
        OCEAN_PROFILE_RESIDUAL_ACTIVE: '',
        FOAM_NEAR_RESOLUTION: foamQuality.nearResolution,
        FOAM_FAR_RESOLUTION: foamQuality.farResolution,
        FOAM_HULL_RESOLUTION: foamQuality.hullResolution,
        DETAIL_OCTAVES: quality.detailOctaves,
        CLOUD_OCTAVES: quality.cloudOctaves,
        CLOUD_MARCH: quality.cloudMarch,
        CLOUD_SHAPE_OCTAVES: quality.cloudShapeOctaves,
        CLOUD_SUN_STEPS: quality.cloudSunSteps,
        FOAM_BREAKUP_OCTAVES: quality.foamBreakupOctaves,
        NOISE_PERIOD: NOISE_PERIOD.toFixed(1),
        SKY_RADIANCE_LUT: '',
        ...(quality.cloudsInHaze ? { CLOUDS_IN_HAZE: '' } : {}),
      },
      side: THREE.FrontSide,
      fog: false,
    });
    // The water is an open surface, so the usual front->back shadow-side flip
    // would cull it entirely when the Sun looks down on it.
    this.material.shadowSide = THREE.DoubleSide;

    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // Reuse the exact uniform records so a phase/LOD update cannot reach
        // the visible sea one frame before its shadow caster.
        uWaveA: uniforms.uWaveA,
        uWaveB: uniforms.uWaveB,
        uWaveAmp: uniforms.uWaveAmp,
        uWaveOrigin: uniforms.uWaveOrigin,
        uResidualMaxK: uniforms.uResidualMaxK,
      },
      vertexShader: SHADOW_VERTEX_SHADER,
      fragmentShader: SHADOW_FRAGMENT_SHADER,
      defines: {
        NUM_WAVES: MAX_WAVES,
        NUM_VERTEX_WAVES: MAX_WAVES,
      },
      side: THREE.DoubleSide,
      fog: false,
    });

    // A COPY, not the caller's object. `applyOptics` mutates this profile in
    // place, and the argument's default is the shared CLEAR_DEEP_OCEAN module
    // constant — so storing the reference would let one lab slider rewrite the
    // profile every other system, and every test, reads as the shipping water.
    this.opticsProfile = { ...profile };
    // Push the default shape's skew weight. The mid-band gains are rebuilt
    // every frame from `detailShapeValue`, but the skew pair is only written
    // here and by `setDetailShape` — without this the shipping default would
    // silently render with its skew off until something touched a slider.
    this.setDetailShape(this.detailShapeValue);
    this.unsubscribeWaterHue = onColourPipelineChange(() => {
      this.publishWaterBodyColour();
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.renderOrder = 0;
    // The sea stops at the ship's skin. Her interior marks a stencil where it is
    // the nearest surface, and this refuses to draw over the mark — the cabin
    // sole is only 0.15 m above the design waterline and the hold's will be
    // *below* it, so without this the sea is drawn inside the rooms.
    //
    // Begin with the stencil as a constructor-safe fallback: the world-volume
    // path cannot be selected until a vessel has supplied its sampled field.
    // Main switches the schooner to the separately compiled shader-volume
    // production path after that upload. The retained comparison is in
    // OCEAN_INTERIOR_CUTOUT_HANDOVER.md; `interiorStencil.ts` documents the
    // fallback mechanism and its one visual artefact.
    rejectWhereInterior(this.material);
    // The sea receives the vessel's shadow but does NOT cast into the Sun's
    // map. See SHADOW_VERTEX_SHADER for why the caster exists at all and why it
    // is off: a shadow map cannot resolve this surface, and a surface that is
    // not in the map cannot self-shadow. `setSunShadowCasting` re-arms it for
    // the A/B that measured this.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.customDepthMaterial = this.shadowMaterial;

    // Construct the shader and uniforms first, then select the production
    // representation so the faithful map can bind through the same path used
    // by diagnostics and Restore default.
    this.setProfileSettings({
      ...this.profileSettingsValue,
      detailRepresentation: DEFAULT_OCEAN_DETAIL_REPRESENTATION,
    });
  }

  /**
   * Bind the persistent foam field.
   *
   * Every frame, not once: the field is double-buffered so that it can advect
   * its own contents downwind, so which texture holds it alternates.
   */
  attachFoam(
    nearTexture: THREE.Texture,
    farTexture: THREE.Texture,
    hullTexture: THREE.Texture,
    nearOrigin: THREE.Vector2,
    farOrigin: THREE.Vector2,
    hullOrigin: THREE.Vector2,
  ): void {
    this.material.uniforms.uFoamNear.value = nearTexture;
    this.material.uniforms.uFoamFar.value = farTexture;
    this.material.uniforms.uFoamHull.value = hullTexture;
    // The origins ride with the textures: each level scrolls by whole texels
    // and parks its sub-texel remainder in its origin, so origin and contents
    // are two halves of one state and must arrive together.
    (this.material.uniforms.uFoamNearOrigin.value as THREE.Vector2).copy(nearOrigin);
    (this.material.uniforms.uFoamFarOrigin.value as THREE.Vector2).copy(farOrigin);
    (this.material.uniforms.uFoamHullOrigin.value as THREE.Vector2).copy(hullOrigin);
  }

  /**
   * Publish the foam-field reconstruction A/B without recompiling.
   *
   * Uniforms rather than defines because this has to be switchable while the
   * same wake sits on the water: the artifact being judged is what the lookup
   * does to a trail the field has already built, and a recompile that clears
   * nothing still costs the seconds of sailing that built it.
   */
  setFoamLookup(lookup: Readonly<FoamLookup>): void {
    const u = this.material.uniforms;
    u.uFoamLookupJitter.value = Math.max(lookup.jitterTexels, 0);
    u.uFoamLookupSmoothing.value = Math.min(Math.max(lookup.smoothing, 0), 1);
  }

  /**
   * Publish the WK1 B-channel appearance levers without recompiling.
   *
   * All zero is an exact visual off-path: B may continue to decay in the field
   * while the ocean consumes none of it.
   */
  setWakeTrailAppearance(appearance: Readonly<WakeTrailAppearance>): void {
    const u = this.material.uniforms;
    u.uWakeBubbleHaze.value = Math.max(appearance.bubbleHaze, 0);
    u.uWakeWhitecapSuppression.value = Math.max(
      appearance.whitecapSuppression,
      0,
    );
    u.uWakeTrailFoamFloor.value = Math.max(appearance.trailFoamFloor, 0);
  }

  /**
   * Publish the course the trail's foam grain should follow.
   *
   * A TARGET, not the frame. What reaches the shader is the latch's held frame,
   * which changes only when this has left it by the release angle and then only
   * through a cross-fade — because the frame rotates `q` about a lattice origin
   * up to 614 m away, and a frame that tracked this vector continuously slid
   * the grain through the standing trail at metres per second. See
   * `scene/foamStreakFrame.ts`.
   *
   * A negligible-speed target is dropped by the latch rather than here, so the
   * grain does not spin as she coasts to a stop; only injection strength
   * decides visibility.
   */
  setWakeStreakTarget(x: number, z: number): void {
    this.wakeStreakTarget.set(x, z);
  }

  /** Publish WK2's one-block, normal-only bow-mound candidate. */
  setBowMoundAppearance(appearance: Readonly<BowMoundAppearance>): void {
    const u = this.material.uniforms;
    (u.uBowMoundCentre.value as THREE.Vector2).set(
      appearance.centreX,
      appearance.centreZ,
    );
    const length = Math.hypot(appearance.forwardX, appearance.forwardZ);
    (u.uBowMoundForward.value as THREE.Vector2).set(
      length > 1e-8 ? appearance.forwardX / length : 0,
      length > 1e-8 ? appearance.forwardZ / length : 1,
    );
    u.uBowMoundNormalStrength.value = Math.max(
      appearance.normalStrength,
      0,
    );
    (u.uBowMoundRadii.value as THREE.Vector2).set(
      Math.max(appearance.acrossRadiusM, 0.05),
      Math.max(appearance.alongRadiusM, 0.05),
    );
  }

  /** Publish the WK-R4 wave pattern. Strength zero is the exact off-path. */
  setShipWakePattern(appearance: Readonly<ShipWakePatternAppearance>): void {
    const u = this.material.uniforms;
    (u.uShipWakeOrigin.value as THREE.Vector2).set(
      appearance.originX,
      appearance.originZ,
    );
    const length = Math.hypot(appearance.dirX, appearance.dirZ);
    if (length > 1e-8) {
      (u.uShipWakeDir.value as THREE.Vector2).set(
        appearance.dirX / length,
        appearance.dirZ / length,
      );
    }
    const hullForwardLength = Math.hypot(
      appearance.hullForwardX,
      appearance.hullForwardZ,
    );
    if (hullForwardLength > 1e-8) {
      (u.uShipWakeHullForward.value as THREE.Vector2).set(
        appearance.hullForwardX / hullForwardLength,
        appearance.hullForwardZ / hullForwardLength,
      );
    }
    u.uShipWakeHullLength.value = Math.max(appearance.hullLengthM, 4);
    u.uShipWakeHalfBeam.value = Math.max(appearance.halfBeamM, 0.25);
    (u.uShipWakeBowShoulderCentre.value as THREE.Vector2).set(
      appearance.bowShoulderCentreX,
      appearance.bowShoulderCentreZ,
    );
    u.uShipWakeBowShoulderHalfWidth.value = Math.max(
      appearance.bowShoulderHalfWidthM,
      0.25,
    );
    u.uShipWakeBowCrownHalfWidth.value = Math.max(
      appearance.bowCrownHalfWidthM,
      0.1,
    );
    u.uShipWakeLambda.value = Math.max(appearance.wavelengthM, 0.5);
    u.uShipWakeStrength.value = Math.max(appearance.normalStrength, 0);
    u.uShipWakeKelvinStrength.value = Math.max(appearance.kelvinStrength, 0);
    u.uShipWakeLength.value = Math.max(appearance.wedgeLengthM, 1);
  }

  /**
   * Re-publish the water body's reflectance for the A/B switch.
   *
   * Rw = bb/(a+bb), so swapping the backscatter's spectral shape is the whole
   * change; the absorption is untouched. Goes with scene/colourPipeline.ts.
   */
  publishWaterBodyColour(): void {
    const profile = isLegacyWaterHue()
      ? { ...this.opticsProfile, backscatter: LEGACY_FLAT_BACKSCATTER }
      : this.opticsProfile;
    const rw = waterBodyReflectance(profile);
    (this.material.uniforms.uWaterRw.value as THREE.Vector3).set(rw[0], rw[1], rw[2]);
  }

  /**
   * How much salt the air is carrying, as a peak extinction coefficient per
   * metre at the surface.
   *
   * Driven per frame from `CrestSpray.activity`, which has already been through
   * the wind gate, the sea state's spray intensity and the gust modulation. The
   * lag in that smoothing is deliberate and visible: a gust raises the spray
   * first and thickens the air a beat later, which is the order it happens in.
   */
  setSaltLoading(density: number): void {
    this.material.uniforms.uSaltDensity.value = Math.max(density, 0);
  }

  get saltLoading(): number {
    return this.material.uniforms.uSaltDensity.value as number;
  }

  /** Shape controls, for the lab. See the fragment block for what each does. */
  setSaltShape(shape: Partial<{
    scaleHeight: number;
    fetch: number;
    floor: number;
    gain: number;
    ambient: number;
    sunGain: number;
  }>): void {
    const u = this.material.uniforms;
    if (shape.scaleHeight !== undefined) u.uSaltScaleHeight.value = shape.scaleHeight;
    if (shape.fetch !== undefined) u.uSaltFetch.value = shape.fetch;
    if (shape.floor !== undefined) u.uSaltFloor.value = shape.floor;
    if (shape.gain !== undefined) u.uSaltGain.value = shape.gain;
    if (shape.ambient !== undefined) u.uSaltAmbient.value = shape.ambient;
    if (shape.sunGain !== undefined) u.uSaltSunGain.value = shape.sunGain;
  }

  /** Per-frame cloud-slab transmittance and optional spatial sun presentation. */
  setCloudOcclusion(
    sunTrans: number,
    moonTrans: number,
    sunPoolStrength = 0,
  ): void {
    this.material.uniforms.uSunCloudTrans.value = sunTrans;
    this.material.uniforms.uMoonCloudTrans.value = moonTrans;
    this.material.uniforms.uSunPoolStrength.value = Math.min(
      Math.max(sunPoolStrength, 0),
      1,
    );
  }

  get foamCoverageGain(): number {
    return this.material.uniforms.uFoamCoverageGain.value as number;
  }

  /**
   * Scale from the foam field's own density units to rendered coverage.
   *
   * A uniform rather than a constant because it is the one number in the
   * whitewater chain that has to be re-measured whenever anything upstream of
   * it changes, and because it is the sweep the ocean lab most needs to run.
   * See FOAM_COVERAGE_GAIN for what the shipped value is calibrated against.
   */
  setFoamCoverageGain(gain: number): void {
    this.material.uniforms.uFoamCoverageGain.value = gain;
  }

  /**
   * Diagnostic outputs from inside the whitewater chain.
   *
   * Compile-time, so production carries neither the branch nor the five
   * intermediates it reads: a debug view that costs something in the shipping
   * shader is a debug view nobody dares leave in.
   *
   *   0  off — the ocean as drawn
   *   1  silhouette: white wherever the ocean drew, for an exact water mask
   *   2  final foam alpha
   *   3  foam coverage, normalised by its 1.6 clamp
   *   4  persistent field: red active, green residual, x4 to be readable
   *   5  near-level fade — 0 means the near foam texture is contributing
   *      nothing at this pixel, whatever the field holds
   */
  get debugView(): number {
    return this.material.uniforms.uDebugView.value as number;
  }

  setDebugView(mode: number): void {
    const enabled = mode > 0;
    if (enabled !== 'OCEAN_DEBUG_VIEW' in this.material.defines) {
      if (enabled) this.material.defines.OCEAN_DEBUG_VIEW = '';
      else delete this.material.defines.OCEAN_DEBUG_VIEW;
      this.material.needsUpdate = true;
    }
    this.material.uniforms.uDebugView.value = mode;
  }

  get skyRadianceLutEnabled(): boolean {
    return 'SKY_RADIANCE_LUT' in this.material.defines;
  }

  /**
   * Whether atmospheric perspective performs the legacy analytic cloud march.
   * Shipping keeps this off; it remains a compile-time switch so visual A/Bs
   * can restore the exact old shader without leaving a runtime branch behind.
   */
  get cloudsInHazeEnabled(): boolean {
    return 'CLOUDS_IN_HAZE' in this.material.defines;
  }

  setCloudsInHazeEnabled(enabled: boolean): void {
    if (enabled === this.cloudsInHazeEnabled) return;
    if (enabled) this.material.defines.CLOUDS_IN_HAZE = '';
    else delete this.material.defines.CLOUDS_IN_HAZE;
    this.material.needsUpdate = true;
  }

  /**
   * A/B switch. This recompiles rather than taking a runtime branch so the
   * analytic variant contains the original atmosphere work and the LUT variant
   * cannot retain it behind a uniform conditional.
   */
  setSkyRadianceLutEnabled(enabled: boolean): void {
    if (enabled === this.skyRadianceLutEnabled) return;
    if (enabled) this.material.defines.SKY_RADIANCE_LUT = '';
    else delete this.material.defines.SKY_RADIANCE_LUT;
    this.material.needsUpdate = true;
  }

  get profileSettings(): Readonly<OceanProfileSettings> {
    return this.profileSettingsValue;
  }

  /**
   * Apply a diagnostic compile-time variant.
   *
   * Recompilation is intentional: a runtime uniform branch would leave the
   * disabled work in the program and make the benchmark answer ambiguous.
   */
  setProfileSettings(settings: OceanProfileSettings): void {
    const next: OceanProfileSettings = {
      vertexWaveSlots: Math.max(
        0,
        Math.min(MAX_WAVES, Math.round(settings.vertexWaveSlots)),
      ),
      residualWaveSlots: Math.max(
        0,
        Math.min(MAX_WAVES, Math.round(settings.residualWaveSlots)),
      ),
      residualPhaseEnabled: settings.residualPhaseEnabled,
      residualLoopMode: settings.residualLoopMode,
      detailOctaves: Math.max(
        0,
        Math.min(this.maximumDetailOctaves, Math.round(settings.detailOctaves)),
      ),
      detailRepresentation: settings.detailRepresentation,
      detailTextureStyle: settings.detailTextureStyle,
      foamEnabled: settings.foamEnabled,
      flatFragment: settings.flatFragment,
    };
    const previous = this.profileSettingsValue;
    if (
      next.vertexWaveSlots === previous.vertexWaveSlots &&
      next.residualWaveSlots === previous.residualWaveSlots &&
      next.residualPhaseEnabled === previous.residualPhaseEnabled &&
      next.residualLoopMode === previous.residualLoopMode &&
      next.detailOctaves === previous.detailOctaves &&
      next.detailRepresentation === previous.detailRepresentation &&
      next.detailTextureStyle === previous.detailTextureStyle &&
      next.foamEnabled === previous.foamEnabled &&
      next.flatFragment === previous.flatFragment
    ) {
      return;
    }

    this.profileSettingsValue = next;
    this.material.defines.NUM_VERTEX_WAVES = next.vertexWaveSlots;
    this.shadowMaterial.defines.NUM_VERTEX_WAVES = next.vertexWaveSlots;
    this.shadowMaterial.needsUpdate = true;
    this.material.defines.NUM_RESIDUAL_WAVES = next.residualWaveSlots;
    if (next.residualPhaseEnabled) {
      delete this.material.defines.OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE;
    } else {
      this.material.defines.OCEAN_PROFILE_DISABLE_RESIDUAL_PHASE = '';
    }
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_BRANCHLESS;
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_TEXTURE;
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_ROLLED;
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_ACTIVE;
    if (next.residualLoopMode === 'active') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_ACTIVE = '';
    } else if (next.residualLoopMode === 'branchless') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_BRANCHLESS = '';
    } else if (next.residualLoopMode === 'texture') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_TEXTURE = '';
    } else if (next.residualLoopMode === 'rolled') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_ROLLED = '';
    }
    // The rolled probe's bound. Uniform, so setting it never recompiles; it
    // tracks the residual slot count the other variants get as a define.
    this.material.uniforms.uResidualSlotCount.value = next.residualWaveSlots;
    this.material.defines.DETAIL_OCTAVES = next.detailOctaves;
    delete this.material.defines.OCEAN_DETAIL_PREFILTERED;
    delete this.material.defines.OCEAN_DETAIL_CACHED;
    delete this.material.defines.OCEAN_DETAIL_HYBRID;
    if (next.detailRepresentation === 'prefiltered') {
      this.ensureDetailGradientTexture(next.detailTextureStyle);
      this.material.defines.OCEAN_DETAIL_PREFILTERED = '';
    } else if (next.detailRepresentation.startsWith('cached-')) {
      const resolution = Number(
        next.detailRepresentation.slice('cached-'.length),
      ) as FaithfulDetailCacheResolution;
      this.ensureFaithfulDetailGradientTexture(resolution);
      this.material.defines.OCEAN_DETAIL_CACHED = '';
    } else if (next.detailRepresentation === 'hybrid') {
      this.ensureFaithfulDetailGradientTexture(2048);
      this.material.defines.OCEAN_DETAIL_HYBRID = '';
    }
    if (next.foamEnabled) delete this.material.defines.OCEAN_PROFILE_DISABLE_FOAM;
    else this.material.defines.OCEAN_PROFILE_DISABLE_FOAM = '';
    if (next.flatFragment) this.material.defines.OCEAN_PROFILE_FLAT = '';
    else delete this.material.defines.OCEAN_PROFILE_FLAT;
    this.material.needsUpdate = true;
  }

  resetProfileSettings(): void {
    this.setProfileSettings({
      vertexWaveSlots: MAX_WAVES,
      residualWaveSlots: MAX_WAVES,
      residualPhaseEnabled: true,
      residualLoopMode: 'active',
      detailOctaves: this.maximumDetailOctaves,
      detailRepresentation: DEFAULT_OCEAN_DETAIL_REPRESENTATION,
      detailTextureStyle: 'spectral',
      foamEnabled: true,
      flatFragment: false,
    });
  }

  get residualCategoryMode(): OceanResidualCategoryMode {
    return this.residualCategoryModeValue;
  }

  /**
   * Compile the residual category probe in place of normal ocean shading.
   * Each integer count is written directly as one RGBA8 display level, so the
   * readback is lossless and does not pass through tone mapping or colour-space
   * conversion.
   */
  setResidualCategoryMode(mode: OceanResidualCategoryMode): void {
    if (mode === this.residualCategoryModeValue) return;
    this.residualCategoryModeValue = mode;
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_CATEGORIES_A;
    delete this.material.defines.OCEAN_PROFILE_RESIDUAL_CATEGORIES_B;
    if (mode === 'a') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_CATEGORIES_A = '';
    } else if (mode === 'b') {
      this.material.defines.OCEAN_PROFILE_RESIDUAL_CATEGORIES_B = '';
    }
    this.material.needsUpdate = true;
  }

  get detailCategoryMode(): OceanDetailCategoryMode {
    return this.detailCategoryModeValue;
  }

  /** Compile a lossless category pass in place of normal ocean shading. */
  setDetailCategoryMode(mode: OceanDetailCategoryMode): void {
    if (mode === this.detailCategoryModeValue) return;
    this.detailCategoryModeValue = mode;
    delete this.material.defines.OCEAN_PROFILE_DETAIL_CATEGORIES;
    if (mode === 'categories') {
      this.material.defines.OCEAN_PROFILE_DETAIL_CATEGORIES = '';
    }
    this.material.needsUpdate = true;
  }

  /**
   * The raft lamp's flame position and 0..1 emission, per frame.
   *
   * `emission`, not the PointLight's intensity: the deck's light and the sea's
   * are two different renderers reading the same flame, and they must be
   * tunable apart. The water's own scale is `uLampGain`.
   */
  setLamp(flameWorld: THREE.Vector3, emission: number): void {
    (this.material.uniforms.uLampWorld.value as THREE.Vector3).copy(flameWorld);
    this.material.uniforms.uLampEmission.value = emission;
  }

  /**
   * The active vessel's waterline centreline, per frame, in world space.
   *
   * Endpoints rather than a centre and a length, so a heeled or pitching hull
   * occludes along the axis she actually lies on instead of an upright
   * approximation of it.
   */
  setVesselOcclusion(sternWorld: THREE.Vector3, bowWorld: THREE.Vector3): void {
    (this.material.uniforms.uVesselAoA.value as THREE.Vector3).copy(sternWorld);
    (this.material.uniforms.uVesselAoB.value as THREE.Vector3).copy(bowWorld);
  }

  /** Upload the active vessel's canonical swept interior volume once. */
  setInteriorCutoutVolume(volume: InteriorCutoutVolume): void {
    this.interiorCutoutTexture?.dispose();
    const texture = new THREE.DataTexture(
      volume.data,
      volume.width,
      volume.height,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    // Each texel is a conservative whole-cell width, so this is deliberately a
    // nearest lookup rather than interpolation across the sheer's jump to zero.
    // Float-nearest is guaranteed and cannot silently vary by device.
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    this.interiorCutoutTexture = texture;

    const u = this.material.uniforms;
    u.uInteriorHalfBreadthMap.value = texture;
    (u.uInteriorCutoutBounds.value as THREE.Vector4).set(
      volume.zMin,
      volume.zMax,
      volume.yMin,
      volume.yMax,
    );
    (u.uInteriorCutoutGridSize.value as THREE.Vector2).set(
      volume.width,
      volume.height,
    );
    u.uInteriorCutoutMargin.value = volume.margin;
  }

  /** Publish the live vessel pose; inversion carries heel and pitch exactly. */
  setInteriorCutoutTransform(vesselWorld: THREE.Matrix4): void {
    (this.material.uniforms.uInteriorWorldToLocal.value as THREE.Matrix4)
      .copy(vesselWorld)
      .invert();
  }

  /**
   * Switch between genuinely distinct GPU pipelines in one build.
   *
   * The stencil arm contains no discard at all. The shader arm disables the
   * fixed-function stencil read and compiles the world-volume discard, so the
   * paired benchmark measures the HSR consequence the handover calls out.
   */
  setInteriorCutoutMode(mode: InteriorCutoutMode): void {
    if (mode === this.interiorCutoutModeValue) return;
    if (mode === 'shader' && !this.interiorCutoutTexture) {
      throw new Error('Interior shader cutout needs a configured vessel volume');
    }
    this.interiorCutoutModeValue = mode;
    if (mode === 'shader') {
      this.material.defines.OCEAN_INTERIOR_VOLUME_CUTOUT = '';
      this.material.stencilWrite = false;
    } else {
      delete this.material.defines.OCEAN_INTERIOR_VOLUME_CUTOUT;
      rejectWhereInterior(this.material);
    }
    this.material.needsUpdate = true;
  }

  get interiorCutoutMode(): InteriorCutoutMode {
    return this.interiorCutoutModeValue;
  }

  /**
   * World size of one Sun shadow-map texel, from the live shadow camera.
   *
   * Derived rather than assumed: the penumbra is computed in metres and has to
   * be spent in taps, so if the box or the map resolution ever moves, a
   * hard-coded conversion would silently rescale every soft edge in the scene.
   */
  setSunShadowTexelWorld(metresPerTexel: number): void {
    this.material.uniforms.uSunShadowTexelWorld.value = metresPerTexel;
  }

  /** Live A/B: variable penumbra vs three's fixed-width filter. */
  setSunSoftShadow(enabled: boolean): void {
    this.material.uniforms.uSunSoftShadow.value = enabled ? 1 : 0;
  }

  get sunSoftShadowEnabled(): boolean {
    return (this.material.uniforms.uSunSoftShadow.value as number) > 0.5;
  }

  /**
   * The active vessel's half-beam, in metres.
   *
   * Fed rather than assumed, for the same reason the axis is: a raft and a
   * schooner occlude at different scales, and the ocean should not import the
   * ship module to find that out. It was a literal 3.2 — half-beam plus a
   * margin for flare and rig — which put half strength a metre outside her
   * planking and made the skirt read as a disc rather than as contact.
   */
  setVesselOcclusionRadius(halfBeamMetres: number): void {
    this.material.uniforms.uVesselAoRadius.value = halfBeamMetres;
  }

  /** Live A/B for the hull's sky occlusion — both the diffuse and mirror parts. */
  setVesselSkyOcclusion(enabled: boolean): void {
    this.material.uniforms.uVesselAoStrength.value = enabled
      ? VESSEL_SKY_OCCLUSION
      : 0;
    this.material.uniforms.uVesselMirrorOcclusion.value = enabled
      ? VESSEL_MIRROR_OCCLUSION
      : 0;
  }

  /**
   * Live A/B for the reflection's occlusion question.
   *
   * `true` tests the mirror direction against the hull; `false` reuses the
   * hemisphere average, which is what shipped first and what over-darkened
   * dusk.
   */
  setVesselDirectionalMirror(enabled: boolean): void {
    this.material.uniforms.uVesselDirectionalMirror.value = enabled ? 1 : 0;
  }

  get vesselDirectionalMirrorEnabled(): boolean {
    return (this.material.uniforms.uVesselDirectionalMirror.value as number) > 0.5;
  }

  get vesselSkyOcclusionEnabled(): boolean {
    return (this.material.uniforms.uVesselAoStrength.value as number) > 0;
  }

  /** Toggle only the water's directional-map lookup. */
  setSunShadowSampling(enabled: boolean): void {
    this.material.uniforms.uSunShadowEnabled.value = enabled ? 1 : 0;
  }

  /**
   * Diagnostic reference: occlude the direct sun everywhere, ignoring the map.
   *
   * This is the "fully shadowed" end of the scale that a shadow completeness
   * measurement has to be read against. Dimming the sun instead would also dim
   * the sky, and the sky is exactly what a shadow must NOT remove.
   */
  setSunShadowForcedFull(): void {
    this.material.uniforms.uSunShadowEnabled.value = -1;
  }

  /** Toggle only the 83k-vertex displaced depth draw. */
  setSunShadowCasting(enabled: boolean): void {
    this.mesh.castShadow = enabled;
  }

  /** Live Sun-shadow A/B, including both receiver and displaced caster. */
  setSunShadowing(enabled: boolean): void {
    this.setSunShadowSampling(enabled);
    this.setSunShadowCasting(enabled);
  }

  /**
   * Is the water taking the Sun's shadow?
   *
   * Sampling alone. This used to require the ocean to be a caster as well,
   * which was true while the sea cast into the depth map and became a lie the
   * moment it stopped: the water was correctly shadowed by the hull while every
   * readout insisted the Sun shadow was inactive. A diagnostic that reports a
   * working feature as off costs more than no diagnostic. Caster state has its
   * own accessor for the A/B that still needs it.
   */
  get sunShadowingEnabled(): boolean {
    return this.sunShadowSamplingEnabled;
  }

  /** Whether the displaced sea is in the depth pass. A/B only; off in production. */
  get sunShadowCastingEnabled(): boolean {
    return this.mesh.castShadow;
  }

  get sunShadowSamplingEnabled(): boolean {
    return (this.material.uniforms.uSunShadowEnabled.value as number) > 0.5;
  }

  /** Live lantern cube-shadow A/B. Caster submission is owned by Lamp. */
  setLampShadowing(enabled: boolean): void {
    this.material.uniforms.uLampShadowEnabled.value = enabled ? 1 : 0;
  }

  get lampShadowingEnabled(): boolean {
    return (this.material.uniforms.uLampShadowEnabled.value as number) > 0.5;
  }

  /**
   * @param centerX/centerZ  local position the disc is centred on — the
   *        observer, which is the raft up close and blends towards the camera's
   *        ground point as the camera pulls away. See the file header.
   * @param presentationOriginX/Z wrapped local encounter/noise scroll. It may
   *        be derived from vessel velocity, but is never authoritative voyage
   *        position.
   */
  update(
    centerX: number,
    centerZ: number,
    presentationOriginX: number,
    presentationOriginZ: number,
    elapsed: number,
    windDir: THREE.Vector2,
    windStrength: number,
    ambientRadiance: THREE.Vector3,
    skySh: Float32Array,
    detail: {
      scale: number;
      strength: number;
      streak: number;
      catsPaw?: Readonly<CatsPawFieldFrame>;
    },
    whitewater: { strength: number; breakup: number; coverage: number },
  ): void {
    this.mesh.position.set(centerX, 0, centerZ);

    // The texture probe reads wave parameters through these instead of the
    // uniform arrays, and the arrays change every frame (phases at minimum),
    // so re-upload while that variant is compiled in. 1.5 KB per frame.
    if (this.profileSettingsValue.residualLoopMode === 'texture') {
      this.waveTexA.needsUpdate = true;
      this.waveTexB.needsUpdate = true;
    }

    const u = this.material.uniforms;
    // The disc is drawn at a non-zero local position, so its vertices' parameter
    // positions are offset by exactly that amount. This is the single line that
    // keeps the rendered surface in the same space as `WaveField.sample()`.
    (u.uWaveOrigin.value as THREE.Vector2).set(centerX, centerZ);
    u.uWaveAmp.value = this.waves.amplitude;
    const residualActiveCount = Math.min(
      this.waves.residualActiveCount,
      this.profileSettingsValue.residualWaveSlots,
    );
    u.uResidualActiveCount.value = residualActiveCount;
    u.uResidualTotalSlopeEnergy.value =
      residualActiveCount < this.waves.residualActiveCount
        ? this.waves.residualWaveB[residualActiveCount * 4]
        : this.waves.residualTotalSlopeEnergy;
    u.uCrestScale.value = 1 / Math.max(this.waves.amplitudeSum * this.waves.amplitude, 1e-4);
    this.waves.breakBand(this.breakBandScratch);
    (u.uBreakBand.value as THREE.Vector2).set(this.breakBandScratch[0], this.breakBandScratch[1]);

    // Detail geometry. The wrap period is derived from the octave stack rather
    // than assumed, so it stays exact when a preset changes the detail scale.
    const detailScale = Math.max(detail.scale, 0.2);
    const detailFreq = 1 / detailScale;
    const wrap = detailWrapPeriod(detailScale);
    u.uDetailFreq.value = detailFreq;
    u.uDetailWrap.value = wrap;
    u.uDetailAmp.value = detail.strength;

    // Living ripples. Each octave's pattern travels at the gravity-wave phase
    // speed of its own cell size, on its own heading about the wind, so the
    // octaves slide across each other and the summed texture churns instead of
    // drifting as one rigid decal — which is what a shared scroll produced,
    // and what the eye reads as "painted spots". Offsets are integrated here
    // in double precision, mapped into each octave's noise domain by the same
    // integer matrix the shader uses (x' = 2x + z, z' = -x + 2z), and wrapped
    // by the lattice period exactly — so there is no scroll pop at any session
    // length. The sign matters: the offset is subtracted from the sample point
    // for the pattern to move WITH its heading (the old shared scroll got this
    // backwards and crawled the texture upwind).
    const scrollAngles = DETAIL_SCROLL_ANGLES;
    for (let o = 0; o < this.profileSettingsValue.detailOctaves; o++) {
      const cell = detailScale / Math.pow(OCTAVE_SCALE, o);
      // c = sqrt(g·λ/2π) with λ ≈ 2 cells, softened toward what reads well.
      const speed = 0.8 * Math.sqrt(3.12 * cell);
      const cos = Math.cos(scrollAngles[o]);
      const sin = Math.sin(scrollAngles[o]);
      const dx = windDir.x * cos - windDir.y * sin;
      const dz = windDir.x * sin + windDir.y * cos;
      let ox = -dx * speed * elapsed * detailFreq;
      let oz = -dz * speed * elapsed * detailFreq;
      for (let m = 0; m < o; m++) {
        const nx = 2 * ox + oz;
        const nz = -ox + 2 * oz;
        ox = nx;
        oz = nz;
      }
      (u.uDetailScroll.value as THREE.Vector2[])[o].set(
        ((ox % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD,
        ((oz % NOISE_PERIOD) + NOISE_PERIOD) % NOISE_PERIOD,
      );
    }

    // Mid-band shift: lerp each octave's gain toward the candidate table, then
    // renormalise over the ACTIVE octaves so the stack's total drawn slope
    // variance is bit-for-bit invariant in the accounting below. Slope RMS per
    // octave scales by 0.55·sqrt(5) ≈ 1.23 relative to the last, which is the
    // weight the renormalisation must use.
    // Wave-scale sky occlusion geometry, re-derived from the live sea.
    //
    // rms height: Hs = 4σ for a narrow-band sea, so σ = Hs/4. The shader
    // normalises vHeight by this, making the depth ramp scale-free — the same
    // control means the same thing on a millpond and in a gale.
    //
    // horizon: a parcel in a trough looks out at neighbours rising at the
    // field's RMS slope. The coefficient below is the ratio between the mean
    // rise to the ADJACENT crest and the RMS slope: for a sinusoid of
    // amplitude a and wavelength λ the crest half a wavelength away rises 2a
    // over λ/2, a slope of 4a/λ, against an RMS slope of 2πa/(λ√2) = 4.44a/λ
    // — so the adjacent crest sits at about 0.9 of the RMS slope. The extra
    // 0.6 is the tail: the horizon is set by the highest neighbour, not the
    // average one, and a random field's worst neighbour stands well above its
    // mean. This is an estimate of a distribution's upper reach, not a
    // measurement, and it is why `strength` exists as a live control.
    {
      const rmsHeight = Math.max(this.waves.significantHeight * 0.25, 0.02);
      const rmsSlope = Math.sqrt(
        Math.max(this.waves.meanSquareSlope + this.waves.unresolvedSlopeVariance, 0),
      );
      const tanE = 1.5 * rmsSlope;
      const sinE = tanE / Math.sqrt(1 + tanE * tanE);
      (u.uWaveOcclusion.value as THREE.Vector3).set(
        1 / rmsHeight,
        sinE,
        this.waveOcclusionStrength,
      );
    }

    const octaveGains = u.uDetailOctaveGain.value as number[];
    writeDetailOctaveGains(
      octaveGains,
      this.detailShapeValue.midShift,
      this.profileSettingsValue.detailOctaves,
    );

    // Slope variance the detail octaves already draw as real normals. The
    // fragment stage must not also supply it statistically: each octave
    // contributes an rms gradient of amp*gain*freq, and the octave transform
    // scales frequency by sqrt(5) while amplitude falls by 0.55 per level.
    // (The gains are renormalised above, so this sum is invariant under the
    // mid-band shift; it is computed with them anyway so the bookkeeping never
    // depends on that argument staying true.)
    let detailVariance = 0;
    let octaveAmp = detail.strength;
    let octaveFreq = detailFreq;
    for (let o = 0; o < this.profileSettingsValue.detailOctaves; o++) {
      const rms = octaveAmp * octaveGains[o] * octaveFreq;
      detailVariance += 0.5 * rms * rms;
      octaveAmp *= 0.55;
      octaveFreq *= OCTAVE_SCALE;
    }
    u.uUnresolvedSlopeVariance.value = Math.max(
      this.waves.unresolvedSlopeVariance - detailVariance,
      0,
    );

    // These are presentation-only noise coordinates. The local encounter
    // offset advances from canonical velocity on ordinary physics seconds; the
    // enormous ECEF position and accelerated astronomical clock never enter.
    // Wrapping by the stack's own exact period means an origin shift of a whole
    // period is a true no-op rather than an approximate one.
    const rawX = this.detailOriginOverride ? this.detailOriginOverride.x : presentationOriginX;
    const rawZ = this.detailOriginOverride ? this.detailOriginOverride.y : presentationOriginZ;
    const originX = ((rawX % wrap) + wrap) % wrap;
    const originZ = ((rawZ % wrap) + wrap) % wrap;
    (u.uDetailOrigin.value as THREE.Vector2).set(originX, originZ);
    u.uDetailMorphTime.value =
      ((elapsed * DETAIL_EVOLUTION_RATE) % DETAIL_TIME_WRAP + DETAIL_TIME_WRAP) %
      DETAIL_TIME_WRAP;

    // The wind vector itself stays live. Its other consumers use it as a
    // direction to dot against (the whitecap slope bias) or as a bounded
    // translation (the salt-haze fetch), and neither has the |q| arm that makes
    // the breakup frame a marquee lever. Only the frame is latched.
    (u.uWindDir.value as THREE.Vector2).copy(windDir);
    u.uWindStrength.value = windStrength;
    const catsPaw = detail.catsPaw;
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
    this.advanceStreakFrames(elapsed, windDir, detail.streak);
    u.uFoamStrength.value = whitewater.strength;
    u.uFoamBreakup.value = whitewater.breakup;
    u.uWhitecapCoverage.value = whitewater.coverage;

    // Real sky irradiance rather than a normalised colour: the upwelling body
    // colour and the foam must both darken honestly as the light goes.
    (u.uWaterAmbient.value as THREE.Vector3)
      .copy(ambientRadiance)
      .multiplyScalar(this.opticsProfile.ambientIrradianceGain);
    // Raw sky-radiance units, NOT the 5.6-scaled irradiance: this substitutes
    // for skyRadiance(R) inside the rough reflection lobe, so it must live on
    // the same scale as the sky the mirror direction samples.
    (u.uSkySh.value as Float32Array).set(skySh);
  }

  /**
   * Offset only the procedural normal-detail sample within the current pixel.
   *
   * Values are in screen pixels, normally in [-0.5, 0.5]. The fragment shader
   * converts them to parameter space with derivatives; geometry, foam and the
   * residual wave band remain at their unjittered positions. Passing zero is
   * therefore the exact legacy render and is used by every non-temporal probe.
   */
  setTemporalDetailJitter(x: number, y: number): void {
    (this.material.uniforms.uTemporalDetailJitter.value as THREE.Vector2).set(x, y);
  }

  /**
   * Whether this draw ends at the 8-bit canvas and therefore owns the frame's
   * quantisation. Cleared by any presenter that renders the sea into a
   * linear-HDR buffer and dithers at its own output instead — see
   * `uQuantiseDither` in the shader for why leaving it on is not harmless.
   */
  setQuantisationDither(enabled: boolean): void {
    this.material.uniforms.uQuantiseDither.value = enabled ? 1 : 0;
  }

  /**
   * Override the detail-noise origin without touching the wave phase.
   *
   * The two are different quantities and only one of them is periodic. Wave
   * phase shifts by `k (d · origin)`, which is not a multiple of 2π for any
   * finite offset, so moving the presentation origin legitimately changes the
   * wave pattern. The detail stack, by contrast, repeats exactly over
   * `detailWrapPeriod`. Testing wrap continuity by moving the presentation
   * origin therefore measures the wrong thing — the waves change, swamping the
   * question being asked. This lets the harness hold the sea completely still
   * and move only the coordinate that is supposed to be periodic.
   *
   * Pass `null` to return to tracking the presentation origin.
   */
  setDetailOriginOverride(origin: THREE.Vector2 | null): void {
    this.detailOriginOverride = origin ? origin.clone() : null;
  }

  private detailOriginOverride: THREE.Vector2 | null = null;

  /**
   * Advance both breakup-frame latches and publish what the shader draws in.
   *
   * The wind frame's target is the live render-axes wind, gusts and all — the
   * latch is what makes gusts stop mattering, and it is better that the release
   * test sees the real signal than that a filtered one is invented here.
   *
   * The wake frame's target is whatever the wake controller last published. A
   * zero target (she has no way on) is dropped by the latch, which holds the
   * grain rather than spinning it.
   */
  private advanceStreakFrames(
    elapsed: number,
    windDir: THREE.Vector2,
    streak: number,
  ): void {
    const dt =
      this.previousElapsedSeconds < 0 ? 0 : elapsed - this.previousElapsedSeconds;
    this.previousElapsedSeconds = elapsed;

    advanceFoamStreakFrame(
      this.windStreakFrame,
      FOAM_WIND_STREAK_FRAME,
      windDir.x,
      windDir.y,
      streak,
      dt,
    );
    advanceFoamStreakFrame(
      this.wakeStreakFrame,
      FOAM_WAKE_STREAK_FRAME,
      this.wakeStreakTarget.x,
      this.wakeStreakTarget.y,
      streak,
      dt,
    );

    const u = this.material.uniforms;
    publishFoamStreakFrame(
      this.windStreakFrame,
      u.uFoamWindFrameA.value as THREE.Vector3,
      u.uFoamWindFrameB.value as THREE.Vector3,
    );
    u.uFoamWindFrameBlend.value = this.windStreakFrame.blend;
    publishFoamStreakFrame(
      this.wakeStreakFrame,
      u.uFoamWakeFrameA.value as THREE.Vector3,
      u.uFoamWakeFrameB.value as THREE.Vector3,
    );
    u.uFoamWakeFrameBlend.value = this.wakeStreakFrame.blend;
  }

  /** The held breakup frames, for tests and the lab. */
  get foamStreakFrames(): {
    wind: Readonly<FoamStreakFrame>;
    wake: Readonly<FoamStreakFrame>;
  } {
    return { wind: this.windStreakFrame, wake: this.wakeStreakFrame };
  }

  /**
   * Shipping detail shape. Both at 1 — the full mid-band tilt and the full
   * crest skew — which is where the round's A/B landed against Ash's
   * reference photo: the symmetric, fine-weighted stack it replaced reads as
   * rounded mush at arm's length. Zero on both is the pre-round shader
   * exactly, and the lab's sliders reach it.
   */
  private detailShapeValue: OceanDetailShape = DEFAULT_OCEAN_DETAIL_SHAPE;

  /**
   * Multiplier on the derived wave sky-occlusion. 1 is the geometry as
   * derived; the range above it exists because the derivation estimates the
   * upper reach of a distribution (see the note where it is computed) and
   * because the sky a trough loses is the BRIGHT horizon band while what
   * replaces it is dark water — an exchange the cosine-weighted fraction
   * alone understates.
   */
  private waveOcclusionStrength = DEFAULT_WAVE_OCCLUSION_STRENGTH;

  /** Current wave sky-occlusion strength. 0 disables the term entirely. */
  get waveOcclusion(): number {
    return this.waveOcclusionStrength;
  }

  setWaveOcclusion(strength: number): void {
    this.waveOcclusionStrength = Math.min(Math.max(strength, 0), 4);
  }

  /** Lognormal sparkle width. 0 is the plain GGX mean. */
  get sparkleStrength(): number {
    return this.material.uniforms.uSparkleStrength.value as number;
  }

  setSparkleStrength(strength: number): void {
    this.material.uniforms.uSparkleStrength.value = Math.min(
      Math.max(strength, 0),
      2.5,
    );
  }

  /** Straight multiplier on the mirrored sky. 1 is Fresnel's own answer. */
  get reflectionGain(): number {
    return this.material.uniforms.uReflectionGain.value as number;
  }

  setReflectionGain(gain: number): void {
    this.material.uniforms.uReflectionGain.value = Math.min(
      Math.max(gain, 0),
      1.5,
    );
  }

  /** Roughness lift on the grazing Fresnel. 0 is the old sky-mirror distance. */
  get grazingSlopeLift(): number {
    return this.material.uniforms.uGrazingSlopeLift.value as number;
  }

  setGrazingSlopeLift(lift: number): void {
    this.material.uniforms.uGrazingSlopeLift.value = Math.min(
      Math.max(lift, 0),
      3,
    );
  }

  /** Water contrast exponent: the spread between its darkest and lightest. */
  get waterContrast(): number {
    return (this.material.uniforms.uWaterContrast.value as THREE.Vector2).x;
  }

  setWaterContrast(exponent: number): void {
    (this.material.uniforms.uWaterContrast.value as THREE.Vector2).x = Math.min(
      Math.max(exponent, 0.5),
      2.5,
    );
  }

  /** How much a below-horizon reflected ray loses. 0 is the old fold. */
  get horizonBlock(): number {
    return (this.material.uniforms.uHorizonBlock.value as THREE.Vector2).y;
  }

  setHorizonBlock(strength: number): void {
    (this.material.uniforms.uHorizonBlock.value as THREE.Vector2).y = Math.min(
      Math.max(strength, 0),
      1,
    );
  }

  /** Current laboratory animation model for the unresolved normal-detail band. */
  get detailMotionMode(): DetailMotionMode {
    return this.detailMotionModeValue;
  }

  /** Switch detail animation without rebuilding the material or resetting time. */
  setDetailMotionMode(mode: DetailMotionMode): void {
    this.detailMotionModeValue = mode;
    this.material.uniforms.uDetailMotionMode.value = DETAIL_MOTION_UNIFORM[mode];
    if (
      mode !== 'directional' &&
      (this.profileSettingsValue.detailRepresentation.startsWith('cached-') ||
        this.profileSettingsValue.detailRepresentation === 'hybrid')
    ) {
      this.setProfileSettings({
        ...this.profileSettingsValue,
        detailRepresentation: 'analytic',
      });
    }
  }

  /** Live shape of the detail band. (0, 0) is the shipping look exactly. */
  get detailShape(): OceanDetailShape {
    return { ...this.detailShapeValue };
  }

  /**
   * Reshape the detail band without touching its energy.
   *
   * `midShift` tilts the drawn octave spectrum toward the 0.3–1.1 m window
   * (see DETAIL_MID_SHIFT_TABLE); `crestSkew` concentrates each octave's slope
   * on the high side of its own noise value — peaked crests, flattened
   * troughs. Both are variance-neutral by construction: the octave gains are
   * renormalised every frame and the skew weight carries the measured
   * normalisation from `detailSkewNormalisation`, so neither slider can
   * brighten, roughen or polish the sea — they only redistribute what the
   * stack already draws.
   */
  setDetailShape(shape: OceanDetailShape): void {
    this.detailShapeValue = {
      midShift: Math.min(Math.max(shape.midShift, 0), 1),
      crestSkew: Math.min(Math.max(shape.crestSkew, 0), 1),
    };
    const skew = this.detailShapeValue.crestSkew * DETAIL_SKEW_MAX;
    const normalisation = detailSkewNormalisation(skew);
    (this.material.uniforms.uDetailSkew.value as THREE.Vector2).set(
      normalisation,
      normalisation * skew,
    );
  }

  /**
   * The live optics profile. The hull's reflected sea reads the SAME object
   * every frame (main's worldRadianceInputs), so a change applied here moves
   * both waters together — one water, one brightness.
   */
  get optics(): OceanOpticsProfile {
    return this.opticsProfile;
  }

  /** Weather visibility through the existing haze term, without reapplying optics. */
  setHazeDistanceM(hazeDistanceM: number): void {
    if (!Number.isFinite(hazeDistanceM) || hazeDistanceM <= 0) {
      throw new RangeError(
        `ocean haze distance must be finite and > 0, got ${hazeDistanceM}`,
      );
    }
    this.opticsProfile.hazeDistanceM = hazeDistanceM;
    this.material.uniforms.uHazeDistance.value = hazeDistanceM;
  }

  /**
   * Mutate the live optics profile and push every affected uniform.
   *
   * This is the water-optics A/B's engine: the lab applies
   * SHIPPING_BODY_OPTICS or DERIVED_BODY_OPTICS (or a slider's single field)
   * and the frame after is lit under the new chain. Absorption/backscatter
   * changes re-derive Rw; everything else is a direct uniform copy.
   */
  applyOptics(patch: Partial<OceanOpticsProfile>): void {
    Object.assign(this.opticsProfile, patch);
    const profile = this.opticsProfile;
    const u = this.material.uniforms;
    const rw = waterBodyReflectance(profile);
    (u.uWaterRw.value as THREE.Vector3).set(rw[0], rw[1], rw[2]);
    (u.uBodyGains.value as THREE.Vector2).set(
      profile.bodySkyGain,
      profile.bodySunGain,
    );
    (u.uFoamGains.value as THREE.Vector2).set(
      profile.foamSkyGain,
      profile.foamSunGain,
    );
    u.uRoughnessScale.value = profile.roughnessScale;
    u.uReflectLobeRatio.value = profile.reflectLobeRatio;
    u.uGrazingRolloff.value = profile.grazingRolloff;
    u.uHazeDistance.value = profile.hazeDistanceM;
    u.uMoonSpecular.value = profile.moonSpecularGain;
  }

  /** Re-apply mesh-dependent wave settings after the sea state changes. */
  refresh(): void {
    this.waves.setLodSpacing(this.lodSpacing);
    this.material.uniforms.uCrestScale.value =
      1 / Math.max(this.waves.amplitudeSum * this.waves.amplitude, 1e-4);
    this.material.uniforms.uUnresolvedSlopeVariance.value = this.waves.unresolvedSlopeVariance;
    this.waves.breakBand(this.breakBandScratch);
    (this.material.uniforms.uBreakBand.value as THREE.Vector2).set(
      this.breakBandScratch[0],
      this.breakBandScratch[1],
    );
  }

  dispose(): void {
    this.unsubscribeWaterHue();
    this.mesh.geometry.dispose();
    this.waveTexA.dispose();
    this.waveTexB.dispose();
    this.interiorCutoutTexture?.dispose();
    Object.values(this.detailGradientTextures).forEach((texture) => texture.dispose());
    Object.values(this.faithfulDetailGradientTextures).forEach((texture) =>
      texture.dispose(),
    );
    this.shadowMaterial.dispose();
    this.material.dispose();
  }
}
