import {
  PUMP_RADIUS,
  PUMP_WELL_BOARD,
  PUMP_WELL_CLEAR,
  PUMP_WELL_HALF,
  PUMP_WELL_HEAD_HEIGHT,
  PUMP_X,
  PUMP_Z,
} from './deckFittings';
import type { FittingSolid, StandablePanel } from './deckFittings';
import {
  BELOW_DECKS_SPACES,
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  belowDecksSpace,
  spaceDeckheadY,
  spaceHalfWidthAt,
} from './deckInterior';
import { cabinBarometer, chartDesk, chartRack, deskChair } from './captainsDesk';
import {
  bookShelf,
  boxBerth,
  boxBerthCurtain,
  cabinTellTaleCompass,
  captainSeaChest,
  hangingLocker,
  sternLockerPort,
  sternLockerStarboard,
  washstand,
} from './cabinFurniture';
import { deskItems } from './deskItems';
import { forecastleFurniture } from './forecastleFurniture';
import { wardroomFurniture } from './wardroomFurniture';
import { isClosureOpen } from './closures';
import { isStationOccupied } from './seatState';
import type { BelowDecksSpace } from './deckInterior';
import type { InteriorFitting } from './roomFitting';
import { deckStandAt } from './deckSurface';
import {
  DECK_PLANK_THICKNESS,
  FORE_SCUTTLE_HALF_BREADTH,
  FORE_SCUTTLE_X,
  FORE_SCUTTLE_Z,
  floorYAt,
} from './hullForm';
import { v3 } from './shipwright';

/**
 * What stands in the rooms below decks.
 *
 * **How a thing below decks says where it is** — the anchor vocabulary, the
 * side-limit rule and the `InteriorFitting` contract itself — moved to
 * `roomFitting.ts` when the captain's desk needed to be its own module and could
 * not import `placeInRoom` from the file that has to list it. Read that one
 * first; it carries the reasoning this file used to.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The hold's stow. It is not *in* a room — it is under all of them, it is
 * bounded by the frames rather than by a sole, and it is a thousand instanced
 * casks rather than a handful of authored boxes. `holdStow.ts` owns it.
 *
 * The captain's desk, its rack and its chair, for the cycle above and because
 * one piece of joinery with three materials, two states and a seat attached to
 * it is a module's worth of decisions. `captainsDesk.ts` owns those; this file
 * still owns the *lists*, because a fitting that is drawn but not collided with
 * — or collided with but not drawn — is the fault every one of these lists
 * exists to make impossible.
 */

// --- the bilge pump, below the planking ---------------------------------------

/**
 * How far the tube's foot stands above the rabbet.
 *
 * A pump draws from the lowest water in the ship and it must not draw the
 * ballast's grit with it, so the foot sits a hand's breadth off the floors with
 * a strainer under it. Below this the limber channel runs along the keelson and
 * is what brings the water here in the first place.
 */
const PUMP_FOOT_CLEARANCE = 0.12;

/**
 * The well's inside, round the tube.
 *
 * **The three plan dimensions moved to `deckFittings.ts`, beside the pump's own
 * station, and the reason is a cycle rather than tidiness.** The wardroom's
 * mess table is cut short at its after end by this well — a derived station,
 * per this file's whole doctrine — and a furniture module cannot ask *this*
 * file where the well is, because this file is the one that has to list the
 * furniture. It is `placeInRoom` leaving for `roomFitting.ts` over again.
 *
 * The timber is still drawn here; only the numbers are somewhere a fitting can
 * reach without importing its own list.
 */
const WELL_CLEAR = PUMP_WELL_CLEAR;
const WELL_BOARD = PUMP_WELL_BOARD;

/** The wardroom, which is the room the pump passes through. */
function pumpSpace(): BelowDecksSpace {
  const space = BELOW_DECKS_SPACES.find(
    (candidate) => PUMP_Z >= candidate.zAft && PUMP_Z <= candidate.zForward,
  );
  if (!space) {
    throw new Error(`the bilge pump at z=${PUMP_Z.toFixed(3)} passes through no room below decks`);
  }
  return space;
}

/**
 * The length of pump nobody had drawn.
 *
 * `deckFittings.ts` draws 0.92 m of tube standing on the planking with a brake
 * on it. Below the planking there was nothing at all — which Ash reported as
 * *"it's located on the deck but doesn't have a shaft going all the way down.
 * Wouldn't it need to connect somewhere?"*, and he is right: a pump that does
 * not reach the bilge is decoration.
 *
 * **The station is not decided here.** `PUMP_X` and `PUMP_Z` come from
 * `deckFittings.ts`, so the head and the tube cannot part company, and
 * `SHIP_BELOW_DECKS_PLAN.md` §4.3's pump well is the same z by construction
 * rather than by agreement.
 */
