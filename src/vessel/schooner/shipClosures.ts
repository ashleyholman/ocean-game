import type { InteractableBox } from '../../player/Interactables';
import type { ClosureName } from './closures';
import type { StandablePanel } from './deckFittings';
import type { InteractionSpaceName } from './interactionSpaces';
import {
  FORE_SCUTTLE_COAMING_HEIGHT,
  foreScuttleCoamingTopY,
  foreScuttleLidBox,
  foreScuttleLidPanel,
} from './deckFittings';
import { inForeScuttle } from './deckSurface';
import {
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  STERN_WINDOWS,
  belowDecksSpace,
  interiorSurfacesAt,
  onHatchwayBoards,
  sternWindowZAt,
} from './deckInterior';
import {
  FORE_SCUTTLE_LADDER_PANELS,
  hatchwayBoardsBox,
} from './interiorFittings';
import { HOLD_LADDER_PANELS, HOLD_SOLE_Y } from './holdStow';
import { FORE_SCUTTLE_X, FORE_SCUTTLE_Z } from './hullForm';
import { boxBerthCurtainTarget } from './cabinFurniture';

/**
 * Every closure aboard, described once, for every system that has to care.
 *
 * WHY A TABLE OF DESCRIPTIONS AND NOT A CLASS PER HATCH
 * -----------------------------------------------------
 * Ash asked the right question — *"seems like there'll be some common
 * properties for doors and hatches"* — and the answer this codebase wants is
 * not polymorphism, for a reason that is about the shape of the problem rather
 * than about the language.
 *
 * **The variation is not in the closures. It is in the systems that read
 * them.** Four of them do, and each has a rule it applies to *every* closure:
 *
 * | system | its one rule |
 * | --- | --- |
 * | `deckObstacles.schoonerStandAt` | shut is floor, open is a hole with footholds |
 * | `Schooner.syncClosures` | draw the state the ship is actually in |
 * | `Schooner.publishPortalLight` | a shut closure's daylight channel publishes nothing |
 * | `shipInteractables` | offer the verb, from every side it can be worked |
 * | `closures.ts` | hold one boolean, and reset it |
 *
 * Five now. The light rule was always there — the hold's boards and the fore
 * scuttle's lid each gate a channel — and it went unlisted because it was
 * written twice inside one method rather than once against the table. The
 * deadlights are the third and the first whose *only* rule it is.
 *
 * A class per hatch inverts that. It would put four systems' logic inside each
 * closure — `ForeScuttle.standAt`, `ForeScuttle.syncMeshes`,
 * `ForeScuttle.pick` — so the walker's rule about floors would be written once
 * per hatch, in four places, and the fifth hatch would get it subtly wrong. It
 * is the same failure this ship keeps finding under a different name: **two
 * sources for one fact**, except the fact here is a *rule* rather than a
 * dimension.
 *
 * The table inverts it back. Each closure states what it *is* — where its
 * barrier lies, what a body stands on, where the footholds are, which meshes
 * belong to which state — and each system iterates the table applying its own
 * rule once. Adding a cabin door means adding a row, and the walker, the
 * renderer and the prompt pick it up without being edited. That is the same
 * device `DECK_OPENINGS`, `OBSTACLE_SOURCES`, `FITTING_KINDS` and
 * `INTERIOR_FITTING_KINDS` already use, and it is why adding the fore scuttle
 * to `DECK_OPENINGS` got the loft, the cutout, the deckhead and the culling for
 * nothing.
 *
 * The parts that genuinely differ per closure are the small pure functions in
 * each row — a lid panel here, a stack of boards there — and those are exactly
 * the parts that *should* differ. Behaviour that varies goes in a function;
 * rules that do not vary stay with the system that owns them.
 *
 * WHAT A ROW OWES THE WALKER
 * --------------------------
 * The invariant Ash asked for, in one sentence: **shut, a closure is floor from
 * above and ceiling from below; open, it is a hole with footholds through it.**
 * `schoonerStandAt` enforces that for every row, so a new hatch cannot be
 * added that you fall through when it is shut or climb through when it is not.
 */

