import { describe, expect, it } from 'vitest';
import {
  CLOUD_TILE_HEIGHT,
  CLOUD_TILE_WIDTH,
  createCloudTileGrid,
} from '../src/scene/CloudDome';
import {
  CLOUD_TILE_REFRESH_FRAMES,
  CloudTileScheduler,
} from '../src/scene/cloudTileScheduler';

describe('cloud tile grid', () => {
  it('covers each production cache exactly with fixed angular tiles', () => {
    const desktop = createCloudTileGrid(6144, 1280);
    expect(desktop.columns).toBe(24);
    expect(desktop.rows).toBe(10);
    expect(desktop.tiles).toHaveLength(240);

    const mobile = createCloudTileGrid(4096, 768);
    expect(mobile.columns).toBe(16);
    expect(mobile.rows).toBe(6);
    expect(mobile.tiles).toHaveLength(96);

    for (const grid of [desktop, mobile]) {
      expect(grid.tiles.every((tile) => tile.width === CLOUD_TILE_WIDTH)).toBe(true);
      expect(grid.tiles.every((tile) => tile.height === CLOUD_TILE_HEIGHT)).toBe(true);
      expect(
        grid.tiles.every(
          (tile) =>
            Math.abs(tile.direction.length() - 1) < 1e-6 &&
            tile.angularRadius > 0,
        ),
      ).toBe(true);
    }
  });

  it('clips edge tiles for non-production dimensions', () => {
    const grid = createCloudTileGrid(600, 300);
    expect(grid.columns).toBe(3);
    expect(grid.rows).toBe(3);
    expect(grid.tiles.at(-1)).toMatchObject({
      x: 512,
      y: 256,
      width: 88,
      height: 44,
    });
  });
});

describe('cloud tile scheduler', () => {
  it('stages a stable guard set within sixty rendered frames', () => {
    const scheduler = new CloudTileScheduler(180);
    const guard = new Set(Array.from({ length: 180 }, (_, index) => index));
    const ready = new Int32Array(180);
    ready.fill(-1);
    const seen = new Set<number>();

    for (let frame = 0; frame < CLOUD_TILE_REFRESH_FRAMES; frame++) {
      const schedule = scheduler.select(
        7,
        ready,
        guard,
        frame,
        frame === 59,
      );
      expect(schedule.steadyBudget).toBe(3);
      expect(schedule.catchUpCount).toBe(0);
      expect(new Set(schedule.indices).size).toBe(schedule.indices.length);
      schedule.indices.forEach((index) => seen.add(index));
      scheduler.markReady(7, ready, schedule.indices);
    }

    expect(seen.size).toBe(180);
    expect([...ready].every((generation) => generation === 7)).toBe(true);
  });

  it('adds every missing required tile before the synchronized swap', () => {
    const scheduler = new CloudTileScheduler(120);
    const ready = new Int32Array(120);
    ready.fill(-1);
    const guard = new Set([40, 41, 42, 43]);
    const schedule = scheduler.select(3, ready, guard, 59, true);

    expect(schedule.steadyBudget).toBe(0);
    expect(schedule.steadyCount).toBe(0);
    expect(schedule.catchUpCount).toBe(4);
    expect(new Set(schedule.indices)).toEqual(guard);
  });

  it('does not catch up guard tiles before the generation boundary', () => {
    const scheduler = new CloudTileScheduler(120);
    const ready = new Int32Array(120);
    ready.fill(-1);
    const schedule = scheduler.select(
      4,
      ready,
      new Set([70, 71, 72]),
      0,
      false,
    );
    expect(schedule.catchUpCount).toBe(0);
    expect(schedule.steadyCount).toBe(1);
  });

  it('skips tiles already ready in the staging generation', () => {
    const scheduler = new CloudTileScheduler(8);
    const ready = new Int32Array(8);
    ready.fill(-1);
    ready[0] = 9;
    ready[1] = 9;
    const schedule = scheduler.select(
      9,
      ready,
      new Set([0, 1, 2, 3]),
      0,
      false,
    );
    expect(schedule.steadyCount).toBe(1);
    expect(schedule.indices[0]).toBe(2);
  });

  it('finishes the current guard even when membership changes late', () => {
    const scheduler = new CloudTileScheduler(240);
    const ready = new Int32Array(240);
    ready.fill(-1);
    let finalGuard = new Set<number>();
    for (let frame = 0; frame < 60; frame++) {
      const start = (frame * 3) % 180;
      finalGuard = new Set(
        Array.from({ length: 60 }, (_, offset) => (start + offset) % 240),
      );
      const schedule = scheduler.select(
        11,
        ready,
        finalGuard,
        frame,
        frame === 59,
      );
      expect(new Set(schedule.indices).size).toBe(schedule.indices.length);
      scheduler.markReady(11, ready, schedule.indices);
    }

    expect(
      [...finalGuard].every((index) => ready[index] === 11),
    ).toBe(true);
  });

  it('spreads a fractional tile budget across the whole cycle', () => {
    const scheduler = new CloudTileScheduler(66);
    const ready = new Int32Array(66);
    ready.fill(-1);
    const guard = new Set(Array.from({ length: 66 }, (_, index) => index));
    const counts: number[] = [];

    for (let frame = 0; frame < 60; frame++) {
      const schedule = scheduler.select(
        12,
        ready,
        guard,
        frame,
        frame === 59,
      );
      counts.push(schedule.steadyCount);
      scheduler.markReady(12, ready, schedule.indices);
    }

    expect(counts.filter((count) => count === 2)).toHaveLength(6);
    expect(counts.filter((count) => count === 1)).toHaveLength(54);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(66);
  });
});
