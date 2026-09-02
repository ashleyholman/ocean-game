import * as THREE from 'three';
import {
  EMBODIED_PITCH_MAX,
  EMBODIED_PITCH_MIN,
  approach,
  clamp,
  embodiedDefaultPitch,
  embodiedFov,
} from './cameraTuning';
import type { CameraContext, CameraPose } from './types';

/**
 * The on-raft camera, at the castaway's eyes.
 *
 * This is an embodied *viewing* mode, not a character controller. There is no
 * walking, no crouching, no hands and no body interaction: the player sits
 * where the castaway sits and looks around.
 *
 * THE ANCHOR IS AUTHORED, NOT INFERRED
 * ------------------------------------
 * `EYE_ANCHOR` below is derived once, on paper, from the figure's actual
 * geometry in `Raft.ts` — see the derivation in the constant's comment — and
 * then written down. Reading it back from the head mesh every frame would tie
 * the camera to a vertex that breathes by eight millimetres, which is a camera
 * that visibly pulses.
 *
 * HEAD STABILISATION
 * ------------------
 * A camera rigidly welded to the raft inherits every degree of a rigid body
 * that pitches and rolls hard in a seaway, and is genuinely unpleasant. A
 * camera locked level is a drone hovering where a person should be. Neither is
 * right, so this takes the *position* in full — the eye is exactly where the
 * deck puts it, heave included, which is what makes the sea feel physical — and
 * attenuates the *angles* hard, through a short low-pass and a small follow
 * fraction. A neck and a vestibulo-ocular reflex are the model, but only up to a
 * point: a real head is attached to an inner ear that agrees with it, and a
 * player's is not, so the angular terms are cut well below what a neck would do
 * while the translation is kept nearly whole. See DEFAULT_STABILISATION.
 */

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * Yaw the castaway figure is placed at in `Raft.ts` (`figure.rotation.y`).
 * The default look direction is derived from it rather than guessed.
 */
const FIGURE_YAW = -0.42;

/**
 * The eye, in raft-local coordinates.
 *
 * Derived from the figure as built:
 *   figure origin           (-0.18, 0.19, 1.02), rotated -0.42 rad about Y
 *   head centre in figure    (0, 0.685, -0.045), radius 0.098
 *   -> head centre in raft   (-0.1617, 0.8750, 0.9789)
 *   -> eyes, 85 mm forward along the figure's facing and 30 mm above centre
 *                            (-0.1963, 0.9050, 1.0565)
 *
 * That is 0.66 m above the deck crown, not the 1.5 m of a standing adult,
 * because the castaway is sitting down. Putting the camera at standing height
 * would float it through the sail and make the raft read as a metre narrower
 * than it is.
 *
 * The 85 mm is not arbitrary either. The torso capsule's upper cap is centred
 * at figure-local (0, 0.5624, 0.0048) with radius 0.135, so an eye only 55 mm
 * forward of the head centre sits **2.7 mm outside the chest** — inside the
 * 0.06 m near plane, which would slice the torso open and, since the figure is
 * culled in this mode anyway, leave the lower-forward view looking out through
 * a hole. 85 mm gives 21.6 mm of clearance and still lands on the face rather
 * than in front of it.
 *
 * The figure sits forward of the mast facing the bow, so the default view opens
 * onto open water with the rig behind the player's shoulder.
 */
export const EYE_ANCHOR = new THREE.Vector3(-0.1963, 0.905, 1.0565);

/** Head centre in raft-local coordinates, for the first-person visibility mask. */
export const HEAD_CENTRE = new THREE.Vector3(-0.1617, 0.875, 0.9789);

/** Look direction, raft-relative, that faces the way the castaway faces. */
export const DEFAULT_LOOK_YAW = Math.PI + FIGURE_YAW;

/** Time constant of the angular low-pass. Short: this is a neck, not a gimbal. */
const ANGULAR_TAU = 0.25;
/**
 * Time constant of the running mean the two positional follow fractions work
 * against.
 *
 * It was `HEAVE_MEAN_TAU` and only heave used it. The mean is what makes a
 * follow fraction mean "how much of the *motion*" rather than "how much of the
 * *position*": subtract a 2.2 s mean and what is left is the swell, the roll and
 * the chop; keep the mean whole and the vessel's own progress across the ocean
 * is passed through untouched. Sway needs that far more than heave did — a
 * fraction applied to a raw world x would drag the camera a tenth of the way
 * back toward the world origin, which is somewhere off the coast of nowhere.
 */
