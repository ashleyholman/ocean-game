import type { InteractableBox } from '../../player/Interactables';
import type { SeatPose } from '../../player/SeatedStation';
import type { FittingSolid } from './deckFittings';
import { BERTH_MOUTH_HEIGHT, lyingPose, seatedPose } from './seatedBody';
import {
  BULKHEAD_THICKNESS,
  DOORWAY_HALF_BREADTH,
  DOORWAY_OFFSET,
  belowDecksSpace,
} from './deckInterior';
import { FORE_SCUTTLE_HALF_BREADTH, FORE_SCUTTLE_X, FORE_SCUTTLE_Z } from './hullForm';
import { mastSectionAt } from './rig';
import {
  SQUARE_FRAME,
  drawnIn,
  framedTarget,
  lowestDeckheadOver,
  placeInRoom,
  placementSpanZ,
  sideLimitOver,
  span,
} from './roomFitting';
import type { Hand, InteriorFitting, RoomPlacement } from './roomFitting';
import { v3 } from './shipwright';

/**
 * What stands in the forecastle: the galley hearth and its dresser, four berths
 * in two tiers, the hinged table at the foremast, and two sea chests.
 *
 * `docs/ship/SHIP_BELOW_DECKS_PLAN.md` §4.4 is the arrangement. Three of its
 * four sentences survive being measured; the fourth does not, and it is worth
 * saying which and why:
 *
 * > "The galley is here, at the aft end against the bulkhead, with its dresser
 * > — shelving, preparation surface, secured pots — **opposite**."
 *
 * **Opposite the galley is the fore scuttle now.** The scuttle was cut on
 * 2026-08-15, after this plan was written, and its ladder stands at x −1.100
 * between z 2.63 and 3.15 — dead in the middle of the dresser the drawing puts
 * there. So the dresser is on the same hand it always was and one station
 * further forward, clear of the climb, which is the smallest move that keeps
 * both. The galley itself is where §4.4 and `massModel.ts` both put it: against
 * the after bulkhead, at z +2.6 — though **outboard of the doorway**, which the
 * plan also could not have known, because `DOORWAY_OFFSET` put the door to the
 * wardroom 0.75 m to port on the same wall the stove wants.
 *
 * WHAT DECIDES THE ROOM
 * ---------------------
 * The forecastle is 3.60 m long and 4.19 m across at its after bulkhead,
 * closing to 1.75 m at the peak. A berth is 1.75 m. That single comparison is
 * most of the arrangement: the berths have to have the forward two thirds of
 * the room, so the galley, the dresser, the table and the chests share the
 * after third with the ladder and the doorway — and the mess table is small,
 * on the centreline, hinged to the foremast, with the chests round the walls
 * rather than drawn up beside it.
 *
 * **The chests are not alongside the table and that was measured rather than
 * chosen.** Between the berths' inboard faces there is 2.32 m of clear sole; a
 * table with a chest each side of it takes 2.20 m of that, and the 0.06 m
 * left each hand is not a lane a 0.52 m body can turn out of into the berth
 * flat. So the seating stands against the sides, which is what §4.4's "sea
 * chests round the walls, doubling as the seating" says in the first place.
 */

// --- what the room is measured from -------------------------------------------

const BULKHEAD_FACE = BULKHEAD_THICKNESS * 0.5;

function forecastle() {
  return belowDecksSpace('forecastle');
}

/**
 * How far inboard of the doorway anything against the after bulkhead may stand.
 *
 * The door to the wardroom is 0.75 m to port and 0.70 m wide, so its port jamb
 * is at 1.10 and a body in the opening is held to 0.84 by the jamb itself. A
 * hand's breadth outboard of that is where the galley's inboard face goes, and
 * it is derived from the doorway rather than eyeballed clear of it because
 * `DOORWAY_OFFSET` is a number that has already moved once.
 */
const DOORWAY_CLEAR = 0.20;
function galleyInboardX(): number {
  return DOORWAY_OFFSET + DOORWAY_HALF_BREADTH + DOORWAY_CLEAR;
}

/** The after face of the foremast at the forecastle sole — the table's hinge. */
export function foremastAfterFaceZ(): number {
  const space = forecastle();
  const section = mastSectionAt('foremast', space.soleY);
  return section.z + section.radius;
}

// --- the galley ----------------------------------------------------------------

const HEARTH_LENGTH = 0.82;
/** Height of the iron top a pot stands on. Waist height, standing. */
const HEARTH_TOP_Y = 0.86;
const HEARTH_PLINTH = 0.10;
const HEARTH_TOP_THICKNESS = 0.03;
/** The flue: a stove pipe of this radius, carried to the beams. */
const FLUE_RADIUS = 0.075;

/**
 * The galley hearth against the forecastle's after bulkhead, to port.
 *
 * A brick-lined firehearth with an iron top and a rail round it, which is what
 * a vessel of this size carried before cast-iron ranges: a box of firebrick you
 * burn wood or coal in, with a plate over it and pot bars.
 *
 * **Its width is what the doorway leaves, not a chosen number.** The door to
 * the wardroom is on this hand; the hearth stands one clear body-width outboard
 * of its jamb and runs to the lining. `massModel.ts` already weighs a 420 kg
 * galley hearth at z = +2.6, so its station was decided before this round and
 * is only being obeyed.
 *
 * **The flue stops at the deckhead and there is nothing above it.** A Charley
 * Noble through the weather deck is a deck fitting, a cutout and a closure's
 * worth of work, and it is not this round's — so what is built is the length of
 * pipe that is honestly inside the room, and the handover says the rest is
 * owed. A pipe that stopped in mid-air would be worse; one that reaches the
 * beams reads as going through them.
 */
