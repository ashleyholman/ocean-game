import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_TERRAIN_COAST_SEGMENT_COUNT,
  globalTerrainSource,
  type GlobalTerrainSource,
} from '../src/terrain/GlobalTerrainSource';
import { assertTerrainTileGeometry } from '../src/terrain/TerrainTile';

const DEG = Math.PI / 180;

describe('coarse global terrain manifest and samples', () => {
  it('pins the derived Natural Earth input without claiming canonical DEM ingestion', () => {
    const { manifest } = globalTerrainSource;
    expect(manifest.buildId).toBe('drift-global-coarse-ne110m-v1');
    expect(manifest.canonical).toBe(false);
    expect(manifest.sources.land.product).toBe('Natural Earth 1:110m Land');
    expect(manifest.sources.land.release).toBe('4.1.0');
    expect(manifest.sources.reliefSeeds.release).toBe('5.0.0');
    expect(manifest.canonicalUpgrade.elevation.status).toBe('not_acquired');
    expect(manifest.canonicalUpgrade.water.status).toBe('not_acquired');
    expect(manifest.canonicalUpgrade.ingestionPipelineStatus).toBe(
      'not_started',
    );
    expect(manifest.runtimeRoles).toContain(
      'voyage_governor_presentation_distance',
    );
    expect(manifest.runtimeRoles).toContain(
      'water_aware_global_opening_bootstrap',
    );
    expect(manifest.runtimeRoles).toContain(
      'water_aware_world_panel_teleport',
    );
    expect(manifest.coastDistanceProfile).toMatchObject({
      algorithm: 'natural-earth-minor-great-circle-segment-v1',
      segmentCount: 5_004,
      purpose:
        'voyage presentation governor and bounded coarse water qualification; not navigation, collision, grounding, or safety',
    });

    expect(manifest.derivedAsset.sha256).toBe(
      '845c4976e601643dd57e308bbd7f9b39752de2739107e5d3ab84784535654616',
    );
    const assetBytes = readFileSync(
      'src/terrain/data/natural-earth-110m-coarse.json',
      'utf8',
    );
    expect(createHash('sha256').update(assetBytes).digest('hex')).toBe(
      manifest.derivedAsset.sha256,
    );
  });

  it.each([
    ['Sydney', -33.87, 151.21, 'land'],
    ['Everest', 27.98, 86.88, 'land'],
    ['London', 51.51, -0.13, 'land'],
    ['central Pacific', 0, -140, 'ocean'],
    ['South Atlantic', -25, -15, 'ocean'],
  ] as const)(
    'classifies the recognisable %s control as %s',
    (_name, latitudeDeg, longitudeDeg, surface) => {
      expect(
        globalTerrainSource.sample(latitudeDeg * DEG, longitudeDeg * DEG)
          .surface,
      ).toBe(surface);
    },
  );

  it('turns sparse traceable extrema into deterministic broad relief', () => {
    const everest = globalTerrainSource.sample(27.9805 * DEG, 86.8806 * DEG);
    const lowAustralia = globalTerrainSource.sample(-30 * DEG, 125 * DEG);
    expect(everest.surface).toBe('land');
    expect(everest.heightM).toBeGreaterThan(5_000);
    expect(everest.relief01).toBeGreaterThan(0.9);
    expect(lowAustralia.surface).toBe('land');
    expect(lowAustralia.heightM).toBe(35);
    expect(lowAustralia.relief01).toBeLessThan(0.02);
    expect(
      globalTerrainSource.sample(27.9805 * DEG, 86.8806 * DEG),
    ).toEqual(everest);
  });
});

describe('coarse global coordinate policy', () => {
  it('normalises wrapped longitude and chooses one longitude gauge at poles', () => {
    const base = globalTerrainSource.sample(-75 * DEG, 179.75 * DEG);
    const wrapped = globalTerrainSource.sample(
      -75 * DEG,
      (179.75 + 720) * DEG,
    );
    expect(wrapped.longitudeRad).toBeCloseTo(base.longitudeRad, 14);
    expect({ ...wrapped, longitudeRad: base.longitudeRad }).toEqual(base);

    expect(
      globalTerrainSource.locationKey(Math.PI / 2, -170 * DEG),
    ).toBe(globalTerrainSource.locationKey(Math.PI / 2, 70 * DEG));
    expect(
      globalTerrainSource.sample(-Math.PI / 2, -Math.PI),
    ).toEqual(globalTerrainSource.sample(-Math.PI / 2, Math.PI));
  });

  it('rejects invalid latitude and non-finite coordinates', () => {
    expect(() => globalTerrainSource.sample(Math.PI, 0)).toThrow(
      /latitudeRad/,
    );
    expect(() => globalTerrainSource.sample(Number.NaN, 0)).toThrow(/finite/);
    expect(() => globalTerrainSource.tilesAt(0, Number.POSITIVE_INFINITY)).toThrow(
      /finite/,
    );
  });
});

