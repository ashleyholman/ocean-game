import { WALKING_STABILISATION } from '../../camera/EmbodiedCameraController';
import type { HeadStabilisation } from '../../camera/EmbodiedCameraController';
import { DEFAULT_WALKER_TUNING } from '../../player/DeckWalker';
import { walkingDeckY } from './hullForm';
import { LOOKOUT_DECK_Y, LOOKOUT_HALF_SPAN, lookoutEye } from './lookout';
import { buildLoadedShip } from './massModel';
import { FOREMAST_Z } from './rig';

/**
 * What standing at the masthead costs, and how much of it reaches the eye.
 *
 * `docs/ship/SHIP_SPEC.md` §5.4 is the brief and it is blunt: *"This is not the
 * deck at altitude."* This module is the arithmetic behind that sentence, done
 * against the geometry as built rather than against the estimate in the
 * document, plus the one decision the milestone exists to make.
 *
 * WHY THE SPEC'S OWN TABLE IS 7% LOW, AND IT IS NOT A TYPO
 * --------------------------------------------------------
 * §5.4 works from "~11.5 m above the roll axis". Reconstructing its arithmetic
 * exactly — `11.5 · sin(20°) = 3.93 m`, `11.5 · 0.349 · ω = 4.23 m/s`,
 * `11.5 · 0.349 · ω² = 0.455 g`, all three of which reproduce the printed row —
 * shows the 11.5 was taken as *ten metres above the deck, roll axis near the
 * waterline*. The waterline is not the roll axis. **A free body rotates about
 * its centre of mass**, `BuoyantBody.transform` composes every rotation about
 * exactly that, and `massModel` puts it at y = 1.887 — 0.66 m lower than the
 * waterline the estimate assumed and 0.74 m lower than the figure it used.
 *
 * The lever is `ALOFT_LEVER` below, and it is 12.48 m: everything in §5.4's
 * table is about 8% larger than printed. That is not a correction worth
 * re-tuning the sea for; it is a correction worth knowing about before deciding
 * how much of it to show, which is what this module is for.
 *
 * ALL OF IT IS TRANSLATION, AND THAT IS THE WHOLE FINDING
 * -------------------------------------------------------
 * Roll and pitch are rigid-body attitudes. The masthead has **exactly** the
 * deck's — twenty degrees is twenty degrees whether you are standing on the
 * planking or ten metres over it — so there is nothing in §5.4 that says the
 * angular follow fractions should differ aloft, and a different number up here
 * would be a number with no cause. `ALOFT_STABILISATION` therefore inherits
 * `WALKING_STABILISATION`'s angles unchanged, and that is a decision rather
 * than an omission.
 *
 * What differs is the *position*, by the ratio of two levers: the eye standing
 * on deck is 3.85 m above the roll axis and the eye on the top is 12.48 m, so
 * every horizontal quantity in the table is 3.2× the deck's. And until M5 the
 * embodied camera passed the eye's horizontal position through **whole** — there
 * was no term that could do anything else.
 */

const DEG = Math.PI / 180;

/**
 * Roll period, seconds — measured, not calculated.
 *
 * The free-decay harness in `SchoonerBuoyancy.measureRollDecay` is the source
 * and `docs/ship/SHIP_SPEC.md` §5 records the result; it is written down here
 * rather than measured at import because a decay run is thirty seconds of
 * physics and this module is read by the camera wiring. `ship-hydrostatics`
 * owns re-measuring it, and `tests/ship-aloft.test.ts` states the dependency so
 * that a period that moves is a conversation rather than a silent drift.
 */
export const MEASURED_ROLL_PERIOD_SECONDS = 5.96;

const ROLL_RATE = (2 * Math.PI) / MEASURED_ROLL_PERIOD_SECONDS;
const GRAVITY = 9.81;

let cachedRollAxisY: number | null = null;

/**
 * Height of the roll axis: the loaded ship's centre of mass.
 *
 * Asked of `massModel` rather than authored, because it is the one number in
 * this file that another round changes by moving ballast, and a copy of it here
 * would be the copy that stayed at 1.887 while the ship got heavier.
 */