/** Which floor a barrier is cut into — the surface withdrawn while it is open. */
export type BarrierLevel =
  | { readonly kind: 'deck' }
  | { readonly kind: 'sole'; readonly y: number };

export interface ClosureBarrier {
  readonly level: BarrierLevel;
  /** Is this plan position inside the opening the closure fills? */
  covers(x: number, z: number): boolean;
  /**
   * The surface a body crosses on while it is SHUT, above its own floor — or
   * `null` when the closure lies flush and its floor already answers.
   *
   * The scuttle's lid sits on a 0.16 m coaming and is a real step; the
   * hatchway's boards are the wardroom's sole and are not.
   */
  shutSurface(): StandablePanel | null;
  /** Footholds through the opening, usable only while it is open. */
  footholds(): readonly StandablePanel[];
  /** What a body on those footholds has over its head. */
  footholdCeiling(x: number, z: number): number;
  /** Whether a compact ladder holds horizontal input until each rung is reached. */
  readonly climbLocked?: boolean;
}

export interface ShipClosure {
  readonly name: ClosureName;
  /** What the player is told they can do next, in the state it is in now. */
  verb(open: boolean): string;
  /**
   * Where a hand can reach it, one target per side it is worked from.
   *
   * **Plural, because a hatch has two sides.** A player standing on the ladder
   * with their head in the scuttle is as entitled to shut it as one standing on
   * the deck, and the first cut of this offered the action from above only —
   * which meant climbing down and then discovering you could not close up
   * behind you.
   */
  targets(open: boolean): readonly ShipClosureTarget[];
  /** How it behaves underfoot, or `null` for a closure nobody walks through. */
  readonly barrier: ClosureBarrier | null;
}

/** A closure face and the storey on which a body may work that face. */
export interface ShipClosureTarget {
  readonly box: InteractableBox;
  readonly from: InteractionSpaceName;
}

/**
 * The ceiling over a point in the cargo hatchway's shaft — the deck two floors
 * up rather than the floor the body is climbing through.
 *
 * Lived in `deckObstacles.ts` while the walker was the only thing that asked.
 * It is a property of the *closure* — what a body on these particular rungs has
 * over its head — so it belongs in the row that describes them.
 */
function holdShaftCeilingAt(x: number, z: number): number {
  let highest = HOLD_SOLE_Y;
  for (const surface of interiorSurfacesAt(x, z)) {
    highest = Math.max(highest, surface.ceilingY);
  }
  return highest;
}

/** The scuttle's own hole, in plan. `deckSurface` owns where that is. */
function foreScuttleCovers(x: number, z: number): boolean {
  return inForeScuttle(x, z);
}

/**
 * The volume under the scuttle a hand can work it from.
 *
 * From the head of the ladder up: a body on the top rungs has its head in the
 * hatchway, and that is the position you shut it from on the way down.
 */
function foreScuttleUnderBox(): InteractableBox {
  const half = 0.45;
  const top = foreScuttleCoamingTopY() - FORE_SCUTTLE_COAMING_HEIGHT;
  return {
    xLo: FORE_SCUTTLE_X - half,
    xHi: FORE_SCUTTLE_X + half,
    // The target is the underside of the closure, not the whole shaft a body
    // occupies while approaching it. `reachableFrom` now owns that latter
    // question. Keeping those two meanings in one tall box put a forecastle
    // eye *inside* the target, where proximity could compete with explicit
    // gaze and an eye at its exact centre could not select it at all.
    yLo: top - UNDERSIDE_TARGET_DEPTH,
    yHi: top + TARGET_FACE_LAP,
    // **Clamped to the forecastle's own after bulkhead, and it was not.**
    // The scuttle stands 0.39 m forward of that bulkhead, so `FORE_SCUTTLE_Z −
    // 0.45` put 0.06 m of this box on the *wardroom* side of it — and `REACH`
    // is 2.2 m from the eye, so a body standing anywhere in the surgeon's
    // cabin was within a metre of it. Measured: from (−1.5, 1.4), looking
    // forward, the offer was "Open the scuttle", through a bulkhead, from
    // another room, on the other side of a partition as well.
    //
    // A `within` cannot fix this one. The scuttle is worked from the forecastle
    // *and* from the open deck, and the deck is not a room — so the guard has
    // to be on the box, which is the honest place for it anyway: what this
    // volume means is "under the hatch", and under the hatch stops at the wall.
    zLo: Math.max(FORE_SCUTTLE_Z - half, belowDecksSpace('forecastle').zAft),
    zHi: FORE_SCUTTLE_Z + half,
  };
}

