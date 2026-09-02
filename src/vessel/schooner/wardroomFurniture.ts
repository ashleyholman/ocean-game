import type { InteractableBox } from '../../player/Interactables';
import type { SeatPose } from '../../player/SeatedStation';
import { PUMP_WELL_HALF, PUMP_Z } from './deckFittings';
import type { FittingSolid } from './deckFittings';
import { BERTH_MOUTH_HEIGHT, lyingPose, seatedPose } from './seatedBody';
import {
  BULKHEAD_THICKNESS,
  DOORWAY_HALF_BREADTH,
  DOORWAY_HEIGHT,
  DOORWAY_OFFSET,
  HATCHWAY_HALF_BREADTH,
  belowDecksSpace,
} from './deckInterior';
import { LAMP_HANGS, LAMP_REACH_HALF } from './lampPlacement';
import { mastSectionAt } from './rig';
import {
  SQUARE_FRAME,
  drawnIn,
  framedTarget,
  lowestDeckheadOver,
  placeInRoom,
  sideLimitOver,
  span,
} from './roomFitting';
import type { Hand, InteriorFitting, RoomPlacement } from './roomFitting';
import { v3 } from './shipwright';

/**
 * What stands in the wardroom: the mess table and its forms, the two officers'
 * cabins that flank the hatchway, and the run of chests along either side.
 *
 * `docs/ship/SHIP_BELOW_DECKS_PLAN.md` §4.3 is the arrangement and the argument
 * for it. What follows is that section measured against the ship as she is now
 * standing, and the interesting part of this round is that **§4.3 was drawn
 * before four things existed that its own blocks now collide with**: the two
 * lanterns Ash marked on the deckhead by eye, the fore scuttle, the doorway
 * offsets that dog-leg the passage round the masts, and the bilge pump's well.
 * Every dimension below that is not a taste is one of those four talking.
 *
 * WHAT DECIDES THE ROOM, IN ORDER
 * -------------------------------
 * 1. **The hatchway.** z +0.5 to +2.3, 1.5 m across, and §4.3.1 is emphatic:
 *    nothing is built in that footprint at any level. The officers' cabins
 *    therefore flank it and the passage crosses over the boards, which is the
 *    plan's own reading and is the one thing here that needed no adjustment.
 * 2. **The mainmast.** Not at z −1.9 — that is the station at the *partners*.
 *    She rakes 5.5°, so at the wardroom's sole the mast is at −1.688 and its
 *    after face is 0.21 m forward of where the plan drew it. The mess table
 *    butts on it, which is where a mess table's head belongs, and `rig.
 *    mastSectionAt` is asked rather than told.
 * 3. **The wardroom's forward lantern**, at x +1.042. It hangs on the one beam
 *    stub outboard of the hatch carlings, because every full beam forward of
 *    z +0.1 is cut by the opening — so the *only* deckhead in the forward two
 *    thirds of this room that will carry a hook is the deckhead the mate's
 *    cabin wants. The lamp keeps it: it is Ash's own ray mark, and the mate's
 *    cabin gives up 0.45 m of width instead. See `officersCabin`.
 * 4. **The pump well**, at x +0.55, z −1.35. The port form is cut short at its
 *    after end by it, which is why the two forms are different lengths.
 *
 * WHERE A BODY GOES
 * -----------------
 * The through route dog-legs twice, and it has to: the after doorway is 0.95 m
 * to starboard and the forward one 0.75 m to port, and the mess table is on the
 * centreline between them. So a body comes down the corridor between the two
 * cabins, passes the table **to port** — the side the pump shortened the form
 * on, and therefore the side with room — crosses the centreline abaft the
 * mainmast where there is nothing in the way, and goes out to starboard. That
 * is not a route anybody chose; it is what the two doorways and one table make,
 * and `ship-interior.test.ts` walks it rather than asserting it.
 */

// --- what the room is measured from -------------------------------------------

/** The face of a ship's bulkhead, which is half its thickness off its plane. */
const BULKHEAD_FACE = BULKHEAD_THICKNESS * 0.5;

/**
 * Clear sole between the mess table and the officers' cabins.
 *
 * **The one dimension in this room that is a body rather than a piece of
 * furniture.** The table is on the centreline with a form each side; the
 * cabins are outboard; so the only way from the corridor to the after part of
 * the room is across this gap, and it has to be wide enough for a 0.52 m body
 * to turn from one lane into the other rather than merely to stand in. 0.80
 * leaves 0.14 m each side of a body crossing it square, and the walk finds it
 * long before a reader would.
 */
const CROSSING_CLEAR = 0.80;

/** A fist between the table's after end and the mainmast's timber. */
const TABLE_OFF_MAST = 0.03;

/** The wardroom, once. */
function wardroom() {
  return belowDecksSpace('wardroom');
}

/**
 * The after face of the mainmast where it passes the wardroom's sole.
 *
 * At the sole rather than at the table top, and that is the binding one: the
 * mast rakes **aft** going up, so the lower the query the further forward the
 * timber is, and the table's own footprint is decided at the floor.
 */
export function mainmastAfterFaceZ(): number {
  const space = wardroom();
  const section = mastSectionAt('mainmast', space.soleY);
  return section.z + section.radius;
}

/** Where the officers' cabins stop, aft — and where the crossing begins. */
export function officersCabinAftZ(): number {
  return wardroom().zForward - BULKHEAD_FACE - CABIN_LENGTH;
}

// --- the mess table -----------------------------------------------------------

const TABLE_WIDTH = 0.84;
const TABLE_TOP_Y = 0.74;
const TABLE_TOP_THICKNESS = 0.042;
/** The fiddle round the top. A table at sea without one is a shelf. */
const TABLE_FIDDLE = 0.034;
const TABLE_FIDDLE_THICKNESS = 0.020;
/** Clear air between the table's edge and a form's inboard face — knee room. */
const FORM_GAP = 0.08;
const FORM_DEPTH = 0.28;
const FORM_SEAT_Y = 0.42;
const FORM_TOP_THICKNESS = 0.036;
/** How far a form's aft end stands off the pump well's boards. */
const FORM_OFF_WELL = 0.04;

