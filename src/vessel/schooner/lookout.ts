import { DEFAULT_WALKER_TUNING } from '../../player/DeckWalker';
import {
  RATLINES,
  RATLINE_DIAMETER,
  RATLINE_SPACING,
  crosstreeArmTopY,
  crosstreeArmUnderY,
  crosstrees,
  mastSectionAt,
  rigNode,
} from './rig';
import type { Crosstrees } from './rig';
import { v3 } from './shipwright';
import type { Vec3 } from './shipwright';

/**
 * The foremast lookout — the platform, the way up onto it, and the ropes that
 * stop a body going off it.
 *
 * `docs/ship/SHIP_SPEC.md` §15 asks for "crosstrees or a modest lower topmast
 * platform; a small expedition-modified lookout position; rope lifelines; room
 * for one person to pause". M2 built the frame — `CROSSTREES` — and M5 planks
 * it, rails it, and rigs the last twelve feet of the way up to it.
 *
 * WHY THIS IS NOT IN `rig.ts`
 * ---------------------------
 * Two reasons, and the second is a behaviour change avoided rather than taste.
 *
 * The futtock shrouds below are rope, and the obvious home for rope is
 * `STANDING_RIGGING`. But `RIG_TRIM_LIMITS` is *derived* from that list at
 * module load — `braceSwingLimitRad()` sweeps the yards against every run in it
 * — and the lower yard swings at 12.45 m, which is exactly the band these
 * futtocks occupy. Four short ropes added to that list would have moved the
 * square topsail's legal brace angle, silently, as a side effect of building a
 * ladder. They belong to the platform, so they live with the platform.
 *
 * The first reason is smaller and still real: `rig.ts` is the graph of the ship
 * as she was rigged, and this is a fitting bolted to one part of it.
 *
 * WHAT THE PLATFORM IS ALLOWED TO BE, AND WHAT DECIDED IT
 * -------------------------------------------------------
 * Not much, and the **fore gaff** decided it rather than taste. The gaff rises
 * aft from its throat at 11.90 m and sweeps through ±51.5° (`RIG_TRIM_LIMITS`),
 * so the region it passes *under* is a sector: at horizontal distance `d` from
 * the throat its upper surface stands at about `11.98 + 0.77 d`, which reaches
 * the underside of this planking at `d ≈ 0.97 m`. Every corner of the platform
 * therefore has to be either inside that radius or outside the sector, and
 * `tests/ship-aloft.test.ts` sweeps the whole trim envelope rather than trusting
 * the arithmetic in this paragraph.
 *
 * The answer that falls out is 1.70 m athwartships by 0.57 m fore-and-aft, laid
 * over the two crosstree arms and stopping short of the after one — **a platform
 * that holds exactly one body with 25 mm to spare at each end.** §15's "no large
 * barrel-shaped pirate crow's nest" is met by arithmetic rather than restraint,
 * and `LOOKOUT_Z_AFT` carries the table that decided the after edge.
 *
 * THERE IS NO LUBBER'S HOLE, AND THAT IS THE GEOMETRY TALKING
 * -----------------------------------------------------------
 * A hole through a top is the kind way up, and this top cannot have one. Two
 * trestletrees and two crosstree arms fill its 0.70 m of fore-and-aft frame, so
 * there is no 0.4 m square of it that is not structure carrying the topmast.
 * Worse, all six fore shrouds converge on `foreHounds` — one point on the
 * masthead — so the gang arrives at the top *at the mast*, around z ≈ 3.46,
 * which is precisely where the forward arm and the doubling are. There is
 * nowhere a hole could be that is both clear of the frame and under the ladder.
 *
 * So the way up is on futtock shrouds, over the edge. That is what a small top
 * without a hole has always meant, and it is the more dramatic of the two —
 * which §15's accept-when asks for in as many words. *Which* edge is not a free
 * choice either: see `futtockHeads`, where the fore lower yard takes the
 * outboard rim away as well.
 */

/** Which of the rig's four draw regions a piece belongs to. */
export type LookoutRegion = 'spar' | 'rope' | 'ironwork';

