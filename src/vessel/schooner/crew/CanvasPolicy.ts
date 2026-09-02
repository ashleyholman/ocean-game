import type { SailName } from '../rig';
import type { CanvasState, SailSetState } from '../sailAero';

/**
 * The canvas policy — design §7 tier 2's "what she should be carrying".
 *
 * A well-handled ship in strong wind carries *less* canvas, not more. The
 * trimmers can only ease what is already set, and S5 measured where that ends:
 * at 16 m/s the hands eased every sheet to its stop and she still lay over
 * 30.7° (FINDING S5-4). Easing cannot depower her. This table is the authority
 * that can, and it is the only place in the crew layer that decides *how much
 * cloth* rather than *what angle*.
 *
 * The bands are provisional feel numbers in the same sense the operator
 * profile's timings are, and they are the knob for how conservative the crew
 * reads. What is *not* negotiable is the ordering below: each plan carries no
 * more of any sail than the plan before it. A policy that shortened one sail
 * while making more of another would be a policy nobody could reason about,
 * and `canvasPlansAreMonotonic` refuses to let it become one.
 */

/** How much cloth a set state is worth, for ordering only. */
const CANVAS_AMOUNT: Readonly<Record<SailSetState, number>> = Object.freeze({
  furled: 0,
  reef2: 1,
  reef1: 2,
  set: 3,
});

export interface CanvasPlan {
  /** What a mate would call this rig. */
  readonly name: string;
  /**
   * The true-wind speed at which this plan stops being enough, m/s. The last
   * plan carries Infinity: there is nothing snugger in this project's scope
   * (storm trysails and bare poles are `SAILING_MODEL_DESIGN.md` §10).
   */
  readonly uptoWindMps: number;
  readonly canvas: CanvasState;
}

/**
 * Ordered from most canvas to least. Design §7's bands, near enough:
 * everything in light air, the kites off by about seven, the flying jib in
 * and the first reef tied around ten to twelve, the square topsail in and
 * deep reefs above fourteen.
 */
export const CANVAS_PLANS: readonly CanvasPlan[] = Object.freeze([
  {
    name: 'all plain sail',
    uptoWindMps: 5.5,
    canvas: Object.freeze({
      mainsail: 'set',
      foresail: 'set',
      foreStaysail: 'set',
      jib: 'set',
      flyingJib: 'set',
      foreTopsail: 'set',
      mainTopmastStaysail: 'set',
      mainGaffTopsail: 'set',
    }) as CanvasState,
  },
  {
    name: 'working canvas',
    uptoWindMps: 7.5,
    canvas: Object.freeze({
      mainsail: 'set',
      foresail: 'set',
      foreStaysail: 'set',
      jib: 'set',
      flyingJib: 'set',
      foreTopsail: 'set',
      mainTopmastStaysail: 'furled',
      mainGaffTopsail: 'furled',
    }) as CanvasState,
  },
  {
    name: 'flying jib in',
    uptoWindMps: 10.5,
    canvas: Object.freeze({
      mainsail: 'set',
      foresail: 'set',
      foreStaysail: 'set',
      jib: 'set',
      flyingJib: 'furled',
      foreTopsail: 'set',
      mainTopmastStaysail: 'furled',
      mainGaffTopsail: 'furled',
    }) as CanvasState,
  },
  {
    name: 'single-reefed',
    uptoWindMps: 13.5,
    canvas: Object.freeze({
      mainsail: 'reef1',
      foresail: 'reef1',
      foreStaysail: 'set',
      jib: 'set',
      flyingJib: 'furled',
      foreTopsail: 'set',
      mainTopmastStaysail: 'furled',
      mainGaffTopsail: 'furled',
    }) as CanvasState,
  },
  {
    name: 'close-reefed',
    uptoWindMps: 17,
    canvas: Object.freeze({
      mainsail: 'reef2',
      foresail: 'reef1',
      foreStaysail: 'set',
      jib: 'furled',
      flyingJib: 'furled',
      foreTopsail: 'furled',
      mainTopmastStaysail: 'furled',
      mainGaffTopsail: 'furled',
    }) as CanvasState,
  },
  {
    name: 'fore and staysail',
    uptoWindMps: Infinity,
    canvas: Object.freeze({
      mainsail: 'furled',
      foresail: 'reef1',
      foreStaysail: 'set',
      jib: 'furled',
      flyingJib: 'furled',
      foreTopsail: 'furled',
      mainTopmastStaysail: 'furled',
      mainGaffTopsail: 'furled',
    }) as CanvasState,
  },
]);