export function rollAxisY(): number {
  if (cachedRollAxisY === null) cachedRollAxisY = buildLoadedShip().properties.comY;
  return cachedRollAxisY;
}

/** How far the lookout's eye stands above the axis it swings about. */
export function aloftLever(side: 1 | -1 = 1): number {
  return lookoutEye(side).y - rollAxisY();
}

/** The same, for a body standing on the weather deck by the foremast. */
export function deckLever(): number {
  return walkingDeckY(FOREMAST_Z) + DEFAULT_WALKER_TUNING.eyeHeight - rollAxisY();
}

export interface MastheadMotion {
  /** Half the arc, metres — what §5.4 calls the lateral swing. */
  lateralMetres: number;
  /** Peak speed through that arc, m/s. */
  peakSpeedMps: number;
  /** Peak acceleration, in g. */
  peakAccelerationG: number;
}

/**
 * The §5.4 row for a roll amplitude, from the built geometry.
 *
 * Simple harmonic roll at the measured period: the excursion is `L·sin θ`, and
 * because a body at the masthead is on the end of a rigid arm the speed and the
 * acceleration are the small-angle `L θ ω` and `L θ ω²`. The sine is kept on the
 * excursion and dropped on the derivatives on purpose — that is exactly the
 * arithmetic §5.4 did, and reproducing it is how the two are comparable.
 */
export function mastheadMotion(rollDeg: number, lever = aloftLever()): MastheadMotion {
  const theta = rollDeg * DEG;
  return {
    lateralMetres: lever * Math.sin(theta),
    peakSpeedMps: lever * theta * ROLL_RATE,
    peakAccelerationG: (lever * theta * ROLL_RATE * ROLL_RATE) / GRAVITY,
  };
}

/**
 * The roll amplitudes §5.4 reports beam-on, by sea state.
 *
 * Authored with provenance rather than measured here: they come out of the
 * damped model over a long run, which is `SchoonerResponse`'s job, not a
 * camera-tuning module's. What this file does with them is arithmetic, and the
 * arithmetic is what the milestone had to justify.
 */
export const SPEC_ROLL_AMPLITUDE_DEG: Readonly<Record<string, number>> = Object.freeze({
  CURRENT_MODERATE: 8,
  MATURE_WIND_SEA: 20,
  SOUTHERN_OCEAN_ROUGH: 34,
});

/** The sea the treatment is designed against — the middle of the three. */
export const DESIGN_SEA = 'MATURE_WIND_SEA';

/** The worst sea in the table, which is where the bound below is measured. */
export const WORST_SEA = 'SOUTHERN_OCEAN_ROUGH';

/**
 * How much of the masthead's sway reaches the eye — and where the number is
 * from, because "0.87" arrived at by taste would be worth nothing.
 *
 * A BODY ALOFT IS NOT WELDED TO THE PLATFORM
 * -------------------------------------------
 * It stands on it with a hand through the lifeline, and a neck holds a head
 * upright while the ship rolls under it. An upright body's eye is
 * `eyeHeight` above its **feet**, vertically; a rigid one's is `eyeHeight`
 * along a mast that has rotated. The difference at the masthead is
 * `eyeHeight · sin θ` — 0.55 m at a 20° roll — and it is entirely inboard.
 *
 * So the fraction is the ratio of the two levers: the feet's, and the eye's.
 * `(12.7625 − 1.887) / (14.3625 − 1.887) = 0.872`. It is not a taste value; it
 * is the same uprightness the angular follow fractions already claim, applied to
 * the position they were never applied to. **The camera has always attenuated
 * the head's rotation and never the head's position, which presents a head
 * turned toward vertical still standing at the end of a rigidly-rotated neck.**
 * That inconsistency is invisible on a deck, where the discrepancy is under half
 * a metre against near geometry that is under your feet, and it is four metres
 * of arc at the masthead.
 *
 * WHY IT IS NOT MORE, AND THE BOUND IS GEOMETRY RATHER THAN OPINION
 * ------------------------------------------------------------------
 * Because the eye has to stay over the body. Everything the fraction removes is
 * eye-to-feet offset: at `SOUTHERN_OCEAN_ROUGH` the raw excursion is 6.98 m, so
 * the largest fraction that keeps the eye inside a platform whose half-span is
 * 0.85 m is about 0.867. The physically-derived 0.872 sits just inside that, and
 * the agreement to half a percent is the useful part of this paragraph: **there
 * is no comfort available above the bound.** A camera attenuated enough to
 * matter is a camera standing off the edge of its own planking, which is a worse
 * failure than a big swing, and `tests/ship-aloft.test.ts` asserts the residual
 * against the platform rather than against this comment.
 *
 * WHY THE DRAMA SURVIVES BEING TRIMMED BY AN EIGHTH
 * --------------------------------------------------
 * Because a translation at altitude is very nearly invisible against what you
 * are mostly looking at. Four metres of sway is 0.05° of parallax against a
 * 5 km horizon, and the near geometry — the planking, the lifelines, the
 * doubling — translates *with* the eye and produces no optical flow at all. The
 * one thing that does move is the ship 10.2 m below, and it swings 21° across
 * the view at `MATURE_WIND_SEA` and 34° in the worst sea. That is where the
 * drama lives, it arrives for free, and nothing here touches it.
 */
