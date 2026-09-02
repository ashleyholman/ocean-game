import * as THREE from 'three';
import type { Mat3d } from '../astronomy/AstronomyProvider';
import { eqjDirectionFromRaDec } from '../astronomy/AstronomyProvider';
import {
  BRIGHT_STAR_CATALOGUE,
} from '../astronomy/data/brightStars.generated';
import { vec3 } from '../world/math';
import {
  GLSL_CLOUD_CACHE_LOOKUP,
  GLSL_CLOUD_DOME_MAPPING,
  GLSL_LOG_DEPTH_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_FRAGMENT,
  GLSL_LOG_DEPTH_PARS_VERTEX,
  GLSL_LOG_DEPTH_VERTEX,
} from './shaders/lib';

/**
 * The radius the dome's vertex positions are BUILT at.
 *
 * Not the distance the dome is drawn at. `update` scales the mesh so the dome
 * sits where `starDomeRadiusM` puts it; see the discussion there. Because the
 * pass sets `gl_PointSize` explicitly and the mesh is translated to the camera
 * every frame, the radius is invisible in x/y — it only decides what DEPTH the
 * star field writes into the test against solid geometry.
 */
const STAR_RADIUS = 485;

/**
 * Where the star dome sits in depth, and why it moved.
 *
 * Stars are at infinity. Every solid thing in the world is nearer than they
 * are, so the depth test — which this pass already runs, and which is what lets
 * a sail or a shroud mask the catalogue — should reject a star wherever any
 * geometry was drawn. It did not, because the dome was built at 485 m: nearer
 * than the headland at 6 km, nearer than the sea past half a kilometre, nearer
 * than anything the terrain harness can mount. A star drew straight through a
 * 3,000 m massif and no depth mode could have helped, because the arithmetic
 * was right and the position was wrong (TERRAIN_ROUND_HANDOVER "Stars punch
 * through terrain"; depth-candidates.md "Also found while here").
 *
 * The fix is to put the dome where the stars are: just inside the far plane,
 * behind every opaque thing the camera can see. `camera.far` is the anchor
 * rather than a constant because the terrain harness raises it (`&far=`, and
 * `range` + 40 km of margin), so a fixed distance would be overtaken the first
 * time a peak was mounted at 120 km.
 *
 * Two consequences on screen, and both are the same bug being corrected:
 *
 *  * Terrain now occludes stars. That is the fix.
 *  * The sea past 485 m now occludes stars below the horizon, where before
 *    only the sea WITHIN 485 m did. The size of that second population is
 *    bounded by arithmetic already in this shader, not by taste. Below the
 *    horizon `airMass` is clamped at `1/0.035`, so extinction is pinned at
 *    exactly 6.893 magnitudes; visibility needs `mEff < uLimitMag + 0.40`, and
 *    the darkest sky the model produces is `uLimitMag = 6.2`. So no star
 *    fainter than magnitude -0.293 can render below the horizon AT ALL, in any
 *    conditions. `horizonCut` stops at -0.012 rad, and the sea within 485 m
 *    already covered everything below -h/485, so the band that changes is
 *    empty above an eye height of 5.8 m and at most 0.39 deg tall at the
 *    embodied 3.4 m eye. `tests/graphics.test.ts` pins the magnitude bound and
 *    counts the catalogue against it.
 *
 * `?starDome=near` restores the 485 m dome for an A/B.
 *
 * Depth precision was checked rather than assumed. The tight case is the
 * smallest adaptive near plane (0.06 m) against the harness far plane the
 * default headland forces (46 km): the window-depth gap between the 6 km
 * headland and a dome at 45.1 km is 8.7e-6, which is 145 steps of a 24-bit
 * buffer. The gap only grows as the near plane rises to its 5.35 m setting.
 */
export const STAR_DOME_FAR_FRACTION = 0.98;

/** The dome distance this pass shipped with, and the `?starDome=near` A/B. */
export const STAR_DOME_LEGACY_RADIUS_M = STAR_RADIUS;

