import * as THREE from 'three';
import {
  CINEMATIC_DEFAULT_SCALE,
  ELEVATION_MAX,
  attackRelease,
  cinematicAimOffset,
  cinematicDistance,
  cinematicElevation,
  cinematicFov,
  cinematicHorizonFraction,
  clamp,
  clamp01,
  horizonFraction,
  waterClearance,
} from './cameraTuning';
import type { CameraContext, CameraPose, VesselAnchor } from './types';

/**
 * The multi-scale external camera.
 *
 * This is a tripod in world space, not a camera attached to the ship. Its
 * orientation changes only in response to player input or a mode transition.
 * Pitch, roll, heave and yaw from the vessel never enter the camera quaternion,
 * so a star cannot move merely because a wave passed under the hull.
 *
 * There are two deliberately separate vertical rules:
 *
 * 1. The assembled vessel's neutral bounds choose one constant vertical offset.
 *    That offset is reused at every distance, so zoom follows exactly one line.
 * 2. Wave safety is upward-only. It can keep the lens out of an exceptional
 *    crest, but it can never pull a deliberately high vessel track downward.
 *
 * Neither rule rotates the camera. Water clearance used to raise the orbit
 * elevation, and the old idle drift changed azimuth after twenty seconds; both
 * moved the sky even when the vessel was safely framed. They do not exist here.
 */

const DEG = Math.PI / 180;

/** Neutral ship silhouette target. It is composition, not a live-wave leash. */
export const NEUTRAL_VESSEL_FRAME_TOP = 0.08;
export const NEUTRAL_VESSEL_FRAME_BOTTOM = 0.92;

/** Highest safe screen position for the live waterline, used only as a guard. */
export const VESSEL_FRAME_GUARD_TOP = 0.1;

const FLOOR_ATTACK_TAU = 0.35;
const FLOOR_RELEASE_TAU = 20;
const MAX_SOLVE_EXPANSIONS = 16;
const SOLVE_ITERATIONS = 28;

/** The part of the composition a mode switch has to bring back intact. */
export interface CinematicFraming {
  azimuth: number;
  elevationOffset: number;
  scale: number;
}

interface FrameBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface FramePosition {
  x: number;
  y: number;
}

