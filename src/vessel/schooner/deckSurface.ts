import {
  DECK_OPENINGS,
  BULWARK_MAIN_HEIGHT,
  BULWARK_QUARTERDECK_HEIGHT,
  BULWARK_THICKNESS,
  COUNTER_SHEAR_START_Z,
  DECK_CAMBER_RATIO,
  FORECASTLE_AFT_Z,
  FORECASTLE_RISE,
  HALF_LENGTH,
  QUARTERDECK_FORWARD_Z,
  QUARTERDECK_RISE,
  bulwarkOuterHalfBeam,
  counterRakeShift,
  deckAtSideY,
} from './hullForm';
import type { DeckOpening } from './hullForm';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * The walkable deck, as a surface rather than as a mesh.
 *
 * `shipGeometry.ts` draws the deck by sampling this file; the character
 * controller stands on it by querying this file. That is deliberate and it is
 * the same contract the flotation model already holds with `hullForm.ts`:
 *
 * > the geometry is handed in by the vessel, which records it as it builds the
 * > meshes, so the two can never disagree
 *
 * A deck the player can walk on is a physical object with two consumers, and the
 * rig round is the argument for why they must not each describe it. `rig.ts`
 * once carried its own guess at where the bulwark was — `halfBreadthAt(z, deck)
 * − 0.14` against a wall that is 0.09 m thick and tumbles home — and every
 * fitting on the rail was placed against a wall that was not there. Ash reported
 * it four times in different words. A floor that the renderer and the collision
 * model each describe separately fails the same way, except that the player
 * walks through the disagreement instead of looking at it.
 *
 * WHAT A TEST OF THIS FILE CAN AND CANNOT PROVE
 * ---------------------------------------------
 * Checking the controller against `deckStandAt` proves nothing — they are the
 * same expression, and a test that derives the truth the same wrong way as the
 * code cannot fail. The check that means something is the *drawn mesh* against
 * this surface: the loft samples 140 stations by 8 columns and applies the
 * counter rake as it goes, while `deckStandAt` inverts that rake to answer a
 * continuous query, so agreement between them is a real result about two
 * different computations. `tests/ship-deck.test.ts` is that test.
 *
 * COORDINATES
 * -----------
 * Ship-local, as `hullForm.ts` defines them: +x port, +y up from the
 * moulded baseline, +z forward. Two longitudinal coordinates appear here and
 * they are not the same:
 *
 * - the **parameter** z, which is what the sheer, the levels and the offsets are
 *   defined against, and
 * - the **placed** z, which is where a point actually lands after the counter's
 *   rake has carried it aft.
 *
 * They differ only abaft z = −6.2 and only above the design waterline, where the
 * quarterdeck is carried up to 0.79 m aft of its parameter station. That
 * overhang is real deck — it is where the taffrail is — so a query about a
 * position on the ship takes placed z and inverts the rake to find the
 * parameter. Functions naming a `zParam` take the former; `deckStandAt` takes
 * the latter, because a walker knows only where it is.
 */

/** One of the three deck levels, aft to forward. */
export interface DeckLevel {
  readonly name: 'quarterdeck' | 'waist' | 'forecastle';
  /** Aft limit, parameter z. */
  readonly z0: number;
  /** Forward limit, parameter z. */
  readonly z1: number;
  /** Height of this level's walking surface above the deck at side. */
  readonly deckRise: number;
  /** Bulwark height above this level's walking surface. */
  readonly heightAboveWalkingDeck: number;
}

/**
 * The three levels, aft to forward.
 *
 * The bulwark heights are imported rather than written. They were literals here
 * *and* literals in `hullForm.bulwarkTopY`, which is two descriptions of one
 * wall agreeing by coincidence — the precise arrangement that put fittings
 * inside the caprail in the rig round.
 */