/** `CameraSystem`'s production far plane; the fallback when none is supplied. */
export const STAR_DOME_DEFAULT_FAR_M = 25000;

export type StarDomeAnchor = 'far' | 'near';

/**
 * Dome radius in metres for a given far plane.
 *
 * Floored at the legacy radius so a diagnostic camera with an unusually short
 * far plane pulls the dome IN rather than collapsing it onto the vessel.
 */
export function starDomeRadiusM(
  cameraFarM: number,
  anchor: StarDomeAnchor = 'far',
): number {
  if (anchor === 'near') return STAR_DOME_LEGACY_RADIUS_M;
  const far =
    Number.isFinite(cameraFarM) && cameraFarM > 0
      ? cameraFarM
      : STAR_DOME_DEFAULT_FAR_M;
  return Math.max(STAR_DOME_LEGACY_RADIUS_M, far * STAR_DOME_FAR_FRACTION);
}

/**
 * Magnitudes of extinction a star below the horizon always carries.
 *
 * `airMass = 1 / max(altitude, 0.035)` clamps at the horizon, so this is a
 * constant down there rather than a limit approached. Exported because the
 * sub-horizon bound above is a claim about the shipped numbers, and a claim
 * about shipped numbers should be a test.
 */
export const STAR_HORIZON_EXTINCTION_MAG = 0.25 * (1 / 0.035 - 1);

/** Device-pixel support and PSF width chosen to conserve energy in motion. */
export const STAR_POINT_SUPPORT_PX = 4;
export const STAR_CORE_SIGMA_PX = 0.56;
export const STAR_TWINKLE_MIN_AMPLITUDE = 0.018;
export const STAR_TWINKLE_MAX_AMPLITUDE = 0.050;
const STAR_CORE_NORMALIZATION =
  1 / (2 * Math.PI * STAR_CORE_SIGMA_PX * STAR_CORE_SIGMA_PX);

/**
 * The render scale every pixel figure in this file is quoted at.
 *
 * Adaptive resolution lowers `renderer.setPixelRatio`, so the buffer shrinks
 * and the browser upscales it back to CSS size. Everything here is measured in
 * RENDER pixels, and a render pixel is not a fixed piece of the screen — which
 * broke the star field in two separate ways when the cap dropped:
 *
 *  * The halo grew. A sigma fixed in render pixels covers twice the angle when
 *    the ratio halves, and the upscale makes that visible one-for-one.
 *  * Faint stars brightened. The core PSF is normalized to unit integral over
 *    RENDER pixels, so its peak per render pixel is scale-independent — but at
 *    half ratio each of those pixels is displayed over four times the area, so
 *    the light a star actually puts on the screen went up fourfold. A star
 *    that was one dim pixel became a 2x2 block of the same brightness.
 *
 * `starResolutionScale` is the correction, and 2 is the reference because that
 * is the ratio the levels in this file were judged at. At the reference it is
 * exactly 1, so nothing about the tuned look moves; below it, halo sigma is
 * scaled so the glare keeps its ANGULAR size, and the core normalization is
 * scaled by its square so a star keeps its total displayed light instead of
 * its per-pixel peak.
 *
 * The core's own sigma is deliberately NOT scaled down. 0.56 is a sampling
 * floor, not a look: below it a point starts to alias as it crosses the pixel
 * grid, which is the artefact the analytic PSF exists to prevent. So at low
 * resolution a star is allowed to be angularly larger than ideal — there are
 * not enough pixels for it to be otherwise — but the energy correction means
 * it dims as it spreads rather than blooming.
 */
export const STAR_REFERENCE_PIXEL_RATIO = 2;

/** Render scale relative to the ratio the field was tuned at, capped at 1. */
export function starResolutionScale(pixelRatio: number): number {
  return Math.min(pixelRatio, STAR_REFERENCE_PIXEL_RATIO) /
    STAR_REFERENCE_PIXEL_RATIO;
}

