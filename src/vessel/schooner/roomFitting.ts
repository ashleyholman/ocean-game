import type { FittingSolid, StandablePanel } from './deckFittings';
import {
  belowDecksSpace,
  spaceDeckheadY,
  spaceSideHalfWidthAt,
} from './deckInterior';
import type { BelowDecksSpace, SpaceName } from './deckInterior';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * **How a thing below decks says where it is, and what a thing below decks is.**
 *
 * WHY AN ANCHOR AND NOT A COORDINATE
 * ----------------------------------
 * The arrangement is not settled. Ash has said in terms that the captain's door
 * may move to line up with the ladder, and every round below decks so far has
 * moved a bulkhead, a floor or an opening. A fitting written as `z = -1.35` is
 * correct until the wall beside it moves and is then silently wrong — which is
 * `hullForm.cabinHeadroomAt`, `INDEX_Y_LO` and the bilge pump's own mass entry
 * over again, the fault this ship has now found in five places and always the
 * same one: **two sources for one position.**
 *
 * So nothing anchored here carries a station. A fitting says *which room, which
 * bulkhead it stands off, which hand of the ship, and how far in* — and
 * `placeInRoom` resolves that against `deckInterior.ts`'s own tables. Move
 * `CABIN_FORWARD_Z` and the furniture in the cabin moves with it, because the
 * offset was always measured from the wall rather than from the keel.
 *
 * THE RULE THAT IS WORTH THE MODULE ON ITS OWN
 * -------------------------------------------
 * A box standing against the ship's side is the shape of fault this hull keeps
 * producing. The side **leans**: at the wardroom's after bulkhead the lined
 * half-width is 1.94 m at the sole and 2.06 m at head height, so a chest drawn
 * to the width it has at the floor stands 0.12 m off the planking at its top,
 * and one drawn to the width at its top is buried in the frames at its foot.
 * That is M4's 60 mm deckhead slot, the furnishing slice's 0.1 m bulkhead, and
 * §10.4's 53–86 mm level line — three rounds, one sentence: **a clearance is
 * only true at the height it was measured at.**
 *
 * `sideLimit` answers it once, for everybody: the *tightest* the room's side
 * gets anywhere over the piece's own footprint and its own height band. A box
 * inside that limit touches the planking at its widest point and is clear
 * everywhere else, which is what a real fitted piece of joinery does. Authors
 * do not get the choice, because the three rounds above are what happens when
 * they do.
 *
 * THE OTHER HALF OF THAT RULE, WHICH TOOK A SECOND ROUND: THE PIECE CAN TURN
 * -------------------------------------------------------------------------
 * A square box against a tapering side is as close as a square box can get, and
 * for two rounds that was the end of it — the desk stood 0.15 m off the lining
 * at its forward corner and `captainsDesk.ts` carried a note saying the real fix
 * was to rotate it about 7° and that the primitive would not allow it.
 *
 * It does now, and the interesting part is **who chooses the angle.** Not the
 * author: an angle typed into a fitting is a second source for a position the
 * hull already knows, which is the fault this module was written to prevent and
 * would be committed at the top of the file that prevents it. So a piece says
 * `align: 'side'` — *lie along the wall* — and `sideTangentYaw` measures the
 * lining's own slope over that piece's footprint and height band. Move the
 * bulkhead, change the sections, and the furniture turns with them.
 *
 * What it buys, measured on the desk: hard against the cabin's port side, a
 * square 1.30 m carcase touches at one corner and stands **0.149 m** off at the
 * other. Laid along the wall at 6.6° it touches near the middle and stands
 * **0.015 m** off at its worst corner, because the side is a curve and a chord
 * across a curve is wrong at its ends by the sagitta and nowhere else. Ten times
 * closer, and closer everywhere rather than closer on average.
 *
 * **This is not the wedge.** The rejected pass filled the gap with joinery; this
 * moves the furniture, which is what Ash asked for in the sentence that rejected
 * it. There is still a gap — 15 mm of it — and it stays.
 *
 * **It is not only the lean, and the captain's cabin is where that shows.**
 * Measured, the cabin's lined side is the same half-width at the sole and at
 * head height at every station in the room — those topsides are plumb — so the
 * *lean* term does nothing there at all. What it does instead is the taper
 * fore-and-aft: 1.136 m at the transom against 1.564 m at the forward bulkhead,
 * 0.12 m of half-breadth per metre of length. A 1.3 m desk placed against that
 * side is hard on the timber at one end and 0.15 m off it at the other, and the
 * sweep is what keeps it out of the frames rather than what keeps it level.
 * The module is worth having for the taper even in rooms with no lean at all.
 *
 * WHY THIS IS NOT IN `interiorFittings.ts`, WHICH IS WHERE IT WAS
 * ---------------------------------------------------------------
 * Because the captain's desk wanted it and could not have it. The desk is its
 * own module — it is a piece of joinery with three materials, two states and a
 * seat, not another entry beside the pump — and a desk that imports
 * `placeInRoom` from the same file that has to list the desk is a cycle. The
 * vocabulary and the furniture written in it are two things, and they were only
 * one file while there was one author of each.
 */

// --- what a fitting is --------------------------------------------------------

/**
 * Which hand of the ship a fitting stands on.
 *
 * **+x is port** — `hullForm.ts`'s coordinate note is emphatic about this and
 * about the round in which every side word in the vessel was backwards.
 */
export type Hand = 'port' | 'starboard' | 'centre';

/** Sign of a hand's x. Centre is 0, and a centre piece is placed by its own x. */
function handSign(hand: Hand): number {
  return hand === 'port' ? 1 : hand === 'starboard' ? -1 : 0;
}

/**
 * What a fitting's station is measured from, so that it follows that thing.
 *
 * `'aft'` and `'forward'` name a bulkhead, and `offset` is the clear distance
 * from it to the piece's near face — which is what someone reading a drawing
 * means and is right for anything that belongs to a wall.
 *
 * `'centre'` puts the piece's own middle `offset` abaft the **after** bulkhead,
 * and exists because the chart rack does not belong to a wall — it belongs to
 * the desk under it, and what a rack over a desk has to satisfy is that its
 * middle is over the sitter. Said as a face offset that becomes
 * `offset + footprint/2`, and the footprint of a *turned* piece is precisely the
 * derived quantity this module exists so that authors never compute. The rack
 * spent a round hanging over nothing for the same class of reason.
 */
