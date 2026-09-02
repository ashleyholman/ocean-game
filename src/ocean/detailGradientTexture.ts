const PERIOD = 256;
const TWO_PI = Math.PI * 2;

interface Component {
  kx: number;
  ky: number;
  phase: number;
  weight: number;
}

// Directionally biased spectra read as short wind ripples rather than the
// rounded islands produced by value noise. Crosswind components keep the field
// from collapsing into a comb, while integer frequencies preserve exact wrap.
const COARSE_COMPONENTS: readonly Component[] = [
  { kx: 128, ky: 0, phase: 0.37, weight: 1.00 },
  { kx: 119, ky: 17, phase: 1.91, weight: 0.92 },
  { kx: 107, ky: -25, phase: 4.22, weight: 0.84 },
  { kx: 97, ky: 31, phase: 2.73, weight: 0.77 },
  { kx: 89, ky: -37, phase: 5.41, weight: 0.70 },
  { kx: 79, ky: 43, phase: 3.36, weight: 0.62 },
  { kx: 67, ky: 71, phase: 0.83, weight: 0.52 },
  { kx: 73, ky: -61, phase: 4.91, weight: 0.48 },
  { kx: 41, ky: 103, phase: 2.18, weight: 0.34 },
  { kx: -37, ky: 97, phase: 5.77, weight: 0.30 },
  { kx: 131, ky: 47, phase: 1.34, weight: 0.38 },
  { kx: 137, ky: -29, phase: 3.98, weight: 0.36 },
];

const FINE_COMPONENTS: readonly Component[] = [
  { kx: 117, ky: 23, phase: 2.17, weight: 1.00 },
  { kx: 109, ky: -31, phase: 5.03, weight: 0.91 },
  { kx: 101, ky: 41, phase: 0.82, weight: 0.83 },
  { kx: 91, ky: -47, phase: 3.79, weight: 0.76 },
  { kx: 83, ky: 53, phase: 1.28, weight: 0.68 },
  { kx: 71, ky: -59, phase: 4.67, weight: 0.60 },
  { kx: 61, ky: 73, phase: 2.94, weight: 0.52 },
  { kx: 77, ky: 67, phase: 5.62, weight: 0.48 },
  { kx: 43, ky: 107, phase: 0.49, weight: 0.34 },
  { kx: -31, ky: 113, phase: 3.31, weight: 0.30 },
  { kx: 139, ky: 37, phase: 1.76, weight: 0.38 },
  { kx: 127, ky: -43, phase: 4.38, weight: 0.36 },
];

export interface DetailGradientTextureData {
  data: Uint8Array;
  size: number;
  coarseDecodeRange: number;
  fineDecodeRange: number;
}

export interface FaithfulDetailGradientTextureData {
  data: Uint8Array;
  size: number;
  decodeRange: number;
  /**
   * Decode range of the value channel packed into B. The value rides along so
   * the crest-skew weight can be computed from the same fetch that supplies
   * the gradient; before the skew existed B carried a constant 128.
   */
  valueDecodeRange: number;
}

export type DetailGradientTextureStyle = 'spectral' | 'value-noise';

function generateSpectralField(
  size: number,
  components: readonly Component[],
): { values: Float32Array; decodeRange: number } {
  const values = new Float32Array(size * size * 2);
  let sumLengthSquared = 0;
  let maximum = 0;

  for (let y = 0; y < size; y++) {
    const qy = ((y + 0.5) * PERIOD) / size;
    for (let x = 0; x < size; x++) {
      const qx = ((x + 0.5) * PERIOD) / size;
      let gx = 0;
      let gy = 0;
      for (const component of components) {
        const magnitude = Math.hypot(component.kx, component.ky);
        const heightAmplitude = component.weight / Math.max(magnitude, 1);
        const phase =
          (TWO_PI * (component.kx * qx + component.ky * qy)) / PERIOD +
          component.phase;
        const derivative =
          heightAmplitude * (TWO_PI / PERIOD) * Math.cos(phase);
        gx += derivative * component.kx;
        gy += derivative * component.ky;
      }
      const offset = (y * size + x) * 2;
      values[offset] = gx;
      values[offset + 1] = gy;
      sumLengthSquared += gx * gx + gy * gy;
    }
  }

  // Unit RMS vector length lets the shader scale each sampled field directly
  // by the slope energy assigned to that band.
  const rms = Math.sqrt(sumLengthSquared / (size * size));
  for (let offset = 0; offset < values.length; offset++) {
    values[offset] /= Math.max(rms, 1e-8);
    maximum = Math.max(maximum, Math.abs(values[offset]));
  }
  return { values, decodeRange: maximum * 1.02 };
}

