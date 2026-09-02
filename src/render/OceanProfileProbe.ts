import type {
  OceanDetailRepresentation,
  OceanProfileSettings,
  OceanResidualLoopMode,
} from '../scene/Ocean';
import { DEFAULT_OCEAN_DETAIL_REPRESENTATION } from '../scene/Ocean';

export const OCEAN_PROBE_WARMUP_FRAMES = 24;
export const OCEAN_PROBE_SAMPLE_COUNT = 12;

export interface OceanProbeVariant {
  key: string;
  label: string;
  settings: OceanProfileSettings;
  lutEnabled: boolean;
  /** Variant whose mean should be subtracted to estimate marginal cost. */
  baselineKey?: string;
  /** Optional second subtraction used to split a component's internal work. */
  secondaryBaselineKey?: string;
  secondaryDeltaLabel?: string;
}

export interface SampleSummary {
  mean: number;
  median: number;
  standardDeviation: number;
  minimum: number;
  maximum: number;
  count: number;
}

export interface OceanProbeResult {
  variant: OceanProbeVariant;
  ocean: SampleSummary;
  frame: SampleSummary;
}

const settings = (
  vertexWaveSlots: number,
  residualWaveSlots: number,
  detailOctaves: number,
  foamEnabled: boolean,
  flatFragment = false,
  residualPhaseEnabled = true,
  residualLoopMode: OceanResidualLoopMode = 'shipping',
  detailRepresentation: OceanDetailRepresentation = 'analytic',
): OceanProfileSettings => ({
  vertexWaveSlots,
  residualWaveSlots,
  residualPhaseEnabled,
  residualLoopMode,
  detailOctaves,
  detailRepresentation,
  detailTextureStyle: 'spectral',
  foamEnabled,
  flatFragment,
});

/**
 * Counterfactual shader sweep.
 *
 * Every family changes one dimension from a shared parent. This is more useful
 * than independently toggling random combinations because its subtraction has
 * a named interpretation, while the shipping-vs-base row still exposes the
 * interactions between all enabled regions.
 */
export function createOceanProbeVariants(
  maximumDetailOctaves: number,
): OceanProbeVariant[] {
  const variants: OceanProbeVariant[] = [];
  const vertexSlots = [0, 12, 24, 36, 48];
  for (const slots of vertexSlots) {
    variants.push({
      key: `flat-v${slots}`,
      label: `flat fragment · ${slots} vertex waves`,
      settings: settings(slots, 0, 0, false, true),
      lutEnabled: true,
      baselineKey: slots === 0 ? undefined : 'flat-v0',
    });
  }

  variants.push({
    key: 'base-optics',
    label: 'base water optics',
    settings: settings(48, 0, 0, false),
    lutEnabled: true,
    baselineKey: 'flat-v48',
  });

  variants.push({
    key: 'residual-classify-48',
    label: '+ 48 residual classify/variance only',
    settings: settings(48, 48, 0, false, false, false),
    lutEnabled: true,
    baselineKey: 'base-optics',
  });

  for (const slots of [12, 24, 36, 48]) {
    variants.push({
      key: `residual-${slots}`,
      label: `+ ${slots} residual waves`,
      settings: settings(48, slots, 0, false),
      lutEnabled: true,
      baselineKey: 'base-optics',
      ...(slots === 48
        ? {
            secondaryBaselineKey: 'residual-classify-48',
            secondaryDeltaLabel: 'phase/cos',
          }
        : {}),
    });
  }

  variants.push({
    key: 'residual-48-active',
    label: '+ residual waves · wavelength active window',
    settings: settings(48, 48, 0, false, false, true, 'active'),
    lutEnabled: true,
    baselineKey: 'base-optics',
    secondaryBaselineKey: 'residual-48',
    secondaryDeltaLabel: 'vs legacy 48-slot loop',
  });

  // Structural probes: the same 48-slot scan, restructured but pixel-identical.
  // Their secondary delta against the shipping loop is the direct answer to
  // "is the scan's cost control flow, uniform access, or unrolling?"
  //
  // The `branchless` mode is deliberately NOT in the sweep: measured 2026-07-31
  // it was roughly 5-10x the shipping scan (selects keep every slot's
  // intermediates live, which reads as register-pressure collapse), slow enough
  // to starve the probe's sample deadline. It remains a manual panel mode.
  const loopModes: [OceanResidualLoopMode, string][] = [
    ['texture', 'texelFetch parameters'],
    ['rolled', 'dynamic loop bound'],
  ];
  for (const [mode, label] of loopModes) {
    variants.push({
      key: `residual-48-${mode}`,
      label: `+ 48 residual waves · ${label}`,
      settings: settings(48, 48, 0, false, false, true, mode),
      lutEnabled: true,
      baselineKey: 'base-optics',
      secondaryBaselineKey: 'residual-48',
      secondaryDeltaLabel: 'vs shipping loop',
    });
  }

  const detailCounts = [...new Set([1, 3, maximumDetailOctaves])]
    .filter((count) => count > 0 && count <= maximumDetailOctaves)
    .sort((a, b) => a - b);
  for (const octaves of detailCounts) {
    variants.push({
      key: `detail-${octaves}`,
      label: `+ ${octaves} detail octave${octaves === 1 ? '' : 's'}`,
      settings: settings(48, 0, octaves, false),
      lutEnabled: true,
      baselineKey: 'base-optics',
    });
  }

  variants.push(
    {
      key: 'foam',
      label: '+ foam',
      settings: settings(48, 0, 0, true),
      lutEnabled: true,
      baselineKey: 'base-optics',
    },
    {
      key: 'full-cached',
      label: 'shipping active-window ocean · cached sky',
      settings: settings(
        48,
        48,
        maximumDetailOctaves,
        true,
        false,
        true,
        'active',
        DEFAULT_OCEAN_DETAIL_REPRESENTATION,
      ),
      lutEnabled: true,
      baselineKey: 'base-optics',
    },
    {
      key: 'full-analytic',
      label: 'shipping active-window ocean · analytic sky',
      settings: settings(
        48,
        48,
        maximumDetailOctaves,
        true,
        false,
        true,
        'active',
        DEFAULT_OCEAN_DETAIL_REPRESENTATION,
      ),
      lutEnabled: false,
      baselineKey: 'full-cached',
    },
  );
  return variants;
}