export type Datum = 'aft' | 'forward' | 'centre';

/**
 * Whether a piece stands square with the ship or lies along the wall it is
 * against.
 *
 * `'square'` is the default and is right for nearly everything: a bulkhead, a
 * coaming and a pump well are all built to the keel, and a piece that quietly
 * turned would be a piece that no longer lines up with the room it is in.
 *
 * `'side'` is for freestanding furniture against the ship's side, and it means
 * *this piece was shoved against a curving wall by a person*. The angle is the
 * lining's own, measured — see this module's head for why it is not a number an
 * author gets to type, and `sideTangentYaw` for how it is taken.
 *
 * There is deliberately no third case for an arbitrary authored angle. The day a
 * piece wants one — a corner cupboard, a cot across a quarter — it can be added
 * with the reason that asked for it beside it. A field nobody fills is how the
 * closure table would have ended up with a chair in it.
 */
export type Alignment = 'square' | 'side';

/**
 * Where a piece's own axes point, and what it turns about.
 *
 * **Everything inside a fitting is drawn in this frame, and that is the whole
 * reason it is published rather than kept.** A desk is thirty boxes — panels,
 * drawer fronts, fiddles, the skiver, the chair, the book on it — and every one
 * of them is authored as "0.032 m of panel at the after end, the full depth of
 * the carcase". Those sentences are true in the piece's own coordinates and
 * become unwriteable in the ship's the moment the piece turns: a drawer front
 * 10 mm proud of the carcase is no longer 10 mm of x.
 *
 * So `placeInRoom` answers in the piece's frame, `framedBox` is how a local
 * rectangle becomes a solid in the ship, and a fitting's own arithmetic does not
 * change at all when it is rotated. The desk's carcase, drawers and fiddles were
 * written before this existed and were not touched by the round that turned it.
 *
 * A frame with `yaw = 0` is the identity, which is what every square piece gets
 * — so nothing that does not rotate pays anything for this, in code or in
 * arithmetic.
 */
export interface PieceFrame {
  /** Rotation about the vertical, radians, matching `FittingSolid`'s box yaw. */
  readonly yaw: number;
  /** The point it turns about, in ship coordinates. Also the frame's origin. */
  readonly pivotX: number;
  readonly pivotZ: number;
}

/** The frame of a piece that is square with the ship: the identity. */
export const SQUARE_FRAME: PieceFrame = { yaw: 0, pivotX: 0, pivotZ: 0 };

/**
 * A point in a piece's own frame, in the ship's.
 *
 * The one conversion, so the sign of the rotation is written once. `boxAxes` in
 * `deckFittings.ts` states the same convention for the primitive — local +x
 * becomes `u`, local +z becomes `w` — and the two must agree or a fitting's
 * pieces would be turned about the frame and drawn about themselves by different
 * amounts, which looks like joinery coming apart at the corners.
 */
export function frameToShip(frame: PieceFrame, x: number, z: number): { x: number; z: number } {
  if (frame.yaw === 0) return { x, z };
  const cos = Math.cos(frame.yaw);
  const sin = Math.sin(frame.yaw);
  const dx = x - frame.pivotX;
  const dz = z - frame.pivotZ;
  return {
    x: frame.pivotX + dx * cos + dz * sin,
    z: frame.pivotZ - dx * sin + dz * cos,
  };
}

/**
 * A point in the ship's coordinates, in a piece's own frame. The way back.
 *
 * WHY THIS HAS TO EXIST RATHER THAN BE WRITTEN WHERE IT IS WANTED
 * --------------------------------------------------------------
 * Because it was, once, and it was wrong in a way that looked right. Asking
 * whether a thing on the desk is inside the desk's fiddles is a question in the
 * *desk's* frame, and a `FittingSolid` reports its centre in the *ship's* — so
 * the check has to come back through the rotation. Written out by hand at the
 * point of use it came out as `cos(−yaw), sin(−yaw)` fed through the same
 * expression above, which is not the inverse of that expression: it is that
 * expression again. The round trip was the identity for zero yaw, plausible for
 * small ones, and silently reported a solid at nearly twice its true
 * displacement from the pivot.
 *
 * `[[c, s], [−s, c]]` inverts to `[[c, −s], [s, c]]`. It is two sign changes and
 * there is now exactly one place in the ship that has to get them right.
 */
export function shipToFrame(frame: PieceFrame, x: number, z: number): { x: number; z: number } {
  if (frame.yaw === 0) return { x, z };
  const cos = Math.cos(frame.yaw);
  const sin = Math.sin(frame.yaw);
  const dx = x - frame.pivotX;
  const dz = z - frame.pivotZ;
  return {
    x: frame.pivotX + dx * cos - dz * sin,
    z: frame.pivotZ + dx * sin + dz * cos,
  };
}

/**
 * The two drawing verbs, bound to one piece's frame.
 *
 * `span` takes a box from its two opposite corners, which is how joinery is
 * actually read off a drawing; `rod` takes a tapered round piece between two
 * points. Both are in the piece's **own** coordinates, and binding the frame
 * once at the top of each fitting is why turning the desk did not touch a single
 * one of the eighty-odd dimensions below it: "0.032 m of panel at the after end,
 * full depth of the carcase" is the same sentence at any angle.
 *
 * Bound rather than passed because the alternative is an extra argument on every
 * call, which is eighty chances to pass the wrong piece's frame and no way for
 * anything to notice — a fiddle drawn square on a desk drawn at 6.5° is joinery
 * coming apart at the corners.
 *
 * Here rather than in `captainsDesk.ts`, which is where it was written, because
 * the captain's berth wanted exactly the same two verbs the moment it turned —
 * and a second copy of a helper whose entire job is to stop two pieces of one
 * fitting disagreeing about a frame is not a helper worth having twice.
 */