export function pumpTube(): InteriorFitting {
  const space = pumpSpace();
  const deck = deckStandAt(PUMP_X, PUMP_Z);
  if (!deck) throw new Error('the bilge pump stands off the deck');

  // From the underside of the planking, so the tube and the deck it passes
  // through meet in the timber rather than leaving a ring of daylight.
  const headY = deck.y - DECK_PLANK_THICKNESS;
  const footY = floorYAt(PUMP_Z) + PUMP_FOOT_CLEARANCE;
  const soleY = space.soleY;

  return {
    name: 'pumpTube',
    kind: 'pumpTube',
    solids: [
      // Standing in the wardroom: solid, because a body is in here with it.
      {
        kind: 'bar',
        a: v3(PUMP_X, soleY, PUMP_Z),
        b: v3(PUMP_X, headY, PUMP_Z),
        radiusA: PUMP_RADIUS * 1.06,
        radiusB: PUMP_RADIUS,
        material: 'timber',
        collides: true,
      },
      // Below the sole, inside the well. Not collidable: there is no floor down
      // there for a body to be standing on, and a collider in a place a body
      // cannot reach is a claim nothing can ever check.
      {
        kind: 'bar',
        a: v3(PUMP_X, footY, PUMP_Z),
        b: v3(PUMP_X, soleY, PUMP_Z),
        radiusA: PUMP_RADIUS * 1.12,
        radiusB: PUMP_RADIUS * 1.06,
        material: 'timber',
        collides: false,
      },
      // The iron bands that stop a bored log splitting, at the two places it is
      // worked hardest: where it passes the sole and at the foot.
      {
        kind: 'bar',
        a: v3(PUMP_X, soleY + 0.30, PUMP_Z),
        b: v3(PUMP_X, soleY + 0.35, PUMP_Z),
        radiusA: PUMP_RADIUS * 1.06 + 0.012,
        radiusB: PUMP_RADIUS * 1.06 + 0.012,
        material: 'ironwork',
        collides: false,
      },
      {
        kind: 'bar',
        a: v3(PUMP_X, footY + 0.06, PUMP_Z),
        b: v3(PUMP_X, footY + 0.11, PUMP_Z),
        radiusA: PUMP_RADIUS * 1.12 + 0.012,
        radiusB: PUMP_RADIUS * 1.12 + 0.012,
        material: 'ironwork',
        collides: false,
      },
    ],
    standable: null,
  };
}

/**
 * The well: four boarded sides from the limbers to the platform, and a head
 * standing proud of the wardroom sole.
 *
 * This is the piece that makes the pump read from inside the ship. A tube
 * emerging from a floor is a pole through a hole; a tube rising out of a boxed
 * well head, with the sounding rod beside it, is a ship's pump.
 *
 * It is placed off the tube rather than anchored to a bulkhead, because it is
 * not furniture arranged in a room — it is built round something whose position
 * is set by the mast step under it. That is the honest reading and it is why
 * this one does not go through `placeInRoom`.
 */
