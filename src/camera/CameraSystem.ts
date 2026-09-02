import * as THREE from 'three';
import {
  CinematicCameraController,
  type CinematicFraming,
} from './CinematicCameraController';
import {
  EmbodiedCameraController,
  type EmbodiedLook,
  type HeadStabilisation,
} from './EmbodiedCameraController';
import { CameraTransition } from './CameraTransition';
import { cinematicAltitude, cinematicDistance, clamp } from './cameraTuning';
import type { CameraContext, CameraPose } from './types';

/**
 * The mode manager, and the sole owner of the rendering camera.
 *
 * ONE CAMERA
 * ----------
 * There is exactly one `THREE.PerspectiveCamera` in the application. The two
 * controllers and the transition produce *poses*; this class is the only thing
 * that copies a pose onto the camera. A controller cannot render itself and
 * cannot fight another controller for the frame, because neither of them owns
 * anything that can be rendered from.
 *
 * ONE INPUT OWNER
 * ---------------
 * Input arrives here and is dispatched to whichever controller is active.
 * During a transition it is dropped: a camera being flown somewhere is not a
 * camera the player is steering, and letting a drag leak into either end would
 * make the landing miss.
 *
 * WHAT SURVIVES A MODE CHANGE
 * ---------------------------
 * The cinematic azimuth, elevation offset and scale, and the embodied look yaw
 * and pitch, are held on their controllers and never rebuilt. Coming back from
 * the vessel therefore restores the composition the player left, rather than
 * snapping to an authored default they did not choose.
 */

export type CameraMode = 'cinematic' | 'embodied';

/**
 * Everything the camera panel reads. All of it is *measured* from the state
 * the controllers actually produced this frame, not recomputed from the curve
 * — a readout that re-derives its own numbers cannot show a clamp.
 */
export interface CameraTelemetry {
  mode: CameraMode;
  transitioning: boolean;
  transitionProgress: number;
  cinematicScale: number;
  distance: number;
  horizontalDistance: number;
  altitude: number;
  opticalPitchDeg: number;
  orbitElevationDeg: number;
  horizonFromTop: number;
  /** Live translation away from the neutral world-space tripod, metres. */
  verticalCorrection: number;
  tripodLocked: boolean;
  vesselFrameLeft: number;
  vesselFrameRight: number;
  vesselFrameTop: number;
  vesselFrameBottom: number;
  waterlineFramePosition: number;
  fovDeg: number;
  nearPlane: number;
  lookYawDeg: number;
  lookPitchDeg: number;
}

export interface CameraSystemOptions {
  /**
   * Hide or show the castaway. Called only when the value changes.
   *
   * The embodied camera sits inside the head sphere, so the figure has to go.
   * This is the documented compromise: rather than a first-person body — which
   * this round explicitly does not build — the whole figure is culled whenever
   * the camera is close enough to be inside it, which also covers the last
   * moments of the transition without a special case.
   */
  setFigureVisible(visible: boolean): void;
}

/** Radius inside which the castaway is culled. Comfortably past the head. */
const FIGURE_CULL_RADIUS = 1.15;
const FIGURE_SHOW_RADIUS = 1.45;

/**
 * Embodied look gain, in fields of view per screen-width of drag.
 *
 * Below about 1.5 the head turns so slowly that looking behind you becomes four
 * separate swipes, which is the fastest way to make an embodied view feel like a
 * machine rather than a neck. 2.2 was the first value that cleared that bar;
 * 3.5 is Ash's, found by walking the deck with the slider — a full turn inside
 * one and a half drags. A viewing camera and a camera you *walk* behind want
 * different numbers, and only the second one has to keep up with a body.
 */
export const EMBODIED_LOOK_GAIN = 3.5;

/**
 * How the player's look input is scaled and signed.
 *
 * A shipped default and two things nobody can settle for someone else: how fast
 * a drag turns the head, and which way up the vertical axis is. Both are
 * preference, not composition — unlike the framing knots or the head model,
 * there is no correct value to find by measurement — so they are live settings
 * rather than constants to argue about.
 */