export function aloftSwayFollow(): number {
  return (LOOKOUT_DECK_Y - rollAxisY()) / (lookoutEye(1).y - rollAxisY());
}

/**
 * The largest sway fraction that still keeps the eye over its own planking in a
 * given sea — the geometric ceiling the derived value has to sit under.
 *
 * The mean in `EmbodiedCameraController` is a one-pole filter at 2.2 s and the
 * roll period is 5.96 s, so about 92% of the excursion survives it as
 * "deviation"; the rest is already inside the mean and is passed whole whatever
 * the fraction says. That factor is here rather than assumed, because leaving it
 * out makes the ceiling 8% tighter than it is and would have argued this whole
 * treatment out of existence.
 */
export function swayCeiling(rollDeg: number): number {
  const raw = mastheadMotion(rollDeg).lateralMetres;
  return 1 - LOOKOUT_HALF_SPAN / (raw * MEAN_FILTER_TRANSMISSION);
}

/**
 * How much of a roll-period oscillation survives the 2.2 s running mean as
 * deviation: `|1 − H(jω)|` for a one-pole at ω = 2π/5.96.
 */
export const MEAN_FILTER_TRANSMISSION = (() => {
  const wt = ROLL_RATE * 2.2;
  const gain = 1 / Math.sqrt(1 + wt * wt);
  const phase = Math.atan(wt);
  const re = 1 - gain * Math.cos(phase);
  const im = gain * Math.sin(phase);
  return Math.hypot(re, im);
})();

/**
 * The head model at the masthead.
 *
 * The walking model's angles, unchanged and on purpose, plus the one term the
 * masthead needs. Built here rather than beside the other two because every
 * number in it is a fact about *this ship* — where her centre of mass is, how
 * high her fore top is, how wide it is — and the camera has no business knowing
 * any of them.
 */
export const ALOFT_STABILISATION: HeadStabilisation = Object.freeze({
  ...WALKING_STABILISATION,
  swayFollow: aloftSwayFollow(),
});

/**
 * How far the presented eye stands off the body it belongs to, at a roll
 * amplitude — the price of the fraction above, in metres.
 */
export function swayResidual(rollDeg: number, follow = aloftSwayFollow()): number {
  return mastheadMotion(rollDeg).lateralMetres * MEAN_FILTER_TRANSMISSION * (1 - follow);
}

/**
 * How far across the view the ship below swings, in degrees, at a roll
 * amplitude.
 *
 * The number the accept-when's "deliberately dramatic" actually cashes out as,
 * and the reason trimming the translation by an eighth does not cost it: this is
 * a ratio of the eye's excursion to its height above the deck, and both are what
 * they are.
 */
export function deckSwingDeg(rollDeg: number, follow = aloftSwayFollow()): number {
  const presented =
    mastheadMotion(rollDeg).lateralMetres *
    (1 - MEAN_FILTER_TRANSMISSION * (1 - follow));
  return (Math.atan(presented / (LOOKOUT_DECK_Y - walkingDeckY(FOREMAST_Z))) / DEG) * 2;
}
