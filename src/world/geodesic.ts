import { Geodesic } from 'geographiclib-geodesic';
import {
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  vec3,
  type Vec3d,
} from './math';
import { transportFrameAlongGeodesic } from './frameTransport';
import type { CanonicalWorldState } from './types';
import {
  createGeographicBasis,
  ecefToGeodetic,
  geodeticToEcef,
  geographicBasisFromGeodetic,
  surfaceNormalEcef,
  type GeodeticCoordinates,
} from './wgs84';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

export interface DirectGeodesicResult {
  latitude2Rad: number;
  longitude2Rad: number;
  forwardAzimuth2Rad: number;
}

/**
 * The other half of the geodesic problem: two points in, the course and
 * distance between them out.
 *
 * A navigator laying a course to a chart position needs exactly this, and it
 * must be the *same* solver that propagates the vessel — a route measured on a
 * sphere and sailed on an ellipsoid is a second geometry, and this codebase
 * has paid for those before.
 */
export interface InverseGeodesicResult {
  distanceM: number;
  /** Initial course from point 1 toward point 2, radians clockwise from north. */
  forwardAzimuth1Rad: number;
}

export interface EllipsoidGeodesic {
  direct(
    latitude1Rad: number,
    longitude1Rad: number,
    forwardAzimuth1Rad: number,
    distanceM: number,
    out: DirectGeodesicResult,
  ): DirectGeodesicResult;
  inverse(
    latitude1Rad: number,
    longitude1Rad: number,
    latitude2Rad: number,
    longitude2Rad: number,
    out: InverseGeodesicResult,
  ): InverseGeodesicResult;
}

/** Radians/metres isolation layer around GeographicLib's degree API. */
export class GeographicLibGeodesic implements EllipsoidGeodesic {
  inverse(
    latitude1Rad: number,
    longitude1Rad: number,
    latitude2Rad: number,
    longitude2Rad: number,
    out: InverseGeodesicResult,
  ): InverseGeodesicResult {
    const result = Geodesic.WGS84.Inverse(
      latitude1Rad * RAD_TO_DEG,
      longitude1Rad * RAD_TO_DEG,
      latitude2Rad * RAD_TO_DEG,
      longitude2Rad * RAD_TO_DEG,
      Geodesic.STANDARD,
    );
    if (result.s12 === undefined || result.azi1 === undefined) {
      throw new Error('GeographicLib inverse result omitted distance or course');
    }
    out.distanceM = result.s12;
    out.forwardAzimuth1Rad = result.azi1 * DEG_TO_RAD;
    return out;
  }

  direct(
    latitude1Rad: number,
    longitude1Rad: number,
    forwardAzimuth1Rad: number,
    distanceM: number,
    out: DirectGeodesicResult,
  ): DirectGeodesicResult {
    const result = Geodesic.WGS84.Direct(
      latitude1Rad * RAD_TO_DEG,
      longitude1Rad * RAD_TO_DEG,
      forwardAzimuth1Rad * RAD_TO_DEG,
      distanceM,
      Geodesic.STANDARD | Geodesic.LONG_UNROLL,
    );
    if (
      result.lat2 === undefined ||
      result.lon2 === undefined ||
      result.azi2 === undefined
    ) {
      throw new Error('GeographicLib direct result omitted endpoint fields');
    }
    out.latitude2Rad = result.lat2 * DEG_TO_RAD;
    out.longitude2Rad = result.lon2 * DEG_TO_RAD;
    out.forwardAzimuth2Rad = result.azi2 * DEG_TO_RAD;
    return out;
  }
}

/**
 * Advances along the current ECEF tangent by a supplied geodesic distance.
 * Speed magnitude is preserved; callers may rescale it afterwards when an
 * analytically integrated acceleration law changes speed over the interval.
 */
