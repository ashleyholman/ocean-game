/**
 * The diffuse Milky Way: the light of the stars we do not draw.
 *
 * `StarField` draws every catalogue star down to magnitude 6.5, which is the
 * naked-eye limit and about nine thousand points. The band is made of the
 * OTHER hundred billion — magnitude 8 to 20, individually invisible, summing
 * to a surface brightness of roughly 21 mag/arcsec² where it is brightest.
 * No extension of a point catalogue reaches it: the light is real but it never
 * resolves, so it has to arrive as radiance on the sky rather than as sprites.
 *
 * Two consequences of that surface brightness are worth stating, because they
 * are what stops this from looking like a decal:
 *
 *  * Against a pristine sky of about 22 mag/arcsec² the contrast is only
 *    around 1.6 to 1. That is why the Milky Way is the first thing a rising
 *    moon erases, and why `visibilityFromLimitingMagnitude` below is steep
 *    rather than a simple night fade.
 *  * At that brightness the eye is on rods, which carry no colour. The real
 *    naked-eye band is essentially grey; the tan core and blue arms belong to
 *    photographs. This world's night is already photographic, so the map's own
 *    colour is kept, but behind a chroma control — see `MILKY_WAY_CHROMA`.
 *
 * The map is baked from the NASA SVS "Deep Star Maps 2020" diffuse layer in
 * galactic coordinates; see `scripts/generate_milky_way.py` for why that
 * particular file and `docs/project/ASSET_CREDITS.md` for the licence.
 */
import * as THREE from 'three';

import {
  MILKY_WAY_CHROMA_BASE64,
  MILKY_WAY_CHROMA_DIVISOR,
  MILKY_WAY_CHROMA_SCALE,
  MILKY_WAY_HEIGHT,
  MILKY_WAY_LUMINANCE_BASE64,
  MILKY_WAY_LUMINANCE_GAMMA,
  MILKY_WAY_WIDTH,
} from '../astronomy/data/milkyWay.generated';
import type { Mat3d } from '../astronomy/AstronomyProvider';
import { eqjDirectionFromRaDec } from '../astronomy/AstronomyProvider';
import { vec3 } from '../world/math';

/**
 * The galactic frame, defined by where it points rather than by a copied
 * matrix.
 *
 * A rotation written out as nine literals is nine chances to transpose
 * something and no way to see that you have. These three numbers are the IAU
 * definition itself — the north galactic pole and the direction of the centre,
 * in J2000 equatorial coordinates — and the axes are built from them below, so
 * the frame is checkable against a catalogue by eye.
 */
const GALACTIC_NORTH_POLE_RA_HOURS = 192.85948 / 15;
const GALACTIC_NORTH_POLE_DEC_DEG = 27.12825;
const GALACTIC_CENTRE_RA_HOURS = 266.4051 / 15;
const GALACTIC_CENTRE_DEC_DEG = -28.93617;

/** Galactic basis vectors expressed in the EQJ frame, as columns. */
const GALACTIC_TO_EQJ = buildGalacticBasis();

/**
 * Extinction coefficient in magnitudes per air mass, matching the value
 * `StarField` extincts point sources with. The band has to dim toward the
 * horizon on the same law its own stars do, or the two disagree about the
 * atmosphere they are behind.
 */
const MILKY_WAY_EXTINCTION_K = 0.25;

/**
 * How much of the map's own colour to keep, 0 grey to 1 as photographed.
 *
 * A judgement, not a measurement — see the rod-vision note in the header — so
 * it is a uniform the graphics panel can walk while looking at the sky.
 */
export const MILKY_WAY_CHROMA = 0.55;

/**
 * Physically faithful peak radiance, in the sky shader's own linear units.
 *
 * Measured against this renderer rather than guessed, because "how bright is
 * the Milky Way" only has an answer relative to the sky it sits on, and this
 * sky is a specific model behind a specific exposure and tone curve.
 *
 * The target is the real contrast: the brightest Milky Way is about
 * 21 mag/arcsec² against a pristine sky of about 22, so at its peak it makes
 * the sky 10^0.4 ≈ 2.5 times brighter. Read off the running night sky, the
 * background sits at 12.4 of 255 — 0.0038 linear after the display transform —
 * so the peak addition wanted is 0.0057 linear. A gain ladder rendered at
 * astronomical night put the band's peak at 0.0080 linear per 0.02 of gain,
 * which puts the answer at 0.015.
 *
 * This is NOT what ships. It is kept as the reference the shipped value is
 * quoted against, and as the number to re-derive from if the exposure or the
 * tone curve ever moves.
 */