export function drawnIn(frame: PieceFrame): {
  span: (
    xLo: number,
    xHi: number,
    yLo: number,
    yHi: number,
    zLo: number,
    zHi: number,
    material: FittingSolid['material'],
    collides: boolean,
  ) => FittingSolid;
  rod: (
    a: Vec3,
    b: Vec3,
    radiusA: number,
    radiusB: number,
    material: FittingSolid['material'],
    collides: boolean,
  ) => FittingSolid;
} {
  return {
    span: (xLo, xHi, yLo, yHi, zLo, zHi, material, collides) =>
      framedBox(frame, xLo, xHi, yLo, yHi, zLo, zHi, material, collides),
    rod: (a, b, radiusA, radiusB, material, collides) =>
      framedBar(frame, a, b, radiusA, radiusB, material, collides),
  };
}

/**
 * A rectangle in a piece's own frame, as the volume a pointer tests against.
 *
 * The same conversion `framedBox` does, without the material or the collision
 * flag — `Interactables`' box is a different vocabulary that happens to describe
 * the same shape, and it grew a yaw for the same reason the fitting's box did.
 * See `InteractableBox.yaw`: squaring a turned target up offered the captain's
 * chair to somebody standing in the next room.
 */
export function framedTarget(
  frame: PieceFrame,
  xLo: number,
  xHi: number,
  yLo: number,
  yHi: number,
  zLo: number,
  zHi: number,
): {
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
  yaw: number;
} {
  const centre = frameToShip(frame, (xLo + xHi) / 2, (zLo + zHi) / 2);
  const halfX = (xHi - xLo) / 2;
  const halfZ = (zHi - zLo) / 2;
  return {
    xLo: centre.x - halfX,
    xHi: centre.x + halfX,
    yLo,
    yHi,
    zLo: centre.z - halfZ,
    zHi: centre.z + halfZ,
    yaw: frame.yaw,
  };
}

/**
 * A tapered round piece in a frame — a drawer ring, a chair leg, a rolled chart.
 *
 * A tube already takes any direction, so unlike a box it needs no angle of its
 * own: turning its two ends turns it. That is why `FittingSolid` grew a yaw on
 * one of its two primitives and not on both.
 */
export function framedBar(
  frame: PieceFrame,
  a: Vec3,
  b: Vec3,
  radiusA: number,
  radiusB: number,
  material: FittingSolid['material'],
  collides: boolean,
): FittingSolid {
  const pa = frameToShip(frame, a.x, a.z);
  const pb = frameToShip(frame, b.x, b.z);
  return {
    kind: 'bar',
    a: v3(pa.x, a.y, pa.z),
    b: v3(pb.x, b.y, pb.z),
    radiusA,
    radiusB,
    material,
    collides,
  };
}

/**
 * A rectangle in a piece's own frame, as a solid standing in the ship.
 *
 * The one way a fitting's part becomes geometry. Takes the two opposite corners,
 * because that is how joinery is read off a drawing, and returns a box that
 * carries the frame's yaw — so the loft, the collider and the light bake all get
 * a turned piece without any of them being told about frames.
 */
export function framedBox(
  frame: PieceFrame,
  xLo: number,
  xHi: number,
  yLo: number,
  yHi: number,
  zLo: number,
  zHi: number,
  material: FittingSolid['material'],
  collides: boolean,
): FittingSolid {
  const centre = frameToShip(frame, (xLo + xHi) / 2, (zLo + zHi) / 2);
  return {
    kind: 'box',
    centre: v3(centre.x, (yLo + yHi) / 2, centre.z),
    half: v3((xHi - xLo) / 2, (yHi - yLo) / 2, (zHi - zLo) / 2),
    yaw: frame.yaw,
    material,
    collides,
  };
}

/**
 * Where a fitting stands, in the terms a joiner would use.
 *
 * Every distance is a *clear* distance to the piece's near face, never to its
 * centre: "0.30 m off the after bulkhead" is what someone reading the drawing
 * means, and a centre-based offset silently changes meaning when the piece's
 * own size changes.
 */
export interface RoomAnchor {
  readonly space: SpaceName;
  /** Which bulkhead `offset` is measured from. Name the wall the piece belongs to. */
  readonly from: Datum;
  /**
   * Clear distance from that bulkhead to the piece's near face.
   *
   * **Clear to the nearest timber of the piece, which for a turned one is a
   * corner rather than a face.** A yawed rectangle reaches further fore-and-aft
   * than its own length — 1.30 m of desk at 6.5° takes 1.36 m of room — and
   * measuring to the face would quietly spend that 60 mm out of the clearance
   * the author asked for. What someone reading the drawing means by "0.62 m off
   * the transom" is that there is 0.62 m of empty sole there.
   */
  readonly offset: number;
  /** Length fore-and-aft, along the piece's own axis. */
  readonly length: number;
  readonly hand: Hand;
  /** Square with the ship, or lying along the side. Defaults to square. */
  readonly align?: Alignment;
  /**
   * Clear distance inboard from the ship's side to the piece's outboard face —
   * or, for a `centre` piece, the distance from the centreline to its nearer
   * face. Zero means fitted hard against the timber, which is what built-in
   * joinery is.
   */
  readonly inboard: number;
  /** Width athwartships. */
  readonly width: number;
  /**
   * Clear height from the sole to the piece's underside.
   *
   * **Zero for anything standing on the floor, which was every fitting until
   * the chart rack.** A rack, a shelf or a barometer is fixed to the lining
   * with nothing under it, and a placement that could only start at the sole
   * would have to be lied to about its height and then drawn somewhere else —
   * which is this module's own fault, committed by the module that exists to
   * prevent it. It also has to be here rather than applied afterwards, because
   * `sideLimit` is a function of the height band: the side a wall-hung piece is
   * screwed to is the side *at head height*, not the side at the floor.
   */
  readonly sill?: number;
  /** Height of the piece itself, from its underside. */
  readonly height: number;
}