/** The table's own two stations, which three pieces have to agree about. */
export interface MessTableGeometry {
  readonly zAft: number;
  readonly zForward: number;
  readonly xLo: number;
  readonly xHi: number;
  readonly soleY: number;
  /** Top of the table's boards. */
  readonly topY: number;
  /** Inboard and outboard faces of a form, as positive half-breadths. */
  readonly formInboard: number;
  readonly formOutboard: number;
  /** Where the port form has to start, because the pump well is abaft it. */
  readonly portFormZAft: number;
}

let cachedTable: MessTableGeometry | null = null;

/**
 * The mess table, resolved.
 *
 * **Its length is what the room leaves it rather than a number**, and that is
 * the honest way round: the after end is the mainmast and the forward end is a
 * body's width short of the officers' cabins, and both of those move if a
 * bulkhead does. It comes out at 1.33 m, which seats two a side — four at a
 * sitting, which is what §4.4's "all eight eat here in two sittings" means.
 *
 * It throws rather than shrinking below that, because a wardroom table that
 * seats three is a piece of furniture nobody would have built.
 */
export function messTableGeometry(): MessTableGeometry {
  if (cachedTable) return cachedTable;
  const space = wardroom();
  const zAft = mainmastAfterFaceZ() + TABLE_OFF_MAST;
  const zForward = officersCabinAftZ() - CROSSING_CLEAR;
  const length = zForward - zAft;
  if (length < 1.10) {
    throw new Error(
      `the wardroom leaves ${length.toFixed(3)} m for a mess table, which seats three`,
    );
  }
  const half = TABLE_WIDTH / 2;
  cachedTable = {
    zAft,
    zForward,
    xLo: -half,
    xHi: half,
    soleY: space.soleY,
    topY: space.soleY + TABLE_TOP_Y,
    formInboard: half + FORM_GAP,
    formOutboard: half + FORM_GAP + FORM_DEPTH,
    portFormZAft: PUMP_Z + PUMP_WELL_HALF + FORM_OFF_WELL,
  };
  return cachedTable;
}

/**
 * The table on the centreline, its head against the mainmast.
 *
 * Two trestle standards and a stretcher rather than four legs, because four
 * legs under a table on a rolling floor is four things to catch a boot on and a
 * trestle is what a ship's mess table actually is. The top is one slab with a
 * fiddle round three sides — the after side is the mast, which is its own
 * fiddle.
 */
export function wardroomTable(): InteriorFitting {
  const t = messTableGeometry();
  const solids: FittingSolid[] = [];
  const carcaseTop = t.topY - TABLE_TOP_THICKNESS;

  // Two trestles, in from the ends so the end seats have foot room.
  for (const z of [t.zAft + 0.22, t.zForward - 0.22]) {
    // The standard: a broad plank on edge, athwartships.
    solids.push(
      span(
        t.xLo + 0.10,
        t.xHi - 0.10,
        t.soleY + 0.09,
        carcaseTop,
        z - 0.035,
        z + 0.035,
        'timber',
        true,
      ),
    );
    // Its foot, which is what stops it rocking.
    solids.push(
      span(
        t.xLo + 0.04,
        t.xHi - 0.04,
        t.soleY,
        t.soleY + 0.09,
        z - 0.075,
        z + 0.075,
        'timber',
        false,
      ),
    );
  }
  // The stretcher between them, low, where a foot rests.
  solids.push(
    span(
      -0.05,
      0.05,
      t.soleY + 0.20,
      t.soleY + 0.31,
      t.zAft + 0.22,
      t.zForward - 0.22,
      'timber',
      false,
    ),
  );

  // The top. **Collidable, and it is the table's only collider that matters**:
  // at 0.74 it is well above the walker's 0.40 m step-over, so a body meets a
  // table rather than climbing one, and the trestles under it are inside its
  // own shadow in plan.
  solids.push(span(t.xLo, t.xHi, carcaseTop, t.topY, t.zAft, t.zForward, 'timber', true));

  // The fiddle: along both sides and across the forward end. Not across the
  // after end, because that end is the mast — you would be fiddling a joint
  // that has a tree through it.
  for (const [xLo, xHi] of [
    [t.xLo, t.xLo + TABLE_FIDDLE_THICKNESS],
    [t.xHi - TABLE_FIDDLE_THICKNESS, t.xHi],
  ] as const) {
    solids.push(
      span(xLo, xHi, t.topY, t.topY + TABLE_FIDDLE, t.zAft, t.zForward, 'timber', false),
    );
  }
  solids.push(
    span(
      t.xLo,
      t.xHi,
      t.topY,
      t.topY + TABLE_FIDDLE,
      t.zForward - TABLE_FIDDLE_THICKNESS,
      t.zForward,
      'timber',
      false,
    ),
  );

  return { name: 'wardroomTable', kind: 'wardroomTable', solids, standable: null };
}

/**
 * A form alongside the table — a bench with no back, which is what a mess seats
 * on.
 *
 * **The two are different lengths and the pump is why.** The well's boards
 * stand 0.19 m each side of x +0.55 and run from z −1.54 to −1.16, which is
 * inside the port form's footprint; so the port form starts forward of the well
 * and the starboard one runs the table's whole length. That asymmetry is the
 * room being honest about what is in it, and it is derived from
 * `PUMP_WELL_HALF` rather than typed, so moving the pump moves the form.
 */