export const MILKY_WAY_MEASURED_GAIN = 0.015;

/**
 * The peak radiance that ships — 0.53x the physically faithful one, by choice.
 *
 * Below the measurement, and for a reason the measurement does not capture:
 * 2.5:1 is the PEAK of the band against a pristine sky, and what a person
 * standing on a deck actually reports is barely seeing it at all. The number
 * describes a photometric maximum; the experience is a faint uncertainty in
 * the sky that resolves when you stop looking straight at it. Half the
 * faithful contrast is where that lands here.
 *
 * Two things also push the faithful figure to read stronger in this renderer
 * than the arithmetic suggests — the star field standing inside the band is
 * denser than the measurement accounted for, and this sky's night floor is a
 * photographic rendering rather than a pristine 22 mag/arcsec².
 *
 * The measurement above stays in the code as the anchor, and the panel reports
 * the gain as a multiple of it, so the size of the departure is always on
 * screen rather than buried in a constant — in either direction.
 */
export const MILKY_WAY_GAIN = 0.008;

/**
 * Limiting magnitudes over which the band fades in.
 *
 * Deliberately narrow and deliberately late. Stars appear one by one as the
 * sky darkens, but an extended source at 1.6 to 1 contrast is either there or
 * it is not, and it is not there until the sky is genuinely dark. Below about
 * magnitude 5 nobody has ever seen it.
 */
const MILKY_WAY_LIMIT_FAINT = 4.9;
const MILKY_WAY_LIMIT_FULL = 6.0;

export interface MilkyWayTextures {
  luminance: THREE.DataTexture;
  chroma: THREE.DataTexture;
}

/**
 * How visible the band is under a given limiting magnitude.
 *
 * One authority for the policy, on the CPU, next to the rest of the night
 * model — the shader receives the answer rather than a copy of the rule.
 */
export function visibilityFromLimitingMagnitude(
  limitingMagnitude: number,
): number {
  const t =
    (limitingMagnitude - MILKY_WAY_LIMIT_FAINT) /
    (MILKY_WAY_LIMIT_FULL - MILKY_WAY_LIMIT_FAINT);
  const clamped = Math.min(Math.max(t, 0), 1);
  return clamped * clamped * (3 - 2 * clamped);
}

/** Decode the baked planes into textures. Called once. */
export function createMilkyWayTextures(): MilkyWayTextures {
  const luminance = new THREE.DataTexture(
    decodeBase64(MILKY_WAY_LUMINANCE_BASE64),
    MILKY_WAY_WIDTH,
    MILKY_WAY_HEIGHT,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  const chroma = new THREE.DataTexture(
    decodeBase64(MILKY_WAY_CHROMA_BASE64),
    MILKY_WAY_WIDTH / MILKY_WAY_CHROMA_DIVISOR,
    MILKY_WAY_HEIGHT / MILKY_WAY_CHROMA_DIVISOR,
    THREE.RGFormat,
    THREE.UnsignedByteType,
  );
  for (const texture of [luminance, chroma]) {
    // Longitude is periodic and latitude is not: the map's top row IS the
    // north galactic pole, so clamping there samples the pole rather than
    // wrapping around to the south.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  }
  return { luminance, chroma };
}

/**
 * Compose the render-space-to-galactic rotation for this frame.
 *
 * `celestialToRender` is row-major and maps EQJ into render space, which is
 * the same matrix `StarField` hands to its mesh. Both it and the galactic
 * basis are rotations, so the composition inverts by transposing:
 *
 *   v_render   = M · v_eqj,        v_eqj = G · v_galactic
 *   v_galactic = (M · G)ᵀ · v_render
 */
export function renderToGalactic(
  celestialToRender: Mat3d,
  out: THREE.Matrix3,
): THREE.Matrix3 {
  const g = GALACTIC_TO_EQJ;
  // a[row][col] of M · G, built directly so no scratch matrix is allocated.
  const a = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      a[row * 3 + col] =
        celestialToRender[row * 3] * g[col] +
        celestialToRender[row * 3 + 1] * g[3 + col] +
        celestialToRender[row * 3 + 2] * g[6 + col];
    }
  }
  // THREE.Matrix3.set takes row-major arguments, so writing the transpose is
  // reading `a` down its columns.
  return out.set(
    a[0], a[3], a[6],
    a[1], a[4], a[7],
    a[2], a[5], a[8],
  );
}

