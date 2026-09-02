export const RESIDUAL_CATEGORY_SLOT_COUNT = 48;

export interface ResidualCategoryMeans {
  unused: number;
  geometryResolved: number;
  geometryTransition: number;
  residualVisible: number;
  residualRoughnessTransition: number;
  fullyStatistical: number;
  individuallyEvaluated: number;
}

export interface ResidualCategorySummary {
  width: number;
  height: number;
  oceanPixels: number;
  oceanCoverage: number;
  invalidPixels: number;
  means: ResidualCategoryMeans;
  individualP50: number;
  individualP90: number;
  individualP95: number;
  individualMaximum: number;
  theoreticalScanReduction: number;
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
 * Decode the two lossless RGBA8 category passes emitted by the ocean shader.
 * Pass A stores four counts. Pass B stores the remaining two, the exact
 * individually-evaluated count, and an opaque ocean mask.
 */
export function decodeResidualCategoryBuffers(
  passA: Uint8Array,
  passB: Uint8Array,
  width: number,
  height: number,
): ResidualCategorySummary {
  const expectedLength = width * height * 4;
  if (passA.length !== expectedLength || passB.length !== expectedLength) {
    throw new Error('Residual category buffers do not match their dimensions');
  }

  const sums: ResidualCategoryMeans = {
    unused: 0,
    geometryResolved: 0,
    geometryTransition: 0,
    residualVisible: 0,
    residualRoughnessTransition: 0,
    fullyStatistical: 0,
    individuallyEvaluated: 0,
  };
  const histogram = new Array<number>(RESIDUAL_CATEGORY_SLOT_COUNT + 1).fill(0);
  let oceanPixels = 0;
  let invalidPixels = 0;

  for (let offset = 0; offset < expectedLength; offset += 4) {
    if (passB[offset + 3] === 0) continue;

    const unused = passA[offset];
    const geometryResolved = passA[offset + 1];
    const geometryTransition = passA[offset + 2];
    const residualVisible = passA[offset + 3];
    const residualRoughnessTransition = passB[offset];
    const fullyStatistical = passB[offset + 1];
    const individuallyEvaluated = passB[offset + 2];
    const categoryTotal =
      unused +
      geometryResolved +
      geometryTransition +
      residualVisible +
      residualRoughnessTransition +
      fullyStatistical;
    const expectedIndividual =
      geometryTransition + residualVisible + residualRoughnessTransition;
    if (
      categoryTotal !== RESIDUAL_CATEGORY_SLOT_COUNT ||
      individuallyEvaluated !== expectedIndividual ||
      individuallyEvaluated > RESIDUAL_CATEGORY_SLOT_COUNT
    ) {
      invalidPixels++;
      continue;
    }

    oceanPixels++;
    sums.unused += unused;
    sums.geometryResolved += geometryResolved;
    sums.geometryTransition += geometryTransition;
    sums.residualVisible += residualVisible;
    sums.residualRoughnessTransition += residualRoughnessTransition;
    sums.fullyStatistical += fullyStatistical;
    sums.individuallyEvaluated += individuallyEvaluated;
    histogram[individuallyEvaluated]++;
  }

  const divisor = Math.max(oceanPixels, 1);
  const means = Object.fromEntries(
    Object.entries(sums).map(([key, value]) => [key, value / divisor]),
  ) as unknown as ResidualCategoryMeans;

  return {
    width,
    height,
    oceanPixels,
    oceanCoverage: oceanPixels / Math.max(width * height, 1),
    invalidPixels,
    means,
    individualP50: percentileFromHistogram(histogram, oceanPixels, 0.5),
    individualP90: percentileFromHistogram(histogram, oceanPixels, 0.9),
    individualP95: percentileFromHistogram(histogram, oceanPixels, 0.95),
    individualMaximum: histogram.reduce(
      (maximum, count, value) => (count > 0 ? value : maximum),
      0,
    ),
    theoreticalScanReduction:
      1 - means.individuallyEvaluated / RESIDUAL_CATEGORY_SLOT_COUNT,
    individualHistogram: histogram,
  };
}

export function formatResidualCategorySummary(
  summary: ResidualCategorySummary,
): string {
  const m = summary.means;
  const count = (value: number): string => value.toFixed(2);
  return [
    'residual category distribution · current frozen view',
    `buffer ${summary.width}×${summary.height} · ocean ${(summary.oceanCoverage * 100).toFixed(1)}% (${summary.oceanPixels.toLocaleString()} px)`,
    '',
    `mean slots/pixel (exclusive, total ${RESIDUAL_CATEGORY_SLOT_COUNT})`,
    `  unused ${count(m.unused)}`,
    `  geometry-resolved ${count(m.geometryResolved)}`,
    `  geometry transition ${count(m.geometryTransition)}`,
    `  residual-visible ${count(m.residualVisible)}`,
    `  residual/roughness transition ${count(m.residualRoughnessTransition)}`,
    `  fully statistical ${count(m.fullyStatistical)}`,
    '',
    `active-window individual work ${count(m.individuallyEvaluated)} slots mean`,
    `  p50 ${summary.individualP50} · p90 ${summary.individualP90} · p95 ${summary.individualP95} · max ${summary.individualMaximum}`,
    `  theoretical scan reduction ${(summary.theoreticalScanReduction * 100).toFixed(1)}% before bound/prefix overhead`,
    summary.invalidPixels === 0
      ? '  integrity: every decoded ocean pixel sums to 48 slots'
      : `  integrity: ${summary.invalidPixels.toLocaleString()} invalid pixels`,
  ].join('\n');
}
