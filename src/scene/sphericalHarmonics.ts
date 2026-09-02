/**
 * L2 spherical harmonics over an equirectangular radiance map.
 *
 * Pure functions over plain arrays, deliberately. The world's diffuse light is
 * the one term in the lighting system that has an exactly known right answer —
 * a cosine integral of the source over the sphere — and the only way to keep it
 * honest is to be able to check it against a brute-force integral in a test.
 * The test suite has no WebGL, so anything that needs a GPU to evaluate is
 * anything that never gets checked. Hence: no three imports, no renderer, no
 * textures. `WorldRadianceSource` reads pixels off the GPU; this file turns
 * pixels into light.
 *
 * CONVENTIONS, both load-bearing
 * ------------------------------
 * 1. The equirect mapping is **three's**, not the one `SkyRadianceLut` uses.
 *    Three's `equirectUv` is `u = atan(z, x)/2pi + 0.5`, `v = asin(y)/pi + 0.5`;
 *    the sky LUT's is `atan(x, -z)`. Same latitudes, azimuth rotated 90°. The
 *    source map is consumed by `PMREMGenerator`, which assumes three's, so the
 *    whole world-lighting path uses three's and the sky LUT keeps its own. Get
 *    this wrong and the specular reflection is a quarter-turn out of register
 *    with the diffuse — which looks like a plausible sky and is not one.
 *
 * 2. The basis and the cosine convolution are copied verbatim from three's
 *    `SphericalHarmonics3.getBasisAt` and the `shGetIrradianceAt` chunk in
 *    r0.185.1. Not "equivalent to" — the same numbers in the same order. The
 *    adapter evaluates these coefficients inside three's own shader, so a
 *    private basis that differed by a sign convention in band 1 would light the
 *    hull from the wrong side and nothing would report it.
 */

/** RGB triples for the 9 L2 coefficients: 27 floats, band-major. */
export const SH_COEFFICIENT_COUNT = 9;
export const SH_FLOAT_COUNT = SH_COEFFICIENT_COUNT * 3;

/**
 * Direction for an equirect texel centre, in three's convention.
 *
 * `u` and `v` are normalised texture coordinates, not pixel indices.
 */
export function equirectDirection(
  u: number,
  v: number,
  out: [number, number, number],
): [number, number, number] {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (v - 0.5) * Math.PI;
  const c = Math.cos(theta);
  out[0] = c * Math.cos(phi);
  out[1] = Math.sin(theta);
  out[2] = c * Math.sin(phi);
  return out;
}

/**
 * Three's SH basis, evaluated at a unit direction.
 *
 * Note band 2's use of `z` where a textbook writes the polar axis: three
 * evaluates the basis in whatever frame it is handed and is self-consistent
 * about it, so the projection and the reconstruction cancel. Do not "fix" this
 * to a Y-up form without changing both ends together.
 */
export function shBasisAt(
  x: number,
  y: number,
  z: number,
  out: Float64Array | number[],
): void {
  out[0] = 0.282095;
  out[1] = 0.488603 * y;
  out[2] = 0.488603 * z;
  out[3] = 0.488603 * x;
  out[4] = 1.092548 * x * y;
  out[5] = 1.092548 * y * z;
  out[6] = 0.315392 * (3 * z * z - 1);
  out[7] = 1.092548 * x * z;
  out[8] = 0.546274 * (x * x - y * y);
}

