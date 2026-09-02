/**
 * The player's body, walking in ship-local space.
 *
 * WHY SHIP-LOCAL, SETTLED FROM LINE ONE
 * -------------------------------------
 * `docs/ship/SHIP_ROUND_HANDOVER.md` section 3.1: collision and gravity resolve in the
 * ship's frame and the result is composed through `matrixWorld`. World-space
 * walking would mean chasing a floor that moves — a deck that is heaving 2 m and
 * rolling 20° under a controller that thinks in world coordinates spends every
 * frame catching up with it. Here the deck is stationary by construction and the
 * ship's motion reaches the player for free, through the transform.
 *
 * The one thing that does not come for free is gravity: it is a *world* fact, so
 * `step` takes the world down direction expressed in ship-local coordinates. On
 * an upright ship that is (0, −1, 0) and nothing happens; as she heels, its
 * in-plane part is what tips the player toward the lee rail.
 *
 * WHAT THIS DOES NOT KNOW
 * -----------------------
 * Nothing about the schooner. It takes a `DeckEnvironment` — a surface it can
 * ask for the floor under a position, and a list of solid columns — which the
 * schooner satisfies from `deckSurface.ts` and `deckObstacles.ts`. That is what
 * lets the same body walk any vessel that can answer those two questions, and it
 * keeps the deck's description in one place instead of two.
 */

/** The floor under a query. `null` from `standAt` means "not deck at all". */
export interface StandResult {
  /** Height of the walking surface, ship-local. */
  readonly y: number;
  /**
   * Underside of whatever is directly overhead. `Infinity` under open sky.
   *
   * A surface with no ceiling is the *common* case aboard and the sky is not
   * something a body hits, so this could have been optional. It is not, because
   * an optional headroom is one every caller is free to forget, and the whole
   * reason M4 exists is that a floor without a ceiling could not describe a
   * cabin. `Infinity` composes — `ceilingY - y >= anything` is true under the
   * sky without a single branch anywhere downstream.
   */
  readonly ceilingY: number;
  /**
   * Is the body **inside a shaft it climbs** rather than on ordinary floor?
   *
   * The one thing the body needs to know to climb rather than fall. A ladder is
   * not a staircase and it is not a drop: a body goes up and down it at its own
   * deliberate rate, and a controller that treats a rung like any other floor
   * teleports up seven of them in a tenth of a second on the way out and falls
   * two metres on the way in. Both were what the fore scuttle read as.
   *
   * It marks the *position*, not just the rungs: a body that has stepped off
   * the ladder into the rest of an open hatchway is still in a hole it is
   * climbing through, and pacing only the rungs left the last part of every
   * descent as a two-metre fall.
   *
   * Optional, and absent means "ordinary floor" — the answer everywhere on the
   * ship but inside two open hatchways, and the reading that keeps every
   * existing environment and test valid without a word.
   */
  readonly climbable?: boolean;
  /** Keep horizontal input on this ladder until the acquired rung is reached. */
  readonly climbLocked?: boolean;
}

/**
 * A solid, as a horizontal segment with a radius and a band of heights.
 *
 * Structurally what `deckObstacles.ts` produces. Declared here rather than
 * imported so the body does not depend on a particular ship.
 */
export interface BlockingColumn {
  readonly name: string;
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  readonly radius: number;
  readonly yLo: number;
  readonly yHi: number;
}

export interface DeckEnvironment {
  /**
   * The floor under a position, for a body that can get its feet as high as
   * `reachY`.
   *
   * The height is not optional and it is not a hint. A ship with a cabin under
   * its quarterdeck has two floors at the same (x, z), and which of them a body
   * is standing on is a fact about the body — so a query without one has no
   * answer, and a defaulted one would quietly hand back the single-storey
   * answer that M3 was built on. `Infinity` is the honest way to ask for the
   * topmost surface, and `placeAt` is where that is spelled.
   */
  standAt(x: number, z: number, reachY: number): StandResult | null;
  readonly columns: readonly BlockingColumn[];
}

