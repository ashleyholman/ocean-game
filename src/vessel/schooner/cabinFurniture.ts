import type { InteractableBox } from '../../player/Interactables';
import type { SeatPose } from '../../player/SeatedStation';
import type { FittingSolid } from './deckFittings';
import {
  belowDecksSpace,
  spaceDeckheadY,
  sternLiningHalfWidthAt,
  sternLiningZAt,
  RUDDER_TRUNK_HALF_BREADTH,
} from './deckInterior';
import { BERTH_MOUTH_HEIGHT, lyingPose } from './seatedBody';
import {
  SQUARE_FRAME,
  drawnIn,
  framedTarget,
  placeInRoom,
  sideLimitOver,
  span,
} from './roomFitting';
import type { InteriorFitting, PieceFrame } from './roomFitting';
import { v3 } from './shipwright';

/**
 * What the captain lives with: his berth, the lockers across the stern, the
 * washstand, the hanging locker, the captain's sea chest, the tell-tale compass
 * and the shelf of books.
 *
 * The desk is not here. `captainsDesk.ts` owns that, and for the reason it
 * gives — a piece of joinery with three materials, two states and a seat
 * attached to it is a module's worth of decisions. This is the rest of the room,
 * and most pieces in it share one property that the desk does not: they do not
 * move. The berth curtain is the deliberate exception. Its dimensions remain
 * beside the berth that owns them, while its two rendered states are built by
 * `interiorFittingGeometry` just as the desk chair's are.
 *
 * WHY THE STERN LOCKERS ARE IN THIS FILE AND THE PANELLING BEHIND THEM IS NOT
 * --------------------------------------------------------------------------
 * Because of the rake, and it is worth stating once for everything that will
 * ever be built against that wall. The cabin's after wall is the counter itself,
 * lined, leaning aft at 18° — `sternLiningZAt` is 0.325 m further aft for every
 * metre of height. `FittingSolid`'s box is axis-aligned and cannot lean, so
 * anything that has to *lie on* that wall — panels, mouldings, the architraves
 * round the lights — is lofted in `cabinJoinery.ts` with the lining it belongs
 * to.
 *
 * A locker is not on the wall, it is standing on the floor *against* the wall,
 * and a locker is a rectangular box in every ship ever built. So the carcase is
 * an ordinary axis-aligned fitting whose back is asked of the lining rather than
 * typed, and the small wedge the rake opens behind it is roofed by its own lid.
 * That is what a real transom locker does with that wedge too.
 *
 * EVERY PIECE AGAINST THE SIDE LIES ALONG IT
 * ------------------------------------------
 * The cabin narrows 0.12 m of half-breadth per metre of length, so a square
 * 1.90 m berth hard against the lining stands 0.23 m off it at one end — a slot
 * you could lose a boot down. `align: 'side'` answers it: the piece is laid on
 * the lining's own chord over its own footprint, and the angle is measured
 * rather than authored. Measured on the four pieces here, the worst gap left
 * between a piece's outboard timber and the lining is **24 mm on the berth,
 * 17 mm on the shelf, 20 mm on the washstand and under a millimetre on the
 * press** — against 0.23 m, 0.10 m, 0.07 m and 0.09 m square.
 *
 * **The berth was built in two bays before this**, each asking the side for its
 * own width, and that is worth knowing because it worked: 0.138 m, with the step
 * hidden in the back under the mattress. It was still six times worse than
 * turning the piece, it needed a lapped bunk bottom and per-bay end boards, and
 * it produced the one genuine bug in this file. `boxBerthGeometry` carries the
 * numbers.
 *
 * What is *not* done about the residual is scribing a filler into it: that is
 * the wedge behind the desk that Ash threw out, and the note in
 * `captainsDesk.ts` is the standing verdict on it.
 *
 * The stern lockers are the exception and they are square, because they stand
 * against the *transom* rather than the side — a yaw would turn them out of
 * parallel with the wall they are built against.
 */

// --- the lockers across the stern ---------------------------------------------

/**
 * How high the locker tops stand above the sole.
 *
 * **0.48, which is a locker and not a chair, and the difference is the stern
 * windows.** The sills are 1.243 m above the sole — set by the sea, not by the
 * room, and they are not coming down: Ash's word on it is that the ingress
 * question was settled long before this round. A seated eye is 0.78 m above
 * whatever it is sitting on, so a chair-height 0.42 m seat puts the eye 43 mm
 * *below* the sill and the only thing through the glass is sky. At 0.48 the eye
 * is 17 mm above it.
 *
 * That margin does not buy a seated view worth building a station for, and none
 * is built here — you stand to look out, which is Ash's own call. What it buys
 * is that the piece is not a joke: somebody sitting on this locker can see out
 * of the window behind them rather than being demonstrably unable to. A stowage
 * locker is a little higher than a chair anyway, because what sets its height is
 * what goes inside it.
 */
const LOCKER_HEIGHT = 0.48;

/** Fore-and-aft depth of a locker, front face to the lining at its foot. */
const LOCKER_DEPTH = 0.45;

const LOCKER_TOP_THICKNESS = 0.038;
/** How far the lid overhangs the carcase's front and ends: a thumb's grip. */
const LOCKER_TOP_PROUD = 0.022;
const LOCKER_PLINTH_SETBACK = 0.04;
const LOCKER_PLINTH_HEIGHT = 0.07;
/** Clearance between a locker's inboard end and the rudder trunk's casing. */
const LOCKER_TRUNK_CLEAR = 0.025;
const LOCKER_SQUAB_THICKNESS = 0.055;
/** Timber round the raised field on a locker front. */
const LOCKER_FIELD_MARGIN = 0.07;
const LOCKER_FIELD_PROUD = 0.009;

/** The forward face of the stern lockers — what everything abaft has to clear. */
export function sternLockerFrontZ(): number {
  return belowDecksSpace('cabin').zAft + LOCKER_DEPTH;
}

/**
 * A locker across the transom, one hand of the rudder trunk.
 *
 * **The back is asked of the wall at the height of the lid, and the carcase's is
 * asked at the sole, and those are two different stations.** The lining's foot
 * is plumb for its first 0.16 m and then rakes: at the sole it is at the sole's
 * own after edge, at 0.48 m it is 0.098 m abaft that. A carcase run back to the
 * upper figure would be standing on 0.098 m of nothing, which is the fault this
 * ship has found under a bulkhead, under a coaming and under a wedge of counter
 * already. So the box stands on the floor it has, and the *lid* runs aft to meet
 * the wall — a lid overhanging its box, which is joinery, and which roofs the
 * wedge so there is no slot to see down.
 */