function latticeValue(x: number, y: number, seed: number): number {
  let value =
    ((x & (PERIOD - 1)) * 0x1f123bb5) ^
    ((y & (PERIOD - 1)) * 0x5f356495) ^
    seed;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value ^= value >>> 16;
  return (value >>> 0) / 0xffffffff - 0.5;
}

const fade = (value: number): number =>
  value * value * value * (value * (value * 6 - 15) + 10);

const fadeDerivative = (value: number): number =>
  30 * value * value * (value - 1) * (value - 1);

const fract = (value: number): number => value - Math.floor(value);

/** CPU mirror of GLSL_COMMON.hash22 for the periodic detail lattice. */
function analyticHash22(x: number, y: number): readonly [number, number] {
  let px = fract(x * 0.1031);
  let py = fract(y * 0.1030);
  let pz = fract(x * 0.0973);
  const shared =
    px * (py + 33.33) +
    py * (pz + 33.33) +
    pz * (px + 33.33);
  px += shared;
  py += shared;
  pz += shared;
  return [
    -1 + 2 * fract((px + py) * pz),
    -1 + 2 * fract((px + pz) * py),
  ];
}

/**
 * CPU mirror of GLSL noisedPeriodic(): value and both spatial derivatives.
 *
 * This is deliberately the shipping field, not a statistically similar
 * replacement. Sampling it into a texture changes only how the same field is
 * evaluated and filtered.
 */
export function sampleAnalyticDetailNoise(
  qx: number,
  qy: number,
): readonly [number, number, number] {
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  const ux = fade(fx);
  const uy = fade(fy);
  const dux = fadeDerivative(fx);
  const duy = fadeDerivative(fy);
  const wrap = (value: number): number => ((value % PERIOD) + PERIOD) % PERIOD;
  const ga = analyticHash22(wrap(ix), wrap(iy));
  const gb = analyticHash22(wrap(ix + 1), wrap(iy));
  const gc = analyticHash22(wrap(ix), wrap(iy + 1));
  const gd = analyticHash22(wrap(ix + 1), wrap(iy + 1));

  const va = ga[0] * fx + ga[1] * fy;
  const vb = gb[0] * (fx - 1) + gb[1] * fy;
  const vc = gc[0] * fx + gc[1] * (fy - 1);
  const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1);
  const crossValue = va - vb - vc + vd;
  const value =
    va + ux * (vb - va) + uy * (vc - va) + ux * uy * crossValue;
  const gx =
    ga[0] +
    ux * (gb[0] - ga[0]) +
    uy * (gc[0] - ga[0]) +
    ux * uy * (ga[0] - gb[0] - gc[0] + gd[0]) +
    dux * (uy * crossValue + vb - va);
  const gy =
    ga[1] +
    ux * (gb[1] - ga[1]) +
    uy * (gc[1] - ga[1]) +
    ux * uy * (ga[1] - gb[1] - gc[1] + gd[1]) +
    duy * (ux * crossValue + vc - va);
  return [value, gx, gy];
}

/** The spatial derivative alone — retained for existing callers and tests. */
export function sampleAnalyticDetailGradient(
  qx: number,
  qy: number,
): readonly [number, number] {
  const sample = sampleAnalyticDetailNoise(qx, qy);
  return [sample[1], sample[2]];
}

/**
 * Sample the existing analytic noise field into a periodic mip-capable map.
 * RG contains d(noise)/d(q), B the noise value (for the crest-skew weight),
 * A stays opaque so the diagnostic can keep one portable RGBA8 sampler on
 * WebGL2. Each signed channel carries its own decode range.
 */