/**
 * How far inboard of the glass a hand reaches to ship or unship a deadlight.
 *
 * The four lights sit in a wall that leans aft at 18°, so their sills are at
 * z −8.18 and their heads at −8.36 — a board across one is 0.18 m of station
 * deep before anything is added for the hand working it. Half a metre forward
 * of the sill puts the box's forward face at −7.68, which is 0.12 m abaft the
 * cabin's own after edge: a body cannot stand in it, so the deadlights are
 * aimed at and never occupied.
 */
const DEADLIGHT_REACH = 0.50;

/**
 * The volume in front of the stern lights, from inside the cabin.
 *
 * **One box for four shutters, because they are one closure.** They are shipped
 * as a set when it comes on to blow — that is what the word means — and the
 * light model has one channel for all four panes, so a per-window state would
 * be four booleans the daylight could not tell apart. `interiorLight.ts`'s
 * `CHANNEL_WINDOWS` is the constraint, and it is the honest one: four rows here
 * would be four verbs offering a distinction the room cannot show.
 */
function sternDeadlightBox(): InteractableBox {
  let xLo = Infinity;
  let xHi = -Infinity;
  let yLo = Infinity;
  let yHi = -Infinity;
  let zLo = Infinity;
  for (const window of STERN_WINDOWS) {
    xLo = Math.min(xLo, window.x - window.halfWidth);
    xHi = Math.max(xHi, window.x + window.halfWidth);
    yLo = Math.min(yLo, window.y - window.halfHeight);
    yHi = Math.max(yHi, window.y + window.halfHeight);
    // The head is the aftmost point of a raked opening, so the box's after face
    // is taken there and not at the sill.
    zLo = Math.min(zLo, sternWindowZAt(window.y + window.halfHeight));
  }
  const zSill = Math.max(...STERN_WINDOWS.map((w) => sternWindowZAt(w.y - w.halfHeight)));
  return {
    // A hand's breadth outboard of the outer lights and under their sills: what
    // is being worked is a board over an opening, not the pane in the middle.
    xLo: xLo - 0.12,
    xHi: xHi + 0.12,
    yLo: yLo - 0.12,
    yHi: yHi + 0.12,
    zLo: zLo - 0.04,
    zHi: zSill + DEADLIGHT_REACH,
  };
}

/** The volume under the hatchway boards — the hold side, at the ladder's head. */
function hatchwayUnderBox(): InteractableBox {
  return {
    xLo: -HATCHWAY_HALF_BREADTH,
    xHi: HATCHWAY_HALF_BREADTH,
    // A thin face at the boards/opening. The hold reach volume describes the
    // ladder-side approach; making this target span that volume leaves the eye
    // inside it and turns occupancy back into selection.
    yLo: HOLD_SOLE_Y - UNDERSIDE_TARGET_DEPTH,
    yHi: HOLD_SOLE_Y + TARGET_FACE_LAP,
    zLo: HATCHWAY_AFT_Z,
    zHi: HATCHWAY_FORWARD_Z,
  };
}

/** Forgiving depth behind the underside a player actually points at. */
const UNDERSIDE_TARGET_DEPTH = 0.14;

/** Tiny overlap through the closure plane, avoiding a numerical crack. */
const TARGET_FACE_LAP = 0.02;