export const DECK_LEVELS: readonly DeckLevel[] = [
  {
    name: 'quarterdeck',
    z0: -HALF_LENGTH,
    z1: QUARTERDECK_FORWARD_Z,
    deckRise: QUARTERDECK_RISE,
    heightAboveWalkingDeck: BULWARK_QUARTERDECK_HEIGHT,
  },
  {
    name: 'waist',
    z0: QUARTERDECK_FORWARD_Z,
    z1: FORECASTLE_AFT_Z,
    deckRise: 0,
    heightAboveWalkingDeck: BULWARK_MAIN_HEIGHT,
  },
  {
    name: 'forecastle',
    z0: FORECASTLE_AFT_Z,
    z1: HALF_LENGTH,
    deckRise: FORECASTLE_RISE,
    heightAboveWalkingDeck: BULWARK_MAIN_HEIGHT,
  },
];

/**
 * The level a parameter z belongs to.
 *
 * The levels partition the ship: the breaks belong forward and aft respectively,
 * so exactly one level answers for any z and a walker at a break sees a step
 * rather than an ambiguity.
 */
export function deckLevelAt(zParam: number): DeckLevel {
  if (zParam <= QUARTERDECK_FORWARD_Z) return DECK_LEVELS[0];
  if (zParam >= FORECASTLE_AFT_Z) return DECK_LEVELS[2];
  return DECK_LEVELS[1];
}

/** Height of a level's walking surface at the side, above the baseline. */
export function levelWalkingY(zParam: number, level: DeckLevel): number {
  return deckAtSideY(zParam) + level.deckRise;
}

/** Top of a level's bulwark — the underside of its caprail. */
export function levelBulwarkTopY(zParam: number, level: DeckLevel): number {
  return levelWalkingY(zParam, level) + level.heightAboveWalkingDeck;
}

/**
 * Half-width of the walkable deck at `zParam`: the inboard face of the bulwark.
 *
 * Taken at the walking surface, where the wall meets the floor. The bulwark
 * tumbles home as it rises, so at head height the gap between the two walls is
 * about 0.2 m narrower than this — see `deckObstacles.ts`, which is where a
 * body of real height is fitted between them.
 */
export function deckHalfWidth(zParam: number, level: DeckLevel): number {
  const y = levelWalkingY(zParam, level);
  return Math.max(bulwarkOuterHalfBeam(zParam, y) - BULWARK_THICKNESS, 0);
}

/** Deck camber at `zParam`: how far the crown stands above the deck at side. */
export function deckCamberHeight(zParam: number, level: DeckLevel): number {
  return 2 * deckHalfWidth(zParam, level) * DECK_CAMBER_RATIO;
}

/**
 * A point on the deck, at parameter station `zParam` and across-beam fraction
 * `u` ∈ [−1, +1]. The returned z is *placed*: the counter's rake is applied.
 */
export function deckPoint(zParam: number, u: number, level: DeckLevel): Vec3 {
  const w = deckHalfWidth(zParam, level);
  const y = levelWalkingY(zParam, level) + deckCamberHeight(zParam, level) * (1 - u * u);
  return v3(u * w, y, zParam - counterRakeShift(zParam, y));
}

/** Upward normal of the deck, by central difference of the placed surface. */
export function deckNormal(zParam: number, u: number, level: DeckLevel): Vec3 {
  const du = 1e-3;
  const dz = 4e-3;
  const zLo = Math.max(zParam - dz, -HALF_LENGTH + dz);
  const zHi = Math.min(zParam + dz, HALF_LENGTH - dz);
  const pu0 = deckPoint(zParam, Math.max(u - du, -1), level);
  const pu1 = deckPoint(zParam, Math.min(u + du, 1), level);
  const pz0 = deckPoint(Math.max(zLo, level.z0), u, level);
  const pz1 = deckPoint(Math.min(zHi, level.z1), u, level);
  const tu = v3(pu1.x - pu0.x, pu1.y - pu0.y, pu1.z - pu0.z);
  const tz = v3(pz1.x - pz0.x, pz1.y - pz0.y, pz1.z - pz0.z);
  let nx = tu.y * tz.z - tu.z * tz.y;
  let ny = tu.z * tz.x - tu.x * tz.z;
  let nz = tu.x * tz.y - tu.y * tz.x;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return v3(0, 1, 0);
  return v3(nx / len, ny / len, nz / len);
}