export function galleyHearth(): InteriorFitting {
  const space = forecastle();
  const zAft = space.zAft + BULKHEAD_FACE;
  const zForward = zAft + HEARTH_LENGTH;
  const inboard = galleyInboardX();
  const lining = sideLimitOver(space, zAft, zForward, space.soleY, space.soleY + HEARTH_TOP_Y);
  const width = lining - inboard;
  if (width < 0.55) {
    throw new Error(`the galley has ${width.toFixed(3)} m of beam between the door and the side`);
  }

  const p = placeInRoom({
    space: 'forecastle',
    from: 'aft',
    offset: BULKHEAD_FACE,
    length: HEARTH_LENGTH,
    hand: 'port',
    // **Square, not laid along the side.** The hearth is built against the
    // *bulkhead*, and a stove turned to follow the ship's side would stand out
    // of parallel with the wall its back is against — the stern lockers'
    // argument in `cabinFurniture.ts`, one room forward.
    inboard: 0,
    width,
    height: HEARTH_TOP_Y,
  });
  const { span: hspan, rod } = drawnIn(p.frame);
  const solids: FittingSolid[] = [];
  const topLo = p.yHi - HEARTH_TOP_THICKNESS;

  // A recessed plinth, then the brick box. **The collidable piece**, and at
  // 0.86 m it is a wall rather than a kerb.
  solids.push(
    hspan(
      p.xLo + 0.04,
      p.xHi,
      p.yLo,
      p.yLo + HEARTH_PLINTH,
      p.zAft,
      p.zForward - 0.04,
      'timber',
      false,
    ),
  );
  solids.push(
    hspan(p.xLo, p.xHi, p.yLo + HEARTH_PLINTH, topLo, p.zAft, p.zForward, 'ironwork', true),
  );
  // The fire door in the forward face, with its bar.
  solids.push(
    hspan(
      p.xLo + 0.10,
      p.xHi - 0.22,
      p.yLo + 0.26,
      topLo - 0.10,
      p.zForward,
      p.zForward + 0.014,
      'ironwork',
      false,
    ),
  );
  solids.push(
    rod(
      v3((p.xLo + p.xHi) / 2 - 0.06, p.yLo + 0.42, p.zForward + 0.03),
      v3((p.xLo + p.xHi) / 2 + 0.06, p.yLo + 0.42, p.zForward + 0.03),
      0.011,
      0.011,
      'ironwork',
      false,
    ),
  );
  // The iron top, proud all round, with a rail on the two open sides so a pot
  // stays on it. The rail is the galley's fiddle and it is the detail that says
  // this is a stove at sea rather than a kitchen range.
  // **Proud into the room and nowhere else.** Run past its own footprint
  // forward, the slab reaches a station the placement never measured and goes
  // 3 mm into the lining — small, invisible, and the exact shape of fault
  // `sideLimitOver`'s head is about: a clearance is only true where it was
  // taken. The stern locker's lid overhangs at its front for the same reason.
  solids.push(
    hspan(p.xLo - 0.02, p.xHi, topLo, p.yHi, p.zAft, p.zForward, 'ironwork', true),
  );
  for (const [xLo, xHi, zLo, zHi] of [
    [p.xLo - 0.02, p.xLo + 0.005, p.zAft, p.zForward],
    [p.xLo - 0.02, p.xHi, p.zForward - 0.025, p.zForward],
  ] as const) {
    solids.push(hspan(xLo, xHi, p.yHi + 0.05, p.yHi + 0.075, zLo, zHi, 'ironwork', false));
  }
  for (const [x, z] of [
    [p.xLo - 0.008, p.zAft + 0.06],
    [p.xLo - 0.008, p.zForward - 0.03],
    [p.xHi - 0.10, p.zForward - 0.014],
  ] as const) {
    solids.push(
      rod(v3(x, p.yHi, z), v3(x, p.yHi + 0.075, z), 0.010, 0.010, 'ironwork', false),
    );
  }
  // Two pots on the top, because an empty stove is a black box.
  solids.push(
    rod(
      v3(p.xLo + 0.18, p.yHi, p.zAft + 0.26),
      v3(p.xLo + 0.18, p.yHi + 0.20, p.zAft + 0.26),
      0.135,
      0.125,
      'ironwork',
      false,
    ),
  );
  solids.push(
    rod(
      v3(p.xHi - 0.20, p.yHi, p.zForward - 0.22),
      v3(p.xHi - 0.20, p.yHi + 0.135, p.zForward - 0.22),
      0.095,
      0.090,
      'ironwork',
      false,
    ),
  );

  // The flue, up the after side against the bulkhead, to the beams.
  const flueX = (p.xLo + p.xHi) / 2 + 0.06;
  const flueZ = p.zAft + 0.16;
  const deckhead = lowestDeckheadOver(
    space,
    SQUARE_FRAME,
    flueZ - FLUE_RADIUS,
    flueZ + FLUE_RADIUS,
    flueX - FLUE_RADIUS,
    flueX + FLUE_RADIUS,
  );
  if (!Number.isFinite(deckhead)) throw new Error('the galley flue rises under no deckhead');
  solids.push(
    rod(
      v3(flueX, p.yHi, flueZ),
      v3(flueX, deckhead + 0.02, flueZ),
      FLUE_RADIUS,
      FLUE_RADIUS * 0.9,
      'ironwork',
      false,
    ),
  );

  return { name: 'galleyHearth', kind: 'galleyHearth', solids, standable: null };
}

// --- the dresser ---------------------------------------------------------------

const DRESSER_LENGTH = 0.86;
const DRESSER_DEPTH = 0.42;
const DRESSER_BENCH_Y = 0.88;
/** Height of the shelving over the preparation surface. */
const DRESSER_SHELVES = 0.62;
const DRESSER_FIDDLE = 0.055;
/**
 * How far the dresser stands clear of the fore scuttle's opening.
 *
 * Measured off the *opening* rather than off the ladder, which is 0.22 m
 * tighter and lives in the file that has to list this one. The hole is the
 * honest datum in any case: what a body needs room for at the foot of a scuttle
 * is the whole shaft, not the timber in it.
 */