export type LookoutSolid =
  | { readonly kind: 'box'; readonly centre: Vec3; readonly half: Vec3; readonly region: LookoutRegion }
  | {
      readonly kind: 'bar';
      readonly a: Vec3;
      readonly b: Vec3;
      readonly radius: number;
      readonly region: LookoutRegion;
    };

/** How thick the planking is, metres. Deal, laid fore-and-aft on the arms. */
const PLANK_THICKNESS = 0.032;

/**
 * Futtock shroud diameter, metres.
 *
 * Lighter than the 0.036 m shrouds they set up from and heavier than the
 * 0.017 m ratlines seized across them: a futtock carries a man's whole weight
 * at a lean and nothing else.
 */
const FUTTOCK_DIAMETER = 0.026;

/** The top this all hangs on. */
export const LOOKOUT_TOP: Crosstrees = crosstrees('foreCrosstrees');

/**
 * The walking surface, ship-local.
 *
 * `crosstreeArmTopY` and not `LOOKOUT_TOP.y`: `y` is the trestletrees'
 * centreline and the arms stand 0.13 m proud of it. That difference is a body's
 * feet either on the planking or inside it, which is why `rig.ts` publishes the
 * arithmetic instead of the loft keeping it to itself.
 */
export const LOOKOUT_DECK_Y = crosstreeArmTopY(LOOKOUT_TOP) + PLANK_THICKNESS;

/** Half-breadth of the planking — the arms' own reach, and no more. */
export const LOOKOUT_HALF_SPAN = LOOKOUT_TOP.halfSpan;

/**
 * The after edge, and it is the fore gaff's number rather than the frame's.
 *
 * The structural answer would be the after crosstree arm's after face, 2.987 —
 * planking is carried by the beams under it and does not hang past the last
 * one. **Measured, that leaves 10 mm to the swung gaff**, which is not a
 * clearance, it is a coincidence. Pulling the edge forward buys clearance fast
 * and standing room slowly, because the gaff comes at the after-outboard corner
 * diagonally from below:
 *
 * | after edge | gaff to planking | fore-and-aft slack for a body |
 * |---|---|---|
 * | 2.987 | **10 mm** | 112 mm |
 * | 3.020 | 35 mm | 79 mm |
 * | **3.050** | **59 mm** | **49 mm** |
 * | 3.080 | 82 mm | 19 mm |
 * | 3.099 | 96 mm | none |
 *
 * 3.05 is the row where a spar is no longer nearly touching a floor and a body
 * still fits on it. `tests/ship-aloft.test.ts` re-derives the whole table rather
 * than believing it, and asserts the value from *both* sides: it is far enough
 * forward to clear the gaff, and not so far forward that the room for one person
 * §15 asks for has been given away for margin nobody needed.
 *
 * The 49 mm is worth reading twice. **The fore top holds exactly one body, with
 * two and a half centimetres to spare at each end**, and it is the foresail's
 * ±51.5° of ease that makes it so. That is not a number to design against
 * casually — it is the reason this platform is the size it is, and the reason
 * the stance below is derived rather than placed.
 */
export const LOOKOUT_Z_AFT = 3.05;

/** What the table above was solved for: the least gap the gaff may leave. */
export const GAFF_CLEARANCE = 0.05;

/** The forward edge: the top's own, which M2 already vetted against the topsail. */
export const LOOKOUT_Z_FORWARD = LOOKOUT_TOP.z + LOOKOUT_TOP.length / 2;

/** Underside of the planking — what a swung gaff has to pass below. */
export const LOOKOUT_UNDER_Y = crosstreeArmTopY(LOOKOUT_TOP);

/** The arms' own underside, which is lower and is the tighter of the two. */
export const LOOKOUT_ARM_UNDER_Y = crosstreeArmUnderY(LOOKOUT_TOP);

/**
 * How high the lifelines stand above the planking, metres.
 *
 * 1.00 m to the upper rope and half that to the lower. A lifeline is not a guard
 * rail: it is what you put an arm over and lean against, so it belongs at the
 * chest of a 1.75 m body rather than at the waist. The lower one exists so that
 * a body that has gone down on one knee — which is what a body aloft does when
 * she rolls — still has something between it and the sea.
 */
export const LIFELINE_HEIGHT = 1.0;
const LOWER_LIFELINE_FRACTION = 0.5;
const STANCHION_RADIUS = 0.016;
const LIFELINE_RADIUS = RATLINE_DIAMETER / 2;

