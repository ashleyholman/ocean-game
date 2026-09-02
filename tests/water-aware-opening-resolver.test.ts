import { describe, expect, it, vi } from 'vitest';
import type { GlobalTerrainSource } from '../src/terrain/GlobalTerrainSource';
import {
  formatWaterAwareOpeningDiagnostic,
  formatWaterAwareTeleportDiagnostic,
  formatWaterAwareTeleportNotice,
  resolveWaterAwareOpening,
  resolveWaterAwareTeleport,
  type AuthoredOpening,
  type WaterAwareOpeningSearchProfile,
} from '../src/terrain/WaterAwareOpeningResolver';

const DEG = Math.PI / 180;
const SMALL_SEARCH: WaterAwareOpeningSearchProfile = {
  minimumClearanceM: 100,
  radialStepM: 1_000,
  maximumRadiusM: 1_000,
  bearingStepDeg: 90,
};

describe('pure water-aware opening resolver', () => {
  it('preserves already-qualified water coordinates bit-identically', () => {
    const sample = vi.fn(() => 'ocean' as const);
    const nearestLandM = vi.fn(() => 12_345);
    const query = makeQuery(sample, nearestLandM);
    const authored: AuthoredOpening = {
      latitudeRad: -0,
      longitudeRad: 2.9,
      outboundCourseRad: -0.4,
    };

    const result = resolveWaterAwareOpening(query, authored, SMALL_SEARCH);
    expect(result.status).toBe('authored');
    if (result.status !== 'authored') throw new Error('expected authored result');
    expect(Object.is(result.resolved.latitudeRad, authored.latitudeRad)).toBe(
      true,
    );
    expect(Object.is(result.resolved.longitudeRad, authored.longitudeRad)).toBe(
      true,
    );
    expect(result).toMatchObject({
      reason: 'authored_water_qualified',
      displacementM: 0,
      candidatesTested: 1,
      ringsTested: 0,
      selectedBearingRad: null,
    });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(nearestLandM).toHaveBeenCalledTimes(1);
  });

  it('wraps an eastbound antimeridian candidate into the canonical gauge', () => {
    const authored: AuthoredOpening = {
      latitudeRad: 0,
      longitudeRad: 179.999 * DEG,
      outboundCourseRad: 90 * DEG,
    };
    const query = makeQuery(
      (latitudeRad, longitudeRad) =>
        latitudeRad === authored.latitudeRad &&
        longitudeRad === authored.longitudeRad
          ? 'land'
          : longitudeRad < 0
            ? 'ocean'
            : 'land',
      () => 500,
    );

    const result = resolveWaterAwareOpening(query, authored, SMALL_SEARCH);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved result');
    expect(result.resolved.longitudeRad).toBeGreaterThanOrEqual(-Math.PI);
    expect(result.resolved.longitudeRad).toBeLessThan(0);
    expect(result.displacementM).toBe(1_000);
  });

  it('uses an explicit tangent-bearing gauge for an exact-pole search', () => {
    const authored: AuthoredOpening = {
      latitudeRad: Math.PI / 2,
      longitudeRad: 2.4,
      outboundCourseRad: 0,
    };
    const query = makeQuery(
      (latitudeRad) =>
        latitudeRad === authored.latitudeRad ? 'land' : 'ocean',
      () => 500,
    );

    const first = resolveWaterAwareOpening(query, authored, SMALL_SEARCH);
    const second = resolveWaterAwareOpening(query, authored, SMALL_SEARCH);
    expect(first).toEqual(second);
    expect(first.status).toBe('resolved');
    if (first.status !== 'resolved') throw new Error('expected resolved result');
    expect(first.resolved.latitudeRad).toBeLessThan(Math.PI / 2);
    expect(Number.isFinite(first.resolved.longitudeRad)).toBe(true);
    expect(first.selectedBearingRad).toBe(0);
    // At the north pole the finite-latitude north basis continues across the
    // pole on the opposite authored meridian. This pins the otherwise
    // undefined atan2(0, 0) gauge instead of merely accepting a finite value.
    expect(first.resolved.longitudeRad).toBeCloseTo(
      wrapLongitude(authored.longitudeRad + Math.PI),
      12,
    );
  });

  it('breaks equal-displacement bearing ties clockwise after course proximity', () => {
    const authored: AuthoredOpening = {
      latitudeRad: 0,
      longitudeRad: 0,
      outboundCourseRad: 0,
    };
    const query = makeQuery(
      (latitudeRad, longitudeRad) =>
        latitudeRad === 0 && longitudeRad === 0
          ? 'land'
          : Math.abs(longitudeRad) > 1e-9
            ? 'ocean'
            : 'land',
      () => 500,
    );

    const result = resolveWaterAwareOpening(query, authored, SMALL_SEARCH);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved result');
    // North is rejected; east (+90°) and west (-90°) are equidistant from the
    // authored course. The stated clockwise tie-break selects east.
    expect(result.resolved.longitudeRad).toBeGreaterThan(0);
    expect(result.selectedBearingRad).toBeCloseTo(Math.PI / 2, 14);
    expect(result.candidatesTested).toBe(3);
  });

  it('returns structured failure after exactly the bounded candidate lattice', () => {
    const profile: WaterAwareOpeningSearchProfile = {
      ...SMALL_SEARCH,
      maximumRadiusM: 2_000,
    };
    const result = resolveWaterAwareOpening(
      makeQuery(() => 'land', () => 0),
      { latitudeRad: 0, longitudeRad: 0, outboundCourseRad: 0 },
      profile,
    );
    expect(result).toMatchObject({
      status: 'failed',
      reason: 'authored_land',
      resolved: null,
      candidatesTested: 9,
      ringsTested: 2,
      maximumObservedClearanceM: 0,
    });
  });

  it('rejects invalid coordinates and non-integral bounded profiles', () => {
    const query = makeQuery(() => 'ocean', () => 500);
    expect(() =>
      resolveWaterAwareOpening(
        query,
        { latitudeRad: Math.PI, longitudeRad: 0, outboundCourseRad: 0 },
        SMALL_SEARCH,
      ),
    ).toThrow(/latitudeRad/);
    expect(() =>
      resolveWaterAwareOpening(
        query,
        { latitudeRad: 0, longitudeRad: 0, outboundCourseRad: 0 },
        { ...SMALL_SEARCH, bearingStepDeg: 7 },
      ),
    ).toThrow(/divide 360/);
  });

  it('publishes authored, resolved, reason, and source in one stable diagnostic', () => {
    const authored = {
      latitudeRad: 0,
      longitudeRad: 0,
      outboundCourseRad: 0,
    };
    const result = resolveWaterAwareOpening(
      makeQuery(
        (latitudeRad, longitudeRad) =>
          latitudeRad === 0 && longitudeRad === 0 ? 'land' : 'ocean',
        () => 500,
      ),
      authored,
      SMALL_SEARCH,
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('expected resolved result');
    expect(formatWaterAwareOpeningDiagnostic(result)).toBe(
      'global opening resolved · reason authored_land' +
        ' · authored 0.00000°,0.00000° (land, 0 m clearance)' +
        ' → resolved 0.00899°,0.00000° (500 m clearance)' +
        ' · displacement 1000 m · test-water-query',
    );
  });
});

describe('pure water-aware globe teleport resolver', () => {
  it('accepts qualified ocean selections bit-identically', () => {
    const selected = { latitudeRad: -0, longitudeRad: 2.9 };
    const decision = resolveWaterAwareTeleport(
      makeQuery(() => 'ocean', () => 12_345),
      selected,
      SMALL_SEARCH,
    );

    expect(decision.status).toBe('accepted');
    expect(decision.target).not.toBeNull();
    expect(Object.is(decision.target!.latitudeRad, selected.latitudeRad)).toBe(
      true,
    );
    expect(Object.is(decision.target!.longitudeRad, selected.longitudeRad)).toBe(
      true,
    );
    expect(decision.resolution).toMatchObject({
      status: 'authored',
      candidatesTested: 1,
      displacementM: 0,
    });
    expect(formatWaterAwareTeleportNotice(decision)).toBeNull();
  });

  it('uses true north as the explicit no-course bearing gauge', () => {
    const decision = resolveWaterAwareTeleport(
      makeQuery(
        (latitudeRad, longitudeRad) =>
          latitudeRad === 0 && longitudeRad === 0 ? 'land' : 'ocean',
        () => 500,
      ),
      { latitudeRad: 0, longitudeRad: 0 },
      SMALL_SEARCH,
    );

    expect(decision.status).toBe('relocated');
    if (decision.status !== 'relocated') {
      throw new Error('expected relocated teleport');
    }
    expect(decision.target.latitudeRad).toBeGreaterThan(0);
    expect(decision.target.longitudeRad).toBeCloseTo(0, 14);
    expect(decision.resolution.selectedBearingRad).toBe(0);
    expect(formatWaterAwareTeleportDiagnostic(decision)).toBe(
      'global teleport relocated · selected 0.00000°,0.00000° (land, 0 m clearance)' +
        ' → target 0.00899°,0.00000° (500 m clearance)' +
        ' · displacement 1000 m · test-water-query',
    );
    expect(formatWaterAwareTeleportNotice(decision)).toBe(
      'moved 1.0 km to qualified coarse water',
    );
  });

  it('rejects a deeply inland selection after the bounded lattice', () => {
    const profile: WaterAwareOpeningSearchProfile = {
      ...SMALL_SEARCH,
      maximumRadiusM: 2_000,
    };
    const decision = resolveWaterAwareTeleport(
      makeQuery(() => 'land', () => 0),
      { latitudeRad: 0, longitudeRad: 0 },
      profile,
    );

    expect(decision.status).toBe('rejected');
    if (decision.status !== 'rejected') {
      throw new Error('expected rejected teleport');
    }
    expect(decision.target).toBeNull();
    expect(formatWaterAwareTeleportDiagnostic(decision)).toBe(
      'global teleport rejected · selected 0.00000°,0.00000° (land, 0 m clearance)' +
        ' · no 100 m-clearance lattice candidate across 2000 m search' +
        ' · maximum sampled 0 m · test-water-query',
    );
    expect(formatWaterAwareTeleportNotice(decision)).toBe(
      'rejected: 2 km lattice exhausted',
    );
  });
});

function wrapLongitude(longitudeRad: number): number {
  const wrapped = ((longitudeRad + Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped === Math.PI ? -Math.PI : wrapped;
}

function makeQuery(
  surfaceAt: (latitudeRad: number, longitudeRad: number) => 'land' | 'ocean',
  nearestLandM: (latitudeRad: number, longitudeRad: number) => number,
): Pick<GlobalTerrainSource, 'sourceBuildId' | 'sample' | 'nearestLandM'> {
  return {
    sourceBuildId: 'test-water-query',
    sample: (latitudeRad, longitudeRad) => {
      const surface = surfaceAt(latitudeRad, longitudeRad);
      return {
        latitudeRad,
        longitudeRad,
        surface,
        heightM: surface === 'land' ? 35 : -80,
        relief01: 0,
      };
    },
    nearestLandM,
  };
}