/**
 * Photometry: how a magnitude becomes an intensity.
 *
 * The physical law is `10^(-0.4 m)` — five magnitudes is exactly a hundredfold
 * — and this pass now uses it. It previously used `10^(-0.23 m)`, a little
 * over half the stops, on the reasoning that the true range would not fit an
 * additive 8-bit pass. It does not fit, and that is fine: the top of the range
 * is SUPPOSED to run out of display, which is what `STAR_GLARE_*` below is
 * for. What the compression actually did was flatten the middle, where the
 * catalogue's mass lives. Measured on the 4.5-limited catalogue it shipped
 * with: 739 of 925 stars — four fifths of the sky — landed between 0.25 and
 * 0.33 of display white. A 1.3x spread across almost every star on screen is
 * why the field read as one uniform sprinkle of identical dots.
 *
 * The exponent is a uniform rather than a constant so the graphics panel can
 * A/B it live against the shipped look without a recompile.
 */
export const STAR_MAGNITUDE_EXPONENT = 0.4;
export const STAR_LEGACY_MAGNITUDE_EXPONENT = 0.23;

/**
 * The magnitude the ladder is pinned by, and the intensity it gets.
 *
 * Steepening the exponent pivots the whole population around some magnitude,
 * and WHICH magnitude decides whether the sky gets brighter or merely wider.
 * The first attempt pivoted about second magnitude and held its old level,
 * which was the wrong end entirely: measured against this renderer, intensity
 * 0.32 already saturates a pixel, so pinning magnitude 2 at 0.347 clipped
 * every star from second magnitude up and left Sirius five stops past white —
 * which is precisely how a star ends up wearing a halo the size of the moon.
 *
 * So the pin is at the FAINT end, where there is somewhere to go. Fifth
 * magnitude is the rung: the faintest thing an unhurried naked eye picks out
 * without knowing where to look, and — this is the point — comfortably above
 * the visibility rolloff, so it is a rung the ladder actually stands on rather
 * than one already being faded out.
 *
 * The intensity was settled by counting rather than by arithmetic, because the
 * arithmetic lies: the display transform is not linear down here, and a first
 * attempt that extrapolated a linear coefficient landed four times too dark.
 * What was actually measured is the population — star pixels above a given
 * excess over the sky they sit on, differenced against the same frame with the
 * pass hidden so the Milky Way and the sky gradient cancel exactly. Over a
 * 1209 x 916 window of sky:
 *
 *     anchor      +3 codes   +8    +20   +60
 *     0.0219      1810       1194  668   192    <- the first pass; too hot
 *     0.0050       ~800       ~440  ~190   ~40   <- here
 *     0.0013        250         95    27     7   <- too dark, field empties
 *
 * The shipped value is 0.010, twice the middle rung above and a 2.2x pull-back
 * from the first pass, settled at the wheel. The shape is what the counting
 * bought: the mass of the catalogue sits low, a tinge over the sky rather than
 * something the eye reads without trying, with only the top of the ladder
 * genuinely bright.
 *
 * Beware when checking this by eye through a downscaled screenshot: a faint
 * star is ONE pixel, and a 2:1 downsample divides its excess by four. The
 * counts above are the honest instrument; a half-resolution capture of this
 * sky looks emptier than the sky is.
 */
export const STAR_ANCHOR_MAGNITUDE = 5;
export const STAR_ANCHOR_INTENSITY = 0.01;

