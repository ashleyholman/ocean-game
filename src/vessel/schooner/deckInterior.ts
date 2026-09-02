import {
  companionOpening,
  DECK_OPENINGS,
  CABIN_AFT_Z,
  DESIGN_DRAUGHT,
  CABIN_FORWARD_Z,
  CABIN_SOLE_Y,
  CARGO_HATCH_HALF_BREADTH,
  CARGO_HATCH_HALF_LENGTH,
  CARGO_HATCH_Z,
  COMPANION_AFT_Z,
  COMPANION_FORWARD_Z,
  DECK_BEAM_DEPTH,
  DECK_PLANK_THICKNESS,
  FORECASTLE_FORWARD_Z,
  FORECASTLE_SOLE_Y,
  PLATFORM_AFT_Z,
  PLATFORM_FORWARD_Z,
  PLATFORM_SOLE_Y,
  COUNTER_SHEAR_START_Z,
  counterStationZ,
  deckAtSideY,
  halfBreadthAt,
  transomPlacedZ,
} from './hullForm';
import {
  BREAK_TOLERANCE,
  deckOverheadAt,
  deckStandAt,
  inCompanionway,
  inForeScuttle,
  openingXLimits,
} from './deckSurface';
import { RUDDER_STOCK_Z } from './deckFittings';

/**
 * Below decks: five spaces on three floors, and the ways between them.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHAT IT BREAKS
 * ----------------------------------------------
 * `deckSurface.ts` answers exactly one height for any (x, z), and `deckObstacles`
 * composes the walker's floor as "the highest surface that admits the query
 * wins". That rule carried the whole of M3 because every surface M3 added was
 * *higher* than the deck: a hatch lid, a grating, a tread. **A sole is lower than
 * the deck above it, and "highest wins" cannot answer it** — it would put a body
 * standing in the cabin on the quarterdeck, through two metres of timber.
 *
 * So the contract is relaxed here, in the smallest way that is still true: a
 * query carries the height the body can *reach*, and the floor is the highest
 * surface at or below that. `deckObstacles.ts` does the composing, for the same
 * dependency reason it already composes the fittings — this module has to ask
 * the deck how high it is, so the deck must not know about this module.
 *
 * A FLOOR IS NOW HALF AN ANSWER
 * -----------------------------
 * Outdoors a walking surface needs no ceiling: the sky is not a thing you hit.
 * Below decks it is the *defining* dimension of the room — `docs/ship/SHIP_SPEC.md`
 * section 6 calls the headroom the hardest dimensional problem in the brief and
 * makes it an input to the hull form rather than a check applied afterward. So
 * every surface answers with the underside of whatever is overhead, and open sky
 * is `Infinity` rather than a special case, so nothing downstream has to ask
 * which kind of surface it is holding.
 *
 * WHAT THE ROOMS ARE MEASURED AGAINST
 * -----------------------------------
 * The deck as it is *drawn*, through `deckOverheadAt`, and not through a second
 * expression for the same surface. `hullForm.cabinHeadroomAt` was such a second
 * expression: it built the camber from `maxHalfBeamAt`, the hull's widest
 * half-breadth at a station, while the deck is actually lofted over
 * `deckHalfWidth`, the inboard face of the bulwark at the walking level. Those
 * differ by about a quarter of a metre of beam, so the claimed headroom ran
 * 9–16 mm above the drawn one all the way along the cabin.
 *
 * FROM ONE ROOM TO FIVE
 * ---------------------
 * M4's structural slice knew one room, and every expression in this file said
 * "cabin" and closed over `CABIN_SOLE_Y`. `docs/ship/SHIP_BELOW_DECKS_PLAN.md`
 * put a floor over the hold and gave the middle and the bow of the ship rooms
 * too, on two further floor heights, so the *height* is now an argument
 * everywhere and `BELOW_DECKS_SPACES` is the one place that says which room is
 * at which. The cabin's own functions are kept as the specialisations they now
 * are, because the hydrostatics test measures that room by name.
 *
 * COORDINATES
 * -----------
 * Ship-local, as `hullForm.ts` defines them, and **placed** z throughout: this
 * file is queried by a body, and a body knows only where it is. The bulkheads
 * are therefore vertical planes at fixed placed stations rather than parameter
 * stations — which is what a bulkhead is. Only the hull's own half-breadth needs
 * the station, and it inverts the rake at the floor's height to get it.
 */

/**
 * How far inside the deck edge a sole stops, metres.
 *
 * A room is bounded by the deck that roofs it (see `roomRoofHalfWidthAt`), and
 * that boundary is the inboard face of the bulwark — a line on the *weather*
 * deck. Below it there is a frame, a spirketting strake and the ceiling planking
 * between the body and the shell. This is that thickness, and it is the only
 * reason a sole is not flush to its own ceiling's edge.
 */
export const CABIN_LINING_THICKNESS = 0.06;

/**
 * How far into a room the deck overhead is sampled at a bulkhead, metres.
 *
 * **A bulkhead can stand under a deck break, and at a break the deck belongs to
 * both levels.** `PLATFORM_AFT_Z` is `QUARTERDECK_FORWARD_Z` — deliberately, see
 * `hullForm.ts` — so a query for the wardroom's ceiling taken exactly at its
 * after bulkhead gets the quarterdeck, 0.55 m higher than the waist deck that
 * roofs every other point in the room. Drawn, that is a ceiling with a step in
 * it one station wide; measured, it is a headroom figure 0.55 m too generous at
 * exactly the place someone would go to check it.
 *
 * So the ceiling over a room is asked on the room's own side of its ends. Ten
 * millimetres, because `deckSurface.BREAK_TOLERANCE` is one and a break admits
 * queries a millimetre either side of itself on purpose.
 */
const ROOF_SAMPLE_INSET = 0.01;

/** The rooms below decks, aft to forward. */
export type SpaceName = 'cabin' | 'landing' | 'wardroom' | 'forecastle';

export interface BelowDecksSpace {
  readonly name: SpaceName;
  /** Aft and forward bulkheads, placed z — where the *sole* runs to. */
  readonly zAft: number;
  readonly zForward: number;
  /** Height of the sole above the baseline. */
  readonly soleY: number;
  /** What the room is, for the debug panel and for anyone reading the list. */
  readonly title: string;
}


/**
 * The arrangement, aft to forward.
 *
 * `docs/ship/SHIP_BELOW_DECKS_PLAN.md` section 4 is the agreed plan and the
 * argument for every bound in it. The peak, forward of `FORECASTLE_FORWARD_Z`,
 * is not here: it is the sail room and boatswain's store, it is stowed solid to
 * the deck, and a space with no floor is not a space a body stands in.
 *
 * Adjacent rooms **share** a bulkhead station, and every function here admits a
 * query at both ends. That is deliberate: at the −2.4 bulkhead the landing's
 * 2.45 sole and the wardroom's 1.80 are both under the query, and which one a
 * body is on depends on the body. `deckObstacles.schoonerStandAt` chooses, the
 * same way it chooses between the deck and a sole.
 */
export const BELOW_DECKS_SPACES: readonly BelowDecksSpace[] = [
  {
    name: 'cabin',
    zAft: CABIN_AFT_Z,
    zForward: CABIN_FORWARD_Z,
    soleY: CABIN_SOLE_Y,
    title: "the captain's cabin",
  },
  {
    name: 'landing',
    zAft: CABIN_FORWARD_Z,
    zForward: PLATFORM_AFT_Z,
    soleY: CABIN_SOLE_Y,
    title: 'the pantry, the ladder and the spirit locker',
  },
  {
    name: 'wardroom',
    zAft: PLATFORM_AFT_Z,
    zForward: PLATFORM_FORWARD_Z,
    soleY: PLATFORM_SOLE_Y,
    title: 'the wardroom, on the platform deck',
  },
  {
    name: 'forecastle',
    zAft: PLATFORM_FORWARD_Z,
    zForward: FORECASTLE_FORWARD_Z,
    soleY: FORECASTLE_SOLE_Y,
    title: 'the forecastle — galley and four berths',
  },
];

/** The space of a given name. Throws rather than returning a wrong room. */
export function belowDecksSpace(name: SpaceName): BelowDecksSpace {
  const found = BELOW_DECKS_SPACES.find((space) => space.name === name);
  if (!found) throw new Error(`no below-decks space named ${name}`);
  return found;
}

/** Every space a placed station falls in — two at a shared bulkhead. */
export function spacesAt(z: number): BelowDecksSpace[] {
  return BELOW_DECKS_SPACES.filter((space) => z >= space.zAft && z <= space.zForward);
}

/** The station the deck overhead is sampled at, for a query inside `space`. */
function roofStationZ(space: BelowDecksSpace, z: number): number {
  const lo = space.zAft + ROOF_SAMPLE_INSET;
  const hi = space.zForward - ROOF_SAMPLE_INSET;
  return Math.min(Math.max(z, lo), hi);
}

/**
 * Half-width of a room at its *deckhead* — where the ship's side meets the deck
 * overhead.
 *
 * **The deck's own edge, and nothing else.** M4 took this as the *smaller* of
 * the deck's half-width and the hull's half-breadth at the sole, which is right
 * in the cabin — where the deck is narrower, because maximum beam is at y = 2.62
 * and the topsides tumble home above it — and wrong wherever it is not. The
 * forecastle is where it stops being right: at z = +6.2 the hull is 0.91 m at
 * the sole against a deck 1.32 m wide, so a deckhead lofted to the sole's width
 * would leave 0.41 m of unroofed slot each side, and **an open-ended surface
 * reads as transparency rather than as a hole** — the same 60 mm leak M4 found
 * round the cabin, six times the size. The hull belongs in the *sole's* width
 * and in the wall between them, which is where it now is.
 */
