import { describe, expect, it } from 'vitest';
import {
  requiredSyntheticTerrainFarKm,
  syntheticTerrainNearestLandM,
  SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M,
  SYNTHETIC_TERRAIN_DEFAULT_BEARING_DEG,
  SYNTHETIC_TERRAIN_DEFAULT_BEARING_OFF_BOW_DEG,
  SYNTHETIC_TERRAIN_DEFAULT_HAZE_KM,
  SYNTHETIC_TERRAIN_DEFAULT_RANGE_KM,
  SYNTHETIC_TERRAIN_RANGE_KM,
} from '../src/terrain/syntheticTerrainHarness';
import {
  SYNTHETIC_FIXTURE_IDS,
  syntheticFixtureCentreRangeM,
  syntheticFixtureNearestLandFromOffsetM,
  syntheticFixtureNearestLandM,
} from '../src/terrain/syntheticFixtures';
import { metresPerRadian } from '../src/terrain/terrainMath';
import { OPENING_TRUE_HEADING_DEG } from '../src/world/openingVoyage';

describe('synthetic terrain camera range', () => {
  it('exposes the full 1–400 km tuning range', () => {
    expect(SYNTHETIC_TERRAIN_RANGE_KM).toEqual({ min: 1, max: 400 });
  });

  it('defaults synthetic terrain haze to 150 km', () => {
    expect(SYNTHETIC_TERRAIN_DEFAULT_HAZE_KM).toBe(150);
  });

  it('derives the default landfall from the opening course, fine on the bow', () => {
    // Land is production now: the default headland is placed relative to the
    // course the opening voyage derives from the sea, not at a written-down
    // compass bearing, so a re-aimed ocean carries its landfall with it.
    expect(SYNTHETIC_TERRAIN_DEFAULT_RANGE_KM).toBe(6);
    expect(SYNTHETIC_TERRAIN_DEFAULT_BEARING_OFF_BOW_DEG).toBe(20);
    expect(SYNTHETIC_TERRAIN_DEFAULT_BEARING_DEG).toBe(
      OPENING_TRUE_HEADING_DEG + SYNTHETIC_TERRAIN_DEFAULT_BEARING_OFF_BOW_DEG,
    );
    // The clamp range the URL parser applies must actually admit the default.
    expect(Math.abs(SYNTHETIC_TERRAIN_DEFAULT_BEARING_DEG)).toBeLessThanOrEqual(
      360,
    );
  });

  it('keeps the broad peak inside the far plane as its range changes', () => {
    expect(requiredSyntheticTerrainFarKm(21)).toBe(61);
    expect(requiredSyntheticTerrainFarKm(40)).toBe(80);
    expect(requiredSyntheticTerrainFarKm(400)).toBe(440);
  });

  it('retains an explicit larger far-plane override', () => {
    expect(requiredSyntheticTerrainFarKm(40, 400)).toBe(400);
  });

  it('does not let a too-small override clip the fixture', () => {
    expect(requiredSyntheticTerrainFarKm(40, 25)).toBe(80);
  });

  /**
   * "Camera-inside-fixture is unguarded" — the standing terrain-round finding,
   * measured rather than argued.
   *
   * It was true of the placement rule it was written against, where `range`
   * meant vessel-to-fixture-CENTRE and `?fixture=peak&range=6` would have put
   * the eye 13 km inside a 19.6 km island. `range` has since become
   * nearest-land distance, which is a different guarantee entirely — and one
   * nothing had ever checked. This checks it at the closest range the URL
   * parser will admit, on every fixture, from bearings all round the compass,
   * against every above-water sample and not only those on the placement axis.
   */
  it('cannot mount a fixture with the eye inside it, at any bearing', () => {
    const clearanceM = SYNTHETIC_TERRAIN_RANGE_KM.min * 1000;
    for (const fixtureId of SYNTHETIC_FIXTURE_IDS) {
      for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += 15) {
        const bearingRad = (bearingDeg * Math.PI) / 180;
        const centreRangeM = syntheticFixtureCentreRangeM(
          fixtureId,
          bearingRad,
          clearanceM,
        );
        const nearestM = syntheticFixtureNearestLandM(
          fixtureId,
          bearingRad,
          centreRangeM,
        );
        // The placement is solved, so it lands ON the clearance rather than
        // beyond it; a metre of slack absorbs the solver's own arithmetic.
        expect(
          nearestM,
          `${fixtureId} at bearing ${bearingDeg}`,
        ).toBeGreaterThan(clearanceM - 1);
      }
    }
  });

  /**
   * The clearance readout stays true once the vessel leaves the placement axis.
   *
   * This is the fault TERR-104's travel found. `getNearestLandM` was the
   * placement solver's own offset — one number, measured on one bearing at
   * mount time — subtracted from the live centre distance for the rest of the
   * session. The voyage governor divides by that number to choose a
   * compression rate (`rate = ω_max·d/v`) and the contact warning compares it
   * against 500 m, so an over-report is the unsafe direction in both.
   *
   * The reconstruction below is the old arithmetic, verbatim, so this fails if
   * anyone puts it back: on `peak` it claims 10.3 km of clearance where there
   * is 5.2 km.
   */
  it('reports clearance from the whole coastline, not from the placement bearing', () => {
    const anchorLatRad = -36.5 * (Math.PI / 180);
    const anchorLonRad = 137.0 * (Math.PI / 180);
    const { northMPerRad, eastMPerRad } = metresPerRadian(anchorLatRad);
    const vesselAt = (eastM: number, northM: number) => ({
      latitudeRad: anchorLatRad + northM / northMPerRad,
      longitudeRad: anchorLonRad + eastM / eastMPerRad,
    });

    let worstStaleOverReportM = 0;
    for (const fixtureId of SYNTHETIC_FIXTURE_IDS) {
      const placementBearingRad = (20 * Math.PI) / 180;
      const requestedM = 6_000;
      const centreRangeM = syntheticFixtureCentreRangeM(
        fixtureId,
        placementBearingRad,
        requestedM,
      );
      const staleCoastOffsetM = centreRangeM - requestedM;

      for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += 15) {
        for (const rangeM of [3_000, 9_000, 25_000]) {
          const eastM = rangeM * Math.sin((bearingDeg * Math.PI) / 180);
          const northM = rangeM * Math.cos((bearingDeg * Math.PI) / 180);
          const live = syntheticTerrainNearestLandM(
            fixtureId,
            vesselAt(eastM, northM),
            { latitudeRad: anchorLatRad, longitudeRad: anchorLonRad },
          );
          const truth = syntheticFixtureNearestLandFromOffsetM(
            fixtureId,
            eastM,
            northM,
          );
          // Metres, not kilometres: the only slack left is the tangent-plane
          // conversion the readout makes on purpose, which is 26.6 m at 25 km
          // and vanishes as the land closes — nothing a rate policy or a 500 m
          // contact warning can notice.
          expect(
            Math.abs(live - truth),
            `${fixtureId} at ${bearingDeg}° ${rangeM} m`,
          ).toBeLessThan(40);

          const stale = Math.max(0, rangeM - staleCoastOffsetM);
          worstStaleOverReportM = Math.max(
            worstStaleOverReportM,
            stale - truth,
          );
        }
      }
    }
    // The size of what was being reported. If this ever drops to nothing the
    // fixtures have become circles and this test has stopped meaning anything.
    expect(worstStaleOverReportM).toBeGreaterThan(4_000);
  });

  /**
   * The half that IS unguarded: the vessel sails, and the fixture does not.
   *
   * Nothing stops a voyage closing the land, because there is no grounding
   * model — so the harness reports the approach instead of inventing one. This
   * pins the warning below the closest mount the parser allows, which is what
   * makes the report always arrive before contact rather than after it.
   */
  it('warns well before a voyage can walk the camera into the hill', () => {
    expect(SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M).toBeGreaterThan(0);
    expect(SYNTHETIC_TERRAIN_CLEARANCE_WARNING_M).toBeLessThan(
      SYNTHETIC_TERRAIN_RANGE_KM.min * 1000,
    );
  });
});