function sternLocker(hand: 1 | -1): InteriorFitting {
  const space = belowDecksSpace('cabin');
  const soleY = space.soleY;
  const topY = soleY + LOCKER_HEIGHT;
  const carcaseTop = topY - LOCKER_TOP_THICKNESS;

  // Aft: the sole's own after edge, which is where the lining's plumb foot is.
  const zAft = space.zAft;
  const zForward = sternLockerFrontZ();
  // The lid runs back to the wall at its own height.
  const zLidAft = sternLiningZAt(topY);

  // The outboard end. Tightest of what the room's side allows over the carcase
  // and what the after lining allows at the lid — the piece straddles the join
  // between the two and has to satisfy both.
  const outboard = Math.min(
    sideLimitOver(space, zAft, zForward, soleY, topY),
    sternLiningHalfWidthAt(topY),
  );
  const inboard = RUDDER_TRUNK_HALF_BREADTH + LOCKER_TRUNK_CLEAR;

  const xLo = hand > 0 ? inboard : -outboard;
  const xHi = hand > 0 ? outboard : -inboard;

  const solids: FittingSolid[] = [];

  // The plinth, set back so the carcase reads as standing on something.
  solids.push(
    span(
      xLo + LOCKER_PLINTH_SETBACK,
      xHi - LOCKER_PLINTH_SETBACK,
      soleY,
      soleY + LOCKER_PLINTH_HEIGHT,
      zAft,
      zForward - LOCKER_PLINTH_SETBACK,
      'timber',
      false,
    ),
  );

  // The carcase. **The one collidable piece**, and it is what stops a body
  // walking aft into the stern windows: 0.48 m is above the walker's 0.40 m
  // step-over, so this is a wall rather than a kerb.
  solids.push(
    span(xLo, xHi, soleY + LOCKER_PLINTH_HEIGHT, carcaseTop, zAft, zForward, 'timber', true),
  );

  // A raised field on the front, which is what makes a box a locker at a glance.
  solids.push(
    span(
      xLo + LOCKER_FIELD_MARGIN,
      xHi - LOCKER_FIELD_MARGIN,
      soleY + LOCKER_PLINTH_HEIGHT + LOCKER_FIELD_MARGIN,
      carcaseTop - LOCKER_FIELD_MARGIN,
      zForward,
      zForward + LOCKER_FIELD_PROUD,
      'timber',
      false,
    ),
  );

  // The lid: proud of the carcase at the *front only*, and run aft to the
  // lining. Collidable with the carcase, because it is the surface a body
  // actually meets at hip height.
  //
  // **Not proud at the ends, and that is not tidiness.** This locker is fitted
  // between the rudder trunk's casing and the ship's side with 25 mm of
  // clearance at one end and none at the other; a lid overhanging both would
  // leave 3 mm of air against the trunk — a gap narrow enough to shimmer rather
  // than read — and bury 23 mm of itself in the lining at the other. A piece
  // built into a space is scribed at the ends and only overhangs where there is
  // somewhere to overhang into, which here is the front.
  solids.push(
    span(xLo, xHi, carcaseTop, topY, zLidAft, zForward + LOCKER_TOP_PROUD, 'timber', true),
  );

  // The squab. Inset from the lid all round so the timber shows as a border,
  // for the reason the desk's skiver needed 95 mm of it: a soft thing laid edge
  // to edge on a hard one reads as paint on the hard one.
  solids.push(
    span(
      xLo + 0.03,
      xHi - 0.03,
      topY,
      topY + LOCKER_SQUAB_THICKNESS,
      zLidAft + 0.03,
      zForward - 0.03,
      'wool',
      false,
    ),
  );

  // A brass ring on the front, which says the lid lifts. It does not lift — the
  // lockers are not closures this round — and a ring is the honest amount of
  // promise to make about that: a handle is a thing a locker has, where a
  // half-open lid would be a state nothing maintains.
  const ringX = (xLo + xHi) / 2;
  solids.push({
    kind: 'bar',
    a: v3(ringX - 0.055, soleY + LOCKER_PLINTH_HEIGHT + 0.16, zForward + LOCKER_FIELD_PROUD + 0.006),
    b: v3(ringX + 0.055, soleY + LOCKER_PLINTH_HEIGHT + 0.16, zForward + LOCKER_FIELD_PROUD + 0.006),
    radiusA: 0.009,
    radiusB: 0.009,
    material: 'brass',
    collides: false,
  });

  return {
    name: hand > 0 ? 'sternLockerPort' : 'sternLockerStarboard',
    kind: 'sternLocker',
    solids,
    // Not standable, and the desk's reason: nothing aboard invites a player onto
    // the furniture, and a 0.48 m lid under a 2.0 m deckhead is a step to
    // nowhere the walker would then have to be got down from.
    standable: null,
  };
}

export function sternLockerPort(): InteriorFitting {
  return sternLocker(1);
}

export function sternLockerStarboard(): InteriorFitting {
  return sternLocker(-1);
}

// --- the berth ----------------------------------------------------------------

/** How far the berth's after end stands off the stern lockers' front. */
const BERTH_OFF_LOCKERS = 0.06;
const BERTH_LENGTH = 1.90;

/**
 * Clear width of the berth across the mattress.
 *
 * A single berth is 0.70–0.75 m. **It is now one number rather than a width and
 * a taper, and deleting the second one is the whole of what turning this piece
 * bought.** See `boxBerthGeometry`.
 */
const BERTH_WIDTH = 0.72;

/** Where the bunk bottom is: the top of the boards the mattress lies on. */
const BERTH_SHELF_Y = 0.50;
const BERTH_MATTRESS = 0.145;
/** How far the lee board stands above the bunk bottom. */
const BERTH_LEE_BOARD = 0.24;
const BERTH_LEE_THICKNESS = 0.032;
/** How far the head and foot boards stand above the bunk bottom. */
const BERTH_END_BOARD = 0.34;
const BERTH_PLINTH_HEIGHT = 0.075;
const BERTH_PLINTH_SETBACK = 0.045;
const BERTH_DRAWERS = 2;
const BERTH_DRAWER_PROUD = 0.011;
/** How high the curtain rail is slung above the sole. */
const BERTH_RAIL_Y = 1.70;
/** The gathered cloth occupies this much of the berth at its foot. */
const BERTH_CURTAIN_GATHER = 0.21;
/** Enough shallow folds to read as cloth without leaving privacy gaps. */
const BERTH_CURTAIN_PLEATS = 12;
const BERTH_CURTAIN_DEPTH = 0.055;

/**
 * The berth, resolved — the numbers the bedding and the shelf over it read.
 *
 * Published for the reason `chartDeskGeometry` is: three things need the same
 * four figures, and each of them computing its own is how a pillow ends up a
 * centimetre inside a mattress in a way no test that did the same arithmetic
 * would ever catch. Everything here is in the **berth's own frame** — see
 * `PieceFrame` — so a dimension in this file is a fact about the bed rather than
 * about where the bed happens to be pointing.
 */
export interface BoxBerthGeometry {
  /** Which way the berth faces, and what it turns about. */
  readonly frame: PieceFrame;
  /** The bunk front, in the berth's own frame. */
  readonly xInboard: number;
  /** The back, against the lining. */
  readonly xOutboard: number;
  readonly zAft: number;
  readonly zForward: number;
  readonly soleY: number;
  /** Top of the bunk bottom boards. The mattress lies on this. */
  readonly shelfY: number;
  /** Top of the mattress. What a body would be lying on. */
  readonly mattressY: number;
}