/**
 * Project an RGBA equirect radiance map onto 9 RGB coefficients.
 *
 * `data` is row-major RGBA, `width * height * 4` floats, row 0 at v≈0 — which
 * for three's mapping is the **nadir**, straight down into the water. The alpha
 * channel is ignored.
 *
 * The solid-angle weight is the **exact** integral of the latitude band a row
 * covers, `(sin(elevationHigh) - sin(elevationLow)) * (2pi/width)`, not the
 * midpoint approximation `cos(elevation) * dElevation * dPhi`.
 *
 * The rows of an equirect map are not equal-area — weighting them as if they
 * were over-counts the poles without limit — but getting that much right is not
 * enough. Sampling `cos` at row centres is a midpoint rule, and its error is
 * `(dTheta^2)/24` of the total: at 64 rows that is +0.010%, a uniform sphere
 * that integrates to 1.0001 * 4pi. Harmless to look at and exactly the kind of
 * thing this round exists to delete — a global gain of unknown provenance
 * sitting in the lighting path, indistinguishable from someone's tuning
 * constant a year from now. The band integral has no such error at any
 * resolution, so `equirectSolidAngleSum` returns 4pi to floating-point
 * precision for a 16x8 map and a 512x256 one alike.
 */
/**
 * Cosine-weighted irradiance on a plane with normal `n`, integrated DIRECTLY
 * from the equirect map — no basis in between.
 *
 * Why this exists when `projectEquirectToSh` + `shIrradiance` already answer
 * the same question: this is the exact integral the projection approximates,
 * so measuring the two against each other on the LIVE map is how a "the
 * probe is lying" hypothesis gets settled. Its first outing (§17.6 of the
 * ship interior handover) settled one by ACQUITTING the SH — the dusk-dark
 * cabin was honest composition, and the two paths agree within ~2% on the
 * real sky at every measured hour. It stays as the portal channels' path
 * because it is immune to the regime the basis genuinely cannot hold — a
 * compact spike misstates L2 anti-solar irradiance ~1.8× (see the
 * portal-sky tests) — and because it costs nothing the cache doesn't absorb.
 * Same texel directions, same band solid angles, same double-precision
 * accumulation as the projection.
 *
 * A uniform source of radiance L returns pi*L for any normal, which is the
 * same convention `shIrradiance` keeps.
 */
export function equirectCosineIrradiance(
  data: ArrayLike<number>,
  width: number,
  height: number,
  nx: number,
  ny: number,
  nz: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const dir: [number, number, number] = [0, 0, 0];
  const dPhi = (2 * Math.PI) / width;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    const weight = equirectRowSolidAngle(j, height) * dPhi;
    if (weight <= 0) continue;
    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      equirectDirection(u, v, dir);
      const cosine = dir[0] * nx + dir[1] * ny + dir[2] * nz;
      if (cosine <= 0) continue;
      const w = weight * cosine;
      const p = (j * width + i) * 4;
      r += data[p] * w;
      g += data[p + 1] * w;
      b += data[p + 2] * w;
    }
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
  return out;
}

export function projectEquirectToSh(
  data: ArrayLike<number>,
  width: number,
  height: number,
  out: Float32Array,
): Float32Array {
  out.fill(0);

  const basis = new Float64Array(SH_COEFFICIENT_COUNT);
  const dir: [number, number, number] = [0, 0, 0];
  // Accumulate in double precision. The map is HDR and the sun's aureole can
  // sit four orders of magnitude above the anti-solar sky; summing 8192 of
  // those into a float32 loses the dim half of the sky, which is exactly the
  // half that fills the shadowed side of the hull.
  const acc = new Float64Array(SH_FLOAT_COUNT);
  const dPhi = (2 * Math.PI) / width;

  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    const weight = equirectRowSolidAngle(j, height) * dPhi;
    if (weight <= 0) continue;

    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      equirectDirection(u, v, dir);
      shBasisAt(dir[0], dir[1], dir[2], basis);

      const p = (j * width + i) * 4;
      const r = data[p] * weight;
      const g = data[p + 1] * weight;
      const b = data[p + 2] * weight;

      for (let k = 0; k < SH_COEFFICIENT_COUNT; k++) {
        const y = basis[k];
        acc[k * 3] += r * y;
        acc[k * 3 + 1] += g * y;
        acc[k * 3 + 2] += b * y;
      }
    }
  }

  for (let k = 0; k < SH_FLOAT_COUNT; k++) out[k] = acc[k];
  return out;
}