export function pumpWell(): InteriorFitting {
  const space = pumpSpace();
  const soleY = space.soleY;
  const footY = floorYAt(PUMP_Z);
  const headTop = soleY + PUMP_WELL_HEAD_HEIGHT;
  const half = PUMP_WELL_HALF;

  const solids: FittingSolid[] = [];

  // The four boards of the casing, from the floors to the top of the head. Each
  // side is one box rather than a stack, so there are no coincident faces to
  // z-fight down the length of it — §11.3's coaming lesson.
  const outer = half;
  const inner = WELL_CLEAR;
  for (const sign of [1, -1]) {
    // Athwartships pair, running the full length so the corners are covered.
    solids.push({
      kind: 'box',
      centre: v3(PUMP_X + sign * (inner + WELL_BOARD / 2), (footY + headTop) / 2, PUMP_Z),
      half: v3(WELL_BOARD / 2, (headTop - footY) / 2, outer),
      material: 'timber',
      // Only the length standing in the wardroom can be walked into, and it is
      // under the step-over. Marked not-collidable for the same reason the
      // forecastle's 0.25 m sill is: a body strides it.
      collides: false,
    });
    // Fore-and-aft pair, run *into* the first pair rather than butted against
    // it. Butted exactly, the two boards share a plane at every corner — and
    // four coincident faces are four dark seams down the well head, which is
    // what the render showed. Half a board of overlap is a lap joint, which is
    // also how it would actually be built. §11.3's coaming lesson: coplanar
    // faces are notches of z-fighting, so make timber interpenetrate.
    solids.push({
      kind: 'box',
      centre: v3(PUMP_X, (footY + headTop) / 2, PUMP_Z + sign * (inner + WELL_BOARD / 2)),
      half: v3(inner + WELL_BOARD / 2, (headTop - footY) / 2, WELL_BOARD / 2),
      material: 'timber',
      collides: false,
    });
  }

  // The sounding rod: a graduated iron rod dropped down the well to read how
  // much water she is making. It is the reason a well is boarded clear.
  solids.push({
    kind: 'bar',
    a: v3(PUMP_X - inner * 0.6, soleY - 0.05, PUMP_Z + inner * 0.6),
    b: v3(PUMP_X - inner * 0.6, headTop + 0.22, PUMP_Z + inner * 0.6),
    radiusA: 0.012,
    radiusB: 0.012,
    material: 'ironwork',
    collides: false,
  });

  return {
    name: 'pumpWell',
    kind: 'pumpWell',
    solids,
    // The head is a flat top a hand's breadth over the sole. It is standable so
    // that a body crossing it steps up and down rather than clipping through —
    // the same contract the cargo hatch's grating has.
    standable: {
      x0: PUMP_X - half,
      x1: PUMP_X + half,
      z0: PUMP_Z - half,
      z1: PUMP_Z + half,
      y: headTop,
    },
  };
}

// --- the boards over the platform's hatchway ----------------------------------

/** Boards across the opening, and the gap between them. */
const BOARD_COUNT = 6;
const BOARD_GAP = 0.008;
const BOARD_THICKNESS = 0.024;

/** How far the stack of lifted boards stands off the opening's after edge. */
const BOARD_STACK_OFFSET = 0.16;

/**
 * The hatchway's boards, in whichever state they are in.
 *
 * **These used to be six boxes inside the hull's own `interiorSole` buffer**,
 * drawn by `shipGeometry.buildHatchwayBoards`, which is exactly right for a
 * floor and impossible for a thing that lifts: a merged geometry has no handle
 * on any one of its parts. They are a fitting now, which gives them their own
 * mesh and lets the two states be two geometries with one visible at a time —
 * cheaper and more honest than moving vertices every frame for something that
 * changes twice a voyage.
 *
 * The board dimensions and the paler timber came across unchanged, because the
 * room reading as *having a hatch you could lift* was already the reason they
 * were drawn separately from the sole.
 */
export function hatchwayBoards(open: boolean): InteriorFitting {
  const space = belowDecksSpace('wardroom');
  const length = HATCHWAY_FORWARD_Z - HATCHWAY_AFT_Z;
  const pitch = length / BOARD_COUNT;
  const solids: FittingSolid[] = [];

  for (let i = 0; i < BOARD_COUNT; i++) {
    if (open) {
      // Stacked on the sole abaft the opening, one on top of the next. Where
      // they would actually go: you lift them off and lay them down clear of
      // the hole so the whip has a straight drop.
      solids.push({
        kind: 'box',
        centre: v3(
          0,
          space.soleY + BOARD_THICKNESS * (i + 0.5),
          HATCHWAY_AFT_Z - BOARD_STACK_OFFSET - pitch / 2,
        ),
        half: v3(HATCHWAY_HALF_BREADTH, BOARD_THICKNESS / 2, pitch * 0.5 - BOARD_GAP),
        material: 'timber',
        collides: false,
      });
    } else {
      solids.push({
        kind: 'box',
        centre: v3(0, space.soleY + BOARD_THICKNESS / 2, HATCHWAY_AFT_Z + pitch * (i + 0.5)),
        half: v3(HATCHWAY_HALF_BREADTH, BOARD_THICKNESS / 2, pitch * 0.5 - BOARD_GAP),
        material: 'timber',
        collides: false,
      });
    }
  }

  return {
    name: 'hatchwayBoards',
    kind: 'hatchwayBoards',
    solids,
    // Shut, they are the sole and the sole already answers there. Lifted, the
    // stack is 0.14 m of timber that a body strides over. Neither is a panel
    // the walker needs told about — which is the same call the cargo hatch's
    // grating gets from the other direction.
    standable: null,
  };
}

