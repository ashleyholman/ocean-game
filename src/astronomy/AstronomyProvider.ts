import {
  Body,
  Equator,
  HourAngle,
  Illumination,
  Observer,
  Rotation_EQJ_EQD,
  SearchHourAngle,
  SiderealTime,
} from 'astronomy-engine';
import {
  assertFiniteNumber,
  dotVec3,
  normalizeVec3,
  setVec3,
  vec3,
  type Vec3d,
} from '../world/math';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import type { CanonicalWorldState } from '../world/types';
import {
  WGS84_POLE_AXIS_EPSILON_M,
  createGeographicBasis,
  ecefToGeodetic,
  geographicBasisFromGeodetic,
  type GeodeticCoordinates,
} from '../world/wgs84';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const HOURS_TO_RAD = Math.PI / 12;
const SOLAR_TIME_TOLERANCE_HOURS = 0.5 / 3600;
const SOLAR_AZIMUTH_POLE_DISTANCE_M = Math.max(
  0.001,
  WGS84_POLE_AXIS_EPSILON_M,
);

/** Row-major 3x3 rotation. */
export type Mat3d = Float64Array;

export interface BodyHorizontalPosition {
  azimuthRad: number | null;
  elevationRad: number;
}

export interface AstronomyFrame {
  /** One shared J2000 mean-equatorial (EQJ) to ECEF rotation. */
  eqjToEcef: Mat3d;
  sunDirectionEcef: Vec3d;
  moonDirectionEcef: Vec3d;
  sunHorizontal: BodyHorizontalPosition;
  moonHorizontal: BodyHorizontalPosition;
  /**
   * Sunlit fraction of the lunar disc, 0..1. Phase-aware Moon brightness is a
   * presentation concern, but the *fraction* is astronomy and belongs here
   * with the directions it is computed from.
   */
  moonIlluminatedFraction: number;
}

export interface ApparentSolarCalendar {
  year: number;
  monthIndex: number;
  dayOfMonth: number;
  dayOfYear: number;
  daysInYear: number;
}

export function createAstronomyFrame(): AstronomyFrame {
  return {
    eqjToEcef: new Float64Array(9),
    sunDirectionEcef: vec3(),
    moonDirectionEcef: vec3(),
    sunHorizontal: { azimuthRad: null, elevationRad: 0 },
    moonHorizontal: { azimuthRad: null, elevationRad: 0 },
    moonIlluminatedFraction: 0.5,
  };
}

/**
 * Isolates Astronomy Engine and exposes only project units/frames.
 *
 * Astronomy Engine's RotationMatrix storage is column-major-like: rot[source]
 * [destination]. We convert it explicitly into a conventional row-major
 * project matrix and test its basis-vector signs.
 */
export class AstronomyProvider {
  compute(
    state: Readonly<CanonicalWorldState>,
    out: AstronomyFrame,
  ): AstronomyFrame {
    const date = dateFromUtcSeconds(state.worldInstantUtcSeconds);
    ecefToGeodetic(state.positionEcefM, GEODETIC);
    const observer = observerFromGeodetic(GEODETIC);

    this.computeEqjToEcef(date, out.eqjToEcef);

    const sunEqj = Equator(Body.Sun, date, observer, false, true).vec;
    setVec3(EQJ_VECTOR, sunEqj.x, sunEqj.y, sunEqj.z);
    applyMat3(out.eqjToEcef, EQJ_VECTOR, out.sunDirectionEcef);
    normalizeVec3(
      out.sunDirectionEcef,
      out.sunDirectionEcef,
      'Sun direction',
    );

    const moonEqj = Equator(Body.Moon, date, observer, false, true).vec;
    setVec3(EQJ_VECTOR, moonEqj.x, moonEqj.y, moonEqj.z);
    applyMat3(out.eqjToEcef, EQJ_VECTOR, out.moonDirectionEcef);
    normalizeVec3(
      out.moonDirectionEcef,
      out.moonDirectionEcef,
      'Moon direction',
    );

    this.horizontalFromEcef(
      state,
      GEODETIC,
      out.sunDirectionEcef,
      out.sunHorizontal,
    );
    this.horizontalFromEcef(
      state,
      GEODETIC,
      out.moonDirectionEcef,
      out.moonHorizontal,
    );

    out.moonIlluminatedFraction = Illumination(Body.Moon, date).phase_fraction;
    return out;
  }

  /** LAST = 12h + apparent topocentric Sun hour angle. */
  localApparentSolarTimeHours(
    state: Readonly<CanonicalWorldState>,
  ): number {
    ecefToGeodetic(state.positionEcefM, GEODETIC);
    const observer = observerFromGeodetic(GEODETIC);
    const hourAngleHours = HourAngle(
      Body.Sun,
      dateFromUtcSeconds(state.worldInstantUtcSeconds),
      observer,
    );
    return wrapHours24(hourAngleHours + 12);
  }