/**
 * An anchor, resolved against the ship as she is currently drawn.
 *
 * Deliberately a *box*, not a transform: everything below decks that a body can
 * hit is a box in `deckObstacles.ts`, and a placement that could describe
 * something the collider cannot is a placement that will one day draw a wall a
 * player walks through. When the collider learnt to turn a box, this learnt to
 * turn a placement, and neither learnt anything else.
 *
 * **The six numbers are in the piece's own frame, not the ship's**, and for a
 * square piece those are the same thing — which is why nothing that does not
 * rotate had to change when this gained a frame. For a turned one they are the
 * rectangle as a joiner would measure it, and `frame` is what puts it in the
 * room. Anything that needs a ship coordinate says so by asking `frameToShip`.
 */
export interface RoomPlacement {
  readonly space: BelowDecksSpace;
  /** Which way this piece faces, and what it turns about. */
  readonly frame: PieceFrame;
  readonly zAft: number;
  readonly zForward: number;
  readonly xLo: number;
  readonly xHi: number;
  readonly yLo: number;
  readonly yHi: number;
  /** The tightest the room's side gets over this footprint and height band. */
  readonly sideLimit: number;
  /** The lowest deckhead over this footprint. */
  readonly deckheadY: number;
}

/** Samples across a footprint when asking the hull how wide it is. Cheap, and
 *  the answer is a minimum, so more samples can only make it more honest. */
const LIMIT_SAMPLES = 9;

/**
 * Samples along each edge when fitting a turned piece to the lining.
 *
 * Denser than `LIMIT_SAMPLES`, and the difference is what the number is *for*.
 * A limit that is reported can be a little slack; a limit the piece is pushed
 * up against until it touches is the difference between joinery against a wall
 * and joinery *in* it. Sampled at nine per edge the desk's outboard face went
 * 0.03 mm into the cabin lining between two samples — invisible, harmless, and
 * a shortfall that scales with the square of the spacing, so it would not have
 * stayed harmless on a longer piece against a tighter curve. At 33 it is under
 * a fiftieth of that.
 */
const SIDE_FIT_SAMPLES = 33;

/**
 * The tightest half-width of a room's side over a station range and a height
 * band — the number a box against the planking may not exceed.
 *
 * Both axes are swept because the hull closes in both: forward it narrows with
 * every station, and everywhere it leans with every row. Sampling one corner is
 * how a chord gets drawn under a curve, which `spaceSideHalfWidthAt`'s own note
 * records as the fault it exists to prevent.
 */
export function sideLimitOver(
  space: BelowDecksSpace,
  zAft: number,
  zForward: number,
  yLo: number,
  yHi: number,
): number {
  let limit = Infinity;
  for (let i = 0; i < LIMIT_SAMPLES; i++) {
    const z = zAft + ((zForward - zAft) * i) / (LIMIT_SAMPLES - 1);
    for (let j = 0; j < LIMIT_SAMPLES; j++) {
      const y = yLo + ((yHi - yLo) * j) / (LIMIT_SAMPLES - 1);
      limit = Math.min(limit, spaceSideHalfWidthAt(space, z, y, false));
    }
  }
  return limit;
}

/** The tightest the lining gets at one station over a piece's height band. */
function sideAt(space: BelowDecksSpace, z: number, yLo: number, yHi: number): number {
  let limit = Infinity;
  for (let j = 0; j < LIMIT_SAMPLES; j++) {
    const y = yLo + ((yHi - yLo) * j) / (LIMIT_SAMPLES - 1);
    limit = Math.min(limit, spaceSideHalfWidthAt(space, z, y, false));
  }
  return limit;
}

/**
 * The lowest deckhead over a footprint — what a tall piece has to clear.
 *
 * **Exported, because pieces outside this module were sampling it by hand.**
 * The hanging locker and the tell-tale compass each wrote their own nested loop
 * over their own step count, and the officers' cabin partitions and the galley
 * flue want the same answer: three or four chances to sample a corner instead
 * of the curve, in rooms whose deck cambers 0.09 m across the beam and falls
 * forward besides. The compass's own comment records that fault being found and
 * fixed once already. Pass `SQUARE_FRAME` for a piece that does not turn.
 */
export function lowestDeckheadOver(
  space: BelowDecksSpace,
  frame: PieceFrame,
  zAft: number,
  zForward: number,
  xLo: number,
  xHi: number,
): number {
  return deckheadOver(space, frame, zAft, zForward, xLo, xHi);
}

function deckheadOver(
  space: BelowDecksSpace,
  frame: PieceFrame,
  zAft: number,
  zForward: number,
  xLo: number,
  xHi: number,
): number {
  let lowest = Infinity;
  for (let i = 0; i < LIMIT_SAMPLES; i++) {
    const lz = zAft + ((zForward - zAft) * i) / (LIMIT_SAMPLES - 1);
    for (let j = 0; j < LIMIT_SAMPLES; j++) {
      const lx = xLo + ((xHi - xLo) * j) / (LIMIT_SAMPLES - 1);
      const p = frameToShip(frame, lx, lz);
      const head = spaceDeckheadY(space, p.x, p.z);
      if (head !== null) lowest = Math.min(lowest, head);
    }
  }
  return lowest;
}

/**
 * The angle the room's side runs at, over one piece's own footprint.
 *
 * **A chord, not a tangent, and the difference is the whole argument.** The
 * lining is a curve in plan; a straight carcase laid on it can touch at one
 * point and no more. Take the tangent at the middle and the piece touches in the
 * middle and its two ends dig into the timber. Take the chord between the
 * stations its ends land on and it touches near the middle and stands off at the
 * ends by the sagitta — 15 mm over the desk's 1.3 m, against the 149 mm a square
 * carcase leaves. Wrong by a curve's own departure from its chord is as close as
 * a straight thing gets to a curved one, and this is `sideLimitOver`'s "sampling
 * one corner is how a chord gets drawn under a curve" read the other way round:
 * there it was the fault, here it is the fit.
 *
 * Positive is *outboard going forward* on the port hand and the mirror of that
 * to starboard, so both sides of a tapering room lean the same way relative to
 * their own lining rather than both turning the same way in the ship.
 */
