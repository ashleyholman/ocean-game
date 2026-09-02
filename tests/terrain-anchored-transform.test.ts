import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import {
  assertTerrainTileGeometry,
  type TerrainTileGeometry,
} from '../src/terrain/TerrainTile';
import {
  latticeCellGeodetic,
  metresPerRadian,
  tileSampleEcef,
  tileSampleLocalOffset,
} from '../src/terrain/terrainMath';
import { syntheticTileSource } from '../src/terrain/syntheticFixtures';
import { setVec3, vec3 } from '../src/world/math';
import type { CanonicalWorldState } from '../src/world/types';
import {
  createGeographicBasis,
  createSurfaceFrame,
  geodeticToEcef,
  geographicBasisFromGeodetic,
} from '../src/world/wgs84';

const DEG = Math.PI / 180;

/**
 * TERR-102 numerical acceptance, per docs/terrain/terrain-r1-synthetic-spike-spec.md
 * §5: reconstructing a sample through anchoredTileMatrix and its Float32
 * tile-local offset must agree with the direct double-precision
 * geodetic → ECEF → render conversion to better than 1 mm with the vessel
 * within 5 km, and better than 5 cm with the vessel 300 km away — at the
 * equator, at the opening's latitude, across the antimeridian, at 80°S, and
 * under a rotated transported frame.
 */

/** A small synthetic test tile at an arbitrary anchor, varied heights. */
function makeTestTile(latitudeDeg: number, longitudeDeg: number): TerrainTileGeometry {
  const samples = 65;
  const spacingM = 40;
  const originLatRad = latitudeDeg * DEG;
  const originLonRad = longitudeDeg * DEG;
  const { northMPerRad, eastMPerRad } = metresPerRadian(originLatRad);
  const lattice = {
    latticeOriginGeodetic: {
      latitudeRad: originLatRad,
      longitudeRad: originLonRad,
    },
    latticeLatStepRad: spacingM / northMPerRad,
    latticeLonStepRad: spacingM / eastMPerRad,
  };
  const half = (samples - 1) / 2;
  const heightsM = new Float32Array(samples * samples);
  let min = Infinity;
  let max = -Infinity;
  let land = 0;
  for (let j = 0; j < samples; j++) {
    for (let i = 0; i < samples; i++) {
      const h = 150 * (((i * 7 + j * 3) % 11) / 11) - 30;
      heightsM[j * samples + i] = Math.fround(h);
      min = Math.min(min, heightsM[j * samples + i]);
      max = Math.max(max, heightsM[j * samples + i]);
      if (h > 0) land += 1;
    }
  }
  const centre = latticeCellGeodetic(lattice, 0, 0);
  const tile: TerrainTileGeometry = {
    key: `test/${latitudeDeg}/${longitudeDeg}`,
    anchorGeodetic: centre,
    anchorEcef: geodeticToEcef(centre.latitudeRad, centre.longitudeRad, 0, vec3()),
    basisEcef: geographicBasisFromGeodetic(
      centre.latitudeRad,
      centre.longitudeRad,
      createGeographicBasis(),
    ),
    ...lattice,
    cellOriginX: -half,
    cellOriginY: -half,
    spacingM,
    samples,
    heightsM,
    minHeightM: min,
    maxHeightM: max,
    geometricErrorM: 0,
    landFraction: land / heightsM.length,
  };
  assertTerrainTileGeometry(tile);
  return tile;
}

/**
 * A canonical state whose transported frame is the local ENU frame rotated
 * about up by `frameRotationRad` — the transported frame is not required to
 * stay north-aligned, and the transform must not care.
 */
function makeState(
  latitudeDeg: number,
  longitudeDeg: number,
  frameRotationRad = 0,
): CanonicalWorldState {
  const latRad = latitudeDeg * DEG;
  const lonRad = longitudeDeg * DEG;
  const basis = geographicBasisFromGeodetic(
    latRad,
    lonRad,
    createGeographicBasis(),
  );
  const frame = createSurfaceFrame();
  const c = Math.cos(frameRotationRad);
  const s = Math.sin(frameRotationRad);
  // right = east·c + north·s, forward = north·c − east·s (rotation about up).
  setVec3(
    frame.right,
    basis.east.x * c + basis.north.x * s,
    basis.east.y * c + basis.north.y * s,
    basis.east.z * c + basis.north.z * s,
  );
  setVec3(
    frame.forward,
    basis.north.x * c - basis.east.x * s,
    basis.north.y * c - basis.east.y * s,
    basis.north.z * c - basis.east.z * s,
  );
  setVec3(frame.up, basis.up.x, basis.up.y, basis.up.z);
  return {
    worldInstantUtcSeconds: 0,
    worldSecondsPerRealSecond: 0,
    paused: true,
    positionEcefM: geodeticToEcef(latRad, lonRad, 0, vec3()),
    velocityEcefMps: vec3(),
    surfaceFrameEcef: frame,
  };
}