/**
 * Where the doubling stands at a height — the lower mast and the topmast taken
 * as one obstruction, because at the top they overlap.
 *
 * A body may not stand in it and the eye may not be inside it. Both are
 * measured in `tests/ship-aloft.test.ts` rather than eyeballed.
 */
export function doublingAt(y: number): { zAft: number; zForward: number; halfBreadth: number } {
  const lower = mastSectionAt('foremast', y);
  const upper = mastSectionAt('foreTopmast', y);
  return {
    zAft: Math.min(lower.z - lower.radius, upper.z - upper.radius),
    zForward: Math.max(lower.z + lower.radius, upper.z + upper.radius),
    halfBreadth: Math.max(lower.radius, upper.radius),
  };
}

/**
 * Where the lookout stands, derived rather than chosen.
 *
 * The free rectangle is the planking less a body's radius on every side, less
 * the doubling that runs up through the middle of it; the stance is the centre
 * of whichever half of it the climber came up. Writing the two numbers here
 * instead would be two facts that stop being true the first time the planking,
 * the body or the mast's rake moves — and all three are quantities other rounds
 * change.
 *
 * **Port and starboard are one expression with a sign, not two rows.** This hull
 * has already paid for the alternative: `xLo` and `xHi` invert across the
 * centreline, and a mirrored pair typed out by hand is where that inversion gets
 * forgotten.
 */
export function lookoutStandPosition(side: 1 | -1): { x: number; z: number } {
  const r = DEFAULT_WALKER_TUNING.radius;
  const doubling = doublingAt(LOOKOUT_DECK_Y);
  const xInner = doubling.halfBreadth + r;
  const xOuter = LOOKOUT_HALF_SPAN - r;
  const zAft = LOOKOUT_Z_AFT + r;
  const zForward = LOOKOUT_Z_FORWARD - r;
  return { x: side * (xInner + xOuter) * 0.5, z: (zAft + zForward) * 0.5 };
}

/** The eye of a body standing there — the same body that walks the deck. */
export function lookoutEye(side: 1 | -1): Vec3 {
  const stand = lookoutStandPosition(side);
  return v3(stand.x, LOOKOUT_DECK_Y + DEFAULT_WALKER_TUNING.eyeHeight, stand.z);
}

/**
 * How far a climber's eye is above the rung their feet are on, metres.
 *
 * 1.48, against the 1.60 of the same body standing on a deck. The difference is
 * the crouch: a body on a ladder has its knees bent and its weight forward, and
 * a climb presented at full standing height reads as a man being winched up.
 * Derived from the walker's own eye rather than authored free, so the two bodies
 * cannot become different men.
 *
 * It lives here rather than in `riggingClimb.ts` because the *platform* needs it
 * as well as the path: where the futtock stave goes is decided by where a
 * climber's head is, and a second copy of a body's height is the shape of fault
 * this hull removes rather than writes.
 */
export const EYE_ABOVE_RUNG = DEFAULT_WALKER_TUNING.eyeHeight - 0.12;

/** Is a horizontal position on the planking? Used by the standing-room gate. */
export function onLookoutPlanking(x: number, z: number): boolean {
  if (z < LOOKOUT_Z_AFT || z > LOOKOUT_Z_FORWARD) return false;
  return Math.abs(x) <= LOOKOUT_HALF_SPAN;
}

// --- the way up: a futtock stave, futtock shrouds, and rungs across them -----

/** How many shrouds a fore gang has — `rig.ts`'s `FORE_SHROUD_PAIRS`, read back. */
const FORE_GANG_SHROUDS = 3;

function gangFoot(side: 1 | -1): Vec3 {
  const label = side > 0 ? 'Port' : 'Starboard';
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < FORE_GANG_SHROUDS; i++) {
    const seat = rigNode(`foreChannel${label}${i}`);
    x += seat.x;
    y += seat.y;
    z += seat.z;
  }
  return v3(x / FORE_GANG_SHROUDS, y / FORE_GANG_SHROUDS, z / FORE_GANG_SHROUDS);
}

