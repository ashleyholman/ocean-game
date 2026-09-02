import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FOAM_HULL_EXTENT,
  FOAM_NEAR_EXTENT,
  FOAM_FAR_EXTENT,
  FOAM_QUALITY_DESKTOP,
} from '../src/scene/FoamField';

const FOAM_SOURCE = readFileSync('src/scene/FoamField.ts', 'utf8');

/** What the injection pass does to a source of true radius r at a given texel. */
function widenedRadius(trueRadiusM: number, texelM: number): number {
  return Math.max(trueRadiusM, texelM * 0.65);
}

const LEVELS = [
  { name: 'hull', texel: FOAM_HULL_EXTENT / FOAM_QUALITY_DESKTOP.hullResolution },
  { name: 'near', texel: FOAM_NEAR_EXTENT / FOAM_QUALITY_DESKTOP.nearResolution },
  { name: 'far', texel: FOAM_FAR_EXTENT / FOAM_QUALITY_DESKTOP.farResolution },
];

/** Mid-range stern source radius from wakePolicy's 0.4-0.72 m band. */
const SOURCE_RADIUS_M = 0.6;

describe('foam source footprint compensation', () => {
  it('has the level geometry the compensation is sized against', () => {
    expect(LEVELS.map((l) => l.texel)).toEqual([0.375, 0.75, 12]);
  });

  it('keeps the two inner levels within one resolution step of each other', () => {
    // A trail is roughly a 1.2 m ribbon. A level finer than that draws it as a
    // ribbon; a level coarser can only record how much foam is in the texel,
    // and the mask threshold scatters that amount into chunks. A 4x step made
    // the whole transition happen at once, one ship length astern.
    const [hull, near] = LEVELS;
    expect(near.texel / hull.texel).toBe(2);
    // And the near level can still nearly place a 1.2 m ribbon inside a texel.
    expect(near.texel).toBeLessThan(1.2);
  });

  it('conserves deposited foam area across the levels', () => {
    // The exact invariant, free of any profile-shape constant.
    //
    // A pass of the source deposits, per unit track, an amount proportional to
    // weight * R^2: the profile is R wide across the track, and its along-track
    // integral is also proportional to R because the source dwells over a texel
    // for a time proportional to R. Physical foam does not care what resolution
    // is storing it, so that product must be level-independent.
    //
    //   squared weight:  (r/R)^2 * R^2 = r^2     — constant. Correct.
    //   linear weight:   (r/R)   * R^2 = r * R   — grows with the texel.
    //
    // The linear form preserved the ribbon's PEAK instead, and let its WIDTH
    // grow with the texel: each coarser level drew the same trail
    // proportionally wider and just as bright. That is the expanding-phases
    // artifact, and it is why the widening happened at the level handovers
    // rather than anywhere the water was actually doing something.
    const r = SOURCE_RADIUS_M;
    const deposited = (weight: (ratio: number) => number) =>
      LEVELS.map((level) => {
        const R = widenedRadius(r, level.texel);
        return weight(Math.min(r / R, 1)) * R * R;
      });

    const squared = deposited((ratio) => ratio * ratio);
    for (const value of squared) expect(value).toBeCloseTo(r * r, 10);

    const linear = deposited((ratio) => ratio);
    expect(linear[0]).toBeCloseTo(r * r, 10);
    // At 0.75 m texels the 0.65-texel widening floor no longer reaches a 0.6 m
    // source, so the near level needs no correction at all and the two inner
    // levels agree exactly. The far level was depositing 13x the foam area.
    expect(linear[1] / squared[1]).toBeCloseTo(1, 6);
    expect(linear[2] / squared[2]).toBeCloseTo(13, 0);
  });

  it('leaves the hull level untouched and collapses the far level', () => {
    const weight = (texel: number): number => {
      const ratio = Math.min(SOURCE_RADIUS_M / widenedRadius(SOURCE_RADIUS_M, texel), 1);
      return ratio * ratio;
    };
    // The source resolves at both inner levels, so the trail as seen from the
    // ship is untouched and the seam between them carries no amplitude step.
    expect(weight(0.375)).toBe(1);
    expect(weight(0.75)).toBe(1);
    // It does not resolve at 1.5 m, which is where the near level used to be:
    // 62% of the old deposit, and the smaller expansion a ship length astern.
    expect(weight(1.5)).toBeCloseTo(0.379, 3);
    // Ten ship lengths astern the far level was depositing 13x too much foam
    // over a 16 m band: the "ginormous square patch".
    expect(weight(12)).toBeCloseTo(0.0059, 4);
    expect(Math.min(SOURCE_RADIUS_M / widenedRadius(SOURCE_RADIUS_M, 12), 1) / weight(12)).toBeCloseTo(13, 0);
  });

  it('squares the ratio at both wake sources and at neither ambient one', () => {
    const squared = FOAM_SOURCE.match(
      /float footprintWeight = radiusRatio \* radiusRatio;/g,
    );
    // The stern segment and the waterline polyline. Ambient injection never
    // widens, so it has no footprint weight to correct.
    expect(squared).toHaveLength(2);
    expect(FOAM_SOURCE).not.toMatch(
      /float footprintWeight = min\(\s*u\w+Radius \/ max\(sourceRadius, 1e-4\),?\s*1\.0,?\s*\)/,
    );
  });
});
