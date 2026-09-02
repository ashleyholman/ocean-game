import type { InteractableBox } from '../../player/Interactables';
import { climbAnchors, shroudApproach, shroudTarget } from './riggingClimb';
import type { ClimbSide } from './riggingClimb';
import { FOREMAST_Z } from './rig';
import type { StationName } from './seatState';
import { isAtTheFoot } from './aloftState';

/** The lower mast is a valid gaze target for taking the shrouds beside it. */
export function climbMastTarget(side: ClimbSide): InteractableBox {
  const deckY = climbAnchors(side)[0].hold.y;
  return {
    xLo: -0.3,
    xHi: 0.3,
    yLo: deckY,
    // Through the lower masthead: a gaze "up the mast" intersects this face
    // rather than leaving the climb target below the centre of view.
    yHi: deckY + 10,
    zLo: FOREMAST_Z - 0.38,
    zHi: FOREMAST_Z + 0.38,
  };
}

/** What may express climbing intent: the gang itself, or the mast it serves. */
export function climbGazeTargets(side: ClimbSide): readonly InteractableBox[] {
  return [shroudTarget(side), climbMastTarget(side)];
}

/**
 * The side and station of weather deck from which this gang can be taken.
 *
 * `shroudApproach` deliberately extends below the deck by 0.4 m as geometric
 * tolerance. That was harmless while only a standing body was considered and
 * became a storey leak once the eye in the forecastle fell inside it. Clamping
 * the interaction volume to the actual climb-start deck preserves all plan
 * tolerance and makes "above this deck" explicit.
 */
export function climbReachVolume(side: ClimbSide): InteractableBox {
  const approach = shroudApproach(side);
  const deckY = climbAnchors(side)[0].hold.y;
  return { ...approach, yLo: Math.max(approach.yLo, deckY) };
}

/** Close enough that continued walking would put the body into the shrouds. */
export const WALK_INTO_CLIMB_DISTANCE = 0.45;

/** A deliberate walk must point broadly toward the gang, not merely pass it. */
const WALK_INTO_CLIMB_DOT = Math.cos((50 * Math.PI) / 180);

function inside(point: { x: number; y: number; z: number }, box: InteractableBox): boolean {
  return (
    point.x >= box.xLo &&
    point.x <= box.xHi &&
    point.y >= box.yLo &&
    point.y <= box.yHi &&
    point.z >= box.zLo &&
    point.z <= box.zHi
  );
}

/** Ship-local horizontal direction produced by the same axes the walker uses. */
export function walkingDirection(
  axes: { forward: number; right: number },
  yaw: number,
): { x: number; z: number } | null {
  const x = -Math.sin(yaw) * axes.forward + Math.cos(yaw) * axes.right;
  const z = -Math.cos(yaw) * axes.forward - Math.sin(yaw) * axes.right;
  const length = Math.hypot(x, z);
  if (length < 0.15) return null;
  return { x: x / length, z: z / length };
}

/**
 * Which gang a body is walking into, if any.
 *
 * Uses the shroud target, not the mast's gaze target: looking at a mast can mean
 * "go aloft", but walking inboard into its timber cannot. Entry happens only at
 * body distance, only from the weather-deck side, and only while motion carries
 * the body toward the ropes.
 */
export function climbWalkEntry(
  eye: { x: number; y: number; z: number },
  axes: { forward: number; right: number },
  yaw: number,
): StationName | null {
  const wish = walkingDirection(axes, yaw);
  if (!wish) return null;
  let best: { name: StationName; distance: number } | null = null;
  for (const side of [1, -1] as const) {
    if (!inside(eye, climbReachVolume(side))) continue;
    const target = shroudTarget(side);
    const nearX = Math.min(Math.max(eye.x, target.xLo), target.xHi);
    const nearZ = Math.min(Math.max(eye.z, target.zLo), target.zHi);
    const dx = nearX - eye.x;
    const dz = nearZ - eye.z;
    const distance = Math.hypot(dx, dz);
    if (distance > WALK_INTO_CLIMB_DISTANCE || distance < 1e-6) continue;
    if ((wish.x * dx + wish.z * dz) / distance < WALK_INTO_CLIMB_DOT) continue;
    const name: StationName = side > 0 ? 'climbPort' : 'climbStarboard';
    if (!best || distance < best.distance) best = { name, distance };
  }
  return best?.name ?? null;
}

/** Holding the descent input through the last rung is a deliberate walk off. */
export function shouldWalkOffClimb(side: ClimbSide, forward: number): boolean {
  return forward < -0.1 && isAtTheFoot(side);
}
