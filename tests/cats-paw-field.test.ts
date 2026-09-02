import { describe, expect, it } from 'vitest';

import { findSeaState } from '../src/ocean/presets';
import {
  WaveField,
  createSurfaceSample,
} from '../src/scene/Waves';
import {
  CatsPawField,
  catsPawLocalWindSpeedMps,
  sampleCatsPawField,
  sampleCatsPawFieldGpuMirror,
} from '../src/weather/CatsPawField';
import type { CanonicalWorldState } from '../src/world/types';

const PATCH_M = 96;
const PERIOD_S = 32;

function worldAt(
  x = 6_378_137,
  y = 0,
  z = 0,
): CanonicalWorldState {
  return {
    worldInstantUtcSeconds: 0,
    worldSecondsPerRealSecond: 30,
    paused: false,
    positionEcefM: { x, y, z },
    velocityEcefMps: { x: 0, y: 0, z: 0 },
    // At this equatorial point: +X is up, +Y is local right, +Z forward.
    surfaceFrameEcef: {
      right: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: 1 },
      up: { x: 1, y: 0, z: 0 },
    },
  };
}

const CONFIG = Object.freeze({
  gustExcessMps: 3.2,
  patchSizeM: PATCH_M,
  periodSeconds: PERIOD_S,
});

describe("deterministic spatial cat's-paw field", () => {
  it('is repeatable, zero-mean over whole periods, and bounded', () => {
    const a = new CatsPawField(0x12345678);
    const b = new CatsPawField(0x12345678);
    const world = worldAt();
    const frameA = a.update(7.25, world, { x: 0.6, y: -0.8 }, CONFIG);
    const frameB = b.update(7.25, world, { x: 0.6, y: -0.8 }, CONFIG);
    expect(frameB).toEqual(frameA);

    let sum = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    const steps = 128;
    for (let ix = 0; ix < steps; ix++) {
      for (let iz = 0; iz < steps; iz++) {
        const value = sampleCatsPawField(
          frameA,
          (ix / steps) * PATCH_M * 4,
          (iz / steps) * PATCH_M * 4,
        );
        sum += value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    expect(Math.abs(sum / (steps * steps))).toBeLessThan(1e-12);
    expect(minimum).toBeGreaterThanOrEqual(-1);
    expect(maximum).toBeLessThanOrEqual(1);
    expect(minimum).toBeLessThan(-0.75);
    expect(maximum).toBeGreaterThan(0.75);
  });

  it('agrees with the Float32 GPU mirror at shared sample points', () => {
    const field = new CatsPawField(0xc001d00d);
    const frame = field.update(
      19.75,
      worldAt(),
      { x: -0.9238795, y: 0.3826834 },
      CONFIG,
    );
    for (let x = -1400; x <= 1400; x += 137) {
      for (let z = -900; z <= 900; z += 113) {
        expect(
          Math.abs(
            sampleCatsPawField(frame, x, z) -
              sampleCatsPawFieldGpuMirror(frame, x, z),
          ),
        ).toBeLessThan(2.5e-5);
      }
    }
  });

  it('is continuous across canonical origin and periodic-advection wraps', () => {
    const first = new CatsPawField(41);
    const shifted = new CatsPawField(41);
    const frameA = first.update(0, worldAt(), { x: 1, y: 0 }, CONFIG);
    // Move the render origin one patch along ECEF/local right. Sampling the
    // same physical point at -PATCH_M must give the identical value.
    const frameB = shifted.update(
      0,
      worldAt(6_378_137, PATCH_M, 0),
      { x: 1, y: 0 },
      CONFIG,
    );
    expect(sampleCatsPawField(frameB, -PATCH_M, 0)).toBeCloseTo(
      sampleCatsPawField(frameA, 0, 0),
      13,
    );

    // One passage period advects exactly one unit cycle downwind.
    const beforeWrap = sampleCatsPawField(frameA, 17, -23);
    first.update(PERIOD_S, worldAt(), { x: 1, y: 0 }, CONFIG);
    expect(sampleCatsPawField(first.frame, 17, -23)).toBeCloseTo(
      beforeWrap,
      13,
    );
  });

  it('keeps a physical point fixed while the transported render axes rotate', () => {
    const theta = 0.37;
    const beforeField = new CatsPawField(73);
    const afterField = new CatsPawField(73);
    const before = beforeField.update(0, worldAt(), { x: 1, y: 0 }, CONFIG);
    const rotatedWorld = worldAt();
    rotatedWorld.surfaceFrameEcef.right = {
      x: 0,
      y: Math.cos(theta),
      z: Math.sin(theta),
    };
    rotatedWorld.surfaceFrameEcef.forward = {
      x: 0,
      y: -Math.sin(theta),
      z: Math.cos(theta),
    };
    const after = afterField.update(0, rotatedWorld, { x: 1, y: 0 }, CONFIG);

    const oldX = 31;
    const oldZ = -47;
    const newX = oldX * Math.cos(theta) - oldZ * Math.sin(theta);
    const newZ = oldX * Math.sin(theta) + oldZ * Math.cos(theta);
    expect(sampleCatsPawField(after, newX, newZ)).toBeCloseTo(
      sampleCatsPawField(before, oldX, oldZ),
      13,
    );
  });

  it('bounds physical wind and resets deterministically', () => {
    expect(catsPawLocalWindSpeedMps(2, 5, -1)).toBe(0);
    expect(catsPawLocalWindSpeedMps(8, 3, 1)).toBe(11);

    const field = new CatsPawField(99);
    const world = worldAt();
    field.update(11, world, { x: 0, y: -1 }, CONFIG);
    const first = sampleCatsPawField(field.frame, 8, 12);
    field.update(29, world, { x: 0, y: -1 }, CONFIG);
    field.reset();
    field.update(11, world, { x: 0, y: -1 }, CONFIG);
    expect(sampleCatsPawField(field.frame, 8, 12)).toBe(first);
  });

  it('cannot change buoyancy or orbital velocity, even at full amplitude', () => {
    const waves = new WaveField(findSeaState('STORM'));
    waves.setTime(19.25);
    waves.setOrigin(37, -21);
    const before = createSurfaceSample();
    const after = createSurfaceSample();
    waves.sample(4.5, -7.25, before);

    const field = new CatsPawField();
    field.update(120, worldAt(), { x: 1, y: 0 }, {
      gustExcessMps: 20,
      patchSizeM: 20,
      periodSeconds: 4,
    });
    // Sampling the presentation field has no route back into WaveField.
    sampleCatsPawField(field.frame, 4.5, -7.25);
    waves.sample(4.5, -7.25, after);
    expect(after).toEqual(before);
  });
});
