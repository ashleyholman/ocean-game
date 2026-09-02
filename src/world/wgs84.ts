import {
  assertFiniteNumber,
  dotVec3,
  isFiniteVec3,
  normalizeVec3,
  setVec3,
  vec3,
  type Vec3d,
} from './math';
import type { SurfaceFrameEcef } from './types';

export const WGS84_SEMI_MAJOR_M = 6378137;
export const WGS84_INVERSE_FLATTENING = 298.257223563;
export const WGS84_FLATTENING = 1 / WGS84_INVERSE_FLATTENING;
export const WGS84_SEMI_MINOR_M = WGS84_SEMI_MAJOR_M * (1 - WGS84_FLATTENING);
export const WGS84_ECCENTRICITY_SQUARED =
  WGS84_FLATTENING * (2 - WGS84_FLATTENING);

const A2 = WGS84_SEMI_MAJOR_M * WGS84_SEMI_MAJOR_M;
const B2 = WGS84_SEMI_MINOR_M * WGS84_SEMI_MINOR_M;
/** Below this distance from the rotation axis, longitude is a gauge. */
export const WGS84_POLE_AXIS_EPSILON_M =
  64 * Number.EPSILON * WGS84_SEMI_MAJOR_M;

export interface GeodeticCoordinates {
  latitudeRad: number;
  longitudeRad: number;
  heightM: number;
}

export interface GeographicBasis {
  east: Vec3d;
  north: Vec3d;
  up: Vec3d;
}

export function wrapLongitudeRad(longitudeRad: number): number {
  assertFiniteNumber(longitudeRad, 'longitudeRad');
  let wrapped = (longitudeRad + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  wrapped -= Math.PI;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export function circularAngleDifferenceRad(aRad: number, bRad: number): number {
  return wrapLongitudeRad(aRad - bRad);
}

export function geodeticToEcef(
  latitudeRad: number,
  longitudeRad: number,
  heightM: number,
  out: Vec3d,
): Vec3d {
  assertFiniteNumber(latitudeRad, 'latitudeRad');
  assertFiniteNumber(longitudeRad, 'longitudeRad');
  assertFiniteNumber(heightM, 'heightM');
  if (latitudeRad < -Math.PI / 2 || latitudeRad > Math.PI / 2) {
    throw new RangeError('latitudeRad must be in [-pi/2, pi/2]');
  }

  // An exact pole has no longitude. Snapping the axis makes the documented
  // longitude-zero gauge deterministic after serialization.
  if (Math.abs(Math.abs(latitudeRad) - Math.PI / 2) <= 4 * Number.EPSILON) {
    return setVec3(
      out,
      0,
      0,
      Math.sign(latitudeRad || 1) * (WGS84_SEMI_MINOR_M + heightM),
    );
  }

  const longitude = wrapLongitudeRad(longitudeRad);
  const sinLatitude = Math.sin(latitudeRad);
  const cosLatitude = Math.cos(latitudeRad);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const primeVerticalRadiusM =
    WGS84_SEMI_MAJOR_M /
    Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);

  out.x = (primeVerticalRadiusM + heightM) * cosLatitude * cosLongitude;
  out.y = (primeVerticalRadiusM + heightM) * cosLatitude * sinLongitude;
  out.z =
    (primeVerticalRadiusM * (1 - WGS84_ECCENTRICITY_SQUARED) + heightM) *
    sinLatitude;
  return out;
}

/**
 * EPSG/Bowring-style inverse with fixed-point refinement. The height formula
 * is stable at every latitude and avoids division by a vanishing cosine.
 */
export function ecefToGeodetic(
  positionEcefM: Readonly<Vec3d>,
  out: GeodeticCoordinates,
): GeodeticCoordinates {
  if (!isFiniteVec3(positionEcefM)) {
    throw new RangeError('positionEcefM must be finite');
  }
  const { x, y, z } = positionEcefM;
  const p = Math.hypot(x, y);
  if (p <= WGS84_POLE_AXIS_EPSILON_M) {
    if (Math.abs(z) <= WGS84_POLE_AXIS_EPSILON_M) {
      throw new RangeError('ECEF origin has no geodetic coordinates');
    }
    out.latitudeRad = Math.sign(z) * (Math.PI / 2);
    out.longitudeRad = 0;
    out.heightM = Math.abs(z) - WGS84_SEMI_MINOR_M;
    return out;
  }

  const longitudeRad = wrapLongitudeRad(Math.atan2(y, x));
  let latitudeRad = Math.atan2(
    z,
    p * (1 - WGS84_ECCENTRICITY_SQUARED),
  );

  for (let iteration = 0; iteration < 12; iteration++) {
    const sinLatitude = Math.sin(latitudeRad);
    const primeVerticalRadiusM =
      WGS84_SEMI_MAJOR_M /
      Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);
    const nextLatitudeRad = Math.atan2(
      z + WGS84_ECCENTRICITY_SQUARED * primeVerticalRadiusM * sinLatitude,
      p,
    );
    if (Math.abs(nextLatitudeRad - latitudeRad) <= 2 * Number.EPSILON) {
      latitudeRad = nextLatitudeRad;
      break;
    }
    latitudeRad = nextLatitudeRad;
  }

  const sinLatitude = Math.sin(latitudeRad);
  const cosLatitude = Math.cos(latitudeRad);
  const primeVerticalRadiusM =
    WGS84_SEMI_MAJOR_M /
    Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude);

  out.latitudeRad = latitudeRad;
  out.longitudeRad = longitudeRad;
  out.heightM =
    p * cosLatitude +
    z * sinLatitude -
    A2 / primeVerticalRadiusM;
  return out;
}

