import { dotVec3, lengthVec3 } from './math';
import type { CanonicalWorldState, NavigationTelemetry } from './types';
import {
  WGS84_POLE_AXIS_EPSILON_M,
  createGeographicBasis,
  ecefToGeodetic,
  geographicBasisFromGeodetic,
  type GeodeticCoordinates,
} from './wgs84';

const COURSE_SPEED_EPSILON_MPS = 1e-9;
const COURSE_POLE_DISTANCE_M = Math.max(0.001, WGS84_POLE_AXIS_EPSILON_M);

export function deriveNavigationTelemetry(
  state: Readonly<CanonicalWorldState>,
  out: NavigationTelemetry,
): NavigationTelemetry {
  ecefToGeodetic(state.positionEcefM, GEODETIC);
  out.latitudeRad = GEODETIC.latitudeRad;
  out.longitudeRad = GEODETIC.longitudeRad;
  out.heightM = GEODETIC.heightM;
  out.speedOverGroundMps = lengthVec3(state.velocityEcefMps);

  if (out.speedOverGroundMps <= COURSE_SPEED_EPSILON_MPS) {
    out.trueCourseRad = null;
    out.courseUnavailableReason = 'stationary';
    return out;
  }

  const axisDistanceM = Math.hypot(
    state.positionEcefM.x,
    state.positionEcefM.y,
  );
  if (axisDistanceM <= COURSE_POLE_DISTANCE_M) {
    out.trueCourseRad = null;
    out.courseUnavailableReason = 'pole';
    return out;
  }

  geographicBasisFromGeodetic(
    GEODETIC.latitudeRad,
    GEODETIC.longitudeRad,
    BASIS,
  );
  let courseRad = Math.atan2(
    dotVec3(state.velocityEcefMps, BASIS.east),
    dotVec3(state.velocityEcefMps, BASIS.north),
  );
  if (courseRad < 0) courseRad += 2 * Math.PI;
  out.trueCourseRad = courseRad;
  out.courseUnavailableReason = null;
  return out;
}

export function createNavigationTelemetry(): NavigationTelemetry {
  return {
    latitudeRad: 0,
    longitudeRad: 0,
    heightM: 0,
    speedOverGroundMps: 0,
    trueCourseRad: null,
    courseUnavailableReason: 'stationary',
  };
}

const GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};
const BASIS = createGeographicBasis();
