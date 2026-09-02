/**
 * How far up the rigging the body is, when it is up the rigging.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A FIELD ON `seatState.ts`
 * ------------------------------------------------------------
 * `seatState.ts` holds one name and resets it, and its own note is emphatic
 * about why it holds *nothing else*: it has no imports at all, and that is
 * load-bearing, because the loft, the walker and the seat controller all read
 * it and any import would put one of them in a cycle. Its rule is "nothing here
 * is geometry and nothing here is a dimension". A progress along a spline is a
 * dimension.
 *
 * It is also a different *kind* of state. Which station a body is in is a fact
 * about the ship's furniture and eleven of the twelve rows never change again
 * once taken. Where on a nine-metre path the body is changes sixty times a
 * second and is the only station aboard that has an inside.
 *
 * So: the name of the station stays in `seatState.ts` — a body is aloft when
 * `occupiedStation()` says `climbPort` or `climbStarboard`, and there is one
 * source for that — and *how far along* lives here. Same split, same reason, as
 * `closures.ts` and `shipClosures.ts`.
 *
 * WHY THE DESCENT IS A FLAG AND NOT A SECOND STATE MACHINE
 * --------------------------------------------------------
 * A player nine metres up needs one button that always works, and "Space" is
 * that button everywhere else aboard. Aloft it cannot simply let go — standing
 * up out of a chair puts the eye back on a body that is 0.6 m away, and doing
 * the same here would drop the camera nine metres into a body still standing on
 * the deck. So Space sets `layingDown`, the progress runs back down at the climb
 * rate, and the station releases when it reaches the foot. It is not a cutscene:
 * the look stays live throughout and any upward input cancels it, which is what
 * `advanceClimb` does on the first frame the player disagrees.
 */

import type { ClimbSide } from './riggingClimb';
import { CLIMB_SPEED, climbLength } from './riggingClimb';

/** Progress along the climb, 0 at the deck and 1 at the lookout. */
let progress = 0;
let layingDown = false;

export function climbProgress(): number {
  return progress;
}

/** True while Space has been pressed aloft and the body is on its way down. */
export function isLayingDown(): boolean {
  return layingDown;
}

/**
 * Put the body at a point on the climb.
 *
 * Used when the station is taken (at 0) and by the diagnostic entry point,
 * which puts a reviewer at the lookout without ten seconds of ladder.
 */
export function setClimbProgress(value: number): void {
  progress = Math.min(Math.max(value, 0), 1);
  if (progress > 0) layingDown = false;
}

export function beginLayingDown(): void {
  layingDown = true;
}

/**
 * How near the deck counts as being down.
 *
 * One frame of climbing at 60 Hz is 0.0175 m of path, so a body that stops
 * exactly at zero would need the last frame to land on it. This is two of them,
 * expressed as a distance rather than as a progress fraction because the two
 * gangs are not the same length and a fraction would mean different things on
 * the two sides of the ship.
 */
export const AT_THE_FOOT_METRES = 0.04;

export function isAtTheFoot(side: ClimbSide): boolean {
  return progress * climbLength(side) <= AT_THE_FOOT_METRES;
}

/**
 * Advance the climb by one frame.
 *
 * `forward` is the walker's own forward axis, so W climbs and S descends with
 * no second binding — the keys that move a body along a deck move it along a
 * ladder, which is the arrangement the fore scuttle already uses and the one a
 * player does not have to be told about.
 *
 * Returns true when the body has reached the deck under its own descent and the
 * station should let go of it.
 */
export function advanceClimb(side: ClimbSide, dt: number, forward: number): boolean {
  if (dt <= 0) return false;
  const perSecond = CLIMB_SPEED / climbLength(side);
  if (layingDown) {
    // Any deliberate move upward is a change of mind, and it wins immediately.
    if (forward > 0.1) layingDown = false;
    else {
      progress = Math.max(progress - perSecond * dt, 0);
      return isAtTheFoot(side);
    }
  }
  const wish = Math.min(Math.max(forward, -1), 1);
  progress = Math.min(Math.max(progress + wish * perSecond * dt, 0), 1);
  return false;
}

/** Back to how she starts. For tests, and for a fresh voyage. */
export function resetClimb(): void {
  progress = 0;
  layingDown = false;
}
