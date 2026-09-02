/**
 * The state the world is in when someone who is not Ash opens the page.
 *
 * Every number a first frame needs used to be a literal at the top of
 * `main.ts`, and each one was chosen for a different afternoon's debugging: a
 * heading picked when the vessel was a towed raft, sheets left at the rig's
 * authored close-hauled trim because that is what the loft was drawn at, and
 * no standing order at the helm at all, so the tiller sat amidships and the
 * ship wandered off downwind while the player worked out what the controls
 * were.
 *
 * This module is that opening as one described situation. It is deliberately
 * *derived*: the heading is computed from the sea state's own swell and wind
 * headings rather than written down, so if the ocean is re-aimed the opening
 * follows it instead of silently becoming wrong. `tests/opening-voyage.test.ts`
 * checks the situation this produces — beam reach, sea on the bow, sailing
 * toward the setting sun — rather than checking the constants against
 * themselves.
 *
 * WHY THIS HEADING
 * ----------------
 * Three things want to agree at once, and one of them is not negotiable:
 *
 *  - the sails should *draw*, which means a reach, not a run and not the no-go
 *    arc — the polar's best speeds all live between 75° and 105° off the wind;
 *  - the swell should not be on the beam, because a beam sea rolls her
 *    continuously and reads as seasickness rather than as sailing;
 *  - the low sun should be somewhere in front, because this ocean is at its
 *    best backlit and the glitter path is the thing worth seeing first.
 *
 * The sea state now carries its breeze square across its swell (see
 * `presets.ts`), which is what makes the first two compatible at all: sail
 * along the swell axis and the wind is automatically abeam. Of the two ways to
 * point along that axis, this one takes the sea on the bow — she pitches
 * instead of rolling — and it is also the half that faces the sunset.
 */

import { findSeaState, PRODUCTION_SEA_STATE } from '../ocean/presets';
import type { SailName } from '../vessel/schooner/rig';
import { AUTHORED_TRIM_DEG } from '../vessel/schooner/SailingControls';
import { trueWindAngleDeg, wrapDegrees180 } from './WorldWind';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Open water in the Tasman Sea, some fifty kilometres off the New South Wales
 * coast, and the instant is a summer evening: the sun is on the horizon.
 */
export const OPENING_LATITUDE_DEG = -33.9;
export const OPENING_LONGITUDE_DEG = 151.9;
export const OPENING_UTC_SECONDS =
  Date.parse('2026-01-15T09:00:00.000Z') / 1000;

/**
 * Bow into the sea, wind abeam.
 *
 * The primary swell *travels* toward `primary.directionDeg`, so it arrives
 * from the reciprocal — and heading straight into it is exactly that bearing.
 * With the breeze square across the swell this is a beam reach by
 * construction, on whichever tack the geometry produces.
 */
export const OPENING_TRUE_HEADING_DEG = normaliseDeg(
  findSeaState(PRODUCTION_SEA_STATE).primary.directionDeg + 180,
);

export const OPENING_TRUE_HEADING_RAD = OPENING_TRUE_HEADING_DEG * DEG_TO_RAD;

/** The sheets the opening tack decides the side of. */
export const OPENING_TRIMMED_SAILS: readonly SailName[] = [
  'mainsail',
  'foresail',
  'foreStaysail',
  'jib',
  'flyingJib',
];

/**
 * The trims the ship is already carrying at the first frame.
 *
 * The *magnitudes* are the rig's own authored fan — 26° on the main easing
 * progressively to 37° on the flying jib — and they stay that way on purpose.
 * That fan is a sail plan, not a slider position: each sail further forward is
 * eased more because of what it does to the slot behind it, and flattening it
 * to one number would be redrawing the rig. It also happens to be the right
 * magnitude for this wind: `tests/opening-voyage.test.ts` reads the committed
 * polar's 4 and 8 m/s full-sail beam schedules and checks this fan's mean
 * against their interpolation at the production wind.
 * (The rig was drawn for a reach. What was wrong before was the *heading*: at
 * the old opening she was running dead downwind on sheets meant for a reach.)
 *
 * What this function decides is the **side**. A sheet is hauled to leeward, so
 * the sign of every trim is the mirror of the side the wind comes over, and
 * the tack is whatever the derived heading and the sea's wind produce. The
 * authored rig is a starboard-tack rig, so today this returns the authored
 * numbers unchanged — and if the ocean is ever re-aimed onto the other tack it
 * returns their mirror instead of leaving every sail aback.
 *
 * An initial condition, not an order: nobody watches the crew haul these in,
 * because they were hauled before the page loaded.
 */
export function openingTrimDeg(): Partial<Record<SailName, number>> {
  return trimDegForTrueWindAngle(openingTrueWindAngleDeg());
}

/**
 * The authored fan, sided for a signed true wind angle off the bow.
 *
 * Split out of `openingTrimDeg` rather than copied, because there is a second
 * caller now — the capture host, staging a named point of sail — and "which way
 * do the sheets go on this tack" is exactly the kind of one-line rule this
 * session watched get independently re-derived in three files. Positive angle is
 * the wind over the port side, so the sheets are hauled to starboard and every
 * sign is negative. See `trueWindAngleDeg`.
 */
export function trimDegForTrueWindAngle(
  trueWindAngleOffBowDeg: number,
): Partial<Record<SailName, number>> {
  const trims: Partial<Record<SailName, number>> = {};
  const windOverPort = trueWindAngleOffBowDeg > 0;
  for (const sail of OPENING_TRIMMED_SAILS) {
    const magnitude = Math.abs(AUTHORED_TRIM_DEG[sail]);
    trims[sail] = windOverPort ? -magnitude : magnitude;
  }
  return trims;
}

/** The standing course the helmsman is already holding when the page opens. */
export const OPENING_ORDERED_COURSE_DEG = OPENING_TRUE_HEADING_DEG;

/**
 * She is already making way — you are joining a passage, not a launching.
 *
 * The world used to open at the sail-down drift speed, which on a schooner
 * carrying full canvas means the first two minutes of anyone's first visit are
 * spent watching an 80-tonne hull accelerate from rest: no bow wave, no wake,
 * no sound of water, and a compass that barely answers the helm because the
 * rudder has almost no inflow. None of that is what the thing looks like.
 *
 * 3.0 m/s ≈ 5.9 knots is what she settles at on this reach in this wind —
 * measured in the running game and bracketed by the committed polar's 4 and
 * 8 m/s full-sail beam points. It is an initial condition and nothing more:
 * the force integration owns the speed from the first substep, so an imperfect
 * guess is corrected in seconds instead of over minutes.
 */
export const OPENING_SPEED_MPS = 3.0;

/** Signed true-wind angle off the bow at the opening heading, degrees. */
export function openingTrueWindAngleDeg(): number {
  return trueWindAngleDeg(
    OPENING_TRUE_HEADING_DEG,
    findSeaState(PRODUCTION_SEA_STATE).generatingWind.directionDeg,
  );
}

/** Signed angle of the primary swell's *source* off the bow, degrees. */
export function openingSwellAngleOffBowDeg(): number {
  const swellSourceDeg =
    findSeaState(PRODUCTION_SEA_STATE).primary.directionDeg + 180;
  return wrapDegrees180(OPENING_TRUE_HEADING_DEG - swellSourceDeg);
}

function normaliseDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
