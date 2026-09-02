import type { InteractableBox } from '../../player/Interactables';
import type { SeatPose } from '../../player/SeatedStation';
import { boxBerthPose, boxBerthTarget } from './cabinFurniture';
import { captainsSeatPose, deskChairGazeTarget, deskChairTarget } from './captainsDesk';
import type { SpaceName } from './deckInterior';
import {
  crewBerthPose,
  crewBerthTarget,
  crewChestPose,
  crewChestTarget,
} from './forecastleFurniture';
import { climbProgress, isAtTheFoot, isLayingDown } from './aloftState';
import { climbPose, shroudTarget } from './riggingClimb';
import type { StationName } from './seatState';
import { climbGazeTargets, climbReachVolume } from './climbInteraction';
import { roomInteractionVolume } from './interactionSpaces';
import { isClosureOpen } from './closures';
import {
  officersBerthPose,
  officersBerthTarget,
  officersBerthWithin,
  wardroomFormPose,
  wardroomFormTarget,
  wardroomFormWithin,
} from './wardroomFurniture';

/**
 * Every place aboard a body puts itself, described once, for every system that
 * has to care.
 *
 * WHY A TABLE, AND WHY IT IS THIS TABLE AND NOT THE CLOSURES'
 * -----------------------------------------------------------
 * `shipClosures.ts` sets out the argument in full and it applies here word for
 * word: **the variation is not in the seats, it is in the systems that read
 * them.** Three do, and each has one rule it applies to every row:
 *
 * | system | its one rule |
 * | --- | --- |
 * | `shipInteractables` | offer the verb where a body can take the station |
 * | `SeatedStation` (via `main.ts`) | write the eye while it is taken |
 * | `seatState.ts` | hold one name, and reset it |
 *
 * What it is *not* is a second closure table. A closure opens and shuts, has
 * two sides and a floor query behind it; a seat has one side, no barrier, and a
 * pose. `seatState.ts`'s own note is the long version, and the short one is
 * that a chair in `SHIP_CLOSURES` would have arrived in the world as a hatch
 * saying "Open the chair".
 *
 * WHAT MADE THE DESK'S ONE CHAIR INTO A TABLE
 * -------------------------------------------
 * Nothing but arithmetic. `shipInteractables` carried the chair as a hand-typed
 * row with its accessor, its verb, its target and its room written inline, and
 * that was the right shape for one seat. There are eleven now. Two of the four
 * fields differ per row and the other two are the same sentence eleven times,
 * which is the shape that lets the tenth seat be added for the player's hands
 * and not for the drawn furniture, silently.
 *
 * WHAT A ROW OWES
 * ---------------
 * - **A pose whose heading is converted, not only its position.** Every piece
 *   below except the mess forms lies along a curving ship's side at its own
 *   yaw. `captainsDesk` records what half a conversion looks like: position
 *   only and the sitter faces the lining at a slight angle; heading only and he
 *   sits square to a room he is not aimed at. `seatedBody.facingYaw` is the one
 *   place the four quarter-turns are written down.
 * - **A target you can point at.** See `wardroomFormTarget` for why these are
 *   the furniture itself rather than the floor in front of it, and why the
 *   captain's chair is the exception.
 * - **A `within` that names a wall, not a distance.** `REACH` is 2.2 m on a
 *   15.5 m vessel and this ship has already learnt twice what that costs: a
 *   body in the landing could sit in the captain's chair through a bulkhead,
 *   and a body on the wardroom's centreline can reach the surgeon's berth
 *   through his partition. Every row here has one.
 */

export type StationKind = 'seat' | 'berth' | 'climb';

/**
 * Where a station is, for the diagnostics and the handover's table.
 *
 * Eleven rows are below decks and answer with one of the four rooms. The two
 * added at M5 are on the weather deck, which is not a room and has no
 * `BelowDecksSpace` — so the word is added rather than the fore shrouds being
 * filed under the forecastle, which is a *different place two metres below the
 * planking* and would have made the diagnostics lie.
 */
export type StationRoom = SpaceName | 'weatherDeck';

