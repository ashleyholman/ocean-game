import { describe, expect, it } from 'vitest';
import {
  AstronomyProvider,
  applyMat3,
  circularHoursDifference,
  createAstronomyFrame,
  daysInUtcYear,
  eqjDirectionFromRaDec,
  isUtcLeapYear,
  utcDayOfYear,
} from '../src/astronomy/AstronomyProvider';
import { dotVec3, normalizeVec3, vec3 } from '../src/world/math';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import {
  createGeographicBasis,
  ecefToGeodetic,
  geographicBasisFromGeodetic,
  type GeodeticCoordinates,
} from '../src/world/wgs84';

const DEG = Math.PI / 180;
const provider = new AstronomyProvider();

describe('astronomical Sun references', () => {
  it.each([
    [
      'NREL SPA canonical',
      '2003-10-17T19:30:30Z',
      39.742476,
      -105.1786,
      90 - 50.127952,
      194.34024,
    ],
    [
      'March equinox at Greenwich equator',
      '2024-03-20T12:00:00Z',
      0,
      0,
      88.166823,
      85.413967,
    ],
    [
      'Tasman Sea summer',
      '2025-01-15T02:01:44Z',
      -33.9,
      151.9,
      77.203857,
      0.001111,
    ],
    [
      'Tasman Sea winter',
      '2025-06-21T01:54:10Z',
      -33.9,
      151.9,
      32.685851,
      0.000256,
    ],
    [
      'Tromso summer',
      '2025-06-21T12:00:00Z',
      69.6492,
      18.9553,
      42.495134,
      203.1,
    ],
    [
      'Tromso winter',
      '2025-12-21T12:00:00Z',
      69.6492,
      18.9553,
      -4.128404,
      196.8,
    ],
  ])(
    '%s has published geometric altitude',
    (
      _label,
      iso,
      latitudeDeg,
      longitudeDeg,
      expectedAltitudeDeg,
      expectedAzimuthDeg,
    ) => {
      const frame = provider.compute(
        worldAt(iso, latitudeDeg, longitudeDeg).state,
        createAstronomyFrame(),
      );
      expect(frame.sunHorizontal.elevationRad / DEG).toBeCloseTo(
        expectedAltitudeDeg,
        1,
      );
      // The two Tromso rows primarily validate polar-day/night elevation. The
      // broad azimuth bound still catches east/west and factor-of-15 errors.
      const toleranceDeg = latitudeDeg > 60 ? 5 : 0.1;
      expect(
        circularDegreesDifference(
          frame.sunHorizontal.azimuthRad! / DEG,
          expectedAzimuthDeg,
        ),
      ).toBeLessThan(toleranceDeg);
    },
  );

  it('finds upper transit rather than assuming the zenith', () => {
    const tasman = worldAt(
      '2025-01-15T12:00:00Z',
      -33.9,
      151.9,
    );
    provider.setLocalApparentSolarTime(tasman, 12);
    const noonFrame = provider.compute(
      tasman.state,
      createAstronomyFrame(),
    );
    expect(
      Math.abs(
        circularHoursDifference(
          provider.localApparentSolarTimeHours(tasman.state),
          12,
        ),
      ),
    ).toBeLessThan(0.1 / 3600);
    expect(noonFrame.sunHorizontal.elevationRad / DEG).toBeCloseTo(77.2, 1);
    expect(noonFrame.sunHorizontal.elevationRad / DEG).toBeLessThan(80);
    expect(
      Math.abs(
        tasman.state.worldInstantUtcSeconds -
          Date.parse('2025-01-15T02:01:44Z') / 1000,
      ),
    ).toBeLessThan(3 * 60);
  });

  it('keeps midnight Sun and polar night finite', () => {
    const summer = worldAt(
      '2025-06-21T12:00:00Z',
      69.6492,
      18.9553,
    );
    provider.setLocalApparentSolarTime(summer, 0);
    const lowerTransit = provider.compute(
      summer.state,
      createAstronomyFrame(),
    );
    expect(lowerTransit.sunHorizontal.elevationRad / DEG).toBeGreaterThan(2);

    const winter = worldAt(
      '2025-12-21T12:00:00Z',
      69.6492,
      18.9553,
    );
    provider.setLocalApparentSolarTime(winter, 12);
    expect(
      provider.compute(winter.state, createAstronomyFrame()).sunHorizontal
        .elevationRad / DEG,
    ).toBeLessThan(-3);
  });

  it('puts the equinox sunrise on the eastern horizon', () => {
    const sunrise = provider.compute(
      worldAt('2024-03-20T06:04:00Z', 0, 0).state,
      createAstronomyFrame(),
    );
    expect(Math.abs(sunrise.sunHorizontal.elevationRad / DEG)).toBeLessThan(1);
    expect(
      Math.abs(
        circularDegreesDifference(
          sunrise.sunHorizontal.azimuthRad! / DEG,
          90,
        ),
      ),
    ).toBeLessThan(2);
  });
});