/**
 * Where the boards are, as something a player can point at.
 *
 * The hatchway remains the target in both states. The lifted timber really is
 * stacked abaft the opening, but Space means "work this hatch": making the
 * target move to that low stack caused the action to disappear at the exact
 * moment the boards vanished. A player who keeps looking into the hold must be
 * offered "Lay the boards", including after they have fallen through it.
 *
 * The open box extends aft over the physical stack as well, so deliberately
 * aiming at either the hatchway or the boards still names the same closure.
 */
export function hatchwayBoardsBox(open: boolean): {
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
} {
  const space = belowDecksSpace('wardroom');
  const length = HATCHWAY_FORWARD_Z - HATCHWAY_AFT_Z;
  const pitch = length / BOARD_COUNT;
  if (open) {
    return {
      xLo: -HATCHWAY_HALF_BREADTH,
      xHi: HATCHWAY_HALF_BREADTH,
      yLo: space.soleY,
      yHi: space.soleY + Math.max(BOARD_THICKNESS * BOARD_COUNT, HATCH_TARGET_HEIGHT),
      zLo: HATCHWAY_AFT_Z - BOARD_STACK_OFFSET - pitch,
      zHi: HATCHWAY_FORWARD_Z,
    };
  }
  return {
    xLo: -HATCHWAY_HALF_BREADTH,
    xHi: HATCHWAY_HALF_BREADTH,
    yLo: space.soleY,
    // **Knee-high, not board-thick, and that is not a fudge.** The target is
    // where a person *aims*, and the boards are 24 mm of timber lying on a
    // floor 1.62 m below the eye: a ray aimed at them enters that slab 2.2 m
    // away no matter how close you stand, because almost all of the distance is
    // the drop rather than the walk. Sized to the thing itself, the hatch was
    // unreachable from anywhere in the room, and every floor-level object in
    // the ship would have inherited it.
    //
    // The right quantity is the volume a hand would go into to work the thing,
    // which for a deck hatch is the space just above it.
    yHi: space.soleY + HATCH_TARGET_HEIGHT,
    zLo: HATCHWAY_AFT_Z,
    zHi: HATCHWAY_FORWARD_Z,
  };
}

/** How far above a floor-level closure the aiming volume stands. Knee height. */
const HATCH_TARGET_HEIGHT = 0.45;

// --- the fore scuttle's ladder -------------------------------------------------

/**
 * The way up out of the forecastle.
 *
 * WHY A LADDER AND NOT A FLIGHT
 * -----------------------------
 * Two reasons, and the first is the one that decided the hold's: **a stair
 * needs run, and a scuttle has none.** Every centimetre a flight reaches away
 * from the opening is a centimetre under solid planking, and this hole is
 * 0.75 m square. The second is that it *should* be different from the
 * companionway aft. That is a five-riser stair at 60–70° with a landing, and it
 * is the officers' way below. The crew's way below is a ladder you back down,
 * and the two reading differently is worth having for free.
 *
 * WHY IT IS AT THE AFTER END, STANDING OFF THE BULKHEAD
 * -----------------------------------------------------
 * Ash's sketch had it against the ship's side — "a ladder down the wall" — and
 * the side would carry it: the forecastle's half-width is 2.02 m at the sole
 * and 2.04 m at the deckhead, so the topsides are effectively plumb through the
 * whole height of this room. It is on the after coaming instead because the
 * *opening* is 0.25 m in from the side and a ladder has to be under the hole it
 * serves. The after coaming is 25 mm off the forecastle's own after bulkhead —
 * flat, plumb and structural, where the ship's side at this station is neither
 * — so this is the same corner Ash pointed at, reached by the one face that can
 * actually take the spikes.
 *
 * WHERE IT IS is asked of the scuttle rather than typed, per this file's whole
 * doctrine: move `FORE_SCUTTLE_X` and the ladder goes with the hatch.
 */
const FORE_SCUTTLE_LADDER_RUNGS = 7;
/** Half-breadth of the visible ladder, leaving the little scuttle compact. */
const FORE_SCUTTLE_LADDER_HALF_BREADTH = 0.27;
/** The slightly wider body envelope used to acquire and remain on the ladder. */
const FORE_SCUTTLE_LADDER_CLIMB_HALF_BREADTH = 0.3;
/** A rung is a hand-sized bar, not the 0.32 m-deep shelf its climb zone is. */
export const FORE_SCUTTLE_RUNG_DEPTH = 0.065;
export const FORE_SCUTTLE_RUNG_THICKNESS = 0.036;