/**
 * GLSL shared by the sky pass. Kept here rather than in `shaders/lib.ts`
 * because every constant it needs is defined in this file, and a decode
 * exponent that lives apart from the encoder that produced it is exactly the
 * kind of pair that drifts.
 */
export const GLSL_MILKY_WAY = /* glsl */ `
uniform sampler2D uMilkyWayLum;
uniform sampler2D uMilkyWayChroma;
/** Peak radiance times this frame's visibility; 0 skips the whole term. */
uniform float uMilkyWay;
/** How much of the map's photographed colour survives. */
uniform float uMilkyWayChroma01;

/**
 * Radiance of the diffuse galaxy along a render-space direction.
 *
 * The caller supplies the direction already rotated into galactic coordinates,
 * because the sky pass has the matrix and this keeps the transform out of the
 * per-pixel path's uniform reads.
 */
vec3 milkyWayRadiance(vec3 galactic, float altitude) {
  float longitude = atan(galactic.y, galactic.x);
  float latitude = asin(clamp(galactic.z, -1.0, 1.0));
  // l = 0 sits at the map's centre column and increases to the LEFT, the
  // convention every all-sky map uses because the sky is seen from inside.
  // Verified against the Magellanic Clouds, which the map resolves: LMC at
  // l 280.5 b -32.9 and SMC at l 302.8 b -44.3 land on them.
  vec2 uv = vec2(
    0.5 - longitude * ${(1 / (2 * Math.PI)).toFixed(8)},
    0.5 - latitude * ${(1 / Math.PI).toFixed(8)}
  );

  float stored = texture2D(uMilkyWayLum, uv).r;
  float lum = pow(stored, ${MILKY_WAY_LUMINANCE_GAMMA.toFixed(1)});
  vec2 ratio = texture2D(uMilkyWayChroma, uv).rg
    * ${MILKY_WAY_CHROMA_SCALE.toFixed(3)};
  // Rebuild RGB from luminance and the two stored chromaticity ratios. Green
  // falls out of the luminance definition rather than being stored, which is
  // what lets the colour plane be two channels instead of three.
  float red = ratio.x * lum;
  float blue = ratio.y * lum;
  float green = (lum - 0.2126 * red - 0.0722 * blue) / 0.7152;
  vec3 rgb = max(vec3(red, green, blue), vec3(0.0));
  rgb = mix(vec3(lum), rgb, uMilkyWayChroma01);

  // The same extinction the point sources get, on the same coefficient, plus
  // a horizon cut. An extended source low in the sky loses contrast twice —
  // it dims, and the sky beneath it brightens — and both are already here.
  float airMass = 1.0 / max(altitude, 0.035);
  float extinction = pow(10.0, ${(-0.4 * MILKY_WAY_EXTINCTION_K).toFixed(4)} * (airMass - 1.0));
  float horizon = smoothstep(-0.005, 0.030, altitude);

  return rgb * (uMilkyWay * extinction * horizon);
}
`;

function buildGalacticBasis(): Float64Array {
  const z = eqjDirectionFromRaDec(
    GALACTIC_NORTH_POLE_RA_HOURS,
    GALACTIC_NORTH_POLE_DEC_DEG,
    vec3(),
  );
  const x = eqjDirectionFromRaDec(
    GALACTIC_CENTRE_RA_HOURS,
    GALACTIC_CENTRE_DEC_DEG,
    vec3(),
  );
  // The IAU pole and centre are very nearly but not exactly perpendicular, so
  // the basis is orthonormalised rather than trusted. y first, then x back
  // from y and z: that keeps the pole exact and moves the residual into the
  // centre direction, where a few arcseconds is invisible and a non-orthogonal
  // basis would be a slow shear across the whole map.
  const y = normalize([
    z.y * x.z - z.z * x.y,
    z.z * x.x - z.x * x.z,
    z.x * x.y - z.y * x.x,
  ]);
  const xOrtho = normalize([
    y[1] * z.z - y[2] * z.y,
    y[2] * z.x - y[0] * z.z,
    y[0] * z.y - y[1] * z.x,
  ]);
  // Column-major-by-row storage: element [row * 3 + col], columns are the
  // galactic axes in EQJ.
  return new Float64Array([
    xOrtho[0], y[0], z.x,
    xOrtho[1], y[1], z.y,
    xOrtho[2], y[2], z.z,
  ]);
}

function normalize(v: number[]): number[] {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
