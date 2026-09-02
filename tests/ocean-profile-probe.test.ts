import { describe, expect, it } from 'vitest';
import {
  createOceanProbeVariants,
  summarizeSamples,
} from '../src/render/OceanProfileProbe';

describe('ocean component probe', () => {
  it('builds comparable counterfactual families and restores the shipping row', () => {
    const variants = createOceanProbeVariants(5);
    const byKey = new Map(variants.map((variant) => [variant.key, variant]));

    expect(byKey.get('flat-v0')?.settings).toMatchObject({
      vertexWaveSlots: 0,
      flatFragment: true,
    });
    expect(byKey.get('residual-48')?.baselineKey).toBe('base-optics');
    expect(byKey.get('detail-5')?.baselineKey).toBe('base-optics');
    expect(byKey.get('full-cached')?.settings).toEqual({
      vertexWaveSlots: 48,
      residualWaveSlots: 48,
      residualPhaseEnabled: true,
      residualLoopMode: 'active',
      detailOctaves: 5,
      detailRepresentation: 'cached-1024',
      detailTextureStyle: 'spectral',
      foamEnabled: true,
      flatFragment: false,
    });
    expect(byKey.get('full-analytic')?.lutEnabled).toBe(false);
    expect(byKey.get('full-analytic')?.baselineKey).toBe('full-cached');
    expect(byKey.get('full-analytic')?.settings.detailRepresentation).toBe(
      'cached-1024',
    );
  });

  it('compares each structural residual-loop probe against both parents', () => {
    const variants = createOceanProbeVariants(5);
    const byKey = new Map(variants.map((variant) => [variant.key, variant]));

    // `branchless` is a manual-only mode: measured 5-10x slower than the
    // shipping scan, it starves the sweep's sample deadline (see
    // createOceanProbeVariants).
    expect(byKey.has('residual-48-branchless')).toBe(false);

    expect(byKey.get('residual-48-active')).toMatchObject({
      baselineKey: 'base-optics',
      secondaryBaselineKey: 'residual-48',
      settings: {
        residualWaveSlots: 48,
        residualLoopMode: 'active',
      },
    });

    for (const mode of ['texture', 'rolled'] as const) {
      const variant = byKey.get(`residual-48-${mode}`);
      expect(variant, `residual-48-${mode} missing`).toBeDefined();
      expect(variant?.settings).toMatchObject({
        residualWaveSlots: 48,
        residualPhaseEnabled: true,
        residualLoopMode: mode,
      });
      expect(variant?.baselineKey).toBe('base-optics');
      expect(variant?.secondaryBaselineKey).toBe('residual-48');
    }
  });

  it('reports mean, median, and sample standard deviation', () => {
    const summary = summarizeSamples([1, 2, 3, 4]);
    expect(summary.mean).toBe(2.5);
    expect(summary.median).toBe(2.5);
    expect(summary.standardDeviation).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(summary.minimum).toBe(1);
    expect(summary.maximum).toBe(4);
    expect(summary.count).toBe(4);
  });
});
