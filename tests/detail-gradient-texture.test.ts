import { describe, expect, it } from 'vitest';
import {
  createDetailGradientTextureData,
  createFaithfulDetailGradientTextureData,
  detailSkewNormalisation,
  measureDetailNoiseMoments,
  sampleAnalyticDetailGradient,
  sampleAnalyticDetailNoise,
} from '../src/ocean/detailGradientTexture';

describe('prefiltered detail gradient texture', () => {
  it('is deterministic, packed, and carries both signed fields', () => {
    const a = createDetailGradientTextureData(48);
    const b = createDetailGradientTextureData(48);
    expect(a.data).toEqual(b.data);
    expect(a.data).toHaveLength(48 * 48 * 4);
    expect(a.coarseDecodeRange).toBeGreaterThan(1);
    expect(a.fineDecodeRange).toBeGreaterThan(1);
    for (let channel = 0; channel < 4; channel++) {
      const values = Array.from(
        { length: 48 * 48 },
        (_, pixel) => a.data[pixel * 4 + channel],
      );
      expect(Math.min(...values)).toBeLessThan(127);
      expect(Math.max(...values)).toBeGreaterThan(128);
    }
  });

  it('rejects unusable texture sizes', () => {
    expect(() => createDetailGradientTextureData(8)).toThrow(/integer >= 16/);
    expect(() => createDetailGradientTextureData(31.5)).toThrow(/integer >= 16/);
  });

  it('keeps the value-noise alternative deterministic and distinct', () => {
    const spectral = createDetailGradientTextureData(48, 'spectral');
    const valueNoiseA = createDetailGradientTextureData(48, 'value-noise');
    const valueNoiseB = createDetailGradientTextureData(48, 'value-noise');
    expect(valueNoiseA.data).toEqual(valueNoiseB.data);
    expect(valueNoiseA.data).not.toEqual(spectral.data);
  });
});

describe('faithful analytic detail cache', () => {
  it('is exactly periodic over the shipping 256-cell domain', () => {
    const points = [
      [0, 0],
      [17.25, 99.75],
      [-0.125, 256.5],
      [255.999, -31.375],
    ] as const;
    for (const [x, y] of points) {
      const baseline = sampleAnalyticDetailGradient(x, y);
      const shiftedX = sampleAnalyticDetailGradient(x + 256, y);
      const shiftedY = sampleAnalyticDetailGradient(x, y - 256);
      expect(shiftedX[0]).toBeCloseTo(baseline[0], 12);
      expect(shiftedX[1]).toBeCloseTo(baseline[1], 12);
      expect(shiftedY[0]).toBeCloseTo(baseline[0], 12);
      expect(shiftedY[1]).toBeCloseTo(baseline[1], 12);
    }
  });

  it('packs the same signed field deterministically', () => {
    const a = createFaithfulDetailGradientTextureData(256);
    const b = createFaithfulDetailGradientTextureData(256);
    expect(a.data).toEqual(b.data);
    expect(a.data).toHaveLength(256 * 256 * 4);
    expect(a.decodeRange).toBeGreaterThan(1);
    const red = Array.from(
      { length: 256 * 256 },
      (_, pixel) => a.data[pixel * 4],
    );
    const green = Array.from(
      { length: 256 * 256 },
      (_, pixel) => a.data[pixel * 4 + 1],
    );
    expect(Math.min(...red)).toBeLessThan(100);
    expect(Math.max(...red)).toBeGreaterThan(155);
    expect(Math.min(...green)).toBeLessThan(100);
    expect(Math.max(...green)).toBeGreaterThan(155);
  });

  it('requires an integer number of texels per analytic cell', () => {
    expect(() => createFaithfulDetailGradientTextureData(255)).toThrow(
      /integer multiple of 256/,
    );
    expect(() => createFaithfulDetailGradientTextureData(384)).toThrow(
      /integer multiple of 256/,
    );
  });

  it('carries the noise value in B for the crest-skew weight', () => {
    const packed = createFaithfulDetailGradientTextureData(256);
    expect(packed.valueDecodeRange).toBeGreaterThan(0);
    const blue = Array.from(
      { length: 256 * 256 },
      (_, pixel) => packed.data[pixel * 4 + 2],
    );
    // A signed field, actually packed: both sides of the midpoint are used.
    expect(Math.min(...blue)).toBeLessThan(100);
    expect(Math.max(...blue)).toBeGreaterThan(155);

    // The value channel decodes back to the analytic field at texel centres.
    const texel = (x: number, y: number): number =>
      ((packed.data[(y * 256 + x) * 4 + 2] / 255) * 2 - 1) *
      packed.valueDecodeRange;
    for (const [x, y] of [[3, 7], [100, 200], [255, 0]] as const) {
      const analytic = sampleAnalyticDetailNoise(x + 0.5, y + 0.5)[0];
      expect(texel(x, y)).toBeCloseTo(analytic, 2);
    }
  });
});

describe('crest-skew normalisation', () => {
  it('is the identity at zero skew and preserves gradient energy elsewhere', () => {
    expect(detailSkewNormalisation(0)).toBe(1);

    // Re-measure the weighted energy directly from the analytic field, clamp
    // included, and check the histogram-derived normalisation returns it to
    // unity. The tolerance covers histogram binning against direct summation.
    const moments = measureDetailNoiseMoments();
    expect(moments.valueRange).toBeGreaterThan(0.5);
    expect(moments.valueSigma).toBeCloseTo(0.204, 1);
    for (const skew of [1.5, 4, 6]) {
      const n = detailSkewNormalisation(skew);
      let weighted = 0;
      let total = 0;
      // Prime, so the sweep is not phase-locked to the noise lattice — 128
      // would land every sample on a cell corner, where the value is zero.
      const samples = 127;
      for (let y = 0; y < samples; y++) {
        for (let x = 0; x < samples; x++) {
          const [value, gx, gy] = sampleAnalyticDetailNoise(
            ((x + 0.5) * 256) / samples,
            ((y + 0.5) * 256) / samples,
          );
          const energy = gx * gx + gy * gy;
          const weight = Math.max(1 + skew * value, 0) * n;
          weighted += weight * weight * energy;
          total += energy;
        }
      }
      expect(weighted / total).toBeGreaterThan(0.98);
      expect(weighted / total).toBeLessThan(1.02);
    }
  });
});