export function createFaithfulDetailGradientTextureData(
  size: number,
): FaithfulDetailGradientTextureData {
  if (!Number.isInteger(size) || size < PERIOD || size % PERIOD !== 0) {
    throw new Error(
      `Faithful detail texture size must be an integer multiple of ${PERIOD}`,
    );
  }
  const values = new Float32Array(size * size * 3);
  let maximum = 0;
  let valueMaximum = 0;
  for (let y = 0; y < size; y++) {
    const qy = ((y + 0.5) * PERIOD) / size;
    for (let x = 0; x < size; x++) {
      const qx = ((x + 0.5) * PERIOD) / size;
      const sample = sampleAnalyticDetailNoise(qx, qy);
      const offset = (y * size + x) * 3;
      values[offset] = sample[1];
      values[offset + 1] = sample[2];
      values[offset + 2] = sample[0];
      maximum = Math.max(maximum, Math.abs(sample[1]), Math.abs(sample[2]));
      valueMaximum = Math.max(valueMaximum, Math.abs(sample[0]));
    }
  }

  const decodeRange = maximum * 1.005;
  const valueDecodeRange = valueMaximum * 1.005;
  const data = new Uint8Array(size * size * 4);
  const encode = (value: number, range: number): number =>
    Math.round(
      Math.min(Math.max(0.5 + 0.5 * value / Math.max(range, 1e-8), 0), 1) *
        255,
    );
  for (let pixel = 0; pixel < size * size; pixel++) {
    const source = pixel * 3;
    const target = pixel * 4;
    data[target] = encode(values[source], decodeRange);
    data[target + 1] = encode(values[source + 1], decodeRange);
    data[target + 2] = encode(values[source + 2], valueDecodeRange);
    data[target + 3] = 255;
  }
  return { data, size, decodeRange, valueDecodeRange };
}

/**
 * Gradient-energy distribution of the analytic field, binned by noise value.
 *
 * This exists for one consumer: the crest-skew weight `max(1 + s·v, 0)`
 * multiplies each octave's drawn gradient, and the skew must be a pure SHAPE
 * control — the variance bookkeeping that hands undrawn energy to the specular
 * lobe assumes the drawn octaves carry exactly their nominal slope variance.
 * The normalisation that keeps that true is
 *
 *     N(s) = 1 / sqrt( E[ max(1 + s·v, 0)² · |g|² ] / E[|g|²] )
 *
 * which needs the JOINT distribution of value and gradient energy, clamp
 * included — for Perlin noise v and |g|² are not independent (slopes are
 * largest mid-flank where v is small), so a Gaussian closed form would be
 * wrong in exactly the range the slider uses. A histogram of |g|² over v
 * captures it to binning error, which is far below the 8-bit quantisation the
 * field is already served through.
 */
export interface DetailNoiseMoments {
  /** Largest |value| over one period of the analytic field. */
  valueRange: number;
  /** RMS of the value field. */
  valueSigma: number;
  /** Bin-centre noise values. */
  binValues: Float64Array;
  /** Fraction of total gradient energy in each bin; sums to 1. */
  binEnergy: Float64Array;
}

const MOMENT_BINS = 64;
/**
 * Samples per axis for the moment sweep. PRIME, deliberately: any count that
 * shares a factor with the 256-cell period samples every noise cell at the
 * same few sub-cell phases, and the value distribution at a fixed phase is
 * badly unrepresentative (at cell corners it is identically zero). A prime
 * count sweeps the sub-cell phase across the whole period.
 */
const MOMENT_SAMPLES = 509;

let cachedMoments: DetailNoiseMoments | undefined;

export function measureDetailNoiseMoments(): DetailNoiseMoments {
  if (cachedMoments) return cachedMoments;

  const samples: Array<readonly [number, number, number]> = [];
  let valueRange = 0;
  let valueSquaredSum = 0;
  for (let y = 0; y < MOMENT_SAMPLES; y++) {
    const qy = ((y + 0.5) * PERIOD) / MOMENT_SAMPLES;
    for (let x = 0; x < MOMENT_SAMPLES; x++) {
      const qx = ((x + 0.5) * PERIOD) / MOMENT_SAMPLES;
      const sample = sampleAnalyticDetailNoise(qx, qy);
      samples.push(sample);
      valueRange = Math.max(valueRange, Math.abs(sample[0]));
      valueSquaredSum += sample[0] * sample[0];
    }
  }

  const binValues = new Float64Array(MOMENT_BINS);
  const binEnergy = new Float64Array(MOMENT_BINS);
  const span = Math.max(valueRange, 1e-8);
  for (let bin = 0; bin < MOMENT_BINS; bin++) {
    binValues[bin] = (((bin + 0.5) / MOMENT_BINS) * 2 - 1) * span;
  }
  let totalEnergy = 0;
  for (const [value, gx, gy] of samples) {
    const energy = gx * gx + gy * gy;
    const t = Math.min(Math.max((value / span + 1) * 0.5, 0), 1 - 1e-9);
    binEnergy[Math.floor(t * MOMENT_BINS)] += energy;
    totalEnergy += energy;
  }
  for (let bin = 0; bin < MOMENT_BINS; bin++) {
    binEnergy[bin] /= Math.max(totalEnergy, 1e-12);
  }

  cachedMoments = {
    valueRange,
    valueSigma: Math.sqrt(valueSquaredSum / samples.length),
    binValues,
    binEnergy,
  };
  return cachedMoments;
}

