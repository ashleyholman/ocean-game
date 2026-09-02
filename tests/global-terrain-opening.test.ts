import { describe, expect, it } from 'vitest';
import { globalTerrainSource } from '../src/terrain/GlobalTerrainSource';
import {
  DEFAULT_WATER_AWARE_OPENING_PROFILE,
  resolveWaterAwareOpening,
} from '../src/terrain/WaterAwareOpeningResolver';
import {
  OPENING_LATITUDE_DEG,
  OPENING_LONGITUDE_DEG,
  OPENING_TRUE_HEADING_RAD,
} from '../src/world/openingVoyage';

const DEG = Math.PI / 180;
/** A city centre on the coast: the land case the resolver exists for. */
const AUTHORED_LAND_OPENING = {
  latitudeRad: -33.8688 * DEG,
  longitudeRad: 151.2093 * DEG,
  outboundCourseRad: OPENING_TRUE_HEADING_RAD,
} as const;

/** The production opening, which sits in open water and must stay put. */
const AUTHORED_OPENING = {
  latitudeRad: OPENING_LATITUDE_DEG * DEG,
  longitudeRad: OPENING_LONGITUDE_DEG * DEG,
  outboundCourseRad: OPENING_TRUE_HEADING_RAD,
} as const;

describe('explicit-global opening', () => {
  it('leaves the production opening where it is authored, in qualified water', () => {
    const resolution = resolveWaterAwareOpening(globalTerrainSource, AUTHORED_OPENING);
    expect(resolution.status).toBe('authored');
    if (resolution.status !== 'authored') throw new Error('expected the authored point');
    expect(resolution).toMatchObject({
      authored: AUTHORED_OPENING,
      authoredSurface: 'ocean',
      reason: 'authored_water_qualified',
      displacementM: 0,
      ringsTested: 0,
    });
    expect(resolution.resolved.latitudeRad).toBe(AUTHORED_OPENING.latitudeRad);
    expect(resolution.resolved.longitudeRad).toBe(AUTHORED_OPENING.longitudeRad);
  });

  it('chooses the first qualified ring reproducibly without changing the authored constants', () => {
    const first = resolveWaterAwareOpening(
      globalTerrainSource,
      AUTHORED_LAND_OPENING,
    );
    const second = resolveWaterAwareOpening(
      globalTerrainSource,
      AUTHORED_LAND_OPENING,
    );
    expect(first).toEqual(second);
    expect(first.status).toBe('resolved');
    if (first.status !== 'resolved') throw new Error('expected land-opening resolution');

    expect(first).toMatchObject({
      sourceBuildId: globalTerrainSource.sourceBuildId,
      authored: AUTHORED_LAND_OPENING,
      authoredSurface: 'land',
      authoredClearanceM: 0,
      reason: 'authored_land',
    });
    expect(first.resolvedClearanceM).toBeGreaterThanOrEqual(
      DEFAULT_WATER_AWARE_OPENING_PROFILE.minimumClearanceM,
    );
    expect(
      globalTerrainSource.sample(
        first.resolved.latitudeRad,
        first.resolved.longitudeRad,
      ).surface,
    ).toBe('ocean');
    expect(first.displacementM).toBe(
      first.ringsTested * DEFAULT_WATER_AWARE_OPENING_PROFILE.radialStepM,
    );

    const previousRings = resolveWaterAwareOpening(
      globalTerrainSource,
      AUTHORED_LAND_OPENING,
      {
        ...DEFAULT_WATER_AWARE_OPENING_PROFILE,
        maximumRadiusM:
          first.displacementM -
          DEFAULT_WATER_AWARE_OPENING_PROFILE.radialStepM,
      },
    );
    expect(previousRings.status).toBe('failed');

    expect(OPENING_LATITUDE_DEG).toBe(-33.9);
    expect(OPENING_LONGITUDE_DEG).toBe(151.9);
  });
});