const POSITION_MEAN_TAU = 2.2;

export interface HeadStabilisation {
  /** Fraction of the raft's low-passed roll the view inherits. */
  rollFollow: number;
  /** Fraction of the raft's low-passed pitch the view inherits. */
  pitchFollow: number;
  /** Fraction of the eye's deviation from its running mean height. */
  heaveFollow: number;
  /**
   * Fraction of the eye's **horizontal** deviation from its running mean.
   *
   * Added at M5, and it is one everywhere but at the masthead. On a deck the
   * eye's horizontal excursion is small — 1.5 m above the roll axis, so a 20°
   * roll swings it half a metre — and it is the thing that makes the sea
   * physical, exactly as heave is. Aloft the lever is eight times as long and
   * the swing is four metres, which is a different quantity wearing the same
   * name; `vessel/schooner/aloftComfort.ts` derives what to do about it and why
   * the answer is not "much".
   *
   * Why a separate term rather than reusing `heaveFollow`: heave and sway have
   * different *causes*. Heave is the sea lifting the whole hull and the player
   * can see it happening to the water; sway at altitude is a lever arm on roll,
   * and the player's own body is not on the end of a lever.
   */
  swayFollow: number;
  /** Low-pass time constant on the inherited angles, seconds. */
  smoothingSeconds: number;
}

/**
 * The shipped head model, settled by sitting in it rather than by argument.
 *
 * Roll 0.10, pitch 0.20, heave 0.90. The asymmetry is the whole finding: the
 * *angular* terms are what make an on-deck camera unpleasant, and they can be
 * cut almost to nothing before the view stops reading as attached to the boat —
 * a tenth of the raft's roll is still visibly a boat rolling. The *translation*
 * is what makes it feel like a boat at all, and it is not nauseating, because
 * being lifted and dropped is exactly what the player can see happening to the
 * water around them. So heave stays at nine tenths.
 *
 * These were 0.55 and 0.45 on the first pass, derived from what a neck does.
 * A neck is attached to an inner ear that agrees with it; a player at a desk
 * has an inner ear that says the room is still, and every degree the horizon
 * tilts is a degree of that disagreement. The sliders in the camera panel are
 * what found it, and they stay for the next person who wants to argue.
 */
export const DEFAULT_STABILISATION: HeadStabilisation = {
  rollFollow: 0.1,
  pitchFollow: 0.2,
  heaveFollow: 0.9,
  // One, which is the value that makes this term do nothing at all — and that is
  // the honest default rather than a guess. A castaway sits 0.66 m above the
  // water on a raft with no lever to speak of, so there is no sway to attenuate
  // and attenuating it would only unstick the eye from the logs under it.
  swayFollow: 1,
  smoothingSeconds: ANGULAR_TAU,
};

/**
 * The head model for a player who is **standing**, settled the same way.
 *
 * Six and a half times the roll of the seated castaway's, three times the
 * pitch, and the whole of the heave. That is not a contradiction of the numbers above,
 * it is what changed underneath them: a castaway sits on a raft 0.66 m above the
 * water with nothing to hold, and the view's job is to stay bearable. A player
 * standing on a deck 1.5 m above the sea, walking, with a rig overhead and a
 * horizon over a rail, has the whole ship as a frame of reference — the tilt
 * reads as the *ship* moving rather than as the world tipping, because there is
 * a mast in shot that stays put relative to the deck.
 *
 * So the vestibular argument that cut the angles to a tenth still holds for the
 * raft and does not transfer. Ash walked her and asked for these.
 */
export const WALKING_STABILISATION: HeadStabilisation = {
  // 0.40, down from 0.65, by Ash's call after walking her furnished. The 0.65
  // was settled on a bare deck: with a hatch, a windlass and a tiller in shot
  // there is far more near geometry holding still relative to the planking, so
  // the ship's motion reads from the *scene* and the head does not have to carry
  // as much of it. Heave stays at 1 — a deck dropping away under the feet is the
  // sensation, not a tilt.
  rollFollow: 0.4,
  pitchFollow: 0.4,
  heaveFollow: 1,
  // One, and for a reason a deck makes stronger than a raft does: the planking
  // is under your feet and fills the lower half of the view, so an eye that
  // moved less than the deck it stands on would slide across its own boards.
  swayFollow: 1,
  smoothingSeconds: ANGULAR_TAU,
};