/**
 * Glare: where the range continues after the display runs out.
 *
 * Past display white a point cannot get brighter, only bigger — the extra
 * range in a real night sky (and in a photograph of one) arrives as spread,
 * from scatter in the eye and in the optics. So the halo is driven by how far
 * a star's intensity exceeds the display, in stops, and not by a threshold on
 * catalogue magnitude as it was before. Two things follow for free. Extinction,
 * the twilight arch and cloud all shrink the halo along with the core, because
 * they are already in the intensity it reads; and a star that is bright only
 * because it is high in a dark sky glares exactly as much as its brightness
 * earns, with no second magnitude cutoff to drift out of agreement with the
 * first.
 *
 * The SIZE of it is the thing to keep honest, and the first pass got it badly
 * wrong. Measured on the brightest star in a quadrant, the width of its
 * footprint standing more than 20 display codes over the sky:
 *
 *     sigma 3.9 (first pass)   18 device px, still +22 to +108 out at 6-12 px
 *     sigma 1.7                 8 device px, gone by 5 px
 *     sigma 1.0 (shipped)       6 device px, essentially just the core
 *
 * The wide one read as the moon rather than a star. The onset sits a little
 * under display white, so about a dozen stars in the catalogue glare at all,
 * and at the shipped sigma the glare is a tight thickening of the point rather
 * than a disc around it. Bright stars are meant to look PIERCING, not large.
 */
const STAR_GLARE_ONSET = 0.06;
const STAR_GLARE_STOPS = 3.2;
const STAR_HALO_SIGMA_MIN_PX = 0.9;
export const STAR_HALO_SIGMA_MAX_PX = 1;
const STAR_HALO_AMPLITUDE = 0.09;

/**
 * Optical depths of cloud a point source must burn through, relative to what
 * the sky's appearance alpha reports.
 *
 * 1.0 is the old linear composite, and is what let stars sit on top of an
 * overcast deck. 5 is the working value: a wisp reporting alpha 0.3 still
 * passes about a sixth of a star, which is what a real thin veil does, while
 * the densest alpha the bake can write — 0.935 at the zenith — passes about
 * one part in a million. A uniform, so the panel can walk it against the sky
 * and settle the "how thin is a veil" question by watching.
 */
export const STAR_CLOUD_BEAM_POWER = 5;
export const STAR_LEGACY_CLOUD_BEAM_POWER = 1;

/**
 * Real catalogue stars as crisp astronomical points.
 *
 * Visibility is magnitude-dependent and driven by the CPU's limiting-magnitude
 * estimate (`TimeOfDay.limitingMagnitude`), so bright stars emerge first in
 * twilight and the full catalogue needs genuine darkness. Per-star work all
 * happens in the vertex shader from static attributes — there is no per-star
 * CPU cost, ever.
 *
 * Brightness is carried by intensity, not by sprite diameter. The raster point
 * is only a support footprint for a device-pixel analytic PSF; its normalized
 * energy stays stable as the star crosses the pixel grid. The halo is separate
 * support on top, sized by the glare the star actually earns.
 */

