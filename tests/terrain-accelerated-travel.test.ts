import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WorldRenderAdapter } from '../src/scene/WorldRenderAdapter';
import { syntheticTileSource } from '../src/terrain/syntheticFixtures';
import type { TerrainTileGeometry } from '../src/terrain/TerrainTile';
import {
  metresPerRadian,
  tileSampleEcef,
  tileSampleLocalOffset,
} from '../src/terrain/terrainMath';
import { vec3 } from '../src/world/math';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import type { CanonicalWorldState } from '../src/world/types';
import { ecefToGeodetic } from '../src/world/wgs84';

/**
 * TERR-104: accelerated vessel travel past and across synthetic tile
 * boundaries.
 *
 * WHAT THIS IS ACTUALLY ASKING
 * ----------------------------
 * TERR-102 proved the anchored transform is accurate at a standstill: park the
 * vessel 5 km or 300 km away and the reconstructed samples land where the
 * double-precision path says they should. That is a claim about ONE state.
 * Terrain stability under way is a claim about a SEQUENCE of them, and it can
 * fail in ways a static check cannot see:
 *
 *  * a seam can open and close as two tiles' anchors move through different
 *    parts of the Float32 grid;
 *  * a step can appear in the motion — accurate before, accurate after, and
 *    visibly discontinuous across the frame that crossed the boundary;
 *  * terrain can turn out to be coupled to the LOCAL wave frame, whose origin
 *    advances by observer velocity and whose phase is re-locked every time the
 *    field changes, rather than to the canonical geodesic position.
 *
 * So this drives the real `PlanetaryWorld` geodesic integrator at the voyage
 * clock's top compression (30×, ~90 m/s over the ground at a working 6 kn) on
 * a track that crosses the `mountain` fixture's internal tile boundaries, and
 * measures all three per frame rather than at the endpoints.
 *
 * WHAT THE NUMBERS CAME OUT AT
 * ----------------------------
 * Over a 16 km passage at 30x — 10,670 frames, 1,068 seam checks, four tile
 * boundaries crossed:
 *
 *   worst shared-edge seam            1.25e-4 m
 *   worst reconstruction error        5.46e-5 m
 *   worst frame-to-frame jerk         3.57e-7 m
 *     of which, within 50 m of a
 *     tile boundary                   3.56e-7 m   (i.e. no different)
 *   30 s at 1x against 1 s at 30x     1.29e-6 m apart
 *   120 frames against 1,200 substeps 8.38e-7 m apart
 *
 * The bounds below sit orders of magnitude above those, so this fails on a
 * regression rather than on a rounding mode. The near-boundary jerk is checked
 * against the away-from-boundary jerk rather than against a constant, because
 * the claim being made is comparative: crossing a boundary is not an event.
 */

const DEG = Math.PI / 180;

/** Kangaroo Island test water, at the `mountain` fixture's own anchor. */
const FIXTURE_ID = 'mountain';
const FIXTURE_LAT_DEG = -36.8;
const FIXTURE_LON_DEG = 137.0;

/**
 * The mountain's lattice is 3 × 3 tiles of 128 cells at 31.25 m, so its
 * internal tile boundaries stand at ±2 km from the centre and its footprint
 * ends at ±6 km. A track 5.5 km north of centre crosses every column boundary
 * while staying over water: land stops at the 4.5 km cone radius.
 */
const TRACK_NORTH_M = 5_500;
const TRACK_START_EAST_M = -8_000;
const TRACK_LENGTH_M = 16_000;

const VOYAGE_RATE = 30;
const SPEED_MPS = 3.0;
const FRAME_SECONDS = 1 / 60;

function makeWorld(
  eastOfFixtureStartM: number,
  northOfFixtureM: number,
  voyageSecondsPerRealSecond: number,
): PlanetaryWorld {
  const { northMPerRad, eastMPerRad } = metresPerRadian(FIXTURE_LAT_DEG * DEG);
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 16) / 1000,
    latitudeRad: FIXTURE_LAT_DEG * DEG + northOfFixtureM / northMPerRad,
    longitudeRad: FIXTURE_LON_DEG * DEG + eastOfFixtureStartM / eastMPerRad,
    initialCourseRad: 90 * DEG,
    initialSpeedMps: SPEED_MPS,
    worldSecondsPerRealSecond: 1,
    voyageSecondsPerRealSecond,
  });
}