export interface LookControl {
  /** Fields of view per screen-width of drag. */
  gain: number;
  /**
   * Flip both axes: pointer up looks *down*, pointer left looks *right*.
   *
   * One switch for both, deliberately. Half-inverted controls exist, and
   * everyone who wants them is already looking for a separate setting; a single
   * "the other way round" is what the word means to everyone else.
   */
  invert: boolean;
}

export const DEFAULT_LOOK_CONTROL: LookControl = {
  gain: EMBODIED_LOOK_GAIN,
  invert: false,
};

export class CameraSystem {
  /** Look sensitivity and pitch direction. Mutated live by the panels. */
  readonly lookControl: LookControl = { ...DEFAULT_LOOK_CONTROL };

  readonly camera: THREE.PerspectiveCamera;
  readonly cinematic = new CinematicCameraController();
  readonly embodied = new EmbodiedCameraController();
  readonly transition = new CameraTransition();

  private mode: CameraMode = 'cinematic';
  private aspect = 1.6;
  private figureVisible = true;
  private readonly options: CameraSystemOptions;

  constructor(options: CameraSystemOptions) {
    this.options = options;
    this.camera = new THREE.PerspectiveCamera(48, 1.6, 0.5, 25000);
    this.camera.matrixAutoUpdate = true;
    this.setViewport(1440, 900);
  }

  get modeName(): CameraMode {
    return this.mode;
  }

  get cinematicScale(): number {
    return this.cinematic.cinematicScale;
  }

  get isTransitioning(): boolean {
    return this.transition.running;
  }

  get stabilisation(): HeadStabilisation {
    return this.embodied.stabilisation;
  }

  setViewport(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    this.cinematic.setViewport(this.aspect);
    this.embodied.setViewport(this.aspect);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  // --- input ---------------------------------------------------------------

  /**
   * A pointer drag, in pixels, against the viewport it happened in.
   *
   * The two modes map it differently on purpose. Orbiting is a *world*
   * gesture — a full sweep of the screen should take you a good way around the
   * vessel — while looking is a *head* gesture, and should move the world by
   * roughly the angle your finger crossed, which means scaling by the field of
   * view rather than by a constant.
   */
  drag(dxPixels: number, dyPixels: number, width: number, height: number): void {
    if (this.transition.running) return;
    const w = Math.max(width, 1);
    const h = Math.max(height, 1);
    if (this.mode === 'cinematic') {
      // 0.42 rad of elevation per full-height drag, not the 0.62 the old rig
      // used. The horizon moves at `1/(2 cos^2(theta) tan(f/2))` of the frame
      // per radian — 1.15 here — so 0.62 swept the horizon 71% of the frame
      // height and a half-screen flick threw it off the top.
      this.cinematic.orbit((-dxPixels / w) * Math.PI * 1.5, (dyPixels / h) * 0.42);
    } else {
      const vertical = (this.camera.fov * Math.PI) / 180;
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * this.aspect);
      // The gaze follows the pointer: up looks up, left looks left. This was
      // grab-the-world — drag right and the scene comes with you, so the view
      // swings left, like a street-level panorama — which is right for a camera
      // you are *viewing* through and wrong for one you are walking behind. A
      // player who is steering a body reads the pointer as the head.
      //
      // Scaled by the field of view rather than by a constant, so the gesture
      // stays attached to the finger when the aspect clamp changes the field.
      const sign = this.lookControl.invert ? 1 : -1;
      this.embodied.lookBy(
        (dxPixels / w) * horizontal * this.lookControl.gain * sign,
        (dyPixels / h) * vertical * this.lookControl.gain * sign,
      );
    }
  }

  /** Wheel or pinch. Positive moves away; ignored in embodied mode. */
  zoomBy(delta: number): void {
    if (this.transition.running || this.mode !== 'cinematic') return;
    this.cinematic.scaleBy(delta);
  }