/**
 * The centreline of a shroud gang, as a straight line from the channel to the
 * masthead.
 *
 * A gang's three shrouds land on deadeyes spread 0.76 m along the channel and
 * converge on one point at the hounds, so "where the gang is" at a height is the
 * mean of the three — which is the line a body climbing the middle of the
 * ratlines is on. Everything above the deck in this file is measured off it, and
 * so is the climb spline.
 */
export function foreGangAt(side: 1 | -1, y: number): Vec3 {
  const foot = gangFoot(side);
  const head = rigNode('foreHounds');
  const t = (y - foot.y) / (head.y - foot.y);
  return v3(foot.x + (head.x - foot.x) * t, y, foot.z + (head.z - foot.z) * t);
}

/** Where the gang starts — the mean of its three deadeye seats. */
export function foreGangFoot(side: 1 | -1): Vec3 {
  return gangFoot(side);
}

/**
 * The line up the **gap** between the forward and middle shrouds of a gang.
 *
 * A body does not climb through a shroud, it climbs between two of them, and
 * that turns out to be a measurement rather than a nicety. The gang's centreline
 * — the mean of three seats 0.38 m apart — lies exactly along the *middle*
 * shroud, so a climb authored on it puts the eye 62 mm from a 36 mm rope as it
 * comes over the rail. The near plane is 60 mm. Measured, found, and moved: the
 * eye rides the gap, which is where a pair of hands go.
 *
 * Both shrouds converge on the same masthead, so the gap closes as the ladder
 * narrows and this line meets the centreline at the hounds by itself. There is
 * no offset to taper.
 */
export function foreGangGapAt(side: 1 | -1, y: number): Vec3 {
  const label = side > 0 ? 'Port' : 'Starboard';
  const head = rigNode('foreHounds');
  let x = 0;
  let z = 0;
  for (const i of [0, 1]) {
    const seat = rigNode(`foreChannel${label}${i}`);
    const t = (y - seat.y) / (head.y - seat.y);
    x += seat.x + (head.x - seat.x) * t;
    z += seat.z + (head.z - seat.z) * t;
  }
  return v3(x / 2, y, z / 2);
}

/** Every fore ratline of one side, lowest first. */
export function foreRungsY(side: 1 | -1): number[] {
  const label = side > 0 ? 'Port' : 'Starboard';
  return RATLINES.filter((rung) => rung.name.startsWith(`foreRatline${label}`))
    .map((rung) => rung.y)
    .sort((a, b) => a - b);
}

/** How much daylight the climber's head keeps under the planking, metres. */
const STAVE_HEAD_MARGIN = 0.1;

/**
 * Half the stave's length, metres.
 *
 * The gang is 0.76 m of channel at the deck and converges to a point at the
 * hounds; by the stave's height it spans about 0.1 m, so the batten reaches well
 * past the outer shrouds rather than sitting between them — which is what a
 * seizing needs, and what gives the two futtocks somewhere to set up from.
 */
const STAVE_HALF_LENGTH = 0.22;

/**
 * Height of the futtock stave — the batten seized across a gang that the futtock
 * shrouds set up from, and therefore the rung at which a body stops climbing
 * upward and starts leaning outward.
 *
 * **DERIVED, AND THE DERIVATION IS THE WHOLE REASON THE CLIMB WORKS.**
 *
 * The first cut of this put it at a round 11.6 m, which is where a stave looks
 * right, and the climb came out with the eye passing *through the planking*. The
 * arithmetic is unforgiving. A body's eye is 1.48 m above the rung it stands on;
 * the underside of this platform is at 12.73; so the eye reaches the planking
 * when the feet are at 11.25. And at 11.25 the gang — which converges on the
 * masthead — is only 0.39 m off the centreline, well inside a platform whose
 * half-span is 0.85. **A body that is still on the gang when its head reaches
 * the top's level has its head inside the top.**
 *
 * There is no way round that by leaning: the whole rise of the futtocks is
 * 1.6 m, so a body that starts out on them at 11.25 is barely off the vertical
 * by the time its eye crosses. It has to leave the gang *before* then. So the
 * stave is the highest drawn ratline whose eye still clears the planking's
 * underside, with a hand's breadth of margin — 11.117 m, which is a rung and not
 * a round number, and which is what the geometry says rather than what looks
 * right.
 *
 * The gang goes on being rattled down above it, as it should: a man going to the
 * masthead itself keeps climbing. The climb spline does not.
 */