const DRESSER_OFF_SCUTTLE = 0.10;
/** Clear air between the dresser's forward end and the berth flat. */
const DRESSER_OFF_BERTHS = 0.04;
/**
 * What the dresser's own turn is allowed to spend out of that gap.
 *
 * A piece laid along a wall reaches further fore-and-aft than its own length,
 * and this one is against the forecastle's fast-closing side. Budgeted rather
 * than discovered, and checked afterwards against `placementSpanZ` — the
 * discovery is what threw when the berths were anchored the other way round.
 */
const DRESSER_TURN_ALLOWANCE = 0.08;

/**
 * The galley dresser: shelving, a preparation surface and secured pots.
 *
 * **Starboard and one station forward of where §4.4 draws it**, because the
 * fore scuttle's ladder now occupies the after end of this hand — see this
 * file's head. It is placed off `FORE_SCUTTLE_LADDER_Z_FORWARD` rather than at
 * a typed station, so moving the scuttle moves the dresser instead of putting
 * a plate rack through the ladder.
 *
 * Three shelves with a fiddle on each, because the whole point of a dresser at
 * sea is that the crockery is *secured* — a shelf without a fiddle is a shelf
 * that empties itself on the first roll, which is the same argument the desk's
 * and the washstand's fiddles already carry.
 */
let cachedDresser: RoomPlacement | null = null;

/** Where the dresser stands, resolved once — the chest abaft it reads this. */
export function galleyDresserPlacement(): RoomPlacement {
  if (cachedDresser) return cachedDresser;
  const space = forecastle();
  // Between two things that were both decided before it: the scuttle's shaft
  // abaft, and the berth flat forward. Its length is what is left rather than a
  // number, and it throws if the two ever close on each other.
  const aftLimit = FORE_SCUTTLE_Z + FORE_SCUTTLE_HALF_BREADTH + DRESSER_OFF_SCUTTLE;
  const forwardFace = crewBerthAftZ() - DRESSER_OFF_BERTHS;
  const length = Math.min(DRESSER_LENGTH, forwardFace - aftLimit - DRESSER_TURN_ALLOWANCE);
  if (length < 0.55) {
    throw new Error(
      `the forecastle leaves ${length.toFixed(3)} m between the scuttle and the berths ` +
        'for the galley dresser',
    );
  }
  const p = placeInRoom({
    space: 'forecastle',
    from: 'forward',
    offset: space.zForward - forwardFace,
    length,
    hand: 'starboard',
    align: 'side',
    inboard: 0,
    width: DRESSER_DEPTH,
    height: DRESSER_BENCH_Y + DRESSER_SHELVES,
  });
  const swept = placementSpanZ(p);
  if (swept.zAft < aftLimit - 1e-9) {
    throw new Error(
      `the galley dresser reaches z ${swept.zAft.toFixed(3)}, inside the fore scuttle's shaft`,
    );
  }
  cachedDresser = p;
  return p;
}

/** The aftmost station the dresser covers, turn included. */
export function galleyDresserAftZ(): number {
  return placementSpanZ(galleyDresserPlacement()).zAft;
}

export function galleyDresser(): InteriorFitting {
  const p = galleyDresserPlacement();
  const { span: dspan, rod } = drawnIn(p.frame);
  // Named, not remembered — to starboard the outboard face is `xLo`. See the
  // note in `cabinFurniture.washstand` for the round that cost.
  const xOutboard = p.xLo;
  const xInboard = p.xHi;
  const solids: FittingSolid[] = [];
  const benchY = p.yLo + DRESSER_BENCH_Y;

  // The cupboard under the bench, solid. **The collidable piece.**
  solids.push(
    dspan(xOutboard, xInboard, p.yLo + 0.07, benchY, p.zAft, p.zForward, 'timber', true),
  );
  solids.push(
    dspan(
      xOutboard,
      xInboard - 0.03,
      p.yLo,
      p.yLo + 0.07,
      p.zAft + 0.03,
      p.zForward - 0.03,
      'timber',
      false,
    ),
  );
  // Two doors on the room side, with a bead between them.
  const midZ = (p.zAft + p.zForward) / 2;
  for (const [zLo, zHi] of [
    [p.zAft + 0.03, midZ - 0.008],
    [midZ + 0.008, p.zForward - 0.03],
  ] as const) {
    solids.push(
      dspan(xInboard, xInboard + 0.022, p.yLo + 0.10, benchY - 0.05, zLo, zHi, 'timber', false),
    );
  }
  // The bench top, proud into the room, with a fiddle at its back and front.
  solids.push(
    dspan(xOutboard, xInboard + 0.03, benchY, benchY + 0.034, p.zAft, p.zForward, 'timber', true),
  );
  solids.push(
    dspan(
      xInboard + 0.012,
      xInboard + 0.03,
      benchY + 0.034,
      benchY + 0.034 + DRESSER_FIDDLE,
      p.zAft,
      p.zForward,
      'timber',
      false,
    ),
  );

  // The back board and three shelves over it, each with its own fiddle.
  solids.push(
    dspan(
      xOutboard,
      xOutboard + 0.016,
      benchY,
      p.yHi,
      p.zAft,
      p.zForward,
      'timber',
      false,
    ),
  );
  for (const [zLo, zHi] of [
    [p.zAft, p.zAft + 0.018],
    [p.zForward - 0.018, p.zForward],
  ] as const) {
    solids.push(dspan(xOutboard, xInboard - 0.10, benchY, p.yHi, zLo, zHi, 'timber', false));
  }
  const shelfYs = [0.20, 0.40, 0.60].map((f) => benchY + DRESSER_SHELVES * f);
  for (const y of shelfYs) {
    solids.push(
      dspan(xOutboard, xInboard - 0.10, y, y + 0.018, p.zAft, p.zForward, 'timber', false),
    );
    solids.push(
      dspan(
        xInboard - 0.118,
        xInboard - 0.10,
        y + 0.018,
        y + 0.018 + DRESSER_FIDDLE,
        p.zAft,
        p.zForward,
        'timber',
        false,
      ),
    );
  }

  // What is on it: a stack of bowls, a pair of pots and a kettle. Three sizes
  // and two materials, because a rack of identical cylinders is a fence.
  solids.push(
    rod(
      v3(xInboard - 0.20, shelfYs[0] + 0.018, p.zAft + 0.20),
      v3(xInboard - 0.20, shelfYs[0] + 0.11, p.zAft + 0.20),
      0.085,
      0.092,
      'paper',
      false,
    ),
  );
  solids.push(
    rod(
      v3(xInboard - 0.19, shelfYs[1] + 0.018, p.zForward - 0.22),
      v3(xInboard - 0.19, shelfYs[1] + 0.10, p.zForward - 0.22),
      0.070,
      0.066,
      'ironwork',
      false,
    ),
  );
  solids.push(
    rod(
      v3(xInboard - 0.21, benchY + 0.034, p.zForward - 0.24),
      v3(xInboard - 0.21, benchY + 0.17, p.zForward - 0.24),
      0.105,
      0.088,
      'ironwork',
      false,
    ),
  );
  // Mugs hung under the lowest shelf, on hooks — the one thing in a galley that
  // hangs, and a room where nothing hangs has no gravity in it.
  for (const z of [p.zAft + 0.24, p.zAft + 0.44, p.zAft + 0.64]) {
    solids.push(
      rod(
        v3(xInboard - 0.16, shelfYs[0] - 0.005, z),
        v3(xInboard - 0.16, shelfYs[0] - 0.075, z),
        0.006,
        0.006,
        'ironwork',
        false,
      ),
    );
    solids.push(
      rod(
        v3(xInboard - 0.16, shelfYs[0] - 0.075, z),
        v3(xInboard - 0.16, shelfYs[0] - 0.155, z),
        0.042,
        0.038,
        'paper',
        false,
      ),
    );
  }

  return { name: 'galleyDresser', kind: 'galleyDresser', solids, standable: null };
}