function wardroomForm(hand: Hand): InteriorFitting {
  const t = messTableGeometry();
  const sign = hand === 'port' ? 1 : -1;
  const zAft = hand === 'port' ? Math.max(t.zAft, t.portFormZAft) : t.zAft;
  const zForward = t.zForward;
  if (zForward - zAft < 0.6) {
    throw new Error(`the ${hand} form is ${(zForward - zAft).toFixed(3)} m long`);
  }
  const inboard = sign * t.formInboard;
  const outboard = sign * t.formOutboard;
  const xLo = Math.min(inboard, outboard);
  const xHi = Math.max(inboard, outboard);
  const seatY = t.soleY + FORM_SEAT_Y;
  const solids: FittingSolid[] = [];

  // Two standards under it, and the seat board.
  for (const z of [zAft + 0.10, zForward - 0.10]) {
    solids.push(
      span(
        xLo + 0.03,
        xHi - 0.03,
        t.soleY,
        seatY - FORM_TOP_THICKNESS,
        z - 0.028,
        z + 0.028,
        'timber',
        false,
      ),
    );
  }
  // **The collidable piece.** At 0.42 the seat is above the 0.40 m step-over by
  // 20 mm, which is deliberate rather than lucky: a form a body strides over is
  // a form a body walks through the middle of the mess on.
  solids.push(
    span(xLo, xHi, seatY - FORM_TOP_THICKNESS, seatY, zAft, zForward, 'timber', true),
  );
  // A rail along the underside of the outboard edge, which is what keeps a
  // board of this span from bowing under four men.
  solids.push(
    span(
      sign > 0 ? xHi - 0.024 : xLo,
      sign > 0 ? xHi : xLo + 0.024,
      seatY - FORM_TOP_THICKNESS - 0.055,
      seatY - FORM_TOP_THICKNESS,
      zAft + 0.04,
      zForward - 0.04,
      'timber',
      false,
    ),
  );

  return {
    name: hand === 'port' ? 'wardroomFormPort' : 'wardroomFormStarboard',
    kind: 'wardroomForm',
    solids,
    standable: null,
  };
}

export function wardroomFormPort(): InteriorFitting {
  return wardroomForm('port');
}

export function wardroomFormStarboard(): InteriorFitting {
  return wardroomForm('starboard');
}

// --- sitting at the mess --------------------------------------------------------

/**
 * Where along the forms a body sits.
 *
 * **The middle of the SHORT form, and both hands use it**, so the two places
 * are opposite each other across the table. A form seats two and the two forms
 * are different lengths — the pump well took 0.37 m off the port one — so
 * "the middle of the form" is two different stations that would put the two
 * diners a third of a metre out of line with each other, eating past one
 * another's shoulders. The only station both forms have is the middle of the
 * shorter, and a mess table where the man opposite is opposite is worth more
 * than a starboard sitter centred on his own bench.
 */
function messSeatZ(): number {
  const t = messTableGeometry();
  return (t.portFormZAft + t.zForward) / 2;
}

/**
 * How far the sitter leans in over the table.
 *
 * A form has no back, so a body on one is already forward of where a chair
 * would put it; this is the rest of the way to the board. Small — 0.06 m
 * against the chart desk's 0.10 — because a man eating leans less than a man
 * reading a chart, and because the fiddle round this table is 34 mm proud and
 * a nose over it is a nose in the beef.
 */
const MESS_LEAN = 0.06;

/** Where the eye goes for a body sitting on one of the mess forms. */
export function wardroomFormPose(hand: Hand): SeatPose {
  const t = messTableGeometry();
  const sign = hand === 'port' ? 1 : -1;
  return seatedPose({
    // The forms are square with the ship: they stand against a table on the
    // centreline, not against the ship's side, so there is nothing for them to
    // lie along. `SQUARE_FRAME` is the identity and says so.
    frame: SQUARE_FRAME,
    x: sign * (t.formInboard + t.formOutboard) / 2,
    z: messSeatZ(),
    seatY: t.soleY + FORM_SEAT_Y,
    // Inboard: you sit at a mess table facing the table. To port that is the
    // ship's −x and to starboard it is +x, which is the one thing about a
    // mirrored pair that a sign flip on the position does not carry with it.
    facing: hand === 'port' ? 'frameMinusX' : 'framePlusX',
    lean: MESS_LEAN,
    // 15° down. The near edge of a 0.74 m table is 64° below a seated eye and
    // the far edge is 23°, so no aim holds the whole board in a 62° field —
    // the desk found the same thing and answered it by aiming at the work.
    // A mess table is not work: aimed at the far half, the frame carries the
    // board, the form opposite, and the room past it, which is what you look
    // at while you eat.
    pitch: -15,
    // Wide, and wider than the desk's 75°: the desk is a composition and this
    // is a room. It reaches the mainmast at the table's head, the officers'
    // cabins forward, and the run of chests behind your own shoulder.
    yawRange: 100,
    pitchLo: -60,
    pitchHi: 40,
  });
}

/**
 * What a body aims at to sit on a form — **the bench, not the floor beside it.**
 *
 * The captain's chair does the opposite, and the difference is measured rather
 * than stylistic. That chair is a scatter of 19 mm legs under a 0.36 m seat
 * board, and `deskChairTarget` explains that aiming at it means looking down at
 * a thin thing near your feet. A form is 1.34 m by 0.28, and the volume a
 * sitter occupies over it is chest-high: you can see it, so you can point at it.
 *
 * The other half of the reason is the room. **The wardroom's aft lantern hangs
 * at x −0.924, directly over the lane the starboard form is worked from**, and
 * the chair's own round records what a floor-shaped target under a lantern
 * costs. `Interactables` ranks an entered box over an occupied one now, so a
 * floor target would survive it — but the fix that survives is the one that
 * does not need the ranking.
 *
 * The box is the seat and the sitter: from the sole to 0.60 m over the seat, so
 * a standing eye 0.6 m away meets it at 45° down rather than 60°.
 */
export function wardroomFormTarget(hand: Hand): InteractableBox {
  const t = messTableGeometry();
  const sign = hand === 'port' ? 1 : -1;
  const zAft = hand === 'port' ? Math.max(t.zAft, t.portFormZAft) : t.zAft;
  const inboard = sign * t.formInboard;
  const outboard = sign * t.formOutboard;
  const seatY = t.soleY + FORM_SEAT_Y;
  return {
    xLo: Math.min(inboard, outboard) - FORM_TARGET_PAD,
    xHi: Math.max(inboard, outboard) + FORM_TARGET_PAD,
    yLo: t.soleY,
    yHi: seatY + 0.60,
    zLo: zAft - FORM_TARGET_PAD,
    zHi: t.zForward + FORM_TARGET_PAD,
  };
}

