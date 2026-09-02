import { describe, expect, it } from 'vitest';
import {
  BOW_PRESSURE_CROWN_SHOULDER_FRACTION,
  BOW_PRESSURE_SHOULDER_STATIONS_AFT,
  resolveBowPressureFrontGeometry,
  type BowPressureFrontGeometry,
} from '../src/scene/bowWakeGeometry';

function geometry(): BowPressureFrontGeometry {
  return {
    tipCentreX: 99,
    tipCentreZ: 99,
    tipHalfWidthM: 99,
    shoulderCentreX: 99,
    shoulderCentreZ: 99,
    shoulderHalfWidthM: 99,
    crownHalfWidthM: 99,
  };
}

describe('finite bow-pressure-front geometry', () => {
  it('uses the live tip and a broad cut two stations aft', () => {
    const points = [
      { x: 2, z: 0 },
      { x: -2, z: 0 },
      { x: 1.4, z: 1 },
      { x: -1.4, z: 1 },
      { x: 0.1, z: 2 },
      { x: -0.1, z: 2 },
    ];
    const out = geometry();

    expect(BOW_PRESSURE_SHOULDER_STATIONS_AFT).toBe(2);
    expect(resolveBowPressureFrontGeometry(points, 3, out)).toBe(true);
    expect(out).toMatchObject({
      tipCentreX: 0,
      tipCentreZ: 2,
      tipHalfWidthM: 0.1,
      shoulderCentreX: 0,
      shoulderCentreZ: 0,
      shoulderHalfWidthM: 2,
    });
    expect(out.crownHalfWidthM).toBeCloseTo(
      2 * BOW_PRESSURE_CROWN_SHOULDER_FRACTION,
      12,
    );
  });

  it('lets the 0.58 floor win on a fine-entry hull, as it does in production', () => {
    // Production shape: the most-forward complete cut sits where the hull is
    // narrowest, so the measured tip is a fraction of a metre against a
    // shoulder half-breadth of about two. Live uniforms read out of
    // ?perf=wake-bow give shoulder 2.056 and crown 1.192, and
    // 2.056 * 0.58 = 1.192 exactly — the tip never wins here.
    const points = [
      { x: 2.06, z: 0 },
      { x: -2.06, z: 0 },
      { x: 1.4, z: 1 },
      { x: -1.4, z: 1 },
      { x: 0.28, z: 2 },
      { x: -0.28, z: 2 },
    ];
    const out = geometry();

    expect(resolveBowPressureFrontGeometry(points, 3, out)).toBe(true);
    expect(out.tipHalfWidthM).toBeCloseTo(0.28, 12);
    expect(out.crownHalfWidthM).toBeCloseTo(
      2.06 * BOW_PRESSURE_CROWN_SHOULDER_FRACTION,
      12,
    );
  });

  it('lets a genuinely bluff tip beat the floor', () => {
    const points = [
      { x: 1.8, z: 0 },
      { x: -1.8, z: 0 },
      { x: 1.1, z: 1 },
      { x: -1.1, z: 1 },
    ];
    const out = geometry();

    expect(resolveBowPressureFrontGeometry(points, 2, out)).toBe(true);
    expect(out.tipHalfWidthM).toBeCloseTo(1.1, 12);
    expect(out.crownHalfWidthM).toBeCloseTo(1.1, 12);
  });

  it('has a one-cut fallback and clears stale output with no source', () => {
    const out = geometry();
    expect(resolveBowPressureFrontGeometry(
      [{ x: 0.8, z: 4 }, { x: -0.8, z: 4 }],
      1,
      out,
    )).toBe(true);
    expect(out.shoulderHalfWidthM).toBeCloseTo(0.8, 12);
    expect(out.crownHalfWidthM).toBeCloseTo(0.8, 12);

    expect(resolveBowPressureFrontGeometry([], 0, out)).toBe(false);
    expect(out).toEqual({
      tipCentreX: 0,
      tipCentreZ: 0,
      tipHalfWidthM: 0,
      shoulderCentreX: 0,
      shoulderCentreZ: 0,
      shoulderHalfWidthM: 0,
      crownHalfWidthM: 0,
    });
  });
});
