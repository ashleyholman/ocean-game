import type * as THREE from 'three';
import type { Lamp } from '../scene/Lamp';
import type { WaveField } from '../scene/Waves';
import type { WindSystem } from '../scene/WindSystem';
import type { BuoyantBody } from './BuoyantBody';
import type {
  MutableHorizontalVelocity,
  VesselHorizontalDynamicsBridge,
} from './VesselMotion';

export type VesselKind = 'schooner' | 'raft';

/** Inputs valid while an active vessel advances its physical state. */
export interface VesselPhysicsContext {
  dt: number;
  waves: WaveField;
  localX: number;
  localZ: number;
  wind: WindSystem;
  elapsed: number;
  /** Transient projection of canonical ECEF velocity into render/wave axes. */
  encounterVelocity: MutableHorizontalVelocity;
  /** Present only for the production force-integrated schooner. */
  horizontalMotion?: VesselHorizontalDynamicsBridge;
}

/** Inputs valid after physics and environment derivation have completed. */
export interface VesselPresentationContext {
  dt: number;
  localX: number;
  localZ: number;
  wind: WindSystem;
  elapsed: number;
  sunDirection: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  moonDirection: THREE.Vector3;
  moonColor: THREE.Color;
  moonIntensity: number;
  ambientRadiance: THREE.Vector3;
  /** Cosine-weighted mean radiance of the visible sky hemisphere. */
  skyHemisphericRadiance: THREE.Vector3;
  /**
   * The authored scene exposure this frame will be displayed through —
   * `lighting.exposure × daylightLift × the user biases`, excluding any
   * camera-adaptation gain (the legacy A/B modes must not change what a
   * vessel's own lights decide). The night half of that curve compensates
   * for a dark SKY; a lamp lit inside a close room must not inherit the
   * sky's compensation, and this is the number it divides out.
   */
  sceneExposure: number;
  /**
   * Apparent wind at the vessel, in render axes — instantaneous, gusts included.
   *
   * The *mean* wind reaches vessels through `wind` and drives the sea's look.
   * This is the other one, and the distinction is deliberate: `WorldWind`'s note
   * says presentation stays on the mean and that pointing anything on screen at
   * the gusty instantaneous value is a look change to be taken on purpose. The
   * wind cues are that change taken on purpose — an indicator that ignores gusts
   * is an indicator that is wrong most of the time.
   */
  apparentWindRender: MutableHorizontalVelocity;
}

/**
 * The narrow runtime boundary shared by independently implemented vessels.
 * Geometry, coefficients, controls and vessel-specific effects stay behind
 * their adapters; the scene owns only this active-vessel surface.
 */
export interface Vessel {
  readonly kind: VesselKind;
  readonly group: THREE.Group;
  readonly sceneObjects: readonly THREE.Object3D[];
  readonly body: BuoyantBody;
  readonly lamp: Lamp;
  readonly halfLengthM: number;
  readonly halfBeamM: number;
  readonly waterlineLocalY: number;
  physicsStep: number | undefined;

  /** Advance physical state. This may update canonical motion through context. */
  advancePhysics(context: VesselPhysicsContext): void;
  /** Pose meshes and update effects/lighting from the completed physics state. */
  updatePresentation(context: VesselPresentationContext): void;
  setEmbodiedFigureVisible?(visible: boolean): void;
  updateTrimPickTargets?(low: THREE.Vector3, high: THREE.Vector3): void;
  /**
   * Cull vessel geometry against the finished camera, once per frame after
   * `updatePresentation` and the camera update. The schooner uses it to stop
   * drawing below decks when no opening is on screen.
   */
  updateInteriorVisibility?(camera: THREE.Camera): void;
  activeOvertopSprayCount(): number;
  resetEffects(): void;
  dispose(): void;
}