/** A hand's breadth of slack round a target, so its edge is not its timber. */
const FORM_TARGET_PAD = 0.06;

/**
 * Where a body has to be standing to sit on a form: **this hand's half of the
 * room.**
 *
 * `REACH` is 2.2 m and the two forms are 1.56 m apart across the table, so
 * without this a body in the port lane could point down at the starboard bench
 * and be seated on the far side of a table it never walked round. The veto is
 * the centreline, which is the one line that cannot be crossed by pointing.
 *
 * It is not the tight lane between the form and the chests — 0.71 m of clear
 * sole — because a station you can only take from inside a 0.19 m band of
 * standing positions is a station that reads as broken from anywhere else, and
 * the lane is not what makes the far form wrong.
 */
export function wardroomFormWithin(hand: Hand): InteractableBox {
  const t = messTableGeometry();
  const sign = hand === 'port' ? 1 : -1;
  const zAft = hand === 'port' ? Math.max(t.zAft, t.portFormZAft) : t.zAft;
  return {
    xLo: Math.min(0, sign * ROOM_HALF_BEAM),
    xHi: Math.max(0, sign * ROOM_HALF_BEAM),
    yLo: t.soleY,
    yHi: t.soleY + STANDING_WITHIN_HEIGHT,
    zLo: zAft - APPROACH_CLEAR,
    zHi: t.zForward + APPROACH_CLEAR,
  };
}

/** Wider than she is anywhere: a `within` box tests stations, not beam. */
const ROOM_HALF_BEAM = 10;
/** Head room over a `within` box's own sole — a standing eye, plus slack. */
const STANDING_WITHIN_HEIGHT = 1.9;
/** How far off the end of a piece a body may stand and still be at it. */
const APPROACH_CLEAR = 0.7;

// --- the officers' cabins ------------------------------------------------------

/** Fore-and-aft length of a cabin, outside its own after partition. */
const CABIN_LENGTH = 1.92;
const PARTITION_THICKNESS = 0.04;
/** Clear air between a partition's head and the beams over it. */
const PARTITION_HEADROOM = 0.02;
/** How far the cabin door's after jamb stands off the after partition. */
const CABIN_DOOR_OFF_AFT = 0.12;
const DOOR_LEAF_THICKNESS = 0.026;
/** How far the carlings that frame the hatchway stand outboard of the opening. */
const CARLING_CLEAR = 0.06;

/** Width of a berth in an officer's cabin, across the mattress. */
const OFFICER_BERTH_WIDTH = 0.62;
const OFFICER_BERTH_SHELF_Y = 0.48;
const OFFICER_BERTH_MATTRESS = 0.13;
const OFFICER_BERTH_LEE_BOARD = 0.22;

/**
 * The inboard face of one officer's cabin partition, and the whole argument of
 * this round in one function.
 *
 * **Starboard is set by the hatchway** — §4.3.1 forbids building in that
 * footprint at any level, so the surgeon's partition stands one carling clear
 * of the opening's edge and his cabin gets everything outboard of it.
 *
 * **Port is set by a lantern.** The wardroom's forward lamp hangs at x +1.042,
 * on the one beam in the forward two thirds of this room that the hatchway does
 * not interrupt, and it swings on 0.42 m of chain. A partition inboard of
 * `LAMP_REACH_HALF` of that hook is a partition the lantern knocks against, and
 * a partition outboard of the lamp puts the room's forward light inside a
 * private cabin. So the mate's partition stands clear of the swing and his
 * cabin is 0.45 m narrower than the surgeon's.
 *
 * That is a real difference between the two officers and it is not a
 * compromise dressed up: the port side of this room carries the doorway to the
 * forecastle *and* the forward lantern, and the plan's own indicative blocks —
 * 1.25 m each hand, symmetrical — were drawn before either existed. The mate
 * gets a bed-place with a door; the surgeon gets a room with floor in it, which
 * is the right way round, because §4.3 puts his chest in his.
 */
function cabinPartitionX(hand: Hand): number {
  if (hand === 'starboard') return HATCHWAY_HALF_BREADTH + CARLING_CLEAR;
  const lamp = LAMP_HANGS.find((hang) => hang.id === 'wardroom-fore');
  if (!lamp) throw new Error('the wardroom has no forward lamp to stand clear of');
  // Clear of the door to the forecastle as well, which is the other thing on
  // this hand. Both are checked, so whichever moves first still governs.
  return Math.max(
    lamp.x + LAMP_REACH_HALF,
    DOORWAY_OFFSET + DOORWAY_HALF_BREADTH + CARLING_CLEAR,
  );
}

/** The two cabins, resolved — what the berth inside each has to fit into. */
export interface OfficersCabinGeometry {
  readonly hand: Hand;
  /** Inboard face of the partition, signed. */
  readonly xPartition: number;
  /** Inside face of the partition, signed — where the cabin's floor begins. */
  readonly xInside: number;
  /** Outboard face: the tightest the lining gets over the cabin's footprint. */
  readonly xLining: number;
  /**
   * Where the *after* partition reaches, which is not the same number.
   *
   * `xLining` is the tightest the side gets anywhere in the cabin — the right
   * answer for "will a berth fit" and the wrong one for a wall. The wardroom
   * widens 0.10 m between this partition and the forward bulkhead, so a wall
   * built to the cabin's minimum stops 0.10 m short of the planking and leaves
   * a slot you can see the cabin through: M4's deckhead leak and §10.4's
   * 0.59 m of open bulkhead, at one tenth the size.
   */
  readonly xWallAft: number;
  readonly zAft: number;
  readonly zForward: number;
  readonly soleY: number;
  /** Top of the partitions — the beams over their own footprint, less a gap. */
  readonly headY: number;
  /** Clear width inside, partition to lining. */
  readonly clearWidth: number;
  /** Clear opening of the cabin door, above its sill. */
  readonly doorHeadY: number;
  readonly doorZAft: number;
  readonly doorZForward: number;
}

