import {
  addScaledVec3,
  crossVec3,
  dotVec3,
  normalizeVec3,
  scaleVec3,
  vec3,
  type Vec3d,
} from './math';
import type { SurfaceFrameEcef } from './types';

/**
 * Exact Levi-Civita transport along a geodesic segment.
 *
 * [T×U, T, U] is an orthonormal path basis at each endpoint. Mapping the start
 * basis to the end basis preserves a carried vector's path-basis coefficients
 * without finite-step normal-rotation error.
 */
export function transportFrameAlongGeodesic(
  frame: SurfaceFrameEcef,
  startTangentUnit: Readonly<Vec3d>,
  startUpUnit: Readonly<Vec3d>,
  endTangentUnit: Readonly<Vec3d>,
  endUpUnit: Readonly<Vec3d>,
): void {
  crossVec3(START_PERP, startTangentUnit, startUpUnit);
  normalizeVec3(START_PERP, START_PERP, 'start geodesic perpendicular');
  crossVec3(END_PERP, endTangentUnit, endUpUnit);
  normalizeVec3(END_PERP, END_PERP, 'end geodesic perpendicular');

  const pathPerpCoefficient = dotVec3(frame.right, START_PERP);
  const pathTangentCoefficient = dotVec3(frame.right, startTangentUnit);
  const normalCoefficient = dotVec3(frame.right, startUpUnit);

  scaleVec3(TRANSPORTED_RIGHT, END_PERP, pathPerpCoefficient);
  addScaledVec3(
    TRANSPORTED_RIGHT,
    TRANSPORTED_RIGHT,
    endTangentUnit,
    pathTangentCoefficient,
  );
  addScaledVec3(
    TRANSPORTED_RIGHT,
    TRANSPORTED_RIGHT,
    endUpUnit,
    normalCoefficient,
  );

  // Remove only round-off leakage; the exact mapping is already tangent.
  addScaledVec3(
    TRANSPORTED_RIGHT,
    TRANSPORTED_RIGHT,
    endUpUnit,
    -dotVec3(TRANSPORTED_RIGHT, endUpUnit),
  );
  normalizeVec3(frame.right, TRANSPORTED_RIGHT, 'transported right axis');
  normalizeVec3(frame.up, endUpUnit, 'endpoint up axis');
  crossVec3(frame.forward, frame.up, frame.right);
  normalizeVec3(frame.forward, frame.forward, 'transported forward axis');
}

const START_PERP = vec3();
const END_PERP = vec3();
const TRANSPORTED_RIGHT = vec3();
