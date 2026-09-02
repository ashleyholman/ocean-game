import type * as THREE from 'three';
import type { GpuPassProfiler } from '../render/GpuProfiler';
import type { WorldRenderAdapter } from '../scene/WorldRenderAdapter';
import type { CanonicalWorldState } from '../world/types';
import { ecefToGeodetic } from '../world/wgs84';
import {
  globalTerrainSource,
  type GlobalTerrainSource,
} from './GlobalTerrainSource';
import { TerrainSystem } from './TerrainSystem';

export interface GlobalTerrainMountDeps {
  scene: THREE.Scene;
  adapter: WorldRenderAdapter;
  state: Readonly<CanonicalWorldState>;
  skyRadianceLut: THREE.Texture;
  profiler?: GpuPassProfiler;
  /** Test seam and future build selector; production uses the shared source. */
  source?: GlobalTerrainSource;
}

export interface GlobalTerrainHandle {
  readonly system: TerrainSystem;
  readonly source: GlobalTerrainSource;
  /** Live distance derived from the last canonical state passed to update. */
  getNearestLandM(): number;
  update(state: Readonly<CanonicalWorldState>): void;
  dispose(): void;
}

/**
 * Mount the whole-world coarse fallback behind `TerrainSystem`.
 *
 * `TerrainSystem.update` derives its provider key directly from canonical ECEF
 * position. Consequently a WorldPanel teleport and ordinary voyage movement
 * use the exact same refresh path; this handle owns no duplicate geodetic
 * state and performs no location polling of its own.
 */
export function mountGlobalTerrain(
  deps: GlobalTerrainMountDeps,
): GlobalTerrainHandle {
  const source = deps.source ?? globalTerrainSource;
  const system = new TerrainSystem(deps.scene, deps.adapter, {
    skyRadianceLut: deps.skyRadianceLut,
    profiler: deps.profiler,
    tileProvider: source,
  });
  system.group.name = 'terrain-global-coarse';

  const geodeticScratch = {
    latitudeRad: 0,
    longitudeRad: 0,
    heightM: 0,
  };
  let latestPositionX: number | undefined;
  let latestPositionY: number | undefined;
  let latestPositionZ: number | undefined;
  let nearestLandM = 0;
  const refreshNearestLand = (state: Readonly<CanonicalWorldState>): void => {
    const { x, y, z } = state.positionEcefM;
    if (
      Object.is(x, latestPositionX) &&
      Object.is(y, latestPositionY) &&
      Object.is(z, latestPositionZ)
    ) {
      return;
    }
    const location = ecefToGeodetic(state.positionEcefM, geodeticScratch);
    const nextNearestLandM = source.nearestLandM(
      location.latitudeRad,
      location.longitudeRad,
    );
    if (!Number.isFinite(nextNearestLandM) || nextNearestLandM < 0) {
      throw new Error(
        '[terrain] global nearest-land query must be non-negative and finite',
      );
    }
    nearestLandM = nextNearestLandM;
    latestPositionX = x;
    latestPositionY = y;
    latestPositionZ = z;
  };
  const update = (state: Readonly<CanonicalWorldState>): void => {
    system.update(state);
    refreshNearestLand(state);
  };
  update(deps.state);

  console.info(
    `[terrain] global coarse build '${source.sourceBuildId}'` +
      ` · ${system.stats.tiles} resident tiles` +
      ` · ${system.stats.triangles.toLocaleString()} triangles` +
      ' · Natural Earth cartographic preview; GLO-30/WBM not ingested',
  );

  return {
    system,
    source,
    getNearestLandM: () => nearestLandM,
    update,
    dispose: () => system.dispose(),
  };
}
