import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import { globalTerrainSource } from '../src/terrain/GlobalTerrainSource';
import { mountGlobalTerrain } from '../src/terrain/globalTerrainRuntime';
import { TerrainSystem } from '../src/terrain/TerrainSystem';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import {
  governedVoyageRate,
  VOYAGE_RATE_RANGE,
} from '../src/world/voyageClock';

const DEG = Math.PI / 180;

afterEach(() => vi.restoreAllMocks());

describe('TerrainSystem global provider coupling', () => {
  it('refreshes from canonical position on teleport and not on an unchanged frame', () => {
    const world = makeWorld(0, -140);
    const scene = new THREE.Scene();
    const system = new TerrainSystem(scene, new WorldRenderAdapter(), {
      skyRadianceLut: new THREE.Texture(),
      tileProvider: globalTerrainSource,
    });

    expect(system.stats.residentLocationKey).toBeNull();
    system.update(world.state);
    const pacificKey = globalTerrainSource.locationKey(0, -140 * DEG);
    expect(system.stats).toMatchObject({
      sourceBuildId: globalTerrainSource.sourceBuildId,
      residentLocationKey: pacificKey,
      tiles: 9,
    });
    const firstChildren = [...system.group.children];
    const expectedPacificNames = globalTerrainSource
      .tilesAt(0, -140 * DEG)
      .map((tile) => tile.key);
    expect(system.group.children.map((child) => child.name)).toEqual(
      expectedPacificNames,
    );

    system.update(world.state);
    expect(system.group.children).toEqual(firstChildren);

    world.teleportGeodeticRadians(27.9805 * DEG, 86.8806 * DEG);
    system.update(world.state);
    const everestKey = globalTerrainSource.locationKey(
      27.9805 * DEG,
      86.8806 * DEG,
    );
    expect(system.stats.residentLocationKey).toBe(everestKey);
    expect(everestKey).not.toBe(pacificKey);
    expect(system.group.children[0]).not.toBe(firstChildren[0]);
    expect(system.group.children.map((child) => child.name)).toEqual(
      globalTerrainSource
        .tilesAt(27.9805 * DEG, 86.8806 * DEG)
        .map((tile) => tile.key),
    );
    expect(
      globalTerrainSource
        .tilesAt(27.9805 * DEG, 86.8806 * DEG)
        .some((tile) => tile.landFraction > 0),
    ).toBe(true);

    system.dispose();
    expect(scene.children).not.toContain(system.group);
  });

  it('feeds live offshore and near-land distances to governed voyage mode', () => {
    const world = makeWorld(0, -140);
    const scene = new THREE.Scene();
    const nearestLandSpy = vi.spyOn(globalTerrainSource, 'nearestLandM');
    const handle = mountGlobalTerrain({
      scene,
      adapter: new WorldRenderAdapter(),
      state: world.state,
      skyRadianceLut: new THREE.Texture(),
    });
    expect(nearestLandSpy).toHaveBeenCalledTimes(1);
    handle.update(world.state);
    expect(nearestLandSpy).toHaveBeenCalledTimes(1);
    const offshoreM = handle.getNearestLandM();
    expect(offshoreM).toBeGreaterThan(2_600_000);
    expect(governedVoyageRate(offshoreM, 3, 0.2)).toBe(
      VOYAGE_RATE_RANGE.max,
    );

    world.teleportGeodeticRadians(-33.87 * DEG, 151.32 * DEG);
    handle.update(world.state);
    expect(nearestLandSpy).toHaveBeenCalledTimes(2);
    expect(globalTerrainSource.sample(-33.87 * DEG, 151.32 * DEG).surface).toBe(
      'ocean',
    );
    const nearCoastM = handle.getNearestLandM();
    expect(nearCoastM).toBeGreaterThan(500);
    expect(nearCoastM).toBeLessThan(1_500);
    expect(
      governedVoyageRate(nearCoastM, 3, 0.2),
    ).toBeLessThan(VOYAGE_RATE_RANGE.max);

    world.teleportGeodeticRadians(-33.8688 * DEG, 151.2093 * DEG);
    handle.update(world.state);
    expect(nearestLandSpy).toHaveBeenCalledTimes(3);
    expect(handle.getNearestLandM()).toBe(0);
    expect(governedVoyageRate(handle.getNearestLandM(), 3, 0.2)).toBe(
      VOYAGE_RATE_RANGE.min,
    );
    handle.dispose();
  });
});

function makeWorld(latitudeDeg: number, longitudeDeg: number): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 17) / 1000,
    latitudeRad: latitudeDeg * DEG,
    longitudeRad: longitudeDeg * DEG,
    initialCourseRad: 0,
    initialSpeedMps: 0,
  });
}
