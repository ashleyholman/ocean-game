import * as THREE from 'three';
import {
  clamp01,
  easeArrival,
  easeArrivalInverse,
  transitionSeconds,
} from './cameraTuning';
import type { CameraPose } from './types';

/**
 * The manual mode change.
 *
 * A cut between a camera 900 m up and a camera on the deck tells the player
 * nothing about how the two are related. A move does, provided it is quick
 * enough not to feel like a cutscene.
 *
 * THE PATH IS A STRAIGHT LINE
 * ---------------------------
 * Straight, and deliberately so. The first version arced up over the masthead
 * and then descended a vertical shaft forward of the mast, solving its lift
 * height from the rig so it could not touch anything. It could not, and it
 * still read badly: the horizontal travel finished while the camera was still
 * several metres up, and the last third of the move was a pure vertical drop.
 * The author's word for it was that the camera "arrives above mast height and
 * then just drops down into place", which is exactly what a path with a
 * vertical final tangent does, however carefully it is eased.
 *
 * The clearance the arc was buying turned out not to be worth anything. The
 * destination is inside the castaway's head, so the camera ends up somewhere
 * with a clear view whatever route it takes, and passing through a rope or the
 * edge of the sail at forty metres a second is a frame or two of cloth. So the
 * route is now the obvious one — a straight run from where the camera is to
 * where the eye is — and the vertical rate is a fixed fraction of the
 * horizontal rate for the whole move, which is what makes it read as a single
 * movement rather than as two.
 *
 * This is a deliberate departure from the round's brief, which asks for a path
 * that avoids the sail and the mast. It was made on the author's explicit
 * instruction after seeing both.
 *
 * Both endpoints are re-evaluated every frame from the live controllers, so the
 * line tracks the raft as it heaves and the move lands exactly on the
 * destination pose rather than near where it used to be.
 *
 * ROTATION
 * --------
 * Slerp, which takes the shortest arc between the two orientations. That is
 * also the least-spin path. In practice there is almost nothing to spin:
 * entering embodied mode adopts the cinematic camera's own bearing, so the two
 * end orientations differ by little more than the pitch levelling out.
 */

export type TransitionDirection = 'to-embodied' | 'to-cinematic';

export class CameraTransition {
  readonly pose: CameraPose = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    fov: 48,
    near: 0.5,
  };

  /** Multiplier on the solved duration. Debug only; 1 in normal use. */
  durationScale = 1;

  private active = false;
  private direction: TransitionDirection = 'to-embodied';
  private elapsed = 0;
  private duration = 1;


  get running(): boolean {
    return this.active;
  }

  /** Eased progress in [0, 1]. Monotonic for monotonic time. */
  get progress(): number {
    return this.active ? clamp01(this.elapsed / this.duration) : 1;
  }

  get seconds(): number {
    return this.duration;
  }

  /**
   * Begin a move. The duration is solved from how far the camera has to
   * travel, so stepping aboard from eight metres is not paced like a dive from
   * a kilometre, and both stay inside the 0.7-1.4 s band.
   */
  start(
    direction: TransitionDirection,
    from: CameraPose,
    to: CameraPose,
  ): void {
    this.active = true;
    this.direction = direction;
    this.elapsed = 0;
    this.duration = Math.max(
      0.05,
      transitionSeconds(from.position.distanceTo(to.position)) *
        this.durationScale,
    );
  }

  cancel(): void {
    this.active = false;
  }

  /**
   * Turn a running move around without a discontinuity.
   *
   * The ease is deliberately asymmetric (see `easeArrival`), so the clock cannot
   * simply be reflected — that trick only works for an ease with
   * `s(1 - u) = 1 - s(u)`, and reflecting an asymmetric one jumps the camera by
   * however far the two disagree. Solving for the time at which the *other*
   * direction is at the eased value the camera is already at gives exact
   * continuity in position, orientation and field of view, and flips only the
   * sign of the velocity — which is what turning round is.
   */
  reverse(): void {
    if (!this.active) return;
    this.direction =
      this.direction === 'to-embodied' ? 'to-cinematic' : 'to-embodied';
    const here = easeArrival(clamp01(this.elapsed / this.duration));
    this.elapsed = this.duration * easeArrivalInverse(1 - here);
  }

  /**
   * Advance and evaluate.
   *
   * @param cinematic live cinematic pose
   * @param embodied  live embodied pose
   * @returns the blended pose, or null once the move has finished
   */
  update(
    dt: number,
    cinematic: CameraPose,
    embodied: CameraPose,
  ): CameraPose | null {
    if (!this.active) return null;
    this.elapsed += Math.max(dt, 0);
    const u = clamp01(this.elapsed / this.duration);
    const eased = easeArrival(u);

    const forward = this.direction === 'to-embodied';
    const from = forward ? cinematic : embodied;
    const to = forward ? embodied : cinematic;
    // A straight run. Both endpoints are live, so the line re-solves every
    // frame and tracks the raft as it heaves.
    this.pose.position.copy(from.position).lerp(to.position, eased);
    this.pose.quaternion.copy(from.quaternion).slerp(to.quaternion, eased);
    this.pose.fov = from.fov + (to.fov - from.fov) * eased;
    // The tightest of the two the whole way: a near plane that grows mid-flight
    // would slice the raft off as the camera passes it.
    this.pose.near = Math.min(from.near, to.near);

    if (u >= 1) {
      this.active = false;
      // Land exactly on the destination rather than near it.
      this.pose.position.copy(to.position);
      this.pose.quaternion.copy(to.quaternion);
      this.pose.fov = to.fov;
      this.pose.near = to.near;
    }
    return this.pose;
  }

  /**
   * Sample the path without running a transition, for the tests.
   *
   * A straight line, so this is a lerp. It exists so the tests state the
   * property rather than assume it: the route between the two poses is exactly
   * the segment joining them, with nothing added.
   */
  samplePath(
    cinematic: THREE.Vector3,
    embodied: THREE.Vector3,
    t: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    return out.copy(cinematic).lerp(embodied, clamp01(t));
  }
}
