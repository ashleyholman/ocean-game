import type * as THREE from 'three';

/**
 * Immutable neutral-space dimensions published by an assembled vessel.
 *
 * The expensive part — walking the scene graph and asking three.js for every
 * mesh bound — happens once when the vessel is constructed. Camera updates
 * only read these eight box corners and the already-derived scalar dimensions.
 */
export interface VesselFramingEnvelope {
  /** Corners of the assembled vessel's vessel-local axis-aligned bounds. */
  readonly points: readonly THREE.Vector3[];
  readonly widthM: number;
  readonly heightM: number;
  readonly lengthM: number;
  /** Radius of the local bounds about their own centre. */
  readonly radiusM: number;
}

/**
 * Everything a camera controller is allowed to know about the world.
 *
 * Deliberately narrow. The camera is downstream of the canonical planetary
 * state and of the vessel's presentation pose: it reads them and it never writes
 * to them. Nothing in this interface offers a way to move the vessel, advance a
 * clock, or touch an ECEF coordinate, which is what makes the world-state
 * isolation invariant structural rather than a rule someone has to remember.
 */
export interface VesselAnchor {
  /** The vessel's full presentation transform, for exact attachment. */
  readonly matrixWorld: THREE.Matrix4;
  /** Presentation attitude, radians. Euler order YXZ, as the vessel group uses. */
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  /** Horizontal position in local render coordinates. Zero in production. */
  readonly x: number;
  readonly z: number;
  /** Mean water height under the vessel this frame, metres. */
  readonly waterlineY: number;
  /** Designed waterline above the vessel group's local origin, metres. */
  readonly designWaterlineY: number;
  /** One-time assembled dimensions, including hull, masts, spars and sails. */
  readonly framing: VesselFramingEnvelope;
}

export interface CameraContext {
  /** Presentation delta time, seconds. Never the accelerated world clock. */
  readonly dt: number;
  readonly vessel: VesselAnchor;
  /** Sea-surface height at a local horizontal position, metres. */
  waterHeightAt(x: number, z: number): number;
}

/**
 * A complete camera state.
 *
 * Controllers write one of these; the mode manager is the only thing that
 * copies it onto the actual three.js camera. That is what keeps "one active
 * camera" true by construction — a controller cannot render itself.
 */
export interface CameraPose {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Vertical field of view, degrees. */
  fov: number;
  near: number;
}