// --- where an opening's edges are --------------------------------------------

/**
 * Inboard and outboard limits of a deck opening at a station, port-positive.
 *
 * **Here rather than in `hullForm.ts`, because an opening that runs out to the
 * ship's side is a fact about the deck edge and this file owns that.** The
 * companionway's outboard limit is the bulwark's inboard face less a
 * clearance, so it varies along the opening — 1.879 at the quarterdeck break
 * down to 1.694 at its after end — and any consumer holding a single pair of
 * numbers for it is holding a chord across a curve.
 *
 * That chord is exactly what Ash saw: a straight coaming against a curved side,
 * with a wedge of dead deck between them that narrowed as it went aft.
 */
export function openingXLimits(opening: DeckOpening, z: number): { xLo: number; xHi: number } {
  if (opening.xHi !== 'side') return { xLo: opening.xLo, xHi: opening.xHi };
  const clearance = opening.outboardClearance ?? 0;
  const level = deckLevelAt(z);
  // **The deck edge and nothing else.** Clamping this by the hull at the floor
  // below was tried and it is what left a sliver of deck outboard of the hole:
  // the room below is narrower than the deck above it, so the two limits differ
  // by 30–50 mm and the difference reads as a strip of planking that should not
  // be there. The hole belongs to the deck; what the flight does about the room
  // narrowing under it is the flight's business.
  const edge = deckHalfWidth(z, level) - clearance;
  return { xLo: opening.xLo, xHi: Math.max(edge, opening.xLo + 0.2) };
}

/** The opening a ship-local position falls inside, or `null`. */
export function deckOpeningAt(x: number, z: number): DeckOpening | null {
  for (const opening of DECK_OPENINGS) {
    if (z < opening.zAft || z > opening.zForward) continue;
    const { xLo, xHi } = openingXLimits(opening, z);
    if (x < xLo || x > xHi) continue;
    return opening;
  }
  return null;
}

/** Is a ship-local position inside the companionway's opening? */
export function inCompanionway(x: number, z: number): boolean {
  return deckOpeningAt(x, z)?.name === 'companionway';
}

/**
 * Is a ship-local position inside the fore scuttle's opening?
 *
 * **Geometry only — it does not know whether the lid is up.** The cut through
 * the planking is there either way; what is lying on the coaming above it is
 * `closures.ts`'s business, and `deckObstacles.ts` is the one place that asks
 * both questions in the same breath. Keeping the state out of here is what lets
 * the loft, the deckhead and the reachability sweep all use this without any of
 * them having to care what the crew last did with the hatch.
 */
export function inForeScuttle(x: number, z: number): boolean {
  return deckOpeningAt(x, z)?.name === 'foreScuttle';
}

// --- the quarterdeck ladders -------------------------------------------------

/**
 * A flight of steps at a deck break.
 *
 * The quarterdeck stands 0.55 m above the waist. That is a stride onto a table,
 * not a step, so without something to climb the after third of the ship is
 * simply unreachable on foot — which is what the first walk found. The
 * forecastle's 0.22 m needs nothing: it is a kerb, and the walker steps up it.
 *
 * Two flights rather than one, starboard and port, because the centreline at
 * this break is taken: the mainmast passes through the deck 0.5 m forward of it
 * and the main fife rail stands 0.12 m abaft it. They also happen to be where a
 * vessel of the type puts them — you go up beside the house, not over it.
 *
 * The tread heights come out of this data, and `shipGeometry.ts` draws the same
 * data as timber. That is the whole point of the file: the step the player
 * climbs and the step they can see are one description.
 *
 * **It is one flight now, to starboard.** The port one is the companionway —
 * the way below decks starts at the break instead of on the quarterdeck, so
 * that side of the break is a hole rather than a stair. See `COMPANION_X` for
 * the argument and `sides` for what the datum had been assuming.
 */
