export const DETAIL_CATEGORY_MAX_OCTAVES = 6;

export interface DetailCategorySummary {
  width: number;
  height: number;
  oceanPixels: number;
  oceanCoverage: number;
  invalidPixels: number;
  configuredOctaves: number;
  meanFullyVisible: number;
  meanTransition: number;
  meanFullyStatistical: number;
  meanIndividuallyEvaluated: number;
  individualP50: number;
  individualP90: number;
  individualP95: number;
  individualMaximum: number;
  individualHistogram: readonly number[];
}

function percentileFromHistogram(
  histogram: readonly number[],
  total: number,
  percentile: number,
): number {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  let cumulative = 0;
  for (let value = 0; value < histogram.length; value++) {
    cumulative += histogram[value];
    if (cumulative >= target) return value;
  }
  return histogram.length - 1;
}

/**
 * Decode the lossless RGBA8 detail-category pass emitted by the ocean shader.
 * RGB stores fully-visible, transition and fully-statistical octave counts;
 * alpha is an exact ocean mask.
 */
export function decodeDetailCategoryBuffer(
  pixels: Uint8Array,
  width: number,
  height: number,
  configuredOctaves: number,
): DetailCategorySummary {
  const expectedLength = width * height * 4;
  if (pixels.length !== expectedLength) {
    throw new Error('Detail category buffer does not match its dimensions');
  }
  if (
    !Number.isInteger(configuredOctaves) ||
    configuredOctaves < 0 ||
    configuredOctaves > DETAIL_CATEGORY_MAX_OCTAVES
  ) {
    throw new Error('Configured detail octave count is outside the diagnostic range');
  }

  const histogram = new Array<number>(configuredOctaves + 1).fill(0);
  let oceanPixels = 0;
  let invalidPixels = 0;
  let fullyVisibleSum = 0;
  let transitionSum = 0;
  let fullyStatisticalSum = 0;

  for (let offset = 0; offset < expectedLength; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const fullyVisible = pixels[offset];
    const transition = pixels[offset + 1];
    const fullyStatistical = pixels[offset + 2];
    if (fullyVisible + transition + fullyStatistical !== configuredOctaves) {
      invalidPixels++;
      continue;
    }

    const individuallyEvaluated = fullyVisible + transition;
    oceanPixels++;
    fullyVisibleSum += fullyVisible;
    transitionSum += transition;
    fullyStatisticalSum += fullyStatistical;
    histogram[individuallyEvaluated]++;
  }

  const divisor = Math.max(oceanPixels, 1);
  const meanFullyVisible = fullyVisibleSum / divisor;
  const meanTransition = transitionSum / divisor;
  const meanFullyStatistical = fullyStatisticalSum / divisor;
  const meanIndividuallyEvaluated = meanFullyVisible + meanTransition;

  return {
    width,
    height,
    oceanPixels,
    oceanCoverage: oceanPixels / Math.max(width * height, 1),
    invalidPixels,
    configuredOctaves,
    meanFullyVisible,
    meanTransition,
    meanFullyStatistical,
    meanIndividuallyEvaluated,
    individualP50: percentileFromHistogram(histogram, oceanPixels, 0.5),
    individualP90: percentileFromHistogram(histogram, oceanPixels, 0.9),
    individualP95: percentileFromHistogram(histogram, oceanPixels, 0.95),
    individualMaximum: histogram.reduce(
      (maximum, count, value) => (count > 0 ? value : maximum),
      0,
    ),
    individualHistogram: histogram,
  };
}

export function formatDetailCategorySummary(
  summary: DetailCategorySummary,
): string {
  return [
    'detail octave distribution · current frozen view',
    `buffer ${summary.width}×${summary.height} · ocean ${(summary.oceanCoverage * 100).toFixed(1)}% (${summary.oceanPixels.toLocaleString()} px)`,
    '',
    `mean octaves/pixel (configured ${summary.configuredOctaves})`,
    `  fully visible ${summary.meanFullyVisible.toFixed(2)}`,
    `  Nyquist transition ${summary.meanTransition.toFixed(2)}`,
    `  fully statistical ${summary.meanFullyStatistical.toFixed(2)}`,
    '',
    `analytic noise work ${summary.meanIndividuallyEvaluated.toFixed(2)} octaves mean`,
    `  p50 ${summary.individualP50} · p90 ${summary.individualP90} · p95 ${summary.individualP95} · max ${summary.individualMaximum}`,
    summary.invalidPixels === 0
      ? `  integrity: every decoded ocean pixel sums to ${summary.configuredOctaves} octaves`
      : `  integrity: ${summary.invalidPixels.toLocaleString()} invalid pixels`,
  ].join('\n');
}
