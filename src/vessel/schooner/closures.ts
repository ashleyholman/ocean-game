/**
 * The state of the things aboard that open and shut.
 *
 * WHY THIS IS MODULE STATE, WHICH IS OTHERWISE NOT HOW THIS PROJECT WORKS
 * ----------------------------------------------------------------------
 * Everything else describing the ship is a pure function of her tables:
 * `deckStandAt`, `interiorSurfacesAt`, `schoonerStandAt`. That is deliberate and
 * it is most of why the geometry and the collider cannot drift apart.
 *
 * A hatch that opens breaks it, and the break is real rather than a failure of
 * imagination. `DeckWalker` takes a `DeckEnvironment` whose whole interface is
 * `standAt(x, z, reachY)` — no state, by design, because the walker is also
 * driven by the reachability tests and by the debug panel, and a floor that
 * depended on who was asking would prove nothing. Threading a world-state
 * argument through it changes a signature that four call sites implement and
 * two suites drive, to carry one boolean.
 *
 * So the boolean lives here, in the smallest module that can hold it, with an
 * explicit reset. The rule that keeps it honest: **nothing here is geometry and
 * nothing here is a dimension.** This module knows only whether a closure is
 * open. Where the boards are, how thick they are and what the sole does when
 * they come up are all still pure functions elsewhere that happen to ask.
 *
 * `resetClosures()` exists because a test that opens a hatch and a test that
 * expects it shut are otherwise ordered by luck.
 */

/**
 * Every closure aboard that can be worked by hand.
 *
 * **The names live here and the descriptions live in `shipClosures.ts`**, and
 * the split is what keeps this module importable by anything. This file has no
 * imports at all — that is the property that lets the walker, the loft and the
 * renderer all read the state without a cycle — so it cannot be the one that
 * knows where a lid is or what it is made of.
 */
export type ClosureName =
  | 'hatchwayBoards'
  | 'foreScuttleLid'
  | 'sternDeadlights'
  | 'captainsBerthCurtain';

export const CLOSURE_NAMES: readonly ClosureName[] = [
  'hatchwayBoards',
  'foreScuttleLid',
  'sternDeadlights',
  'captainsBerthCurtain',
];

/**
 * How each closure starts. **The only copy of this fact.**
 *
 * `ShipClosure` used to carry an `initiallyOpen` beside its verb and its
 * targets, and nothing ever read it: this record is what `resetClosures` and a
 * fresh voyage actually use. Two sources for one fact, one of them dead, and
 * the third closure is what would have made them disagree — the deadlights are
 * the first thing aboard that does *not* start shut, so a round that set the
 * ornamental copy and left this one would have shipped a cabin that begins the
 * voyage dark. The dead field is gone; this is the fact.
 *
 * The two hatches start shut. A ship at sea has her hatches on, and the boards
 * over the platform's hatchway are the wardroom's floor — a room whose floor
 * starts with a hole in it is a room somebody fell through before they had
 * touched anything. The fore scuttle's lid is shut for the same reason and one
 * more: shut, it is a 0.20 m step-over on the starboard gangway, and open it is
 * a hole in it.
 *
 * **The deadlights start OPEN, which is to say unshipped**, and the polarity is
 * worth reading twice. A closure is named for the opening it fills, so `open`
 * here means the stern lights are open to the sea and the sky and the shutters
 * are stowed in the lockers under them. A voyage that opened with the
 * deadlights in would be a captain's cabin with four boards over its windows in
 * fair weather, which is not a ship at sea — it is a ship expecting to be
 * pooped.
 */
const INITIAL: Record<ClosureName, boolean> = {
  hatchwayBoards: false,
  foreScuttleLid: false,
  sternDeadlights: true,
  // Drawn back so the made berth is visible on a fresh voyage.
  captainsBerthCurtain: true,
};

const state: Record<ClosureName, boolean> = { ...INITIAL };

export function isClosureOpen(name: ClosureName): boolean {
  return state[name];
}

export function setClosureOpen(name: ClosureName, open: boolean): void {
  state[name] = open;
}

/** Flip one, and report what it became. */
export function toggleClosure(name: ClosureName): boolean {
  state[name] = !state[name];
  return state[name];
}

/** Back to how she starts. For tests, and for a fresh voyage. */
export function resetClosures(): void {
  for (const name of CLOSURE_NAMES) state[name] = INITIAL[name];
}
