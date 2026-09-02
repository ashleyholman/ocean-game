import type { SeatPose } from '../../player/SeatedStation';
import { frameToShip } from './roomFitting';
import type { PieceFrame } from './roomFitting';

/**
 * How a body sits and lies in the furniture, and where that puts its eye.
 *
 * WHY THIS IS NOT IN THE FURNITURE
 * --------------------------------
 * Because it is not a fact about the furniture. A chart desk knows how high its
 * chair is; it has no business also knowing how far a man's eye is above the
 * board he is sitting on, and until this file existed it was the only thing
 * aboard that did — `SEATED_EYE_ABOVE_SEAT` lived in `captainsDesk.ts` because
 * the chair was the only seat in the ship. Two mess forms, a sea chest and six
 * berths later, copying it into each of them is the "two sources for one fact"
 * fault this hull has spent a year removing, with the extra twist that a body
 * that is 0.78 m tall sitting in one room and 0.76 m in the next is a room that
 * changes size when you walk into it.
 *
 * So: **the furniture publishes where its seat and its mattress are, and this
 * publishes what a body does with them.** The two poses below are the whole of
 * the vocabulary, and every station aboard goes through one of them.
 *
 * THE FRAME
 * ---------
 * Both builders take a piece's own `PieceFrame` and its own local coordinates,
 * because the pieces they serve are laid along a curving ship's side and their
 * dimensions are only writeable in their own axes — `roomFitting.PieceFrame`
 * sets that out. Both convert **the position and the heading**, and the
 * captain's desk records what happens when a round converts only one of them:
 * position alone and the sitter faces the lining at a slight angle; heading
 * alone and he sits square to a room he is not aimed at.
 */

/**
 * How far a seated man's eye is above the seat he is on.
 *
 * 0.78 m. Sitting height — crown to seat — is about 0.90 m for a 1.75 m man,
 * which is `WalkerTuning.standingHeight`, and the eye is a little under a hand
 * below the crown. It is derived from the same body the walker is rather than
 * picked, because a seated eye that does not match the standing one makes the
 * room change size when you sit down.
 */
export const SEATED_EYE_ABOVE_SEAT = 0.78;

/**
 * How far a lying man's eye is above the mattress he is on.
 *
 * 0.16 m, and it is two things added up rather than a guess: a bolster is about
 * 80 mm thick — the berths draw theirs at 70 to 85 — and the eye is roughly
 * half a head above whatever the head is resting on, which is another 80.
 *
 * **The number that matters is what it clears.** In every berth aboard this
 * lands the eye a few centimetres *above* the lee board and well below the
 * tier or the deckhead over it, which is the geometry of lying in a bunk: you
 * can see out over the board into the room, and you cannot sit up.
 */
export const LYING_EYE_ABOVE_MATTRESS = 0.16;

/**
 * How far from the head board the eye lies, along the berth.
 *
 * 0.26 m. Every berth aboard draws its bolster between 0.28 and 0.40 m from the
 * head board, so this puts the eye over the pillow in all six rather than over
 * the bare boards at the very end of the bed — which is where a body whose
 * "head position" was the head board itself would have its skull inside the
 * timber.
 */
const LYING_HEAD_INSET = 0.26;

/**
 * How much of the air over a bunk bottom counts as the berth, for aiming.
 *
 * 0.50 m — a body lying down, and no more, because the crew's bunks are in two
 * tiers 0.76 m apart and a target that reached the deckhead would make the
 * lower bunk and the upper one one object to point at. The officers' berths and
 * the captain's have nothing over them and take the same figure anyway: a
 * target that means "the bed" in one room and "the bed and all the air above
 * it" in another is a target a player has to learn twice.
 *
 * Here rather than in either room's furniture, for the reason the eye heights
 * are: it is a fact about the body that lies in a berth, not about any
 * particular berth.
 */
export const BERTH_MOUTH_HEIGHT = 0.50;

const HALF_PI = Math.PI / 2;

/** Degrees, because every pose below is authored in them. */
function rad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Which way the camera looks to face along one of a piece's own axes.
 *
 * The camera looks down its own −Z, so a yaw of 0 faces the ship's −z and a yaw
 * of −π/2 faces +x. Turning the piece turns all four: facing the frame's −z is
 * the frame's own yaw, and the other three are quarter turns off it.
 *
 * **This is the one place the four are written down**, and it exists because
 * the desk got it right by working it out in a comment and nothing else could
 * have. Every station aboard names a direction in its own frame — *inboard*,
 * *toward the foot of the bed* — and the conversion is the same four lines
 * every time.
 */
export type FrameFacing = 'aftward' | 'forward' | 'framePlusX' | 'frameMinusX';

export function facingYaw(frame: PieceFrame, facing: FrameFacing): number {
  switch (facing) {
    case 'aftward':
      return frame.yaw;
    case 'forward':
      return frame.yaw + Math.PI;
    case 'framePlusX':
      return frame.yaw - HALF_PI;
    case 'frameMinusX':
      return frame.yaw + HALF_PI;
  }
}