describe('celestial-to-Earth rotation and stars', () => {
  it('is a proper orthonormal rotation', () => {
    const frame = provider.compute(
      worldAt('2026-07-28T00:00:00Z', -33.9, 151.9).state,
      createAstronomyFrame(),
    );
    const matrix = frame.eqjToEcef;
    for (let row = 0; row < 3; row++) {
      for (let other = 0; other < 3; other++) {
        let value = 0;
        for (let column = 0; column < 3; column++) {
          value +=
            matrix[row * 3 + column] *
            matrix[other * 3 + column];
        }
        expect(value).toBeCloseTo(row === other ? 1 : 0, 12);
      }
    }
    expect(determinant3(matrix)).toBeCloseTo(1, 12);
  });

  it('rotates the celestial sphere westward over six hours', () => {
    const early = provider.compute(
      worldAt('2026-07-28T00:00:00Z', 0, 0).state,
      createAstronomyFrame(),
    );
    const later = provider.compute(
      worldAt('2026-07-28T06:00:00Z', 0, 0).state,
      createAstronomyFrame(),
    );
    const starEqj = eqjDirectionFromRaDec(0, 0, vec3());
    const a = normalizeVec3(
      vec3(),
      applyMat3(early.eqjToEcef, starEqj, vec3()),
    );
    const b = normalizeVec3(
      vec3(),
      applyMat3(later.eqjToEcef, starEqj, vec3()),
    );
    const rotationAngleDeg = Math.acos(
      Math.max(-1, Math.min(1, dotVec3(a, b))),
    ) / DEG;
    expect(rotationAngleDeg).toBeGreaterThan(89);
    expect(rotationAngleDeg).toBeLessThan(92);
    expect(a.x * b.y - a.y * b.x).toBeLessThan(0);
  });

  it('places Polaris below the southern site and near latitude in the north', () => {
    const polaris = eqjDirectionFromRaDec(
      2.52975,
      89.264109,
      vec3(),
    );
    const instant = '2025-01-15T10:00:00Z';
    const southern = worldAt(instant, -33.9, 151.9);
    const northern = worldAt(instant, 40, -105);

    expect(starElevationDeg(southern, polaris)).toBeLessThan(-32);
    expect(starElevationDeg(northern, polaris)).toBeGreaterThan(39);
    expect(starElevationDeg(northern, polaris)).toBeLessThan(41);
  });

  it('keeps all five principal Southern Cross stars visible from the southern site', () => {
    const southern = worldAt(
      '2025-01-15T10:00:00Z',
      -33.9,
      151.9,
    );
    const crux = [
      [12.443311, -63.099092], // Acrux
      [12.795359, -59.688764], // Mimosa
      [12.519429, -57.113212], // Gacrux
      [12.252427, -58.748928], // Imai
      [12.356004, -60.401148], // Ginan
    ];
    for (const [rightAscensionHours, declinationDeg] of crux) {
      expect(
        starElevationDeg(
          southern,
          eqjDirectionFromRaDec(
            rightAscensionHours,
            declinationDeg,
            vec3(),
          ),
        ),
      ).toBeGreaterThan(5);
    }
  });
});