let cachedBerth: BoxBerthGeometry | null = null;

/**
 * **The berth lies along the ship's side, and that replaced a two-bay carcase.**
 *
 * The cabin narrows 0.12 m of half-breadth per metre of length, so a square
 * 1.90 m berth hard against the lining touches at one end and stands 0.23 m off
 * at the other. This round's first answer was to build it in two bays that each
 * asked the side for their own width, keeping the bunk front one fair line and
 * putting the 0.11 m step in the back under the mattress. It worked, and it cost
 * a `[number, number]` in the published geometry, a lapped joint in the bunk
 * bottom, per-bay head and foot boards, and one genuine bug — a board that
 * spanned both bays at the wider one's width and stood 92 mm inside the
 * planking.
 *
 * `align: 'side'` is the better answer to the same question and it arrived from
 * the desk's round. **Measured on this berth, along its outboard face:**
 *
 * | square, one box | 0.230 m |
 * | two bays        | 0.138 m |
 * | laid along the side | **0.024 m** |
 *
 * Six times closer than the two-bay carcase and ten times closer than a square
 * one, from one box instead of two, with no step to hide and nothing that can be
 * sized to the wrong bay. It touches at z −6.35 and opens to 24 mm at the head
 * and 22 mm at the foot, which is a chord under a curve and is as close as a
 * straight thing gets to a bent one.
 *
 * **The two-bay construction is gone rather than kept alongside it**: two
 * mechanisms for one taper in one room is how a person ends up fixing the wrong
 * one.
 *
 * The gap that is left is not filled. That is still Ash's rejected-wedge verdict
 * and it still governs.
 */
export function boxBerthGeometry(): BoxBerthGeometry {
  if (cachedBerth) return cachedBerth;
  const p = placeInRoom({
    space: 'cabin',
    from: 'aft',
    // Off the lockers rather than off the bulkhead, and derived rather than
    // typed: move the lockers and the bed moves ahead of them.
    offset: LOCKER_DEPTH + BERTH_OFF_LOCKERS,
    length: BERTH_LENGTH,
    hand: 'starboard',
    align: 'side',
    inboard: 0,
    width: BERTH_WIDTH,
    // **The whole envelope, up to the curtain rail, rather than the carcase.**
    // The rail is 1.70 m up and is the highest timber on the piece; declaring
    // only the 0.84 m of joinery would leave the deckhead over it unchecked, in
    // the corner of the room where the deck is lowest and cambering away.
    height: BERTH_RAIL_Y + 0.03,
  });

  cachedBerth = {
    frame: p.frame,
    xInboard: p.xHi,
    xOutboard: p.xLo,
    zAft: p.zAft,
    zForward: p.zForward,
    soleY: p.yLo,
    shelfY: p.yLo + BERTH_SHELF_Y,
    mattressY: p.yLo + BERTH_SHELF_Y + BERTH_MATTRESS,
  };
  return cachedBerth;
}

/**
 * The pose of the captain lying in his berth.
 *
 * **Head AFT, and this is the one berth aboard that sleeps that way.** The
 * other six are head-forward; `boxBerth` draws this bolster at `zAft + 0.07`
 * and gives the reasons — the stern lights are aft, his feet go toward his own
 * door, and the bookshelf's underside is 0.51 m over the *foot* of the mattress
 * and would otherwise be the first thing he met sitting up.
 *
 * So `zHead` is the after end here and the forward end everywhere else, and
 * `lyingPose` takes the two in that order for exactly this reason. A pose that
 * assumed one convention would put the captain's head under his own bookshelf
 * and his feet on his pillow, and nothing in the suite would have noticed.
 *
 * Lying, he looks up along the bed and forward at the deckhead over his own
 * cabin. He cannot see the stern lights — they are behind and above his own
 * pillow — which is what a berth with its head at the transom is.
 */
export function boxBerthPose(): SeatPose {
  const b = boxBerthGeometry();
  return lyingPose({
    frame: b.frame,
    xInboard: b.xInboard,
    xOutboard: b.xOutboard,
    zHead: b.zAft,
    zFoot: b.zForward,
    mattressY: b.mattressY,
  });
}

/** The mouth of the captain's berth — what he aims at to turn in. */
export function boxBerthTarget(): InteractableBox {
  const b = boxBerthGeometry();
  return framedTarget(
    b.frame,
    Math.min(b.xInboard, b.xOutboard),
    Math.max(b.xInboard, b.xOutboard),
    b.shelfY,
    b.shelfY + BERTH_MOUTH_HEIGHT,
    b.zAft,
    b.zForward,
  );
}

/**
 * The box berth against the starboard side, head aft.
 *
 * **Head aft, and that is not arbitrary.** The pillow end is the end you wake up
 * looking from, and what is aft in this room is the four stern lights. It also
 * puts your feet toward the door, which is what every berth on every vessel
 * does, and it keeps the pillow out from under the bookshelf — see `bookShelf`,
 * whose underside is 0.51 m over the mattress and would otherwise be the first
 * thing a captain sitting up in the morning met with his head.
 *
 * **To starboard the inboard face is `xHi` and the outboard face is `xLo`**,
 * which is the reverse of every port piece aboard and is named rather than
 * remembered — see the note in `washstand` for the round in which not naming it
 * built a whole piece of furniture inside out.
 */