export interface DeckStair {
  readonly name: string;
  /** Station of the flight's top, parameter z. The break itself. */
  readonly zTop: number;
  /** Station of the flight's foot, parameter z — forward of the top. */
  readonly zBottom: number;
  /** Inboard edge, port side. The starboard flight mirrors. */
  readonly xInboard: number;
  /**
   * How far short of the deck edge the flight's outboard side stops.
   *
   * Not an absolute x. The deck edge is a curve, so a flight with a straight
   * outboard side leaves a wedge of deck between itself and the bulwark that is
   * too narrow to walk in and too wide to look deliberate — which is exactly how
   * it read. The outboard side follows the planking instead, at this clearance,
   * and only the timber's own thickness is left.
   */
  readonly outboardClearance: number;
  /**
   * Risers in the flight, counting the last step *onto the deck*.
   *
   * So the drawn treads number one fewer. A tread level with the quarterdeck
   * standing against the quarterdeck is not a step, it is 0.28 m of extra deck
   * with a seam in it.
   */
  readonly risers: number;
  /**
   * Which hands the flight stands on: `1` port, `-1` starboard.
   *
   * **This used to be implicit, and the implication was "both".** The datum was
   * written once and every reader mirrored it — `stairAt` on `Math.abs(x)`, the
   * loft on a `[1, -1]` loop — which was exactly right while the two flights
   * were one description. It stopped being right when the port one became the
   * way *down*: see `COMPANION_X`. A pair of ladders at a break is the norm and
   * the ship gave one up deliberately, so the fact is now stated rather than
   * assumed, and `ship-deck.test.ts` can ask whether the quarterdeck is still
   * reachable knowing there is only one route to it.
   */
  readonly sides: readonly (1 | -1)[];
}

/** Fore-and-aft depth of one tread. A foot is 0.30 m long; this is generous. */
const STAIR_TREAD_DEPTH = 0.28;

export const DECK_STAIRS: readonly DeckStair[] = [
  {
    name: 'quarterdeckLadder',
    zTop: QUARTERDECK_FORWARD_Z,
    zBottom: QUARTERDECK_FORWARD_Z + STAIR_TREAD_DEPTH * 2,
    /**
     * 0.40, in from 0.80 — the gap between the flights is now too narrow to
     * stand in.
     *
     * The mainmast passes through this flight's footprint 0.5 m forward of the
     * break, so the two flights cannot meet on the centreline. What was between
     * them was 1.6 m of nothing, and Ash's report was the exact failure mode
     * that invites: "sometimes I get stuck trying to walk up that gap and miss
     * the stairs." A gap wide enough to walk into and too short to climb is a
     * trap whatever else is true about it.
     *
     * The number is the mast's collider radius plus a body's, so any body that
     * has squeezed past the mast is *already standing on a flight*. Below the
     * mast's partner collar it would cut through drawn timber; above the sum it
     * leaves a channel again. `ship-deck.test.ts` derives both bounds rather
     * than restating this one.
     */
    xInboard: 0.4,
    outboardClearance: 0.02,
    risers: 3,
    // Starboard only. Ash's call: the helm is up here and this is the way to
    // it, while the port side of the break is now the way below.
    sides: [-1],
  },
];

/** Drawn treads in a flight: one fewer than its risers. */
export function stairTreadCount(stair: DeckStair): number {
  return stair.risers - 1;
}

/**
 * The flight's outboard edge at a station — the deck edge, less its clearance.
 *
 * Read from the same `deckHalfWidth` the walker is bounded by, so the ladder
 * cannot stand proud of the planking it is bolted to however the sheer moves.
 */
export function stairOutboardX(stair: DeckStair, zParam: number): number {
  const level = deckLevelAt(zParam);
  return Math.max(
    deckHalfWidth(zParam, level) - stair.outboardClearance,
    stair.xInboard + 0.2,
  );
}

