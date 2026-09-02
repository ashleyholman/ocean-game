import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FOAM_LOOKUP_JITTER_TEXELS,
  FOAM_LOOKUP_LEGACY_JITTER_TEXELS,
  FOAM_LOOKUP_SMOOTHING,
  clampFoamLookup,
  createFoamLookup,
  resolveFoamLookup,
  type FoamLookup,
} from '../src/scene/foamLookup';
import { FOAM_NEAR_EXTENT } from '../src/scene/FoamField';

const OCEAN_SOURCE = readFileSync('src/scene/Ocean.ts', 'utf8');

function lookup(): FoamLookup {
  return { jitterTexels: -1, smoothing: -1 };
}

describe('foam field reconstruction', () => {
  it('keeps the legacy arm at the exact established lookup', () => {
    // The legacy arm's whole job is to be comparable against every foam capture
    // taken before this change. A "close enough" jitter would silently rebase
    // the A/B it exists to serve.
    const out = resolveFoamLookup(true, lookup());
    expect(out.jitterTexels).toBe(0.9);
    expect(out.smoothing).toBe(0);
  });

  it('displaces the sample by nothing at all in the replacement', () => {
    // Not a tuning default. Sample displacement is the failure — it samples the
    // field somewhere the field is not — so the replacement's honest value is
    // zero and the quintic warp carries the anti-grid work instead.
    const out = resolveFoamLookup(false, lookup());
    expect(out.jitterTexels).toBe(0);
    expect(out.smoothing).toBeGreaterThan(0);
    expect(out.smoothing).toBe(FOAM_LOOKUP_SMOOTHING);
  });

  it('stops short of a full warp, which trades one grid artifact for another', () => {
    // Strength 1 flattens the interpolant at texel centres as well as at their
    // boundaries, which reads as a lattice of texel-sized plateaus on a flat
    // sea. The replacement has to sit strictly inside the open interval.
    expect(FOAM_LOOKUP_SMOOTHING).toBeGreaterThan(0);
    expect(FOAM_LOOKUP_SMOOTHING).toBeLessThan(1);
  });

  it('starts at the replacement rather than at the behaviour under review', () => {
    const created = createFoamLookup();
    expect(created.jitterTexels).toBe(FOAM_LOOKUP_JITTER_TEXELS);
    expect(created.smoothing).toBe(FOAM_LOOKUP_SMOOTHING);
  });

  it('never lets a lab value climb past the setting known to fail', () => {
    const out = lookup();
    clampFoamLookup({ jitterTexels: 5, smoothing: 4 }, out);
    expect(out.jitterTexels).toBe(FOAM_LOOKUP_LEGACY_JITTER_TEXELS);
    expect(out.smoothing).toBe(1);

    clampFoamLookup({ jitterTexels: -3, smoothing: -2 }, out);
    expect(out.jitterTexels).toBe(0);
    expect(out.smoothing).toBe(0);

    clampFoamLookup({ jitterTexels: Number.NaN, smoothing: Number.NaN }, out);
    expect(out.jitterTexels).toBe(0);
    expect(out.smoothing).toBe(0);
  });

  it('costs a metre and a third of sea at the legacy setting', () => {
    // The number that makes the fault legible: this is a displacement in metres
    // of open water, not a sub-pixel dither, and a hull trail is only a couple
    // of texels wide.
    const nearTexelM = FOAM_NEAR_EXTENT / 256;
    expect(nearTexelM).toBeCloseTo(1.5, 6);
    expect(FOAM_LOOKUP_LEGACY_JITTER_TEXELS * nearTexelM).toBeCloseTo(1.35, 6);
  });
});

describe('the quintic fraction warp', () => {
  // The shipped warp is GLSL, so pin the polynomial in the source and assert the
  // properties on its mirror. Both halves are needed: the maths below is only
  // about the wake if it is the same maths the fragment shader runs.
  const warp = (f: number): number => f * f * f * (f * (f * 6 - 15) + 10);

  it('is the polynomial the shader actually evaluates', () => {
    expect(OCEAN_SOURCE).toContain('f * f * f * (f * (f * 6.0 - 15.0) + 10.0)');
  });

  it('leaves texel centres where they were', () => {
    expect(warp(0)).toBe(0);
    expect(warp(1)).toBe(1);
  });

  it('has a vanishing derivative at both ends, which is the whole point', () => {
    // A zero gradient on each side of a texel boundary is what makes the
    // reconstruction C1 across it, and the gradient jump is what the diamond
    // lattice is the level sets of.
    const h = 1e-6;
    expect((warp(h) - warp(0)) / h).toBeCloseTo(0, 8);
    expect((warp(1) - warp(1 - h)) / h).toBeCloseTo(0, 8);
  });

  it('is monotonic, so it reorders no foam', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const value = warp(i / 200);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBeCloseTo(1, 12);
  });

  it('is skipped entirely at strength zero rather than rounded to', () => {
    // The early exit is what lets the legacy arm claim bit-exactness: the
    // reconstructed uv would otherwise come back through a multiply and a
    // divide that need not land on the same float.
    expect(OCEAN_SOURCE).toContain('if (strength <= 0.0) return uv;');
  });

  it('warps only the fraction, so the sample stays in its own texel', () => {
    for (let i = 0; i <= 100; i++) {
      const f = i / 100;
      const warped = warp(f);
      expect(warped).toBeGreaterThanOrEqual(0);
      expect(warped).toBeLessThanOrEqual(1);
    }
  });
});