export function boxBerth(): InteriorFitting {
  const b = boxBerthGeometry();
  const { span, rod } = drawnIn(b.frame);
  const solids: FittingSolid[] = [];
  const plinthTop = b.soleY + BERTH_PLINTH_HEIGHT;

  // The plinth, set back so the carcase reads as standing on something.
  solids.push(
    span(
      b.xOutboard,
      b.xInboard - BERTH_PLINTH_SETBACK,
      b.soleY,
      plinthTop,
      b.zAft,
      b.zForward,
      'timber',
      false,
    ),
  );

  // The carcase under the bunk: the drawer bank, solid to the bunk bottom.
  // **The collidable piece.** Its top is at 0.50, above the walker's 0.40 m
  // step-over, so a body meets a bed rather than climbing one.
  solids.push(
    span(b.xOutboard, b.xInboard, plinthTop, b.shelfY, b.zAft, b.zForward, 'timber', true),
  );

  // The bunk bottom: one board the length of the berth, which it can be again
  // now that the berth is one bay. The version that had to be laid twice and
  // lapped is in `boxBerthGeometry`'s note, along with what it cost.
  solids.push(
    span(
      b.xOutboard,
      b.xInboard,
      b.shelfY - 0.022,
      b.shelfY,
      b.zAft,
      b.zForward,
      'timber',
      false,
    ),
  );

  // The drawers under it, fronts proud with a brass ring on each. A berth over
  // drawers is what a built-in berth is for: it is the only 0.42 m of stowage in
  // the ship that is not in the hold.
  const drawerPitch = (b.zForward - b.zAft) / BERTH_DRAWERS;
  for (let i = 0; i < BERTH_DRAWERS; i++) {
    const zLo = b.zAft + drawerPitch * i + 0.014;
    const zHi = b.zAft + drawerPitch * (i + 1) - 0.014;
    solids.push(
      span(
        b.xInboard - 0.004,
        b.xInboard + BERTH_DRAWER_PROUD,
        plinthTop + 0.02,
        b.shelfY - 0.03,
        zLo,
        zHi,
        'timber',
        false,
      ),
    );
    const ringZ = (zLo + zHi) / 2;
    const ringY = (plinthTop + b.shelfY) / 2;
    solids.push(
      rod(
        v3(b.xInboard + BERTH_DRAWER_PROUD + 0.004, ringY, ringZ - 0.06),
        v3(b.xInboard + BERTH_DRAWER_PROUD + 0.004, ringY, ringZ + 0.06),
        0.010,
        0.010,
        'brass',
        false,
      ),
    );
  }

  // The lee board: the rail along the inboard edge that keeps a sleeping man in
  // his bed when she rolls. **The single most useful 0.24 m in the room and the
  // one detail that makes this a berth rather than a bed** — the desk's fiddle
  // argument, one storey up and with a body in it instead of a book.
  solids.push(
    span(
      b.xInboard - BERTH_LEE_THICKNESS,
      b.xInboard,
      b.shelfY,
      b.shelfY + BERTH_LEE_BOARD,
      b.zAft,
      b.zForward,
      'timber',
      true,
    ),
  );

  // The head and foot boards, which are what "box" means.
  for (const [zLo, zHi] of [
    [b.zAft, b.zAft + 0.03],
    [b.zForward - 0.03, b.zForward],
  ] as const) {
    solids.push(
      span(b.xOutboard, b.xInboard, b.shelfY, b.shelfY + BERTH_END_BOARD, zLo, zHi, 'timber', false),
    );
  }

  // --- what is on it --------------------------------------------------------
  // The mattress, inside the boards on every side so it reads as lying in the
  // berth rather than as a slab the same size as it.
  const mattressXOut = b.xOutboard + 0.02;
  const mattressXIn = b.xInboard - BERTH_LEE_THICKNESS - 0.008;
  solids.push(
    span(
      mattressXOut,
      mattressXIn,
      b.shelfY,
      b.mattressY,
      b.zAft + 0.035,
      b.zForward - 0.035,
      'linen',
      false,
    ),
  );

  // The pillow, at the head, which is aft.
  solids.push(
    span(
      mattressXOut + 0.06,
      mattressXIn - 0.09,
      b.mattressY,
      b.mattressY + 0.085,
      b.zAft + 0.07,
      b.zAft + 0.40,
      'linen',
      false,
    ),
  );

  // The blanket over the forward two thirds, with the sheet turned back at its
  // head. **Two materials and a fold, rather than one cover** — a bed drawn as a
  // single rectangle of anything is a shelf with a cushion on it, and what says
  // "made up" is that you can see the layers: linen at the pillow, a turn-back,
  // then wool to the foot.
  const blanketZ = b.zAft + (b.zForward - b.zAft) * 0.34;
  solids.push(
    span(
      mattressXOut,
      mattressXIn,
      b.mattressY,
      b.mattressY + 0.045,
      blanketZ,
      b.zForward - 0.035,
      'wool',
      false,
    ),
  );
  solids.push(
    span(
      mattressXOut,
      mattressXIn,
      b.mattressY + 0.045,
      b.mattressY + 0.062,
      blanketZ - 0.10,
      blanketZ + 0.03,
      'linen',
      false,
    ),
  );

  // --- the curtain rail -----------------------------------------------------
  // The rail is fixed joinery. The cloth itself is stateful and is built by
  // `boxBerthCurtain`, outside this fixed fitting, so drawing it back changes
  // both what the player sees and what their gaze can reach behind it.
  const railY = b.soleY + BERTH_RAIL_Y;
  solids.push(
    rod(
      v3(b.xInboard + 0.015, railY, b.zAft + 0.02),
      v3(b.xInboard + 0.015, railY, b.zForward - 0.02),
      0.014,
      0.014,
      'brass',
      false,
    ),
  );

  return {
    name: 'boxBerth',
    kind: 'boxBerth',
    solids,
    // Not standable. See `INTERIOR_FITTING_KINDS.boxBerth`: getting into the
    // berth is an action with a verb if it is ever anything, not a surface a
    // player wanders onto at 0.50 m and then has to be got off.
    standable: null,
  };
}

/** The bottom hem of the closed cloth, just overlapping the lee board. */
function berthCurtainBottomY(): number {
  const b = boxBerthGeometry();
  return b.shelfY + BERTH_LEE_BOARD - 0.02;
}

/**
 * The captain's privacy curtain, either gathered at the foot or drawn aft.
 *
 * This used to be a decorative promise: the brass rail and a gathered bundle
 * were visible, but no state or action could draw the cloth. Closed, these
 * contiguous shallow pleats span the berth mouth and are ordinary opaque linen
 * geometry. They therefore actually screen the sleeper and prevent the berth
 * behind them being selected; open, the old gathered silhouette remains at the
 * foot where the player can point at it to close it again.
 */
export function boxBerthCurtain(open: boolean): InteriorFitting {
  const b = boxBerthGeometry();
  const { span } = drawnIn(b.frame);
  const railY = b.soleY + BERTH_RAIL_Y;
  const bottomY = berthCurtainBottomY();
  const solids: FittingSolid[] = [];

  if (open) {
    solids.push(
      span(
        b.xInboard - BERTH_CURTAIN_DEPTH / 2,
        b.xInboard + BERTH_CURTAIN_DEPTH / 2,
        bottomY,
        railY - 0.02,
        b.zForward - BERTH_CURTAIN_GATHER,
        b.zForward - 0.03,
        'linen',
        false,
      ),
    );
  } else {
    const zLo = b.zAft + 0.03;
    const zHi = b.zForward - 0.03;
    const pitch = (zHi - zLo) / BERTH_CURTAIN_PLEATS;
    for (let i = 0; i < BERTH_CURTAIN_PLEATS; i++) {
      // Alternating depth gives the closed sheet a readable pleated face. The
      // boxes meet in z, so no view ray slips through a decorative gap.
      const fold = i % 2 === 0 ? -0.012 : 0.012;
      solids.push(
        span(
          b.xInboard - BERTH_CURTAIN_DEPTH / 2 + fold,
          b.xInboard + BERTH_CURTAIN_DEPTH / 2 + fold,
          bottomY,
          railY - 0.02,
          zLo + pitch * i,
          zLo + pitch * (i + 1),
          'linen',
          false,
        ),
      );
    }
  }

  return {
    name: `boxBerthCurtain:${open ? 'open' : 'closed'}`,
    kind: 'boxBerthCurtain',
    solids,
    standable: null,
  };
}