/** Max render-space error across a spread of samples, metres. */
function maximumReconstructionError(
  tile: TerrainTileGeometry,
  state: CanonicalWorldState,
): number {
  const adapter = new WorldRenderAdapter();
  const matrix = adapter.anchoredTileMatrix(state, tile, new THREE.Matrix4());
  const local = vec3();
  const sampleEcef = vec3();
  const reference = new THREE.Vector3();
  const reconstructed = new THREE.Vector3();
  let worst = 0;
  const last = tile.samples - 1;
  const probes = [0, 1, Math.floor(last / 3), Math.floor(last / 2), last - 1, last];
  for (const j of probes) {
    for (const i of probes) {
      tileSampleLocalOffset(tile, i, j, local);
      // The exact path a mesh takes: offsets rounded to Float32 vertices.
      reconstructed
        .set(Math.fround(local.x), Math.fround(local.y), Math.fround(local.z))
        .applyMatrix4(matrix);
      adapter.nearbyEcefPositionToThree(
        state,
        tileSampleEcef(tile, i, j, sampleEcef),
        reference,
      );
      worst = Math.max(worst, reconstructed.distanceTo(reference));
    }
  }
  return worst;
}

/** Offset a geodetic position east by metres (good enough for test states). */
function eastOf(latitudeDeg: number, longitudeDeg: number, metres: number): number {
  const { eastMPerRad } = metresPerRadian(latitudeDeg * DEG);
  return longitudeDeg + (metres / eastMPerRad) / DEG;
}

const SITES: Array<{ name: string; latDeg: number; lonDeg: number }> = [
  { name: 'equator', latDeg: 0, lonDeg: 0 },
  { name: 'opening latitude', latDeg: -33.9, lonDeg: 151.9 },
  { name: 'antimeridian', latDeg: -0.2, lonDeg: 179.9995 },
  { name: 'high latitude', latDeg: -80, lonDeg: 20 },
];

describe('anchored tile transform (TERR-102)', () => {
  it('reconstructs samples to <1 mm with the vessel 5 km away', () => {
    for (const site of SITES) {
      const tile = makeTestTile(site.latDeg, site.lonDeg);
      const state = makeState(site.latDeg, eastOf(site.latDeg, site.lonDeg, 5_000));
      const error = maximumReconstructionError(tile, state);
      expect(error, site.name).toBeLessThan(1e-3);
    }
  });

  it('reconstructs samples to <5 cm with the vessel 300 km away', () => {
    for (const site of SITES) {
      const tile = makeTestTile(site.latDeg, site.lonDeg);
      const state = makeState(site.latDeg, eastOf(site.latDeg, site.lonDeg, 300_000));
      const error = maximumReconstructionError(tile, state);
      expect(error, site.name).toBeLessThan(5e-2);
    }
  });

  it('is indifferent to transported-frame rotation', () => {
    const tile = makeTestTile(-36.5, 136.6);
    for (const rotation of [0.31, 2.39, -1.87]) {
      const state = makeState(-36.5, eastOf(-36.5, 136.6, 20_000), rotation);
      expect(maximumReconstructionError(tile, state)).toBeLessThan(1e-3);
    }
  });

  it('handles the real synthetic fixtures at their own anchors', () => {
    for (const id of ['low-coast', 'peak']) {
      for (const tile of syntheticTileSource.tilesFor(id)) {
        const state = makeState(-36.9, 136.9, 1.1);
        // Fixture anchors are tens of kilometres from this vessel position;
        // the peak's 125 m tiles are the worst Float32 case in the spike.
        expect(maximumReconstructionError(tile, state)).toBeLessThan(5e-3);
      }
    }
  });

  it('moves rendered tiles exactly opposite to vessel travel', () => {
    const tile = makeTestTile(-36.5, 136.6);
    const adapter = new WorldRenderAdapter();
    const stateA = makeState(-36.5, eastOf(-36.5, 136.6, 4_000), 0.7);
    const stateB: CanonicalWorldState = {
      ...stateA,
      positionEcefM: geodeticToEcef(
        -36.5 * DEG,
        eastOf(-36.5, 136.6, 14_000) * DEG,
        0,
        vec3(),
      ),
    };
    const mA = adapter.anchoredTileMatrix(stateA, tile, new THREE.Matrix4());
    const mB = adapter.anchoredTileMatrix(stateB, tile, new THREE.Matrix4());
    const deltaVessel = new THREE.Vector3();
    adapter.nearbyEcefPositionToThree(stateA, stateB.positionEcefM, deltaVessel);
    const point = new THREE.Vector3(500, 60, -700);
    const before = point.clone().applyMatrix4(mA);
    const after = point.clone().applyMatrix4(mB);
    // Same frame, moved vessel: the tile recedes by exactly the travel delta.
    expect(after.clone().sub(before).add(deltaVessel).length()).toBeLessThan(1e-6);
  });
});