export interface ShipStation {
  readonly name: StationName;
  /**
   * What sort of place it is.
   *
   * Three now, and each split earns itself: a seat and a berth differ in the
   * verb, in the pose builder and in what a future round would hang on them.
   * It is also the seam described in `SHIP_INTERIOR_HANDOVER.md` §22 — if a
   * time-skip ever attaches to lying down, `kind === 'berth'` is the predicate
   * it attaches to, and nothing here has to be re-sorted for it.
   *
   * **`'climb'` is the one that is not furniture**, and M5's note below says
   * what it does and does not share with the other two.
   */
  readonly kind: StationKind;
  /** The room it is in — for the diagnostics and for the handover's table. */
  readonly room: StationRoom;
  /** What the player is told they can do, in the state the body is in now. */
  verb(occupied: boolean): string;
  /** Where a hand points to take it. */
  target(): InteractableBox;
  /** Additional valid gaze geometry, when the affordance has more than one face. */
  interactionTargets?(): readonly InteractableBox[];
  /** Where the body has to be standing for it to be offered at all. */
  within(): InteractableBox;
  /** Where the eye goes, and how far it may turn, once it is taken. */
  pose(): SeatPose;
}

/**
 * A room, as the volume a body has to be in to use what is in it.
 *
 * Generous athwartships and vertically on purpose — the rooms below decks are
 * divided fore-and-aft by bulkheads and by nothing else, so the station range
 * is the whole of what this is for. Moved here from `shipInteractables.ts`,
 * where the chair was its only caller.
 */
export function roomVolume(name: SpaceName): InteractableBox {
  return roomInteractionVolume(name);
}

/**
 * Getting up, whatever you are getting up from.
 *
 * One verb for eleven rows because it is one action: the body was held and now
 * it is not. The *taking* verbs differ because they describe eleven different
 * things — a chart desk is not a bunk — but "Stand up" and "Turn out" are the
 * same sentence in two registers, and a player who has just lain down does not
 * need to be told which register the ship is in.
 */
const RISE = 'Stand up';

function seat(
  name: StationName,
  room: StationRoom,
  taking: string,
  parts: Omit<ShipStation, 'name' | 'kind' | 'room' | 'verb'>,
): ShipStation {
  return {
    name,
    kind: 'seat',
    room,
    verb: (occupied) => (occupied ? RISE : taking),
    ...parts,
  };
}

function berth(
  name: StationName,
  room: StationRoom,
  taking: string,
  parts: Omit<ShipStation, 'name' | 'kind' | 'room' | 'verb'>,
): ShipStation {
  return {
    name,
    kind: 'berth',
    room,
    // "Turn in" and "turn out" are what a seaman does to his bunk, and they are
    // deliberately not "Sleep": nothing below decks makes time pass, and a verb
    // that promised it would be a promise the world cannot keep. §22 of the
    // handover records that as a seam rather than a gap.
    verb: (occupied) => (occupied ? 'Turn out' : taking),
    ...parts,
  };
}

export const SHIP_STATIONS: readonly ShipStation[] = [
  seat('deskChair', 'cabin', 'Sit at the chart desk', {
    target: () => deskChairTarget(),
    interactionTargets: () => [deskChairGazeTarget()],
    // The whole cabin, unlike every other row: this target is the clear *floor*
    // in front of the desk rather than the chair, so the room is the only thing
    // that can fence it. `deskChairTarget` carries why it is the floor.
    within: () => roomVolume('cabin'),
    pose: () => captainsSeatPose(),
  }),
  seat('wardroomFormPort', 'wardroom', 'Sit at the mess table', {
    target: () => wardroomFormTarget('port'),
    within: () => wardroomFormWithin('port'),
    pose: () => wardroomFormPose('port'),
  }),
  seat('wardroomFormStarboard', 'wardroom', 'Sit at the mess table', {
    target: () => wardroomFormTarget('starboard'),
    within: () => wardroomFormWithin('starboard'),
    pose: () => wardroomFormPose('starboard'),
  }),
  seat('crewChestPort', 'forecastle', 'Sit on the chest', {
    target: () => crewChestTarget('port'),
    within: () => roomVolume('forecastle'),
    pose: () => crewChestPose('port'),
  }),
  berth('captainsBerth', 'cabin', 'Turn in', {
    target: () => boxBerthTarget(),
    // A closed privacy curtain is a real visual screen, not decoration the
    // picker reaches through. Draw it back before selecting the berth behind.
    interactionTargets: () =>
      isClosureOpen('captainsBerthCurtain') ? [boxBerthTarget()] : [],
    // The landing is 1.2 m from the head of this berth through a bulkhead, and
    // `REACH` does not know the bulkhead is there. Same guard, same wall, same
    // room as the chair's.
    within: () => roomVolume('cabin'),
    pose: () => boxBerthPose(),
  }),
  berth('surgeonsBerth', 'wardroom', 'Turn in', {
    target: () => officersBerthTarget('starboard'),
    within: () => officersBerthWithin('starboard'),
    pose: () => officersBerthPose('starboard'),
  }),
  berth('matesBerth', 'wardroom', 'Turn in', {
    target: () => officersBerthTarget('port'),
    within: () => officersBerthWithin('port'),
    pose: () => officersBerthPose('port'),
  }),
  berth('crewBerthPortLower', 'forecastle', 'Turn in to the lower berth', {
    target: () => crewBerthTarget('port', 0),
    within: () => roomVolume('forecastle'),
    pose: () => crewBerthPose('port', 0),
  }),
  berth('crewBerthPortUpper', 'forecastle', 'Turn in to the upper berth', {
    target: () => crewBerthTarget('port', 1),
    within: () => roomVolume('forecastle'),
    pose: () => crewBerthPose('port', 1),
  }),
  berth('crewBerthStarboardLower', 'forecastle', 'Turn in to the lower berth', {
    target: () => crewBerthTarget('starboard', 0),
    within: () => roomVolume('forecastle'),
    pose: () => crewBerthPose('starboard', 0),
  }),
  berth('crewBerthStarboardUpper', 'forecastle', 'Turn in to the upper berth', {
    target: () => crewBerthTarget('starboard', 1),
    within: () => roomVolume('forecastle'),
    pose: () => crewBerthPose('starboard', 1),
  }),
  climb('climbPort', 1),
  climb('climbStarboard', -1),
];