export interface WalkerTuning {
  /** Eye above the feet, metres. */
  eyeHeight: number;
  /** Top of the head above the feet — what decides whether a spar blocks. */
  standingHeight: number;
  /** Body radius, metres. */
  radius: number;
  /** Tallest rise the walker steps up in one move. */
  stepUp: number;
  /**
   * Solids whose top is below this height above the feet are stepped over
   * rather than walked into. The sheet horses are 0.34 m of shin-high iron bar
   * that `rig.ts` says in as many words is "meant to be stepped over".
   */
  stepOver: number;
  /** Level walking speed, m/s. */
  walkSpeed: number;
  /**
   * Time constant of the approach to the commanded velocity — also friction.
   * Zero is legal and means instant: full speed on the first frame of input.
   */
  responseTau: number;
  /**
   * How long the eye takes to catch up after stepping *up*, seconds.
   *
   * The body's height is resolved instantly, because a foot is either on the
   * step or it is not and a lagging collision height is a lagging wall. What
   * lags is the presentation: the eye keeps the height it had and closes the
   * gap over this long, which is what a knee does. Zero puts the whole rise in
   * one frame, and a 0.18 m step taken that way reads as a jolt rather than as
   * a stride. Only upward — dropping is gravity's business and already smooth.
   */
  stepSmoothing: number;
  /**
   * Vertical acceleration of the presented feet after their support drops, m/s².
   *
   * Deliberately gentler than physical gravity. In first person a one-metre
   * shipboard drop at 9.81 m/s² is over in four tenths of a second, which reads
   * as a teleport once the body also has to duck. The in-plane `gravity` below
   * remains physical for collision and deck motion; this is the authored
   * movement the camera shows for a person lowering into a hold rather than a
   * loose object's instantaneous gameplay position.
   */
  fallGravity: number;
  /** Time for the presented body to fold down into a lower posture, seconds. */
  duckSmoothing: number;
  /**
   * Time for the presented body to stand up while climbing out, seconds.
   * Longer than the descent because the body is hauling itself up a ladder.
   */
  climbSmoothing: number;
  /**
   * How fast a body goes up or down a ladder, m/s.
   *
   * **The same number both ways, and that is the point.** Before this the two
   * directions were two different accidents. Going up, each rung was an
   * ordinary step, so the body arrived at the top of a seven-rung ladder in
   * about a tenth of a second and only the camera lagged — a teleport with a
   * smear on it. Going down, the shaft was empty air, so the body fell at
   * 9.81 m/s² while the camera spent the distance at the gentler authored
   * 4.2 — a drop with a lag, and a drop is not how anyone leaves a forecastle.
   *
   * Capping the body's own vertical rate while it is on a rung makes both
   * directions the same deliberate climb, and makes the camera's job trivial:
   * it has almost nothing to catch up on, because nothing teleported.
   *
   * 1.2 m/s is brisk for a ladder and right for a 2 m scuttle — about 1.6 s
   * from the forecastle sole to the planking, long enough to read as a climb
   * and short enough that nobody waits. A sailor in a hurry beats it; a player
   * who does it twenty times a voyage does not want them to.
   */
  ladderSpeed: number;
  /**
   * How much of gravity's in-plane pull on a heeled deck the walker feels.
   *
   * Not a physical constant: a real sailor braces, and a player at a desk has no
   * way to. Zero is a magnet-boots walk that ignores a 20° heel; one is a
   * frictionless deck. The default is deliberately low and is a slider.
   */
  slip: number;
  gravity: number;
  /**
   * The least floor-to-ceiling a body walks through at full speed, metres.
   *
   * Not the standing height. A deckhead lower than your head is something you
   * duck under, not a wall — the cabin runs 1.84 m at its forward bulkhead
   * against a 1.75 m body. So low headroom lowers the eye (see `eyeY`) rather
   * than stopping anybody.
   *
   * **This used to be the refusal too, and it was the wrong number for that
   * job by a factor of nearly two.** Its own comment said it refused only when
   * a gap "stops being a space a person could get through at all" — and 1.15 m
   * is a *squat*, upright on your haunches with your head up, which is nowhere
   * near the limit of what a person can get through. Ash settled it by
   * measurement rather than by argument: he shuffled under a 0.68 m desk. The
   * refusal is `crawlHeight` now and this is what it always actually meant.
   */
  crouchHeight: number;
  /**
   * The least floor-to-ceiling a body will enter at all, metres.
   *
   * 0.75 — above Ash's measured 0.68 m, with the margin on the side that
   * refuses. Between this and `crouchHeight` a body is on its hands and knees
   * and moves at `crawlSpeed`; below it the gap is refused.
   *
   * **The room this exists for is the hold.** Its working well under the
   * hatchway is 0.92 m clear from the top of the ballast to the platform sole,
   * because the ballast is *solved* to close Archimedes and the sole height is
   * `SHIP_BELOW_DECKS_PLAN.md` §3's own decision — neither is ours to spend. A
   * hold is a place you go down on your knees in, and the alternative to this
   * constant was buying 0.29 m out of the ship's stability or out of the
   * wardroom's headroom to let a squatting body in.
   */
  crawlHeight: number;
  /**
   * Speed on hands and knees, m/s.
   *
   * Not a gameplay tax. It is most of what makes a crawl read as a crawl: the
   * eye is already low because `eyeY` ducks it, but a body that shuffles into
   * the hold at a brisk 3 m/s reads as a short room rather than as a hold.
   */
  crawlSpeed: number;
  /** How far the eye stays under a deckhead when it has to duck, metres. */
  headClearance: number;
}