/**
 * The two decks a flight joins, measured on the beam line through `x`.
 *
 * **Through `x`, because the deck is not flat.** It is crowned 1/50 of its beam
 * — 90 mm over the half-width here — so a flight whose treads are flat planes
 * sits level with the planking along exactly one line and tilts away from it
 * everywhere else. Against a cambered deck that reads as steps built crooked,
 * which is what Ash saw: the flight looked sloped sideways even though every
 * tread was perfectly horizontal. Horizontal was the fault.
 *
 * Taking the heights at each `x` instead gives treads that carry the deck's own
 * camber, so a flight is parallel to the planking at every point of its width
 * and the last step onto the quarterdeck is the same height all the way across.
 */
export function stairEndHeights(stair: DeckStair, x: number): { footY: number; headY: number } {
  const foot = deckLevelAt(stair.zBottom);
  const head = deckLevelAt(stair.zTop - 1e-6);
  const footW = deckHalfWidth(stair.zBottom, foot);
  const headW = deckHalfWidth(stair.zTop, head);
  const ax = Math.abs(x);
  const footU = footW > 1e-6 ? Math.min(ax / footW, 1) : 0;
  const headU = headW > 1e-6 ? Math.min(ax / headW, 1) : 0;
  return {
    footY:
      levelWalkingY(stair.zBottom, foot) +
      deckCamberHeight(stair.zBottom, foot) * (1 - footU * footU),
    headY:
      levelWalkingY(stair.zTop, head) +
      deckCamberHeight(stair.zTop, head) * (1 - headU * headU),
  };
}

/** Top surface of tread `index` on the beam line through `x`; 1 is the bottom step. */
export function stairTreadY(stair: DeckStair, index: number, x: number): number {
  const { footY, headY } = stairEndHeights(stair, x);
  return footY + (headY - footY) * (index / stair.risers);
}

/** Aft and forward limits of tread `index`, parameter z. */
/**
 * Aft and forward limits of tread `index`, parameter z.
 *
 * **The bottom tread is the one furthest from the break.** A flight climbs
 * toward the raised deck, so the tallest step stands against it and the shortest
 * is out in the waist where you step on first.
 *
 * This was inverted, and the inversion is the exact fault this file's header is
 * about. `stairTreadIndexAt` maps a position to a tread and the loft maps a
 * tread to a position, and the two were written separately: the walker climbed a
 * correct flight while the drawn timber descended toward the quarterdeck, with
 * its tallest step standing alone in the middle of the deck. Ash saw it
 * immediately. They are inverses of one another now, and
 * `ship-deck.test.ts` walks the round trip.
 */
export function stairTreadZ(stair: DeckStair, index: number): { zAft: number; zForward: number } {
  const depth = (stair.zBottom - stair.zTop) / stairTreadCount(stair);
  return {
    zAft: stair.zBottom - depth * index,
    zForward: stair.zBottom - depth * (index - 1),
  };
}

/** Tread under a station: 1 at the foot of the flight, the topmost at its head. */
export function stairTreadIndexAt(stair: DeckStair, zParam: number): number {
  const count = stairTreadCount(stair);
  const t = (stair.zBottom - zParam) / (stair.zBottom - stair.zTop);
  return Math.min(Math.max(Math.ceil(t * count), 1), count);
}

/** How far outside a flight still counts as on it — the deck-edge tolerance. */
const STAIR_EDGE_TOLERANCE = 1e-4;