/**
 * How far forward of the hole's after edge the ladder stands.
 *
 * **A ladder needs toe room, and this one had none.** It was spiked flush to
 * the after coaming — 25 mm off the forecastle's own after bulkhead, which
 * reads well and is where a shipwright would put the spikes. It also made the
 * ladder unclimbable, and the way it failed is worth keeping because nothing
 * about it looks like a ladder problem:
 *
 * > The bulkhead is a collider. A body is a cylinder of `radius` 0.26 m, so its
 * > centre cannot come within 0.26 m of the bulkhead's forward face at 2.63 —
 * > it is pushed to z ≥ 2.89. The rungs' footprint ran 2.625 to 2.865. So the
 * > walker was shoved *forward off the ladder* on the first frame, found no
 * > foothold, and fell 2 m to the sole. Every rung was correctly spaced,
 * > correctly published and correctly gated; the body simply could not stand on
 * > any of them.
 *
 * 0.205 m puts the rungs' band at 2.83–3.15 against a body that must be at
 * 2.89 or forward of it, so the usable standing band is 0.26 m of the shaft's
 * 0.75. `ship-interior.test.ts` asserts the ladder is climbable by climbing it
 * rather than by re-deriving this number.
 *
 * It is also what a real ladder does. You do not climb one with your toes
 * against the bulkhead behind it; it stands off far enough to get a boot on the
 * rung, and the stiles are what reach back to the timber.
 */
const FORE_SCUTTLE_LADDER_STANDOFF = 0.205;
/** Fore-and-aft depth of the body-acquisition band, not of the visible rungs. */
const FORE_SCUTTLE_LADDER_DEPTH = 0.32;

export const FORE_SCUTTLE_LADDER_Z_AFT =
  FORE_SCUTTLE_Z - FORE_SCUTTLE_HALF_BREADTH + FORE_SCUTTLE_LADDER_STANDOFF;
export const FORE_SCUTTLE_LADDER_Z_FORWARD =
  FORE_SCUTTLE_LADDER_Z_AFT + FORE_SCUTTLE_LADDER_DEPTH;

/** The deck the ladder's head comes out at — the planking, not the coaming. */
export function foreScuttleLadderHeadY(): number {
  const stand = deckStandAt(
    FORE_SCUTTLE_X,
    (FORE_SCUTTLE_LADDER_Z_AFT + FORE_SCUTTLE_LADDER_Z_FORWARD) / 2,
  );
  if (!stand) throw new Error('the fore scuttle is not over the deck');
  return stand.y;
}

/** The forecastle sole the ladder stands on. */
export function foreScuttleLadderFootY(): number {
  return belowDecksSpace('forecastle').soleY;
}

/**
 * Rise per rung.
 *
 * Seven rungs over roughly 1.97 m is 0.25 m apiece, under
 * `DEFAULT_WALKER_TUNING.stepUp` at 0.32 — so every rung is reachable from the
 * one below it and from the sole. `ship-interior.test.ts` asserts that against
 * the walker's own tuning rather than against 0.32 written out again here.
 *
 * **Divided by rungs + 1, so the top rung stops one rise BELOW the planking**,
 * and that is not an off-by-one. Divided by the rung count, the topmost rung
 * lands exactly level with the deck — which is what the hold's ladder does, and
 * is harmless there because its hatchway is 1.8 m long and the ladder only
 * 0.26 m of it. This shaft is 0.75 m and the ladder is 0.32 m of it, so a top
 * rung at deck height floors nearly half the opening at deck height: you could
 * **walk straight across the open scuttle** without noticing it was open, which
 * is the opposite of what an open hatch on a working deck should be.
 *
 * One rise down, stepping into the hole drops the body 0.25 m into it — head at
 * deck level, feet on the ladder, which is exactly where a body entering a
 * scuttle is — and stepping out again is a 0.25 m rise, well inside a stride.
 */
export function foreScuttleLadderRise(): number {
  return (
    (foreScuttleLadderHeadY() - foreScuttleLadderFootY()) /
    (FORE_SCUTTLE_LADDER_RUNGS + 1)
  );
}