/** The cloth itself, not the floor or bed behind it, as a gaze target. */
export function boxBerthCurtainTarget(open: boolean): InteractableBox {
  const b = boxBerthGeometry();
  const railY = b.soleY + BERTH_RAIL_Y;
  return framedTarget(
    b.frame,
    b.xInboard - 0.10,
    b.xInboard + 0.12,
    berthCurtainBottomY() - 0.05,
    railY + 0.04,
    open ? b.zForward - BERTH_CURTAIN_GATHER - 0.08 : b.zAft,
    b.zForward,
  );
}

// --- the washstand ------------------------------------------------------------

const WASHSTAND_OFF_FORWARD = 0.24;
const WASHSTAND_LENGTH = 0.58;
const WASHSTAND_WIDTH = 0.44;
const WASHSTAND_HEIGHT = 0.80;
const WASHSTAND_TOP_THICKNESS = 0.032;
/** How far the splashback stands above the top, against the lining. */
const WASHSTAND_SPLASHBACK = 0.22;

/**
 * The washstand in the starboard forward corner.
 *
 * `SHIP_BELOW_DECKS_PLAN.md` §4.1 asks for it there, and unlike that section's
 * headroom argument this one survives being measured: the forward corners are
 * what is left once the berth has the side and the desk has the other, and a
 * washstand is the one piece of cabin furniture that genuinely wants to be near
 * the door rather than near the windows.
 *
 * **The basin is creamware and it is drawn in `paper`.** That is not a shortcut
 * for want of a material: glazed earthenware and rag paper are within a few
 * percent of the same value, both are matt, and the palette's own rule is that a
 * material earns its row by doing a job no existing row does. A seventh entry
 * whose only difference from `paper` is the story attached to it is the column
 * nobody fills.
 *
 * **It lies along the side, and the splashback is why that was worth doing on a
 * piece only 0.58 m long.** Square, this stands 70 mm off the lining at one end
 * — which is nothing behind a chest of drawers and is a visible slot behind a
 * board whose entire job is to be the surface the water hits. Turned, it is
 * 20 mm.
 */
export function washstand(): InteriorFitting {
  const p = placeInRoom({
    space: 'cabin',
    from: 'forward',
    offset: WASHSTAND_OFF_FORWARD,
    length: WASHSTAND_LENGTH,
    hand: 'starboard',
    align: 'side',
    inboard: 0,
    width: WASHSTAND_WIDTH,
    height: WASHSTAND_HEIGHT,
  });
  const { span, rod } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  const topY = p.yHi;
  const carcaseTop = topY - WASHSTAND_TOP_THICKNESS;
  const midZ = (p.zAft + p.zForward) / 2;

  /**
   * **Which face is against the ship and which faces the room, said once.**
   *
   * `RoomPlacement` reports `xLo` and `xHi` as a span, not as outboard and
   * inboard, and which is which flips with the hand: to port the outboard face
   * is `xHi`, to starboard it is `xLo`. The chart rack and the chart desk are
   * both port pieces and both read `xHi` as the lining — so the first version of
   * this washstand, copied from them onto the starboard side, hung its
   * splashback in the middle of the room and its towel rail inside the hull.
   * Nothing threw and nothing failed; the piece was simply built inside out.
   *
   * Naming the two faces is the fix, and every starboard piece in this file
   * should do the same rather than remembering which way round it is.
   */
  const xOutboard = p.xLo;
  const xInboard = p.xHi;
  const midX = (xOutboard + xInboard) / 2;

  // Two standards and a shelf between them, which is what a washstand is: an
  // open frame with the basin in the top and the ewer on the shelf under it.
  for (const [zLo, zHi] of [
    [p.zAft, p.zAft + 0.035],
    [p.zForward - 0.035, p.zForward],
  ] as const) {
    solids.push(span(xOutboard, xInboard, p.yLo, carcaseTop, zLo, zHi, 'timber', true));
  }
  // The lower shelf.
  solids.push(
    span(xOutboard, xInboard, p.yLo + 0.26, p.yLo + 0.286, p.zAft, p.zForward, 'timber', false),
  );
  // Its fiddle, on the room side, because a ewer left on an open shelf at sea is
  // a ewer on the sole. Same 35 mm the desk's is.
  solids.push(
    span(
      xInboard - 0.016,
      xInboard,
      p.yLo + 0.286,
      p.yLo + 0.321,
      p.zAft,
      p.zForward,
      'timber',
      false,
    ),
  );
  // The top.
  solids.push(span(xOutboard, xInboard, carcaseTop, topY, p.zAft, p.zForward, 'timber', true));
  // The splashback against the lining — the piece that stops this reading as a
  // side table with a bowl on it.
  solids.push(
    span(
      xOutboard,
      xOutboard + 0.02,
      topY,
      topY + WASHSTAND_SPLASHBACK,
      p.zAft,
      p.zForward,
      'timber',
      false,
    ),
  );
  // And a small shelf on it for a razor and a cake of soap.
  solids.push(
    span(
      xOutboard,
      xOutboard + 0.10,
      topY + WASHSTAND_SPLASHBACK - 0.024,
      topY + WASHSTAND_SPLASHBACK,
      p.zAft + 0.06,
      p.zForward - 0.06,
      'timber',
      false,
    ),
  );

  // The basin: an open creamware bowl. This used to be a capped tapered tube,
  // which made the top a solid cream disc and therefore read as one large
  // object rather than a vessel. The same outer frustum remains the truthful
  // fitting envelope, while the geometry profile cuts a deep inner wall and
  // open mouth into it.
  const basin = rod(
    v3(midX - 0.02, topY, midZ),
    v3(midX - 0.02, topY + 0.095, midZ),
    0.115,
    0.155,
    'paper',
    false,
  );
  // `rod` is typed in the shared fitting vocabulary; this call is necessarily
  // its bar arm, and keeping the guard makes a future primitive change fail
  // here instead of quietly dropping the bowl profile.
  if (basin.kind !== 'bar') throw new Error('wash basin must be a round fitting');
  solids.push({ ...basin, profile: 'open-bowl' });
  // A small dark drain at the bottom gives the eye an unambiguous depth cue.
  solids.push(
    rod(
      v3(midX - 0.02, topY + 0.019, midZ),
      v3(midX - 0.02, topY + 0.022, midZ),
      0.012,
      0.012,
      'brass',
      false,
    ),
  );
  // The ewer on the shelf below, with a handle.
  const ewerX = midX + 0.02;
  const ewerZ = midZ + 0.13;
  const ewerFoot = p.yLo + 0.321;
  solids.push(
    rod(
      v3(ewerX, ewerFoot, ewerZ),
      v3(ewerX, ewerFoot + 0.215, ewerZ),
      0.062,
      0.048,
      'paper',
      false,
    ),
  );
  solids.push(
    rod(
      v3(ewerX, ewerFoot + 0.055, ewerZ - 0.062),
      v3(ewerX, ewerFoot + 0.185, ewerZ - 0.062),
      0.011,
      0.011,
      'paper',
      false,
    ),
  );

  // A brass rail on the inboard side with a towel over it. The towel is the one
  // thing in this corner that hangs, and a room where nothing hangs is a room
  // with no gravity in it.
  const railX = xInboard + 0.035;
  solids.push(
    rod(
      v3(railX, topY - 0.10, p.zAft + 0.08),
      v3(railX, topY - 0.10, p.zForward - 0.08),
      0.010,
      0.010,
      'brass',
      false,
    ),
  );
  solids.push(
    span(
      railX - 0.014,
      railX + 0.014,
      topY - 0.34,
      topY - 0.09,
      p.zAft + 0.14,
      p.zForward - 0.14,
      'linen',
      false,
    ),
  );

  return { name: 'washstand', kind: 'washstand', solids, standable: null };
}