  /**
   * Calendar fields for the observer's apparent-solar day. This is a derived
   * view: UTC remains canonical. The synthetic local timestamp is UTC shifted
   * by the circular difference between LAST and UTC clock time.
   */
  localApparentSolarCalendar(
    state: Readonly<CanonicalWorldState>,
  ): ApparentSolarCalendar {
    const date = dateFromUtcSeconds(state.worldInstantUtcSeconds);
    const utcHours =
      date.getUTCHours() +
      date.getUTCMinutes() / 60 +
      date.getUTCSeconds() / 3600 +
      date.getUTCMilliseconds() / 3_600_000;
    const solarHours = this.localApparentSolarTimeHours(state);
    ecefToGeodetic(state.positionEcefM, GEODETIC);
    const longitudeHours = GEODETIC.longitudeRad * (12 / Math.PI);
    // `solarHours - utcHours` is known only modulo 24. Choose the branch
    // nearest the longitude-derived mean-solar offset, not the branch nearest
    // zero; the latter assigns the wrong date close to the antimeridian when
    // the equation of time pushes the apparent offset just beyond ±12 h.
    let offsetHours = solarHours - utcHours;
    offsetHours +=
      24 * Math.round((longitudeHours - offsetHours) / 24);
    const solarDate = new Date(
      date.getTime() + offsetHours * 3_600_000,
    );
    const year = solarDate.getUTCFullYear();
    return {
      year,
      monthIndex: solarDate.getUTCMonth(),
      dayOfMonth: solarDate.getUTCDate(),
      dayOfYear: dayOfYearFromDate(solarDate),
      daysInYear: daysInUtcYear(year),
    };
  }

  /**
   * Finds the nearest event with a requested LAST. `24` deliberately selects
   * the next 00:00 branch; `0` selects the nearest branch.
   */
  findUtcSecondsForLocalApparentSolarTime(
    state: Readonly<CanonicalWorldState>,
    targetSolarTimeHours: number,
    referenceUtcSeconds: number,
  ): number {
    assertFiniteNumber(targetSolarTimeHours, 'targetSolarTimeHours');
    assertFiniteNumber(referenceUtcSeconds, 'referenceUtcSeconds');
    if (targetSolarTimeHours < 0 || targetSolarTimeHours > 24) {
      throw new RangeError('targetSolarTimeHours must be in [0, 24]');
    }

    ecefToGeodetic(state.positionEcefM, GEODETIC);
    const observer = observerFromGeodetic(GEODETIC);
    const targetWrappedHours = wrapHours24(targetSolarTimeHours);
    const targetHourAngleHours = wrapHours24(targetWrappedHours - 12);
    const referenceDate = dateFromUtcSeconds(referenceUtcSeconds);

    const currentHours = wrapHours24(
      HourAngle(Body.Sun, referenceDate, observer) + 12,
    );
    if (
      targetSolarTimeHours !== 24 &&
      Math.abs(circularHoursDifference(currentHours, targetWrappedHours)) <=
        SOLAR_TIME_TOLERANCE_HOURS
    ) {
      return referenceUtcSeconds;
    }

    if (targetSolarTimeHours === 24) {
      const event = SearchHourAngle(
        Body.Sun,
        observer,
        targetHourAngleHours,
        new Date(referenceDate.getTime() + 1),
        1,
      );
      return refineSolarTimeUtcSeconds(
        observer,
        targetWrappedHours,
        event.time.date.getTime() / 1000,
      );
    }

    const before = SearchHourAngle(
      Body.Sun,
      observer,
      targetHourAngleHours,
      new Date(referenceDate.getTime() + 1),
      -1,
    );
    const after = SearchHourAngle(
      Body.Sun,
      observer,
      targetHourAngleHours,
      new Date(referenceDate.getTime() - 1),
      1,
    );
    const beforeSeconds = refineSolarTimeUtcSeconds(
      observer,
      targetWrappedHours,
      before.time.date.getTime() / 1000,
    );
    const afterSeconds = refineSolarTimeUtcSeconds(
      observer,
      targetWrappedHours,
      after.time.date.getTime() / 1000,
    );
    return referenceUtcSeconds - beforeSeconds <=
      afterSeconds - referenceUtcSeconds
      ? beforeSeconds
      : afterSeconds;
  }

  setLocalApparentSolarTime(
    world: PlanetaryWorld,
    targetSolarTimeHours: number,
  ): void {
    const calendar = this.localApparentSolarCalendar(world.state);
    const instant = this.findUtcSecondsOnApparentSolarDay(
      world.state,
      targetSolarTimeHours,
      calendar.year,
      calendar.dayOfYear,
    );
    world.setWorldInstantUtcSeconds(instant);
  }