// --- the crew's berths ----------------------------------------------------------

/**
 * Length of a berth in the forecastle.
 *
 * 1.70 and not the captain's 1.90, and two things took it there rather than a
 * view about how tall a seaman is.
 *
 * The first is the room: the forecastle is 3.54 m between its bulkheads' faces,
 * the after half carries the galley, the fore scuttle, the doorway, the dresser
 * and the mess table, and what the bow will hold — laid over at 25°, which
 * takes 1.85 m of station for 1.70 m of bunk — is this.
 *
 * The second took the last 50 mm and is the more interesting: **the
 * forecastle's lantern.** It hangs at x −1.005, z 4.143 and swings on 0.42 m
 * of chain, and at 1.75 m the starboard stack's after inboard corner came
 * 0.208 m from its hook — inside the swing, so the lamp would knock against
 * the upper bunk's lee board on every roll. Shortening the bunks 50 mm opens
 * that to 0.236 m. It was found by a test rather than by eye, which is the
 * point of having one: a lantern and a bunk 12 mm apart is not a thing a
 * drawing shows.
 *
 * 1.70 m is 5 ft 7, which is short and is a period berth.
 */
const CREW_BERTH_LENGTH = 1.70;
const CREW_BERTH_WIDTH = 0.62;
/** How far the lower bunk's boards stand above the sole, over its locker. */
const CREW_LOWER_SHELF_Y = 0.42;
const CREW_TIER_PITCH = 0.76;
const CREW_MATTRESS = 0.115;
const CREW_LEE_BOARD = 0.20;
const CREW_LEE_THICKNESS = 0.028;
/** Clear air between a berth's head board and the peak bulkhead. */
const CREW_BERTH_HEAD_CLEAR = 0.03;

/** One stack of berths, resolved — what the bedding and the lee boards read. */
export interface CrewBerthGeometry {
  readonly hand: Hand;
  readonly placement: RoomPlacement;
  readonly zAft: number;
  readonly zForward: number;
  /** Inboard face of the bunk front, signed. */
  readonly xInboard: number;
  readonly xOutboard: number;
  readonly soleY: number;
  /** Top of each tier's boards, lower first. */
  readonly shelfYs: readonly number[];
}

const cachedBerths = new Map<Hand, CrewBerthGeometry>();

/**
 * Two berths in a stack against one side, forward.
 *
 * **Two tiers, and the headroom is what allows it.** The forecastle deck rises
 * at z +4.6 — the same break the weather deck has — so from there forward the
 * room is 2.17 to 2.32 m in the clear against 1.81 aft. A second tier at
 * 1.18 m leaves nearly a metre over the upper mattress, which is a bunk rather
 * than a coffin, and it is only true forward of the break. Four hands in two
 * stacks is also what leaves the sole clear for the mess table; four singles
 * round the walls would need 7 m of side and the room has 3.5.
 *
 * **Anchored to the peak bulkhead and not to the foremast, which is the way
 * round the room actually works.** The bunks are the one thing in here whose
 * length cannot give — 1.75 m is already short — so they take the bow and the
 * galley's dresser, the mess table and the chests are fitted into what is left
 * abaft them. Anchoring them the other way round is the first thing this round
 * tried and `placeInRoom` threw, which is the useful failure: laid over at 26°
 * a 1.75 m berth reaches 1.85 m fore-and-aft, and the 0.10 m the turn eats is
 * exactly the clearance an author does not think to budget for.
 *
 * The stack lies along the ship's side, and this is the piece where that
 * matters most in the whole vessel: the forecastle closes from 1.83 m of
 * half-breadth at the berths' after end to 0.93 m at the peak, which is
 * 0.49 m of taper per metre — four times the captain's cabin. Square against
 * that, the berth would stand 0.9 m off the planking at one end, or be buried
 * in the frames at the other.
 */