/** The flight under a ship-local position, or null. Either side of the ship. */
function stairAt(x: number, zParam: number): { stair: DeckStair; y: number } | null {
  const ax = Math.abs(x);
  const hand = x >= 0 ? 1 : -1;
  for (const stair of DECK_STAIRS) {
    if (!stair.sides.includes(hand)) continue;
    if (ax < stair.xInboard - STAIR_EDGE_TOLERANCE) continue;
    if (ax > stairOutboardX(stair, zParam) + STAIR_EDGE_TOLERANCE) continue;
    if (zParam < stair.zTop - STAIR_EDGE_TOLERANCE) continue;
    if (zParam > stair.zBottom + STAIR_EDGE_TOLERANCE) continue;
    return { stair, y: stairTreadY(stair, stairTreadIndexAt(stair, zParam), x) };
  }
  return null;
}

/** Where a walker is standing: the answer `deckStandAt` gives. */
export interface DeckStand {
  /** Height of the walking surface under the query, above the baseline. */
  readonly y: number;
  /** The flight of steps under the query, if the surface is one. */
  readonly stair: DeckStair | null;
  /** The level the query belongs to. */
  readonly level: DeckLevel;
  /** Parameter station the placed z corresponds to. */
  readonly zParam: number;
  /** Walkable half-width there, to the inboard face of the bulwark. */
  readonly halfWidth: number;
  /** Across-beam fraction of the query, ±1 at the bulwark. */
  readonly u: number;
}

/** Height of the deck at a parameter station, on the beam line through `x`. */
function surfaceYAt(zParam: number, x: number): number {
  const level = deckLevelAt(zParam);
  const w = deckHalfWidth(zParam, level);
  const u = w > 1e-6 ? Math.max(Math.min(x / w, 1), -1) : 0;
  return levelWalkingY(zParam, level) + deckCamberHeight(zParam, level) * (1 - u * u);
}

/**
 * How close to a break still counts as being on both of its levels.
 *
 * A millimetre. The break is a line, and a query on it — the drawn deck has
 * vertices exactly there, and float32 puts some of them a hundred nanometres to
 * the wrong side — belongs to the deck the walker can actually stand on rather
 * than to whichever level's inequality happens to win.
 */
export const BREAK_TOLERANCE = 1e-3;

/** Where the deck of parameter station `zParam` actually lands. */
function placedZ(zParam: number, x: number): number {
  return zParam - counterRakeShift(zParam, surfaceYAt(zParam, x));
}

/**
 * Invert the counter rake: the parameter station whose deck lands at placed `z`,
 * or `null` if no station's deck lands there at all.
 *
 * Forward of where the shear begins there is nothing to invert and the two
 * coordinates are the same number. Abaft it, `placedZ` is a strictly increasing
 * function of the station — the rake grows aft but never faster than the station
 * moves — so the station is found by bisection.
 *
 * WHY NOT THE OBVIOUS FIXED-POINT ITERATION
 * -----------------------------------------
 * `zParam = z + shift(zParam)` is the natural way to write this and it does not
 * converge here. The shear's ramp is a smoothstep whose slope reaches ≈0.6 per
 * metre right where the quarterdeck is, so the iteration *oscillates* about the
 * answer, losing about a third of its error per pass. Five passes left it 0.3 m
 * out at the taffrail, which reads as the after end of the quarterdeck not being
 * deck at all — the drawn mesh caught it, because the loft had placed vertices
 * there and this file answered that they had no floor under them.
 *
 * Bisection over the whole after body converges to a micrometre in 24 passes and
 * cannot oscillate. It also gives the boundary for free: a position abaft where
 * the sternpost station places its own deck is not on the ship, and that is what
 * `null` means here.
 */