/**
 * One frame of steady progress due east.
 *
 * Along the transported frame's RIGHT axis, not its forward one:
 * `initialCourseRad` aims the velocity vector, while `initialiseSurfaceFrame`
 * always starts the frame north-aligned, and it is the frame the displacement
 * is expressed in. Driving "forward" here would sail north up the meridian and
 * never reach a tile boundary — which is how this was first written, and the
 * loop simply never ended.
 */
function stepAhead(world: PlanetaryWorld, seconds: number): void {
  world.advanceTangentMotionStep(
    seconds,
    SPEED_MPS * seconds,
    0,
    SPEED_MPS,
    0,
  );
}

/** Vessel offset east of the fixture centre, metres. */
function eastOfFixtureM(state: Readonly<CanonicalWorldState>): number {
  const vessel = ecefToGeodetic(state.positionEcefM, {
    latitudeRad: 0,
    longitudeRad: 0,
    heightM: 0,
  });
  const { eastMPerRad } = metresPerRadian(vessel.latitudeRad);
  return (vessel.longitudeRad - FIXTURE_LON_DEG * DEG) * eastMPerRad;
}

interface TileEdgeProbe {
  a: { tile: TerrainTileGeometry; i: number; j: number };
  b: { tile: TerrainTileGeometry; i: number; j: number };
}

/**
 * Sample pairs that two tiles both own: the same fixture-wide lattice cell,
 * addressed through each tile's own origin. If the two matrices ever disagree,
 * the shared edge cracks on screen.
 */
function sharedEdgeProbes(
  tiles: TerrainTileGeometry[],
  stride: number,
): TileEdgeProbe[] {
  const probes: TileEdgeProbe[] = [];
  const cellOf = (tile: TerrainTileGeometry, i: number, j: number) =>
    `${tile.cellOriginX + i}/${tile.cellOriginY + j}`;
  for (let a = 0; a < tiles.length; a++) {
    for (let b = a + 1; b < tiles.length; b++) {
      const owned = new Map<string, { i: number; j: number }>();
      const last = tiles[b].samples - 1;
      for (const j of [0, last]) {
        for (let i = 0; i <= last; i += stride) {
          owned.set(cellOf(tiles[b], i, j), { i, j });
        }
      }
      for (const i of [0, last]) {
        for (let j = 0; j <= last; j += stride) {
          owned.set(cellOf(tiles[b], i, j), { i, j });
        }
      }
      const lastA = tiles[a].samples - 1;
      for (const j of [0, lastA]) {
        for (let i = 0; i <= lastA; i += stride) {
          const match = owned.get(cellOf(tiles[a], i, j));
          if (match) {
            probes.push({
              a: { tile: tiles[a], i, j },
              b: { tile: tiles[b], ...match },
            });
          }
        }
      }
      for (const i of [0, lastA]) {
        for (let j = 0; j <= lastA; j += stride) {
          const match = owned.get(cellOf(tiles[a], i, j));
          if (match) {
            probes.push({
              a: { tile: tiles[a], i, j },
              b: { tile: tiles[b], ...match },
            });
          }
        }
      }
    }
  }
  return probes;
}

/** The exact path a vertex takes: Float32 local offset through the matrix. */
function renderPosition(
  adapter: WorldRenderAdapter,
  state: Readonly<CanonicalWorldState>,
  tile: TerrainTileGeometry,
  i: number,
  j: number,
  out: THREE.Vector3,
  matrix = new THREE.Matrix4(),
): THREE.Vector3 {
  const local = tileSampleLocalOffset(tile, i, j, vec3());
  adapter.anchoredTileMatrix(state, tile, matrix);
  return out
    .set(Math.fround(local.x), Math.fround(local.y), Math.fround(local.z))
    .applyMatrix4(matrix);
}