export function crewBerthGeometry(hand: Hand): CrewBerthGeometry {
  const found = cachedBerths.get(hand);
  if (found) return found;
  const placement = placeInRoom({
    space: 'forecastle',
    // Off the peak bulkhead's own face — the room's bound is the bulkhead's
    // *plane*, so a berth run to `zForward` would have its head board inside
    // 30 mm of the timber and nothing would complain.
    from: 'forward',
    offset: BULKHEAD_FACE + CREW_BERTH_HEAD_CLEAR,
    length: CREW_BERTH_LENGTH,
    hand,
    align: 'side',
    inboard: 0,
    width: CREW_BERTH_WIDTH,
    height: CREW_LOWER_SHELF_Y + CREW_TIER_PITCH + CREW_MATTRESS + CREW_LEE_BOARD,
  });
  const geometry: CrewBerthGeometry = {
    hand,
    placement,
    zAft: placement.zAft,
    zForward: placement.zForward,
    xInboard: hand === 'port' ? placement.xLo : placement.xHi,
    xOutboard: hand === 'port' ? placement.xHi : placement.xLo,
    soleY: placement.yLo,
    shelfYs: [
      placement.yLo + CREW_LOWER_SHELF_Y,
      placement.yLo + CREW_LOWER_SHELF_Y + CREW_TIER_PITCH,
    ],
  };
  cachedBerths.set(hand, geometry);
  return geometry;
}

/**
 * The after end of the berth flat: the furthest forward anything else may go.
 *
 * The **swept** station rather than the berth's own after end, because the
 * stacks are turned — see `placementSpanZ`. Both hands are asked and the aftmost
 * answer governs, so a change to one side's taper cannot leave the other side's
 * dresser overlapping a bunk.
 */
export function crewBerthAftZ(): number {
  return Math.min(
    placementSpanZ(crewBerthGeometry('port').placement).zAft,
    placementSpanZ(crewBerthGeometry('starboard').placement).zAft,
  );
}

function crewBerths(hand: Hand): InteriorFitting {
  const b = crewBerthGeometry(hand);
  const p = b.placement;
  const sign = hand === 'port' ? 1 : -1;
  const { span: bspan, rod } = drawnIn(p.frame);
  const lo = Math.min(p.xLo, p.xHi);
  const hi = Math.max(p.xLo, p.xHi);
  const solids: FittingSolid[] = [];

  // The locker under the lower bunk. **The collidable carcase**, solid from the
  // sole to 0.42 — above the walker's step-over, so a body meets a bunk rather
  // than climbing onto one. This is where a hand's chest goes: §4.4 asks for
  // four sea chests and the room has floor for two, so two of them live here.
  solids.push(bspan(lo, hi, p.yLo, b.shelfYs[0], p.zAft, p.zForward, 'timber', true));
  {
    const pitch = (p.zForward - p.zAft) / 2;
    for (let i = 0; i < 2; i++) {
      const face = sign > 0 ? lo : hi;
      solids.push(
        bspan(
          Math.min(face, face - sign * 0.012),
          Math.max(face, face - sign * 0.012),
          p.yLo + 0.06,
          b.shelfYs[0] - 0.04,
          p.zAft + pitch * i + 0.02,
          p.zAft + pitch * (i + 1) - 0.02,
          'timber',
          false,
        ),
      );
    }
  }

  for (let tier = 0; tier < b.shelfYs.length; tier++) {
    const shelfY = b.shelfYs[tier];
    const mattressY = shelfY + CREW_MATTRESS;
    // The bunk bottom.
    solids.push(
      bspan(lo, hi, shelfY - 0.022, shelfY, p.zAft, p.zForward, 'timber', tier > 0),
    );
    // The lee board along the front of each tier — the one rail that keeps a
    // sleeping man in his bed when she rolls, and the detail that makes a
    // shelf a berth.
    //
    // **Let into the bunk front rather than standing proud of it.** Drawn 28 mm
    // proud it is a shin at head height on the only lane to the bunks, and it
    // was also 28 mm of the reason the forecastle's lantern swung into this
    // stack — see `CREW_BERTH_LENGTH`. A lee board on a real bunk is the front
    // edge of the bottom boards carried up, which is flush by construction.
    const inner = b.xInboard + sign * CREW_LEE_THICKNESS;
    solids.push(
      bspan(
        Math.min(b.xInboard, inner),
        Math.max(b.xInboard, inner),
        shelfY,
        shelfY + CREW_LEE_BOARD,
        p.zAft,
        p.zForward,
        'timber',
        tier === 0,
      ),
    );
    // Bedding: a straw mattress, a blanket over the after two thirds, a bolster
    // at the head — which is forward, away from the noise of the mess.
    // The bedding, inside the lee board on the room side so the timber shows
    // as a border and the bed reads as lying *in* the berth.
    const beddingInboard = b.xInboard + sign * (CREW_LEE_THICKNESS + 0.006);
    const beddingOutboard = b.xOutboard - sign * 0.02;
    const bLo = Math.min(beddingInboard, beddingOutboard);
    const bHi = Math.max(beddingInboard, beddingOutboard);
    solids.push(
      bspan(bLo, bHi, shelfY, mattressY, p.zAft + 0.03, p.zForward - 0.03, 'linen', false),
    );
    solids.push(
      bspan(
        bLo,
        bHi,
        mattressY,
        mattressY + 0.038,
        p.zAft + 0.03,
        p.zForward - (p.zForward - p.zAft) * 0.34,
        'wool',
        false,
      ),
    );
    solids.push(
      bspan(
        bLo + 0.03,
        bHi - 0.03,
        mattressY,
        mattressY + 0.07,
        p.zForward - 0.34,
        p.zForward - 0.06,
        'linen',
        false,
      ),
    );
    // The two stanchions that carry the upper tier, at the bunk front. Drawn
    // for the lower tier only: they run past it to the upper bunk's boards.
    if (tier === 0) {
      for (const z of [p.zAft + 0.05, p.zForward - 0.05]) {
        solids.push(
          bspan(
            Math.min(b.xInboard, b.xInboard - sign * 0.05),
            Math.max(b.xInboard, b.xInboard - sign * 0.05),
            shelfY,
            b.shelfYs[1],
            z - 0.028,
            z + 0.028,
            'timber',
            false,
          ),
        );
      }
    }
  }

  // A hook for an oilskin at the head of each bunk, on the ship's side.
  for (const shelfY of b.shelfYs) {
    solids.push(
      rod(
        v3(b.xOutboard, shelfY + 0.44, p.zForward - 0.12),
        v3(b.xOutboard - sign * 0.06, shelfY + 0.42, p.zForward - 0.12),
        0.009,
        0.007,
        'ironwork',
        false,
      ),
    );
  }

  return {
    name: hand === 'port' ? 'crewBerthsPort' : 'crewBerthsStarboard',
    kind: 'crewBerth',
    solids,
    standable: null,
  };
}