const cachedCabins = new Map<Hand, OfficersCabinGeometry>();

export function officersCabinGeometry(hand: Hand): OfficersCabinGeometry {
  const found = cachedCabins.get(hand);
  if (found) return found;
  const space = wardroom();
  const sign = hand === 'port' ? 1 : -1;
  const zForward = space.zForward - BULKHEAD_FACE;
  const zAft = officersCabinAftZ();
  const xPartition = sign * cabinPartitionX(hand);
  const xInside = xPartition + sign * PARTITION_THICKNESS;

  // The lining over the cabin's whole footprint and whole height, which is the
  // tightest it gets anywhere in the room the partitions enclose. Asked once,
  // here, so the berth and the partitions cannot disagree about how wide the
  // cabin is — `sideLimitOver`'s own rule, applied to a room instead of a box.
  const xLiningAbs = sideLimitOver(space, zAft, zForward, space.soleY, space.soleY + 1.6);
  const clearWidth = xLiningAbs - Math.abs(xInside);
  if (clearWidth < OFFICER_BERTH_WIDTH) {
    throw new Error(
      `the ${hand} officer's cabin is ${clearWidth.toFixed(3)} m inside, ` +
        `which will not take a ${OFFICER_BERTH_WIDTH.toFixed(2)} m berth`,
    );
  }

  const xWallAftAbs = sideLimitOver(
    space,
    zAft,
    zAft + PARTITION_THICKNESS,
    space.soleY,
    space.soleY + 1.6,
  );

  // Over the *widest* the cabin gets, not the narrowest: the after partition
  // reaches further outboard than the berth does, and outboard is where the
  // deck cambers down. Sampling only the berth's own band is how a wall ends
  // up 12 mm from the beams in the corner nobody measured.
  const xOuter = sign * Math.max(xLiningAbs, xWallAftAbs);
  const deckhead = lowestDeckheadOver(
    space,
    SQUARE_FRAME,
    zAft,
    zForward,
    Math.min(xPartition, xOuter),
    Math.max(xPartition, xOuter),
  );
  if (!Number.isFinite(deckhead)) {
    throw new Error(`the ${hand} officer's cabin stands under no deckhead`);
  }
  const headY = deckhead - PARTITION_HEADROOM;

  const doorZAft = zAft + PARTITION_THICKNESS + CABIN_DOOR_OFF_AFT;
  const doorZForward = doorZAft + 2 * DOORWAY_HALF_BREADTH;

  const geometry: OfficersCabinGeometry = {
    hand,
    xPartition,
    xInside,
    xLining: sign * xLiningAbs,
    xWallAft: sign * xWallAftAbs,
    zAft,
    zForward,
    soleY: space.soleY,
    headY,
    clearWidth,
    // The ship's own door height, capped by the beams: a lintel is a low
    // ceiling and the walker passes under anything over its standing height,
    // but a door drawn taller than the room is a hole in the deckhead.
    doorHeadY: Math.min(space.soleY + DOORWAY_HEIGHT, headY - 0.06),
    doorZAft,
    doorZForward,
  };
  cachedCabins.set(hand, geometry);
  return geometry;
}

const cachedOfficersBerths = new Map<Hand, RoomPlacement>();

/**
 * Whether an officer's cabin is a room a body walks into, or a bed-place.
 *
 * **One predicate, two readers, and they used to be two expressions.** The
 * berth asked `clearWidth − berthWidth < 0.52` to decide whether to fill the
 * cabin; the station asked `clearWidth ≥ berthWidth + 0.52` to decide whether
 * you go in or lean in at the door. Those are the same question written twice,
 * and the day one of them gained a millimetre of slack would have been the day
 * the mate's berth filled his cabin *and* expected a body to stand beside it.
 *
 * 0.52 m is the walker's own diameter. §21.8 has the measurement: the surgeon
 * clears it with 0.63 m and the mate misses it with 0.18.
 */
export function officersCabinIsWalkIn(hand: Hand): boolean {
  const c = officersCabinGeometry(hand);
  return c.clearWidth - Math.min(OFFICER_BERTH_WIDTH, c.clearWidth) >= WALKER_DIAMETER;
}

/** The walker's own width — what "a body fits beside it" means, in metres. */
const WALKER_DIAMETER = 0.52;

/**
 * Where one officer's berth stands, published.
 *
 * **It was a local inside `officersCabin` and the lying pose is why it is not.**
 * A body turning in has to know where the mattress is to within a centimetre —
 * the same four numbers the bolster, the blanket and the lee board are drawn
 * from — and a station that re-derived them would be the "two sources for one
 * position" fault with a man's head in it. `crewBerthGeometry` and
 * `boxBerthGeometry` publish theirs for the same reason and did so first.
 */
export function officersBerthPlacement(hand: Hand): RoomPlacement {
  const found = cachedOfficersBerths.get(hand);
  if (found) return found;
  const c = officersCabinGeometry(hand);
  const berthWidth = Math.min(OFFICER_BERTH_WIDTH, c.clearWidth);
  const fillsCabin = !officersCabinIsWalkIn(hand);
  const placement = placeInRoom({
    space: 'wardroom',
    from: 'forward',
    offset: BULKHEAD_FACE + 0.03,
    length: c.zForward - c.zAft - PARTITION_THICKNESS - 0.06,
    hand,
    align: 'side',
    inboard: 0,
    // A cabin with no floor to spare gives the whole of itself to the bed —
    // which is a standing bed-place and is better than a bunk with a 0.2 m
    // slot beside it that nothing can use.
    width: fillsCabin ? c.clearWidth : berthWidth,
    height: OFFICER_BERTH_SHELF_Y + OFFICER_BERTH_LEE_BOARD,
  });
  cachedOfficersBerths.set(hand, placement);
  return placement;
}