/**
 * What fraction of each rung's rise the eye is allowed to lag behind by.
 *
 * A sixth. The body climbs at a constant rate, and a constant rate presented
 * exactly is a lift rather than a ladder — the rungs stop reading as rungs. A
 * small lag on each one puts the sway back without reintroducing the smear the
 * cap was added to remove.
 */
const LADDER_STEP_LAG = 1 / 6;

export const DEFAULT_WALKER_TUNING: WalkerTuning = {
  // **1.60 m eye, Ash's, dropped from 1.62.** Period-plausible for the era and
  // the figure the boom clearances were measured against was the old one — see
  // `ship-deck.test.ts`, which asserts those clearances against this tuning
  // rather than against a copy, so lowering the eye can only make them safer.
  eyeHeight: 1.6,
  // The body, not the eye, and it is doing three jobs — none of which is
  // "where you look from", which is why moving it appears to do nothing:
  //
  //  - `crownToEye` is `standingHeight - eyeHeight`, the skull above the eye.
  //    `eyeHeightFor` clamps the eye down by whatever the *crown* is over when
  //    the deckhead is low, so this is what makes you duck rather than clip;
  //  - `posture()` calls it a stoop below `standingHeight + headClearance`;
  //  - the collider ignores any column whose foot is above `y + standingHeight`
  //    — it is the height of the cylinder, so it is what you can walk *under*.
  //
  // All three only bite where something is low overhead. On the weather deck
  // and in a 2.0 m cabin nothing is, which is exactly why it looks inert.
  //
  // Left at 1.75 while the eye came down, so the crown gap is 0.15 m rather
  // than 0.13. That is a slightly taller skull on the same body and it makes
  // the walker duck a shade earlier under the beams — flagged rather than
  // adjusted, because the body's height is a separate decision from the eye's.
  standingHeight: 1.75,
  radius: 0.26,
  stepUp: 0.32,
  stepOver: 0.4,
  // 3.0 m/s is brisk for a walk — a shade under a jog — and it is what the deck
  // wants: she is 15.5 m long, so a slower body spends the whole voyage in
  // transit between the two places worth standing.
  walkSpeed: 3,
  // Instant, by Ash's call after walking her. A ramp on a body that is already
  // being carried by a heaving deck reads as the deck's lag, not the legs'.
  responseTau: 0,
  stepSmoothing: 0.12,
  fallGravity: 4.2,
  duckSmoothing: 0.75,
  climbSmoothing: 1.05,
  ladderSpeed: 1.2,
  slip: 0.35,
  gravity: 9.81,
  crouchHeight: 1.15,
  crawlHeight: 0.75,
  crawlSpeed: 0.9,
  headClearance: 0.06,
};