export function crewBerthsPort(): InteriorFitting {
  return crewBerths('port');
}

export function crewBerthsStarboard(): InteriorFitting {
  return crewBerths('starboard');
}

// --- turning in --------------------------------------------------------------

/** Which of a stack's two bunks. Lower is 0, as `shelfYs` reports them. */
export type CrewTier = 0 | 1;

/**
 * The pose of a hand lying in one of the four crew bunks.
 *
 * **Head forward, and the bolster is what says so** — `crewBerths` draws it at
 * the forward end and writes the reason on it: away from the noise of the mess.
 * Both tiers sleep the same way round, which is the only thing about this pair
 * that a mirror does carry.
 *
 * The stacks lie over at 24.6° — the sharpest turn in the ship — so the heading
 * is the berth's own and not the keel's. A hand lying in the port bunk is
 * looking 24.6° off the centreline, which is what lying in a bow is.
 */
export function crewBerthPose(hand: Hand, tier: CrewTier): SeatPose {
  const b = crewBerthGeometry(hand);
  return lyingPose({
    frame: b.placement.frame,
    xInboard: b.xInboard,
    xOutboard: b.xOutboard,
    zHead: b.zForward,
    zFoot: b.zAft,
    mattressY: b.shelfYs[tier] + CREW_MATTRESS,
  });
}

/**
 * The mouth of one bunk in a stack — what a body aims at to turn in.
 *
 * **Capped by the tier above rather than by a constant.** Two bunks 0.76 m
 * apart are two targets a body picks between by looking up or down at them, and
 * a lower bunk whose box reached its own 0.50 m of air would end 22 mm under
 * the upper bunk's boards — near enough that a glance across the two would be
 * one object, which is a player climbing into the wrong bed.
 */
export function crewBerthTarget(hand: Hand, tier: CrewTier): InteractableBox {
  const b = crewBerthGeometry(hand);
  const p = b.placement;
  const shelfY = b.shelfYs[tier];
  const above = b.shelfYs[tier + 1];
  const ceiling = above === undefined ? Infinity : above - 0.022;
  return framedTarget(
    p.frame,
    Math.min(p.xLo, p.xHi),
    Math.max(p.xLo, p.xHi),
    shelfY,
    Math.min(shelfY + BERTH_MOUTH_HEIGHT, ceiling),
    p.zAft,
    p.zForward,
  );
}

// --- sitting on a chest --------------------------------------------------------

const cachedChests = new Map<Hand, RoomPlacement>();

/**
 * Where a crew chest stands, published.
 *
 * A local until the port one became something you sit on. Same reason the
 * berths publish theirs: a station that re-derived the placement would be a
 * second description of one piece of furniture.
 */
export function crewChestPlacement(hand: Hand): RoomPlacement {
  const found = cachedChests.get(hand);
  if (found) return found;
  const space = forecastle();
  const forwardFace =
    hand === 'port'
      ? crewBerthAftZ() - CHEST_OFF_NEIGHBOUR
      : galleyDresserAftZ() - CHEST_OFF_NEIGHBOUR;
  const placement = placeInRoom({
    space: 'forecastle',
    // Placed by the face that has something behind it, which for both of these
    // is the forward one: the port chest stops at the berth flat and the
    // starboard one at the dresser. Anchoring by the after face instead would
    // let the turn push either of them into the thing it was cleared of.
    from: 'forward',
    offset: space.zForward - forwardFace,
    length: CREW_CHEST_LENGTH,
    hand,
    align: 'side',
    inboard: 0,
    width: CREW_CHEST_WIDTH,
    height: CREW_CHEST_HEIGHT,
  });
  cachedChests.set(hand, placement);
  return placement;
}

/**
 * The pose of a hand sitting on the port sea chest.
 *
 * **Facing inboard, which is where the room is.** A chest stands with its back
 * against the ship's side, and the only way to sit on one is with your back to
 * the planking — so the heading is the chest's own inboard normal, turned with
 * it. The crew's table is 1.09 m off that face, which is a long reach for a
 * meal and is what the forecastle has: §21.7's tightest lane is 0.25 m and the
 * chests could not be drawn up beside the leaf.
 *
 * **There is no station on the starboard chest**, and the reason is measured
 * rather than a matter of taste: it stands at z +2.62 → +3.47 with its inboard
 * face at x −1.53, and the fore scuttle's ladder is spiked to the bulkhead at
 * x −1.10 across z +2.83 → +3.15. A seated man's knees reach about 0.25 m off
 * the chest, which is 0.18 m *inside* the ladder — so the pose would intersect
 * the furniture it does not use, which is the one thing a seat may not do.
 */
