/** Number of sub-pixel detail samples before the temporal pattern repeats. */
export const OCEAN_TEMPORAL_JITTER_PERIOD = 8;

/** Friendly tuning range exposed by Ocean Lab rather than raw EMA weights. */
export const OCEAN_TEMPORAL_STABILITY_MIN = 0;
export const OCEAN_TEMPORAL_STABILITY_MAX = 100;
export const OCEAN_TEMPORAL_DEFAULT_STABILITY = 50;
export const OCEAN_TEMPORAL_DEFAULT_HISTORY_WEIGHT = 0.86;

export function clampOceanTemporalStability(stability: number): number {
  if (!Number.isFinite(stability)) return OCEAN_TEMPORAL_DEFAULT_STABILITY;
  return Math.min(
    OCEAN_TEMPORAL_STABILITY_MAX,
    Math.max(OCEAN_TEMPORAL_STABILITY_MIN, stability),
  );
}

/**
 * Map the friendly stability dial onto the exponential history accumulator.
 *
 * Raw weights become extraordinarily sensitive near 1.0, so the panel never
 * exposes them linearly. Zero is a one-frame/current-only result, 50 preserves
 * the tuned 0.86 default (about seven effective samples), and 100 reaches
 * 0.9804 (about 51 effective samples) without ever becoming frozen at 1.0.
 */
export function oceanTemporalHistoryWeight(stability: number): number {
  const bounded = clampOceanTemporalStability(stability);
  return 1 - Math.pow(
    1 - OCEAN_TEMPORAL_DEFAULT_HISTORY_WEIGHT,
    bounded / OCEAN_TEMPORAL_DEFAULT_STABILITY,
  );
}

/**
 * Motion-vector range carried by the compact RGBA8 ocean metadata target.
 *
 * A range of +/-32 pixels keeps the quantisation step at roughly a quarter of
 * a pixel. Faster motion is not clamped into a plausible-looking lie: the
 * metadata shader marks it invalid and the resolve uses the current frame.
 */
export const OCEAN_TEMPORAL_MOTION_RANGE_PX = 32;

/** Radical-inverse Halton sample in [0, 1). */
export function halton(index: number, base: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('Halton index must be a non-negative integer');
  }
  if (!Number.isInteger(base) || base < 2) {
    throw new RangeError('Halton base must be an integer >= 2');
  }

  let i = index;
  let fraction = 1;
  let result = 0;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

/**
 * Eight-sample Halton(2, 3) detail jitter, expressed in screen pixels.
 *
 * Indexing starts at one because Halton sample zero is the corner of the unit
 * square. The sequence is centred around the pixel before it is handed to the
 * ocean shader, which turns it into a parameter-space offset with derivatives.
 */
export function oceanTemporalJitter(frameIndex: number): readonly [number, number] {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError('Temporal frame index must be a non-negative integer');
  }
  const sample = (frameIndex % OCEAN_TEMPORAL_JITTER_PERIOD) + 1;
  return [halton(sample, 2) - 0.5, halton(sample, 3) - 0.5];
}

/** CPU mirror of the metadata shader's signed-motion encoding. */
export function encodeOceanMotionPixel(value: number): number {
  const normalized = value / (2 * OCEAN_TEMPORAL_MOTION_RANGE_PX) + 0.5;
  return Math.min(Math.max(normalized, 0), 1);
}

/** CPU mirror of the temporal resolve's signed-motion decoding. */
export function decodeOceanMotionPixel(encoded: number): number {
  return (Math.min(Math.max(encoded, 0), 1) - 0.5) *
    (2 * OCEAN_TEMPORAL_MOTION_RANGE_PX);
}