export function propagateGeodesicDistance(
  state: CanonicalWorldState,
  distanceM: number,
  geodesic: EllipsoidGeodesic,
): void {
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    throw new RangeError('distanceM must be finite and non-negative');
  }
  const speedMps = lengthVec3(state.velocityEcefMps);
  if (distanceM === 0 || speedMps === 0) return;

  normalizeVec3(START_TANGENT, state.velocityEcefMps, 'ECEF velocity');
  surfaceNormalEcef(state.positionEcefM, START_UP);
  ecefToGeodetic(state.positionEcefM, START_GEODETIC);
  geographicBasisFromGeodetic(
    START_GEODETIC.latitudeRad,
    START_GEODETIC.longitudeRad,
    START_BASIS,
  );

  const forwardAzimuth1Rad = Math.atan2(
    dotVec3(START_TANGENT, START_BASIS.east),
    dotVec3(START_TANGENT, START_BASIS.north),
  );
  geodesic.direct(
    START_GEODETIC.latitudeRad,
    START_GEODETIC.longitudeRad,
    forwardAzimuth1Rad,
    distanceM,
    DIRECT_RESULT,
  );

  // Construct T1 from GeographicLib's raw, mutually consistent lon2/azi2
  // before geodeticToEcef snaps an exact pole to the longitude-zero axis.
  geographicBasisFromGeodetic(
    DIRECT_RESULT.latitude2Rad,
    DIRECT_RESULT.longitude2Rad,
    END_BASIS,
  );
  const sinAzimuth = Math.sin(DIRECT_RESULT.forwardAzimuth2Rad);
  const cosAzimuth = Math.cos(DIRECT_RESULT.forwardAzimuth2Rad);
  END_TANGENT.x =
    END_BASIS.north.x * cosAzimuth + END_BASIS.east.x * sinAzimuth;
  END_TANGENT.y =
    END_BASIS.north.y * cosAzimuth + END_BASIS.east.y * sinAzimuth;
  END_TANGENT.z =
    END_BASIS.north.z * cosAzimuth + END_BASIS.east.z * sinAzimuth;
  normalizeVec3(END_TANGENT, END_TANGENT, 'endpoint geodesic tangent');

  geodeticToEcef(
    DIRECT_RESULT.latitude2Rad,
    DIRECT_RESULT.longitude2Rad,
    0,
    END_POSITION,
  );
  surfaceNormalEcef(END_POSITION, END_UP);
  transportFrameAlongGeodesic(
    state.surfaceFrameEcef,
    START_TANGENT,
    START_UP,
    END_TANGENT,
    END_UP,
  );

  state.positionEcefM.x = END_POSITION.x;
  state.positionEcefM.y = END_POSITION.y;
  state.positionEcefM.z = END_POSITION.z;
  scaleVec3(state.velocityEcefMps, END_TANGENT, speedMps);
}

const START_TANGENT = vec3();
const END_TANGENT = vec3();
const START_UP = vec3();
const END_UP = vec3();
const END_POSITION = vec3();
const START_BASIS = createGeographicBasis();
const END_BASIS = createGeographicBasis();
const START_GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};
const DIRECT_RESULT: DirectGeodesicResult = {
  latitude2Rad: 0,
  longitude2Rad: 0,
  forwardAzimuth2Rad: 0,
};

export function tangentFromCourse(
  latitudeRad: number,
  longitudeRad: number,
  courseRad: number,
  out: Vec3d,
): Vec3d {
  geographicBasisFromGeodetic(latitudeRad, longitudeRad, COURSE_BASIS);
  const sinCourse = Math.sin(courseRad);
  const cosCourse = Math.cos(courseRad);
  out.x =
    COURSE_BASIS.north.x * cosCourse + COURSE_BASIS.east.x * sinCourse;
  out.y =
    COURSE_BASIS.north.y * cosCourse + COURSE_BASIS.east.y * sinCourse;
  out.z =
    COURSE_BASIS.north.z * cosCourse + COURSE_BASIS.east.z * sinCourse;
  return normalizeVec3(out, out, 'course tangent');
}

const COURSE_BASIS = createGeographicBasis();