export function foreScuttleLadder(): InteriorFitting {
  const foot = foreScuttleLadderFootY();
  const rise = foreScuttleLadderRise();
  const zMid = (FORE_SCUTTLE_LADDER_Z_AFT + FORE_SCUTTLE_LADDER_Z_FORWARD) / 2;
  const solids: FittingSolid[] = [];

  for (let i = 0; i < FORE_SCUTTLE_LADDER_RUNGS; i++) {
    solids.push({
      kind: 'box',
      centre: v3(
        FORE_SCUTTLE_X,
        foot + rise * (i + 1) - FORE_SCUTTLE_RUNG_THICKNESS / 2,
        zMid,
      ),
      half: v3(
        FORE_SCUTTLE_LADDER_HALF_BREADTH,
        FORE_SCUTTLE_RUNG_THICKNESS / 2,
        FORE_SCUTTLE_RUNG_DEPTH / 2,
      ),
      material: 'timber',
      collides: false,
    });
  }

  // The two stiles, carried from the sole to the deckhead the ladder passes
  // through. They stop at the planking rather than standing proud of it: a
  // scuttle ladder is let into the coaming, and a stile poking up through the
  // deck is a thing to trip on that no vessel has.
  for (const side of [1, -1]) {
    const head = foreScuttleLadderHeadY();
    solids.push({
      kind: 'box',
      centre: v3(
        FORE_SCUTTLE_X + side * FORE_SCUTTLE_LADDER_HALF_BREADTH,
        (foot + head) / 2,
        zMid,
      ),
      half: v3(0.03, (head - foot) / 2, 0.04),
      material: 'timber',
      collides: false,
    });
  }

  return {
    name: 'foreScuttleLadder',
    kind: 'foreScuttleLadder',
    solids,
    // The rungs are not one flat top, so there is no single panel to declare.
    // They are published individually, and conditionally, through
    // `FORE_SCUTTLE_LADDER_PANELS`.
    standable: null,
  };
}

/**
 * The rungs as surfaces a body stands on.
 *
 * **`deckObstacles.ts` publishes these only while the lid is up.** The hold's
 * ladder learned that one the hard way: with the boards laid, a surface query
 * that knew about the rungs but not about their lid let a body climb straight
 * through the closed timber.
 *
 * Unlike the hold's, these carry no ceiling of their own — a body in this shaft
 * has open sky over it, which is the whole difference between a scuttle and a
 * hatchway between two decks.
 */
export const FORE_SCUTTLE_LADDER_PANELS: readonly StandablePanel[] = Array.from(
  { length: FORE_SCUTTLE_LADDER_RUNGS },
  (_, i) => ({
    x0: FORE_SCUTTLE_X - FORE_SCUTTLE_LADDER_CLIMB_HALF_BREADTH,
    x1: FORE_SCUTTLE_X + FORE_SCUTTLE_LADDER_CLIMB_HALF_BREADTH,
    // The top foothold carries a short transfer zone to the after edge of the
    // opening. Holding forward against the ladder otherwise walks the body out
    // of the 0.32 m acquisition band a fraction of a second before its feet can
    // reach the deck, at which point the only remaining surface is the sole two
    // metres below. It is a climb envelope, not extra visible timber.
    z0:
      i === FORE_SCUTTLE_LADDER_RUNGS - 1
        ? FORE_SCUTTLE_Z - FORE_SCUTTLE_HALF_BREADTH
        : FORE_SCUTTLE_LADDER_Z_AFT,
    z1: FORE_SCUTTLE_LADDER_Z_FORWARD,
    y: foreScuttleLadderFootY() + foreScuttleLadderRise() * (i + 1),
  }),
);

/**
 * The underside of the shut scuttle — the forecastle's ceiling, across the hole.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Because the deckhead is cut for the scuttle **permanently**, and the thing
 * that closes it is a fitting standing on the weather deck. Everything up there
 * — the coaming's four inner faces, the lid's underside — is an exterior
 * material with full sky visibility, since `bakeFittingPortalLight` encloses
 * only what is *below* the planking and none of this is. So with the hatch
 * shut, the forecastle was looking straight up at sunlit oak through a hole in
 * its own ceiling: the §15.5 item-5 family, and the visible remainder of Ash's
 * *"the forecastle should not be lit by the hatch opening if the hatch is
 * closed"* once the light channel itself was gated.
 *
 * Probed from inside the dark room at midday it read as `fitting:timber` at
 * vessel (−1.30, 4.075, 2.625) — the coaming's after piece, seen from below.
 *
 * A soffit is the honest object rather than a patch. **With the cover on, the
 * underside of the cover is the ceiling**, and a ceiling belongs to the room:
 * drawn in the interior region, baked enclosed, lit by the forecastle's own
 * portals like every other square metre of deckhead. It also occludes the whole
 * shaft, so nothing above it has to be reasoned about again.
 *
 * Shut only. Lid up, it is gone and the room looks up a daylit shaft at the
 * sky, which is the entire point of cutting the scuttle.
 */