export function roofHalfWidthAt(z: number): number {
  const over = deckOverheadAt(0, z);
  if (!over) return 0;
  if (z >= COUNTER_SHEAR_START_Z) return over.halfWidth;
  // **Abaft the shear the deck's aft edge is a curve in (x, z), not a station.**
  // A point 1.2 m off the centreline at the same placed z belongs to a station
  // further aft than one on the centreline does, because the camber lowers it
  // and the rake carries a lower point less far — and the counter is narrower
  // there. So the centreline's own half-width is an over-estimate of how wide
  // the deck is *at this placed z*, by 0.1 m at the cabin's after end.
  //
  // M4 papered over this with `over ? over.y : CABIN_SOLE_Y + 2` fallbacks in
  // the loft, which was harmless while the cabin stopped 1.2 m short of the
  // transom. Run the room aft to the transom and it is the corner of the room
  // hanging outboard of any deck at all. Bisect instead: the widest x that
  // still has deck over it.
  let lo = 0;
  let hi = over.halfWidth;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) * 0.5;
    if (deckOverheadAt(mid, z)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Half-width of the inside of the shell at a placed point, before the lining.
 *
 * Below the sheer this is the moulded hull, asked at the station the point's own
 * height maps to — the counter's rake carries a point at the sole 49 mm aft at
 * the transom, and one at the deckhead 0.75 m. Above the sheer the deck is
 * inside the bulwark and the deck's own edge is the bound, which also stops this
 * falling to zero in the 0.55 m of quarterdeck that stands above the sheer line.
 */
export function shellHalfWidthAt(z: number, y: number): number {
  const roof = roofHalfWidthAt(z);
  if (roof <= 0) return 0;
  const station = counterStationZ(z, y);
  if (Number.isNaN(station)) return 0;
  const shell = y <= deckAtSideY(station) ? halfBreadthAt(station, y) : roof;
  return Math.max(Math.min(roof, shell), 0);
}

/** Half-width of a floor laid at `soleY`: the shell there, less the lining. */
export function roomHalfWidthAt(z: number, soleY: number): number {
  return Math.max(shellHalfWidthAt(z, soleY) - CABIN_LINING_THICKNESS, 0);
}

/** Half-width of a named space's deckhead at `z`, or 0 outside it. */
export function spaceRoofHalfWidthAt(space: BelowDecksSpace, z: number): number {
  if (z < space.zAft || z > space.zForward) return 0;
  return roofHalfWidthAt(roofStationZ(space, z));
}

/** Half-width of a named space's sole at `z`, or 0 outside it. */
export function spaceHalfWidthAt(space: BelowDecksSpace, z: number): number {
  if (z < space.zAft || z > space.zForward) return 0;
  return roomHalfWidthAt(roofStationZ(space, z), space.soleY);
}

/**
 * Half-width of a room's side at height `y` — the ship's side, lined.
 *
 * The wall is not a straight lean from the sole to the deck edge: forward, where
 * the sections are closing toward the stem, the hull curves 0.8 m inboard over
 * the height of the forecastle, and a chord across that is 0.4 m of wall
 * standing in mid-air. It is the M4 chord leak again — the fix there was to
 * sample the loft's own stations, and the fix here is to sample the loft's own
 * *heights*.
 *
 * The top row is the deck edge exactly, without the lining, because that is
 * where the deckhead's edge is and the two have to be one x by construction.
 */
export function spaceSideHalfWidthAt(
  space: BelowDecksSpace,
  z: number,
  y: number,
  atDeckhead: boolean,
): number {
  if (atDeckhead) return spaceRoofHalfWidthAt(space, z);
  return Math.max(shellHalfWidthAt(roofStationZ(space, z), y) - CABIN_LINING_THICKNESS, 0);
}

/**
 * Underside of the deck beams over a point in `space`.
 *
 * The height a head actually meets: the planking is 0.05 m and the beams hang
 * 0.13 m below it, and a room is measured under a beam.
 */
export function spaceDeckheadY(space: BelowDecksSpace, x: number, z: number): number | null {
  const over = deckOverheadAt(x, roofStationZ(space, z));
  return over ? over.y - DECK_BEAM_DEPTH : null;
}

/** Underside of the deck *planking* over a point — where a bulkhead's top lands. */
export function spacePlankingY(space: BelowDecksSpace, x: number, z: number): number | null {
  const over = deckOverheadAt(x, roofStationZ(space, z));
  return over ? over.y - DECK_PLANK_THICKNESS : null;
}

/** Clear height under the beams at a point in `space`, metres. */
export function spaceClearHeightAt(space: BelowDecksSpace, x: number, z: number): number | null {
  const head = spaceDeckheadY(space, x, z);
  return head === null ? null : head - space.soleY;
}

/** Usable sole area of one space, m². */
export function spaceSoleArea(space: BelowDecksSpace): number {
  const steps = 256;
  const span = space.zForward - space.zAft;
  let area = 0;
  for (let i = 0; i < steps; i++) {
    area += 2 * spaceHalfWidthAt(space, space.zAft + (span * (i + 0.5)) / steps) * (span / steps);
  }
  return area;
}

/** Every walkable square metre below decks. */
export function belowDecksSoleArea(): number {
  return BELOW_DECKS_SPACES.reduce((sum, space) => sum + spaceSoleArea(space), 0);
}

// --- the captain's cabin, by name --------------------------------------------

/**
 * The cabin's own expressions.
 *
 * Kept because `ship-hydrostatics.test.ts` asserts section 6's 1.85 m of clear
 * standing height *in that room*, and a bound is worth naming the room it binds.
 */
const CABIN = belowDecksSpace('cabin');

export function cabinRoofHalfWidthAt(z: number): number {
  return spaceRoofHalfWidthAt(CABIN, z);
}

export function cabinHalfWidthAt(z: number): number {
  return spaceHalfWidthAt(CABIN, z);
}

export function cabinClearHeightAt(x: number, z: number): number | null {
  return spaceClearHeightAt(CABIN, x, z);
}

/**
 * Clear standing height on the centreline of the captain's cabin at `z`.
 *
 * The constraint `docs/ship/SHIP_SPEC.md` section 6 calls the hardest
 * dimensional problem in the brief, and an *input* to the hull form rather than
 * a check applied to it: the sheer line, the deck camber and the quarterdeck
 * rise were all chosen partly to satisfy it. A hull faired without it comes out
 * 50 mm short and the fix at that point is a new hull.
 */
export function cabinHeadroomAt(z: number): number {
  return cabinClearHeightAt(0, z) ?? 0;
}

export function cabinSoleArea(): number {
  return spaceSoleArea(CABIN);
}

// --- the companion ladder ----------------------------------------------------

/**
 * Risers in the flight, counting the last step *onto the deck*.
 *
 * **Five now, and the reason it is not seven is that the flight got shorter.**
 * It used to fall 2.012 m from the quarterdeck and seven risers of 0.287 was
 * the only count the walker's 0.32 m step-up allowed. Heading it at the break
 * takes `QUARTERDECK_RISE` off the top: the drop is 1.44 m, and five risers put
 * each at 0.289 — within a millimetre of what the old flight used, because that
 * dimension was never the problem.
 *
 * The drawn treads are one fewer, for the reason `DECK_STAIRS` gives: a tread
 * level with the deck standing against the deck is not a step, it is a plank
 * with a seam in it.
 */
export const COMPANION_RISERS = 5;

/**
 * Drawn treads in the flight.
 *
 * **All of them.** It used to be one fewer, because the last riser was the step
 * onto the deck and a tread level with the deck is a plank with a seam in it.
 * The flight now tops out at the head ledge rather than at the planking, and
 * that top tread is a real step: the deck stands 0.16 m above it. See
 * `flightLedgeY`.
 */
export const COMPANION_TREADS = COMPANION_RISERS;

/** Thickness of each closed tread board in the drawn companion flight. */
export const COMPANION_TREAD_THICKNESS = 0.055;

/**
 * Clear sole between the flight's foot and the after coaming, metres.
 *
 * THE NUMBER THAT MADE THE COMPANIONWAY WALKABLE, AND WHY IT IS NOT A TASTE
 * ------------------------------------------------------------------------
 * The flight first ran the full length of the opening, foot hard against the
 * after coaming, and the walker got stuck on the third tread down. The reason is
 * a geometry the deck round never had to think about:
 *
 * > A body descending a ladder has its head above the deck until its feet are
 * > within one riser of the bottom.
 *
 * The body stands 1.75 m and the coaming rises 0.50 m from the deck, so the
 * coaming is a solid in the body's own height band for the entire descent bar
 * the last step — and a solid is something the walker keeps a body's radius
 * away from. Foot against the coaming, the lowest treads were inside that
 * radius and simply could not be reached; the body stopped on the tread above
 * and stayed there, grounded, with nothing reporting a fault.
 *
 * So the flight stops a radius short and the body steps *down* off it onto open
 * sole, by which point its head is below the deck and the coaming has dropped
 * out of its band. 0.45 is the 0.26 m body radius with enough margin that a
 * body which drifted off the centreline still finds the floor.
 *
 * **This is the M3 finding again, in a place it had not been looked for:** a
 * clearance rule has to be measured at the height the thing actually is. The
 * coaming reads as a kerb around a hole, and a kerb is a thing you are beside;
 * for the two seconds you are on the ladder it is a thing at your ear.
 *
 * It used also to be what made the ladder steep. The opening was 1.15 m, this
 * took 0.45 of it, and six treads shared the 0.70 that was left — 0.117 m
 * apiece, which put the flight at 71°: the top of a ship's ladder's 60–70°
 * range, and deliberately so, because Ash's report on the 54° version was that
 * it read as a domestic stair.
 *
 * **That trade is gone rather than rebalanced.** The opening is 1.30 m and the
 * drop is 0.57 m less, so the four treads share 0.85 m — 0.213 m apiece, a
 * ~60° flight — *and* this keeps its full 0.45. Both dimensions improved
 * because the flight stopped starting one deck too high, which is worth
 * recording: the steepness was never a taste problem to be tuned, it was the
 * quarterdeck's rise being paid for twice.
 */
export const COMPANION_LANDING_DEPTH = 0.45;

/**
 * Which way the flight runs, and why it is not the quarterdeck ladder's way.
 *
 * The **head is forward**, at `COMPANION_FORWARD_Z`, and the flight descends
 * *aft* to its foot. Both ends were decided by what is at them rather than by
 * convention:
 *
 * - The foot lands on the landing with the cabin door 0.6 m aft of it, so you
 *   come down facing the room you are going to. Run the other way and the foot
 *   lands against the wardroom's bulkhead with your back to the cabin.
 * - **The head is the break itself** — `COMPANION_FORWARD_Z` is
 *   `QUARTERDECK_FORWARD_Z` — so a body walking aft along the waist steps off
 *   the deck it is already on. Nothing is cut in the waist: the hole is in the
 *   quarterdeck's forward edge, and everything abaft the first riser is under
 *   the quarterdeck and dry.
 *
 * **The coaming is open forward because the ladder's head is**, and that is the
 * one thing here a seaman would argue with — more so now than before, because
 * the waist is the lowest part of the weather deck and green water runs to it.
 * The period answer is not geometry: a companion hood over the head, drop
 * boards in grooves and a sliding cover, all of which are furnishing and none
 * of which move a number in this file. Ash has the call and the place is left
 * for it. If the orientation is ever reversed it is these two constants and
 * nothing else — the flight, the coaming, the loft and the light all read them.
 */
export const FLIGHT_HEAD_Z = COMPANION_FORWARD_Z;
export const FLIGHT_FOOT_Z = COMPANION_AFT_Z + COMPANION_LANDING_DEPTH;

/**
 * How far forward of the break the head's height is sampled.
 *
 * **Twice `BREAK_TOLERANCE`, and it has to be derived from it rather than
 * chosen.** `deckStandAt` deliberately admits a query within a millimetre of a
 * break to *both* levels and answers the higher, so that a walker on the line
 * gets the deck it can stand on. Sampling the head one tolerance forward of the
 * break therefore still answers the quarterdeck — and the whole point of the
 * move is that this flight starts from the waist, 0.55 m lower.
 *
 * That is exactly what happened: the first build of this used 1e-3 and the
 * flight silently kept its old 2.01 m drop, which showed up as **0.40 m
 * risers** — a ladder no body can climb — and not as anything about the break.
 * The number that was wrong and the symptom were two files apart.
 */
const FLIGHT_HEAD_INSET = 2 * BREAK_TOLERANCE;

/**
 * Is a position on the flight rather than on the landing beside it?
 *
 * The flight does not fill the opening, so "in the companionway" and "on the
 * ladder" are not the same question — asking the wrong one puts a tread on the
 * landing, which is exactly the surface the body has to be able to step *down*
 * onto.
 */
export function companionXLimits(z: number): { xLo: number; xHi: number } {
  return openingXLimits(companionOpening(), z);
}

/** Middle of the opening across the beam at a station. */
export function companionMidX(z: number): number {
  const { xLo, xHi } = companionXLimits(z);
  return (xLo + xHi) * 0.5;
}

export function onCompanionFlight(x: number, z: number): boolean {
  if (z < FLIGHT_FOOT_Z || z > FLIGHT_HEAD_Z) return false;
  const { xLo, xHi } = companionXLimits(z);
  return x >= xLo && x <= xHi;
}

/**
 * Height of the flight's head on the beam line through `x` — the quarterdeck.
 *
 * Through `x`, because the deck is crowned and a flight whose treads are flat
 * planes meets it along exactly one line. M3 found this the hard way on the
 * quarterdeck ladder: every tread was perfectly horizontal and the flight read
 * as built crooked, because horizontal was the fault. The foot is the sole,
 * which *is* flat — a sole is laid level — so the treads interpolate from a
 * level plane to a cambered one and meet the deck exactly at every x.
 */
function flightHeadY(x: number): number {
  const z = FLIGHT_HEAD_Z + FLIGHT_HEAD_INSET;
  const head = deckStandAt(x, z);
  // The head runs from 0.63 out to the ship's side in the waist, so there is
  // always deck there. Falling back to the opening's own middle rather than
  // throwing keeps a query at the very edge from being a different kind of
  // answer than one a millimetre inboard.
  return head ? head.y : deckStandAt(companionMidX(z), z)!.y;
}

/**
 * The head ledge: the underside of the waist deck at the break, through `x`.
 *
 * **The top tread stands on this, not one riser below the deck**, and the
 * difference is a fault Ash reported as "a dark bar across the opening at the
 * top of the stairs, blocking you from exiting — invisible from the other
 * side".
 *
 * The flight used to divide the whole drop from the waist deck into equal
 * risers, which put its top tread 0.29 m below the deck. The wardroom bulkhead
 * standing on the same plane reaches that deck's *underside* at 3.72, so it
 * finished 0.13 m proud of the tread: an upstand across the full width of the
 * way out, drawn on one face and therefore invisible from the deck side. Cut
 * the timber back to the tread instead and the 0.13 m became a letterbox into
 * the wardroom's ceiling — the same fault turned inside out, which is how it
 * was chased round three times.
 *
 * There is no arrangement of a wall and a tread at different heights that is
 * not one or the other. So they are the same height: the flight starts at the
 * deck's underside and the step down from the planking onto it is the head
 * ledge, which is what a hatchway has and what a body steps over going in.
 */
export function flightLedgeY(x: number): number {
  const wardroom = belowDecksSpace('wardroom');
  const ledge = spaceDeckheadY(wardroom, x, PLATFORM_AFT_Z);
  return ledge ?? flightHeadY(x);
}

/**
 * Top surface of tread `index` on the beam line through `x`; 1 is the lowest.
 *
 * `COMPANION_RISERS` of them from the sole to the ledge. The step from the
 * waist deck down onto the top tread is over and above these — see
 * `flightLedgeY` — and is 0.16 m, well inside the walker's stride.
 */
export function companionTreadY(index: number, x: number): number {
  return CABIN_SOLE_Y + (flightLedgeY(x) - CABIN_SOLE_Y) * (index / COMPANION_RISERS);
}

/**
 * Aft and forward limits of tread `index`.
 *
 * **Tread 1 is the aftmost**, at the foot, because the flight climbs forward.
 * This is the inverse of `companionTreadIndexAt` and the two are written as
 * inverses deliberately: M3's flight had them written separately and they
 * disagreed, so the walker climbed a correct flight while the drawn timber
 * descended the other way with its tallest step standing alone on the deck.
 */
export function companionTreadZ(index: number): { zAft: number; zForward: number } {
  const depth = (FLIGHT_HEAD_Z - FLIGHT_FOOT_Z) / COMPANION_TREADS;
  return {
    zAft: FLIGHT_FOOT_Z + depth * (index - 1),
    zForward: FLIGHT_FOOT_Z + depth * index,
  };
}

/** Tread under a placed station: 1 at the foot, `COMPANION_TREADS` at the head. */
export function companionTreadIndexAt(z: number): number {
  const t = (z - FLIGHT_FOOT_Z) / (FLIGHT_HEAD_Z - FLIGHT_FOOT_Z);
  return Math.min(Math.max(Math.ceil(t * COMPANION_TREADS), 1), COMPANION_TREADS);
}

export const COMPANION_CHEEK_WIDTH = 0.075;
export const COMPANION_CHEEK_DEPTH = 0.13;
export const COMPANION_CHEEK_EDGE_REVEAL = 0.015;

/**
 * The two raking cheeks as lateral collision rails for the flight.
 *
 * The detailed render follows every tread and carries each cheek diagonally
 * beneath it. Collision deliberately fills down to the landing sole: what
 * matters to a vertical body is that the visible side of the ladder separates
 * the landing from the space beneath an unreachable tread. The rails remain
 * narrow in plan, so a body already on the flight slides along them and climbs
 * normally; only a side approach is refused.
 */
export function companionCheekSolids(): InteriorSolid[] {
  const out: InteriorSolid[] = [];
  for (let index = 1; index <= COMPANION_TREADS; index++) {
    const { zAft, zForward } = companionTreadZ(index);
    const zMid = (zAft + zForward) * 0.5;
    const limits = companionXLimits(zMid);
    const top = Math.max(
      companionTreadY(index, limits.xLo),
      companionTreadY(index, limits.xHi),
    );
    for (const side of ['inboard', 'outboard'] as const) {
      const edge =
        side === 'inboard'
          ? limits.xLo + COMPANION_CHEEK_EDGE_REVEAL
          : limits.xHi - COMPANION_CHEEK_EDGE_REVEAL;
      const centreX =
        edge + (side === 'inboard' ? 1 : -1) * COMPANION_CHEEK_WIDTH * 0.5;
      out.push({
        name: `companionCheek${side === 'inboard' ? 'Inboard' : 'Outboard'}${index}`,
        centre: {
          x: centreX,
          y: (CABIN_SOLE_Y + top) * 0.5,
          z: zMid,
        },
        half: {
          x: COMPANION_CHEEK_WIDTH * 0.5,
          y: (top - CABIN_SOLE_Y) * 0.5,
          z: (zForward - zAft) * 0.5,
        },
      });
    }
  }
  return out;
}

/**
 * Height the coaming stands above the quarterdeck, metres.
 *
 * **Above the walker's step-over, and that is what sets it.** A solid whose top
 * is within 0.40 m of the feet is stepped over rather than walked into — the
 * sheet horses are 0.34 m of shin-high iron the rig explicitly wants stepped
 * over — so a coaming of the usual 0.30 m would be a kerb you stride across into
 * a two-metre hole. 0.50 m blocks, and is a plausible height for a companion
 * coaming on a vessel that expects water on deck.
 */
export const COMPANION_COAMING_HEIGHT = 0.5;

/** Thickness of the coaming timber, metres. */
export const COMPANION_COAMING_THICKNESS = 0.08;

// --- the steps between the floors --------------------------------------------

/**
 * A change of floor level at a bulkhead.
 *
 * Three floors joined bow to stern means two of these, and they are different
 * kinds of thing rather than two sizes of one:
 *
 * - **Aft, 0.65 m** from the landing down to the wardroom. That is twice the
 *   walker's 0.32 m step-up, so it needs a flight — two drawn treads at 0.217 m,
 *   which is three risers counting the last one onto the landing.
 * - **Forward, 0.25 m** from the wardroom up to the forecastle. That is *under*
 *   the step-up, so it needs nothing: the floor simply starts higher, the way
 *   the forecastle deck's own 0.22 m break does on the weather deck. One riser,
 *   no treads. Drawing treads here would be drawing a stair a body walks past.
 *
 * WHICH SIDE OF THE BULKHEAD THE FLIGHT STANDS ON, AND WHY IT MOVED
 * -----------------------------------------------------------------
 * This datum used to say `highY`/`lowY` and hold the flight *forward* of the
 * aft bulkhead, descending away from it into the wardroom — so the doorway's
 * sill was the higher floor and you stepped down through the door. It read two
 * arrangements as the only two available, and rejected the other one (a flight
 * climbing to the bulkhead from inside the lower room) because it puts a tread
 * in the doorway where a door has to swing.
 *
 * **There is a third, and Ash found it by walking through the door.** Cut the
 * flight into the floor of the *higher* room instead, so it descends towards
 * the bulkhead and arrives at the low floor with a flat in front of the door.
 * Then the sill is the low floor and the whole 0.65 m of level change is spent
 * before you reach the opening:
 *
 * > lintel 3.713, sill 2.450 → **1.263 m** of clear door, in a room with
 * > 1.913 m of headroom on the far side of it.
 * > lintel 3.713, sill 1.800 → **1.850 m**, and the crouch is gone.
 *
 * The 1.263 was the only crouch below decks, and it existed for no reason
 * except that the steps were on the wrong side of the wall. So the datum now
 * names the floor **at the bulkhead** (`sillY` — which is what the doorway's
 * sill is) and the floor **at the far end of the run** (`farY`), and either can
 * be the higher. `farY > sillY` means the flight is cut down into the far
 * room's sole and there is a well; `farY < sillY` means it descends away into
 * a lower room and there is not.
 */
export interface InteriorSteps {
  readonly name: string;
  /** The bulkhead the run is measured from, placed z. */
  readonly zTop: number;
  /** Centre of the flight across the beam — the doorway it serves. */
  readonly x: number;
  /** Half-breadth of the flight, and of the well it is cut into. */
  readonly halfBreadth: number;
  /** Floor level *at* the bulkhead. This is the doorway's sill. */
  readonly sillY: number;
  /** Floor level at the far end of the run, in the room the flight stands in. */
  readonly farY: number;
  /** +1 if the flight runs forward from the bulkhead, −1 if aft. */
  readonly direction: 1 | -1;
  /** Risers, counting the last one onto the far floor. */
  readonly risers: number;
  /** Fore-and-aft depth of one drawn tread. */
  readonly treadDepth: number;
  /**
   * Flat at sill level between the bulkhead and the first riser, metres.
   *
   * **The companionway's `COMPANION_LANDING_DEPTH` lesson, at a doorway.** A
   * body that steps off the bottom tread straight into the opening is a body
   * whose shoulder is in the door frame while its foot is still on a riser, and
   * the frame is a solid it keeps a radius clear of. The flat is what lets it
   * arrive on level floor and *then* walk through. It is also where the door
   * swings, which is the objection that kept the flight out of the doorway in
   * the first place — now answered rather than avoided.
   */
  readonly sillRun: number;
}

/**
 * Where the doorways are across the beam, and why they are not on the centreline.
 *
 * **Both masts stand on it.** The mainmast passes through the wardroom at
 * z = −1.9, which is 0.5 m from the foot of the after steps; the foremast passes
 * through the forecastle at +4.1, 1.5 m from the forward doorway. A body of
 * 0.26 m radius keeps 0.44 m clear of a mast, so a centreline door at either
 * bulkhead opens onto a spar — and the walk found it: she crossed the wardroom,
 * was pushed round the mainmast, and could no longer find the 0.70 m flight she
 * had been walking at.
 *
 * `docs/ship/SHIP_BELOW_DECKS_PLAN.md`'s drawing had the doors off-centre and
 * this was drawn on the centreline anyway, reasoning from section 4.3's "the
 * passage crosses over the boards". The drawing was right: the passage crosses
 * the hatchway on the boards and then *dog-legs* round each mast, which is what
 * a below-decks passage on a vessel with masts through it always does.
 *
 * The cabin's own door stays amidships: the companion ladder comes down on the
 * centreline and there is nothing in the landing to walk round.
 */
export const DOORWAY_OFFSET = 0.75;

/**
 * How wide a doorway through a bulkhead is, each side of its centre.
 *
 * The body is 0.26 m in radius, so 0.35 leaves 0.09 m of clearance each side —
 * tighter than the companionway's 0.16 because a doorway is walked through on
 * the flat rather than climbed down through, and because a 0.70 m door is what
 * this ship would actually carry.
 */
export const DOORWAY_HALF_BREADTH = 0.35;

/**
 * How high a doorway is above its sill, metres.
 *
 * Capped by the deckhead wherever the room is lower than this, which in the
 * landing it very nearly is — 1.83 m of clear height against a 1.85 m door. A
 * door taller than the room it is in is a hole in the deckhead.
 */
export const DOORWAY_HEIGHT = 1.85;

/** Thickness of a joinery bulkhead, metres. */
export const BULKHEAD_THICKNESS = 0.06;

/**
 * How far off the centreline the well is cut, and why it is not `DOORWAY_OFFSET`.
 *
 * The doorway wants 0.75 — clear of the mainmast, which is what sets the two
 * other doors. The *well* has to clear something the door never had to: the
 * companion coaming, whose outboard face stands at 0.50. A well centred on 0.75
 * reaches inboard to 0.40 and fouls it by 100 mm, which is a body stopped dead
 * halfway to the wardroom.
 *
 * 0.95 puts the well's inboard edge at 0.60 with 100 mm in hand, and is still
 * 0.51 m clear of the mainmast's own keep-out. When the companionway moves off
 * the quarterdeck this constraint goes away, and this number can go back to
 * `DOORWAY_OFFSET` if the room reads better for it.
 */
export const WELL_OFFSET = 0.95;

/** Half-breadth of a flight between floors: the doorway it serves. */
export const STEPS_HALF_BREADTH = DOORWAY_HALF_BREADTH;

export const INTERIOR_STEPS: readonly InteriorSteps[] = [
  {
    name: 'wardroomWell',
    zTop: PLATFORM_AFT_Z,
    // To starboard, clear of the mainmast at z −1.9. See `WELL_OFFSET`.
    x: -WELL_OFFSET,
    halfBreadth: STEPS_HALF_BREADTH,
    // Cut down into the landing's sole, so the door's sill is the wardroom's
    // floor and the level change is spent before the opening.
    sillY: PLATFORM_SOLE_Y,
    farY: CABIN_SOLE_Y,
    direction: -1,
    risers: 3,
    treadDepth: 0.3,
    sillRun: 0.45,
  },
  {
    name: 'forecastleStep',
    zTop: PLATFORM_FORWARD_Z,
    // To port, clear of the foremast at z +4.1.
    x: DOORWAY_OFFSET,
    halfBreadth: STEPS_HALF_BREADTH,
    sillY: FORECASTLE_SOLE_Y,
    farY: PLATFORM_SOLE_Y,
    direction: -1,
    risers: 1,
    treadDepth: 0.3,
    // Descends away into the lower room: nothing is cut, so nothing to stand on
    // before the door.
    sillRun: 0,
  },
];

/** Drawn treads in a flight: one fewer than its risers. */
export function stepTreadCount(steps: InteriorSteps): number {
  return steps.risers - 1;
}

/** The lower and higher of a flight's two floors, whichever end each is at. */
export function stepsLowY(steps: InteriorSteps): number {
  return Math.min(steps.sillY, steps.farY);
}

export function stepsHighY(steps: InteriorSteps): number {
  return Math.max(steps.sillY, steps.farY);
}

/** Whole fore-and-aft reach of the flight from the bulkhead: flat plus treads. */
export function stepsRunLength(steps: InteriorSteps): number {
  return steps.sillRun + stepTreadCount(steps) * steps.treadDepth;
}

/**
 * Top surface of tread `index`; 1 is the one nearest the bulkhead.
 *
 * Counted from the bulkhead outward in both directions, which is a change from
 * the old datum's "1 is the lowest". It has to be: with the flight able to
 * stand on either side, "lowest" no longer picks an end. The last riser lands
 * on `farY` and is not drawn, exactly as before.
 */
export function stepTreadY(steps: InteriorSteps, index: number): number {
  return steps.sillY + (steps.farY - steps.sillY) * (index / steps.risers);
}

/** Limits of tread `index`, placed z, aft first. */
export function stepTreadZ(steps: InteriorSteps, index: number): { zAft: number; zForward: number } {
  // Written as the inverse of `stepTreadIndexAt` below for the reason
  // `companionTreadZ` gives — M3 shipped a flight whose walker and whose timber
  // descended in opposite directions.
  const near = steps.zTop + steps.direction * (steps.sillRun + steps.treadDepth * (index - 1));
  const far = near + steps.direction * steps.treadDepth;
  return steps.direction > 0
    ? { zAft: near, zForward: far }
    : { zAft: far, zForward: near };
}

/**
 * Tread under a placed station, or 0 if the query is off the flight.
 *
 * **The tolerance here has to be the one `inStepsWell` uses, and finding out why
 * cost a walk.** The two are read together — the well says "the room's sole is
 * not here" and this says "a tread is" — so a station either predicate admits
 * and the other refuses is a station with *no floor at all*. The body then falls
 * back to the lowest candidate, which below the quarterdeck is the quarterdeck,
 * 2.0 m over its head, and `attemptMove` refuses the step as a wall.
 *
 * The gap was **three nanometres** wide at the well's aft edge: the walker
 * arrives on 0.05 m strides at z = −3.450000003, `inStepsWell` admits it on its
 * ±1e-6, and an exact `> count * treadDepth` here did not. A body walked to the
 * lip of the stairs and stopped there with nothing reporting a fault, which is
 * the same shape as M4's sealed island at the ladder head.
 *
 * So: same epsilon at both ends, and clamp rather than reject — inside the run
 * by any margin means one of the treads, and which one is arithmetic.
 */
export function stepTreadIndexAt(steps: InteriorSteps, z: number): number {
  const count = stepTreadCount(steps);
  if (count <= 0) return 0;
  const along = (z - steps.zTop) * steps.direction - steps.sillRun;
  if (along < -1e-6 || along > count * steps.treadDepth + 1e-6) return 0;
  return Math.min(Math.max(Math.floor(along / steps.treadDepth) + 1, 1), count);
}

/** Is a position on a flight of interior steps? */
export function onInteriorSteps(steps: InteriorSteps, x: number, z: number): boolean {
  if (Math.abs(x - steps.x) > steps.halfBreadth) return false;
  return stepTreadIndexAt(steps, z) > 0;
}

/** Is a position on the flat at the sill, between the bulkhead and the treads? */
export function onStepsSillFlat(steps: InteriorSteps, x: number, z: number): boolean {
  if (steps.sillRun <= 0) return false;
  if (Math.abs(x - steps.x) > steps.halfBreadth) return false;
  const along = (z - steps.zTop) * steps.direction;
  return along >= -1e-6 && along <= steps.sillRun + 1e-6;
}

/**
 * Is a position inside the well this flight is cut into?
 *
 * Only where `farY` is the *higher* floor. A flight that descends away from its
 * bulkhead stands on the lower room's sole and cuts nothing; a flight that
 * descends *towards* it is a hole in the higher room's sole, and the sole has
 * to stop being reported there or a body walks over its own stairs.
 */
export function inStepsWell(steps: InteriorSteps, x: number, z: number): boolean {
  if (steps.farY <= steps.sillY + 1e-6) return false;
  if (Math.abs(x - steps.x) > steps.halfBreadth) return false;
  const along = (z - steps.zTop) * steps.direction;
  return along >= -1e-6 && along <= stepsRunLength(steps) + 1e-6;
}

/** The room a flight stands in — the one whose sole is at its far end. */
export function stepsRoom(steps: InteriorSteps): BelowDecksSpace | null {
  const inside = steps.zTop + steps.direction * ROOF_SAMPLE_INSET;
  return spacesAt(inside).find((space) => Math.abs(space.soleY - steps.farY) < 1e-6) ?? null;
}

// --- the platform's hatchway --------------------------------------------------

/**
 * The hatchway through the platform deck: the cargo hatch's own footprint,
 * directly under it.
 *
 * **This is not tidiness, it is the only way the loading works.** A full water
 * cask is 400–500 kg and is lowered on a whip from a stay: it has to fall down
 * one straight vertical line from the sky to the stow, through both openings at
 * once. Hatchways on successive decks were aligned for exactly this reason, with
 * pillars at the corners of the opening carrying the interrupted beams. An
 * earlier draft of the plan drew the two offset and different sizes, which was
 * the deck hatch being treated as decoration on the deck rather than as the top
 * of a route through the ship.
 *
 * The opening is **boarded flush and walked on**, the way the cargo hatch's own
 * grating already is; you lift the boards to strike stores down. So it is not a
 * hole in the walker's floor — the sole runs across it — and it is the thing
 * that decides the room: nothing can be built in this footprint at any level, so
 * the officers' cabins flank it and the passage crosses over the boards.
 *
 * Read from `hullForm.ts`, where the cargo hatch's plan now lives. It was in
 * `deckFittings.ts`, and while it stayed there the only way to agree with it
 * here was to type the same three numbers again.
 */
export const HATCHWAY_AFT_Z = CARGO_HATCH_Z - CARGO_HATCH_HALF_LENGTH;
export const HATCHWAY_FORWARD_Z = CARGO_HATCH_Z + CARGO_HATCH_HALF_LENGTH;
export const HATCHWAY_HALF_BREADTH = CARGO_HATCH_HALF_BREADTH;

/** Is a position over the platform's hatchway — on the boards? */
export function onHatchwayBoards(x: number, z: number): boolean {
  return (
    Math.abs(x) <= HATCHWAY_HALF_BREADTH &&
    z >= HATCHWAY_AFT_Z &&
    z <= HATCHWAY_FORWARD_Z
  );
}

// --- what the walker stands on ----------------------------------------------

/**
 * The head of a doorway a body is standing in, or `null` outside every one.
 *
 * **A lintel is a low ceiling, not a wall**, and getting that wrong is what
 * stopped the bow-to-stern walk the moment the deckheads were told the truth.
 * The landing's sole is 2.45 and the waist deck's beams over the wardroom are
 * 3.725, so the doorway between them is 1.263 m of clear opening — a real
 * dimension, and one a 1.75 m body gets through by ducking. Drawn as a solid
 * from the head up to the deckhead it is instead a wall with a gap under it
 * that nothing can use, and she was stopped on the top step with the room in
 * front of her.
 *
 * Expressed as a ceiling, the walker's own rules do the whole job with no new
 * concept: `crouchHeight` lets a body through anything over 1.15 m, `eyeY`
 * lowers the head under it, and a doorway shorter than that is refused — which
 * is correct, and is what a doorway too low to use should do.
 *
 * The band is the bulkhead's own thickness. A body's *head* is under the lintel
 * for a body-radius either side of that, so the eye drops abruptly rather than
 * over the approach; the duck is unexamined work in any case — see
 * `SHIP_BELOW_DECKS_PLAN.md` section 7 — and this is one more case for it.
 */
function doorwayHeadOver(x: number, z: number): number | null {
  for (const bulkhead of BULKHEADS) {
    if (bulkhead.sillY === null) continue;
    if (Math.abs(x - bulkhead.doorX) > DOORWAY_HALF_BREADTH) continue;
    if (Math.abs(z - bulkhead.z) > BULKHEAD_THICKNESS * 0.5) continue;
    return doorwayHeadY(bulkhead);
  }
  return null;
}

/** A surface below decks: a floor, and whatever is directly over it. */
export interface InteriorSurface {
  /** Height of the walking surface above the baseline. */
  readonly y: number;
  /** Underside of whatever is overhead. `Infinity` under open sky. */
  readonly ceilingY: number;
  /** Which space this is, for lighting and for the debug panel. */
  readonly space: SpaceName | 'companionway' | 'steps';
}

/**
 * Every floor below decks under a placed position, in no particular order.
 *
 * A *list*, because that is the honest shape of the answer and the whole point
 * of the round: at the foot of the companion ladder the sole and the ladder's
 * lowest tread are both under the query, and at the −2.4 bulkhead the landing's
 * sole and the wardroom's are 0.65 m apart at the same (x, z). Which one a body
 * is standing on depends on the body. Choosing is `deckObstacles.ts`'s job,
 * because choosing needs the weather deck in the running too.
 */
export function interiorSurfacesAt(x: number, z: number): InteriorSurface[] {
  const out: InteriorSurface[] = [];

  for (const space of spacesAt(z)) {
    const halfWidth = spaceHalfWidthAt(space, z);
    if (halfWidth <= 0 || Math.abs(x) > halfWidth) continue;
    // A well is a hole in this room's sole. Reporting the sole across it would
    // put a floor over the stairs cut into it — the same fault as roofing the
    // companionway, one deck down.
    if (INTERIOR_STEPS.some((steps) => steps.farY === space.soleY && inStepsWell(steps, x, z))) {
      continue;
    }
    // The opening is a hole in the room's ceiling, so the sky is what is
    // overhead. Written as `Infinity` rather than as a flag for the reason the
    // interface gives: a consumer that has to ask "is this one of the open ones"
    // is a consumer that will forget to.
    //
    // **The fore scuttle counts here whatever its lid is doing**, and that is
    // deliberate rather than an omission. The cut through the deckhead is
    // permanent joinery; the lid lies on the *planking*, 0.18 m higher. So the
    // volume overhead really is open to the underside of the lid, and a body
    // standing under the scuttle really can put its head up into the hole. What
    // the lid governs is the *floor* — whether the deck is withdrawn — and that
    // question is asked in `deckObstacles.ts`, which is the one place that has
    // any business knowing what the crew last did with a hatch.
    const head =
      inCompanionway(x, z) || inForeScuttle(x, z)
        ? Infinity
        : spaceDeckheadY(space, x, z);
    const doorway = doorwayHeadOver(x, z);
    const ceiling = Math.min(head ?? Infinity, doorway ?? Infinity);
    out.push({ y: space.soleY, ceilingY: ceiling, space: space.name });
  }

  if (onCompanionFlight(x, z)) {
    const index = companionTreadIndexAt(z);
    const y = companionTreadY(index, x);
    // Only when it stands above the sole. The lowest tread of a flight whose
    // foot *is* the sole is the sole, and offering it as a second surface at the
    // same height is an ambiguity the chooser would have to break arbitrarily.
    if (y > CABIN_SOLE_Y + 1e-6) {
      out.push({ y, ceilingY: Infinity, space: 'companionway' });
    }
  }

  for (const steps of INTERIOR_STEPS) {
    // The ceiling over a tread — and over the flat at the sill — is the ceiling
    // of the room the flight physically stands in. Asked of that room rather
    // than of the low floor's, because the well is cut into the landing while
    // the floor it arrives at is the wardroom's.
    const room = stepsRoom(steps);
    const roomHead = (): number => {
      const head = room ? spaceDeckheadY(room, x, z) : null;
      const doorway = doorwayHeadOver(x, z);
      return Math.min(head ?? Infinity, doorway ?? Infinity);
    };

    if (onStepsSillFlat(steps, x, z)) {
      out.push({ y: steps.sillY, ceilingY: roomHead(), space: 'steps' });
    }

    if (!onInteriorSteps(steps, x, z)) continue;
    const y = stepTreadY(steps, stepTreadIndexAt(steps, z));
    if (y <= stepsLowY(steps) + 1e-6) continue;
    out.push({ y, ceilingY: roomHead(), space: 'steps' });
  }

  return out;
}

// --- the solids ---------------------------------------------------------------

export interface InteriorSolid {
  readonly name: string;
  readonly centre: { x: number; y: number; z: number };
  readonly half: { x: number; y: number; z: number };
}

/**
 * The coaming, as the three solids it is.
 *
 * Open forward, where the ladder's head is — see `FLIGHT_HEAD_Z`. The two sides
 * run the full length of the opening and the after piece closes it, so a body
 * can only enter the way the flight is built to be climbed.
 *
 * **It stands on the quarterdeck, and the flight's head does not.** The opening
 * is a bite out of the quarterdeck's forward edge, so all three pieces are
 * founded at 4.45 while a body walks in at 3.89 from the waist. That is not a
 * mismatch to be reconciled: the coaming is a kerb round a hole for anyone
 * *on* the quarterdeck, and the entrance at the break is below all of it.
 */
/** How many pieces each run of coaming is cut into. */
const COAMING_SEGMENTS = 8;

/**
 * One length of coaming, as the segments it is drawn and collided as.
 *
 * **A coaming cannot be one box, and this is the third time that lesson has
 * been paid for on this ship.** The deck is sheered fore-and-aft *and* cambered
 * athwartships, so a level fitting standing on it touches along exactly one
 * line and floats or sinks everywhere else — M3 wrote that down for the
 * quarterdeck ladder's treads and it was not carried over here. Ash's report is
 * the same fact from the outside: *"on its inboard side it looks aligned, and
 * then towards outboard it gets progressively more misaligned"* for the after
 * piece, which is the camber; and *"at its aft end it appears aligned, but
 * towards the fore end it's misaligned"* for the long piece, which is the
 * sheer. Two axes, one cause.
 *
 * So each run is cut into segments and every segment is founded on the deck
 * *under itself*. The same list is drawn and collided, which is the whole point
 * of the file: the timber a player sees and the solid they are stopped by are
 * one description.
 */
function coamingRun(
  name: string,
  from: { x: number; z: number },
  to: { x: number; z: number },
): InteriorSolid[] {
  const t = COMPANION_COAMING_THICKNESS;
  const h = COMPANION_COAMING_HEIGHT;
  const out: InteriorSolid[] = [];
  for (let i = 0; i < COAMING_SEGMENTS; i++) {
    const s0 = i / COAMING_SEGMENTS;
    const s1 = (i + 1) / COAMING_SEGMENTS;
    const x0 = from.x + (to.x - from.x) * s0;
    const x1 = from.x + (to.x - from.x) * s1;
    const z0 = from.z + (to.z - from.z) * s0;
    const z1 = from.z + (to.z - from.z) * s1;
    const xMid = (x0 + x1) * 0.5;
    const zMid = (z0 + z1) * 0.5;
    const deck = deckStandAt(xMid, zMid);
    const base = deck ? deck.y : CABIN_SOLE_Y;
    out.push({
      name: `${name}${i}`,
      centre: { x: xMid, y: base + h * 0.5, z: zMid },
      half: {
        x: Math.max(Math.abs(x1 - x0) * 0.5, t * 0.5),
        y: h * 0.5,
        z: Math.max(Math.abs(z1 - z0) * 0.5, t * 0.5),
      },
    });
  }
  return out;
}

export function companionCoamingSolids(): InteriorSolid[] {
  const t = COMPANION_COAMING_THICKNESS;
  const aft = companionXLimits(COMPANION_AFT_Z);
  const fore = companionXLimits(COMPANION_FORWARD_Z);

  // **Two runs, not three, and both founded on the hole rather than on a centre
  // and a half-breadth.**
  //
  // The outboard one is gone: the opening runs out to the ship's side, so the
  // bulwark's inboard planking is that coaming. What is left stands with its
  // inner face exactly on an edge of the cutout — the inboard run along
  // `xLo`, which is constant, and the after run across the opening's after
  // end, whose outboard limit is the deck edge there.
  return [
    ...coamingRun(
      'companionCoamingInboard',
      { x: aft.xLo - t * 0.5, z: COMPANION_AFT_Z },
      { x: fore.xLo - t * 0.5, z: COMPANION_FORWARD_Z },
    ),
    ...coamingRun(
      'companionCoamingAft',
      { x: aft.xLo - t, z: COMPANION_AFT_Z - t * 0.5 },
      { x: aft.xHi, z: COMPANION_AFT_Z - t * 0.5 },
    ),
  ];
}

/** A bulkhead: which rooms it divides, and the doorway through it. */
export interface Bulkhead {
  readonly name: string;
  /** Placed z of the plane. */
  readonly z: number;
  /** The sole on each side, aft first. `null` where there is no room. */
  readonly soleAft: number | null;
  readonly soleForward: number | null;
  /** Sill of the doorway, or `null` for a bulkhead with no door in it. */
  readonly sillY: number | null;
  /** Centre of the doorway across the beam. See `DOORWAY_OFFSET`. */
  readonly doorX: number;
  /**
   * The room whose deckhead bounds the *doorway* — the lower ceiling of the two.
   *
   * A doorway cannot be taller than the shorter of the rooms it joins, so this
   * is the right room to ask about the opening. **It is the wrong room to draw
   * the bulkhead to**, which is what it was used for: see `bulkheadRoofOn`.
   */
  readonly roof: BelowDecksSpace;
}

/**
 * The room on one face of a bulkhead: `1` forward of it, `-1` abaft.
 *
 * THE 0.59 m OF OPEN WALL THIS EXISTS TO CLOSE
 * --------------------------------------------
 * Both faces of every bulkhead were drawn to `roof` — deliberately the *lower*
 * of the two ceilings, which is right for the doorway and wrong for the timber.
 * The wardroom bulkhead stands under the quarterdeck break: the landing abaft it
 * is roofed at 4.32 and the wardroom forward of it at 3.73, so the whole
 * bulkhead stopped 0.59 m short of the landing's own deckhead, across the full
 * width of the ship. From the landing you looked over the top of it at the
 * weather deck, the rigging and the sky — which is what Ash reported, and the
 * raycast agrees: at 3.90 m the ray leaves the room and hits deck planking 2.5 m
 * away, on the other side of a wall.
 *
 * **The camber fix in `shipGeometry` was a real 78 mm and not this.** Two faults
 * with one symptom, and finding the first is exactly how you stop looking for
 * the second.
 */
export function bulkheadRoofOn(bulkhead: Bulkhead, facing: 1 | -1): BelowDecksSpace | null {
  const sole = facing > 0 ? bulkhead.soleForward : bulkhead.soleAft;
  if (sole === null) return null;
  const inside = bulkhead.z + facing * ROOF_SAMPLE_INSET;
  return (
    spacesAt(inside).find((space) => Math.abs(space.soleY - sole) < 1e-6) ?? bulkhead.roof
  );
}

/**
 * The four bulkheads, aft to forward.
 *
 * **The sill of a doorway is the floor on the side you arrive from**, which is
 * usually the higher of the two — the bulkhead below the sill is then solid and
 * the steps come down off it into the lower room. Where a well is cut into the
 * higher room instead, the arriving floor is the *lower* one and there is
 * nothing under the sill at all. That is the same fact `INTERIOR_STEPS` states
 * from the other side, and it is stated twice on purpose: this list is what
 * gets drawn and collided, and that one is what gets walked on, and a doorway
 * whose sill did not agree with its own steps is a stair into a wall.
 *
 * The peak bulkhead carries no door. Forward of it is the sail room and the
 * boatswain's store — spare sails, cordage, blocks — which is stowed solid from
 * the floors to the deck and is not a space anyone stands in. `SHIP_SPEC.md`
 * section 10 asks for those as believable volume at low detail, and a closed
 * bulkhead with the peak behind it is exactly that.
 */
export const BULKHEADS: readonly Bulkhead[] = [
  {
    name: 'cabinBulkhead',
    z: CABIN_FORWARD_Z,
    soleAft: CABIN_SOLE_Y,
    soleForward: CABIN_SOLE_Y,
    sillY: CABIN_SOLE_Y,
    doorX: 0,
    roof: belowDecksSpace('landing'),
  },
  {
    name: 'wardroomBulkheadAft',
    z: PLATFORM_AFT_Z,
    soleAft: CABIN_SOLE_Y,
    soleForward: PLATFORM_SOLE_Y,
    // **The low floor, not the high one** — the well abaft this bulkhead brings
    // the landing down to the wardroom's own level before the opening, so both
    // sides of the door are at 1.80 and the clear height goes 1.263 → 1.850.
    // See `InteriorSteps`. This is the one bulkhead where the sill is not the
    // higher of the two soles, and it is why that rule is stated on the datum
    // rather than assumed by the code that reads it.
    sillY: PLATFORM_SOLE_Y,
    doorX: -WELL_OFFSET,
    roof: belowDecksSpace('wardroom'),
  },
  {
    name: 'wardroomBulkheadForward',
    z: PLATFORM_FORWARD_Z,
    soleAft: PLATFORM_SOLE_Y,
    soleForward: FORECASTLE_SOLE_Y,
    sillY: FORECASTLE_SOLE_Y,
    doorX: DOORWAY_OFFSET,
    roof: belowDecksSpace('forecastle'),
  },
  {
    name: 'peakBulkhead',
    z: FORECASTLE_FORWARD_Z,
    soleAft: FORECASTLE_SOLE_Y,
    soleForward: null,
    sillY: null,
    doorX: 0,
    roof: belowDecksSpace('forecastle'),
  },
];

/** Half-width of a bulkhead: the wider of the two rooms it closes. */
export function bulkheadHalfWidthAt(bulkhead: Bulkhead): number {
  return Math.max(
    bulkhead.soleAft === null ? 0 : roomHalfWidthAt(bulkhead.z, bulkhead.soleAft),
    bulkhead.soleForward === null ? 0 : roomHalfWidthAt(bulkhead.z, bulkhead.soleForward),
  );
}

/** The floor a bulkhead stands on: the lower of its two sides. */
export function bulkheadFootY(bulkhead: Bulkhead): number {
  const soles = [bulkhead.soleAft, bulkhead.soleForward].filter(
    (y): y is number => y !== null,
  );
  return Math.min(...soles);
}

/** Top of the doorway through a bulkhead, capped by the room it is in. */
export function doorwayHeadY(bulkhead: Bulkhead): number | null {
  if (bulkhead.sillY === null) return null;
  const head = spaceDeckheadY(bulkhead.roof, bulkhead.doorX, bulkhead.z);
  const wanted = bulkhead.sillY + DOORWAY_HEIGHT;
  return head === null ? wanted : Math.min(wanted, head);
}

/**
 * The bulkheads as the solids a body is stopped by.
 *
 * **They were `collidable: false` through M4 and that was right then**, because
 * the cabin was the only room and its bulkheads stood exactly where the sole
 * ended — the surface already refused a body there, and a collider would have
 * been a second description of one plane. It stopped being right the moment
 * there was floor on *both* sides: with four rooms joined bow to stern, a
 * bulkhead that is not a solid is not a bulkhead, and a body would walk through
 * the wall anywhere except the doorway.
 *
 * Two boxes per bulkhead, port and starboard of the doorway, plus the lintel
 * over it where the room is tall enough to have one. Where a doorway's sill
 * stands above the lower floor, a third box fills under it — that is the face
 * the steps come down.
 *
 * WHERE A COMPANIONWAY CROSSES A BULKHEAD'S OWN PLANE
 * ---------------------------------------------------
 * The wardroom's after bulkhead stands *at the quarterdeck break*, which is
 * also where the companionway's head now is. Both wanted the same plane, and
 * the bulkhead won: a body climbed to the third tread and stopped, held by
 * `wardroomBulkheadAftPort`, with the waist deck one step above its feet.
 *
 * The bulkhead reaches the **higher** of its two deckheads on purpose — §10.4's
 * fault was a collider drawn to the lower one, which left a 0.59 m band a head
 * passed through above a wall standing right there. That is still right
 * everywhere except across the shaft, where the band *is* the way out and the
 * lower deckhead is exactly the correct top: over the opening the bulkhead
 * stops at the waist deck's underside, so the step from the top tread onto the
 * waist is inside the walker's step-over and the timber is ignored rather than
 * climbed.
 *
 * So this is not the 0.59 m fault coming back. It is the same rule with the one
 * exception the rule never had to cover: a hole through the deck the higher
 * ceiling belongs to.
 */
export function bulkheadSolids(): InteriorSolid[] {
  const out: InteriorSolid[] = [];
  const halfThickness = BULKHEAD_THICKNESS * 0.5;
  // `stepOver` is 80 mm taller than `stepUp`. Carry a deck-break collider this
  // far above the planking so it cannot become ignorable before the floor on
  // its far side is reachable. Once a body is actually on that floor the lip is
  // far below its step-over band and disappears in the ordinary way.
  const deckBreakCollisionLip = 0.09;

  for (const bulkhead of BULKHEADS) {
    const halfWidth = bulkheadHalfWidthAt(bulkhead);
    if (halfWidth <= 0) continue;
    const foot = bulkheadFootY(bulkhead);
    // The crown, because it is the highest the deckhead gets across the beam and
    // a collider that stopped at the deck *at the side* would leave a gap over
    // the centreline that a body's head fits through — and the **higher** of the
    // two rooms, for the same reason in the other axis: at a deck break the two
    // ceilings are 0.59 m apart, and a collider drawn to the lower one leaves a
    // band a head passes through above a wall that is standing right there.
    const top = Math.max(
      ...([1, -1] as const)
        .map((facing) => bulkheadRoofOn(bulkhead, facing))
        .map((space) => (space ? spaceDeckheadY(space, 0, bulkhead.z) : null))
        .filter((y): y is number => y !== null),
    );
    if (!Number.isFinite(top) || top <= foot) continue;

    // The shaft that crosses this plane, if one does, and the top the timber
    // takes inside it: the flight's actual top tread. The previous exception
    // stopped one tread lower and cut an unnecessary 0.25 m window through the
    // wardroom wall. The last tread already fills that band and meets the
    // wardroom deckhead, so it is the natural top of the bulkhead as well as a
    // surface the walker can step onto before crossing the plane. This keeps a
    // full-height wardroom partition and the companion route from competing for
    // the same volume.
    const shaftTop = companionTreadY(
      COMPANION_TREADS,
      companionMidX(bulkhead.z),
    );
    // **The companionway by name, not "the uncovered one".** Everything below
    // this line is the companion flight's own geometry — `shaftTop` is
    // `companionTreadY`, and the panel split assumes a stair crosses the plane.
    // The filter used to say `!opening.covered`, which was a true description
    // of the companionway while it was the only uncovered opening on the ship.
    // The fore scuttle is the second, and had it landed on a bulkhead station
    // this would have quietly handed it a companion tread to stand on. Naming
    // the thing you mean costs one string and cannot rot.
    const shaft = DECK_OPENINGS.find(
      (opening) =>
        opening.name === 'companionway' &&
        Math.min(
          Math.abs(opening.zAft - bulkhead.z),
          Math.abs(opening.zForward - bulkhead.z),
        ) < 1e-6,
    );
    const shaftSpan = shaft ? openingXLimits(shaft, bulkhead.z) : null;

    /** One panel of timber, split where the shaft crosses it and capped there. */
    const panel = (name: string, xLo: number, xHi: number): void => {
      if (xHi - xLo <= 1e-6) return;
      const quarterdeckCentreCut =
        bulkhead.name === 'wardroomBulkheadAft' && 0 > xLo && 0 < xHi ? [0] : [];
      const cuts = [
        xLo,
        ...quarterdeckCentreCut,
        ...(
          shaftSpan
            ? [shaftSpan.xLo, shaftSpan.xHi].filter((x) => x > xLo && x < xHi)
            : []
        ),
        xHi,
      ].sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const lo = cuts[i];
        const hi = cuts[i + 1];
        const inShaft =
          shaftSpan !== null && lo >= shaftSpan.xLo - 1e-6 && hi <= shaftSpan.xHi + 1e-6;
        // Away from a route through the break, this collider also carries the
        // visible deck riser from the bulkhead's deckhead to the planking. At
        // the quarterdeck it is needed only on the centre/port side; the
        // starboard half is the weather-deck stair and its floor query owns that
        // transition.
        const carriesDeckRiser =
          bulkhead.name === 'wardroomBulkheadAft' && lo >= -1e-9;
        const panelTop = inShaft
          ? shaftTop
          : carriesDeckRiser
            ? top + DECK_BEAM_DEPTH + deckBreakCollisionLip
            : top;
        if (panelTop <= foot + 1e-6) continue;
        out.push({
          name: cuts.length > 2 ? `${name}${i}` : name,
          centre: { x: (lo + hi) * 0.5, y: (foot + panelTop) * 0.5, z: bulkhead.z },
          half: {
            x: (hi - lo) * 0.5,
            y: (panelTop - foot) * 0.5,
            z: halfThickness,
          },
        });
      }
    };

    const doorHalf = bulkhead.sillY === null ? 0 : DOORWAY_HALF_BREADTH;
    const doorLo = bulkhead.doorX - doorHalf;
    const doorHi = bulkhead.doorX + doorHalf;
    if (doorHalf > 0 && doorLo > -halfWidth && doorHi < halfWidth) {
      panel(`${bulkhead.name}Port`, doorHi, halfWidth);
      panel(`${bulkhead.name}Starboard`, -halfWidth, doorLo);
      // **No lintel collider.** The timber over a doorway is drawn, and it is
      // real, but as a *solid* it is a wall with an unusable gap under it: the
      // landing-to-wardroom door is 1.263 m of clear opening and a body is
      // 1.75 m, so a collider from the head upward stops her dead in a doorway
      // she should be ducking through. `doorwayHeadOver` states it as a ceiling
      // instead, which is what a lintel is, and the walker's `crouchHeight`
      // then decides — including refusing a doorway genuinely too low to use.
      if (bulkhead.sillY! > foot + 1e-6) {
        out.push({
          name: `${bulkhead.name}Sill`,
          centre: { x: bulkhead.doorX, y: (foot + bulkhead.sillY!) * 0.5, z: bulkhead.z },
          half: { x: doorHalf, y: (bulkhead.sillY! - foot) * 0.5, z: halfThickness },
        });
      }
    } else {
      panel(bulkhead.name, -halfWidth, halfWidth);
    }
  }
  return out;
}