  /** Manual mode change. The only way modes change in this round. */
  toggleMode(): void {
    this.setMode(this.mode === 'cinematic' ? 'embodied' : 'cinematic');
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;

    // Whichever way the player is facing, they keep facing it. The castaway
    // faces the bow and the camera is usually somewhere else, so inheriting the
    // figure's facing put a backflip in the middle of a one-second dive; and
    // returning to the azimuth the orbit happened to be at put the same
    // backflip in the way back out, for anyone who had turned their head while
    // aboard. Both directions now carry the bearing across, so a mode change is
    // a move and never a spin.
    //
    // Not during a transition: a reversal is already at neither end, and
    // re-deriving a bearing from a pose halfway between the two would swing the
    // destination out from under the move in progress.
    if (!this.transition.running) {
      if (mode === 'embodied') {
        this.embodied.adoptWorldOrientation(this.cinematic.pose.quaternion);
      } else {
        this.cinematic.adoptWorldBearing(this.embodied.pose.quaternion);
      }
    }

    this.mode = mode;
    // Changing your mind mid-flight turns the camera around from wherever it
    // has got to, rather than restarting from an endpoint it has already left.
    // Smootherstep is symmetric about its midpoint, so reflecting the elapsed
    // time is exactly continuous in position, orientation and field of view.
    if (this.transition.running) {
      this.transition.reverse();
      return;
    }

    this.transition.start(
      mode === 'embodied' ? 'to-embodied' : 'to-cinematic',
      mode === 'embodied' ? this.cinematic.pose : this.embodied.pose,
      mode === 'embodied' ? this.embodied.pose : this.cinematic.pose,
    );
  }

  /**
   * Switch modes without the authored travel animation.
   *
   * Diagnostic captures need every candidate to see the same frozen world.
   * Letting a one-second transition elapse would move that world before the
   * first capture, while freezing it would also freeze the transition. This
   * keeps the normal interactive path untouched and gives the harness an
   * explicit, reversible cut between camera controllers.
   */
  setDiagnosticMode(mode: CameraMode): void {
    this.setMode(mode);
    this.transition.cancel();
  }

  // --- saved state ---------------------------------------------------------

  get framing(): CinematicFraming {
    return this.cinematic.framing;
  }

  set framing(value: CinematicFraming) {
    this.cinematic.framing = value;
  }

  get look(): EmbodiedLook {
    return this.embodied.look;
  }

  set look(value: EmbodiedLook) {
    this.embodied.look = value;
  }

  resetCinematic(): void {
    this.cinematic.reset();
  }

  resetEmbodiedLook(): void {
    this.embodied.resetLook();
  }

  /** Full reset to the opening composition. Used by the diagnostic harness. */
  reset(): void {
    this.transition.cancel();
    this.mode = 'cinematic';
    this.cinematic.reset();
    this.embodied.reset();
  }

  // --- update --------------------------------------------------------------

  update(context: CameraContext): void {
    // Both controllers run every frame. The inactive one has to stay current
    // or a mode change would blend towards a pose from whenever it was last
    // looked at, and the transition would land on stale geometry.
    const cinematicPose = this.cinematic.update(context);
    const embodiedPose = this.embodied.update(context);

    const blended = this.transition.update(context.dt, cinematicPose, embodiedPose);
    const pose =
      blended ?? (this.mode === 'embodied' ? embodiedPose : cinematicPose);

    this.apply(pose);
    this.updateFigureVisibility();
  }