export const SHIP_CLOSURES: readonly ShipClosure[] = [
  {
    name: 'hatchwayBoards',
    // A seaman lays boards and lifts them; he does not "open" a hatchway.
    verb: (open) => (open ? 'Lay the boards' : 'Lift the boards'),
    targets: (open) => [
      { box: hatchwayBoardsBox(open), from: 'wardroom' },
      { box: hatchwayUnderBox(), from: 'hold' },
    ],
    barrier: {
      level: { kind: 'sole', y: belowDecksSpace('wardroom').soleY },
      covers: (x, z) => onHatchwayBoards(x, z),
      // Laid, they *are* the sole and the sole already answers there. Nothing
      // extra to stand on — which is the difference between a flush closure and
      // one on a coaming, and is why this returns null rather than a panel at
      // the same height that two systems would then both believe in.
      shutSurface: () => null,
      footholds: () => HOLD_LADDER_PANELS,
      // A body on these rungs is inside a shaft between two decks, so what is
      // over its head is the wardroom's deckhead — not the sky.
      footholdCeiling: (x, z) => holdShaftCeilingAt(x, z),
    },
  },
  {
    name: 'foreScuttleLid',
    // This one really is opened and shut: a single hinged lid, not a stack of
    // loose boards. The boards earned their verb by genuinely not being a door.
    // Each face names its own reachable storey below. That is the semantic deck
    // occlusion the old picker lacked: the lid may be worked from the weather
    // deck and its underside from the forecastle, never through the planking
    // from a vertically adjacent room.
    verb: (open) => (open ? 'Shut the scuttle' : 'Open the scuttle'),
    targets: (open) => [
      { box: foreScuttleLidBox(open), from: 'weatherDeck' },
      { box: foreScuttleUnderBox(), from: 'forecastle' },
    ],
    barrier: {
      level: { kind: 'deck' },
      covers: foreScuttleCovers,
      shutSurface: () => foreScuttleLidPanel(),
      footholds: () => FORE_SCUTTLE_LADDER_PANELS,
      // Open sky. That is the whole difference between a scuttle out of a room
      // and a hatchway between two decks, and it is why the walker stands up as
      // it climbs out of the forecastle and stays ducked climbing out of the
      // hold.
      footholdCeiling: () => Infinity,
      // The 0.75 m scuttle is crossed horizontally much faster than its nearly
      // vertical ladder can raise a body. Hold each acquired rung before
      // applying continued forward movement so climbing out cannot become a
      // run straight through the shaft and back down into the room.
      climbLocked: true,
    },
  },
  {
    name: 'sternDeadlights',
    // A seaman *ships* a deadlight and *unships* it — it is a loose board that
    // goes into a rabbet, not a door on hinges. The boards over the hatchway
    // earned their own verb the same way, by genuinely not being a door.
    verb: (open) => (open ? 'Ship the deadlights' : 'Unship the deadlights'),
    targets: () => [{ box: sternDeadlightBox(), from: 'cabin' }],
    /**
     * **No barrier, and it is the first closure aboard without one.**
     *
     * The field has been nullable since the pattern was written and nothing has
     * ever used the null until now, which makes this worth saying plainly: a
     * barrier is what a closure does *underfoot*, and the invariant the table
     * guarantees — shut is floor, open is a hole with footholds — is a sentence
     * about a hole in a deck. These are shutters on a wall. Nobody walks
     * through a stern light, in either state, and `schoonerStandAt` skips any
     * row that says so.
     *
     * What they gate instead is light, and that is a rule of the vessel's own
     * (`Schooner.publishPortalLight`) rather than of the floor's: shipped, the
     * cabin's window channel publishes nothing at all, exactly as the hold's
     * boards already do for theirs.
     */
    barrier: null,
  },
  {
    name: 'captainsBerthCurtain',
    // Open means drawn back at the foot, matching every other closure's
    // polarity: the opening into the berth is unobstructed.
    verb: (open) => (open ? 'Draw the berth curtain' : 'Draw back the berth curtain'),
    targets: (open) => [{ box: boxBerthCurtainTarget(open), from: 'cabin' }],
    // A privacy curtain changes sight, not the floor under a body.
    barrier: null,
  },
];

/** One closure by name. Throws rather than silently doing nothing. */
export function shipClosure(name: ClosureName): ShipClosure {
  const found = SHIP_CLOSURES.find((closure) => closure.name === name);
  if (!found) throw new Error(`no closure described for ${name}`);
  return found;
}