/** Top of an officer's mattress — what a body turning in lies on. */
function officersMattressY(hand: Hand): number {
  return officersBerthPlacement(hand).yLo + OFFICER_BERTH_SHELF_Y + OFFICER_BERTH_MATTRESS;
}

/**
 * The pose of an officer lying in his berth.
 *
 * **Head forward, and it is the pillow that says so rather than this function.**
 * `officersCabin` draws the bolster between `zForward − 0.40` and
 * `zForward − 0.08` and writes the reason on it — the door is aft and a man
 * sleeps with his feet toward it — so `zHead` is the berth's forward end and
 * `zFoot` its after one. The captain's berth is the other way round and
 * `lyingPose` takes the two in that order precisely so the difference has to be
 * stated at each bed instead of assumed once.
 */
export function officersBerthPose(hand: Hand): SeatPose {
  const p = officersBerthPlacement(hand);
  return lyingPose({
    frame: p.frame,
    xInboard: hand === 'port' ? p.xLo : p.xHi,
    xOutboard: hand === 'port' ? p.xHi : p.xLo,
    zHead: p.zForward,
    zFoot: p.zAft,
    mattressY: officersMattressY(hand),
  });
}

/** The mouth of an officer's berth — the volume a body would lie in. */
export function officersBerthTarget(hand: Hand): InteractableBox {
  const p = officersBerthPlacement(hand);
  const shelfY = p.yLo + OFFICER_BERTH_SHELF_Y;
  return framedTarget(
    p.frame,
    Math.min(p.xLo, p.xHi),
    Math.max(p.xLo, p.xHi),
    shelfY,
    shelfY + BERTH_MOUTH_HEIGHT,
    p.zAft,
    p.zForward,
  );
}

/**
 * Where a body has to be standing to turn in to an officer's berth.
 *
 * **Inside his own cabin, and the partitions are why.** `REACH` is 2.2 m and
 * the surgeon's mattress is **0.75 m** from a body standing in the wardroom
 * with its back against his partition, and 1.66 m from one on the centreline —
 * both inside the reach, and both through a wall of boards the pick knows
 * nothing about. This is the same guard `deskChairTarget` needed against the
 * cabin bulkhead, one room forward and one wall thinner.
 *
 * **The mate's reaches into his doorway and the surgeon's does not**, because
 * §21.8's asymmetry is real: at 0.799 m inside, the mate's cabin will not take
 * a 0.62 m berth *and* a 0.52 m body, so his berth is worked from the opening
 * or not at all. The surgeon has 0.63 m of floor beside his bunk and you go in.
 */
export function officersBerthWithin(hand: Hand): InteractableBox {
  const c = officersCabinGeometry(hand);
  const sign = hand === 'port' ? 1 : -1;
  const walkIn = officersCabinIsWalkIn(hand);
  // A bed-place is entered by leaning in at the door; a room is entered.
  const inboardLimit = walkIn ? c.xInside : c.xPartition - sign * DOORWAY_STAND_OFF;
  const outboard = c.xLining;
  const zAft = walkIn ? c.zAft : c.doorZAft - 0.02;
  const zForward = walkIn ? c.zForward : c.doorZForward + 0.02;
  return {
    xLo: Math.min(inboardLimit, outboard),
    xHi: Math.max(inboardLimit, outboard),
    yLo: c.soleY,
    yHi: c.soleY + STANDING_WITHIN_HEIGHT,
    zLo: zAft,
    zHi: zForward,
  };
}

/** How far out of a bed-place's doorway a body may stand and still reach in. */
const DOORWAY_STAND_OFF = 0.70;

/**
 * One officer's cabin: two partitions, a door standing open, and a berth.
 *
 * **The berth fills whatever the cabin has left, and in the mate's case that is
 * all of it.** The surgeon's cabin is 1.25 m inside, so a 0.62 m berth leaves
 * 0.63 m of floor and a body can stand in it; the mate's is 0.80 m inside,
 * which is a berth and nothing else — so his berth is drawn the full width of
 * the room it is in and his door opens onto its lee board. That is a *standing
 * bed-place*, which is what the smaller of two officers' cabins on a 47-ton
 * schooner is, and it is what §2's own precedent describes aboard *Beagle*:
 * "sleeping spaces marked off along one side".
 *
 * The width is asked of the room rather than typed for exactly the reason
 * `sideLimitOver` exists: a berth drawn to a remembered width in a cabin whose
 * partition moved is a berth standing in the planking or a slot behind it.
 *
 * **The doors are drawn open and there is no state that shuts them.** They are
 * not in the closure table: a closure is a thing four systems have a rule
 * about, and a cabin door that only ever changes what a player can see into is
 * not one of those yet. Open is also the state a door at sea is actually in —
 * hooked back for air — and it is the state in which the room reads as a cabin
 * rather than as a cupboard.
 */