export const FUTTOCK_STAVE_Y = (() => {
  const ceiling = LOOKOUT_UNDER_Y - EYE_ABOVE_RUNG - STAVE_HEAD_MARGIN;
  const rungs = foreRungsY(1).filter((y) => y <= ceiling);
  if (rungs.length === 0) throw new Error('no ratline low enough to swing out from');
  return rungs[rungs.length - 1];
})();

/**
 * THE ONE CORNER OF THIS TOP THAT IS NOT ALREADY OCCUPIED
 * -------------------------------------------------------
 * The obvious place for futtock shrouds is the outboard rim beside the
 * crosstree arms, and it is the one place they cannot go. **The fore lower yard
 * is slung at 12.45 m, immediately under the top, and it is 7.5 m long.** Braced
 * hard it swings its arms aft: measured, its after face passes z = 3.35 at
 * 1.0 m off the centreline and z = 3.38 at 0.7 m — which is exactly where a
 * futtock leaning out to the forward arm would be. The first cut of these ran
 * 38 mm *inside* the yard at full brace.
 *
 * Above the yard there is 95 mm of daylight before the crosstree arms, which is
 * not a gap a head goes through. Below and aft, the fore gaff owns everything
 * within 0.97 m of its throat. What is left is **the after-outboard corner**:
 * abaft the yard's sweep, outboard of the gaff's sector, and under the one edge
 * of the planking with nothing over it.
 *
 * So the futtocks land on the platform's **after edge**, spread athwartships,
 * and the climb comes up abaft the top rather than beside it. That is not a
 * compromise dressed up — a top with a yard under it and a gaff behind it has
 * one way in, and this is it.
 */

/** How far apart the two futtocks are where they land, metres. */
const FUTTOCK_SPREAD = 0.3;

/** Where each futtock shroud lands: the after edge, outboard end first. */
export function futtockHeads(side: 1 | -1): readonly Vec3[] {
  return [LOOKOUT_HALF_SPAN, LOOKOUT_HALF_SPAN - FUTTOCK_SPREAD].map((x) =>
    v3(side * x, LOOKOUT_UNDER_Y, LOOKOUT_Z_AFT),
  );
}

/**
 * Where they set up from: the two ends of the stave, after end first.
 *
 * Paired with the heads in the same order, so the outboard futtock is the after
 * one all the way up and the two never cross. A crossed pair is not a ladder,
 * and it is the sort of thing that looks fine in one view and wrong in the next.
 */
export function futtockFeet(side: 1 | -1): readonly Vec3[] {
  const stave = foreGangGapAt(side, FUTTOCK_STAVE_Y);
  return [
    v3(stave.x, stave.y, stave.z - STAVE_HALF_LENGTH),
    v3(stave.x, stave.y, stave.z + STAVE_HALF_LENGTH),
  ];
}

/** The middle of the stave, which is the hold a foot uses. */
export function futtockFoot(side: 1 | -1): Vec3 {
  return foreGangGapAt(side, FUTTOCK_STAVE_Y);
}

/**
 * The rungs across the futtocks, at the ratlines' own spacing.
 *
 * The arithmetic is the gate rather than the look: without them the 1.65 m from
 * the stave to the rim is one step a body cannot make, and
 * `tests/ship-aloft.test.ts` says so by measuring the gaps between holds. The
 * last one is deliberately close under the rim — the step off a futtock onto a
 * platform is the one a body is least able to make long.
 */
export function futtockRungY(): number[] {
  const out: number[] = [];
  for (let y = FUTTOCK_STAVE_Y + RATLINE_SPACING; y < LOOKOUT_UNDER_Y - 0.04; y += RATLINE_SPACING) {
    out.push(y);
  }
  return out;
}

/** A point on one of the two futtocks of a side, at a height. */
export function futtockAt(side: 1 | -1, y: number, index: 0 | 1): Vec3 {
  const foot = futtockFeet(side)[index];
  const head = futtockHeads(side)[index];
  const t = (y - foot.y) / (head.y - foot.y);
  return v3(foot.x + (head.x - foot.x) * t, y, foot.z + (head.z - foot.z) * t);
}