const VERTEX_SHADER = /* glsl */ `
precision highp float;

${GLSL_LOG_DEPTH_PARS_VERTEX}

const float PI = 3.141592653589793;

attribute float aPointSize;
attribute float aMagnitude;

uniform float uPixelRatio;
uniform float uFade;
uniform float uLimitMag;
/** Presentation time only: scintillation continues while astronomy is paused. */
uniform float uTime;
/** Unit vector toward the sunset point on the horizon (render space). */
uniform vec3  uTwilightDir;
/** Extra magnitudes of sky glow at the arch's centre; 0 in full night. */
uniform float uTwilightPenalty;
/** Magnitude-to-intensity exponent; 0.4 is physical, 0.23 the legacy A/B. */
uniform float uMagnitudeExponent;
/** Intensity of a star at STAR_ANCHOR_MAGNITUDE; the whole ladder hangs here. */
uniform float uAnchorIntensity;
/** Widest glare sigma in device pixels, for the brightest star in the sky. */
uniform float uHaloSigmaMax;
/** Render scale against the reference ratio; 1 at full resolution. */
uniform float uResolutionScale;
/** How completely a cloud's optical depth extinguishes a point source. */
uniform float uCloudBeamPower;
/** The displayed cloud generation and its live advection. */
uniform vec2 uCloudOffset;
uniform vec2 uCloudDriftBase;
uniform float uCloudOpacity;

${GLSL_CLOUD_DOME_MAPPING}
${GLSL_CLOUD_CACHE_LOOKUP}

varying vec3 vColor;
varying float vIntensity;
varying float vHalo;
varying float vHaloSigma;
varying float vPointSize;

void main() {
  vec3 rotated = mat3(modelMatrix) * position;
  // Direction, not position. The model matrix carries a SCALE now — the dome
  // is parked just inside the far plane so solid geometry can occlude it —
  // and dividing by a compiled-in radius would have made every altitude in
  // this shader wrong the moment that scale moved. Normalizing is exactly the
  // old value at the old radius and stays right at any other.
  vec3 skyDirection = normalize(rotated);
  float altitude = skyDirection.y;

  // Atmospheric extinction, in magnitudes: k (X - 1) with X the relative air
  // mass. Stars near the horizon dim — never brighten — and set below it.
  float airMass = 1.0 / max(altitude, 0.035);
  float extinctionMag = 0.25 * (airMass - 1.0);
  // The twilight arch is not symmetric: the sky above the sunset point holds
  // its glow for an hour while the anti-solar side is already dark. Stars
  // therefore appear opposite the sunset first and colonise the bright
  // sector last — the same mu01^2 weighting the sky's multi-scatter arch
  // uses, converted to magnitudes of penalty.
  float muT = dot(skyDirection, uTwilightDir) * 0.5 + 0.5;
  float mEff = aMagnitude + extinctionMag + uTwilightPenalty * muT * muT;
  float horizonCut = smoothstep(-0.012, 0.010, altitude);

  // Visibility against the sky's limiting magnitude. The band is asymmetric:
  // a star pops out of the glow slightly before the textbook limit and is
  // fully established a magnitude past it.
  float visibility = smoothstep(uLimitMag + 0.40, uLimitMag - 0.90, mEff) * horizonCut * uFade;

  // Photometric intensity, pinned at the FAINT end so the range opens
  // downward into the sky rather than upward off the display. See the
  // STAR_ANCHOR_MAGNITUDE discussion above.
  float photometric = uAnchorIntensity
    * pow(10.0, -uMagnitudeExponent * (mEff - ${STAR_ANCHOR_MAGNITUDE.toFixed(1)}));
  float unoccludedIntensity = photometric * visibility;

  // Real scintillation changes intensity, not the star's position or apparent
  // diameter. Two low-amplitude, per-star frequencies keep the field from
  // breathing in unison. The extra air column near the horizon raises the
  // effect slightly, but even there it stays a brightness modulation rather
  // than an on/off switch.
  float twinkleSeed = fract(sin(dot(position, vec3(0.1271, 0.3117, 0.7413))) * 43758.5453);
  float twinkleSeed2 = fract(twinkleSeed * 17.371 + 0.173);
  float twinkleWave =
    sin(uTime * mix(0.45, 1.05, twinkleSeed) + twinkleSeed * 6.2831853) * 0.72 +
    sin(uTime * mix(1.55, 2.35, twinkleSeed2) + twinkleSeed2 * 19.0) * 0.28;
  float lowAltitude = 1.0 - smoothstep(0.10, 0.65, altitude);
  float twinkleAmplitude = mix(
    ${STAR_TWINKLE_MIN_AMPLITUDE.toFixed(3)},
    ${STAR_TWINKLE_MAX_AMPLITUDE.toFixed(3)},
    lowAltitude
  )
    * mix(0.75, 1.0, twinkleSeed2);
  float twinkleGain = 1.0 + twinkleWave * twinkleAmplitude;

  // The sky's cached opacity is the authority here too. Sampling its exact
  // sparse-atlas address makes a star dim through a tuft and disappear behind
  // a dense core instead of being additively painted over the finished cloud.
  //
  // But the sky's alpha is an APPEARANCE alpha for a scattering slab, and a
  // star is a delta-direction beam. Compositing it linearly, as this did, is
  // the wrong law twice over.
  //
  // First, the alpha has a ceiling below one. cloudBake writes
  // (1 - transmit) * fade with the march exiting at transmit < 0.01 and
  // fade = haze * horizonFade * cloudRes, so the densest possible cloud
  // reports about 0.935 at the zenith, 0.88 at 30 degrees and 0.80 at 15 —
  // leaking 6%, 12% and 20% of every star straight through a solid deck. And
  // none of those fades are holes in the cloud: haze is atmosphere in FRONT of
  // it and cloudRes is a Nyquist retirement of detail, neither of which lets a
  // star through.
  //
  // Second, even an honest alpha is not a beam transmittance. Cumulus runs to
  // optical depths in the tens, so exp(-tau) along the line of sight is
  // essentially zero while the slab's appearance alpha is merely high. Raising
  // transmittance to a power is exactly that reconstruction —
  // (1 - a)^k == exp(-k * tau) for a = 1 - exp(-tau) — so one uniform
  // converts the sky's look into the beam's fate. Thin veils still pass stars,
  // which is real; anything with body does not.
  float cloudTransmission = 1.0;
  if (unoccludedIntensity > 0.0005 && altitude > 0.004 && uCloudOpacity > 0.001) {
    vec3 cloudAddress = cloudCacheAddress(cloudCumulusUv(skyDirection));
    if (cloudAddress.z > 0.5) {
      float cloudAlpha = texture2D(uCloudPackA, cloudAddress.xy).a * uCloudOpacity;
      cloudTransmission = pow(
        max(1.0 - clamp(cloudAlpha, 0.0, 1.0), 0.0),
        uCloudBeamPower
      );
    }
  }

  vIntensity = unoccludedIntensity * cloudTransmission * twinkleGain;
  vColor = color;
  // Glare in stops over the display, not a magnitude threshold. Reading the
  // FINAL intensity is what makes cloud, extinction and twilight shrink the
  // halo along with the core.
  vHalo = clamp(
    log2(max(vIntensity, 1e-6) / ${STAR_GLARE_ONSET.toFixed(3)})
      / ${STAR_GLARE_STOPS.toFixed(1)},
    0.0,
    1.0
  );
  // Halo sigma follows the render scale so the glare keeps its angular size
  // when adaptive resolution drops the cap; without this it doubles on screen
  // every time the ratio halves. Floored so it never falls under the sample
  // spacing and turns into a hard-edged dot.
  vHaloSigma = max(
    mix(
      ${STAR_HALO_SIGMA_MIN_PX.toFixed(2)},
      uHaloSigmaMax,
      vHalo
    ) * uResolutionScale,
    0.5
  );

  vec4 world = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
  ${GLSL_LOG_DEPTH_VERTEX}
  // The sprite is a sampling footprint, not the visible diameter. A stable
  // four-device-pixel minimum gives the analytic PSF enough neighbouring
  // samples to conserve its energy while the celestial field crosses the
  // pixel grid. A glaring star additionally needs room for its own skirt:
  // six sigma across contains it, and clipping the support instead would
  // square off the halo into a visible box. Only a few dozen stars in the
  // whole catalogue ever ask for the wide end.
  gl_PointSize = max(
    max(${STAR_POINT_SUPPORT_PX.toFixed(1)}, aPointSize * uPixelRatio),
    6.0 * vHaloSigma * step(0.001, vHalo)
  );
  vPointSize = gl_PointSize;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

${GLSL_LOG_DEPTH_PARS_FRAGMENT}

uniform float uResolutionScale;

varying vec3 vColor;
varying float vIntensity;
varying float vHalo;
varying float vHaloSigma;
varying float vPointSize;

void main() {
  ${GLSL_LOG_DEPTH_FRAGMENT}
  // Evaluate the point-spread function in DEVICE PIXELS. The previous shader
  // evaluated a much narrower Gaussian in normalized sprite coordinates and
  // discarded it at a hard threshold. As sky rotation moved its sub-pixel
  // centre, the sampled energy varied by several times and faint stars could
  // disappear completely. A sigma just over half a pixel distributes one
  // point across the nearest samples while remaining visually pin-sharp.
  vec2 pixelOffset = (gl_PointCoord - 0.5) * vPointSize;
  float pixelRadius2 = dot(pixelOffset, pixelOffset);
  const float CORE_SIGMA_PX = ${STAR_CORE_SIGMA_PX.toFixed(3)};
  const float CORE_NORM = ${STAR_CORE_NORMALIZATION.toFixed(6)};
  // The sigma stays put — it is a sampling floor, not a look — but the
  // normalization follows the SQUARE of the render scale. Unit integral over
  // render pixels means a scale-independent peak, and at half resolution each
  // of those pixels is displayed four times as large, which is precisely how a
  // faint star quadrupled its light on screen when the cap dropped. Scaling
  // here conserves what the screen actually receives.
  float core = exp(-0.5 * pixelRadius2 / (CORE_SIGMA_PX * CORE_SIGMA_PX))
    * CORE_NORM * uResolutionScale * uResolutionScale;
  // The glare skirt. It widens with the star's over-range amount rather than
  // only brightening, because past display white brightening is the one thing
  // it cannot do — the extra range has to arrive as area. Amplitude is held
  // low and DELIBERATELY not energy-normalized: this is scatter added around
  // the source, not the source's own energy redistributed, so a widening halo
  // must not dim the core it belongs to.
  float halo = exp(-0.5 * pixelRadius2 / (vHaloSigma * vHaloSigma))
    * ${STAR_HALO_AMPLITUDE.toFixed(3)} * vHalo;
  float energy = (core + halo) * vIntensity;

  gl_FragColor = vec4(vColor * energy * 1.25, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class StarField {
  readonly mesh: THREE.Points;
  readonly material: THREE.ShaderMaterial;

  constructor(cloudUniforms: Record<string, THREE.IUniform>) {
    const count = BRIGHT_STAR_CATALOGUE.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const magnitudes = new Float32Array(count);
    const direction = vec3();

    for (let index = 0; index < count; index++) {
      const [
        rightAscensionHours,
        declinationDeg,
        visualMagnitude,
        colorIndexBv,
      ] = BRIGHT_STAR_CATALOGUE[index];
      eqjDirectionFromRaDec(
        rightAscensionHours,
        declinationDeg,
        direction,
      );
      const offset = index * 3;
      positions[offset] = direction.x * STAR_RADIUS;
      positions[offset + 1] = direction.y * STAR_RADIUS;
      positions[offset + 2] = direction.z * STAR_RADIUS;

      const color = starColorFromBv(colorIndexBv ?? 0.45);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      // Restrained size growth: Sirius ~3.3 device px, ordinary stars ~1.6.
      sizes[index] = THREE.MathUtils.clamp(
        2.4 - visualMagnitude * 0.3,
        1.5,
        3.4,
      );
      magnitudes[index] = visualMagnitude;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(positions, 3),
    );
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute(
      'aPointSize',
      new THREE.BufferAttribute(sizes, 1),
    );
    geometry.setAttribute(
      'aMagnitude',
      new THREE.BufferAttribute(magnitudes, 1),
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(),
      STAR_RADIUS,
    );

    this.material = new THREE.ShaderMaterial({
      // The cloud entries are shared IUniform objects, not copied values, so
      // cache swaps and per-frame advection reach this pass atomically with the
      // sky that is visibly composited from them.
      uniforms: {
        ...cloudUniforms,
        // Preserve SkySystem's shared presentation clock when present; tests
        // and isolated consumers still get a deterministic zero-time default.
        uTime: cloudUniforms.uTime ?? { value: 0 },
        uPixelRatio: { value: 1 },
        uFade: { value: 1 },
        uLimitMag: { value: -6 },
        uTwilightDir: { value: new THREE.Vector3(0, 0, 1) },
        uTwilightPenalty: { value: 0 },
        uMagnitudeExponent: { value: STAR_MAGNITUDE_EXPONENT },
        uAnchorIntensity: { value: STAR_ANCHOR_INTENSITY },
        uHaloSigmaMax: { value: STAR_HALO_SIGMA_MAX_PX },
        uResolutionScale: { value: 1 },
        uCloudBeamPower: { value: STAR_CLOUD_BEAM_POWER },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      vertexColors: true,
      transparent: true,
      // Opaque scene geometry has rendered before the transparent star pass.
      // Testing its depth is what lets sails, hulls, rigging, and every future
      // solid foreground object mask the catalogue naturally.
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Points(geometry, this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -900;
  }

  /**
   * Where the dome is parked in depth. `?starDome=near` selects the legacy
   * 485 m radius; see STAR_DOME_FAR_FRACTION for what turns on it.
   */
  domeAnchor: StarDomeAnchor = 'far';

  /** Live dome radius in metres, for diagnostics and tests. */
  domeRadiusM = starDomeRadiusM(STAR_DOME_DEFAULT_FAR_M);

  update(
    celestialToRender: Mat3d,
    cameraPosition: THREE.Vector3,
    limitingMagnitude: number,
    pixelRatio: number,
    twilightDirection?: THREE.Vector3,
    twilightPenaltyMag = 0,
    cameraFarM: number = STAR_DOME_DEFAULT_FAR_M,
  ): void {
    // A uniform scale on the rotation, not a new geometry. The dome's screen
    // position is the direction of each vertex and nothing else — the pass
    // sizes its own points — so this moves depth alone. The bounding sphere is
    // stale afterwards on purpose: `frustumCulled` is false.
    this.domeRadiusM = starDomeRadiusM(cameraFarM, this.domeAnchor);
    const domeScale = this.domeRadiusM / STAR_RADIUS;
    this.mesh.matrix.set(
      celestialToRender[0] * domeScale,
      celestialToRender[1] * domeScale,
      celestialToRender[2] * domeScale,
      cameraPosition.x,
      celestialToRender[3] * domeScale,
      celestialToRender[4] * domeScale,
      celestialToRender[5] * domeScale,
      cameraPosition.y,
      celestialToRender[6] * domeScale,
      celestialToRender[7] * domeScale,
      celestialToRender[8] * domeScale,
      cameraPosition.z,
      0,
      0,
      0,
      1,
    );
    this.mesh.matrixWorldNeedsUpdate = true;
    this.material.uniforms.uLimitMag.value = limitingMagnitude;
    this.material.uniforms.uPixelRatio.value = Math.min(
      pixelRatio,
      STAR_REFERENCE_PIXEL_RATIO,
    );
    // Adaptive resolution moves this every few seconds; see the discussion at
    // STAR_REFERENCE_PIXEL_RATIO for what it corrects.
    this.material.uniforms.uResolutionScale.value =
      starResolutionScale(pixelRatio);
    if (twilightDirection) {
      (this.material.uniforms.uTwilightDir.value as THREE.Vector3).copy(
        twilightDirection,
      );
    }
    this.material.uniforms.uTwilightPenalty.value = twilightPenaltyMag;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** Compact perceptual approximation; catalogue B-V remains the authority. */
function starColorFromBv(colorIndexBv: number): readonly [number, number, number] {
  const t = THREE.MathUtils.clamp((colorIndexBv + 0.35) / 2.35, 0, 1);
  if (t < 0.45) {
    const u = t / 0.45;
    return [
      0.58 + 0.42 * u,
      0.70 + 0.30 * u,
      1,
    ];
  }
  const u = (t - 0.45) / 0.55;
  return [
    1,
    1 - 0.28 * u,
    1 - 0.53 * u,
  ];
}