describe('solar-time, date, and teleport controls', () => {
  it('preserves LAST when teleporting across longitudes', () => {
    const world = worldAt(
      '2025-01-15T02:55:00Z',
      -33.9,
      151.9,
    );
    const before = provider.localApparentSolarTimeHours(world.state);
    provider.teleportPreservingLocalApparentSolarTime(
      world,
      40 * DEG,
      -74 * DEG,
    );
    const after = provider.localApparentSolarTimeHours(world.state);
    expect(Math.abs(circularHoursDifference(after, before))).toBeLessThan(
      0.1 / 3600,
    );
    const geodetic = ecefToGeodetic(
      world.state.positionEcefM,
      geodeticOut(),
    );
    expect(geodetic.latitudeRad / DEG).toBeCloseTo(40, 10);
    expect(geodetic.longitudeRad / DEG).toBeCloseTo(-74, 10);
  });

  it('preserves LAST and the solar date through several teleports', () => {
    const world = worldAt(
      '2025-06-21T02:47:00Z',
      -33.9,
      151.9,
    );
    const selectedTime = provider.localApparentSolarTimeHours(
      world.state,
    );
    const selectedCalendar =
      provider.localApparentSolarCalendar(world.state);

    for (const [latitudeDeg, longitudeDeg] of [
      [40.7128, -74.006],
      [0, 0],
      [69.6492, 18.9553],
      [-33.8688, 151.2093],
    ]) {
      provider.teleportPreservingLocalApparentSolarTime(
        world,
        latitudeDeg * DEG,
        longitudeDeg * DEG,
      );
      expect(
        Math.abs(
          circularHoursDifference(
            provider.localApparentSolarTimeHours(world.state),
            selectedTime,
          ),
        ),
      ).toBeLessThan(0.5 / 3600);
      const calendar =
        provider.localApparentSolarCalendar(world.state);
      expect(calendar.year).toBe(selectedCalendar.year);
      expect(calendar.dayOfYear).toBe(selectedCalendar.dayOfYear);
      const frame = provider.compute(
        world.state,
        createAstronomyFrame(),
      );
      expect(Number.isFinite(frame.sunDirectionEcef.x)).toBe(true);
      expect([...frame.eqjToEcef].every(Number.isFinite)).toBe(true);
    }
  });

  it('preserves LAST while changing day of year, including leap years', () => {
    const world = worldAt(
      '2024-01-15T04:00:00Z',
      -33.9,
      151.9,
    );
    const before = provider.localApparentSolarTimeHours(world.state);
    provider.setDayOfYearPreservingLocalApparentSolarTime(world, 60);
    expect(utcDayOfYear(world.state.worldInstantUtcSeconds)).toBe(60);
    expect(
      Math.abs(
        circularHoursDifference(
          provider.localApparentSolarTimeHours(world.state),
          before,
        ),
      ),
    ).toBeLessThan(0.1 / 3600);
    expect(isUtcLeapYear(2024)).toBe(true);
    expect(daysInUtcYear(2024)).toBe(366);
    expect(daysInUtcYear(2025)).toBe(365);
  });

  it('treats 24:00 as the next solar-midnight branch', () => {
    const world = worldAt('2025-01-15T00:00:00Z', 0, 0);
    const before = world.state.worldInstantUtcSeconds;
    provider.setLocalApparentSolarTime(world, 24);
    expect(world.state.worldInstantUtcSeconds).toBeGreaterThan(before);
    expect(
      Math.abs(
        circularHoursDifference(
          provider.localApparentSolarTimeHours(world.state),
          0,
        ),
      ),
    ).toBeLessThan(0.1 / 3600);
  });

  it('keeps 00:00 to 12:00 on the selected apparent-solar day', () => {
    const world = worldAt(
      '2026-06-21T07:15:00Z',
      89.6,
      -108.5,
    );
    provider.setLocalApparentSolarTime(world, 0);
    const selectedDay =
      provider.localApparentSolarCalendar(world.state).dayOfYear;
    provider.setLocalApparentSolarTime(world, 12);
    expect(
      provider.localApparentSolarCalendar(world.state).dayOfYear,
    ).toBe(selectedDay);
    expect(
      Math.abs(
        circularHoursDifference(
          provider.localApparentSolarTimeHours(world.state),
          12,
        ),
      ),
    ).toBeLessThan(0.1 / 3600);
  });

  it('keeps the solar calendar branch stable at both antimeridian sides', () => {
    for (const longitudeDeg of [179.9, -179.9]) {
      const world = worldAt(
        '2026-01-15T12:00:00Z',
        10,
        longitudeDeg,
      );
      provider.setDayOfYearPreservingLocalApparentSolarTime(world, 200);
      provider.setLocalApparentSolarTime(world, 0);
      expect(
        provider.localApparentSolarCalendar(world.state).dayOfYear,
      ).toBe(200);
      provider.setLocalApparentSolarTime(world, 12);
      expect(
        provider.localApparentSolarCalendar(world.state).dayOfYear,
      ).toBe(200);
    }
  });

  it('uses a finite longitude-zero gauge but suppresses azimuth at a pole', () => {
    const pole = worldAt('2025-06-21T12:00:00Z', 90, 170);
    const frame = provider.compute(pole.state, createAstronomyFrame());
    expect(frame.sunHorizontal.azimuthRad).toBeNull();
    expect(Number.isFinite(frame.sunHorizontal.elevationRad)).toBe(true);
    expect(
      Number.isFinite(provider.localApparentSolarTimeHours(pole.state)),
    ).toBe(true);
  });
});

