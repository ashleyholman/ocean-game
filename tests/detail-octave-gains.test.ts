import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OCEAN_DETAIL_SHAPE,
  OCEAN_QUALITY_DESKTOP,
  OCEAN_QUALITY_MOBILE,
  writeDetailOctaveGains,
} from '../src/scene/Ocean';

/** Slope RMS ratio between adjacent detail octaves: 0.55 amplitude × √5 freq. */
const BAND_STEP = 0.55 * Math.sqrt(5);

/** Total drawn slope variance of a gain table over `octaves` active bands. */
function drawnVariance(gains: readonly number[], octaves: number): number {
  let total = 0;
  let bandRms = 1;
  for (let o = 0; o < octaves; o++) {
    total += (gains[o] * bandRms) ** 2;
    bandRms *= BAND_STEP;
  }
  return total;
}

describe('detail octave gains', () => {
  const tiers = [
    ['desktop', OCEAN_QUALITY_DESKTOP.detailOctaves],
    ['mobile', OCEAN_QUALITY_MOBILE.detailOctaves],
  ] as const;

  it('is the identity at zero shift, on every tier', () => {
    for (const [, octaves] of tiers) {
      const gains = new Array(6).fill(0);
      writeDetailOctaveGains(gains, 0, octaves);
      for (const gain of gains) expect(gain).toBeCloseTo(1, 12);
    }
  });

  it('holds total drawn slope variance across the whole shift range', () => {
    // The invariant that lets the shift be a pure shape control: the variance
    // bookkeeping in updateUniforms subtracts the drawn detail from the
    // statistical roughness budget, so a shift that changed the total would
    // silently roughen or polish the sea instead of only reshaping it.
    for (const [tier, octaves] of tiers) {
      const reference = drawnVariance(new Array(6).fill(1), octaves);
      for (const shift of [0, 0.25, 0.5, 0.75, 1]) {
        const gains = new Array(6).fill(0);
        writeDetailOctaveGains(gains, shift, octaves);
        const ratio = drawnVariance(gains, octaves) / reference;
        expect(ratio, `${tier} tier at shift ${shift}`).toBeCloseTo(1, 9);
      }
    }
  });

  it('moves energy toward the mid band at full shift', () => {
    const octaves = OCEAN_QUALITY_DESKTOP.detailOctaves;
    const gains = new Array(6).fill(0);
    writeDetailOctaveGains(gains, 1, octaves);
    // Octave 0 (2.4 m blobs, overlapping the resolved geometry) and the
    // finest octaves give way to octaves 1-2, the 0.3-1.1 m chop window.
    expect(gains[0]).toBeLessThan(1);
    expect(gains[1]).toBeGreaterThan(gains[0]);
    expect(gains[2]).toBeGreaterThan(gains[0]);
    expect(gains[octaves - 1]).toBeLessThan(gains[2]);
  });

  it('leaves inactive octaves at unity rather than a stale gain', () => {
    const gains = new Array(6).fill(0);
    writeDetailOctaveGains(gains, 1, OCEAN_QUALITY_DESKTOP.detailOctaves);
    writeDetailOctaveGains(gains, 1, OCEAN_QUALITY_MOBILE.detailOctaves);
    for (let o = OCEAN_QUALITY_MOBILE.detailOctaves; o < 6; o++) {
      expect(gains[o]).toBe(1);
    }
  });

  it('ships the shape the round landed on', () => {
    expect(DEFAULT_OCEAN_DETAIL_SHAPE.midShift).toBe(1);
    // Zero, and it must STAY zero until the clamp is gone: the skew's
    // max(1 + s·v, 0) flattens whole low-value regions into dead patches that
    // read as warts on the water. Rejected on sight; see the constant's note.
    expect(DEFAULT_OCEAN_DETAIL_SHAPE.crestSkew).toBe(0);
  });
});