export function foreScuttleSoffit(): InteriorFitting {
  const space = belowDecksSpace('forecastle');
  // A little proud of the opening it covers, so there is no hairline of sky
  // between the panel and the carlings that frame the hole.
  const half = FORE_SCUTTLE_HALF_BREADTH + SOFFIT_LAP;

  // **Sized to fill the shaft, not set to one height.** Two goes at this were
  // both too thin, and the second failure is the instructive one.
  //
  // The deckhead follows the deck, and the deck falls 0.090 m across this
  // footprint — the same number that decided the coaming above. A flat panel at
  // the *centre's* height therefore sits below the ceiling at one end, and the
  // end it sits below is a slot you can see the sunlit coaming through: the
  // fault this panel exists to close, reintroduced one storey down.
  //
  // Spanning the deckhead's own range fixed that and left a subtler one. Probed
  // from the dark room, a ray still reached `fitting:scuttleLid:shut` at vessel
  // (−1.186, 4.149, 2.721) — because a shallow enough sight line **grazes the
  // panel's top corner**, passing under the deckhead forward of the opening and
  // over the soffit by about two millimetres, and then rises into the shaft
  // beyond it. A plug that stops inside the hole can always be got past by some
  // angle.
  //
  // So it is carried from the lowest deckhead all the way to the highest
  // *walking surface*: the panel fills the deck's whole thickness across the
  // opening, and there is no line at all from the room into the shaft. The lid
  // above hides its top, and with the lid up the panel is not drawn.
  let lowest = Infinity;
  let highest = -Infinity;
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = FORE_SCUTTLE_X - half + (2 * half * i) / steps;
      const z = FORE_SCUTTLE_Z - half + (2 * half * j) / steps;
      const under = spaceDeckheadY(space, x, z);
      if (under !== null) lowest = Math.min(lowest, under);
      const over = deckStandAt(x, z);
      if (over) highest = Math.max(highest, over.y);
    }
  }
  if (!Number.isFinite(lowest) || !Number.isFinite(highest)) {
    throw new Error('the fore scuttle has no deck over it');
  }

  const thickness = highest - lowest;
  return {
    name: 'foreScuttleSoffit',
    kind: 'foreScuttleSoffit',
    solids: [
      {
        kind: 'box',
        centre: v3(FORE_SCUTTLE_X, lowest + thickness / 2, FORE_SCUTTLE_Z),
        half: v3(half, thickness / 2, half),
        material: 'timber',
        collides: false,
      },
    ],
    standable: null,
  };
}

/** How far the panel laps past the opening onto the carlings that frame it. */
const SOFFIT_LAP = 0.03;


/**
 * The captain's quarters, less the desk.
 *
 * One list, built once, read by `interiorFittingsNow` and by `INTERIOR_FITTINGS`
 * both — because every one of these pieces is fixed joinery with no second
 * state, and a piece that appears in one of those lists and not the other is
 * either drawn and not collided with or collided with and not drawn. That is the
 * fault every list in this file exists to make impossible, and it gets harder to
 * spot by eye with each thing added to the room.
 */
const CABIN_FURNITURE: readonly InteriorFitting[] = [
  sternLockerPort(),
  sternLockerStarboard(),
  boxBerth(),
  washstand(),
  hangingLocker(),
  captainSeaChest(),
  cabinTellTaleCompass(),
  cabinBarometer(),
  bookShelf(),
];

/**
 * The wardroom's and the forecastle's furniture, on the cabin's own terms.
 *
 * Built once and read by both lists, for the reason `CABIN_FURNITURE` gives.
 * They live in their own modules for the reason `captainsDesk.ts` does — a room
 * with a mess table, two officers' cabins and a run of chests in it is a
 * module's worth of decisions, and a module that has to be listed here cannot
 * import from here.
 */
const WARDROOM_FURNITURE: readonly InteriorFitting[] = wardroomFurniture();
const FORECASTLE_FURNITURE: readonly InteriorFitting[] = forecastleFurniture();

