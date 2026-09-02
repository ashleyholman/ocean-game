import type { Vec3d } from './math';

export interface SurfaceFrameEcef {
  /** Tangent axis mapped to Three.js +X. */
  right: Vec3d;
  /** Tangent axis mapped to Three.js -Z. */
  forward: Vec3d;
  /** Outward WGS84 ellipsoid normal, mapped to Three.js +Y. */
  up: Vec3d;
}

/**
 * Canonical global state. Latitude, longitude, course, local position, solar
 * time, and render orientation are derived views. The clock fields share this
 * serialisable record, but their rate/pause controls affect astronomy only;
 * velocity is an actual m/s value while PlanetaryWorld applies its separate
 * voyage-time compression only when advancing ECEF position.
 */
export interface CanonicalWorldState {
  worldInstantUtcSeconds: number;
  worldSecondsPerRealSecond: number;
  paused: boolean;
  positionEcefM: Vec3d;
  velocityEcefMps: Vec3d;
  surfaceFrameEcef: SurfaceFrameEcef;
}

export interface CanonicalWorldSnapshotV1 {
  version: 1;
  worldInstantUtcSeconds: number;
  worldSecondsPerRealSecond: number;
  paused: boolean;
  positionEcefM: readonly [number, number, number];
  velocityEcefMps: readonly [number, number, number];
  surfaceFrameEcef: {
    right: readonly [number, number, number];
    forward: readonly [number, number, number];
    up: readonly [number, number, number];
  };
}

export interface NavigationTelemetry {
  latitudeRad: number;
  longitudeRad: number;
  heightM: number;
  speedOverGroundMps: number;
  /** Clockwise from true north; null at negligible speed or a pole. */
  trueCourseRad: number | null;
  courseUnavailableReason: 'stationary' | 'pole' | null;
}