export function summarizeSamples(samples: readonly number[]): SampleSummary {
  if (samples.length === 0) {
    throw new Error('Cannot summarize an empty sample set');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(samples.length - 1, 1);
  return {
    mean,
    median,
    standardDeviation: Math.sqrt(variance),
    minimum: sorted[0],
    maximum: sorted[sorted.length - 1],
    count: samples.length,
  };
}

export function formatOceanProbeResults(
  results: readonly OceanProbeResult[],
): string {
  const byKey = new Map(results.map((result) => [result.variant.key, result]));
  const lines = [
    'ocean GPU component probe',
    'mean ± sample SD; Δ frame subtracts the named counterfactual parent',
    'whole-frame Δ is primary; signed ocean prefix is the noisy cross-check',
    '',
  ];

  for (const result of results) {
    const baseline = result.variant.baselineKey
      ? byKey.get(result.variant.baselineKey)
      : undefined;
    const delta = baseline
      ? result.frame.mean - baseline.frame.mean
      : undefined;
    const deltaStandardError = baseline
      ? Math.sqrt(
          result.frame.standardDeviation ** 2 / result.frame.count +
            baseline.frame.standardDeviation ** 2 / baseline.frame.count,
        )
      : undefined;
    const deltaText =
      delta === undefined || deltaStandardError === undefined
        ? ''
        : ` · Δ frame ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ± ${deltaStandardError.toFixed(2)} ms`;
    const secondaryBaseline = result.variant.secondaryBaselineKey
      ? byKey.get(result.variant.secondaryBaselineKey)
      : undefined;
    const secondaryDelta = secondaryBaseline
      ? result.frame.mean - secondaryBaseline.frame.mean
      : undefined;
    const secondaryStandardError = secondaryBaseline
      ? Math.sqrt(
          result.frame.standardDeviation ** 2 / result.frame.count +
            secondaryBaseline.frame.standardDeviation ** 2 /
              secondaryBaseline.frame.count,
        )
      : undefined;
    const secondaryText =
      secondaryDelta === undefined || secondaryStandardError === undefined
        ? ''
        : ` · ${result.variant.secondaryDeltaLabel ?? 'secondary'} ${secondaryDelta >= 0 ? '+' : ''}${secondaryDelta.toFixed(2)} ± ${secondaryStandardError.toFixed(2)} ms`;
    lines.push(
      `${result.variant.label}`,
      `  frame ${result.frame.mean.toFixed(2)} ± ${result.frame.standardDeviation.toFixed(2)} ms${deltaText}${secondaryText}`,
      `  ocean prefix ${result.ocean.mean.toFixed(2)} ± ${result.ocean.standardDeviation.toFixed(2)} ms · n=${result.ocean.count}`,
    );
  }
  return lines.join('\n');
}