export interface SeatedAt {
  /** The piece's own frame — the axes `x` and `z` below are in. */
  readonly frame: PieceFrame;
  /** Where the seat's middle is, in the piece's frame. */
  readonly x: number;
  readonly z: number;
  /** Top of the seat board, in the ship's y — heights need no frame. */
  readonly seatY: number;
  /** Which of the piece's own axes the sitter faces along. */
  readonly facing: FrameFacing;
  /**
   * How far the sitter leans that way, metres.
   *
   * A body at a table is not a body sitting upright on a stool, and the desk's
   * round found this the expensive way: without it the chair had to choose
   * between standing far enough off to frame the desk and tucking in close
   * enough to be at it. Applied to the eye alone — the seat, the knees and the
   * collider stay where the furniture is.
   */
  readonly lean?: number;
  /**
   * Where the eye settles and how far it may turn — **degrees, signed, up is
   * positive**, in all four fields and in `lyingPose` below.
   *
   * One convention, stated once, because the alternative is what the first cut
   * of this file had: a `pitchDown` that was negated on the way in beside a
   * `pitchLo` that was negated on the way in too, so a limit written as `-5`
   * meant five degrees *up*. Nothing would have thrown.
   */
  readonly pitch: number;
  readonly yawRange: number;
  readonly pitchLo: number;
  readonly pitchHi: number;
}

/** The pose of a body sitting on something. */
export function seatedPose(at: SeatedAt): SeatPose {
  const yaw = facingYaw(at.frame, at.facing);
  const lean = at.lean ?? 0;
  // The lean runs along the axis the sitter faces, in the piece's own frame, so
  // that leaning toward a table stays leaning toward it when the piece turns.
  const local = leanedLocal(at.x, at.z, at.facing, lean);
  const eye = frameToShip(at.frame, local.x, local.z);
  return {
    x: eye.x,
    y: at.seatY + SEATED_EYE_ABOVE_SEAT,
    z: eye.z,
    yaw,
    pitch: rad(at.pitch),
    yawRange: rad(at.yawRange),
    pitchLo: rad(at.pitchLo),
    pitchHi: rad(at.pitchHi),
  };
}

function leanedLocal(
  x: number,
  z: number,
  facing: FrameFacing,
  lean: number,
): { x: number; z: number } {
  switch (facing) {
    case 'aftward':
      return { x, z: z - lean };
    case 'forward':
      return { x, z: z + lean };
    case 'framePlusX':
      return { x: x + lean, z };
    case 'frameMinusX':
      return { x: x - lean, z };
  }
}

export interface LyingIn {
  /** The berth's own frame. */
  readonly frame: PieceFrame;
  /** The two faces of the bunk across its width, in the berth's frame. */
  readonly xInboard: number;
  readonly xOutboard: number;
  /**
   * The two ends, in the berth's frame — **the head first, and the order is the
   * fact.** Three of the seven berths aboard sleep head-forward and one sleeps
   * head-aft, each for a reason written beside the bolster that draws it, and a
   * lying pose that guessed would put a captain's skull where his feet are and
   * nothing at all would fail.
   */
  readonly zHead: number;
  readonly zFoot: number;
  /** Top of the mattress — what the body is lying on. */
  readonly mattressY: number;
}

/**
 * The pose of a body lying in a berth.
 *
 * **What a lying body looks at is the deckhead**, so the pose is pitched up
 * rather than down and the frame is the beams over the bunk. It is aimed along
 * the body toward the feet, which is the one direction a man in a bunk can look
 * without moving anything but his eyes; the cone lets him roll his head into
 * the room or against the ship's side, and it does not let him see the wall
 * behind his own pillow, which is what a neck is.
 *
 * 40° up is not the deckhead directly overhead: that would be a photograph of
 * planking. It is up and along the bed, which puts the beams across the top of
 * the frame and the room past your own feet across the bottom — the composition
 * of waking up in a bunk, and the only one from which you can tell which berth
 * you are in.
 */
export function lyingPose(at: LyingIn): SeatPose {
  const toward = at.zFoot > at.zHead ? 'forward' : 'aftward';
  const sign = at.zFoot > at.zHead ? 1 : -1;
  const local = {
    x: (at.xInboard + at.xOutboard) / 2,
    z: at.zHead + sign * LYING_HEAD_INSET,
  };
  const eye = frameToShip(at.frame, local.x, local.z);
  return {
    x: eye.x,
    y: at.mattressY + LYING_EYE_ABOVE_MATTRESS,
    z: eye.z,
    yaw: facingYaw(at.frame, toward),
    pitch: rad(40),
    // A head on a bolster, not a body on a swivel. Wide enough to look into the
    // room over the lee board and at the ship's side behind you; not wide
    // enough to face your own pillow.
    yawRange: rad(80),
    pitchLo: rad(-5),
    pitchHi: rad(75),
  };
}