/**
 * A gang of shrouds, as a place a body puts itself.
 *
 * WHY THE CLIMB IS A ROW HERE AND NOT A MACHINE OF ITS OWN
 * ---------------------------------------------------------
 * Because everything this table exists to answer, it answers for a climb
 * unchanged. `shipInteractables` offers the verb where a body can take it;
 * `SeatedStation` writes the eye while it is taken; `seatState.ts` holds one
 * name and resets it. A climb needs all three and nothing else — it is entered
 * by pointing at a thing, it holds the body where it stood, it owns the eye
 * until it lets go, and a body can only be in one of them.
 *
 * **The one thing it adds is that its pose moves**, and `SeatedStation` already
 * copes with that without a line changing: `step` asks `pose()` every frame and,
 * once the settle is over, writes the eye to it exactly. A moving pose was never
 * ruled out; nothing had needed one. So the alternative — a second controller
 * beside `SeatedStation` with its own hold, its own settle, its own eye write
 * and its own way of getting the walker back — would have been a parallel copy
 * of a working thing to express "the pose is a function of a number".
 *
 * WHAT DOES NOT FIT, STATED RATHER THAN PAPERED OVER
 * --------------------------------------------------
 * Two things, both small and both deliberate.
 *
 * - **The number itself has nowhere on this row to live.** A station is
 *   described by pure functions and holds no state; where on the ladder the body
 *   is changes sixty times a second. It lives in `aloftState.ts`, which is the
 *   same split `closures.ts`/`shipClosures.ts` and `seatState.ts`/this file
 *   already use, so it is a precedent rather than an exception.
 * - **`SeatPose`'s cone is declined rather than used.** Every other row clamps
 *   the head and `SeatPose.yawRange` calls the width "the whole design". A
 *   lookout's job is to look everywhere. `riggingClimb.climbPose` argues it.
 */
function climb(name: StationName, side: 1 | -1): ShipStation {
  return {
    name,
    kind: 'climb',
    room: 'weatherDeck',
    // Three verbs from one row, because the state a climb is in is a height and
    // not a boolean. Going aloft, coming down the last foot of it, and starting
    // down from the masthead are three different things to be told.
    verb: (occupied) => {
      if (!occupied) return 'Go aloft';
      if (isAtTheFoot(side)) return 'Step down on deck';
      return isLayingDown() ? 'Hold on' : 'Lay down on deck';
    },
    target: () => shroudTarget(side),
    // Looking at the lower mast from the gang's foot expresses the same intent
    // as looking at the shrouds themselves. This is selection geometry only;
    // walking entry below still requires moving outboard into the ropes.
    interactionTargets: () => climbGazeTargets(side),
    within: () => climbReachVolume(side),
    pose: () => climbPose(side, climbProgress()),
  };
}

/** One station by name. Throws rather than silently doing nothing. */
export function shipStation(name: StationName): ShipStation {
  const found = SHIP_STATIONS.find((station) => station.name === name);
  if (!found) throw new Error(`no station described for ${name}`);
  return found;
}