// --- the hanging locker -------------------------------------------------------

const HANGING_LOCKER_OFF_FORWARD = 0.14;
const HANGING_LOCKER_LENGTH = 0.74;
const HANGING_LOCKER_WIDTH = 0.56;
/** Clear air left between the locker's cornice and the beams over it. */
const HANGING_LOCKER_HEADROOM = 0.10;
const HANGING_LOCKER_PANEL = 0.028;
const HANGING_LOCKER_FIELD_MARGIN = 0.075;

/**
 * The hanging locker, port side against the forward bulkhead.
 *
 * Where the oilskins and the shore-going coat live, and the only tall object in
 * the room. That is most of what it is for compositionally: the cabin is
 * otherwise all horizontals — a desk, a berth, two lockers, a floor — and one
 * vertical mass by the door gives the eye something to measure the room against.
 *
 * **Its height is derived, not chosen.** The deckhead falls forward and outboard
 * and this piece is in the corner where it is lowest, so a typed 1.70 would be
 * right until somebody changed the camber and then it would be a locker through
 * the beams. It is as tall as the lowest deckhead over its own footprint allows,
 * less a hand's breadth — which is what a joiner building in place would do, and
 * `placeInRoom` throws rather than clamps if that arithmetic is ever wrong.
 *
 * **It lies along the side too, and it is the piece where that is least obvious
 * and matters most.** A press is a tall flat face; a 90 mm wedge of daylight
 * down its outboard edge is a wedge 1.7 m high, seen from the doorway you come
 * in by. Turned, the gap is under a millimetre. The cost is that its forward end
 * is no longer parallel to the bulkhead 0.14 m ahead of it — which was the
 * argument for leaving it square, and it does not survive the comparison: a gap
 * that was already there going slightly out of true is a smaller fault than a
 * new one the height of the room.
 */
export function hangingLocker(): InteriorFitting {
  const space = belowDecksSpace('cabin');
  const zForward = space.zForward - HANGING_LOCKER_OFF_FORWARD;
  const zAft = zForward - HANGING_LOCKER_LENGTH;

  // Ask the room how tall the piece may be, over the footprint it will actually
  // occupy. The side is plumb in this cabin, so one pass over a generous band
  // resolves the outboard face exactly.
  const limit = sideLimitOver(space, zAft, zForward, space.soleY, space.soleY + 2);
  let deckhead = Infinity;
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const x = limit - HANGING_LOCKER_WIDTH + (HANGING_LOCKER_WIDTH * i) / 4;
      const z = zAft + ((zForward - zAft) * j) / 4;
      const head = spaceDeckheadY(space, x, z);
      if (head !== null) deckhead = Math.min(deckhead, head);
    }
  }
  if (!Number.isFinite(deckhead)) {
    throw new Error('the hanging locker stands under no deckhead');
  }
  const height = deckhead - space.soleY - HANGING_LOCKER_HEADROOM;

  const p = placeInRoom({
    space: 'cabin',
    from: 'forward',
    offset: HANGING_LOCKER_OFF_FORWARD,
    length: HANGING_LOCKER_LENGTH,
    hand: 'port',
    align: 'side',
    inboard: 0,
    width: HANGING_LOCKER_WIDTH,
    height,
  });

  const { span, rod } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  // The carcase, solid. A wardrobe is a box and a body meets it as one.
  solids.push(span(p.xLo, p.xHi, p.yLo + 0.06, p.yHi - 0.05, p.zAft, p.zForward, 'timber', true));
  // Plinth and cornice, both proud of the carcase at their own ends. A tall box
  // with neither is a crate stood on end.
  solids.push(
    span(p.xLo, p.xHi, p.yLo, p.yLo + 0.06, p.zAft - 0.012, p.zForward + 0.012, 'timber', false),
  );
  solids.push(
    span(
      p.xLo - 0.016,
      p.xHi,
      p.yHi - 0.05,
      p.yHi,
      p.zAft - 0.016,
      p.zForward + 0.016,
      'timber',
      false,
    ),
  );

  // Two doors on the inboard face, each with a raised field, and a bead of
  // shadow down the middle where they meet.
  const midZ = (p.zAft + p.zForward) / 2;
  for (const [zLo, zHi] of [
    [p.zAft + 0.02, midZ - 0.006],
    [midZ + 0.006, p.zForward - 0.02],
  ] as const) {
    solids.push(
      span(
        p.xLo - HANGING_LOCKER_PANEL,
        p.xLo,
        p.yLo + 0.09,
        p.yHi - 0.08,
        zLo,
        zHi,
        'timber',
        false,
      ),
    );
    solids.push(
      span(
        p.xLo - HANGING_LOCKER_PANEL - 0.008,
        p.xLo - HANGING_LOCKER_PANEL,
        p.yLo + 0.09 + HANGING_LOCKER_FIELD_MARGIN,
        p.yHi - 0.08 - HANGING_LOCKER_FIELD_MARGIN,
        zLo + HANGING_LOCKER_FIELD_MARGIN,
        zHi - HANGING_LOCKER_FIELD_MARGIN,
        'timber',
        false,
      ),
    );
  }
  // Two brass knobs, either side of the meeting stile.
  for (const side of [-1, 1] as const) {
    solids.push(
    rod(
      v3(p.xLo - HANGING_LOCKER_PANEL - 0.008, (p.yLo + p.yHi) / 2, midZ + side * 0.05),
      v3(p.xLo - HANGING_LOCKER_PANEL - 0.042, (p.yLo + p.yHi) / 2, midZ + side * 0.05),
      0.014,
      0.020,
      'brass',
      false,
    ),
  );
  }

  return { name: 'hangingLocker', kind: 'hangingLocker', solids, standable: null };
}

// --- the captain's sea chest -------------------------------------------------