export interface WalkerInput {
  /** Forward on the walker's facing, −1 to 1. */
  forward: number;
  /** Right of the walker's facing, −1 to 1. */
  right: number;
  /** Facing, ship-relative radians, as the embodied camera holds it. */
  yaw: number;
}

/** World down, expressed in ship-local coordinates. */
export interface LocalGravity {
  x: number;
  y: number;
  z: number;
}

const UPRIGHT_GRAVITY: LocalGravity = { x: 0, y: -1, z: 0 };

export class DeckWalker {
  readonly tuning: WalkerTuning = { ...DEFAULT_WALKER_TUNING };

  /** Ship-local position of the feet. */
  x = 0;
  y = 0;
  z = 0;

  /** Ship-local horizontal velocity, m/s. */
  vx = 0;
  vz = 0;
  /** Vertical velocity, only non-zero when the deck has dropped away. */
  vy = 0;

  grounded = true;

  /** What the walker last ran into, for the debug panel. */
  lastContact: string | null = null;

  /** Underside of whatever is over the walker's head. `Infinity` under open sky. */
  ceilingY = Infinity;

  /** How far the eye is still behind the feet after a step up, metres. */
  private stepLag = 0;

  /**
   * How far the presented feet remain above their collision position in a fall.
   * Collision keeps physical gravity; this lag spends the same drop again at
   * `fallGravity`, so presentation can be gentle without changing walkability.
   */
  private fallLag = 0;
  private fallPresentationVelocity = 0;

  /**
   * Presented eye height above the feet.
   *
   * This is normally the authored standing/ducked height immediately. Across a
   * real change of level, however, it eases at the same time as the feet fall or
   * climb. Keeping it separate is what lets opening the boards show one joined
   * fall-and-stoop instead of clamping the camera under the sole in one frame.
   */
  private presentedEyeHeight = DEFAULT_WALKER_TUNING.eyeHeight;
  private eyeHeightFrom = DEFAULT_WALKER_TUNING.eyeHeight;
  private eyeHeightTarget = DEFAULT_WALKER_TUNING.eyeHeight;
  private eyeHeightElapsed = 0;
  private eyeHeightDuration = 0;

  /** Floor currently supporting (or waiting below) the body. */
  private supportY = 0;

  /** A step made while rising out of a crawl is presented as a ladder climb. */
  private climbing = false;

  constructor(private environment: DeckEnvironment) {}

  setEnvironment(environment: DeckEnvironment): void {
    this.environment = environment;
  }

  /**
   * The highest surface this body could get its feet onto from where it is.
   *
   * The whole of the two-storey rule, on this side of the contract. The
   * environment is handed a height and never learns the body's stride, so a
   * second kind of body — a crawling one, a climbing one — changes this one
   * expression and nothing about the ship.
   */
  private reachY(): number {
    return this.y + this.tuning.stepUp;
  }

  /**
   * Put the walker down at a position.
   *
   * `fromY` chooses the storey: omit it and the walker lands on the topmost
   * surface, which is the weather deck and is what every existing caller means.
   * Pass a height to put a body below decks — the cabin sole is under the
   * quarterdeck, and "on the ship at (x, z)" stopped being a complete
   * instruction the moment that was true.
   */
  placeAt(x: number, z: number, fromY?: number): boolean {
    const reach = fromY === undefined ? Infinity : fromY + this.tuning.stepUp;
    const stand = this.environment.standAt(x, z, reach);
    if (!stand) return false;
    this.x = x;
    this.z = z;
    this.y = stand.y;
    this.ceilingY = stand.ceilingY;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.stepLag = 0;
    this.fallLag = 0;
    this.fallPresentationVelocity = 0;
    this.supportY = stand.y;
    this.setEyeHeightImmediately(this.eyeHeightFor(stand.y, stand.ceilingY));
    this.climbing = false;
    this.grounded = true;
    return true;
  }