/**
 * The variance-preserving normalisation for a crest-skew strength `s`:
 * multiplying every drawn detail gradient by `N(s)·max(1 + s·v, 0)` leaves the
 * octave's expected slope variance exactly where the bookkeeping already puts
 * it. `N(0) = 1` identically, so a zero skew is the shipping shader.
 */
export function detailSkewNormalisation(skew: number): number {
  if (skew === 0) return 1;
  const moments = measureDetailNoiseMoments();
  let weighted = 0;
  for (let bin = 0; bin < moments.binValues.length; bin++) {
    const weight = Math.max(1 + skew * moments.binValues[bin], 0);
    weighted += weight * weight * moments.binEnergy[bin];
  }
  return 1 / Math.sqrt(Math.max(weighted, 1e-6));
}

function generateValueNoiseField(
  size: number,
  seed: number,
): { values: Float32Array; decodeRange: number } {
  const values = new Float32Array(size * size * 2);
  let sumLengthSquared = 0;
  let maximum = 0;

  for (let y = 0; y < size; y++) {
    const qy = ((y + 0.5) * PERIOD) / size;
    for (let x = 0; x < size; x++) {
      const qx = ((x + 0.5) * PERIOD) / size;
      const ix = Math.floor(qx);
      const iy = Math.floor(qy);
      const fx = qx - ix;
      const fy = qy - iy;
      const ux = fade(fx);
      const uy = fade(fy);
      const a00 = latticeValue(ix, iy, seed);
      const a10 = latticeValue(ix + 1, iy, seed);
      const a01 = latticeValue(ix, iy + 1, seed);
      const a11 = latticeValue(ix + 1, iy + 1, seed);
      const lower = a00 + (a10 - a00) * ux;
      const upper = a01 + (a11 - a01) * ux;
      const gx =
        ((a10 - a00) * (1 - uy) + (a11 - a01) * uy) *
        fadeDerivative(fx);
      const gy = (upper - lower) * fadeDerivative(fy);
      const offset = (y * size + x) * 2;
      values[offset] = gx;
      values[offset + 1] = gy;
      sumLengthSquared += gx * gx + gy * gy;
    }
  }

  const rms = Math.sqrt(sumLengthSquared / (size * size));
  for (let offset = 0; offset < values.length; offset++) {
    values[offset] /= Math.max(rms, 1e-8);
    maximum = Math.max(maximum, Math.abs(values[offset]));
  }
  return { values, decodeRange: maximum * 1.02 };
}

/**
 * Build two periodic directional-gradient fields packed into RG and BA.
 *
 * The shader samples the coarse field in the base 256-cell detail domain and
 * the fine field after the existing integer octave transform. Hardware mips
 * therefore prefilter both bands without weakening the exact wrap contract.
 */
export function createDetailGradientTextureData(
  size = 512,
  style: DetailGradientTextureStyle = 'spectral',
): DetailGradientTextureData {
  if (!Number.isInteger(size) || size < 16) {
    throw new Error('Detail gradient texture size must be an integer >= 16');
  }
  const coarse =
    style === 'spectral'
      ? generateSpectralField(size, COARSE_COMPONENTS)
      : generateValueNoiseField(size, 0x63d83595);
  const fine =
    style === 'spectral'
      ? generateSpectralField(size, FINE_COMPONENTS)
      : generateValueNoiseField(size, 0x9e3779b9);
  const data = new Uint8Array(size * size * 4);

  for (let pixel = 0; pixel < size * size; pixel++) {
    const source = pixel * 2;
    const target = pixel * 4;
    const encode = (value: number, range: number): number =>
      Math.round(
        Math.min(Math.max(0.5 + 0.5 * (value / Math.max(range, 1e-8)), 0), 1) *
          255,
      );
    data[target] = encode(coarse.values[source], coarse.decodeRange);
    data[target + 1] = encode(coarse.values[source + 1], coarse.decodeRange);
    data[target + 2] = encode(fine.values[source], fine.decodeRange);
    data[target + 3] = encode(fine.values[source + 1], fine.decodeRange);
  }

  return {
    data,
    size,
    coarseDecodeRange: coarse.decodeRange,
    fineDecodeRange: fine.decodeRange,
  };
}
