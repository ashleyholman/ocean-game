import * as THREE from 'three';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type LabCamerasCapability = SimCapability<
  'cameras' | 'vessel' | 'wind'
>;

/**
 * Diagnostic camera presets.
 *
 * These exist to *expose* the water contact line, not to flatter it. None of
 * them inherits raft heave, pitch or roll: they are anchored to the raft's
 * horizontal position and to the water surface, both of which are world
 * quantities visible in the same frame. If the raft rides high, you see it ride
 * high, because the water — not the raft — sets the vertical reference.
 *
 * `FIXED_WORLD_CAMERA` is anchored to nothing at all and never moves, which is
 * how vertical response and phase are read off directly over time.
 */

export type LabCameraName =
  | 'PRODUCTION'
  | 'PORT_WATERLINE'
  | 'STARBOARD_WATERLINE'
  | 'BOW_WATERLINE'
  | 'STERN_WATERLINE'
  | 'HIGH_THREE_QUARTER'
  | 'DIAGNOSTIC_ORTHOGRAPHIC_SIDE'
  | 'FIXED_WORLD_CAMERA';

export const LAB_CAMERA_NAMES: readonly LabCameraName[] = [
  'PRODUCTION',
  'PORT_WATERLINE',
  'STARBOARD_WATERLINE',
  'BOW_WATERLINE',
  'STERN_WATERLINE',
  'HIGH_THREE_QUARTER',
  'DIAGNOSTIC_ORTHOGRAPHIC_SIDE',
  'FIXED_WORLD_CAMERA',
];

interface Placement {
  /** Offset in the raft's nominal heading frame: +x port, +z bow. */
  side: number;
  fore: number;
  /** Eye height above the local water surface. */
  eye: number;
  /** Look-at height above the local water surface. */
  aim: number;
  fov: number;
}

const PLACEMENTS: Partial<Record<LabCameraName, Placement>> = {
  // Eye height is a compromise found by looking: at 0.5 m the depression angle
  // to the raft is under 3 degrees, the near and far water project to almost the
  // same screen height, and the contact line becomes genuinely hard to read —
  // a camera that hides the thing it exists to show. 0.95 m gives about 7
  // degrees, which separates near water, waterline and far water while staying
  // low enough to see the waterline edge-on.
  PORT_WATERLINE: { side: 7.0, fore: 0, eye: 0.95, aim: 0.10, fov: 26 },
  STARBOARD_WATERLINE: { side: -7.0, fore: 0, eye: 0.95, aim: 0.10, fov: 26 },
  BOW_WATERLINE: { side: 0, fore: 6.4, eye: 0.90, aim: 0.10, fov: 28 },
  STERN_WATERLINE: { side: 0, fore: -6.4, eye: 0.90, aim: 0.10, fov: 28 },
  HIGH_THREE_QUARTER: { side: 9.5, fore: -9.5, eye: 7.4, aim: 0.10, fov: 32 },
};

export class LabCameras {
  private readonly perspective = new THREE.PerspectiveCamera(24, 1.6, 0.1, 25000);
  private readonly ortho = new THREE.OrthographicCamera(-3, 3, 2, -2, 0.1, 25000);
  private readonly fixed = new THREE.PerspectiveCamera(26, 1.6, 0.1, 25000);
  private fixedInitialised = false;
  private aspect = 1.6;

  /** Heading the diagnostic frame is aligned to. Constant, so the views are stable. */
  private heading = 0;

  constructor(private readonly sim: LabCamerasCapability) {
    this.heading = sim.wind.headingRad;
  }

  setViewport(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    this.perspective.aspect = this.aspect;
    this.perspective.updateProjectionMatrix();
    this.fixed.aspect = this.aspect;
    this.fixed.updateProjectionMatrix();
    const halfHeight = 1.0;
    this.ortho.top = halfHeight;
    this.ortho.bottom = -halfHeight;
    this.ortho.left = -halfHeight * this.aspect;
    this.ortho.right = halfHeight * this.aspect;
    this.ortho.updateProjectionMatrix();
  }

  /** Reset anything that latches a starting position. */
  reset(): void {
    this.fixedInitialised = false;
    this.heading = this.sim.wind.headingRad;
  }

  camera(name: LabCameraName): THREE.Camera {
    const { sim } = this;
    // The renderer is raft-centred; the raft's nominal local position is (0, 0).
    const raftX = 0;
    const raftZ = 0;
    const waterY = sim.vessel.body.centreWaterY;

    if (name === 'PRODUCTION') return sim.cameras.camera;

    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    /** Heading-frame (side, fore) to local render (x, z). */
    const toWorld = (side: number, fore: number) => ({
      x: raftX + side * ch + fore * sh,
      z: raftZ - side * sh + fore * ch,
    });

    if (name === 'DIAGNOSTIC_ORTHOGRAPHIC_SIDE') {
      // Strictly level and strictly side-on, with the eye exactly on the local
      // water surface, so screen height maps linearly to world height and the
      // centre scanline *is* the waterline. Made for measuring against the
      // overlay, not for looking at.
      const p = toWorld(14, 0);
      this.ortho.position.set(p.x, waterY, p.z);
      this.ortho.up.set(0, 1, 0);
      this.ortho.lookAt(raftX, waterY, raftZ);
      return this.ortho;
    }

    if (name === 'FIXED_WORLD_CAMERA') {
      if (!this.fixedInitialised) {
        const p = toWorld(7.0, -2.0);
        this.fixed.position.set(p.x, 1.35, p.z);
        this.fixed.lookAt(raftX, 0, raftZ);
        this.fixedInitialised = true;
      }
      // Deliberately never updated again: the raft drifts through the frame and
      // its vertical motion is read against a completely static reference.
      return this.fixed;
    }

    const placement = PLACEMENTS[name]!;
    const p = toWorld(placement.side, placement.fore);
    this.perspective.fov = placement.fov;
    this.perspective.aspect = this.aspect;
    this.perspective.updateProjectionMatrix();
    this.perspective.position.set(p.x, waterY + placement.eye, p.z);
    this.perspective.up.set(0, 1, 0);
    this.perspective.lookAt(raftX, waterY + placement.aim, raftZ);
    return this.perspective;
  }
}
