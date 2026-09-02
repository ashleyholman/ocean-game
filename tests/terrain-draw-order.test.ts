import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GPU_DETAIL_PASSES,
  deriveGpuPassTimings,
  GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN,
  GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN,
  type GpuDetailPass,
} from '../src/render/GpuProfiler';
import {
  INTERIOR_RENDER_ORDER,
  SHIP_RENDER_ORDER,
} from '../src/scene/interiorStencil';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import { syntheticTileSource } from '../src/terrain/syntheticFixtures';
import { TerrainSystem } from '../src/terrain/TerrainSystem';
import {
  DEFAULT_TERRAIN_DRAW_ORDER,
  getTerrainDrawOrder,
  OCEAN_RENDER_ORDER,
  parseTerrainDrawOrder,
  resetTerrainDrawOrder,
  setTerrainDrawOrder,
  TERRAIN_RENDER_ORDER_AFTER,
  TERRAIN_RENDER_ORDER_BEFORE,
} from '../src/terrain/terrainDrawOrder';

afterEach(() => resetTerrainDrawOrder());

describe('terrain draw order (TERR-131)', () => {
  it('ships the order the untouched tie already produced', () => {
    // Terrain and the ocean both sat at renderOrder 0, and three broke the tie
    // by projected origin depth — the sea disc is centred on the camera, so it
    // always won. `after` states that outcome instead of inheriting it; the
    // flip has to be asked for.
    expect(DEFAULT_TERRAIN_DRAW_ORDER).toBe('after');
    expect(getTerrainDrawOrder()).toBe('after');
    expect(TERRAIN_RENDER_ORDER_AFTER).toBeGreaterThan(OCEAN_RENDER_ORDER);
  });

  it('never collides with the two slots the interior stencil needs', () => {
    // The hull must write depth before the interior tests against it, or the
    // cabin marks the stencil through the planking. Sharing either number with
    // terrain would make that ordering depend on a depth sort.
    for (const order of [TERRAIN_RENDER_ORDER_BEFORE, TERRAIN_RENDER_ORDER_AFTER]) {
      expect(order).not.toBe(SHIP_RENDER_ORDER);
      expect(order).not.toBe(INTERIOR_RENDER_ORDER);
      expect(order).not.toBe(OCEAN_RENDER_ORDER);
    }
    expect(SHIP_RENDER_ORDER).toBeLessThan(INTERIOR_RENDER_ORDER);
    expect(INTERIOR_RENDER_ORDER).toBeLessThan(TERRAIN_RENDER_ORDER_BEFORE);
    expect(TERRAIN_RENDER_ORDER_BEFORE).toBeLessThan(OCEAN_RENDER_ORDER);
  });

  it('refuses an arm it does not recognise', () => {
    expect(parseTerrainDrawOrder(null)).toBe('after');
    expect(parseTerrainDrawOrder('')).toBe('after');
    expect(parseTerrainDrawOrder('before')).toBe('before');
    expect(() => parseTerrainDrawOrder('first')).toThrow(/terrainOrder/);
  });

  it('moves every resident tile when the live switch flips', () => {
    const scene = new THREE.Scene();
    const system = new TerrainSystem(scene, new WorldRenderAdapter(), {
      skyRadianceLut: new THREE.Texture(),
    });
    system.loadTiles(syntheticTileSource.tilesFor('headland'));
    const orders = () => system.group.children.map((mesh) => mesh.renderOrder);

    expect(orders()).toEqual([TERRAIN_RENDER_ORDER_AFTER]);
    setTerrainDrawOrder('before');
    expect(orders()).toEqual([TERRAIN_RENDER_ORDER_BEFORE]);
    expect(system.stats.drawOrder).toBe('before');
    expect(system.stats.renderOrder).toBe(TERRAIN_RENDER_ORDER_BEFORE);

    // And tiles loaded while the switch is over there arrive in the right place
    // rather than at the boot arm.
    system.loadTiles(syntheticTileSource.tilesFor('headland'));
    expect(orders()).toEqual([TERRAIN_RENDER_ORDER_BEFORE]);

    system.dispose();
    // Disposal must release the subscription, or a discarded system keeps
    // being told about arms it no longer has meshes for.
    setTerrainDrawOrder('after');
    expect(system.stats.tiles).toBe(0);
  });
});