/**
 * How far the wind must fall below a band's own floor before the crew will
 * shake anything out again.
 *
 * A crew is quick to shorten and slow to make sail — reefing is cheap
 * insurance and shaking out a reef you immediately tie in again is a wasted
 * hour of everyone's day. That asymmetry lives here and in the sustain times
 * the navigator holds a judgement for.
 */
export const CANVAS_HYSTERESIS_MPS = 1.2;

/** Every sail in the rig, in the order the canvas plans list them. */
export const CANVAS_SAILS: readonly SailName[] = Object.freeze(
  Object.keys(CANVAS_PLANS[0].canvas) as SailName[],
);

/** The plan index for a wind speed, ignoring hysteresis and judgement time. */
export function canvasPlanIndexForWind(windSpeedMps: number): number {
  for (let index = 0; index < CANVAS_PLANS.length; index++) {
    if (windSpeedMps < CANVAS_PLANS[index].uptoWindMps) return index;
  }
  return CANVAS_PLANS.length - 1;
}

/**
 * The plan index a captain already carrying `currentIndex` would move to.
 *
 * Shortening happens as soon as the wind is past this plan's band. Making sail
 * again waits until the wind has fallen a clear margin below the band's floor,
 * so a gust that touches the edge does not start a reef, and a lull does not
 * undo one.
 */
export function nextCanvasPlanIndex(
  currentIndex: number,
  windSpeedMps: number,
): number {
  const clamped = clampIndex(currentIndex);
  if (windSpeedMps >= CANVAS_PLANS[clamped].uptoWindMps) {
    return clampIndex(clamped + 1);
  }
  if (clamped === 0) return 0;
  const floorMps = CANVAS_PLANS[clamped - 1].uptoWindMps;
  if (windSpeedMps <= floorMps - CANVAS_HYSTERESIS_MPS) {
    return clampIndex(clamped - 1);
  }
  return clamped;
}

/** How much cloth a plan carries, summed over the rig — for evidence only. */
export function canvasPlanAmount(canvas: CanvasState): number {
  let total = 0;
  for (const sail of CANVAS_SAILS) total += CANVAS_AMOUNT[canvas[sail]];
  return total;
}

export function canvasAmount(state: SailSetState): number {
  return CANVAS_AMOUNT[state];
}

/**
 * No plan carries more of any sail than the plan before it, and every plan
 * carries strictly less cloth overall.
 *
 * Asserted rather than assumed: the table is edited by hand, by whoever is
 * tuning how conservative the crew feels, and a non-monotonic row would make
 * "shorten sail" mean "set something".
 */
export function canvasPlansAreMonotonic(
  plans: readonly CanvasPlan[] = CANVAS_PLANS,
): boolean {
  for (let index = 1; index < plans.length; index++) {
    const previous = plans[index - 1].canvas;
    const current = plans[index].canvas;
    for (const sail of CANVAS_SAILS) {
      if (CANVAS_AMOUNT[current[sail]] > CANVAS_AMOUNT[previous[sail]]) {
        return false;
      }
    }
    if (canvasPlanAmount(current) >= canvasPlanAmount(previous)) return false;
    if (plans[index].uptoWindMps <= plans[index - 1].uptoWindMps) return false;
  }
  return true;
}

/**
 * Sails that should be handed rather than fought when the hand at their
 * station reports he cannot make them draw.
 *
 * Only the square topsail. A fore-and-aft sail that will not draw is a trim
 * or a course problem and the answer is the sheet or the helm; a yard that has
 * been braced to its stop and still meets the wind on its front face is a sail
 * the ship should not be carrying at all. S5 measured exactly that: close-
 * hauled the fore topsail sits at −45° angle of attack, the hand braces to the
 * stop, reports `cannot draw`, and before this round nothing acted on it — so
 * she beat with a square sail permanently aback (FINDING S5-3).
 */
export const STRIKE_WHEN_CANNOT_DRAW: ReadonlySet<SailName> = new Set<SailName>(
  ['foreTopsail'],
);

/**
 * How far off the wind she must be sailing before a sail struck for not
 * drawing may be set again.
 *
 * The square topsail is a running sail. Handed on a beat, it stays handed
 * until she is well off the wind — not the moment a wave lets it draw for a
 * second. Degrees off the bow of the wind the navigator is *steering* to, so
 * the decision is made from his own course and his own estimate of where the
 * wind is, never from the sail's instantaneous angle of attack.
 */
export const RESET_STRUCK_SAIL_WIND_ANGLE_DEG = 100;

function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  if (index > CANVAS_PLANS.length - 1) return CANVAS_PLANS.length - 1;
  return Math.round(index);
}
