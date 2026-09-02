/**
 * Where the body is, when it is not on its feet.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A ROW IN `closures.ts`
 * --------------------------------------------------------
 * Architecturally they are the same thing — a fact held in module state that
 * the geometry, the collider and the player's prompt all read from one copy —
 * and the temptation to add `deskChair` to `ClosureName` and be done was real.
 *
 * It is wrong for a reason that shows up immediately downstream.
 * `shipInteractables.ts` **derives the interactable list from
 * `SHIP_CLOSURES`**, and every closure's contract is that it *opens and shuts*:
 * a verb pair, two target boxes, a lid that a floor query has to know about. A
 * chair has none of that. It would have arrived in the world as a hatch that
 * says "Open the chair", with a `targets(open)` nobody could write honestly, and
 * the first person to add a second seat aboard would have found the closure
 * table full of furniture.
 *
 * So: the same shape, deliberately not the same table. `closures.ts`'s own note
 * explains why module state is the honest home for a boolean the pure geometry
 * functions have to consult, and every word of it applies here. The rule it
 * sets is the one that keeps this file trivial: **nothing here is geometry and
 * nothing here is a dimension.** Where a station puts the eye is
 * `shipStations.ts`, and this module has never heard of it.
 *
 * WHY IT IS A NAME AND NOT A BOOLEAN ANY MORE
 * -------------------------------------------
 * It was `let seated = false`, and one chair is the only arrangement that
 * survives. The ship now has ten places a body puts itself — the chart desk's
 * chair, two forms at the mess table, a sea chest in the forecastle and six
 * berths — and a boolean per place would be ten booleans that can all be true
 * at once, which is a body in six beds.
 *
 * **One name, or nothing.** A body is in at most one station, so the state is
 * the station's name, and "am I seated" is a question you answer by asking
 * which. It also means the drawn chair reads `isStationOccupied('deskChair')`
 * rather than a boolean that would have had to mean "seated *somewhere*" the
 * moment the second seat existed.
 *
 * **The names live here and the descriptions live in `shipStations.ts`**, which
 * is exactly the split `closures.ts` and `shipClosures.ts` already use and for
 * the same reason: this file has no imports at all, and that is load-bearing —
 * the loft, the walker and the player's own seat controller all read it, and
 * any import would put one of them in a cycle.
 */

export type StationName =
  | 'deskChair'
  | 'wardroomFormPort'
  | 'wardroomFormStarboard'
  | 'crewChestPort'
  | 'captainsBerth'
  | 'surgeonsBerth'
  | 'matesBerth'
  | 'crewBerthPortLower'
  | 'crewBerthPortUpper'
  | 'crewBerthStarboardLower'
  | 'crewBerthStarboardUpper'
  // M5. A gang of shrouds is a place a body puts itself and does not walk out
  // of, which is the whole of what this list means — see `shipStations.ts` for
  // why a climb is a station whose pose moves rather than a machine of its own.
  | 'climbPort'
  | 'climbStarboard';

let occupied: StationName | null = null;

/** Which station the body is in, or `null` for on its feet. */
export function occupiedStation(): StationName | null {
  return occupied;
}

export function setOccupiedStation(name: StationName | null): void {
  occupied = name;
}

/** Is this particular station the one the body is in? */
export function isStationOccupied(name: StationName): boolean {
  return occupied === name;
}

/** Back to how she starts. For tests, and for a fresh voyage. */
export function resetSeat(): void {
  occupied = null;
}