/**
 * A small personal chest in the only useful gap left on the port side.
 *
 * The canonical plan put a sea chest in a forward corner. The tall hanging
 * locker ultimately took the corner itself, but it left 0.69 m between its
 * after face and the chart desk. This chest uses 0.50 m of that gap with a
 * hand's breadth at either end. It is placed off the hanging locker rather than
 * by copying either piece's station, so changing that locker moves the chest
 * instead of letting the two grow through one another.
 *
 * At 0.50 m it is smaller than the metre-long naval chests that survive in
 * museums, and that is deliberate. This is a 15.5 m schooner with a 9.3 m²
 * cabin, not a frigate's great cabin; the hanging press already carries the
 * captain's clothes. The chest is for papers, valuables and the few personal
 * things that ought not live in an unlocked desk drawer.
 */
const SEA_CHEST_OFF_FORWARD = HANGING_LOCKER_OFF_FORWARD + HANGING_LOCKER_LENGTH + 0.12;
const SEA_CHEST_LENGTH = 0.50;
const SEA_CHEST_WIDTH = 0.47;
const SEA_CHEST_HEIGHT = 0.44;
const SEA_CHEST_LID = 0.055;

export function captainSeaChest(): InteriorFitting {
  const p = placeInRoom({
    space: 'cabin',
    from: 'forward',
    offset: SEA_CHEST_OFF_FORWARD,
    length: SEA_CHEST_LENGTH,
    hand: 'port',
    align: 'side',
    inboard: 0,
    width: SEA_CHEST_WIDTH,
    height: SEA_CHEST_HEIGHT,
  });
  const { span, rod } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  const lidLo = p.yHi - SEA_CHEST_LID;
  const xMid = (p.xLo + p.xHi) / 2;
  const zMid = (p.zAft + p.zForward) / 2;

  // A recessed plinth, the deal carcase and its slightly proud lid. This is a
  // travelling chest rather than a pirate prop: low, square, iron-bound and
  // made to survive being carried through a companionway.
  solids.push(
    span(
      p.xLo + 0.035,
      p.xHi - 0.025,
      p.yLo,
      p.yLo + 0.055,
      p.zAft + 0.035,
      p.zForward - 0.035,
      'timber',
      false,
    ),
  );
  solids.push(
    span(p.xLo, p.xHi, p.yLo + 0.055, lidLo, p.zAft, p.zForward, 'timber', true),
  );
  // Scribed to the lining outboard, proud only into the room and at its ends.
  solids.push(
    span(
      p.xLo - 0.018,
      p.xHi,
      lidLo,
      p.yHi,
      p.zAft - 0.018,
      p.zForward + 0.018,
      'timber',
      true,
    ),
  );

  // Leather on the lid and the two straps continued over it. The inboard face
  // carries the historical detail, but the ordinary standing view mostly sees
  // this top; carrying the same construction across it is what makes the low
  // dark box read as a bound travelling chest from the middle of the cabin.
  solids.push(
    span(
      p.xLo - 0.012,
      p.xHi - 0.012,
      p.yHi,
      p.yHi + 0.0025,
      p.zAft + 0.018,
      p.zForward - 0.018,
      'leather',
      false,
    ),
  );

  // Leather over the room-facing panel, with brass straps and a central
  // escutcheon. The chest in Royal Museums Greenwich dated 1770–80 is
  // leather-covered and brass-nailed; this uses the same restrained vocabulary
  // without turning the whole object into a bright jewellery box.
  solids.push(
    span(
      p.xLo - 0.008,
      p.xLo,
      p.yLo + 0.09,
      lidLo - 0.025,
      p.zAft + 0.028,
      p.zForward - 0.028,
      'leather',
      false,
    ),
  );
  for (const z of [p.zAft + 0.075, p.zForward - 0.075]) {
    solids.push(
      span(
        p.xLo - 0.013,
        p.xLo - 0.007,
        p.yLo + 0.075,
        p.yHi - 0.018,
        z - 0.017,
        z + 0.017,
        'brass',
        false,
      ),
    );
    solids.push(
      span(
        p.xLo - 0.014,
        p.xHi - 0.010,
        p.yHi + 0.0025,
        p.yHi + 0.006,
        z - 0.017,
        z + 0.017,
        'brass',
        false,
      ),
    );
  }
  solids.push(
    span(
      p.xLo - 0.016,
      p.xLo - 0.008,
      p.yLo + 0.235,
      p.yLo + 0.285,
      zMid - 0.032,
      zMid + 0.032,
      'brass',
      false,
    ),
  );

  // Rope beckets on the end boards. Three short dark-hide bars make each loop;
  // there is no bright rope material in this room and a tarred becket should
  // not look like the berth linen.
  for (const z of [p.zAft - 0.011, p.zForward + 0.011]) {
    const yTop = p.yLo + 0.29;
    const yBottom = p.yLo + 0.19;
    for (const x of [xMid - 0.065, xMid + 0.065]) {
      solids.push(
        rod(v3(x, yBottom, z), v3(x, yTop, z), 0.008, 0.008, 'leather', false),
      );
    }
    solids.push(
      rod(
        v3(xMid - 0.065, yBottom, z),
        v3(xMid + 0.065, yBottom, z),
        0.008,
        0.008,
        'leather',
        false,
      ),
    );
  }

  return { name: 'captainSeaChest', kind: 'seaChest', solids, standable: null };
}

// --- the tell-tale compass ---------------------------------------------------

/**
 * The upside-down compass the captain can read without going on deck.
 *
 * Crown or tell-tale compasses are visible in eighteenth-century cabin
 * paintings. This one hangs over the rudder trunk and stern lockers, not in the
 * walking lane or over the chart lamp. Its pale card faces down; the case and
 * card are shallow solid cylinders because the fitting vocabulary has no torus
 * and a fake ring would put a barrel across the face.
 */
export function cabinTellTaleCompass(): InteriorFitting {
  const space = belowDecksSpace('cabin');
  const z = (space.zAft + sternLockerFrontZ()) / 2;
  // The deck cambers in x and falls in z. Ask it over the whole circular case,
  // not only at the suspension point: that first answer put the case's
  // outboard rim 6 mm through the boards while its centre was perfectly clear.
  let deckhead = Infinity;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      const head = spaceDeckheadY(space, (ix * 0.145) / 2, z + (iz * 0.145) / 2);
      if (head !== null) deckhead = Math.min(deckhead, head);
    }
  }
  if (!Number.isFinite(deckhead)) {
    throw new Error('the cabin tell-tale hangs under no deckhead');
  }

  const { rod } = drawnIn(SQUARE_FRAME);
  const caseTop = deckhead - 0.075;
  const caseBottom = deckhead - 0.135;
  const faceY = caseBottom - 0.003;
  const solids: FittingSolid[] = [
    // Hook and short suspension. The lamp uses a chain; the compass wants to
    // stay square with the keel, so it gets a stiff brass stem.
    rod(v3(0, caseTop, z), v3(0, deckhead - 0.012, z), 0.010, 0.007, 'brass', false),
    // Timber case and the pale card set just below it, face-down to the room.
    rod(v3(0, caseBottom, z), v3(0, caseTop, z), 0.145, 0.145, 'timber', false),
    rod(v3(0, faceY, z), v3(0, caseBottom, z), 0.112, 0.112, 'paper', false),
    // A restrained north-south needle and central boss. These are small enough
    // not to hide the card and bright enough to identify the object under a
    // lantern from the middle of the room.
    rod(
      v3(0, faceY - 0.004, z - 0.082),
      v3(0, faceY - 0.004, z + 0.082),
      0.005,
      0.005,
      'brass',
      false,
    ),
    rod(
      v3(0, faceY - 0.010, z),
      v3(0, faceY - 0.002, z),
      0.012,
      0.012,
      'brass',
      false,
    ),
  ];

  return {
    name: 'cabinTellTaleCompass',
    kind: 'tellTaleCompass',
    solids,
    standable: null,
  };
}