export function crewChestPose(hand: Hand): SeatPose {
  const p = crewChestPlacement(hand);
  return seatedPose({
    frame: p.frame,
    x: (p.xLo + p.xHi) / 2,
    z: (p.zAft + p.zForward) / 2,
    seatY: p.yHi,
    // **The chest's inboard face is `xLo` to port and `xHi` to starboard**, so
    // facing inboard is the frame's −x to port and its +x to starboard. This
    // was written the other way round first and the pose faced a port sitter at
    // the ship's side from 0.1 m: the inversion `cabinFurniture.washstand`
    // records building a whole piece of furniture inside out, and it is the
    // same one. Read it off `crewChest`'s own `xInboard`, do not reason about
    // it.
    facing: hand === 'port' ? 'frameMinusX' : 'framePlusX',
    // Nothing to lean over: the table is a metre off and a chest has no back
    // to sit up against either.
    lean: 0,
    // Level, near enough. A chest is 0.43 m and the eye lands at 3.26 — half a
    // metre over the crew's table at 2.80, which a 10° drop puts in the lower
    // third of the frame with the berth flat and the foremast above it.
    pitch: -10,
    yawRange: 100,
    pitchLo: -55,
    pitchHi: 45,
  });
}

/** What a body aims at to sit on a chest: the lid and the sitter over it. */
export function crewChestTarget(hand: Hand): InteractableBox {
  const p = crewChestPlacement(hand);
  return framedTarget(
    p.frame,
    Math.min(p.xLo, p.xHi) - CHEST_TARGET_PAD,
    Math.max(p.xLo, p.xHi) + CHEST_TARGET_PAD,
    p.yLo,
    p.yHi + 0.60,
    p.zAft - CHEST_TARGET_PAD,
    p.zForward + CHEST_TARGET_PAD,
  );
}

const CHEST_TARGET_PAD = 0.06;

// --- the hinged table at the foremast --------------------------------------------

const FOREMAST_TABLE_LENGTH = 0.68;
const FOREMAST_TABLE_HALF_WIDTH = 0.27;
const FOREMAST_TABLE_TOP_Y = 0.72;
const FOREMAST_TABLE_THICKNESS = 0.036;

/**
 * The crew's table, hinged to the foremast and drawn down.
 *
 * §4.4 asks for "a hinged table at the foremast" and that is exactly what this
 * is: a leaf cleated to the mast's after side on two iron hinges, with one
 * folding leg under its free end, which comes down for a meal and goes up flat
 * against the mast when the watch wants the floor. **It is drawn down and there
 * is no state that folds it**, for the berth curtain's reason in
 * `cabinFurniture.ts`: a leaf drawn up is a plank against a spar and tells a
 * player nothing about what this room is for, and a state nothing maintains is
 * worse than an object that is honestly always in one.
 *
 * Its station is the mast's, asked at the sole — see `rig.mastSectionAt` for
 * why that is not `FOREMAST_Z`. Its width is what the lane past it allows: at
 * 0.86 m across it leaves 0.55–0.75 m of clear sole each hand between it and
 * the dresser or the chest, which a 0.52 m body walks.
 */
export function foremastTable(): InteriorFitting {
  const space = forecastle();
  const zForward = foremastAfterFaceZ();
  const zAft = zForward - FOREMAST_TABLE_LENGTH;
  const topY = space.soleY + FOREMAST_TABLE_TOP_Y;
  const solids: FittingSolid[] = [];
  const xLo = -FOREMAST_TABLE_HALF_WIDTH;
  const xHi = FOREMAST_TABLE_HALF_WIDTH;

  // The leaf. **The one collidable piece**, and at 0.72 it is a table a body
  // meets rather than a step it takes.
  solids.push(
    span(xLo, xHi, topY - FOREMAST_TABLE_THICKNESS, topY, zAft, zForward, 'timber', true),
  );
  // A batten across the underside at each end, which is what stops a leaf of
  // this span cupping.
  for (const z of [zAft + 0.06, zForward - 0.08]) {
    solids.push(
      span(
        xLo + 0.05,
        xHi - 0.05,
        topY - FOREMAST_TABLE_THICKNESS - 0.026,
        topY - FOREMAST_TABLE_THICKNESS,
        z - 0.024,
        z + 0.024,
        'timber',
        false,
      ),
    );
  }
  // The fiddle round the three free sides. The fourth is the mast.
  for (const [fxLo, fxHi, fzLo, fzHi] of [
    [xLo, xLo + 0.018, zAft, zForward],
    [xHi - 0.018, xHi, zAft, zForward],
    [xLo, xHi, zAft, zAft + 0.018],
  ] as const) {
    solids.push(span(fxLo, fxHi, topY, topY + 0.030, fzLo, fzHi, 'timber', false));
  }
  // The folding leg under the free end, and its two hinges on the mast.
  {
    const { rod } = drawnIn(SQUARE_FRAME);
    for (const x of [-0.24, 0.24]) {
      solids.push(
        rod(
          v3(x, space.soleY, zAft + 0.09),
          v3(x, topY - FOREMAST_TABLE_THICKNESS - 0.026, zAft + 0.09),
          0.030,
          0.026,
          'timber',
          false,
        ),
      );
    }
    solids.push(
      span(
        -0.26,
        0.26,
        space.soleY + 0.16,
        space.soleY + 0.19,
        zAft + 0.07,
        zAft + 0.11,
        'timber',
        false,
      ),
    );
    for (const x of [-0.26, 0.26]) {
      solids.push(
        span(
          x - 0.03,
          x + 0.03,
          topY - FOREMAST_TABLE_THICKNESS - 0.02,
          topY,
          zForward,
          zForward + 0.045,
          'ironwork',
          false,
        ),
      );
    }
  }

  return { name: 'foremastTable', kind: 'foremastTable', solids, standable: null };
}

// --- the sea chests ---------------------------------------------------------------