  setDayOfYearPreservingLocalApparentSolarTime(
    world: PlanetaryWorld,
    dayOfYear: number,
  ): void {
    assertFiniteNumber(dayOfYear, 'dayOfYear');
    const calendar = this.localApparentSolarCalendar(world.state);
    const year = calendar.year;
    const dayCount = daysInUtcYear(year);
    if (
      dayOfYear < 1 ||
      dayOfYear > dayCount ||
      !Number.isInteger(dayOfYear)
    ) {
      throw new RangeError(
        `dayOfYear must be an integer in [1, ${dayCount}]`,
      );
    }
    const solarTimeHours = this.localApparentSolarTimeHours(world.state);
    const instant = this.findUtcSecondsOnApparentSolarDay(
      world.state,
      solarTimeHours,
      year,
      dayOfYear,
    );
    world.setWorldInstantUtcSeconds(instant);
  }

  teleportPreservingLocalApparentSolarTime(
    world: PlanetaryWorld,
    latitudeRad: number,
    longitudeRad: number,
  ): void {
    const solarTimeHours = this.localApparentSolarTimeHours(world.state);
    const calendar = this.localApparentSolarCalendar(world.state);

    world.teleportGeodeticRadians(latitudeRad, longitudeRad);
    const instant = this.findUtcSecondsOnApparentSolarDay(
      world.state,
      solarTimeHours,
      calendar.year,
      calendar.dayOfYear,
    );
    world.setWorldInstantUtcSeconds(instant);
  }

  private findUtcSecondsOnApparentSolarDay(
    state: Readonly<CanonicalWorldState>,
    targetSolarTimeHours: number,
    solarYear: number,
    solarDayOfYear: number,
  ): number {
    assertFiniteNumber(targetSolarTimeHours, 'targetSolarTimeHours');
    if (targetSolarTimeHours < 0 || targetSolarTimeHours > 24) {
      throw new RangeError('targetSolarTimeHours must be in [0, 24]');
    }
    const dayCount = daysInUtcYear(solarYear);
    if (
      !Number.isInteger(solarDayOfYear) ||
      solarDayOfYear < 1 ||
      solarDayOfYear > dayCount
    ) {
      throw new RangeError(
        `solarDayOfYear must be an integer in [1, ${dayCount}]`,
      );
    }

    ecefToGeodetic(state.positionEcefM, GEODETIC);
    const observer = observerFromGeodetic(GEODETIC);
    // Longitude supplies an inexpensive first estimate; SearchHourAngle then
    // accounts for the equation of time and the full apparent Sun model.
    const estimatedNoonUtcSeconds =
      Date.UTC(solarYear, 0, solarDayOfYear, 12, 0, 0, 0) / 1000 -
      (GEODETIC.longitudeRad / (2 * Math.PI)) * 86_400;
    const noonUtcSeconds =
      this.findUtcSecondsForLocalApparentSolarTime(
        state,
        12,
        estimatedNoonUtcSeconds,
      );
    if (targetSolarTimeHours === 12) return noonUtcSeconds;

    const direction = targetSolarTimeHours < 12 ? -1 : 1;
    const targetHourAngleHours = wrapHours24(
      wrapHours24(targetSolarTimeHours) - 12,
    );
    const event = SearchHourAngle(
      Body.Sun,
      observer,
      targetHourAngleHours,
      new Date(noonUtcSeconds * 1000 - direction),
      direction,
    );
    return refineSolarTimeUtcSeconds(
      observer,
      wrapHours24(targetSolarTimeHours),
      event.time.date.getTime() / 1000,
    );
  }

  private computeEqjToEcef(date: Date, out: Mat3d): void {
    const eqjToEqd = Rotation_EQJ_EQD(date).rot;
    const gastRad = SiderealTime(date) * HOURS_TO_RAD;
    const cosine = Math.cos(gastRad);
    const sine = Math.sin(gastRad);

    for (let sourceAxis = 0; sourceAxis < 3; sourceAxis++) {
      const equatorDateX = eqjToEqd[sourceAxis][0];
      const equatorDateY = eqjToEqd[sourceAxis][1];
      const equatorDateZ = eqjToEqd[sourceAxis][2];
      out[sourceAxis] =
        cosine * equatorDateX + sine * equatorDateY;
      out[3 + sourceAxis] =
        -sine * equatorDateX + cosine * equatorDateY;
      out[6 + sourceAxis] = equatorDateZ;
    }
  }