export function sideTangentYaw(
  space: BelowDecksSpace,
  hand: Hand,
  zAft: number,
  zForward: number,
  yLo: number,
  yHi: number,
): number {
  const sign = handSign(hand);
  if (sign === 0) return 0;
  const aft = sideAt(space, zAft, yLo, yHi);
  const forward = sideAt(space, zForward, yLo, yHi);
  return sign * Math.atan2(forward - aft, zForward - zAft);
}

/** How much room fore-and-aft a piece of this size takes once it is turned. */
function footprintLength(length: number, width: number, yaw: number): number {
  return length * Math.abs(Math.cos(yaw)) + width * Math.abs(Math.sin(yaw));
}

/**
 * The furthest outboard a turned rectangle can go before it is in the planking.
 *
 * Sampled round the piece's **perimeter** rather than along its outboard face,
 * and that is not belt-and-braces. The face is the binding edge only while the
 * piece is square with the wall; turned, its after corner swings inboard and its
 * end grain swings out, so at some stations the nearest timber to the lining
 * belongs to an end. The perimeter of a rectangle contains, at every station it
 * covers, the point of the rectangle furthest outboard at that station — which
 * is exactly the quantity being minimised, so sampling it is sufficient as well
 * as safe.
 */
function outboardLimit(
  space: BelowDecksSpace,
  sign: number,
  yaw: number,
  centreZ: number,
  halfWidth: number,
  halfLength: number,
  yLo: number,
  yHi: number,
): number {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  let limit = Infinity;
  /** One point of the perimeter, in the piece's own axes about its centre. */
  const consider = (lx: number, lz: number): void => {
    const x = lx * cos + lz * sin;
    const z = centreZ - lx * sin + lz * cos;
    const room = sideAt(space, z, yLo, yHi);
    // Port: the piece may be shifted until `x + shift` reaches `+room`.
    // Starboard: until it reaches `-room`, which is the same number mirrored.
    limit = Math.min(limit, room - sign * x);
  };
  for (let i = 0; i < SIDE_FIT_SAMPLES; i++) {
    const t = -1 + (2 * i) / (SIDE_FIT_SAMPLES - 1);
    consider(halfWidth, t * halfLength);
    consider(-halfWidth, t * halfLength);
    consider(t * halfWidth, halfLength);
    consider(t * halfWidth, -halfLength);
  }
  return limit;
}

/**
 * Resolve an anchor.
 *
 * Throws rather than clamping when a piece will not fit in the room it names.
 * The useful moment to say "this chest is longer than the cabin" is the one
 * where the number would otherwise have been quietly invented — the same reason
 * `deckFittings.standOn` throws for a fitting placed off the deck.
 */
export function placeInRoom(anchor: RoomAnchor): RoomPlacement {
  const space = belowDecksSpace(anchor.space);
  const yLo = space.soleY + (anchor.sill ?? 0);
  const yHi = yLo + anchor.height;
  const sign = handSign(anchor.hand);

  // The angle and the footprint each need the other: the wall's slope is
  // measured over the stations the piece covers, and a turned piece covers more
  // of them than its own length. Settled by iteration from the square case,
  // which is `deckFittings.tillerRise`'s trick and converges as fast — a couple
  // of degrees of yaw move the span by centimetres, and centimetres of span move
  // the yaw by hundredths of a degree.
  let yaw = 0;
  let zNear = 0;
  let zFar = 0;
  for (let pass = 0; pass < 3; pass++) {
    const spanZ = footprintLength(anchor.length, anchor.width, yaw);
    zNear =
      anchor.from === 'aft'
        ? space.zAft + anchor.offset
        : anchor.from === 'centre'
          ? space.zAft + anchor.offset - spanZ / 2
          : space.zForward - anchor.offset - spanZ;
    zFar = zNear + spanZ;
    if (anchor.align !== 'side') break;
    yaw = sideTangentYaw(space, anchor.hand, zNear, zFar, yLo, yHi);
  }

  if (zNear < space.zAft - 1e-9 || zFar > space.zForward + 1e-9) {
    throw new Error(
      `interior fitting does not fit in the ${anchor.space}: ` +
        `${zNear.toFixed(3)}..${zFar.toFixed(3)} against the room's ` +
        `${space.zAft.toFixed(3)}..${space.zForward.toFixed(3)}`,
    );
  }

  const pivotZ = (zNear + zFar) / 2;
  const halfWidth = anchor.width / 2;
  const halfLength = anchor.length / 2;

  // The side, as reported: the tightest the lining gets anywhere over the
  // stations the piece covers. Reported rather than applied now — what places a
  // turned piece is `outboardLimit`, which is this same question asked once per
  // point of the piece instead of once for the piece.
  const sideLimit = sideLimitOver(space, zNear, zFar, yLo, yHi);

  let pivotX: number;
  if (sign === 0) {
    // A centre piece is placed off the centreline and never touches the side,
    // so its limit is the room's own half-width — reported, not applied.
    pivotX = anchor.inboard + halfWidth;
  } else {
    // **The whole point of the module.** The outboard face is set by the side
    // over the piece's own timber, not by the side at any one corner of it.
    // `outboardLimit` answers in the piece's own centre, because the samples it
    // minimises over are already measured from there — asking it for a *face*
    // and then stepping in half a width would count that half width twice, which
    // is precisely the slip this round made and the 0.30 m of daylight behind
    // the desk that came of it.
    pivotX =
      sign *
      (outboardLimit(space, sign, yaw, pivotZ, halfWidth, halfLength, yLo, yHi) -
        anchor.inboard);
    // How far the piece reaches athwartships once turned — a rectangle laid over
    // at an angle is wider in the ship than it is in itself.
    const halfSpanX = halfWidth * Math.abs(Math.cos(yaw)) + halfLength * Math.abs(Math.sin(yaw));
    const inboardFace = sign * pivotX - halfSpanX;
    if (inboardFace < 0) {
      throw new Error(
        `interior fitting is wider than the ${anchor.space}'s side allows: ` +
          `${(halfSpanX * 2).toFixed(3)} m of piece across the ship puts its inboard ` +
          `face ${(-inboardFace).toFixed(3)} m past the centreline`,
      );
    }
  }

  const frame: PieceFrame = yaw === 0 ? SQUARE_FRAME : { yaw, pivotX, pivotZ };
  const xLo = pivotX - halfWidth;
  const xHi = pivotX + halfWidth;
  const zAft = pivotZ - halfLength;
  const zForward = pivotZ + halfLength;

  const deckheadY = deckheadOver(space, frame, zAft, zForward, xLo, xHi);
  if (yHi > deckheadY) {
    throw new Error(
      `interior fitting is taller than the ${anchor.space}: top ${yHi.toFixed(3)} ` +
        `against a deckhead at ${deckheadY.toFixed(3)}`,
    );
  }

  return { space, frame, zAft, zForward, xLo, xHi, yLo, yHi, sideLimit, deckheadY };
}