function deckParamZ(z: number, x: number): number | null {
  if (z > HALF_LENGTH) return null;
  if (z >= COUNTER_SHEAR_START_Z) return z;

  let lo = -HALF_LENGTH;
  let hi = COUNTER_SHEAR_START_Z;
  // The aftmost deck line, with a millimetre of tolerance. Nothing about the
  // edge of the counter is precise to better than that, and a query taken from
  // a drawn vertex has been through float32 on the way — which is enough to put
  // the last row of the deck a micrometre outside its own surface.
  const aftmost = placedZ(lo, x);
  if (z < aftmost) return z < aftmost - 1e-3 ? null : lo;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (placedZ(mid, x) < z) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * The **deck itself** at a ship-local position: lofted planking, nothing on it.
 *
 * WHY THIS IS A SEPARATE QUESTION FROM `deckStandAt`
 * -------------------------------------------------
 * `deckStandAt` answers *"what can a body stand on here"*, and so it must
 * include things that stand **on** the deck — today a stair tread, tomorrow a
 * hatch lid. That is right for feet and wrong for anything asking about the
 * timber, and below decks the difference is a whole storey.
 *
 * The rooms had no other expression to ask, so they asked this one, and under
 * the two quarterdeck ladders the wardroom's *ceiling* came back as the top of
 * a staircase: 0.35 m of headroom that does not exist, a doorway head drawn
 * 0.27 m proud of the weather deck, and — because a deck lofted one-sided is
 * invisible from below — open sky visible from inside the ship through a door.
 * Ash walked into the landing and saw the sea and the rigging through the
 * wardroom's doorway.
 *
 * **It is `hullForm.cabinHeadroomAt` again**, which M4 recorded in the same
 * words: a question about the room asked of a module that cannot answer it, so
 * the only available answer was the wrong one. The fix both times is to make the
 * right answer available rather than to correct the arithmetic.
 */
export function deckOverheadAt(x: number, z: number): DeckStand | null {
  return lofted(x, z);
}

/**
 * The walking surface under a ship-local position, or `null` off the deck.
 *
 * `null` means the query is outside the bulwarks or beyond the ends — not that
 * it is above or below the deck. Height is answered for the whole column, so a
 * walker who is momentarily airborne still knows what it will land on.
 */
export function deckStandAt(x: number, z: number): DeckStand | null {
  const deck = lofted(x, z);
  if (!deck) return null;
  const stair = stairAt(x, deck.zParam);
  // A flight stands on the lower deck, so its tread is the surface wherever it
  // is the higher of the two. Taking the maximum rather than replacing means the
  // query is continuous at the flight's edges.
  if (stair && stair.y > deck.y) {
    return { ...deck, y: stair.y, stair: stair.stair };
  }
  return deck;
}

function lofted(x: number, z: number): DeckStand | null {
  const zParam = deckParamZ(z, x);
  if (zParam === null) return null;

  // Every level that reaches this station, highest first.
  //
  // At a break two levels do: the quarterdeck begins exactly where the waist
  // ends. They are not the same width there — the quarterdeck is 0.55 m higher
  // and the bulwark tumbles home, so it is 0.07 m narrower each side — and a
  // walker standing in that 0.07 m at the foot of the riser is on the waist. A
  // single-level lookup answers "no deck" there, which is a hole at the break
  // wide enough to fall through and exactly one vertex wide in the drawn mesh,
  // which is where it was found.
  let level: DeckLevel | null = null;
  let halfWidth = 0;
  let u = 0;
  let deckY = -Infinity;
  for (const candidate of DECK_LEVELS) {
    if (zParam < candidate.z0 - BREAK_TOLERANCE) continue;
    if (zParam > candidate.z1 + BREAK_TOLERANCE) continue;
    const w = deckHalfWidth(zParam, candidate);
    if (w <= 1e-6) continue;
    // A tenth of a millimetre of tolerance at the deck edge, for the same reason
    // the counter has a millimetre: the drawn edge lands on this boundary
    // exactly, and a float32 vertex position does not survive that exactly.
    if (Math.abs(x) > w + 1e-4) continue;
    const candidateU = Math.max(Math.min(x / w, 1), -1);
    const y =
      levelWalkingY(zParam, candidate) +
      deckCamberHeight(zParam, candidate) * (1 - candidateU * candidateU);
    if (y <= deckY) continue;
    level = candidate;
    halfWidth = w;
    u = candidateU;
    deckY = y;
  }
  if (!level) return null;
  return { y: deckY, stair: null, level, zParam, halfWidth, u };
}