function worldAt(
  iso: string,
  latitudeDeg: number,
  longitudeDeg: number,
): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.parse(iso) / 1000,
    latitudeRad: latitudeDeg * DEG,
    longitudeRad: longitudeDeg * DEG,
    initialCourseRad: 0,
    initialSpeedMps: 0,
  });
}

function starElevationDeg(
  world: PlanetaryWorld,
  starEqj: Readonly<{ x: number; y: number; z: number }>,
): number {
  const frame = provider.compute(world.state, createAstronomyFrame());
  const starEcef = normalizeVec3(
    vec3(),
    applyMat3(frame.eqjToEcef, starEqj, vec3()),
  );
  const geodetic = ecefToGeodetic(
    world.state.positionEcefM,
    geodeticOut(),
  );
  const basis = geographicBasisFromGeodetic(
    geodetic.latitudeRad,
    geodetic.longitudeRad,
    createGeographicBasis(),
  );
  return Math.asin(
    Math.max(-1, Math.min(1, dotVec3(starEcef, basis.up))),
  ) / DEG;
}

function determinant3(matrix: Float64Array): number {
  return (
    matrix[0] * (matrix[4] * matrix[8] - matrix[5] * matrix[7]) -
    matrix[1] * (matrix[3] * matrix[8] - matrix[5] * matrix[6]) +
    matrix[2] * (matrix[3] * matrix[7] - matrix[4] * matrix[6])
  );
}

function circularDegreesDifference(aDeg: number, bDeg: number): number {
  let difference = Math.abs(aDeg - bDeg) % 360;
  if (difference > 180) difference = 360 - difference;
  return difference;
}

function geodeticOut(): GeodeticCoordinates {
  return { latitudeRad: 0, longitudeRad: 0, heightM: 0 };
}