/**
 * The stations a placed piece actually covers, turn and all.
 *
 * **`RoomPlacement`'s own `zAft` and `zForward` are in the piece's frame**, and
 * for a turned one that is not what it occupies: a 1.75 m berth laid over at
 * 26° reaches 1.85 m fore-and-aft, and the 0.10 m difference is exactly the
 * clearance the next piece forward thought it had. `placeInRoom` already knows
 * this — `RoomAnchor.offset`'s note is about the same 60 mm on the desk — but
 * nothing published it, so a fitting placed *off another fitting* had no honest
 * way to ask where the first one ends. The forecastle's dresser is placed off
 * the crew berths' after end and is the first piece aboard that had to.
 */
export function placementSpanZ(placement: RoomPlacement): {
  zAft: number;
  zForward: number;
} {
  if (placement.frame.yaw === 0) {
    return { zAft: placement.zAft, zForward: placement.zForward };
  }
  const length = placement.zForward - placement.zAft;
  const width = placement.xHi - placement.xLo;
  const half = footprintLength(length, width, placement.frame.yaw) / 2;
  return {
    zAft: placement.frame.pivotZ - half,
    zForward: placement.frame.pivotZ + half,
  };
}

/** A placement as the box it is — the whole piece, in one solid. */
export function placedBox(
  placement: RoomPlacement,
  material: FittingSolid['material'],
  collides: boolean,
): FittingSolid {
  return framedBox(
    placement.frame,
    placement.xLo,
    placement.xHi,
    placement.yLo,
    placement.yHi,
    placement.zAft,
    placement.zForward,
    material,
    collides,
  );
}

/**
 * A box from its two opposite corners, which is how joinery is actually read.
 *
 * Here rather than in each furniture module because there are now three of them
 * and all three were about to write it. A joiner gives a piece as two corners —
 * "from the lining to 0.60 in, from the sole to 0.76 up" — and every fitting
 * below decks is described that way in its own comments; `FittingSolid`'s
 * centre-and-half form is what the collider and the loft want, and converting
 * between the two in eight places is eight chances to halve the wrong number.
 */
export function span(
  xLo: number,
  xHi: number,
  yLo: number,
  yHi: number,
  zLo: number,
  zHi: number,
  material: FittingSolid['material'],
  collides: boolean,
): FittingSolid {
  return {
    kind: 'box',
    centre: v3((xLo + xHi) / 2, (yLo + yHi) / 2, (zLo + zHi) / 2),
    half: v3((xHi - xLo) / 2, (yHi - yLo) / 2, (zHi - zLo) / 2),
    material,
    collides,
  };
}

// --- what a fitting is --------------------------------------------------------

/** Every kind of thing standing in a room below decks. */
export type InteriorFittingKind =
  | 'pumpTube'
  | 'pumpWell'
  | 'hatchwayBoards'
  | 'foreScuttleLadder'
  | 'foreScuttleSoffit'
  | 'chartDesk'
  | 'chartRack'
  | 'deskChair'
  | 'deskItems'
  | 'sternLocker'
  | 'boxBerth'
  | 'boxBerthCurtain'
  | 'washstand'
  | 'hangingLocker'
  | 'seaChest'
  | 'tellTaleCompass'
  | 'bookShelf'
  | 'barometer'
  | 'wardroomTable'
  | 'wardroomForm'
  | 'officersCabin'
  | 'wardroomStores'
  | 'galleyHearth'
  | 'galleyDresser'
  | 'crewBerth'
  | 'foremastTable';

export interface InteriorFitting {
  readonly name: string;
  readonly kind: InteriorFittingKind;
  readonly solids: readonly FittingSolid[];
  /** A flat top a walker stands on, if this piece has one. */
  readonly standable: StandablePanel | null;
}

/**
 * Every kind, classified — `FITTING_KINDS` and `INTERIOR_SOURCES` over again,
 * and for the same reason: a suite keyed to one list stops covering the ship
 * the moment geometry lands in a different one.
 *
 * The reasons are claims about dimensions rather than flags, so
 * `ship-interior.test.ts` can check each against the geometry. "Under the
 * step-over height" stops being true the moment somebody raises a well head.
 */
