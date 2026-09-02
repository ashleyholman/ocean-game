/**
 * The sky as nine numbers per channel.
 *
 * WHY
 *
 * A wind-roughened sea cannot point-sample the sky it reflects. The reflected
 * ray sweeps whole cloud cells between neighbouring pixels, so drawing the sky
 * through the mirror direction renders as static, and the previous cure was to
 * replace it — everywhere the sampling got hard, which is almost everywhere —
 * with ONE cosine-weighted average of the entire dome.
 *
 * That average is very nearly achromatic. Measured at 62% cloud cover it is
 * (1.314, 1.405, 1.706): ratios 0.77 : 0.82 : 1.0, and 1.85x the zenith's own
 * blue, because the mean of a cloudy dome is mostly cloud. So the sea reflected
 * "average cloudy sky" in every direction, including where it faced clear blue
 * zenith, and 94% of the far water's red channel came from it. That is the grey.
 *
 * WHAT THIS IS INSTEAD
 *
 * The same average, plus the two bands of directional variation that were being
 * thrown away. An order-2 real spherical-harmonic projection of the sky is nine
 * coefficients per channel; convolved with the clamped-cosine kernel it gives
 * the irradiance-like mean over a wide lobe about any direction, which is
 * exactly what a rough reflection converges to.
 *
 * The l=0 term IS the old whole-dome mean, so this is a strict generalisation:
 * `evaluate(up)` reproduces the number the sea used to get everywhere, and
 * every other direction gets its own answer. And because an order-2 basis
 * cannot represent anything sharper than a hemisphere-scale gradient, it is
 * band-limited by construction — it cannot reintroduce the static the flat mean
 * was there to prevent.
 */

/** Coefficient count for an order-2 (l <= 2) real SH basis. */
export const SH_COEFFICIENTS = 9;

/**
 * Convolution weights for the clamped-cosine kernel, per band
 * (Ramamoorthi & Hanrahan). Turning a radiance projection into an irradiance
 * one costs exactly this: one multiply per band.
 */
const COSINE_LOBE = [3.141592653589793, 2.0943951023931953, 0.7853981633974483];
const BAND_OF: readonly number[] = [0, 1, 1, 1, 2, 2, 2, 2, 2];

/**
 * Real SH basis, orientated with the pole along +Y.
 *
 * The canonical formulae put the pole on +Z; the axes are permuted here
 * because a sky is stratified by ELEVATION, and putting the pole up means the
 * dominant zenith-to-horizon gradient lands in a single well-conditioned
 * coefficient instead of being smeared across the band. Orthonormality is
 * rotation-invariant, so this is a relabelling and not an approximation.
 *
 * Must match `skyProbe()` in GLSL_SKY.
 */
export function shBasis(
  x: number,
  y: number,
  z: number,
  out: number[],
): number[] {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * z;
  out[5] = 1.092548 * z * y;
  out[6] = 0.315392 * (3 * y * y - 1);
  out[7] = 1.092548 * x * y;
  out[8] = 0.546274 * (x * x - z * z);
  return out;
}

/**
 * Directions to project the sky along: a Fibonacci spiral over the UPPER
 * hemisphere only.
 *
 * Upper hemisphere only because that is the whole of what a sea surface can
 * reflect, and treating the missing half as zero radiance is not an
 * approximation here — there is no downward skylight.
 *
 * A spiral rather than rings. The set this replaces was a zenith point plus two
 * rings of six, which is 13 evaluations arranged so that every sample of a ring
 * shares an elevation: fine for extracting a mean, useless for fitting an l=2
 * band, and actively misleading for the azimuthal modes, where six evenly
 * spaced samples alias any 6-fold structure straight into the fit. A spiral has
 * no repeating azimuth and no shared elevations.
 */