function officersCabin(hand: Hand): InteriorFitting {
  const c = officersCabinGeometry(hand);
  const sign = hand === 'port' ? 1 : -1;
  const solids: FittingSolid[] = [];
  const xPartLo = Math.min(c.xPartition, c.xInside);
  const xPartHi = Math.max(c.xPartition, c.xInside);

  // --- the after partition, athwartships from the inboard one to the lining.
  //
  // **Its own station's lining, not the cabin's.** `xLining` is the tightest
  // the side gets anywhere over the cabin's whole footprint — which is the
  // right number for asking whether a berth fits and the wrong one for a wall:
  // the wardroom widens 0.10 m between this partition and the forward
  // bulkhead, so a partition run to the cabin's minimum stops 0.10 m short of
  // the planking and leaves a slot you see the cabin through. It is the M4
  // deckhead leak and §10.4's 0.59 m of open bulkhead, at 0.10 m.
  solids.push(
    span(
      Math.min(c.xPartition, c.xWallAft),
      Math.max(c.xPartition, c.xWallAft),
      c.soleY,
      c.headY,
      c.zAft,
      c.zAft + PARTITION_THICKNESS,
      'timber',
      true,
    ),
  );

  // --- the inboard partition, in three pieces round its doorway.
  for (const [zLo, zHi] of [
    [c.zAft, c.doorZAft],
    [c.doorZForward, c.zForward],
  ] as const) {
    solids.push(span(xPartLo, xPartHi, c.soleY, c.headY, zLo, zHi, 'timber', true));
  }
  // The lintel over the opening. Collidable like the rest of the wall — the
  // walker ignores a solid whose foot is above its own standing height, so this
  // is a head, not a barrier, and it is drawn as one rather than left out.
  solids.push(
    span(
      xPartLo,
      xPartHi,
      c.doorHeadY,
      c.headY,
      c.doorZAft,
      c.doorZForward,
      'timber',
      true,
    ),
  );
  // A bead down each jamb and across the head, which is what makes an opening
  // in a boarded partition read as a door frame.
  for (const [zLo, zHi] of [
    [c.doorZAft - 0.03, c.doorZAft],
    [c.doorZForward, c.doorZForward + 0.03],
  ] as const) {
    solids.push(
      span(
        xPartLo - 0.012,
        xPartHi + 0.012,
        c.soleY,
        c.doorHeadY + 0.03,
        zLo,
        zHi,
        'timber',
        false,
      ),
    );
  }
  solids.push(
    span(
      xPartLo - 0.012,
      xPartHi + 0.012,
      c.doorHeadY,
      c.doorHeadY + 0.03,
      c.doorZAft - 0.03,
      c.doorZForward + 0.03,
      'timber',
      false,
    ),
  );

  // --- the door, hooked back inside against its own partition.
  const leafInner = c.xInside + sign * DOOR_LEAF_THICKNESS;
  solids.push(
    span(
      Math.min(c.xInside, leafInner),
      Math.max(c.xInside, leafInner),
      c.soleY + 0.02,
      c.doorHeadY - 0.01,
      c.doorZForward + 0.02,
      c.doorZForward + 0.02 + 2 * DOORWAY_HALF_BREADTH - 0.04,
      'timber',
      false,
    ),
  );
  // Its ring, and the hook in the partition that holds it back.
  {
    const { rod } = drawnIn(SQUARE_FRAME);
    const ringZ = c.doorZForward + 0.10;
    const ringY = c.soleY + 1.02;
    solids.push(
      rod(
        v3(leafInner + sign * 0.004, ringY, ringZ - 0.05),
        v3(leafInner + sign * 0.004, ringY, ringZ + 0.05),
        0.009,
        0.009,
        'brass',
        false,
      ),
    );
  }

  // --- the berth against the ship's side.
  const berth = officersBerthPlacement(hand);
  const { span: bspan } = drawnIn(berth.frame);
  const xOutboard = hand === 'port' ? berth.xHi : berth.xLo;
  const xInboard = hand === 'port' ? berth.xLo : berth.xHi;
  const shelfY = berth.yLo + OFFICER_BERTH_SHELF_Y;
  const lo = Math.min(xOutboard, xInboard);
  const hi = Math.max(xOutboard, xInboard);

  // The locker under the bunk — the only stowage an officer has that is not in
  // the hold. Solid to the bunk bottom, and the cabin's one real collider.
  solids.push(bspan(lo, hi, berth.yLo, shelfY, berth.zAft, berth.zForward, 'timber', true));
  // Two drawer fronts in it, proud, so it is not a plain block.
  {
    const pitch = (berth.zForward - berth.zAft) / 2;
    for (let i = 0; i < 2; i++) {
      const zLo = berth.zAft + pitch * i + 0.02;
      const zHi = berth.zAft + pitch * (i + 1) - 0.02;
      const face = sign > 0 ? lo : hi;
      solids.push(
        bspan(
          Math.min(face, face - sign * 0.012),
          Math.max(face, face - sign * 0.012),
          berth.yLo + 0.06,
          shelfY - 0.04,
          zLo,
          zHi,
          'timber',
          false,
        ),
      );
    }
  }
  // The mattress and a blanket over it. Not the berth's full width, so the
  // timber shows as a border and it reads as bedding in a bed.
  solids.push(
    bspan(
      lo + 0.02,
      hi - 0.02,
      shelfY,
      shelfY + OFFICER_BERTH_MATTRESS,
      berth.zAft + 0.03,
      berth.zForward - 0.03,
      'linen',
      false,
    ),
  );
  solids.push(
    bspan(
      lo + 0.02,
      hi - 0.02,
      shelfY + OFFICER_BERTH_MATTRESS,
      shelfY + OFFICER_BERTH_MATTRESS + 0.04,
      berth.zAft + (berth.zForward - berth.zAft) * 0.36,
      berth.zForward - 0.03,
      'wool',
      false,
    ),
  );
  // The pillow, at the head — which is forward here, because the door is aft
  // and a man sleeps with his feet toward it.
  solids.push(
    bspan(
      lo + 0.06,
      hi - 0.06,
      shelfY + OFFICER_BERTH_MATTRESS,
      shelfY + OFFICER_BERTH_MATTRESS + 0.075,
      berth.zForward - 0.40,
      berth.zForward - 0.08,
      'linen',
      false,
    ),
  );
  // The lee board along the bunk front. In the mate's cabin this is the first
  // thing his door opens onto, which is the whole character of the room.
  //
  // Let into the front rather than proud of it — the forecastle's stacks carry
  // the reason, and here there is a second: the mate's berth is the full width
  // of his cabin, so a board 30 mm proud would be 30 mm inside the partition.
  {
    const inner = xInboard + sign * 0.03;
    solids.push(
      bspan(
        Math.min(xInboard, inner),
        Math.max(xInboard, inner),
        shelfY,
        shelfY + OFFICER_BERTH_LEE_BOARD,
        berth.zAft,
        berth.zForward,
        'timber',
        true,
      ),
    );
  }

  // --- hooks on the partition, which is where a coat lives in a cabin this
  // size. Iron, and low enough to be under the door head.
  {
    const { rod } = drawnIn(SQUARE_FRAME);
    for (const z of [c.zAft + 0.30, c.zAft + 0.52]) {
      solids.push(
        rod(
          v3(c.xInside, c.soleY + 1.42, z),
          v3(c.xInside + sign * 0.07, c.soleY + 1.40, z),
          0.010,
          0.008,
          'ironwork',
          false,
        ),
      );
    }
  }

  return {
    name: hand === 'port' ? 'mateCabin' : 'surgeonCabin',
    kind: 'officersCabin',
    solids,
    standable: null,
  };
}