// --- the drawn thing ---------------------------------------------------------

function box(centre: Vec3, half: Vec3, region: LookoutRegion): LookoutSolid {
  return { kind: 'box', centre, half, region };
}

function bar(a: Vec3, b: Vec3, radius: number, region: LookoutRegion): LookoutSolid {
  return { kind: 'bar', a, b, radius, region };
}

/**
 * Every piece of the lookout, in ship-local coordinates.
 *
 * **Nothing here has a collider**, and that is `SHIP_ROUND_HANDOVER.md` §3.4
 * rather than an oversight: traversal aloft is authored, so the walker never
 * comes within eight metres of any of it and a collider would be a cost with no
 * consumer. `tests/ship-aloft.test.ts` asserts the whole of it stands above the
 * obstacle index's own ceiling, so the claim is measured, not asserted in prose.
 */
export function lookoutSolids(): LookoutSolid[] {
  const out: LookoutSolid[] = [];
  const halfDepth = (LOOKOUT_Z_FORWARD - LOOKOUT_Z_AFT) / 2;
  const midZ = (LOOKOUT_Z_FORWARD + LOOKOUT_Z_AFT) / 2;
  const deckMidY = LOOKOUT_DECK_Y - PLANK_THICKNESS / 2;
  const doubling = doublingAt(LOOKOUT_DECK_Y);

  // The planking, in two halves with the doubling between them. One box across
  // the whole span would have been planking through the mast — the mast is what
  // a top is *for*, and the platform is fitted round it.
  for (const side of [1, -1] as const) {
    const inner = side * doubling.halfBreadth;
    const outer = side * LOOKOUT_HALF_SPAN;
    out.push(
      box(
        v3((inner + outer) / 2, deckMidY, midZ),
        v3(Math.abs(outer - inner) / 2, PLANK_THICKNESS / 2, halfDepth),
        'spar',
      ),
    );
  }

  // Four stanchions and two ropes round the outboard and after edges. The
  // forward edge is left open because the doubling closes it: a rope across it
  // would have to pass through the topmast, and there is nowhere to fall.
  for (const side of [1, -1] as const) {
    for (const z of [LOOKOUT_Z_AFT, LOOKOUT_Z_FORWARD]) {
      const foot = v3(side * LOOKOUT_HALF_SPAN, LOOKOUT_DECK_Y, z);
      out.push(bar(foot, v3(foot.x, foot.y + LIFELINE_HEIGHT, foot.z), STANCHION_RADIUS, 'ironwork'));
    }
  }
  for (const fraction of [LOWER_LIFELINE_FRACTION, 1]) {
    const y = LOOKOUT_DECK_Y + LIFELINE_HEIGHT * fraction;
    for (const side of [1, -1] as const) {
      out.push(
        bar(
          v3(side * LOOKOUT_HALF_SPAN, y, LOOKOUT_Z_FORWARD),
          v3(side * LOOKOUT_HALF_SPAN, y, LOOKOUT_Z_AFT),
          LIFELINE_RADIUS,
          'rope',
        ),
      );
    }
    // Across the after edge, which is the one a body backs into.
    out.push(
      bar(
        v3(LOOKOUT_HALF_SPAN, y, LOOKOUT_Z_AFT),
        v3(-LOOKOUT_HALF_SPAN, y, LOOKOUT_Z_AFT),
        LIFELINE_RADIUS,
        'rope',
      ),
    );
  }

  for (const side of [1, -1] as const) {
    const feet = futtockFeet(side);
    const heads = futtockHeads(side);
    // The stave: a batten seized across the gang. It is what the futtocks set up
    // from and what stops them pulling the shrouds together.
    out.push(bar(feet[0], feet[1], LIFELINE_RADIUS, 'ironwork'));
    for (let i = 0; i < heads.length; i++) {
      out.push(bar(feet[i], heads[i], FUTTOCK_DIAMETER / 2, 'rope'));
    }
    for (const y of futtockRungY()) {
      out.push(bar(futtockAt(side, y, 0), futtockAt(side, y, 1), LIFELINE_RADIUS, 'rope'));
    }
  }

  return out;
}