describe('coarse global nearest-land query', () => {
  it('uses one fixed bounded scan over the pinned Natural Earth coast', () => {
    expect(GLOBAL_TERRAIN_COAST_SEGMENT_COUNT).toBe(5_004);
    expect(GLOBAL_TERRAIN_COAST_SEGMENT_COUNT).toBeLessThanOrEqual(5_100);

    const centralPacificM = globalTerrainSource.nearestLandM(0, -140 * DEG);
    expect(centralPacificM).toBeGreaterThan(2_600_000);
    expect(centralPacificM).toBeLessThan(2_800_000);
    expect(globalTerrainSource.nearestLandM(0, -140 * DEG)).toBe(
      centralPacificM,
    );
  });

  it('returns zero on land and a small positive distance just offshore', () => {
    expect(globalTerrainSource.nearestLandM(-33.8688 * DEG, 151.2093 * DEG)).toBe(
      0,
    );

    const offshoreLatitudeRad = -33.87 * DEG;
    const offshoreLongitudeRad = 151.32 * DEG;
    expect(
      globalTerrainSource.sample(offshoreLatitudeRad, offshoreLongitudeRad).surface,
    ).toBe('ocean');
    const offshoreDistanceM = globalTerrainSource.nearestLandM(
      offshoreLatitudeRad,
      offshoreLongitudeRad,
    );
    expect(offshoreDistanceM).toBeGreaterThan(500);
    expect(offshoreDistanceM).toBeLessThan(1_500);
  });

  it('is longitude-wrap invariant and finite at both poles', () => {
    const antimeridianM = globalTerrainSource.nearestLandM(
      -17 * DEG,
      179.9 * DEG,
    );
    expect(antimeridianM).toBeGreaterThan(30_000);
    expect(antimeridianM).toBeLessThan(60_000);
    expect(
      globalTerrainSource.nearestLandM(-17 * DEG, -180.1 * DEG),
    ).toBeCloseTo(antimeridianM, 6);

    const northPoleM = globalTerrainSource.nearestLandM(Math.PI / 2, -170 * DEG);
    expect(northPoleM).toBeGreaterThan(600_000);
    expect(northPoleM).toBeLessThan(800_000);
    expect(globalTerrainSource.nearestLandM(Math.PI / 2, 70 * DEG)).toBe(
      northPoleM,
    );
    expect(globalTerrainSource.nearestLandM(-Math.PI / 2, 170 * DEG)).toBe(0);
  });

  it('applies the same strict coordinate validation as terrain sampling', () => {
    expect(() => globalTerrainSource.nearestLandM(Math.PI, 0)).toThrow(
      /latitudeRad/,
    );
    expect(() => globalTerrainSource.nearestLandM(0, Number.NaN)).toThrow(
      /finite/,
    );
  });
});

describe('coarse global tile provider', () => {
  it('emits a deterministic local set whose centre agrees with the globe sample', () => {
    const latitudeRad = 27.9805 * DEG;
    const longitudeRad = 86.8806 * DEG;
    const first = globalTerrainSource.tilesAt(latitudeRad, longitudeRad);
    const second = globalTerrainSource.tilesAt(latitudeRad, longitudeRad);
    expect(first).toHaveLength(9);
    expect(first.map((tile) => tile.key)).toEqual(
      second.map((tile) => tile.key),
    );
    for (let index = 0; index < first.length; index++) {
      assertTerrainTileGeometry(first[index]);
      expect(first[index].heightsM).toEqual(second[index].heightsM);
    }

    const locationKey = globalTerrainSource.locationKey(
      latitudeRad,
      longitudeRad,
    );
    const centreTile = first.find((tile) => tile.key === locationKey);
    expect(centreTile).toBeDefined();
    const centreIndex = 16 * centreTile!.samples + 16;
    const centreSample = globalTerrainSource.sample(
      centreTile!.anchorGeodetic.latitudeRad,
      centreTile!.anchorGeodetic.longitudeRad,
    );
    expect(centreTile!.heightsM[centreIndex]).toBe(
      Math.fround(centreSample.heightM),
    );
    expect(centreTile!.landFraction).toBeGreaterThan(0);
  });

  it('reuses bit-identical samples across neighbours at the antimeridian', () => {
    const tiles = globalTerrainSource.tilesAt(-75 * DEG, 179.99 * DEG);
    const seen = new Map<string, number>();
    let sharedSamples = 0;
    for (const tile of tiles) {
      for (let j = 0; j < tile.samples; j++) {
        for (let i = 0; i < tile.samples; i++) {
          const key = `${tile.cellOriginX + i}/${tile.cellOriginY + j}`;
          const height = tile.heightsM[j * tile.samples + i];
          const previous = seen.get(key);
          if (previous === undefined) {
            seen.set(key, height);
          } else {
            sharedSamples++;
            expect(Object.is(height, previous), key).toBe(true);
          }
        }
      }
    }
    // A 3 × 3 set has twelve shared 33-sample edges, with intersections
    // de-duplicated by the global cell key.
    expect(sharedSamples).toBeGreaterThan(350);
    expect(tiles.some((tile) => tile.key.endsWith('/0@1'))).toBe(true);
  });

  it('keeps the polar neighbourhood finite and structurally valid', () => {
    const tiles = globalTerrainSource.tilesAt(Math.PI / 2, 120 * DEG);
    expect(tiles).toHaveLength(6);
    expect(new Set(tiles.map((tile) => tile.key)).size).toBe(tiles.length);
    for (const tile of tiles) {
      assertTerrainTileGeometry(tile);
      expect(tile.heightsM.every(Number.isFinite)).toBe(true);
    }
  });
});

// Type-level witness that the shared object is the renderer's provider rather
// than a separate globe-only copy of the data.
const _providerWitness: GlobalTerrainSource = globalTerrainSource;
void _providerWitness;
