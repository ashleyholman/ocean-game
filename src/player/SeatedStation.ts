import type { DeckWalker } from './DeckWalker';

/**
 * Sitting down at something, and getting up again.
 *
 * WHY THIS IS NOT A THIRD CAMERA MODE
 * -----------------------------------
 * `CameraSystem` has two modes and a transition between them, and the reason
 * they are modes is that they are two *controllers* producing two poses from
 * two different sets of state — an orbit and a head. Sitting is neither. It is
 * the embodied camera, on the same vessel, with the same look input, with the
 * body's feet planted: the only things that change are where the eye is, how
 * far it may turn, and whether the walk keys do anything.
 *
 * A third mode would have meant a third controller, a third pair of transition
 * endpoints, a third branch in `drag()`, a row in `CameraTelemetry`, and a
 * decision about what the HUD's view switch does while you are sitting down —
 * all to express "the eye is 0.4 m lower and you cannot walk". This is that
 * instead: a small thing that *writes* the embodied eye for as long as it is
 * seated, and lets go of it when it is not.
 *
 * WHY THE WALKER IS HELD RATHER THAN MOVED
 * ----------------------------------------
 * `DeckWalker.setHeld` freezes the body where it stands. The player walks up to
 * the chair, sits, and the walker stays exactly where their feet were — so
 * standing up puts them back beside the chair rather than teleporting them into
 * it or dropping them wherever the seat happened to be. The eye travels to the
 * seat and back; the body never moves at all, and there is no moment where the
 * collider has to be asked whether a person may stand inside a chair.
 *
 * It also means the seat is not responsible for anything a floor is responsible
 * for. If sitting moved the walker, sitting could fail — no surface, a collider
 * in the way, a ship that rolled at the wrong instant — and "you cannot sit
 * down here for reasons the game will not explain" is the worst possible
 * outcome for a chair.
 */

/** Where a seat puts the eye, and how far it lets the eye turn. */
export interface SeatPose {
  /** Where the eye goes, ship-local. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Where it looks once it has settled. */
  readonly yaw: number;
  readonly pitch: number;
  /**
   * How far either way the head may turn from `yaw`, radians.
   *
   * **A clamp and not a lock, and the width is the whole design.** Locked, a
   * seated view is a photograph and the ship stops existing around it; free, the
   * player spins on the spot at a desk and the composition the seat was built
   * for is one of three hundred and sixty. Wide enough to look along the desk,
   * out of the stern windows and back at the door you came in by; not wide
   * enough to end up facing away from the thing you sat down to do.
   */
  readonly yawRange: number;
  readonly pitchLo: number;
  readonly pitchHi: number;
}

/**
 * The narrow slice of the camera a seat is allowed to touch.
 *
 * `CameraSystem` satisfies it. Stated as an interface rather than importing the
 * class because there is exactly nothing else a seat should be able to do to
 * the camera — it may not change mode, start a transition, or touch the
 * cinematic rig, and an interface is a cheaper guarantee of that than a rule.
 */
export interface SeatedView {
  readonly embodied: {
    readonly eyeLocal: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    readonly headLocal: { copy(v: { x: number; y: number; z: number }): unknown };
  };
  look: { yaw: number; pitch: number };
  readonly modeName: string;
}

/**
 * How long it takes to sit down, seconds.
 *
 * **Sitting is a move, not a cut**, for the same reason the camera's mode change
 * is: a cut from standing to seated at a desk 0.6 m away reads as a teleport
 * into the furniture, and the player loses track of where the room is. It is
 * also short — 0.55 s — because unlike a mode change there is nothing to look
 * at on the way. The one-second dive between the orbit and the deck is a shot;
 * this is a chair.
 */
const SETTLE_SECONDS = 0.55;

