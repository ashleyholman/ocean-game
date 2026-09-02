import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_FIXTURE_IDS,
  syntheticFixtureCentreRangeM,
  syntheticFixtureCoastSampleCount,
  syntheticFixtureNearestLandFromOffsetM,
  syntheticTileSource,
} from '../src/terrain/syntheticFixtures';
import { assertTerrainTileGeometry } from '../src/terrain/TerrainTile';
import {
  latticeCellGeodetic,
  tileSampleEcef,
} from '../src/terrain/terrainMath';
import { vec3 } from '../src/world/math';

describe('synthetic terrain fixtures (TERR-101)', () => {
  it('exposes the four spec fixtures', () => {
    expect(SYNTHETIC_FIXTURE_IDS).toEqual([
      'low-coast',
      'headland',
      'mountain',
      'peak',
    ]);
  });

  // Walks every sample of every fixture tile; seconds of real work, so the
  // default 5 s budget flakes under machine load.
  it('produces structurally valid tiles with consistent metadata', { timeout: 120_000 }, () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      for (const tile of syntheticTileSource.tilesFor(id)) {
        assertTerrainTileGeometry(tile);
        let min = Infinity;
        let max = -Infinity;
        let land = 0;
        let allFinite = true;
        for (const h of tile.heightsM) {
          if (!Number.isFinite(h)) allFinite = false;
          if (h < min) min = h;
          if (h > max) max = h;
          if (h > 0) land += 1;
        }
        expect(allFinite, tile.key).toBe(true);
        expect(tile.minHeightM, tile.key).toBe(min);
        expect(tile.maxHeightM, tile.key).toBe(max);
        expect(tile.landFraction, tile.key).toBeCloseTo(
          land / tile.heightsM.length,
          12,
        );
        expect(tile.samples).toBe(129);
      }
    }
  });

  it('is bit-identical across repeated generation', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const first = syntheticTileSource.tilesFor(id);
      const second = syntheticTileSource.tilesFor(id);
      expect(second.length).toBe(first.length);
      for (let t = 0; t < first.length; t++) {
        expect(second[t].key).toBe(first[t].key);
        expect(second[t].heightsM).toEqual(first[t].heightsM);
        expect(second[t].anchorEcef).toEqual(first[t].anchorEcef);
      }
    }
  });

  it('shares edge samples exactly between adjacent tiles', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const tiles = syntheticTileSource.tilesFor(id);
      const byOrigin = new Map(
        tiles.map((tile) => [`${tile.cellOriginX}/${tile.cellOriginY}`, tile]),
      );
      const edge = tiles[0].samples - 1;
      let sharedEdges = 0;
      for (const tile of tiles) {
        const eastNeighbour = byOrigin.get(
          `${tile.cellOriginX + edge}/${tile.cellOriginY}`,
        );
        if (eastNeighbour) {
          sharedEdges += 1;
          const a = vec3();
          const b = vec3();
          let identical = true;
          for (let j = 0; j < tile.samples; j++) {
            const hA = tile.heightsM[j * tile.samples + edge];
            const hB = eastNeighbour.heightsM[j * tile.samples];
            // The lattice contract: both tiles compute identical doubles for
            // the shared sample's geodetic position, hence identical ECEF.
            tileSampleEcef(tile, edge, j, a);
            tileSampleEcef(eastNeighbour, 0, j, b);
            if (hA !== hB || a.x !== b.x || a.y !== b.y || a.z !== b.z) {
              identical = false;
            }
          }
          expect(identical, `${tile.key} east edge`).toBe(true);
        }
        const northNeighbour = byOrigin.get(
          `${tile.cellOriginX}/${tile.cellOriginY + edge}`,
        );
        if (northNeighbour) {
          sharedEdges += 1;
          let identical = true;
          for (let i = 0; i < tile.samples; i++) {
            if (northNeighbour.heightsM[i] !== tile.heightsM[edge * tile.samples + i]) {
              identical = false;
            }
          }
          expect(identical, `${tile.key} north edge`).toBe(true);
        }
      }
      const spec = { 'low-coast': 1, headland: 0, mountain: 12, peak: 7 }[id];
      expect(sharedEdges).toBe(spec);
    }
  });

  it('gives every fixture a coastline and an underwater continuation', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const tiles = syntheticTileSource.tilesFor(id);
      const min = Math.min(...tiles.map((t) => t.minHeightM));
      const max = Math.max(...tiles.map((t) => t.maxHeightM));
      const land = tiles.reduce((sum, t) => sum + t.landFraction, 0) / tiles.length;
      // No vertical wall: the sea floor band exists well below zero.
      expect(min).toBeLessThanOrEqual(-50);
      // A coastline exists: some land, mostly sea around it.
      expect(max).toBeGreaterThan(0);
      expect(land).toBeGreaterThan(0.005);
      expect(land).toBeLessThan(0.8);
    }
  });

  /**
   * TERR-130's second half, which the first half hid.
   *
   * "An underwater continuation to −60 m so no fixture has a vertical coastal
   * wall" was checked as `min(height) <= -50`, and every fixture passed —
   * including `low-coast`, whose dune field ran straight off the east side of
   * its own footprint. The sheet ended at 11.6 m above the sea across 354 ring
   * samples: a vertical face down to nothing, with sky behind it, at a place
   * the minimum-height check could never look. The wall and the gap are
   * different failures and this is the one that asks about the gap.
   */
  it('drowns every fixture boundary so no land sheet ends in mid-air', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const tiles = syntheticTileSource.tilesFor(id);
      const cellX = tiles.map((t) => t.cellOriginX);
      const cellY = tiles.map((t) => t.cellOriginY);
      const minX = Math.min(...cellX);
      const maxX = Math.max(...cellX) + (tiles[0].samples - 1);
      const minY = Math.min(...cellY);
      const maxY = Math.max(...cellY) + (tiles[0].samples - 1);

      let ringMaxM = -Infinity;
      let ringSamples = 0;
      for (const tile of tiles) {
        for (let j = 0; j < tile.samples; j++) {
          for (let i = 0; i < tile.samples; i++) {
            const x = tile.cellOriginX + i;
            const y = tile.cellOriginY + j;
            if (x !== minX && x !== maxX && y !== minY && y !== maxY) continue;
            ringSamples++;
            ringMaxM = Math.max(ringMaxM, tile.heightsM[j * tile.samples + i]);
          }
        }
      }
      expect(ringSamples, id).toBeGreaterThan(0);
      // Well under water, not merely at zero: a ring sample at −1 m would show
      // a metre of cliff on a calm day and more in a sea.
      expect(ringMaxM, id).toBeLessThan(-40);
    }
  });

  /**
   * The shelving half, stated as a slope rather than as a minimum height.
   *
   * `headland` is a cliff coast on purpose and reaches 49°, so this is not a
   * gentleness test — it is the "vertical wall" test, and vertical means the
   * lattice cannot resolve the face at all.
   */
  it('shelves into the water rather than walling into it', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const tiles = syntheticTileSource.tilesFor(id);
      const heights = new Map<string, number>();
      for (const tile of tiles) {
        for (let j = 0; j < tile.samples; j++) {
          for (let i = 0; i < tile.samples; i++) {
            heights.set(
              `${tile.cellOriginX + i}/${tile.cellOriginY + j}`,
              tile.heightsM[j * tile.samples + i],
            );
          }
        }
      }
      let worstGradient = 0;
      for (const tile of tiles) {
        for (let j = 0; j < tile.samples; j++) {
          for (let i = 0; i < tile.samples; i++) {
            const x = tile.cellOriginX + i;
            const y = tile.cellOriginY + j;
            const here = heights.get(`${x}/${y}`)!;
            const east = heights.get(`${x + 1}/${y}`);
            const north = heights.get(`${x}/${y + 1}`);
            if (east === undefined || north === undefined) continue;
            if (here > 0 === east > 0 && here > 0 === north > 0) continue;
            worstGradient = Math.max(
              worstGradient,
              Math.abs(east - here) / tile.spacingM,
              Math.abs(north - here) / tile.spacingM,
            );
          }
        }
      }
      // The steepest shipped coast is `headland`'s cliff: 52.6 m of fall
      // across one 31.25 m cell, a gradient of 1.68 or 59°. A genuine wall
      // drops the fixture's whole relief in a single cell — 3.2 for that
      // fixture — so the bound sits between the two rather than at either.
      expect(worstGradient, id).toBeLessThan(2.2);
    }
  });

  /**
   * The coastline set the live nearest-land query runs over is exact.
   *
   * It scans only above-water samples that have a submerged neighbour, which
   * is a claim about geometry: the nearest land sample to a point at sea
   * always has one, because a step toward the vessel from a fully surrounded
   * sample would be land and nearer. Cheap to argue, cheaper to measure —
   * this compares it against the brute-force minimum over EVERY land sample.
   */
  it('answers nearest-land from the coastline as exactly as from every sample', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      const tiles = syntheticTileSource.tilesFor(id);
      const land: number[] = [];
      for (const tile of tiles) {
        for (let j = 0; j < tile.samples; j++) {
          for (let i = 0; i < tile.samples; i++) {
            if (tile.heightsM[j * tile.samples + i] <= 0) continue;
            land.push(
              (tile.cellOriginX + i) * tile.spacingM,
              (tile.cellOriginY + j) * tile.spacingM,
            );
          }
        }
      }
      expect(land.length, id).toBeGreaterThan(0);
      // Fewer points to scan is the whole reason the coast set exists.
      expect(syntheticFixtureCoastSampleCount(id) * 2).toBeLessThan(
        land.length,
      );

      for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += 37) {
        for (const rangeM of [1_500, 7_000, 30_000]) {
          const eastM = rangeM * Math.sin((bearingDeg * Math.PI) / 180);
          const northM = rangeM * Math.cos((bearingDeg * Math.PI) / 180);
          let bruteM = Infinity;
          for (let k = 0; k < land.length; k += 2) {
            bruteM = Math.min(
              bruteM,
              Math.hypot(land[k] - eastM, land[k + 1] - northM),
            );
          }
          const coastM = syntheticFixtureNearestLandFromOffsetM(
            id,
            eastM,
            northM,
          );
          const where = `${id} at ${bearingDeg}° ${rangeM} m`;
          if (coastM === 0) {
            // Standing on land is answered directly rather than through the
            // coast set — the middle of an island is far from every shore, and
            // "distance to land" there is zero. Brute force cannot say that:
            // the nearest LAND SAMPLE is up to a cell diagonal away.
            expect(bruteM, where).toBeLessThanOrEqual(tiles[0].spacingM);
            continue;
          }
          expect(coastM, where).toBeCloseTo(bruteM, 6);
        }
      }
    }
  });

  it('matches the spec peak heights per fixture', () => {
    const max = (id: string) =>
      Math.max(...syntheticTileSource.tilesFor(id).map((t) => t.maxHeightM));
    expect(max('low-coast')).toBeGreaterThan(6);
    expect(max('low-coast')).toBeLessThan(14);
    expect(max('headland')).toBeGreaterThan(85);
    expect(max('headland')).toBeLessThan(115);
    expect(max('mountain')).toBeGreaterThan(480);
    expect(max('mountain')).toBeLessThan(650);
    expect(max('peak')).toBeGreaterThan(2400);
    expect(max('peak')).toBeLessThanOrEqual(3000);
  });

  it('anchors every tile on its own lattice centre at height zero', () => {
    for (const id of SYNTHETIC_FIXTURE_IDS) {
      for (const tile of syntheticTileSource.tilesFor(id)) {
        const half = (tile.samples - 1) / 2;
        const centre = latticeCellGeodetic(
          tile,
          tile.cellOriginX + half,
          tile.cellOriginY + half,
        );
        expect(tile.anchorGeodetic.latitudeRad).toBe(centre.latitudeRad);
        expect(tile.anchorGeodetic.longitudeRad).toBe(centre.longitudeRad);
      }
    }
  });

  it('places the nearest above-water land at the requested range', () => {
    for (const id of ['headland', 'peak']) {
      const tiles = syntheticTileSource.tilesFor(id);
      for (const bearingDeg of [-48, 0, 73]) {
        const bearingRad = (bearingDeg * Math.PI) / 180;
        const eastDirection = Math.sin(bearingRad);
        const northDirection = Math.cos(bearingRad);
        for (const requestedM of [1_000, 40_000, 400_000]) {
          const centreRangeM = syntheticFixtureCentreRangeM(
            id,
            bearingRad,
            requestedM,
          );
          let nearestM = Infinity;
          for (const tile of tiles) {
            for (let j = 0; j < tile.samples; j++) {
              for (let i = 0; i < tile.samples; i++) {
                if (tile.heightsM[j * tile.samples + i] <= 0) continue;
                const eastM = (tile.cellOriginX + i) * tile.spacingM;
                const northM = (tile.cellOriginY + j) * tile.spacingM;
                nearestM = Math.min(
                  nearestM,
                  Math.hypot(
                    centreRangeM * eastDirection + eastM,
                    centreRangeM * northDirection + northM,
                  ),
                );
              }
            }
          }
          expect(nearestM, `${id} at ${bearingDeg}°`).toBeCloseTo(
            requestedM,
            6,
          );
        }
      }
    }
  });
});