export interface EmbodiedLook {
  yaw: number;
  pitch: number;
}

function wrapPi(angle: number): number {
  let x = (angle + Math.PI) % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x - Math.PI;
}

export class EmbodiedCameraController {
  readonly pose: CameraPose = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: 62,
    near: 0.06,
  };

  readonly stabilisation: HeadStabilisation = { ...DEFAULT_STABILISATION };

  /**
   * The eye, in vessel-local coordinates. Written by whatever owns the body.
   *
   * It defaults to the castaway's eye because the raft *is* a seated figure and
   * there is nothing else it could be. On the schooner the deck walker writes it
   * every frame — and until it did, `V` aboard the schooner put the camera at
   * this raft-derived 0.905 m, which on that vessel is three metres below the
   * deck and 1.4 m under the sea, inside the hull. An anchor that is a constant
   * of one vessel cannot be a constant of the camera.
   */
  readonly eyeLocal = EYE_ANCHOR.clone();

  /** Head centre, vessel-local, for the first-person visibility mask. */
  readonly headLocal = HEAD_CENTRE.clone();

  /** Player look, relative to the raft. Yaw wraps; pitch is clamped. */
  private lookYaw = DEFAULT_LOOK_YAW;
  private aspect = 1.6;
  private lookPitch = embodiedDefaultPitch(1.6);

  private lowPassPitch = 0;
  private lowPassRoll = 0;
  private meanEyeX = 0;
  private meanEyeY = 0;
  private meanEyeZ = 0;
  private initialised = false;

  /** Where the eye actually is this frame, before stabilisation trims it. */
  readonly rawEye = new THREE.Vector3();
  /** Where the castaway's head is, for the first-person visibility mask. */
  readonly headCentre = new THREE.Vector3();

  private readonly baseEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly baseQuat = new THREE.Quaternion();
  private readonly lookQuat = new THREE.Quaternion();

  setViewport(aspect: number): void {
    this.aspect = aspect;
    this.pose.fov = embodiedFov(aspect) / DEG;
  }

  /** The authored default pitch at the current aspect. Positive is up. */
  get defaultPitch(): number {
    return embodiedDefaultPitch(this.aspect);
  }

  get look(): EmbodiedLook {
    return { yaw: this.lookYaw, pitch: this.lookPitch };
  }

  set look(value: EmbodiedLook) {
    this.lookYaw = wrapPi(value.yaw);
    this.lookPitch = clamp(value.pitch, EMBODIED_PITCH_MIN, EMBODIED_PITCH_MAX);
  }

  get yaw(): number {
    return this.lookYaw;
  }

  get pitch(): number {
    return this.lookPitch;
  }

  /**
   * Look input, radians. Yaw is unbounded and wraps, so a full turn is
   * continuous; pitch is clamped one degree short of the zenith.
   */
  lookBy(deltaYaw: number, deltaPitch: number): void {
    this.lookYaw = wrapPi(this.lookYaw + deltaYaw);
    this.lookPitch = clamp(
      this.lookPitch + deltaPitch,
      EMBODIED_PITCH_MIN,
      EMBODIED_PITCH_MAX,
    );
  }

  /** Face the way the castaway faces again. */
  resetLook(): void {
    this.lookYaw = DEFAULT_LOOK_YAW;
    this.lookPitch = this.defaultPitch;
  }

  /**
   * Take the bearing out of a world orientation and make it the player's look.
   *
   * Used when the mode changes: coming aboard, the player keeps facing whatever
   * they were already facing, so the transition is a move rather than a move
   * and a spin.
   *
   * WHY THE BEARING AND NOT THE WHOLE ORIENTATION
   * ---------------------------------------------
   * The castaway faces the bow, and the cinematic camera is usually somewhere
   * else entirely — at the authored default composition the two are 108 degrees
   * apart, and from half the orbit they are nearly opposite. Snapping to the
   * figure's facing therefore threw a backflip into the middle of a one-second
   * dive, which reads as the camera being yanked round rather than as arriving
   * anywhere. Whatever the cinematic camera was pointing at is also the thing
   * the player was looking at, and it is the raft — so keeping the bearing lands
   * the view on the rig and the sail, which says "you are aboard this" far
   * better than the empty water off the bow does.
   *
   * The *pitch* is not inherited. The cinematic camera looks down at the raft by
   * definition — 8.6 degrees at the authored composition and 80 in a bird's-eye
   * orbit — and arriving on deck already staring at your own lap is not an
   * arrival. It levels to the authored embodied pitch instead, and because the
   * transition slerps between the two end orientations, the levelling happens
   * *during* the dive: the view comes up to the horizon as the camera comes
   * down to the eye, which is the movement of actually looking up on arrival.
   *
   * The look is stored *inside* the stabilised head frame, so the world bearing
   * is divided by that frame rather than used directly. Roll is dropped: the
   * frame carries the raft's, and the player has no control that makes any.
   */
  adoptWorldOrientation(worldQuaternion: THREE.Quaternion): void {
    this.lookQuat.copy(this.baseQuat).invert().multiply(worldQuaternion);
    this.lookEuler.setFromQuaternion(this.lookQuat, 'YXZ');
    this.lookYaw = wrapPi(this.lookEuler.y);
    this.lookPitch = this.defaultPitch;
  }

  /** Drop the stabilisation filters, so the next frame starts settled. */
  reset(): void {
    this.resetLook();
    this.initialised = false;
    this.lowPassPitch = 0;
    this.lowPassRoll = 0;
  }

  update(context: CameraContext): CameraPose {
    const dt = Math.max(context.dt, 0);
    const vessel = context.vessel;
    const s = this.stabilisation;

    // Position: the exact deck attachment, so the eye goes where the raft
    // genuinely puts it. Nothing is faked here.
    this.rawEye.copy(this.eyeLocal).applyMatrix4(vessel.matrixWorld);
    this.headCentre.copy(this.headLocal).applyMatrix4(vessel.matrixWorld);

    if (!this.initialised) {
      this.initialised = true;
      this.meanEyeX = this.rawEye.x;
      this.meanEyeY = this.rawEye.y;
      this.meanEyeZ = this.rawEye.z;
      this.lowPassPitch = vessel.pitch;
      this.lowPassRoll = vessel.roll;
    }

    this.meanEyeX = approach(this.meanEyeX, this.rawEye.x, POSITION_MEAN_TAU, dt);
    this.meanEyeY = approach(this.meanEyeY, this.rawEye.y, POSITION_MEAN_TAU, dt);
    this.meanEyeZ = approach(this.meanEyeZ, this.rawEye.z, POSITION_MEAN_TAU, dt);
    // Horizontal and vertical are trimmed the same way and by different amounts:
    // the mean is kept whole so the vessel's own progress is never lagged, and
    // the follow fraction decides how much of what is left about that mean gets
    // through. Both are one at every station but the masthead.
    this.pose.position.set(
      this.meanEyeX + s.swayFollow * (this.rawEye.x - this.meanEyeX),
      this.meanEyeY + s.heaveFollow * (this.rawEye.y - this.meanEyeY),
      this.meanEyeZ + s.swayFollow * (this.rawEye.z - this.meanEyeZ),
    );

    // Angles: low-pass first, then take a fraction. The filter removes the
    // high-frequency chop the eye cannot track; the fraction removes the
    // excess amplitude of what is left.
    const tau = Math.max(s.smoothingSeconds, 1e-3);
    this.lowPassPitch = approach(this.lowPassPitch, vessel.pitch, tau, dt);
    this.lowPassRoll = approach(this.lowPassRoll, vessel.roll, tau, dt);

    // Yaw is inherited in full and unfiltered: the raft's heading wanders over
    // tens of seconds, which is a slow turn of the whole world and reads as
    // being aboard something adrift. It is not a motion-sickness term.
    this.baseEuler.set(
      this.lowPassPitch * s.pitchFollow,
      vessel.yaw,
      this.lowPassRoll * s.rollFollow,
    );
    this.baseQuat.setFromEuler(this.baseEuler);

    // The player's look is applied *inside* the stabilised head frame, so a
    // roll tilts the world under a fixed gaze rather than swinging the gaze.
    this.lookEuler.set(this.lookPitch, this.lookYaw, 0);
    this.lookQuat.setFromEuler(this.lookEuler);
    this.pose.quaternion.copy(this.baseQuat).multiply(this.lookQuat);

    // Near plane close enough to see the deck logs a third of a metre away
    // without slicing them, which a 0.5 m plane does.
    this.pose.near = 0.06;

    // Re-derived per frame, not only on a resize: the field is a live setting
    // now, and a slider that only takes effect when the window changes size is
    // a slider that appears not to work.
    this.pose.fov = embodiedFov(this.aspect) / DEG;

    return this.pose;
  }
}