describe('terrain under accelerated travel (TERR-104)', () => {
  const adapter = new WorldRenderAdapter();
  const tiles = syntheticTileSource.tilesFor(FIXTURE_ID);

  it('mounts a fixture whose tile boundaries the track actually crosses', () => {
    // The premise, checked rather than assumed: three tile columns, boundaries
    // at ±2 km, and a 16 km track that passes all of them.
    expect(tiles.length).toBe(9);
    const boundaries = [...new Set(tiles.map((t) => t.cellOriginX))].sort(
      (a, b) => a - b,
    );
    expect(boundaries.map((c) => c * tiles[0].spacingM)).toEqual([
      -6000, -2000, 2000,
    ]);
    expect(TRACK_START_EAST_M).toBeLessThan(-6000);
    expect(TRACK_START_EAST_M + TRACK_LENGTH_M).toBeGreaterThan(6000);
  });

  it('keeps shared tile edges closed the whole way past the fixture', () => {
    const world = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    const probes = sharedEdgeProbes(tiles, 16);
    expect(probes.length).toBeGreaterThan(40);

    const pointA = new THREE.Vector3();
    const pointB = new THREE.Vector3();
    const matrixA = new THREE.Matrix4();
    const matrixB = new THREE.Matrix4();
    let worstSeamM = 0;
    let checks = 0;

    const endEastM = TRACK_START_EAST_M + TRACK_LENGTH_M;
    while (eastOfFixtureM(world.state) < endEastM) {
      for (let frame = 0; frame < 10; frame++) stepAhead(world, FRAME_SECONDS);
      checks++;
      // A cap rather than trust: a track that stops making ground turns a
      // measurement into a hang, and that is a slow way to learn about it.
      expect(checks).toBeLessThan(5_000);
      for (const probe of probes) {
        renderPosition(
          adapter,
          world.state,
          probe.a.tile,
          probe.a.i,
          probe.a.j,
          pointA,
          matrixA,
        );
        renderPosition(
          adapter,
          world.state,
          probe.b.tile,
          probe.b.i,
          probe.b.j,
          pointB,
          matrixB,
        );
        worstSeamM = Math.max(worstSeamM, pointA.distanceTo(pointB));
      }
    }

    expect(checks).toBeGreaterThan(100);
    // Measured worst ≈ 0.1 mm. A crack a millimetre wide is still invisible;
    // a regression that breaks the shared-lattice contract is metres.
    expect(worstSeamM).toBeLessThan(2e-3);
  });

  it('moves terrain smoothly through every tile boundary it crosses', () => {
    const world = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    // A sample on the middle tile's western edge — the boundary the track
    // crosses first, and the vertex most exposed to the anchor changing hands.
    const middle = tiles.find(
      (tile) => tile.cellOriginX === -64 && tile.cellOriginY === -64,
    );
    expect(middle).toBeDefined();
    const probeTile = middle!;
    const probeI = 0;
    const probeJ = probeTile.samples - 1;

    const previous = new THREE.Vector3();
    const current = new THREE.Vector3();
    const next = new THREE.Vector3();
    const reference = new THREE.Vector3();
    const sampleEcef = vec3();

    let worstReconstructionM = 0;
    let worstJerkM = 0;
    let worstJerkNearBoundaryM = 0;
    let worstJerkAwayFromBoundaryM = 0;
    let boundaryFrames = 0;

    const sampleHere = (out: THREE.Vector3) =>
      renderPosition(adapter, world.state, probeTile, probeI, probeJ, out);

    sampleHere(previous);
    stepAhead(world, FRAME_SECONDS);
    sampleHere(current);

    const endEastM = TRACK_START_EAST_M + TRACK_LENGTH_M;
    let frames = 0;
    while (eastOfFixtureM(world.state) < endEastM) {
      expect((frames += 1)).toBeLessThan(50_000);
      stepAhead(world, FRAME_SECONDS);
      sampleHere(next);

      adapter.nearbyEcefPositionToThree(
        world.state,
        tileSampleEcef(probeTile, probeI, probeJ, sampleEcef),
        reference,
      );
      worstReconstructionM = Math.max(
        worstReconstructionM,
        next.distanceTo(reference),
      );

      // Second difference: the frame-to-frame CHANGE in displacement. Uniform
      // travel over a sphere makes this essentially zero, so whatever is left
      // is the arithmetic — and a step at a tile boundary would show up here
      // and nowhere else.
      const jerkM = next
        .clone()
        .sub(current)
        .sub(current.clone().sub(previous))
        .length();
      worstJerkM = Math.max(worstJerkM, jerkM);

      const east = eastOfFixtureM(world.state);
      const nearBoundary = [-6000, -2000, 2000, 6000].some(
        (edge) => Math.abs(east - edge) < 50,
      );
      if (nearBoundary) {
        boundaryFrames++;
        worstJerkNearBoundaryM = Math.max(worstJerkNearBoundaryM, jerkM);
      } else {
        worstJerkAwayFromBoundaryM = Math.max(
          worstJerkAwayFromBoundaryM,
          jerkM,
        );
      }

      previous.copy(current);
      current.copy(next);
    }

    expect(boundaryFrames).toBeGreaterThan(50);
    // Static acceptance (spec §5) is 1 mm within 5 km; travel must not spend
    // more than that budget on top of it.
    expect(worstReconstructionM).toBeLessThan(1e-3);
    expect(worstJerkM).toBeLessThan(1e-3);
    // The point of the whole exercise: crossing a boundary is not an event.
    expect(worstJerkNearBoundaryM).toBeLessThanOrEqual(
      Math.max(worstJerkAwayFromBoundaryM, 1e-9) * 2,
    );
  });

  it('buys distance with the voyage rate, not a different track', () => {
    // 30 seconds at honest 1x against 1 second at 30x. Accelerated travel must
    // be the same passage covered sooner — if compression changed the ground
    // track, every capture taken at 30x would be of a different world.
    const slow = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, 1);
    const fast = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    for (let step = 0; step < 900; step++) stepAhead(slow, 1 / 30);
    for (let step = 0; step < 30; step++) stepAhead(fast, 1 / 30);

    const separationM = Math.hypot(
      slow.state.positionEcefM.x - fast.state.positionEcefM.x,
      slow.state.positionEcefM.y - fast.state.positionEcefM.y,
      slow.state.positionEcefM.z - fast.state.positionEcefM.z,
    );
    // 90 m of travel, reached in 900 steps or in 30. Measured 1.29e-6 m.
    expect(separationM).toBeLessThan(1e-4);
  });

  it('renders the same terrain however the frame time was chopped up', () => {
    // The proxy for "independent of local wave phase": the wave field re-locks
    // its phase on every parameter change and integrates its origin per
    // substep, so a differently chopped frame is exactly the case where a
    // coupling between the two would show. Terrain must not notice.
    const coarse = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    const fine = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    for (let step = 0; step < 120; step++) stepAhead(coarse, 1 / 60);
    for (let step = 0; step < 1200; step++) stepAhead(fine, 1 / 600);

    const point = new THREE.Vector3();
    const other = new THREE.Vector3();
    let worstM = 0;
    for (const tile of tiles) {
      const last = tile.samples - 1;
      for (const j of [0, last]) {
        for (const i of [0, last]) {
          renderPosition(adapter, coarse.state, tile, i, j, point);
          renderPosition(adapter, fine.state, tile, i, j, other);
          worstM = Math.max(worstM, point.distanceTo(other));
        }
      }
    }
    expect(worstM).toBeLessThan(1e-3);
  });

  it('ignores every clock and velocity input the wave field rides on', () => {
    // Structural, and cheap to keep: the anchored matrix is a pure function of
    // position and transported frame. Time, rate, pause and velocity are what
    // move the water; if any of them ever reached this matrix, land would
    // shimmer with the sea.
    const world = makeWorld(TRACK_START_EAST_M, TRACK_NORTH_M, VOYAGE_RATE);
    for (let step = 0; step < 300; step++) stepAhead(world, FRAME_SECONDS);

    const base = world.state;
    const disturbed: CanonicalWorldState = {
      ...base,
      worldInstantUtcSeconds: base.worldInstantUtcSeconds + 86_400,
      worldSecondsPerRealSecond: 30,
      paused: !base.paused,
      velocityEcefMps: vec3(11, -7, 3),
    };

    for (const tile of tiles) {
      const a = adapter.anchoredTileMatrix(base, tile, new THREE.Matrix4());
      const b = adapter.anchoredTileMatrix(disturbed, tile, new THREE.Matrix4());
      expect(b.elements).toEqual(a.elements);
    }
  });
});