/**
 * Half-dimensions of the boxed casing round the rudder stock.
 *
 * The stock's own siding plus the trunk it works in and the joinery over that.
 */
export const RUDDER_TRUNK_HALF_BREADTH = 0.15;
export const RUDDER_TRUNK_HALF_LENGTH = 0.16;

/**
 * The rudder trunk, boxed in, standing in the after end of the cabin.
 *
 * **The transom rakes and the stock does not, and that is the whole geometry of
 * it.** The stock comes up vertically at z = −7.75; the transom leans away aft
 * at 18°, so it is 0.05 m abaft the stock at the sole and 0.72 m abaft it at the
 * deckhead. The casing therefore stands *free in the room*, on the centreline,
 * widening its intrusion as it rises — which is why the stern windows go in two
 * pairs either side of it rather than in a row of three with one behind it, and
 * why the bench across the transom is in two pieces.
 *
 * Collidable, unlike everything else drawn below decks: it is a column in the
 * middle of the floor at the exact place a player walks aft to look out of the
 * windows.
 */
export function rudderTrunkSolid(): InteriorSolid {
  const cabin = belowDecksSpace('cabin');
  const top = spaceDeckheadY(cabin, 0, RUDDER_STOCK_Z) ?? cabin.soleY + 2;
  return {
    name: 'rudderTrunk',
    centre: {
      x: 0,
      y: (cabin.soleY + top) * 0.5,
      z: RUDDER_STOCK_Z,
    },
    half: {
      x: RUDDER_TRUNK_HALF_BREADTH,
      y: (top - cabin.soleY) * 0.5,
      z: RUDDER_TRUNK_HALF_LENGTH,
    },
  };
}

