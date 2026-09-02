import { describe, expect, it } from 'vitest';
import {
  decodeResidualCategoryBuffers,
  RESIDUAL_CATEGORY_SLOT_COUNT,
} from '../src/render/OceanResidualCategoryProbe';

describe('residual category probe', () => {
  it('decodes exclusive category counts and ignores transparent background', () => {
    const passA = new Uint8Array([
      2, 10, 1, 20,
      0, 0, 0, 0,
      0, 30, 0, 10,
    ]);
    const passB = new Uint8Array([
      3, 12, 24, 255,
      0, 0, 0, 0,
      0, 8, 10, 255,
    ]);

    const summary = decodeResidualCategoryBuffers(passA, passB, 3, 1);
    expect(summary.oceanPixels).toBe(2);
    expect(summary.invalidPixels).toBe(0);
    expect(summary.means.individuallyEvaluated).toBe(17);
    expect(summary.means.geometryResolved).toBe(20);
    expect(summary.individualP50).toBe(10);
    expect(summary.individualP90).toBe(24);
    expect(summary.individualMaximum).toBe(24);
    expect(summary.theoreticalScanReduction).toBeCloseTo(
      1 - 17 / RESIDUAL_CATEGORY_SLOT_COUNT,
      12,
    );
  });

  it('rejects malformed category pixels from the summary', () => {
    const passA = new Uint8Array([0, 0, 0, 0]);
    const passB = new Uint8Array([0, 47, 0, 255]);
    const summary = decodeResidualCategoryBuffers(passA, passB, 1, 1);
    expect(summary.oceanPixels).toBe(0);
    expect(summary.invalidPixels).toBe(1);
  });

  it('checks buffer dimensions', () => {
    expect(() =>
      decodeResidualCategoryBuffers(new Uint8Array(3), new Uint8Array(4), 1, 1),
    ).toThrow(/dimensions/);
  });
});