export function mateCabin(): InteriorFitting {
  return officersCabin('port');
}

export function surgeonCabin(): InteriorFitting {
  return officersCabin('starboard');
}

// --- the chests and ship's stores along the sides -----------------------------

const STORES_DEPTH = 0.38;
const STORES_HEIGHT = 0.60;
const STORES_LID_THICKNESS = 0.036;
const STORES_PLINTH = 0.06;
/** Bays in the run — one chest each, with a becket on the end of each. */
const STORES_BAYS = 3;

/**
 * The run of expedition chests and ship's stores along one side.
 *
 * §4.3 asks for them "along both sides" in the after bay, and they run further
 * forward than that here for a reason the plan could not have known: the after
 * bay is 0.87 m deep once the mess table butts on the mainmast, which is one
 * chest, not a run. Carried up alongside the table instead, the run is 2.2 m
 * and it makes the lane a body walks rather than pinching it — **two obstacles
 * side by side leave a constant gap, and two in series leave a corner**, and it
 * was the corner between a short after-bay run and the form's end that this
 * arrangement first produced. 0.42 m deep leaves 0.7–0.9 m of clear sole
 * between the chests and the forms, against a body of 0.52.
 *
 * The lid collides with the carcase: at 0.60 m it is half a metre above the
 * walker's step-over, so this is the wall that keeps a body off the ship's side
 * rather than a kerb it strides.
 */
function wardroomStores(hand: Hand): InteriorFitting {
  const space = wardroom();
  const t = messTableGeometry();
  const zAft = space.zAft + BULKHEAD_FACE;
  const zForward = t.zForward;
  const p = placeInRoom({
    space: 'wardroom',
    from: 'aft',
    offset: BULKHEAD_FACE,
    length: zForward - zAft,
    hand,
    align: 'side',
    inboard: 0,
    width: STORES_DEPTH,
    height: STORES_HEIGHT,
  });
  const { span: sspan, rod } = drawnIn(p.frame);
  const sign = hand === 'port' ? 1 : -1;
  const xOutboard = hand === 'port' ? p.xHi : p.xLo;
  const xInboard = hand === 'port' ? p.xLo : p.xHi;
  const lo = Math.min(p.xLo, p.xHi);
  const hi = Math.max(p.xLo, p.xHi);
  const lidLo = p.yHi - STORES_LID_THICKNESS;
  const solids: FittingSolid[] = [];

  // Plinth, carcase, lid — the chest vocabulary the captain's own sea chest
  // already uses, at a run's scale and without the leather: these are the
  // ship's chests and the expedition's, not a man's personal one.
  solids.push(
    sspan(
      lo + 0.03,
      hi - 0.03,
      p.yLo,
      p.yLo + STORES_PLINTH,
      p.zAft + 0.03,
      p.zForward - 0.03,
      'timber',
      false,
    ),
  );
  solids.push(
    sspan(lo, hi, p.yLo + STORES_PLINTH, lidLo, p.zAft, p.zForward, 'timber', true),
  );
  solids.push(
    sspan(
      Math.min(xInboard - sign * 0.016, xOutboard),
      Math.max(xInboard - sign * 0.016, xOutboard),
      lidLo,
      p.yHi,
      p.zAft,
      p.zForward,
      'timber',
      true,
    ),
  );

  // Stiles between the bays, so a 2.2 m run reads as chests rather than as one
  // enormous box, and a becket on each bay.
  const pitch = (p.zForward - p.zAft) / STORES_BAYS;
  for (let i = 1; i < STORES_BAYS; i++) {
    const z = p.zAft + pitch * i;
    solids.push(
      sspan(
        Math.min(xInboard, xInboard - sign * 0.012),
        Math.max(xInboard, xInboard - sign * 0.012),
        p.yLo + STORES_PLINTH,
        lidLo,
        z - 0.024,
        z + 0.024,
        'timber',
        false,
      ),
    );
  }
  for (let i = 0; i < STORES_BAYS; i++) {
    const z = p.zAft + pitch * (i + 0.5);
    const y = p.yLo + STORES_HEIGHT * 0.55;
    const face = xInboard - sign * 0.014;
    solids.push(
      rod(v3(face, y - 0.05, z - 0.055), v3(face, y - 0.05, z + 0.055), 0.008, 0.008, 'leather', false),
    );
    solids.push(
      rod(v3(face, y - 0.05, z - 0.055), v3(face, y + 0.05, z - 0.055), 0.008, 0.008, 'leather', false),
    );
    solids.push(
      rod(v3(face, y - 0.05, z + 0.055), v3(face, y + 0.05, z + 0.055), 0.008, 0.008, 'leather', false),
    );
  }

  return {
    name: hand === 'port' ? 'wardroomStoresPort' : 'wardroomStoresStarboard',
    kind: 'wardroomStores',
    solids,
    standable: null,
  };
}

export function wardroomStoresPort(): InteriorFitting {
  return wardroomStores('port');
}

export function wardroomStoresStarboard(): InteriorFitting {
  return wardroomStores('starboard');
}

/** Everything standing in the wardroom, in the order a joiner would fit it. */
export function wardroomFurniture(): readonly InteriorFitting[] {
  return [
    wardroomTable(),
    wardroomFormPort(),
    wardroomFormStarboard(),
    mateCabin(),
    surgeonCabin(),
    wardroomStoresPort(),
    wardroomStoresStarboard(),
  ];
}