/** A stern window: centre and half-dimensions on the transom's own plane. */
export interface SternWindow {
  readonly x: number;
  readonly y: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * The after lining of the cabin **follows the transom**, and it did not.
 *
 * WHY THIS HAD TO CHANGE BEFORE THE WINDOWS COULD MOVE
 * ---------------------------------------------------
 * The wall was plumb, at the transom's own station *taken at the sole* — so the
 * higher up you went, the further aft the transom had leaned away from the
 * panelling, and the deeper the reveal from the wall to the glass. The number is
 * exact: the counter rakes at 18 degrees, so the reveal grows 0.325 m for every
 * metre of height above the sole. At the old sills, 0.68 m up, that was 0.29 m
 * and read as a window. At a sill high enough to keep the sea out it would have
 * been 0.47 m — a tunnel deeper than the light is wide.
 *
 * **The two are not independent choices.** There is no window height above about
 * 3.1 with a sane reveal while the wall is plumb, so raising the lights *is*
 * raking the wall. A plumb bulkhead with a wedge of dead counter behind the
 * panelling is right down at the tuck, where the counter actually is; carried to
 * the deckhead it is 0.67 m of the room given away for nothing.
 *
 * The lining stands `CABIN_LINING_THICKNESS` inboard of the moulded transom,
 * measured horizontally, and never abaft the sole's own after edge — which
 * leaves a short plumb skirt at the bottom where the lining's thickness matters
 * more than the rake, and that is what the foot of a raked bulkhead looks like.
 */
export function sternLiningZAt(y: number): number {
  return Math.min(transomPlacedZ(y) + CABIN_LINING_THICKNESS, CABIN_AFT_Z);
}

/** Half-width of the after lining at height `y`: the counter there, lined. */
export function sternLiningHalfWidthAt(y: number): number {
  return Math.max(shellHalfWidthAt(sternLiningZAt(y), y) - CABIN_LINING_THICKNESS, 0);
}

/**
 * Timber between one light and the next, and at the quarters. **Structural.**
 *
 * A stern light sits between the stern timbers, and the piers either side of it
 * are those timbers rather than spacing. The old arrangement had 0.10 m between
 * the members of each pair and 0.50 m in the middle, which was not a decision —
 * it was what was left once four openings had been fitted round the rudder
 * trunk. Ash asked whether it was deliberate. It was not. This is.
 */
const STERN_WINDOW_PIER = 0.11;

/**
 * How far under the deckhead the heads of the lights sit.
 *
 * A beam's depth and the lining over it. What it buys is the number that
 * matters: the heads land at 4.24 against a standing eye at 4.07, so **you can
 * see out of them standing up** — which the old ones, heads at 3.57 and half a
 * metre below the eye, could not do at all. A man in that cabin had to stoop to
 * look at the sea, and every screenshot through them was solid water.
 */
const STERN_WINDOW_HEADER = 0.28;

/** Height of a light, sill to head. */
const STERN_WINDOW_HEIGHT = 0.55;

/**
 * How far the sills stand above the design waterline, metres.
 *
 * **Set by the sea, and measured rather than guessed.** In 110 s of the
 * production sea state the old sills — 0.83 m up — came within 0.21 m of the
 * water at their worst, and the drawn surface carries a further 0.157 m of
 * detail that the buoyancy sampler never sees, so what a player watched came
 * within about 0.05 m of going under. That is the margin Ash called far too
 * marginal, and the measurement agrees with him.
 *
 * At 1.25 m the same 110 s leaves 0.75 m in hand at the worst crest. It is not a
 * guarantee, and the honest answer to a following sea is the deadlights the
 * furnishing pass owes — shutters shipped over the glass in heavy weather — but
 * it is the difference between a window that is occasionally alarming and one
 * that is not.
 */
const STERN_WINDOW_SILL_ABOVE_DWL = 1.25;

/** The band the lights occupy: the deckhead at the top, the sea at the bottom. */
function sternWindowBand(): { sill: number; head: number } {
  const cabin = belowDecksSpace('cabin');
  const deckhead = spaceDeckheadY(cabin, 0, cabin.zAft) ?? cabin.soleY + 2;
  const head = deckhead - STERN_WINDOW_HEADER;
  const sill = Math.max(head - STERN_WINDOW_HEIGHT, DESIGN_DRAUGHT + STERN_WINDOW_SILL_ABOVE_DWL);
  return { sill, head };
}

/**
 * Four stern lights, in two pairs either side of the rudder trunk.
 *
 * **Four and not three, and that is the rudder's doing.** The exterior carried
 * three — one of them on the centreline — from before the cabin reached the
 * transom, so nothing had to notice that the rudder stock comes up exactly
 * there. It does, boxed, from the sole to the deckhead; the middle window looked
 * out at the back of a timber casing.
 *
 * **Everything about them is derived now**, because Ash asked why they were
 * spaced and sized the way they were and the truthful answer was that nobody had
 * decided. The band is set at the top by the deckhead and at the bottom by the
 * waterline; the widths are what is left between the trunk's casing and the
 * ship's side once the piers have taken their timber, shared equally. Move the
 * trunk, the header or the freeboard rule and the lights follow.
 *
 * Taken at the *head*, where the counter is narrowest: a light that fits at the
 * top of the band fits all the way down it.
 *
 * The list lives here because the *interior* lining and the *exterior* transom
 * both cut to it, and two descriptions of one opening is how you get a window
 * that is glazed on the outside and planked over on the inside.
 */
export const STERN_WINDOWS: readonly SternWindow[] = (() => {
  const { sill, head } = sternWindowBand();
  const inboard = RUDDER_TRUNK_HALF_BREADTH + STERN_WINDOW_PIER;
  const outboard = sternLiningHalfWidthAt(head) - STERN_WINDOW_PIER;
  const halfWidth = Math.max((outboard - inboard - STERN_WINDOW_PIER) * 0.25, 0.05);
  return [inboard + halfWidth, outboard - halfWidth].flatMap((centre) =>
    ([1, -1] as const).map((side) => ({
      x: side * centre,
      y: (sill + head) * 0.5,
      halfWidth,
      halfHeight: (head - sill) * 0.5,
    })),
  );
})();

/**
 * The glass at a height: the transom there, a fraction inboard of the moulded
 * line so the panes read as openings rather than as paint.
 *
 * **A function of height and not a plane**, now the lights are 0.55 m tall on an
 * 18 degree rake: sill and head are 0.18 m apart in z, and one flat quad across
 * that is a pane standing half proud of the transom and half sunk into it. The
 * exterior transom and the interior reveals both read this, so the two cannot
 * drift apart — which is the fault the old single plane was written against, one
 * size of the same mistake smaller.
 */
export function sternWindowZAt(y: number): number {
  return transomPlacedZ(y) + 0.02;
}

/** Every solid below decks a body can be stopped by. */
export function interiorSolids(): InteriorSolid[] {
  return [
    ...companionCoamingSolids(),
    ...companionCheekSolids(),
    ...bulkheadSolids(),
    rudderTrunkSolid(),
  ];
}

/** The lowest floor aboard — what the walker's obstacle index has to reach down to. */
export const LOWEST_SOLE_Y = Math.min(...BELOW_DECKS_SPACES.map((space) => space.soleY));

/**
 * Every list in this file that produces geometry, classified.
 *
 * The same arrangement `OBSTACLE_SOURCES` holds for the rig and `FITTING_KINDS`
 * for the deck's furniture, and it is here for the same reason: an intersection
 * suite keyed to one list stops covering the ship the moment geometry lands in a
 * different list. `ship-interior.test.ts` asserts that every entry is real and
 * that nothing below decks is missing from it.
 */
export const INTERIOR_SOURCES: Record<string, { collidable: boolean; reason: string }> = {
  interiorSoles: {
    collidable: false,
    reason:
      'Floors, not walls. Their *extent* is what stops a body — walking off the ' +
      'edge of a sole is refused because there is no surface there, which is ' +
      'the same thing that stops a walker at the bulwarks.',
  },
  companionCheeks: {
    collidable: true,
    reason:
      'The two narrow side rails of the flight. They keep a body on the landing ' +
      'from crossing sideways beneath a tread it cannot acquire, while leaving ' +
      'the fore-and-aft climbing route between them clear.',
  },
  companionTreads: {
    collidable: false,
    reason: 'Floors as well: a flight is climbed, and the walker steps up 0.287 m per tread.',
  },
  interiorSteps: {
    collidable: false,
    reason:
      'Floors. The two drawn treads at the wardroom bulkhead are 0.217 m apiece, ' +
      'under the walker’s step-up in both directions; the forecastle’s 0.25 m has ' +
      'no tread at all because the step-up already covers it.',
  },
  companionCoaming: {
    collidable: true,
    reason:
      'The one solid below decks that stands on the weather deck. 0.50 m proud, ' +
      'which is above the walker’s 0.40 m step-over, so it blocks rather than ' +
      'being strode across into the opening.',
  },
  interiorBulkheads: {
    collidable: true,
    reason:
      'Collided now, and they were not through M4. With one room the bulkhead ' +
      'stood exactly where the sole ended, so the surface already refused a body ' +
      'and a collider would have been a second description of one plane. With ' +
      'four rooms there is floor on both sides, and a bulkhead that is not a ' +
      'solid is a wall you walk through.',
  },
  interiorBeams: {
    collidable: false,
    reason:
      'Overhead. They are the *ceiling*, and a ceiling is enforced by the ' +
      'headroom in `InteriorSurface`, not by a column a body walks into.',
  },
  hatchwayBoards: {
    collidable: false,
    reason:
      'The platform’s hatchway is boarded flush and walked on, so it is part of ' +
      'the wardroom’s sole rather than a hole in it. The boards are drawn as ' +
      'their own thing only because they have to read as liftable.',
  },
  transomLining: {
    collidable: false,
    reason:
      'The cabin’s after wall is the transom itself, raked 18°, with the four ' +
      'stern windows in it. The sole ends there, so the surface refuses a body ' +
      'before the timber has to.',
  },
  rudderTrunk: {
    collidable: true,
    reason:
      'The boxed casing round the rudder stock, which comes up vertically at ' +
      'z −7.75 while the transom rakes away from it — so it stands 0 to 0.6 m ' +
      'inside the after end of the cabin, on the centreline, where a body walks.',
  },
};