  private horizontalFromEcef(
    state: Readonly<CanonicalWorldState>,
    geodetic: Readonly<GeodeticCoordinates>,
    directionEcef: Readonly<Vec3d>,
    out: BodyHorizontalPosition,
  ): void {
    geographicBasisFromGeodetic(
      geodetic.latitudeRad,
      geodetic.longitudeRad,
      BASIS,
    );
    const east = dotVec3(directionEcef, BASIS.east);
    const north = dotVec3(directionEcef, BASIS.north);
    const up = Math.max(-1, Math.min(1, dotVec3(directionEcef, BASIS.up)));
    out.elevationRad = Math.asin(up);

    if (
      Math.hypot(state.positionEcefM.x, state.positionEcefM.y) <=
      SOLAR_AZIMUTH_POLE_DISTANCE_M
    ) {
      out.azimuthRad = null;
      return;
    }
    let azimuthRad = Math.atan2(east, north);
    if (azimuthRad < 0) azimuthRad += 2 * Math.PI;
    out.azimuthRad = azimuthRad;
  }
}

export function applyMat3(
  matrix: Mat3d,
  value: Readonly<Vec3d>,
  out: Vec3d,
): Vec3d {
  const x = matrix[0] * value.x + matrix[1] * value.y + matrix[2] * value.z;
  const y = matrix[3] * value.x + matrix[4] * value.y + matrix[5] * value.z;
  const z = matrix[6] * value.x + matrix[7] * value.y + matrix[8] * value.z;
  return setVec3(out, x, y, z);
}

export function eqjDirectionFromRaDec(
  rightAscensionHours: number,
  declinationDeg: number,
  out: Vec3d,
): Vec3d {
  assertFiniteNumber(rightAscensionHours, 'rightAscensionHours');
  assertFiniteNumber(declinationDeg, 'declinationDeg');
  if (declinationDeg < -90 || declinationDeg > 90) {
    throw new RangeError('declinationDeg must be in [-90, 90]');
  }
  const rightAscensionRad = rightAscensionHours * HOURS_TO_RAD;
  const declinationRad = declinationDeg * DEG_TO_RAD;
  const cosDeclination = Math.cos(declinationRad);
  return setVec3(
    out,
    cosDeclination * Math.cos(rightAscensionRad),
    cosDeclination * Math.sin(rightAscensionRad),
    Math.sin(declinationRad),
  );
}

export function wrapHours24(hours: number): number {
  assertFiniteNumber(hours, 'hours');
  let wrapped = hours % 24;
  if (wrapped < 0) wrapped += 24;
  return wrapped === 0 ? 0 : wrapped;
}

export function circularHoursDifference(aHours: number, bHours: number): number {
  let difference = wrapHours24(aHours - bHours);
  if (difference >= 12) difference -= 24;
  return difference;
}

export function isUtcLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInUtcYear(year: number): number {
  return isUtcLeapYear(year) ? 366 : 365;
}

export function utcDayOfYear(worldInstantUtcSeconds: number): number {
  const date = dateFromUtcSeconds(worldInstantUtcSeconds);
  return dayOfYearFromDate(date);
}

function dayOfYearFromDate(date: Date): number {
  const year = date.getUTCFullYear();
  return (
    Math.floor(
      (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) -
        Date.UTC(year, 0, 1)) /
        86_400_000,
    ) + 1
  );
}

function observerFromGeodetic(
  geodetic: Readonly<GeodeticCoordinates>,
): Observer {
  return new Observer(
    geodetic.latitudeRad * RAD_TO_DEG,
    geodetic.longitudeRad * RAD_TO_DEG,
    geodetic.heightM,
  );
}

function refineSolarTimeUtcSeconds(
  observer: Observer,
  targetSolarTimeHours: number,
  initialUtcSeconds: number,
): number {
  let utcSeconds = initialUtcSeconds;
  for (let iteration = 0; iteration < 4; iteration++) {
    const date = dateFromUtcSeconds(utcSeconds);
    const currentHours = wrapHours24(
      HourAngle(Body.Sun, date, observer) + 12,
    );
    const errorHours = circularHoursDifference(
      currentHours,
      targetSolarTimeHours,
    );
    if (Math.abs(errorHours) <= SOLAR_TIME_TOLERANCE_HOURS) {
      return utcSeconds;
    }
    const probeHours = wrapHours24(
      HourAngle(
        Body.Sun,
        new Date(date.getTime() + 1000),
        observer,
      ) + 12,
    );
    const hoursPerSecond = circularHoursDifference(
      probeHours,
      currentHours,
    );
    if (!Number.isFinite(hoursPerSecond) || hoursPerSecond <= 0) {
      throw new Error('Apparent solar-time refinement did not advance');
    }
    utcSeconds -= errorHours / hoursPerSecond;
  }
  return utcSeconds;
}

function dateFromUtcSeconds(worldInstantUtcSeconds: number): Date {
  assertFiniteNumber(worldInstantUtcSeconds, 'worldInstantUtcSeconds');
  const date = new Date(worldInstantUtcSeconds * 1000);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('worldInstantUtcSeconds is outside the Date range');
  }
  return date;
}

const GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};
const BASIS = createGeographicBasis();
const EQJ_VECTOR = vec3();