export class CinematicCameraController {
  readonly pose: CameraPose = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: 48,
    near: 0.5,
  };

  /** Direction from the vessel to the camera, radians. */
  private azimuth = 132 * DEG;
  private elevationOffset = 0;
  private scale = CINEMATIC_DEFAULT_SCALE;

  private azVelocity = 0;
  private elVelocity = 0;

  // Spring-damped follow of horizontal render-origin motion. Production is zero.
  private followX = 0;
  private followZ = 0;
  private followVX = 0;
  private followVZ = 0;
  private followInitialised = false;

  /** Crest envelope under the camera, relative to the vessel's waterline. */
  private floorRise = 0;
  private floorInitialised = false;

  private aspect = 1.6;
  private tanHalfFov = Math.tan(24 * DEG);

  private measuredDistance = 36;
  private measuredHorizontalDistance = 35;
  private measuredAltitude = 10;
  private measuredElevation = 11 * DEG;
  private measuredPitch = 8.6 * DEG;
  private measuredVerticalCorrection = 0;
  private measuredFrameLeft = 0.5;
  private measuredFrameRight = 0.5;
  private measuredFrameTop = 0.5;
  private measuredFrameBottom = 0.5;
  private measuredWaterlineFrame = 0.55;

  // Solved once per vessel / orbit / viewport composition at one stable
  // dimension-aware reference view, then held over the entire zoom range.
  private trackCacheFraming: VesselAnchor['framing'] | undefined;
  private trackCacheAspect = NaN;
  private trackCacheQuaternionX = NaN;
  private trackCacheQuaternionY = NaN;
  private trackCacheQuaternionZ = NaN;
  private trackCacheQuaternionW = NaN;
  private trackCacheDesignWaterlineY = NaN;
  private trackCacheLift = 0;

  private vessel: VesselAnchor | undefined;
  private readonly aim = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly basis = new THREE.Matrix4();
  private readonly inverseQuaternion = new THREE.Quaternion();
  private readonly scratchPoint = new THREE.Vector3();
  private readonly frameScratch: FramePosition = { x: 0.5, y: 0.5 };
  private readonly boundsScratch: FrameBounds = {
    left: 0.5,
    right: 0.5,
    top: 0.5,
    bottom: 0.5,
  };

  constructor() {
    this.setViewport(1.6);
  }

  get framing(): CinematicFraming {
    return {
      azimuth: this.azimuth,
      elevationOffset: this.elevationOffset,
      scale: this.scale,
    };
  }

  set framing(value: CinematicFraming) {
    this.azimuth = value.azimuth;
    this.elevationOffset = value.elevationOffset;
    this.scale = clamp01(value.scale);
    this.azVelocity = 0;
    this.elVelocity = 0;
  }

  get cinematicScale(): number {
    return this.scale;
  }

  /** Authored scale distance, metres. A safety lift does not alter zoom. */
  get distance(): number {
    return this.measuredDistance;
  }

  /** Camera height above the vessel's live waterline, metres. */
  get altitude(): number {
    return this.measuredAltitude;
  }

  get horizontalDistance(): number {
    return this.measuredHorizontalDistance;
  }

  /** Player-authored orbit elevation. Live safety never changes it. */
  get orbitElevation(): number {
    return this.measuredElevation;
  }

  /** Downward tilt of the forward axis, radians. */
  get opticalPitch(): number {
    return this.measuredPitch;
  }

  /** Where the horizon lands, as a fraction of frame height from the top. */
  get horizonPlacement(): number {
    return horizonFraction(this.measuredPitch, this.tanHalfFov);
  }

  /** Live Y-only correction away from the neutral tripod position, metres. */
  get verticalCorrection(): number {
    return this.measuredVerticalCorrection;
  }

  /** True when neither water clearance nor the framing guard is moving the rig. */
  get tripodLocked(): boolean {
    return Math.abs(this.measuredVerticalCorrection) < 1e-7;
  }

  get vesselFrameTop(): number {
    return this.measuredFrameTop;
  }

  get vesselFrameBottom(): number {
    return this.measuredFrameBottom;
  }

  get vesselFrameLeft(): number {
    return this.measuredFrameLeft;
  }

  get vesselFrameRight(): number {
    return this.measuredFrameRight;
  }

  get waterlineFramePosition(): number {
    return this.measuredWaterlineFrame;
  }

  get orbitAzimuth(): number {
    return this.azimuth;
  }

  /** Point the orbit at an absolute bearing and stop input inertia. */
  setAzimuth(radians: number): void {
    this.azimuth = radians;
    this.azVelocity = 0;
  }

  setViewport(aspect: number): void {
    const safeAspect = Number.isFinite(aspect) ? Math.max(aspect, 1e-3) : 1;
    this.aspect = safeAspect;
    const fov = cinematicFov(safeAspect);
    this.tanHalfFov = Math.tan(fov / 2);
    this.pose.fov = fov / DEG;
  }

  /** Orbit input, radians. Azimuth is free; elevation is clamped on use. */
  orbit(deltaAzimuth: number, deltaElevation: number): void {
    this.azimuth += deltaAzimuth;
    this.elevationOffset += deltaElevation;
    this.azVelocity = deltaAzimuth * 8;
    this.elVelocity = deltaElevation * 8;
  }

  scaleBy(delta: number): void {
    this.scale = clamp01(this.scale + delta);
  }

  setScale(value: number): void {
    this.scale = clamp01(value);
  }

  /** Set the scale that produces a given slant distance. Used by the panel. */
  setDistance(metres: number): void {
    const target = Math.max(metres, 1e-3);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (cinematicDistance(mid) < target) lo = mid;
      else hi = mid;
    }
    this.scale = clamp01((lo + hi) / 2);
  }

  /** Aim for a specific authored altitude at the current scale. */
  setAltitude(metres: number): void {
    const distance = cinematicDistance(this.scale);
    const wanted = Math.asin(clamp(metres / Math.max(distance, 1e-3), -1, 1));
    this.elevationOffset = wanted - cinematicElevation();
  }

  /** Turn the orbit so it backs away along a world orientation. */
  adoptWorldBearing(worldQuaternion: THREE.Quaternion): void {
    this.forward.set(0, 0, -1).applyQuaternion(worldQuaternion);
    if (Math.hypot(this.forward.x, this.forward.z) < 1e-3) return;
    this.azimuth = Math.PI - Math.atan2(-this.forward.x, -this.forward.z);
    this.azVelocity = 0;
    this.elVelocity = 0;
  }

  /** Return to the authored default composition. */
  reset(): void {
    this.azimuth = 132 * DEG;
    this.elevationOffset = 0;
    this.scale = CINEMATIC_DEFAULT_SCALE;
    this.azVelocity = 0;
    this.elVelocity = 0;
    this.followInitialised = false;
    this.followVX = 0;
    this.followVZ = 0;
    this.floorRise = 0;
    this.floorInitialised = false;
    this.trackCacheFraming = undefined;
  }

  update(context: CameraContext): CameraPose {
    const dt = Math.max(context.dt, 0);

    // Input inertia is the only autonomous motion, and exists only immediately
    // after an actual drag. An untouched camera has no timer and no drift path.
    if (Math.abs(this.azVelocity) > 1e-5 || Math.abs(this.elVelocity) > 1e-5) {
      this.azimuth += this.azVelocity * dt;
      this.elevationOffset += this.elVelocity * dt;
      const decay = Math.exp(-dt / 0.25);
      this.azVelocity *= decay;
      this.elVelocity *= decay;
    }

    const vessel = context.vessel;
    this.vessel = vessel;

    // Horizontal render-origin following is independent of attitude and heave.
    if (!this.followInitialised) {
      this.followX = vessel.x;
      this.followZ = vessel.z;
      this.followInitialised = true;
    }
    const step = Math.min(dt, 1 / 30);
    const omega = 1.6;
    const f = 1 + 2 * step * omega;
    const oo = omega * omega;
    const hoo = step * oo;
    const hhoo = step * hoo;
    const inv = 1 / (f + hhoo);
    const nx = (f * this.followX + step * this.followVX + hhoo * vessel.x) * inv;
    this.followVX = (this.followVX + hoo * (vessel.x - this.followX)) * inv;
    this.followX = nx;
    const nz = (f * this.followZ + step * this.followVZ + hhoo * vessel.z) * inv;
    this.followVZ = (this.followVZ + hoo * (vessel.z - this.followZ)) * inv;
    this.followZ = nz;

    const distance = cinematicDistance(this.scale);
    const horizonTarget = clamp(cinematicHorizonFraction(this.aspect), 0.02, 0.9);
    const defaultElevation = cinematicElevation();
    const aimOffset = cinematicAimOffset(horizonTarget, this.tanHalfFov);
    const rawElevation = defaultElevation + this.elevationOffset;
    const elevation = clamp(rawElevation, -0.5, ELEVATION_MAX);
    this.elevationOffset += elevation - rawElevation;

    const cosEl = Math.cos(elevation);
    const sinEl = Math.sin(elevation);
    const horizontal = distance * cosEl;
    const position = this.pose.position;
    position.x = this.followX + Math.sin(this.azimuth) * horizontal;
    position.z = this.followZ - Math.cos(this.azimuth) * horizontal;

    // Orientation is solved before Y because it is authored and independent of
    // every vertical safety decision below.
    const opticalPitch = clamp(elevation - aimOffset, -20 * DEG, 89 * DEG);
    const cosPitch = Math.cos(opticalPitch);
    position.y = 0;
    this.aim.set(
      position.x - Math.sin(this.azimuth) * cosPitch,
      -Math.sin(opticalPitch),
      position.z + Math.cos(this.azimuth) * cosPitch,
    );
    this.basis.lookAt(position, this.aim, this.up);
    this.pose.quaternion.setFromRotationMatrix(this.basis);
    this.inverseQuaternion.copy(this.pose.quaternion).invert();

    // One straight track. The offset is vessel-specific but invariant in scale;
    // no fit state, blend or threshold can bend the path while zooming.
    const authoredY = sinEl * distance;
    const trackY = authoredY + this.neutralTrackLift(elevation);

    // Water clearance is a Y lift, never an orbit-elevation change. The sampled
    // height stays relative to the vessel so a long swell lifting both together
    // does not leave a twenty-second absolute crest envelope hanging in the sky.
    const surfaceRise =
      context.waterHeightAt(position.x, position.z) - vessel.waterlineY;
    this.floorRise = this.floorInitialised
      ? attackRelease(
          this.floorRise,
          surfaceRise,
          FLOOR_ATTACK_TAU,
          FLOOR_RELEASE_TAU,
          dt,
        )
      : surfaceRise;
    this.floorInitialised = true;
    const waterFloorY = vessel.waterlineY + this.floorRise + waterClearance(distance);
    let cameraY = Math.max(trackY, waterFloorY);

    // True screen-space dead zone. No percentage of heave is carried inside it.
    // Outside it, solve the exact perspective projection for the smallest Y move
    // that puts the waterline back on the nearest guard edge.
    let waterlineFrame = this.worldFrameFraction(
      vessel.x,
      vessel.waterlineY,
      vessel.z,
      cameraY,
    );
    if (waterlineFrame < VESSEL_FRAME_GUARD_TOP) {
      cameraY = this.solveWorldPointY(
        cameraY,
        VESSEL_FRAME_GUARD_TOP,
        1,
        vessel.x,
        vessel.waterlineY,
        vessel.z,
      );
    }

    position.y = cameraY;
    waterlineFrame = this.worldFrameFraction(
      vessel.x,
      vessel.waterlineY,
      vessel.z,
      cameraY,
    );
    const liveBounds = this.frameBoundsAt(cameraY, false, this.boundsScratch);

    const altitude = cameraY - vessel.waterlineY;
    this.pose.near = clamp(0.02 * Math.min(distance, Math.max(altitude, 0.1)), 0.25, 6);

    this.measuredDistance = distance;
    this.measuredHorizontalDistance = horizontal;
    this.measuredAltitude = altitude;
    this.measuredElevation = elevation;
    this.measuredPitch = opticalPitch;
    this.measuredVerticalCorrection = cameraY - trackY;
    this.measuredFrameLeft = liveBounds.left;
    this.measuredFrameRight = liveBounds.right;
    this.measuredFrameTop = liveBounds.top;
    this.measuredFrameBottom = liveBounds.bottom;
    this.measuredWaterlineFrame = waterlineFrame;

    return this.pose;
  }

  /** One constant vessel-specific lift, applied unchanged at every zoom scale. */
  private neutralTrackLift(elevation: number): number {
    const vessel = this.vessel;
    if (!vessel) return 0;
    const q = this.pose.quaternion;
    if (
      this.trackCacheFraming === vessel.framing &&
      this.trackCacheAspect === this.aspect &&
      this.trackCacheQuaternionX === q.x &&
      this.trackCacheQuaternionY === q.y &&
      this.trackCacheQuaternionZ === q.z &&
      this.trackCacheQuaternionW === q.w &&
      this.trackCacheDesignWaterlineY === vessel.designWaterlineY
    ) {
      return this.trackCacheLift;
    }

    // Solve at one stable reference view, never at the user's current scale.
    // Very long future vessels move that reference far enough outside their own
    // depth envelope, but the resulting lift is still one constant number.
    const referenceDistance = Math.max(
      cinematicDistance(CINEMATIC_DEFAULT_SCALE),
      vessel.framing.radiusM * 2.5,
    );
    const referenceHorizontal = referenceDistance * Math.cos(elevation);
    const referenceY = referenceDistance * Math.sin(elevation);
    const currentX = this.pose.position.x;
    const currentZ = this.pose.position.z;
    this.pose.position.x =
      vessel.x + Math.sin(this.azimuth) * referenceHorizontal;
    this.pose.position.z =
      vessel.z - Math.cos(this.azimuth) * referenceHorizontal;

    let lift = 0;
    try {
      const deficit = this.neutralFramingDeficit(referenceY);
      const solvedY = Number.isFinite(deficit) && deficit < 0
        ? this.solveNeutralFramingY(referenceY, referenceDistance)
        : referenceY;
      lift = Math.max(0, solvedY - referenceY);
    } finally {
      this.pose.position.x = currentX;
      this.pose.position.z = currentZ;
    }

    this.trackCacheFraming = vessel.framing;
    this.trackCacheAspect = this.aspect;
    this.trackCacheQuaternionX = q.x;
    this.trackCacheQuaternionY = q.y;
    this.trackCacheQuaternionZ = q.z;
    this.trackCacheQuaternionW = q.w;
    this.trackCacheDesignWaterlineY = vessel.designWaterlineY;
    this.trackCacheLift = lift;
    return lift;
  }

  /**
   * Positive means the neutral silhouette is low enough in frame.
   *
   * If the reference silhouette exceeds the safe corridor, the target top
   * retreats by half the overflow. That centres its unavoidable crop without
   * introducing a second zoom regime: this value is solved at one distance.
   */
  private neutralFramingDeficit(cameraY: number): number {
    const bounds = this.frameBoundsAt(cameraY, true, this.boundsScratch);
    if (!Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) return NaN;
    const corridor = NEUTRAL_VESSEL_FRAME_BOTTOM - NEUTRAL_VESSEL_FRAME_TOP;
    const overflow = Math.max(0, bounds.bottom - bounds.top - corridor);
    const targetTop = NEUTRAL_VESSEL_FRAME_TOP - overflow * 0.5;
    return bounds.top - targetTop;
  }

  /** Numeric inverse of the continuous neutral-framing deficit. */
  private solveNeutralFramingY(startY: number, distance: number): number {
    let failing = startY;
    let passing = startY;
    let stride = Math.max(0.25, distance * 0.02);
    let passingSatisfied = false;
    for (let i = 0; i < MAX_SOLVE_EXPANSIONS; i++) {
      passing += stride;
      const value = this.neutralFramingDeficit(passing);
      passingSatisfied = Number.isFinite(value) && value >= 0;
      if (passingSatisfied) break;
      failing = passing;
      stride *= 2;
    }
    if (!passingSatisfied) return startY;

    for (let i = 0; i < SOLVE_ITERATIONS; i++) {
      const mid = (failing + passing) * 0.5;
      const value = this.neutralFramingDeficit(mid);
      if (Number.isFinite(value) && value >= 0) passing = mid;
      else failing = mid;
    }
    return passing;
  }

  /**
   * Project either neutral or live cached envelope corners.
   *
   * Neutral mode removes wave attitude and puts the designed waterline at zero.
   * Both paths use only eight cached points; neither asks a mesh for geometry.
   */
  private frameBoundsAt(
    cameraY: number,
    neutral: boolean,
    out: FrameBounds,
  ): FrameBounds {
    const vessel = this.vessel;
    if (!vessel || vessel.framing.points.length === 0) {
      out.left = 0.5;
      out.right = 0.5;
      out.top = 0.5;
      out.bottom = 0.5;
      return out;
    }

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const point of vessel.framing.points) {
      if (neutral) {
        this.scratchPoint.set(
          vessel.x + point.x,
          point.y - vessel.designWaterlineY,
          vessel.z + point.z,
        );
      } else {
        this.scratchPoint.copy(point).applyMatrix4(vessel.matrixWorld);
      }
      const frame = this.worldFramePosition(
        this.scratchPoint.x,
        this.scratchPoint.y,
        this.scratchPoint.z,
        cameraY,
        this.frameScratch,
      );
      left = Math.min(left, frame.x);
      right = Math.max(right, frame.x);
      top = Math.min(top, frame.y);
      bottom = Math.max(bottom, frame.y);
    }
    out.left = left;
    out.right = right;
    out.top = top;
    out.bottom = bottom;
    return out;
  }

  private solveWorldPointY(
    startY: number,
    target: number,
    direction: -1 | 1,
    x: number,
    y: number,
    z: number,
  ): number {
    const valueAtStart = this.worldFrameFraction(x, y, z, startY);
    if (direction > 0 ? valueAtStart >= target : valueAtStart <= target) return startY;

    let failing = startY;
    let passing = startY;
    let stride = Math.max(0.25, this.measuredDistance * 0.02);
    let passingSatisfied = false;
    for (let i = 0; i < MAX_SOLVE_EXPANSIONS; i++) {
      passing += direction * stride;
      const value = this.worldFrameFraction(x, y, z, passing);
      passingSatisfied = direction > 0 ? value >= target : value <= target;
      if (passingSatisfied) break;
      failing = passing;
      stride *= 2;
    }
    if (!passingSatisfied) return passing;

    for (let i = 0; i < SOLVE_ITERATIONS; i++) {
      const mid = (failing + passing) / 2;
      const value = this.worldFrameFraction(x, y, z, mid);
      const midSatisfied = direction > 0 ? value >= target : value <= target;
      if (midSatisfied) passing = mid;
      else failing = mid;
    }
    return passing;
  }

  private worldFrameFraction(x: number, y: number, z: number, cameraY: number): number {
    return this.worldFramePosition(
      x,
      y,
      z,
      cameraY,
      this.frameScratch,
    ).y;
  }

  private worldFramePosition(
    x: number,
    y: number,
    z: number,
    cameraY: number,
    out: FramePosition,
  ): FramePosition {
    this.scratchPoint
      .set(x - this.pose.position.x, y - cameraY, z - this.pose.position.z)
      .applyQuaternion(this.inverseQuaternion);
    const depth = -this.scratchPoint.z;
    if (depth <= 1e-4) {
      out.x = this.scratchPoint.x >= 0 ? Infinity : -Infinity;
      out.y = this.scratchPoint.y >= 0 ? -Infinity : Infinity;
      return out;
    }
    out.x =
      0.5 *
      (1 + this.scratchPoint.x / depth / (this.tanHalfFov * this.aspect));
    out.y = 0.5 * (1 - this.scratchPoint.y / depth / this.tanHalfFov);
    return out;
  }
}