export const INTERIOR_FITTING_KINDS: Record<InteriorFittingKind, { readonly reason: string }> = {
  pumpTube: {
    reason:
      'The bored log itself, from the underside of the weather deck down to the ' +
      'limbers. Solid where it stands in the wardroom, floor to deckhead, and ' +
      'not solid below the platform sole — a body cannot be in the hold to hit it.',
  },
  pumpWell: {
    reason:
      'The boxed casing round the tube. Its head stands proud of the wardroom ' +
      'sole and is under the walker’s 0.40 m step-over, so it is a kerb that is ' +
      'strode across rather than a wall — the same reading `INTERIOR_STEPS` ' +
      'gives the forecastle’s 0.25 m riser.',
  },
  hatchwayBoards: {
    reason:
      'Laid flush and walked on, so they are the wardroom’s sole rather than a ' +
      'thing standing on it. Never collidable in either state: shut they are a ' +
      'floor, and lifted they are stacked clear of the opening at 0.09 m, well ' +
      'under the step-over. What changes when they come up is the *floor*, in ' +
      '`schoonerStandAt`, not a collider here.',
  },
  foreScuttleLadder: {
    reason:
      'Rungs and two stiles spiked to the after coaming of the fore scuttle. ' +
      'Never collidable: a rung is a floor, which is the reading the companion ' +
      'flight, the wardroom’s steps and the hold’s ladder all already have. ' +
      'Its rungs are published as surfaces only while the lid is up — the hold ' +
      'ladder’s rule, and for the same reason: a ladder the walker can use ' +
      'through a shut hatch is a body climbing out through 50 mm of oak.',
  },
  foreScuttleSoffit: {
    reason:
      'The underside of the shut scuttle, drawn as part of the room’s ceiling. ' +
      'Never collidable and never standable: the deck above it is what a body ' +
      'stands on from either side, and this is a surface the eye meets rather ' +
      'than the feet. It exists so the forecastle looks up at dark interior ' +
      'timber instead of at the coaming’s sunlit inner faces.',
  },
  chartDesk: {
    reason:
      'Built-in joinery against the cabin’s port side, and **solid to the top ' +
      'across its whole footprint**: the standards and the drawer bank carry the ' +
      'block from the sole up, and the top slab carries it across the knee-hole ' +
      'between them. The knee-hole is drawn as a hole and is not one as far as a ' +
      'body is concerned, which is the honest reading rather than an oversight — ' +
      'the walker is a 1.75 m cylinder, so a gap that only exists below 0.72 m ' +
      'is a gap nothing can ever be in. Leaving the slab out to "open" it would ' +
      'buy a player standing inside the desk with its top through their chest. ' +
      'Sitting works because the seat holds the walker, not because the carcase ' +
      'lets it through. Not standable either: nothing aboard invites a player ' +
      'onto the furniture, and a 0.76 m panel under a 2.0 m deckhead is a step ' +
      'to nowhere the walker would then have to be got down from.',
  },
  chartRack: {
    reason:
      'Pigeonholes screwed to the lining over the desk, underside 1.10 m above ' +
      'the sole. Never collidable, and the reason is the height rather than a ' +
      'preference: its lowest timber is 0.34 m clear over the desk top, which is ' +
      'above the desk’s own collider, so a body stopped by the desk can never ' +
      'reach the rack to be stopped by it. A second collider inside the first ' +
      'one’s shadow is a claim nothing can check.',
  },
  deskItems: {
    reason:
      'What is lying on the desk — the sailing manual and marine timekeeper. ' +
      'Never collidable and never standable, and neither is a judgement call: ' +
      'every item is inside the desk’s own well, and the desk is solid to its ' +
      'top, so a body stopped by one would already be inside the desk. ' +
      'Opening one is a DOM overlay rather than a second state in the world, so ' +
      'unlike the chair there is nothing here for a state pair to switch ' +
      'between: the drawn book is the same book whether or not it is being read.',
  },
  sternLocker: {
    reason:
      'A stowage locker standing on the sole against the raked after lining, ' +
      'one each hand of the rudder trunk. Its carcase and lid collide and ' +
      'nothing else on it does: at 0.48 m the lid is above the walker’s 0.40 m ' +
      'step-over, so this is the wall that stops a body walking aft into the ' +
      'stern windows rather than a kerb it strides. The squab, the plinth and ' +
      'the raised field are all inside the carcase’s own shadow. Not standable ' +
      'for the chart desk’s reason: nothing aboard invites a player onto the ' +
      'furniture.',
  },
  boxBerth: {
    reason:
      'Built-in joinery against the starboard side, in two bays that each take ' +
      'their own width from the ship’s side so the bunk front stays one fair ' +
      'line. The carcase under the bunk and the lee board along its front are ' +
      'collidable and the bedding above them is not — the carcase is solid from ' +
      'the sole to 0.50 m, which is over the step-over, so a body meets the bed ' +
      'before it can ever reach the mattress. Not standable: climbing into a ' +
      'berth is an action with a verb if it is ever anything at all, not a ' +
      'surface a player wanders onto and then has to be got off.',
  },
  boxBerthCurtain: {
    reason:
      'The linen privacy curtain at the captain’s berth mouth. Never collidable: ' +
      'closed it screens sight rather than becoming a wall, and open it is a ' +
      'gathered hand-worked bundle clear of the walking sole.',
  },
  washstand: {
    reason:
      'An open frame in the starboard forward corner with a basin in its top ' +
      'and a ewer on the shelf under it. The two standards and the top collide; ' +
      'the basin, the ewer, the towel and the splashback do not, and each of ' +
      'them is inside the frame’s own footprint or hung on its side above the ' +
      'sole. Not standable — a 0.80 m top is over the walker’s step-up and ' +
      'there is a basin of water on it.',
  },
  hangingLocker: {
    reason:
      'A full-height press against the forward bulkhead to port, where the ' +
      'oilskins live. The carcase collides and its plinth, cornice, doors and ' +
      'knobs do not: all four are proud of a face that already stops a body. ' +
      'Its height is asked of the lowest deckhead over its own footprint rather ' +
      'than typed, because the deck cambers and falls forward and a constant ' +
      'here is a locker through the beams the day somebody changes the camber.',
  },
  seaChest: {
    reason:
      'A chest at the foot of a man’s bed-place: the captain’s low personal one ' +
      'between the chart desk and hanging locker, and the crew’s two in the ' +
      'forecastle, which double as the seating at their mess table. Its carcase ' +
      'and lid collide, while the recessed plinth, leather cover, brass or iron ' +
      'straps and rope beckets sit inside or proud of faces the carcase already ' +
      'stops a body at. At 0.43–0.44 m the lid is above the walker’s 0.40 m ' +
      'step-over, so it is a small wall rather than a stair onto the furniture; ' +
      'it is not standable for the chart desk’s reason. One kind and two ' +
      'builders, because a gentleman’s leather-covered travelling chest and a ' +
      'seaman’s painted deal one are the same object to a body and want to look ' +
      'nothing alike to an eye.',
  },
  tellTaleCompass: {
    reason:
      'The cabin compass hangs face-down from the deckhead over the rudder ' +
      'trunk and stern lockers. Nothing on it collides or supports a body: its ' +
      'lowest fitting is above standing head height, and the locker and trunk ' +
      'beneath it already keep the walker out of its vertical shadow.',
  },
  barometer: {
    reason:
      'The captain’s glass, screwed flat to the port lining forward of the ' +
      'chart rack with its centre 1.30 m above the sole. Never a collider and ' +
      'never standable: it stands 0.075 m off the lining, which is inside the ' +
      'chart desk’s own shadow along that wall, and a walker is a cylinder of ' +
      '0.26 m radius that the desk stops long before any part of this reaches ' +
      'it. It is read by opening its face, not by walking into it.',
  },
  bookShelf: {
    reason:
      'Shelving screwed to the lining over the foot of the berth, underside ' +
      '1.15 m above the sole. Never collidable, and the chart rack’s reason ' +
      'rather than a preference: its inboard face is 0.62 m outboard of the ' +
      'bunk front, the berth is solid from the sole to 0.74 m, and a walker is a ' +
      'cylinder of 0.26 m radius — so a body pressed as hard against the berth ' +
      'as it can get is still 0.88 m short of the nearest timber on this shelf. ' +
      'A collider that far inside another’s shadow is a claim nothing can check.',
  },
  deskChair: {
    reason:
      'Two states, and never a collider in either. Tucked, the seat is under ' +
      'the desk top inside the desk’s own footprint, so the desk already stops ' +
      'anyone who would have hit it. Drawn out, it is only ever drawn out ' +
      'while the player is sitting in it — the seat pushes back in when they ' +
      'stand — so there is no frame in which a loose chair stands in a 9.3 m² ' +
      'room with a 0.26 m body that has to get round it. That is the whole ' +
      'reason it has two states rather than one: a chair left standing out is ' +
      'the wedge this room has no width to spare for.',
  },
  wardroomTable: {
    reason:
      'The mess table on the wardroom’s centreline, its head against the ' +
      'mainmast. Only the top collides, and that is the whole of what a table ' +
      'is to a body: at 0.74 m it is well over the walker’s 0.40 m step-over, ' +
      'and the two trestles and the stretcher under it stand inside the top’s ' +
      'own shadow in plan, so a second collider there is a claim nothing can ' +
      'check. Not standable — nothing aboard invites a player onto the ' +
      'furniture, which is the chart desk’s rule.',
  },
  wardroomForm: {
    reason:
      'A backless bench each side of the mess table. The seat board collides ' +
      'and its two standards and the rail under it do not: at 0.42 m the seat ' +
      'is 20 mm above the walker’s step-over, which is deliberate rather than ' +
      'lucky — a form a body strides is a form a body walks through the middle ' +
      'of the mess on. Not standable, for the same reason as the table.',
  },
  officersCabin: {
    reason:
      'The mate’s and the surgeon’s cabins, flanking the platform’s hatchway. ' +
      'Everything that makes the room a room collides — the after partition, ' +
      'the inboard partition each side of its doorway, the lintel over it, and ' +
      'the berth’s locker and lee board inside. The lintel is drawn as timber ' +
      'and behaves as a head rather than a wall because the walker ignores a ' +
      'solid whose foot is above its own standing height. The door leaf, its ' +
      'ring and the coat hooks do not collide: the leaf is hooked back flat ' +
      'against a partition that already stops a body, and the hooks are 1.4 m ' +
      'up on the same timber. Not standable, and the mate’s cabin is not even ' +
      'walk-in — see `wardroomFurniture.ts` for why one of the two is a room ' +
      'and the other a standing bed-place.',
  },
  wardroomStores: {
    reason:
      'The run of expedition chests and ship’s stores along each side of the ' +
      'wardroom. Carcase and lid collide and the plinth, the bay stiles and the ' +
      'rope beckets do not, all three being inside or proud of a face the ' +
      'carcase already stops a body at. At 0.60 m the lid is well over the ' +
      'walker’s step-over, so this is the wall that keeps a body off the ship’s ' +
      'side rather than a kerb it strides. Not standable: it would be a step ' +
      'onto a 0.60 m shelf under a 1.9 m deckhead, which the walker would then ' +
      'have to be got down from.',
  },
  galleyHearth: {
    reason:
      'The firehearth against the forecastle’s after bulkhead, to port and ' +
      'outboard of the doorway. The brick box and the iron top over it collide; ' +
      'the plinth, the fire door, the pot rail, the two pots and the flue do ' +
      'not — every one of them is inside the box’s own footprint or proud of a ' +
      'face it already stops a body at, and the flue rises from 0.86 m to the ' +
      'beams, which is above a standing body’s head where it is not inside the ' +
      'hearth. Not standable: it is a fire.',
  },
  galleyDresser: {
    reason:
      'Shelving, a preparation surface and secured pots, on the starboard side ' +
      'forward of the fore scuttle. The cupboard under the bench and the bench ' +
      'top collide; the doors, the back board, the three shelves, their fiddles ' +
      'and the crockery on them do not — the shelves begin at 1.06 m above the ' +
      'sole, inside the shadow of a carcase that is solid from the sole to ' +
      '0.91 m, so a body stopped by the cupboard can never reach them. Not ' +
      'standable.',
  },
  crewBerth: {
    reason:
      'Two berths in a stack against one side of the forecastle, forward. The ' +
      'locker under the lower bunk collides and so does each tier’s lee board ' +
      'and the upper tier’s bunk bottom; the bedding, the stanchions and the ' +
      'oilskin hooks do not. The rule is the box berth’s: the carcase is solid ' +
      'from the sole to 0.42 m, which is over the step-over, so a body meets a ' +
      'bunk rather than climbing one, and the mattress above it is inside that ' +
      'shadow. Not standable — getting into a berth is an action with a verb if ' +
      'it is ever anything at all.',
  },
  foremastTable: {
    reason:
      'The crew’s hinged leaf, cleated to the after side of the foremast and ' +
      'drawn down. The leaf collides and nothing else does: the two battens ' +
      'under it, the fiddle round its three free sides, the folding leg and the ' +
      'iron hinges are all inside the leaf’s own footprint in plan or proud of ' +
      'it by less than a body could ever be stopped by first. At 0.72 m the ' +
      'leaf is a table a body meets, not a step it takes. Not standable.',
  },
};