/**
 * Irradiance from the coefficients, in the direction of a surface normal.
 *
 * The CPU mirror of three's `shGetIrradianceAt`. Two callers: the tests, and
 * the sun calibration — the design asks for the noon ratio of direct sun to
 * sky irradiance to be *measured* from the live probe rather than guessed, and
 * this is the function that measures it.
 *
 * Returns true irradiance: a uniform source of radiance L over the whole
 * sphere gives exactly `pi * L`, independent of normal.
 *
 * Clamped at zero. L2 cannot represent a hard horizon step, so a bright sky
 * over a dark sea rings slightly negative near the nadir; a negative irradiance
 * is not a look decision to preserve, it is an artefact of the basis, and
 * subtracting light from the underside of a bulwark would be a real visible
 * bug. The tests bound the ringing rather than trusting the clamp to hide it.
 */
export function shIrradiance(
  sh: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  out: [number, number, number],
): [number, number, number] {
  for (let c = 0; c < 3; c++) {
    let v = sh[c] * 0.886227;
    v += sh[3 + c] * 2.0 * 0.511664 * y;
    v += sh[6 + c] * 2.0 * 0.511664 * z;
    v += sh[9 + c] * 2.0 * 0.511664 * x;
    v += sh[12 + c] * 2.0 * 0.429043 * x * y;
    v += sh[15 + c] * 2.0 * 0.429043 * y * z;
    v += sh[18 + c] * (0.743125 * z * z - 0.247708);
    v += sh[21 + c] * 2.0 * 0.429043 * x * z;
    v += sh[24 + c] * 0.429043 * (x * x - y * y);
    out[c] = Math.max(v, 0);
  }
  return out;
}

/**
 * Brute-force cosine convolution of the same map, for the same normal.
 *
 * The reference the SH path is checked against. This is what "correct diffuse
 * lighting" means with no basis in the way: sum radiance times `max(dot(n, w),
 * 0)` times solid angle over every texel. Slow and exact — a test tool, never a
 * runtime path.
 */
export function cosineConvolveEquirect(
  data: ArrayLike<number>,
  width: number,
  height: number,
  nx: number,
  ny: number,
  nz: number,
  out: [number, number, number],
): [number, number, number] {
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;

  const dir: [number, number, number] = [0, 0, 0];
  const dPhi = (2 * Math.PI) / width;

  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    const weight = equirectRowSolidAngle(j, height) * dPhi;
    if (weight <= 0) continue;

    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      equirectDirection(u, v, dir);
      const cosine = dir[0] * nx + dir[1] * ny + dir[2] * nz;
      if (cosine <= 0) continue;

      const w = weight * cosine;
      const p = (j * width + i) * 4;
      out[0] += data[p] * w;
      out[1] += data[p + 1] * w;
      out[2] += data[p + 2] * w;
    }
  }

  return out;
}

/**
 * Solid angle of one latitude row of an equirect map, per radian of azimuth.
 *
 * `sin(high) - sin(low)` over the band the row covers — the exact integral, so
 * the quadrature carries no resolution-dependent gain. See the note on
 * `projectEquirectToSh`.
 */
export function equirectRowSolidAngle(row: number, height: number): number {
  const lo = (row / height - 0.5) * Math.PI;
  const hi = ((row + 1) / height - 0.5) * Math.PI;
  return Math.sin(hi) - Math.sin(lo);
}

/**
 * Total solid angle the projection weights sum to.
 *
 * Exposed only so a test can assert it lands on 4pi. A quadrature that has
 * quietly drifted off 4pi is a lighting system with a hidden global gain, which
 * is precisely the class of bug this whole round exists to remove.
 */
export function equirectSolidAngleSum(width: number, height: number): number {
  let sum = 0;
  const dPhi = (2 * Math.PI) / width;
  for (let j = 0; j < height; j++) sum += equirectRowSolidAngle(j, height) * dPhi * width;
  return sum;
}