// --- the bookshelf ------------------------------------------------------------

/**
 * How far above the sole the shelf's underside hangs.
 *
 * 1.15, and it is set by the berth under it rather than by the eye: the mattress
 * is at 0.645, so this leaves 0.505 m of clear air over the bed — enough to sit
 * up in without meeting it, if only just, and it is over the *foot* half of the
 * berth for the case where that is not enough. It is also at standing eye height
 * for someone in the middle of the room, which is where a shelf of books belongs.
 */
const SHELF_SILL = 1.15;
const SHELF_HEIGHT = 0.34;
const SHELF_DEPTH = 0.20;
const SHELF_LENGTH = 0.82;
const SHELF_PANEL = 0.016;
/** The fiddle across the front. Books at sea leave the shelf without one. */
const SHELF_FIDDLE = 0.07;

/**
 * The shelf of books over the foot of the berth.
 *
 * **Never collidable, and the reason is geometric rather than a preference** —
 * the chart rack's argument, on the other side of the room.
 *
 * The claim to make is about *reach*, not about footprints, and the first
 * version of this comment got that wrong: it said the shelf hangs entirely
 * inside the berth's footprint in x, and it does not quite. The reasoning it was
 * supporting was never about that.
 *
 * What is true: the shelf's inboard face is over 0.6 m outboard of the bunk
 * front, the berth is solid from the sole to 0.74 m, and a walker is a cylinder
 * of 0.26 m radius — so a body pressed as hard against the berth as it can get
 * is still the better part of a metre short of the nearest timber on this shelf.
 * A collider that far inside another's shadow is a claim nothing can ever check.
 *
 * **It lies along the lining, and of everything in this room it is the piece
 * with the least choice about it.** The berth and the washstand stand on the
 * sole and are merely *against* the side; a shelf is screwed *to* it. A square
 * shelf on a curving lining is fixed to the timber at one end and floating 0.1 m
 * off it at the other — not a poor fit but an impossible one, since there is
 * nothing at the far end for the screws to go into.
 */
export function bookShelf(): InteriorFitting {
  const b = boxBerthGeometry();
  const space = belowDecksSpace('cabin');

  const p = placeInRoom({
    space: 'cabin',
    // **Centred on a station rather than offset from a bulkhead**, because what
    // this piece has to satisfy is that it is over the foot of the bed — the
    // chart rack's lesson, which spent a round hanging over nothing after the
    // desk moved out from under it. `from: 'centre'` exists for exactly this,
    // and it means the shelf's *footprint* is centred there however the turn
    // lengthens it.
    from: 'centre',
    // A quarter of the berth's length forward of its middle, which puts the
    // whole shelf over the foot half with its after end clear of the middle
    // rather than straddling it. At 0.22 the after corner landed 2 mm abaft the
    // midpoint — harmless, and a margin that thin is a margin that is really
    // just an accident of the shelf's length.
    offset: b.frame.pivotZ - space.zAft + BERTH_LENGTH * 0.26,
    length: SHELF_LENGTH,
    hand: 'starboard',
    align: 'side',
    inboard: 0,
    width: SHELF_DEPTH,
    sill: SHELF_SILL,
    height: SHELF_HEIGHT,
  });

  const { span } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  const shelfY = p.yLo + SHELF_HEIGHT * 0.46;
  // Named, not remembered — see the note in `washstand`. To starboard the
  // outboard face is `xLo`, which is the opposite of every port piece aboard.
  const xOutboard = p.xLo;
  const xInboard = p.xHi;

  // Back against the lining, two ends, top, bottom and one middle shelf.
  solids.push(
    span(xOutboard, xOutboard + SHELF_PANEL, p.yLo, p.yHi, p.zAft, p.zForward, 'timber', false),
  );
  for (const [zLo, zHi] of [
    [p.zAft, p.zAft + SHELF_PANEL],
    [p.zForward - SHELF_PANEL, p.zForward],
  ] as const) {
    solids.push(span(xOutboard, xInboard, p.yLo, p.yHi, zLo, zHi, 'timber', false));
  }
  for (const [yLo, yHi] of [
    [p.yLo, p.yLo + SHELF_PANEL],
    [shelfY, shelfY + SHELF_PANEL],
    [p.yHi - SHELF_PANEL, p.yHi],
  ] as const) {
    solids.push(span(xOutboard, xInboard, yLo, yHi, p.zAft, p.zForward, 'timber', false));
  }

  // The books. **Three materials and no two the same width**, because a row of
  // identical blocks in one colour is a solid, and what makes a shelf read as
  // books is the ragged top edge and the change of binding every few volumes.
  // Bound in leather, in paper boards and in cloth, which is what a working
  // library of the period actually looked like.
  const bindings = ['leather', 'timber', 'paper', 'wool', 'leather', 'timber'] as const;
  const widths = [0.042, 0.031, 0.055, 0.028, 0.048, 0.036];
  const heights = [0.9, 0.82, 1.0, 0.76, 0.94, 0.86];
  for (const [tierLo, tierHi] of [
    [p.yLo + SHELF_PANEL, shelfY],
    [shelfY + SHELF_PANEL, p.yHi - SHELF_PANEL],
  ] as const) {
    let z = p.zAft + SHELF_PANEL + 0.012;
    for (let i = 0; i < bindings.length; i++) {
      const width = widths[(i + (tierLo > shelfY ? 3 : 0)) % widths.length];
      if (z + width > p.zForward - SHELF_PANEL - 0.01) break;
      const height = (tierHi - tierLo) * heights[(i + (tierLo > shelfY ? 2 : 0)) % heights.length];
      solids.push(
        span(
          xOutboard + SHELF_PANEL,
          xInboard - 0.03,
          tierLo,
          tierLo + height,
          z,
          z + width,
          bindings[i],
          false,
        ),
      );
      z += width + 0.004;
    }
  }

  // The fiddle across the front of each tier, over the books.
  for (const yLo of [p.yLo + SHELF_PANEL, shelfY + SHELF_PANEL]) {
    solids.push(
      span(
        xInboard - 0.014,
        xInboard,
        yLo,
        yLo + SHELF_FIDDLE,
        p.zAft,
        p.zForward,
        'timber',
        false,
      ),
    );
  }

  return { name: 'bookShelf', kind: 'bookShelf', solids, standable: null };
}