/** Outward WGS84 ellipsoid normal, not the geocentric radial direction. */
export function surfaceNormalEcef(
  positionEcefM: Readonly<Vec3d>,
  out: Vec3d,
): Vec3d {
  if (!isFiniteVec3(positionEcefM)) {
    throw new RangeError('positionEcefM must be finite');
  }
  setVec3(
    out,
    positionEcefM.x / A2,
    positionEcefM.y / A2,
    positionEcefM.z / B2,
  );
  return normalizeVec3(out, out, 'WGS84 surface normal');
}

export function geographicBasisFromGeodetic(
  latitudeRad: number,
  longitudeRad: number,
  out: GeographicBasis,
): GeographicBasis {
  assertFiniteNumber(latitudeRad, 'latitudeRad');
  assertFiniteNumber(longitudeRad, 'longitudeRad');
  const rawCosLatitude = Math.cos(latitudeRad);
  const atPole = Math.abs(rawCosLatitude) <= 8 * Number.EPSILON;
  const longitude =
    atPole
      ? 0
      : wrapLongitudeRad(longitudeRad);
  const sinLatitude = atPole
    ? Math.sign(latitudeRad || 1)
    : Math.sin(latitudeRad);
  const cosLatitude = atPole ? 0 : rawCosLatitude;
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);

  setVec3(
    out.east,
    canonicalZero(-sinLongitude),
    canonicalZero(cosLongitude),
    0,
  );
  setVec3(
    out.north,
    canonicalZero(-sinLatitude * cosLongitude),
    canonicalZero(-sinLatitude * sinLongitude),
    canonicalZero(cosLatitude),
  );
  setVec3(
    out.up,
    canonicalZero(cosLatitude * cosLongitude),
    canonicalZero(cosLatitude * sinLongitude),
    canonicalZero(sinLatitude),
  );
  return out;
}

export function createGeographicBasis(): GeographicBasis {
  return { east: vec3(), north: vec3(), up: vec3() };
}

export function initialiseSurfaceFrame(
  latitudeRad: number,
  longitudeRad: number,
  out: SurfaceFrameEcef,
): SurfaceFrameEcef {
  const basis = geographicBasisFromGeodetic(
    latitudeRad,
    longitudeRad,
    TEMP_BASIS,
  );
  setVec3(out.right, basis.east.x, basis.east.y, basis.east.z);
  setVec3(out.forward, basis.north.x, basis.north.y, basis.north.z);
  setVec3(out.up, basis.up.x, basis.up.y, basis.up.z);
  return out;
}

export function createSurfaceFrame(): SurfaceFrameEcef {
  return { right: vec3(), forward: vec3(), up: vec3() };
}

export function ellipsoidEquationResidual(positionEcefM: Readonly<Vec3d>): number {
  return (
    (positionEcefM.x * positionEcefM.x + positionEcefM.y * positionEcefM.y) /
      A2 +
    (positionEcefM.z * positionEcefM.z) / B2 -
    1
  );
}

export function frameMaximumResidual(frame: Readonly<SurfaceFrameEcef>): number {
  const handedX =
    frame.right.y * frame.forward.z -
    frame.right.z * frame.forward.y;
  const handedY =
    frame.right.z * frame.forward.x -
    frame.right.x * frame.forward.z;
  const handedZ =
    frame.right.x * frame.forward.y -
    frame.right.y * frame.forward.x;
  return Math.max(
    Math.abs(dotVec3(frame.right, frame.right) - 1),
    Math.abs(dotVec3(frame.forward, frame.forward) - 1),
    Math.abs(dotVec3(frame.up, frame.up) - 1),
    Math.abs(dotVec3(frame.right, frame.forward)),
    Math.abs(dotVec3(frame.right, frame.up)),
    Math.abs(dotVec3(frame.forward, frame.up)),
    Math.hypot(
      handedX - frame.up.x,
      handedY - frame.up.y,
      handedZ - frame.up.z,
    ),
  );
}

const TEMP_BASIS = createGeographicBasis();

function canonicalZero(value: number): number {
  return value === 0 ? 0 : value;
}