/** Everything standing in a room below decks, in the state she is in. */
export function interiorFittingsNow(): InteriorFitting[] {
  return [
    pumpTube(),
    pumpWell(),
    foreScuttleLadder(),
    chartDesk(),
    chartRack(),
    cabinBarometer(),
    deskChair(isStationOccupied('deskChair')),
    boxBerthCurtain(isClosureOpen('captainsBerthCurtain')),
    {
      name: 'deskItems',
      kind: 'deskItems',
      solids: deskItems().flatMap((item) => item.solids),
      standable: null,
    },
    ...CABIN_FURNITURE,
    ...WARDROOM_FURNITURE,
    ...FORECASTLE_FURNITURE,
    hatchwayBoards(isClosureOpen('hatchwayBoards')),
    ...(isClosureOpen('foreScuttleLid') ? [] : [foreScuttleSoffit()]),
  ];
}

/**
 * The fittings whose shape never changes.
 *
 * `DECK_OBSTACLES` is built once at module load and the collider has to be a
 * constant for the same reason the geometry is — so this is the list the
 * obstacle index reads. The boards are deliberately absent: they are never a
 * collider in either state, which `INTERIOR_FITTING_KINDS.hatchwayBoards`
 * states and `ship-interior.test.ts` checks, so nothing is lost by their not
 * being here and a stale collider is avoided by their not being here.
 */
export const INTERIOR_FITTINGS: readonly InteriorFitting[] = [
  pumpTube(),
  pumpWell(),
  // The ladder's shape never changes — only whether its rungs are *usable*, and
  // that is a floor question `schoonerStandAt` asks, not a collider question.
  // So it belongs here, and its solids are all `collides: false`.
  foreScuttleLadder(),
  // The desk and the rack over it. Fixed joinery: neither has a second state,
  // so both are drawn once and the desk's standing panels are in the obstacle
  // index from module load like everything else here.
  //
  // **The chair is deliberately absent, and not for the boards' reason.** The
  // boards are out because they never collide in either state; the chair never
  // collides either — but it also *changes shape*, so a constant list is the
  // wrong home for it twice over. It is drawn from `interiorFittingsNow()` and
  // by `buildDeskChairGeometry`, one mesh per state with one visible.
  chartDesk(),
  chartRack(),
  cabinBarometer(),
  // What is lying on the desk. Its shape never changes and it never collides,
  // so it belongs here with the fixed joinery rather than in a state pair —
  // an item that is *open* is open in a DOM overlay, not in the world.
  {
    name: 'deskItems',
    kind: 'deskItems',
    solids: deskItems().flatMap((item) => item.solids),
    standable: null,
  },
  // The rest of the captain's quarters. Same list the live enumeration reads,
  // and deliberately the same objects rather than a second call: the berth's
  // geometry is cached and the bookshelf is placed off it, so two constructions
  // would be two chances for the shelf to hang over a bed that had moved.
  ...CABIN_FURNITURE,
  // The wardroom and the forecastle, on the same terms. Nothing in either room
  // has a second state: a table is a table and a berth is made.
  ...WARDROOM_FURNITURE,
  ...FORECASTLE_FURNITURE,
];

const INTERIOR_FITTING_PANELS: readonly StandablePanel[] = INTERIOR_FITTINGS.map(
  (fitting) => fitting.standable,
).filter((panel): panel is StandablePanel => panel !== null);

/**
 * The top of a fitting a body standing below decks is on, or `null`.
 *
 * Highest rather than first, for the reason `fittingStandAt` gives: two panels
 * that overlap are a mistake, and answering the lower of them is a mistake that
 * hides inside a working room.
 *
 * **It does not carry a ceiling.** A fitting stands in a room and the room's own
 * deckhead is still what is overhead — `deckObstacles.schoonerStandAt` pairs
 * this with the surface it found, rather than letting a fitting invent a
 * headroom of its own.
 */
export function interiorFittingStandAt(x: number, z: number): number | null {
  let best: number | null = null;
  for (const panel of INTERIOR_FITTING_PANELS) {
    if (x < panel.x0 || x > panel.x1) continue;
    if (z < panel.z0 || z > panel.z1) continue;
    if (best === null || panel.y > best) best = panel.y;
  }
  return best;
}

/**
 * The half-width of the room at the pump, for the plan's drawing tool and for
 * anyone asking whether the pump is where the plan says it is.
 */
export function pumpRoomHalfWidth(): number {
  return spaceHalfWidthAt(pumpSpace(), PUMP_Z);
}