describe('terrain residency counts (TERR-134)', () => {
  it('reports tiles, triangles, vertices and resident bytes', () => {
    const scene = new THREE.Scene();
    const system = new TerrainSystem(scene, new WorldRenderAdapter(), {
      skyRadianceLut: new THREE.Texture(),
    });
    const tiles = syntheticTileSource.tilesFor('mountain');
    system.loadTiles(tiles);

    const samples = tiles[0].samples;
    const cells = samples - 1;
    const stats = system.stats;
    expect(stats.tiles).toBe(9);
    expect(stats.triangles).toBe(9 * cells * cells * 2);
    expect(stats.vertices).toBe(9 * samples * samples);
    // Position, normal and colour at 3 floats each, plus 3 Uint32 indices per
    // triangle. A budget line has to be derived from what is uploaded, not
    // from a nominal tile size.
    expect(stats.geometryBytes).toBe(
      9 * (samples * samples * 3 * 3 * 4 + cells * cells * 6 * 4),
    );

    system.dispose();
    expect(system.stats.geometryBytes).toBe(0);
  });
});

describe('GPU bucket rotations (TERR-134)', () => {
  const prefix = {
    frame: 20,
    foamSimulation: 0.5,
    cloudCacheBake: 9.5,
    skyAndCloudDraw: 10.3,
    sceneOpaque: 11.1,
    terrain: 11.6,
    ocean: 18,
    stars: 18.4,
  };

  it('keeps the pre-terrain rotation exactly as it was', () => {
    // Every harness that constructs a profiler without an opinion still gets
    // the five buckets it always got, with the vessel inside `ocean`.
    expect(DEFAULT_GPU_DETAIL_PASSES).toEqual([
      'foamSimulation',
      'cloudCacheBake',
      'skyAndCloudDraw',
      'ocean',
      'stars',
    ]);
    const timing = deriveGpuPassTimings(prefix);
    expect(timing.ocean).toBeCloseTo(7.7);
    expect(timing.sceneAndStars).toBeCloseTo(0.4);
    expect(timing.terrain).toBeUndefined();
    expect(timing.sceneOpaque).toBeUndefined();
  });

  it('splits the vessel and the land out of the ocean bucket', () => {
    const timing = deriveGpuPassTimings(
      prefix,
      GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN,
    );
    expect(timing.skyAndCloudDraw).toBeCloseTo(0.8);
    expect(timing.sceneOpaque).toBeCloseTo(0.8);
    expect(timing.terrain).toBeCloseTo(0.5);
    expect(timing.ocean).toBeCloseTo(6.4);
    expect(timing.sceneAndStars).toBeCloseTo(0.4);
    // The split is a partition, not an extra: the same total, differently
    // attributed.
    expect(
      (timing.sceneOpaque ?? 0) + (timing.terrain ?? 0) + timing.ocean,
    ).toBeCloseTo(7.7);
  });

  it('reads the same names in the other arm, with the endpoints swapped', () => {
    const afterPrefix = { ...prefix, terrain: 18.2, ocean: 17.9 };
    const timing = deriveGpuPassTimings(
      afterPrefix,
      GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN,
    );
    expect(timing.sceneOpaque).toBeCloseTo(0.8);
    expect(timing.ocean).toBeCloseTo(6.8);
    expect(timing.terrain).toBeCloseTo(0.3);
    expect(timing.sceneAndStars).toBeCloseTo(0.2);
  });

  it('orders both rotations the way the frame is actually submitted', () => {
    // A prefix list out of submission order does not read wrong, it reads
    // NEGATIVE, and the smoother then hides it. So the relation is pinned.
    const indexIn = (passes: readonly GpuDetailPass[], pass: GpuDetailPass) =>
      passes.indexOf(pass);
    expect(
      indexIn(GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN, 'terrain'),
    ).toBeLessThan(indexIn(GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN, 'ocean'));
    expect(
      indexIn(GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN, 'terrain'),
    ).toBeGreaterThan(indexIn(GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN, 'ocean'));
    for (const passes of [
      GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN,
      GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN,
    ]) {
      expect(indexIn(passes, 'sceneOpaque')).toBeLessThan(
        indexIn(passes, 'terrain'),
      );
      expect(passes[passes.length - 1]).toBe('stars');
      // Eight frames a rotation now, up from six. Anything quoting a rotation
      // length must read it from the profiler.
      expect(passes.length + 1).toBe(8);
    }
  });

  it('reads about zero terrain when no terrain is mounted', () => {
    // `?terrain=off`. The sea closes both boundaries at the same instant, so
    // the bucket is empty and — the part that matters — the rotation still
    // completes instead of stalling every other bucket with it.
    const empty = { ...prefix, sceneOpaque: 11.1, terrain: 11.1 };
    const timing = deriveGpuPassTimings(
      empty,
      GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN,
    );
    expect(timing.terrain).toBe(0);
    expect(timing.ocean).toBeCloseTo(6.9);
  });
});