  /**
   * The eye, in ship-local coordinates.
   *
   * Presented feet, less the step they are still catching up on, plus the
   * presented posture. At rest the crown is never closer to the deckhead than
   * `headClearance`. A real level transition is the exception: while crossing
   * an open plane, the old posture is allowed to ease through it instead of
   * snapping to the destination's headroom before the body has moved.
   *
   * Collision height still resolves immediately, because a lagging collision
   * height is a lagging wall; only what the player sees is free to bend. A cabin
   * with 1.84 m of clear height and a 1.75 m body needs no duck at all; the hold
   * will need it every step.
   */
  eyeY(): number {
    return this.y + this.fallLag - this.stepLag + this.presentedEyeHeight;
  }

  /** Skull above the eye — where the head actually stops. */
  private crownToEye(): number {
    const t = this.tuning;
    return Math.max(t.standingHeight - t.eyeHeight, 0);
  }

  /** Eye above the feet for a body supported by this floor and ceiling. */
  private eyeHeightFor(supportY: number, ceilingY: number): number {
    const t = this.tuning;
    // **The clamp is to the crown, not to the eye.** `headClearance` is the air
    // between the top of the head and the timber, and the top of the head is
    // `standingHeight - eyeHeight` above the eye — 0.13 m on this body.
    return Math.min(t.eyeHeight, ceilingY - supportY - this.crownToEye() - t.headClearance);
  }

  private setEyeHeightImmediately(height: number): void {
    this.presentedEyeHeight = height;
    this.eyeHeightFrom = height;
    this.eyeHeightTarget = height;
    this.eyeHeightElapsed = 0;
    this.eyeHeightDuration = 0;
  }

  /**
   * Begin a posture change without introducing a second visible phase.
   *
   * Smoothstep has zero velocity at both ends. Downward it begins alongside
   * the gravity-driven feet rather than snapping; upward it blends standing up
   * into the slower rung climb. Retargeting starts from the value already on
   * screen, so catching a fall by laying the boards cannot jump either.
   */
  private setEyeHeight(height: number, smooth: boolean): void {
    if (Math.abs(height - this.eyeHeightTarget) < 1e-6) return;
    if (!smooth) {
      this.setEyeHeightImmediately(height);
      return;
    }
    this.eyeHeightFrom = this.presentedEyeHeight;
    this.eyeHeightTarget = height;
    this.eyeHeightElapsed = 0;
    this.eyeHeightDuration =
      height < this.presentedEyeHeight ? this.tuning.duckSmoothing : this.tuning.climbSmoothing;
  }

  private updateEyeHeight(dt: number): void {
    if (this.eyeHeightDuration <= 0) return;
    this.eyeHeightElapsed = Math.min(this.eyeHeightElapsed + dt, this.eyeHeightDuration);
    const u = this.eyeHeightElapsed / this.eyeHeightDuration;
    const eased = u * u * (3 - 2 * u);
    this.presentedEyeHeight =
      this.eyeHeightFrom + (this.eyeHeightTarget - this.eyeHeightFrom) * eased;
    if (u >= 1) {
      this.presentedEyeHeight = this.eyeHeightTarget;
      this.eyeHeightDuration = 0;
    }
  }

  /**
   * Clear height over the body's own feet — `Infinity` under open sky.
   *
   * The one question three separate things ask: what speed the body moves at,
   * what posture the panel reports, and whether it is standing, stooping or on
   * its hands and knees. Asked once here so those three cannot disagree.
   */
  headroom(): number {
    return this.ceilingY - this.y;
  }