const CREW_CHEST_LENGTH = 0.76;
const CREW_CHEST_WIDTH = 0.44;
/** Chest-height, which is also seat height: a chest at a mess table is a stool. */
const CREW_CHEST_HEIGHT = 0.43;
const CREW_CHEST_LID = 0.045;

/**
 * A seaman's chest against the ship's side, which is also what he sits on.
 *
 * Plainer than the captain's — see `cabinFurniture.captainSeaChest`, which is
 * leather-covered and brass-strapped because it is a gentleman's travelling
 * chest. A hand's chest is painted deal with a rope becket at each end and
 * nothing else on it, and the two want to look different from across a room.
 * They share a kind because they are the same class of object and one
 * classification is the point of the kind list.
 *
 * **Two, not four, and the room decided it.** §4.4 wants a chest for each hand
 * round the walls; the after third of the forecastle has the galley on one side
 * and the scuttle on the other, and the forward two thirds is berths. So two
 * stand where there is wall for them — one abreast the mess table to port, one
 * against the after bulkhead to starboard, outboard of the ladder — and the
 * other two hands stow under the lower bunks, which is what `crewBerth`'s own
 * locker is for.
 */
function crewChest(hand: Hand, name: string): InteriorFitting {
  const p = crewChestPlacement(hand);
  const { span: cspan, rod } = drawnIn(p.frame);
  const sign = hand === 'port' ? 1 : -1;
  const xInboard = hand === 'port' ? p.xLo : p.xHi;
  const lo = Math.min(p.xLo, p.xHi);
  const hi = Math.max(p.xLo, p.xHi);
  const lidLo = p.yHi - CREW_CHEST_LID;
  const solids: FittingSolid[] = [];

  // Plinth, carcase, lid. **Carcase and lid collide**: at 0.43 the lid is above
  // the walker's 0.40 m step-over by 30 mm, so a chest is a low wall rather
  // than a kerb — which is right, because a body that strode a sea chest would
  // stride it into the ship's side.
  solids.push(
    cspan(
      lo + 0.03,
      hi - 0.03,
      p.yLo,
      p.yLo + 0.05,
      p.zAft + 0.03,
      p.zForward - 0.03,
      'timber',
      false,
    ),
  );
  solids.push(cspan(lo, hi, p.yLo + 0.05, lidLo, p.zAft, p.zForward, 'timber', true));
  solids.push(
    cspan(
      Math.min(xInboard - sign * 0.014, hand === 'port' ? hi : lo),
      Math.max(xInboard - sign * 0.014, hand === 'port' ? hi : lo),
      lidLo,
      p.yHi,
      p.zAft - 0.014,
      p.zForward + 0.014,
      'timber',
      true,
    ),
  );
  // Iron corner straps at the two ends of the lid, which is all the ironwork a
  // seaman's chest has.
  for (const z of [p.zAft + 0.05, p.zForward - 0.05]) {
    solids.push(
      cspan(
        Math.min(xInboard - sign * 0.016, xInboard + sign * 0.004),
        Math.max(xInboard - sign * 0.016, xInboard + sign * 0.004),
        p.yLo + 0.07,
        p.yHi,
        z - 0.020,
        z + 0.020,
        'ironwork',
        false,
      ),
    );
  }
  // A rope becket on each end board — the handle a chest is actually carried by.
  for (const z of [p.zAft - 0.010, p.zForward + 0.010]) {
    const xMid = (lo + hi) / 2;
    const yTop = p.yLo + 0.30;
    const yBottom = p.yLo + 0.19;
    for (const x of [xMid - 0.06, xMid + 0.06]) {
      solids.push(rod(v3(x, yBottom, z), v3(x, yTop, z), 0.008, 0.008, 'leather', false));
    }
    solids.push(
      rod(
        v3(xMid - 0.06, yBottom, z),
        v3(xMid + 0.06, yBottom, z),
        0.008,
        0.008,
        'leather',
        false,
      ),
    );
  }

  return { name, kind: 'seaChest', solids, standable: null };
}

/**
 * Where the two crew chests stand.
 *
 * Both derived: the port one is abreast the mess table, so it is the seat at
 * it; the starboard one is against the after bulkhead outboard of the fore
 * scuttle's climb envelope, which is the only wall left on that hand.
 */
export function crewChestPort(): InteriorFitting {
  // Abreast the mess table, against the port side: the seat at it, and the one
  // place on this hand that is neither the galley nor the berth flat.
  return crewChest('port', 'crewChestPort');
}

export function crewChestStarboard(): InteriorFitting {
  // Against the after bulkhead, outboard of the fore scuttle's shaft — the
  // only wall left on this hand once the ladder and the dresser have theirs.
  return crewChest('starboard', 'crewChestStarboard');
}

/** Clear air between a chest and whatever stands next to it along the side. */
const CHEST_OFF_NEIGHBOUR = 0.04;

/**
 * The outboard edge of the fore scuttle's shaft, which nothing may reach into.
 *
 * Published so `ship-interior.test.ts` can check the starboard chest against it
 * rather than re-deriving it. The chest stands against the same bulkhead the
 * ladder is spiked to, and a chest inside the climb envelope is a body shoved
 * off a ladder — which is the fault `FORE_SCUTTLE_LADDER_STANDOFF`'s own note
 * records costing a walk. The *opening* is the datum rather than the ladder's
 * acquisition band, which is 0.075 m narrower: what a climbing body needs clear
 * is the shaft.
 */
export function foreScuttleShaftOutboardX(): number {
  return FORE_SCUTTLE_X - FORE_SCUTTLE_HALF_BREADTH;
}

/** Everything standing in the forecastle. */
export function forecastleFurniture(): readonly InteriorFitting[] {
  return [
    galleyHearth(),
    galleyDresser(),
    crewBerthsPort(),
    crewBerthsStarboard(),
    foremastTable(),
    crewChestPort(),
    crewChestStarboard(),
  ];
}