  private apply(pose: CameraPose): void {
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(pose.quaternion);
    if (this.camera.fov !== pose.fov || this.camera.near !== pose.near) {
      this.camera.fov = pose.fov;
      this.camera.near = pose.near;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  /**
   * Cull the castaway when the camera is inside them.
   *
   * Hysteresis, because a threshold crossed exactly at the end of a transition
   * would flicker the figure on and off while the camera settles.
   */
  private updateFigureVisibility(): void {
    const distance = this.camera.position.distanceTo(this.embodied.headCentre);
    const visible = this.figureVisible
      ? distance > FIGURE_CULL_RADIUS
      : distance > FIGURE_SHOW_RADIUS;
    if (visible !== this.figureVisible) {
      this.figureVisible = visible;
      this.options.setFigureVisible(visible);
    }
  }

  // --- telemetry -----------------------------------------------------------

  /**
   * A fresh record every call. **Deliberate, and not to be turned into a reused
   * scratch object** — this project's out-param convention lives two classes
   * over (`CinematicCameraController.worldFramePosition`, `CameraTransition`)
   * and it is the wrong pattern here.
   *
   * The allocation was reported as a per-frame trap. Measured against the
   * callers rather than assumed: there are four in `src/`, and none is on a
   * frame path. `CameraPanel.update` is throttled to 10 Hz *and* gated on the
   * camera tab being the selected, open panel — and it allocates a
   * twenty-element string array plus twenty template strings on the same tick,
   * so the one object blamed here is a rounding error inside its own caller.
   * The other three are `RuntimeVisualDiagnostics`, once per contact sheet or
   * matrix. The only per-frame caller anywhere is a `while
   * (system.isTransitioning)` loop in `tests/camera.test.ts`.
   *
   * Two of those diagnostic callers are also why the obvious fix would be
   * wrong: they name the result `originalCamera` and hold it **across awaits**
   * while deliberately moving the camera, so as to put it back afterwards. A
   * mutating scratch would let the saved pose follow the camera it is meant to
   * be a record of, and the restore would quietly become a no-op — a far worse
   * bug than one object per 100 ms in a panel nobody has open.
   *
   * If a frame path ever needs this, add a `readTelemetry(out)` beside it
   * rather than changing what this one returns.
   */
  telemetry(): CameraTelemetry {
    const RAD = 180 / Math.PI;
    return {
      mode: this.mode,
      transitioning: this.transition.running,
      transitionProgress: this.transition.progress,
      cinematicScale: this.cinematic.cinematicScale,
      distance: this.cinematic.distance,
      horizontalDistance: this.cinematic.horizontalDistance,
      altitude: this.cinematic.altitude,
      opticalPitchDeg: this.cinematic.opticalPitch * RAD,
      orbitElevationDeg: this.cinematic.orbitElevation * RAD,
      horizonFromTop: this.cinematic.horizonPlacement,
      verticalCorrection: this.cinematic.verticalCorrection,
      tripodLocked: this.cinematic.tripodLocked,
      vesselFrameLeft: this.cinematic.vesselFrameLeft,
      vesselFrameRight: this.cinematic.vesselFrameRight,
      vesselFrameTop: this.cinematic.vesselFrameTop,
      vesselFrameBottom: this.cinematic.vesselFrameBottom,
      waterlineFramePosition: this.cinematic.waterlineFramePosition,
      fovDeg: this.camera.fov,
      nearPlane: this.camera.near,
      lookYawDeg: this.embodied.yaw * RAD,
      lookPitchDeg: this.embodied.pitch * RAD,
    };
  }

  /** The authored endpoints, for the panel's read-only range display. */
  get range(): {
    minDistance: number;
    maxDistance: number;
    minAltitude: number;
    maxAltitude: number;
  } {
    return {
      minDistance: cinematicDistance(0),
      maxDistance: cinematicDistance(1),
      minAltitude: cinematicAltitude(0),
      maxAltitude: cinematicAltitude(1),
    };
  }

  /** Set the cinematic scale that produces a given slant distance. */
  setDistance(metres: number): void {
    this.cinematic.setDistance(clamp(metres, cinematicDistance(0), cinematicDistance(1)));
  }

  /**
   * Place the cinematic camera at an explicit distance and altitude.
   *
   * The ocean laboratory's inspection viewpoints use this. It moves the
   * production camera rather than constructing a rival one, which means the
   * sea-clearance clamp applies here too: a requested altitude below the local
   * crests is raised to clear them. Genuine waterline inspection lives in the
   * buoyancy lab, which has purpose-built diagnostic cameras for it.
   */
  setDiagnosticView(distanceMetres: number, altitudeMetres: number): void {
    this.setDistance(distanceMetres);
    this.cinematic.setAltitude(altitudeMetres);
  }
}
