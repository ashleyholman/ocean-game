import { tangentFromCourse } from '../world/geodesic';
import { dotVec3, vec3 } from '../world/math';
import type { CanonicalWorldState } from '../world/types';
import {
  createGeographicBasis,
  ecefToGeodetic,
  geographicBasisFromGeodetic,
  type GeodeticCoordinates,
} from '../world/wgs84';

/** Vessel horizontal velocity in the local render/wave frame. */
export interface HorizontalVelocity {
  x: number;
  z: number;
}

export interface MutableHorizontalVelocity extends HorizontalVelocity {
  x: number;
  z: number;
}

export type HorizontalDynamicsMode = 'free' | 'captive-tow';

/**
 * Scene/world bridge used by a vessel's fixed horizontal integrator.
 *
 * The mutable encounter velocity is passed separately through
 * `VesselPhysicsContext`; this object carries only controls and the canonical
 * commit. The commit receives render-frame values (+X right, +Z model aft).
 */
export interface VesselHorizontalDynamicsBridge {
  mode: HorizontalDynamicsMode;
  readonly towVelocityWorldMps: MutableHorizontalVelocity;
  towYawRad: number;
  commitStep(
    physicsDeltaSeconds: number,
    encounterDisplacementX: number,
    encounterDisplacementZ: number,
    endVelocityX: number,
    endVelocityZ: number,
    endYawRad: number,
    endYawRateRadPerSecond: number,
  ): void;
}

/** Developer-panel contract. It issues controls; it does not own motion state. */
export interface VesselMotionDebugControls {
  actualSpeedMps(): number;
  targetSpeedMps(): number;
  isPrescribedSpeed(): boolean;
  increaseSpeed(): void;
  decreaseSpeed(): void;
  stop(): void;
  releaseTow(): void;
  trueHeadingRad(): number;
  setTrueHeadingRad(headingRad: number): void;
}

/**
 * One optional captive-tow target layered over the legacy diagnostic speed.
 *
 * In the production schooner, a selected value constrains the tow and clearing
 * it releases passive dynamics. The legacy callback remains for the opt-in raft
 * and old diagnostic paths; it is not a sail force. Canonical ECEF velocity
 * remains the single stored velocity in either mode.
 */
export class VesselSpeedTarget {
  private prescribedSpeedMps: number | null = null;

  constructor(private readonly legacyTarget: () => number) {}

  get targetSpeedMps(): number {
    const value = this.prescribedSpeedMps ?? this.legacyTarget();
    assertSpeed(value);
    return value;
  }

  get isPrescribed(): boolean {
    return this.prescribedSpeedMps !== null;
  }

  prescribe(speedMps: number): void {
    assertSpeed(speedMps);
    this.prescribedSpeedMps = speedMps;
  }

  resumeLegacy(): void {
    this.prescribedSpeedMps = null;
  }
}

/**
 * Resolve canonical speed onto the horizontal presentation course.
 *
 * Until a current field exists, speed over ground and speed through water are
 * intentionally the same number. This conversion creates no second velocity;
 * it is the per-step local view consumed by encounter physics and effects.
 */
export function resolveEncounterVelocity(
  presentationDirection: Readonly<HorizontalVelocity>,
  speedThroughWaterMps: number,
  out: MutableHorizontalVelocity,
): MutableHorizontalVelocity {
  assertSpeed(speedThroughWaterMps);
  if (speedThroughWaterMps === 0) {
    out.x = 0;
    out.z = 0;
    return out;
  }

  const length = Math.hypot(
    presentationDirection.x,
    presentationDirection.z,
  );
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new RangeError('presentation course must have a finite horizontal direction');
  }
  const scale = speedThroughWaterMps / length;
  out.x = presentationDirection.x * scale;
  out.z = presentationDirection.z * scale;
  return out;
}

/**
 * Project canonical ECEF velocity into the local render/wave frame.
 *
 * Unlike `resolveEncounterVelocity`, this retains both tangent components, so
 * a dynamically sideslipping vessel is not collapsed back onto its course.
 */