  /**
   * What the body is doing with its height, as a word.
   *
   * For the debug panel and for tests, so a posture assertion reads as a
   * posture rather than as an inequality on two constants.
   */
  posture(): 'stand' | 'stoop' | 'crawl' {
    const t = this.tuning;
    const clear = this.headroom();
    if (clear < t.crouchHeight) return 'crawl';
    if (clear < t.standingHeight + t.headClearance) return 'stoop';
    return 'stand';
  }

  /**
   * Diagnostic hold: while set, the body stays exactly where `placeAt` put
   * it — no input, no heel slip, no gravity.
   *
   * For deterministic captures only. The inspection harness placed a body on
   * the waist deck, waited a few seconds for the light to settle, and the
   * heel slip poured it half a metre aft and down the open companionway —
   * every frame of waiting moved the eye the capture was waiting to steady.
   */
  private held = false;

  setHeld(held: boolean): void {
    this.held = held;
  }

  step(dt: number, input: WalkerInput, gravityLocal: LocalGravity = UPRIGHT_GRAVITY): void {
    if (dt <= 0) return;
    if (this.held) return;
    const t = this.tuning;

    // The camera looks down its own −Z, so a yaw of zero faces aft on a ship
    // whose +z is the bow. This is the same convention the embodied controller
    // stores its look in, which is why the two need no adaptor between them.
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    const forwardX = -sin;
    const forwardZ = -cos;
    const rightX = cos;
    const rightZ = -sin;

    let wishX = forwardX * input.forward + rightX * input.right;
    let wishZ = forwardZ * input.forward + rightZ * input.right;
    const wishLength = Math.hypot(wishX, wishZ);
    if (wishLength > 1) {
      wishX /= wishLength;
      wishZ /= wishLength;
    }

    // Speed is a posture, and the posture is read off the headroom the body is
    // actually under. A crawl that moved at a walk's 3 m/s would read as a
    // short room rather than as a hold — which is the whole difference between
    // the two, since the eye is low in both.
    const speed = this.headroom() < t.crouchHeight ? t.crawlSpeed : t.walkSpeed;
    const approach = 1 - Math.exp(-dt / Math.max(t.responseTau, 1e-3));
    this.vx += (wishX * speed - this.vx) * approach;
    this.vz += (wishZ * speed - this.vz) * approach;

    // Gravity's in-plane component: zero upright, and what makes a heeled deck
    // something you lean into.
    this.vx += gravityLocal.x * t.gravity * t.slip * dt;
    this.vz += gravityLocal.z * t.gravity * t.slip * dt;

    this.lastContact = null;
    // A compact near-vertical ladder has much less fore-and-aft acquisition
    // room than a stair or the long hold ladder. Once one of its rungs is
    // acquired, finish that vertical travel before held forward input carries
    // the body out of the ladder's footprint and back onto the floor below.
    const supportBeforeMove = this.environment.standAt(this.x, this.z, this.reachY());
    const settlingOnLockedLadder =
      supportBeforeMove?.climbLocked === true &&
      Math.abs(supportBeforeMove.y - this.y) > 1e-4;
    if (settlingOnLockedLadder) {
      this.vx = 0;
      this.vz = 0;
    } else {
      this.moveHorizontally(this.vx * dt, this.vz * dt);
    }
    const yBeforeSettlement = this.y;
    this.settleVertically(dt);
    if (this.y < yBeforeSettlement) this.fallLag += yBeforeSettlement - this.y;

    // Collision falls at physical gravity. The camera spends that accumulated
    // distance at the gentler authored acceleration, starting from rest, which
    // preserves both responsive walking and a readable first-person descent.
    if (this.fallLag > 0) {
      this.fallPresentationVelocity += t.fallGravity * dt;
      const descent = this.fallPresentationVelocity * dt;
      if (descent >= this.fallLag) {
        this.fallLag = 0;
        this.fallPresentationVelocity = 0;
      } else {
        this.fallLag -= descent;
      }
    }

    // Posture and level change together. Updating after the support query means
    // the very first frame sees only the beginning of the ease, not its end.
    this.updateEyeHeight(dt);

    // The eye closes on the feet. Exponential rather than linear, so the last
    // millimetres are not a visible arrival.
    if (this.stepLag !== 0) {
      const tau = Math.max(this.climbing ? t.climbSmoothing * 0.45 : t.stepSmoothing, 1e-4);
      this.stepLag *= Math.exp(-dt / tau);
      if (Math.abs(this.stepLag) < 1e-4) {
        this.stepLag = 0;
        if (this.eyeHeightDuration === 0) this.climbing = false;
      }
    }
  }