/** Smootherstep: zero velocity and zero acceleration at both ends. */
function ease(t: number): number {
  const x = Math.min(Math.max(t, 0), 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

const TWO_PI = Math.PI * 2;

/** Signed shortest angle from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  let d = (to - from) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

export class SeatedStation {
  private seated = false;
  /**
   * Seconds into the settle, counting up while sitting and down while rising.
   *
   * **Starts finished, and it started at zero.** `step` returns early only when
   * the body is up *and* the move is over, so a fresh seat spent its first
   * 0.55 s running the rising branch — easing the embodied eye out of
   * `(0, 0, 0)`, the origin of the ship, toward the body. Nobody had sat down;
   * the seat was interpolating out of a chair that never existed. Invisible in
   * the orbit the game opens in and half a second of the eye climbing out of
   * the keel for anything that starts embodied.
   */
  private settle = SETTLE_SECONDS;
  /** Where the eye and the look were when this move started. */
  private fromX = 0;
  private fromY = 0;
  private fromZ = 0;
  private fromYaw = 0;
  private fromPitch = 0;

  constructor(
    private readonly walker: DeckWalker,
    private readonly view: SeatedView,
    private readonly pose: () => SeatPose,
    private readonly onChanged: (seated: boolean) => void,
  ) {}

  get isSeated(): boolean {
    return this.seated;
  }

  /**
   * Whether the player's own input should be ignored this frame.
   *
   * True only while the move is running. A camera being flown somewhere is not
   * a camera the player is steering — `CameraSystem.drag` drops input during a
   * transition for exactly this reason, and a look that fought the settle would
   * make the landing miss.
   */
  get isSettling(): boolean {
    return this.settle > 0 && this.settle < SETTLE_SECONDS;
  }

  sitDown(): void {
    if (this.seated) return;
    this.captureStart();
    this.seated = true;
    this.settle = 0;
    this.walker.setHeld(true);
    this.onChanged(true);
  }

  standUp(): void {
    if (!this.seated) return;
    this.captureStart();
    this.seated = false;
    this.settle = 0;
    // **Released now rather than when the move finishes.** The body has not
    // moved and does not need to; releasing at the end would mean half a second
    // in which the walk keys are silently dead after the chair has visibly gone
    // back under the desk, which reads as the game having stuck.
    this.walker.setHeld(false);
    this.onChanged(false);
  }

  toggle(): void {
    if (this.seated) this.standUp();
    else this.sitDown();
  }

  /**
   * Give the eye back to the body, without a move.
   *
   * For the diagnostic entry points, which place a seated player directly and
   * must not then watch half a second of camera travel from wherever the eye
   * was initialised to.
   */
  snapToSeat(): void {
    this.seated = true;
    this.settle = SETTLE_SECONDS;
    this.walker.setHeld(true);
    const p = this.pose();
    this.view.embodied.eyeLocal.set(p.x, p.y, p.z);
    this.view.embodied.headLocal.copy(this.view.embodied.eyeLocal);
    this.view.look = { yaw: p.yaw, pitch: p.pitch };
    this.onChanged(true);
  }

  private captureStart(): void {
    const eye = this.view.embodied.eyeLocal;
    this.fromX = eye.x;
    this.fromY = eye.y;
    this.fromZ = eye.z;
    this.fromYaw = this.view.look.yaw;
    this.fromPitch = this.view.look.pitch;
  }

  /**
   * Called every frame **after** whatever normally writes the eye.
   *
   * Order matters and it is the cheap half of not needing a camera mode: the
   * walker writes the eye from the body's own position every frame, and this
   * overwrites it while seated. Called before, the body would win and the
   * player would sit down into their own standing eye.
   */
  step(dt: number): void {
    if (!this.seated && this.settle >= SETTLE_SECONDS) return;

    this.settle = Math.min(this.settle + dt, SETTLE_SECONDS);
    const t = ease(this.settle / SETTLE_SECONDS);

    if (this.seated) {
      // **Asked for inside the branch that uses it, and it used to be outside.**
      // The rising branch below has no use for the pose — it travels back to
      // wherever the body's own eye is — and with one seat aboard the wasted
      // call was harmless. It stopped being harmless when the pose became "the
      // pose of whichever station the body is in": standing up clears that
      // name, so a `pose()` on the way *out* of a chair is a question with no
      // answer, and the caller would have had to keep a second copy of the
      // station just to answer it.
      const p = this.pose();
      // Toward the seat. The look eases to the pose as well, so a player who
      // sat down facing the door arrives facing the desk.
      const eye = this.view.embodied.eyeLocal;
      eye.set(
        this.fromX + (p.x - this.fromX) * t,
        this.fromY + (p.y - this.fromY) * t,
        this.fromZ + (p.z - this.fromZ) * t,
      );
      this.view.embodied.headLocal.copy(eye);
      if (this.isSettling) {
        this.view.look = {
          yaw: this.fromYaw + angleDelta(this.fromYaw, p.yaw) * t,
          pitch: this.fromPitch + (p.pitch - this.fromPitch) * t,
        };
      } else {
        this.clampLook(p);
      }
      return;
    }

    // Rising: the eye travels back to wherever the body's own eye is now, and
    // once it arrives this stops writing at all and the walker has it again.
    const eye = this.view.embodied.eyeLocal;
    const bodyX = this.walker.x;
    const bodyY = this.walker.eyeY();
    const bodyZ = this.walker.z;
    eye.set(
      this.fromX + (bodyX - this.fromX) * t,
      this.fromY + (bodyY - this.fromY) * t,
      this.fromZ + (bodyZ - this.fromZ) * t,
    );
    this.view.embodied.headLocal.copy(eye);
  }

  /** Hold the head inside the seat's cone. */
  private clampLook(p: SeatPose): void {
    const look = this.view.look;
    const offset = angleDelta(p.yaw, look.yaw);
    const clampedOffset = Math.min(Math.max(offset, -p.yawRange), p.yawRange);
    const pitch = Math.min(Math.max(look.pitch, p.pitchLo), p.pitchHi);
    if (clampedOffset !== offset || pitch !== look.pitch) {
      this.view.look = { yaw: p.yaw + clampedOffset, pitch };
    }
  }
}