export function resolveCanonicalHorizontalVelocity(
  state: Readonly<CanonicalWorldState>,
  out: MutableHorizontalVelocity,
): MutableHorizontalVelocity {
  out.x = dotVec3(state.velocityEcefMps, state.surfaceFrameEcef.right);
  out.z = -dotVec3(state.velocityEcefMps, state.surfaceFrameEcef.forward);
  if (!Number.isFinite(out.x) || !Number.isFinite(out.z)) {
    throw new RangeError('canonical velocity did not project to finite horizontal components');
  }
  return out;
}

/**
 * Project a commanded true heading into the transported local render frame.
 *
 * Heading belongs to the vessel and remains meaningful while stationary;
 * course over ground belongs to the velocity vector and does not. Keeping this
 * projection independent from velocity lets a stopped vessel turn without
 * inventing a tiny movement merely to preserve its bow direction.
 */
export function resolveTrueHeadingDirection(
  state: Readonly<CanonicalWorldState>,
  trueHeadingRad: number,
  out: MutableHorizontalVelocity,
): MutableHorizontalVelocity {
  if (!Number.isFinite(trueHeadingRad)) {
    throw new RangeError(`true heading must be finite, got ${trueHeadingRad}`);
  }
  ecefToGeodetic(state.positionEcefM, HEADING_GEODETIC);
  tangentFromCourse(
    HEADING_GEODETIC.latitudeRad,
    HEADING_GEODETIC.longitudeRad,
    trueHeadingRad,
    HEADING_ECEF,
  );
  out.x = dotVec3(HEADING_ECEF, state.surfaceFrameEcef.right);
  out.z = -dotVec3(HEADING_ECEF, state.surfaceFrameEcef.forward);
  const length = Math.hypot(out.x, out.z);
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new RangeError('true heading did not project to a finite horizontal direction');
  }
  out.x /= length;
  out.z /= length;
  return out;
}

/** Local +z is the bow, so this yaw points it along the supplied velocity. */
export function modelYawForVelocity(
  velocity: Readonly<HorizontalVelocity>,
  stationaryYaw: number,
): number {
  if (Math.hypot(velocity.x, velocity.z) <= 1e-12) return stationaryYaw;
  return Math.atan2(velocity.x, velocity.z);
}

/** Convert the schooner's model yaw in the transported frame to true heading. */
export function trueHeadingForModelYaw(
  state: Readonly<CanonicalWorldState>,
  modelYawRad: number,
): number {
  if (!Number.isFinite(modelYawRad)) {
    throw new RangeError(`model yaw must be finite, got ${modelYawRad}`);
  }
  ecefToGeodetic(state.positionEcefM, HEADING_GEODETIC);
  geographicBasisFromGeodetic(
    HEADING_GEODETIC.latitudeRad,
    HEADING_GEODETIC.longitudeRad,
    HEADING_BASIS,
  );

  // Model +Z is the bow. Ry(yaw) maps it to render
  // (+sin(yaw), +cos(yaw)); render +Z is transported-frame -forward.
  const renderX = Math.sin(modelYawRad);
  const renderZ = Math.cos(modelYawRad);
  HEADING_ECEF.x =
    state.surfaceFrameEcef.right.x * renderX -
    state.surfaceFrameEcef.forward.x * renderZ;
  HEADING_ECEF.y =
    state.surfaceFrameEcef.right.y * renderX -
    state.surfaceFrameEcef.forward.y * renderZ;
  HEADING_ECEF.z =
    state.surfaceFrameEcef.right.z * renderX -
    state.surfaceFrameEcef.forward.z * renderZ;

  let heading = Math.atan2(
    dotVec3(HEADING_ECEF, HEADING_BASIS.east),
    dotVec3(HEADING_ECEF, HEADING_BASIS.north),
  );
  if (heading < 0) heading += 2 * Math.PI;
  return heading;
}

function assertSpeed(speedMps: number): void {
  if (!Number.isFinite(speedMps) || speedMps < 0) {
    throw new RangeError(`speed must be finite and non-negative, got ${speedMps}`);
  }
}

const HEADING_ECEF = vec3();
const HEADING_BASIS = createGeographicBasis();
const HEADING_GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};