  /**
   * Move, and slide rather than stop when the whole move is refused.
   *
   * Trying each axis separately after the combined move fails is what turns a
   * bulwark into something you walk *along*. Without it, approaching the rail at
   * any angle but square stops the player dead, which reads as the deck being
   * covered in invisible corners.
   */
  private moveHorizontally(dx: number, dz: number): void {
    if (this.attemptMove(dx, dz)) return;
    const movedX = Math.abs(dx) > 1e-9 && this.attemptMove(dx, 0);
    const movedZ = Math.abs(dz) > 1e-9 && this.attemptMove(0, dz);
    if (!movedX) this.vx = 0;
    if (!movedZ) this.vz = 0;
  }

  /**
   * One attempted move, with contact resolution. Public because it is also the
   * primitive the reachability test drives: asking "can a body get from here to
   * there" has to go through the same routine the player does, or it proves
   * something about a second walker nobody plays.
   */
  attemptMove(dx: number, dz: number): boolean {
    const t = this.tuning;
    let x = this.x + dx;
    let z = this.z + dz;

    // Push out of anything solid, three passes: one contact can push a body into
    // a second, and the fife rail's board and its two stanchions are exactly
    // that arrangement.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const column of this.environment.columns) {
        if (column.yHi <= this.y + t.stepOver) continue;
        if (column.yLo >= this.y + t.standingHeight) continue;
        const near = nearestOnSegment(column, x, z);
        const reach = column.radius + t.radius;
        if (near.distance >= reach) continue;
        this.lastContact = column.name;
        if (near.distance < 1e-6) {
          // Dead centre of a column: push forward along the body's own motion,
          // which is the only direction that carries information here.
          const length = Math.hypot(dx, dz) || 1;
          x += (dx / length) * reach;
          z += (dz / length) * reach;
        } else {
          const scale = (reach - near.distance) / near.distance;
          x += (x - near.x) * scale;
          z += (z - near.z) * scale;
        }
        moved = true;
      }
      if (!moved) break;
    }

    const reach = this.reachY();
    const stand = this.environment.standAt(x, z, reach);
    if (!stand) return false;
    // A body is not a point. Testing only the centre lets a walker stand with
    // half of themselves out over the sea, which at the bow — where the deck
    // narrows to 0.52 m of half-breadth — is most of them.
    if (!this.footprintOnDeck(x, z, reach)) return false;
    // A rise taller than a step is a wall — the quarterdeck break is 0.55 m and
    // is climbed at the ladders, not walked into.
    if (stand.y - this.y > t.stepUp) return false;
    // And a gap too low to get through is a wall lying down. This is what stops
    // a body at the foot of the companion ladder from walking sideways out of
    // the opening into the 80 mm between the top tread and the deck beams.
    //
    // **`crawlHeight`, not `crouchHeight`.** A gap between the two is one a
    // person gets through on hands and knees, which is what the hold is; the
    // 80 mm above is refused by either. The eye is already handled — `eyeY`
    // ducks it under the deckhead however low that is.
    if (stand.ceilingY - stand.y < t.crawlHeight) return false;

    this.x = x;
    this.z = z;
    return true;
  }

  /**
   * The four probes round the body, asked at the *same* reach as its centre.
   *
   * Passing the reach matters more than it looks. Without it each probe would
   * pick its own storey, so a body standing at the edge of the companionway
   * would have one foot answered by the quarterdeck and the other by the cabin
   * sole two metres below — both non-null, both plausible, and the check would
   * pass on a footprint spanning two decks.
   */
  private footprintOnDeck(x: number, z: number, reach: number): boolean {
    const r = this.tuning.radius;
    return (
      this.environment.standAt(x + r, z, reach) !== null &&
      this.environment.standAt(x - r, z, reach) !== null &&
      this.environment.standAt(x, z + r, reach) !== null &&
      this.environment.standAt(x, z - r, reach) !== null
    );
  }

  /**
   * Follow the floor: step up onto it, or fall to it.
   *
   * The fall matters more than it sounds. A deck that pitches away under a
   * walker leaves them briefly unsupported, and a controller that simply pins
   * the feet to the surface removes exactly the sensation the ship is there to
   * produce.
   */
  private settleVertically(dt: number): void {
    const stand = this.environment.standAt(this.x, this.z, this.reachY());
    if (!stand) {
      this.grounded = true;
      return;
    }
    const oldSupportY = this.supportY;
    const levelChanged = Math.abs(stand.y - oldSupportY) > 1e-4;
    const dropping = stand.y < this.y - 1e-4;
    const risingFromLowPosture =
      stand.y > this.y + 1e-4 &&
      (this.eyeHeightTarget < this.tuning.eyeHeight - 1e-4 ||
        this.presentedEyeHeight < this.tuning.eyeHeight - 1e-4);

    this.supportY = stand.y;
    this.ceilingY = stand.ceilingY;
    const desiredEyeHeight = this.eyeHeightFor(stand.y, stand.ceilingY);
    // Only a level transition is allowed to carry the head temporarily through
    // the old plane. Walking under an ordinary low beam still ducks at once.
    this.setEyeHeight(desiredEyeHeight, levelChanged && (dropping || risingFromLowPosture));

    if (this.y <= stand.y + 1e-4) {
      const rise = stand.y - this.y;
      if (stand.climbable && rise > 1e-6) {
        // **A rung is climbed, not strode onto.** The body itself is rate-
        // limited here rather than only the camera, and that is the whole
        // repair: seven rungs are seven ordinary steps, each legal on its own,
        // and a body that takes them as fast as the floor query offers them is
        // at the top of a 2 m ladder in about a tenth of a second. Capping the
        // body means there is nothing for the eye to catch up on — the climb is
        // the motion, not a smear over a teleport.
        const climb = Math.min(rise, this.tuning.ladderSpeed * dt);
        this.y += climb;
        // A sliver of lag still, so the rungs read as rungs rather than as a
        // lift. Without it a constant-rate rise is perfectly linear and reads
        // as machinery.
        this.stepLag += climb * LADDER_STEP_LAG;
        this.climbing = true;
        this.vy = 0;
        this.grounded = true;
        return;
      }
      // Stepping up: the body arrives now, the eye follows.
      this.stepLag += rise;
      if (risingFromLowPosture) this.climbing = true;
      this.y = stand.y;
      this.vy = 0;
      this.grounded = true;
      return;
    }
    this.vy -= this.tuning.gravity * dt;
    // **Going down a ladder is a climb, not a fall.** The rung under the body
    // says so; without this the same 2 m shaft it now takes 1.6 s to climb is
    // dropped in 0.6, and the camera spends the rest of a second catching up
    // from behind the planking.
    if (stand.climbable) {
      this.vy = Math.max(this.vy, -this.tuning.ladderSpeed);
      this.climbing = true;
    }
    this.y += this.vy * dt;
    if (this.y <= stand.y) {
      this.y = stand.y;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = false;
    }
  }
}

function nearestOnSegment(
  column: BlockingColumn,
  x: number,
  z: number,
): { x: number; z: number; distance: number } {
  const dx = column.x1 - column.x0;
  const dz = column.z1 - column.z0;
  const lengthSq = dx * dx + dz * dz;
  let t = 0;
  if (lengthSq > 1e-12) {
    t = ((x - column.x0) * dx + (z - column.z0) * dz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const nx = column.x0 + dx * t;
  const nz = column.z0 + dz * t;
  return { x: nx, z: nz, distance: Math.hypot(x - nx, z - nz) };
}
