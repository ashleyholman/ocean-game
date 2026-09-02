import { describe, expect, it } from 'vitest';
import { decodeDetailCategoryBuffer } from '../src/render/OceanDetailCategoryProbe';

describe('detail category probe', () => {
  it('decodes octave categories and ignores transparent background', () => {
    const pixels = new Uint8Array([
      2, 1, 2, 255,
      0, 0, 0, 0,
      0, 1, 4, 255,
    ]);
    const summary = decodeDetailCategoryBuffer(pixels, 3, 1, 5);
    expect(summary.oceanPixels).toBe(2);
    expect(summary.invalidPixels).toBe(0);
    expect(summary.meanFullyVisible).toBe(1);
    expect(summary.meanTransition).toBe(1);
    expect(summary.meanFullyStatistical).toBe(3);
    expect(summary.meanIndividuallyEvaluated).toBe(2);
    expect(summary.individualP50).toBe(1);
    expect(summary.individualP95).toBe(3);
    expect(summary.individualMaximum).toBe(3);
  });

  it('rejects malformed category pixels from the summary', () => {
    const summary = decodeDetailCategoryBuffer(
      new Uint8Array([1, 1, 2, 255]),
      1,
      1,
      5,
    );
    expect(summary.oceanPixels).toBe(0);
    expect(summary.invalidPixels).toBe(1);
  });

  it('checks dimensions and configured octave count', () => {
    expect(() =>
      decodeDetailCategoryBuffer(new Uint8Array(3), 1, 1, 5),
    ).toThrow(/dimensions/);
    expect(() =>
      decodeDetailCategoryBuffer(new Uint8Array(4), 1, 1, 7),
    ).toThrow(/diagnostic range/);
  });
});