export function fibonacciHemisphere(
  count: number,
): ReadonlyArray<readonly [number, number, number]> {
  const points: Array<readonly [number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    // Stratified in cos(zenith) so the samples carry equal solid angle.
    const y = (i + 0.5) / count;
    const r = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = golden * i;
    points.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return points;
}

/**
 * Evaluate a cosine-convolved projection along `dir`, in MEAN RADIANCE units.
 *
 * Irradiance divided by pi, so the result is directly comparable with the
 * radiances everything else in the renderer speaks — and so that `evaluate` at
 * the zenith returns the same number the old whole-dome mean did.
 *
 * `coefficients` is 27 floats, RGB interleaved per coefficient.
 * Must match `skyProbe()` in GLSL_SKY.
 */
export function evaluateSkyProbe(
  coefficients: Float32Array,
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
): [number, number, number] {
  const basis: number[] = [];
  shBasis(x, y, z, basis);
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  for (let i = 0; i < SH_COEFFICIENTS; i++) {
    const weight = (COSINE_LOBE[BAND_OF[i]] * basis[i]) / Math.PI;
    out[0] += coefficients[i * 3] * weight;
    out[1] += coefficients[i * 3 + 1] * weight;
    out[2] += coefficients[i * 3 + 2] * weight;
  }
  const norm = 1 / lobeCoverage(y);
  out[0] *= norm;
  out[1] *= norm;
  out[2] *= norm;
  return out;
}

/**
 * What fraction of the cosine lobe about `dirY` lies over the sky.
 *
 * The projection covers the upper hemisphere and treats the rest as zero
 * radiance, which is correct — there is no downward skylight. But a cosine
 * lobe about a NEAR-HORIZONTAL direction has half its kernel under the
 * horizon, so without this it collects half as much and a grazing reflection
 * comes out about half as bright as it should. That is not physics, it is the
 * kernel hanging off the edge of the data.
 *
 * Analytic, and exactly linear. Projecting a uniform unit sky leaves only two
 * non-zero coefficients — c0 = 2*PI*Y00 and the l=1 term along the pole,
 * c = PI*0.488603 — because the (3y^2 - 1) integral over a hemisphere is
 * identically zero. Reconstructing those two gives 0.5 + 0.5*y: one at the
 * zenith, one half at the horizon, which is the geometry stated plainly.
 *
 * Must match `skyProbe()` in GLSL_SKY.
 */
export function lobeCoverage(dirY: number): number {
  return 0.5 + 0.5 * dirY;
}

/**
 * Coefficients of a UNIFORM sky of the given radiance.
 *
 * Its reconstruction is that radiance in every direction, which is what makes
 * it the A/B path: it reproduces the flat whole-dome mean the sea used to get,
 * through the same shader code, so the comparison isolates the directional
 * bands and does not also toggle a branch.
 *
 * Two non-zero coefficients, not one. A uniform sky is not a DC-only signal
 * once the lower hemisphere is empty — it has a pole-aligned l=1 component,
 * and that component is exactly what `lobeCoverage` divides back out. Dropping
 * it (the obvious first guess) leaves the "flat" path 1.8x too bright at
 * grazing angles, which is precisely where the A/B is being looked at.
 */
export function flatProbe(
  coefficients: Float32Array,
  radiance: { x: number; y: number; z: number },
): void {
  coefficients.fill(0);
  // Integrals of the basis over the upper hemisphere: 2*PI*Y00 for l=0, and
  // PI * 0.488603 for the +Y-aligned l=1 term. The (3y^2 - 1) integral is zero.
  const dc = 2 * Math.PI * 0.282095;
  const pole = Math.PI * 0.488603;
  coefficients[0] = radiance.x * dc;
  coefficients[1] = radiance.y * dc;
  coefficients[2] = radiance.z * dc;
  coefficients[3] = radiance.x * pole;
  coefficients[4] = radiance.y * pole;
  coefficients[5] = radiance.z * pole;
}

/** GLSL mirror of `shBasis` and `evaluateSkyProbe`. Included by GLSL_SKY. */
export const GLSL_SKY_PROBE = /* glsl */ `
uniform vec3 uSkySh[9];

/**
 * The sky's order-2 harmonic projection, cosine-convolved, evaluated along
 * dir. Returns MEAN RADIANCE — the wide-lobe limit of a rough reflection.
 *
 * Must match evaluateSkyProbe() in scene/skyHarmonics.ts.
 */
vec3 skyProbe(vec3 dir) {
  // COSINE_LOBE[band] / PI, folded into the basis constants.
  const float C0 = 0.2820948;  // A0 * 0.282095 / PI
  const float C1 = 0.3257350;  // A1 * 0.488603 / PI
  const float C2 = 0.2731371;  // A2 * 1.092548 / PI
  const float C3 = 0.0788479;  // A2 * 0.315392 / PI
  const float C4 = 0.1365686;  // A2 * 0.546274 / PI
  vec3 lobe = uSkySh[0] * C0
       + uSkySh[1] * (C1 * dir.y)
       + uSkySh[2] * (C1 * dir.z)
       + uSkySh[3] * (C1 * dir.x)
       + uSkySh[4] * (C2 * dir.x * dir.z)
       + uSkySh[5] * (C2 * dir.z * dir.y)
       + uSkySh[6] * (C3 * (3.0 * dir.y * dir.y - 1.0))
       + uSkySh[7] * (C2 * dir.x * dir.y)
       + uSkySh[8] * (C4 * (dir.x * dir.x - dir.z * dir.z));
  // The lobe about a low direction hangs half off the sky, where the
  // projection holds zero. Normalise by how much of it is over data, or a
  // grazing reflection arrives half as bright as it should. See lobeCoverage().
  return max(lobe, vec3(0.0)) / (0.5 + 0.5 * dir.y);
}
`;
