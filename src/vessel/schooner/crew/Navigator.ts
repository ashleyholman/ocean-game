import type {
  EllipsoidGeodesic,
  InverseGeodesicResult,
} from '../../../world/geodesic';
import type { SailName } from '../rig';
import type { CanvasState, SailSetState } from '../sailAero';
import {
  CANVAS_PLANS,
  CANVAS_SAILS,
  RESET_STRUCK_SAIL_WIND_ANGLE_DEG,
  STRIKE_WHEN_CANNOT_DRAW,
  nextCanvasPlanIndex,
} from './CanvasPolicy';
import { signedAngleDifferenceDeg, wrap360 } from './CompassInstrument';
import type { CrewOrder } from './CrewOrders';
import type { NavigatorObservation } from './CrewObservations';
import type { HelmManeuverState } from './Helmsman';
import {
  createHumanRandomStream,
  type HumanRandomStream,
} from './HumanOperator';

/**
 * Tier 2 — the navigator (design §7).
 *
 * He is given a place on the chart and works the ship to it: lays the course
 * if she can sail it, boards to windward if she cannot, orders the evolutions
 * that change tack, and decides how much canvas the day is worth. He never
 * touches a control. Every one of his decisions leaves this module as a
 * **spoken order** and is worked by the same hands the player can relieve at
 * any moment — the helmsman puts the helm down, the trimmers haul the sheets
 * across, the topmen hand the cloth (design invariant 2, one control surface).
 *
 * What he knows is `NavigatorObservation`: a fix a few minutes old, a compass,
 * a log, and a seaman's estimate of the weather. There is no vessel velocity,
 * heel, sail force or apparent-wind vector in this file, and the structural
 * test in `ship-sailing-voyage.test.ts` keeps it that way.
 *
 * WHICH CLOCK THIS RUNS ON
 * ------------------------
 * Ordinary physics seconds, all of it: review intervals, judgement times, the
 * patience he shows a tack. The 30× voyage compression touches geodesic
 * displacement and nothing else, so a compressed passage moves the *chart*
 * faster underneath a crew who work at exactly the speed they always did.
 * That is asserted rather than asserted-in-a-comment — see the compression
 * case in the voyage evidence.
 */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * The true-wind angle he lays his boards out on, degrees off the bow.
 *
 * From the committed polar (`evidence/ship-sailing/polar-baseline.json`),
 * made-good speed to windward peaks broadly between 45° and 60°: at 8 m/s of
 * wind she makes 1.91 kn-equivalent of VMG at 45° and 1.96 at 60°; at 4 m/s
 * the wider angle is plainly better (1.11 against 0.93) and at 12 m/s the
 * closer one is (2.65 against 2.33). Fifty-five degrees is inside a metre a
 * second of the best at every wind in the table, and it leaves her a good
 * full — a navigator who lays out laylines at the exact pinching angle is
 * writing cheques the helmsman cannot cash in a seaway.
 */
export const BEAT_ANGLE_DEG = 55;
/**
 * How much closer than the beat angle a mark may lie before he stops calling
 * the course sailable. A mark two degrees inside the layline is laid, not beaten to.
 */
const LAY_TOLERANCE_DEG = 2;
/** Course changes smaller than this are not worth a spoken order. */
const COURSE_CHANGE_DEADBAND_DEG = 5;
/**
 * How much nearer the mark the other board must point before he will start a
 * beat on it rather than on the one she is already sailing.
 *
 * A mark dead to windward is exactly the same angle off both boards, so
 * without this the choice is decided by a rounding error — and the first
 * thing the navigator does on a fresh order is throw the ship through the
 * wind for no gain at all. Measured the hard way: he did, and she stalled at
 * 0.1 m/s in the eye of it.
 */
const TACK_ADVANTAGE_DEG = 12;
/** Close enough. The captain may say otherwise per voyage. */
export const DEFAULT_ARRIVAL_RADIUS_M = 250;
/**
 * Board length when beating, in chart metres — design §S6's "simple
 * fixed-length legs in v1, proper laylines later".
 *
 * Fixed in the sense that matters (he is not computing laylines), but a
 * *fraction of what is left* rather than an absolute distance, for two
 * reasons. Near the mark, a two-mile board sailed from half a mile out is not
 * a board, it is a detour. Far from it — and this is the one the voyage clock
 * forces — an absolute board is meaningless under compression: at 30× she
 * covers two miles of chart in twenty seconds while a tack costs her fifty,
 * so a fixed board would have her tacking almost continuously and making
 * nothing. A proportional board is the same passage at any clock. The
 * absolute figure below is only a sanity ceiling for ocean distances.
 */
const LEG_DISTANCE_M = 20_000;
const MINIMUM_LEG_M = 250;
const LEG_FRACTION_OF_REMAINING = 0.45;
/**
 * The way she must have on before he will order a tack, m/s through the water.
 *
 * S4's tack evidence is the source: entries at 2.6 and 3.4 m/s complete from
 * every approach, and the case that starts from rest fails and stays failed —
 * the rudder has no authority and the sail moment weathercocks her. This is
 * the floor with a little margin under the successful entries.
 */
export const TACK_ENTRY_SPEED_MPS = 2.2;
/** How long she is left to gather way after a tack that would not go round. */
const GATHER_WAY_SECONDS = 45;
/** How long he waits for an ordered evolution to be taken up at all. */
const EVOLUTION_WATCHDOG_SECONDS = 20;
/** How often he looks at the chart. Ordinary seconds; his own stream. */
const REVIEW_INTERVAL_SECONDS = Object.freeze({ min: 6, max: 14 });
/**
 * How long a wind must hold before he acts on it.
 *
 * Quick to shorten, slow to make sail. The asymmetry is the whole of a
 * captain's attitude to canvas: shortening early costs a little speed, and
 * shortening late costs a spar.
 */
const SHORTEN_SAIL_SUSTAIN_SECONDS = 25;
const MAKE_SAIL_SUSTAIN_SECONDS = 90;

export type VoyagePhase =
  | 'idle'
  | 'making-course'
  | 'beating'
  | 'evolution'
  | 'arrived';

export type VoyageEventKind =
  | 'order-received'
  | 'course'
  | 'tack'
  | 'gybe'
  | 'evolution-complete'
  | 'evolution-failed'
  | 'tack-deferred-for-way'
  | 'canvas'
  | 'strike-cannot-draw'
  | 'reset-struck-sail'
  | 'arrived';

export interface VoyageEvent {
  readonly timeSeconds: number;
  readonly kind: VoyageEventKind;
  /** In the navigator's own words, for the log and the HUD. */
  readonly detail: string;
  readonly courseDeg: number | null;
  readonly distanceToGoM: number | null;
}

export interface VoyageDestination {
  readonly latitudeRad: number;
  readonly longitudeRad: number;
  readonly arrivalRadiusM: number;
}

export interface NavigatorReadout {
  readonly elapsedSeconds: number;
  readonly phase: VoyagePhase;
  readonly destination: VoyageDestination | null;
  readonly distanceToGoM: number | null;
  readonly bearingToDestinationDeg: number | null;
  readonly orderedCourseDeg: number | null;
  readonly tackSide: 'port' | 'starboard' | null;
  readonly canvasPlanIndex: number;
  readonly canvasPlanName: string;
  readonly struckForCannotDraw: readonly SailName[];
  readonly tackCount: number;
  readonly gybeCount: number;
  readonly failedEvolutionCount: number;
  readonly deferredTackCount: number;
  readonly events: readonly VoyageEvent[];
}

/**
 * The deck, as the navigator can address it: spoken orders out, reports back.
 *
 * Everything here is a thing said aloud or a thing a hand tells him. There is
 * deliberately no method that writes a control.
 */
export interface NavigatorDeck {
  orderCompassCourse(courseDeg: number): CrewOrder;
  orderTack(newCourseDeg: number): CrewOrder;
  orderGybe(newCourseDeg: number): CrewOrder;
  orderCanvas(planName: string, canvas: CanvasState): CrewOrder;
  /** What the man on the tiller is doing about the evolution he was given. */
  maneuver(): Readonly<HelmManeuverState> | null;
  /** Sails whose hands report, from sustained evidence, that they will not draw. */
  cannotDrawReports(): readonly SailName[];
}

export class Navigator {
  private readonly attentionRandom: HumanRandomStream;
  private elapsed = 0;
  private phaseValue: VoyagePhase = 'idle';
  private destinationValue: VoyageDestination | null = null;
  private orderedCourseDeg: number | null = null;
  private tackSideValue: 'port' | 'starboard' | null = null;
  private legStartLatitudeRad = 0;
  private legStartLongitudeRad = 0;
  private legLimitM = LEG_DISTANCE_M;
  private nextReviewAt = 0;
  private gatherWayUntil = 0;
  /** The order number of the evolution he is waiting on, or 0. */
  private evolutionOrderSequenceId = 0;
  private evolutionOrderedAt = 0;
  private courseBeforeEvolution: number | null = null;
  private tackSideBeforeEvolution: 'port' | 'starboard' | null = null;
  private canvasIndexValue = 0;
  private candidateCanvasIndex: number | null = null;
  private candidateCanvasSince = 0;
  private lastIssuedCanvas: string | null = null;
  private readonly struck = new Set<SailName>();
  private distanceToGoM: number | null = null;
  private bearingToDestinationDeg: number | null = null;
  private tackCountValue = 0;
  private gybeCountValue = 0;
  private failedEvolutionCountValue = 0;
  private deferredTackCountValue = 0;
  private readonly eventValues: VoyageEvent[] = [];
  private readonly inverse: InverseGeodesicResult = {
    distanceM: 0,
    forwardAzimuth1Rad: 0,
  };

  constructor(
    private readonly deck: NavigatorDeck,
    private readonly geodesic: EllipsoidGeodesic,
    seed: number,
    /**
     * What she is already carrying when he takes the deck. The policy walks
     * from here rather than ordering the whole rig re-set on the first review.
     */
    private readonly initialCanvasIndex = 0,
  ) {
    this.attentionRandom = createHumanRandomStream(seed, 'navigator', 'attention');
    this.canvasIndexValue = initialCanvasIndex;
  }

  get phase(): VoyagePhase {
    return this.phaseValue;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  /** "Sail to that point." Degrees in, because charts are in degrees. */
  sailTo(
    latitudeDeg: number,
    longitudeDeg: number,
    arrivalRadiusM = DEFAULT_ARRIVAL_RADIUS_M,
  ): void {
    if (!Number.isFinite(latitudeDeg) || Math.abs(latitudeDeg) > 90) {
      throw new RangeError(`destination latitude out of range: ${latitudeDeg}`);
    }
    if (!Number.isFinite(longitudeDeg)) {
      throw new RangeError(`destination longitude must be finite`);
    }
    if (!Number.isFinite(arrivalRadiusM) || arrivalRadiusM <= 0) {
      throw new RangeError(`arrival radius must be positive: ${arrivalRadiusM}`);
    }
    this.destinationValue = {
      latitudeRad: latitudeDeg * DEG_TO_RAD,
      longitudeRad: longitudeDeg * DEG_TO_RAD,
      arrivalRadiusM,
    };
    this.phaseValue = 'making-course';
    this.orderedCourseDeg = null;
    this.tackSideValue = null;
    this.nextReviewAt = this.elapsed;
    this.record('order-received', `sail to ${latitudeDeg.toFixed(4)}, ${longitudeDeg.toFixed(4)}`, null);
  }

  standDown(): void {
    this.destinationValue = null;
    this.phaseValue = 'idle';
    this.orderedCourseDeg = null;
    this.tackSideValue = null;
  }

  advanceSubstep(
    stepSeconds: number,
    observation: Readonly<NavigatorObservation>,
  ): void {
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      throw new RangeError(`navigator step must be positive, got ${stepSeconds}`);
    }
    this.elapsed += stepSeconds;
    this.followEvolution(observation);
    if (this.destinationValue === null || this.phaseValue === 'arrived') return;
    if (this.phaseValue === 'evolution') return;
    if (this.elapsed < this.nextReviewAt) return;
    this.nextReviewAt =
      this.elapsed + this.attentionRandom.between(REVIEW_INTERVAL_SECONDS);
    this.review(observation);
  }

  reset(): void {
    this.elapsed = 0;
    this.phaseValue = 'idle';
    this.destinationValue = null;
    this.orderedCourseDeg = null;
    this.tackSideValue = null;
    this.legStartLatitudeRad = 0;
    this.legStartLongitudeRad = 0;
    this.legLimitM = LEG_DISTANCE_M;
    this.nextReviewAt = 0;
    this.gatherWayUntil = 0;
    this.evolutionOrderSequenceId = 0;
    this.evolutionOrderedAt = 0;
    this.courseBeforeEvolution = null;
    this.tackSideBeforeEvolution = null;
    this.canvasIndexValue = this.initialCanvasIndex;
    this.candidateCanvasIndex = null;
    this.candidateCanvasSince = 0;
    this.lastIssuedCanvas = null;
    this.struck.clear();
    this.distanceToGoM = null;
    this.bearingToDestinationDeg = null;
    this.tackCountValue = 0;
    this.gybeCountValue = 0;
    this.failedEvolutionCountValue = 0;
    this.deferredTackCountValue = 0;
    this.eventValues.length = 0;
    this.attentionRandom.reset();
  }

  readout(): NavigatorReadout {
    return {
      elapsedSeconds: this.elapsed,
      phase: this.phaseValue,
      destination: this.destinationValue,
      distanceToGoM: this.distanceToGoM,
      bearingToDestinationDeg: this.bearingToDestinationDeg,
      orderedCourseDeg: this.orderedCourseDeg,
      tackSide: this.tackSideValue,
      canvasPlanIndex: this.canvasIndexValue,
      canvasPlanName: CANVAS_PLANS[this.canvasIndexValue].name,
      struckForCannotDraw: [...this.struck],
      tackCount: this.tackCountValue,
      gybeCount: this.gybeCountValue,
      failedEvolutionCount: this.failedEvolutionCountValue,
      deferredTackCount: this.deferredTackCountValue,
      events: this.eventValues,
    };
  }

  /** The canvas he currently intends, policy plan overlaid with what is handed. */
  intendedCanvas(): CanvasState {
    const plan = CANVAS_PLANS[this.canvasIndexValue].canvas;
    if (this.struck.size === 0) return plan;
    const resolved: Partial<Record<SailName, SailSetState>> = {};
    for (const sail of CANVAS_SAILS) {
      resolved[sail] = this.struck.has(sail) ? 'furled' : plan[sail];
    }
    return resolved as CanvasState;
  }

  // --- the work ---------------------------------------------------------------

  private review(observation: Readonly<NavigatorObservation>): void {
    const destination = this.destinationValue!;
    const windFromDeg = observation.windFromBearingDeg;
    if (windFromDeg === null || observation.windSpeedMps === null) return;

    this.geodesic.inverse(
      observation.fixLatitudeRad,
      observation.fixLongitudeRad,
      destination.latitudeRad,
      destination.longitudeRad,
      this.inverse,
    );
    const distanceM = this.inverse.distanceM;
    const bearingDeg = wrap360(this.inverse.forwardAzimuth1Rad * RAD_TO_DEG);
    this.distanceToGoM = distanceM;
    this.bearingToDestinationDeg = bearingDeg;

    if (distanceM <= destination.arrivalRadiusM) {
      this.phaseValue = 'arrived';
      this.record('arrived', `${distanceM.toFixed(0)} m from the mark`, null);
      return;
    }

    this.reviewCanvas(observation, windFromDeg);

    const directOffWindDeg = Math.abs(
      signedAngleDifferenceDeg(bearingDeg, windFromDeg),
    );
    const beating = directOffWindDeg < BEAT_ANGLE_DEG - LAY_TOLERANCE_DEG;
    const desiredCourseDeg = beating
      ? this.beatCourse(observation, windFromDeg, bearingDeg, distanceM)
      : bearingDeg;
    this.phaseValue = beating ? 'beating' : 'making-course';
    this.steer(observation, windFromDeg, desiredCourseDeg, distanceM);
  }

  /**
   * Which board to be on, and for how long.
   *
   * No laylines in this version by deliberate choice (`SAILING_PROJECT_PLAN.md`
   * §S6): boards are a fixed length, shortened in proportion as the mark comes
   * up so the last few converge rather than sailing her past it.
   */
  private beatCourse(
    observation: Readonly<NavigatorObservation>,
    windFromDeg: number,
    bearingDeg: number,
    distanceM: number,
  ): number {
    const portTackCourse = wrap360(windFromDeg + BEAT_ANGLE_DEG);
    const starboardTackCourse = wrap360(windFromDeg - BEAT_ANGLE_DEG);
    const legLimitM = Math.min(
      LEG_DISTANCE_M,
      Math.max(MINIMUM_LEG_M, distanceM * LEG_FRACTION_OF_REMAINING),
    );

    if (this.tackSideValue === null) {
      // Starting a beat: take the board that points nearer the mark — but not
      // for a few degrees of it. Both boards are the same angle off a mark
      // dead to windward, and a navigator who tacks a ship to gain two degrees
      // has spent a minute of her way to buy nothing.
      const side = this.betterTack(
        bearingDeg,
        portTackCourse,
        starboardTackCourse,
        observation.compassHeadingDeg,
        windFromDeg,
      );
      this.startLeg(observation, side, legLimitM);
      return side === 'port' ? portTackCourse : starboardTackCourse;
    }

    const sailedM = this.distanceSailedOnLeg(observation);
    if (sailedM >= this.legLimitM) {
      const side = this.tackSideValue === 'port' ? 'starboard' : 'port';
      this.startLeg(observation, side, legLimitM);
      return side === 'port' ? portTackCourse : starboardTackCourse;
    }
    return this.tackSideValue === 'port' ? portTackCourse : starboardTackCourse;
  }

  private betterTack(
    bearingDeg: number,
    portTackCourse: number,
    starboardTackCourse: number,
    headingDeg: number,
    windFromDeg: number,
  ): 'port' | 'starboard' {
    const portOff = Math.abs(signedAngleDifferenceDeg(portTackCourse, bearingDeg));
    const starboardOff = Math.abs(
      signedAngleDifferenceDeg(starboardTackCourse, bearingDeg),
    );
    const boardSheIsOn: 'port' | 'starboard' =
      signedAngleDifferenceDeg(headingDeg, windFromDeg) >= 0
        ? 'port'
        : 'starboard';
    const advantage =
      boardSheIsOn === 'port' ? starboardOff - portOff : portOff - starboardOff;
    // Negative advantage means the other board points nearer the mark. It has
    // to point *meaningfully* nearer before it is worth a tack.
    if (advantage > -TACK_ADVANTAGE_DEG) return boardSheIsOn;
    return boardSheIsOn === 'port' ? 'starboard' : 'port';
  }

  private startLeg(
    observation: Readonly<NavigatorObservation>,
    side: 'port' | 'starboard',
    legLimitM: number,
  ): void {
    this.tackSideValue = side;
    this.legStartLatitudeRad = observation.fixLatitudeRad;
    this.legStartLongitudeRad = observation.fixLongitudeRad;
    this.legLimitM = legLimitM;
  }

  private distanceSailedOnLeg(
    observation: Readonly<NavigatorObservation>,
  ): number {
    this.geodesic.inverse(
      this.legStartLatitudeRad,
      this.legStartLongitudeRad,
      observation.fixLatitudeRad,
      observation.fixLongitudeRad,
      this.inverse,
    );
    return this.inverse.distanceM;
  }

  /**
   * Turn the course he wants into the order the deck should hear.
   *
   * The one decision that matters here is *how* she gets from the course she
   * is on to the course he wants. If the two lie on the same side of the
   * wind she simply steers round. If they lie on opposite sides, somebody is
   * putting a bow or a stern through the wind, and that is an evolution with
   * a name — through the eye is a tack, through dead astern is a gybe,
   * whichever way round is shorter.
   */
  private steer(
    observation: Readonly<NavigatorObservation>,
    windFromDeg: number,
    desiredCourseDeg: number,
    distanceM: number,
  ): void {
    const current =
      this.orderedCourseDeg ?? wrap360(observation.compassHeadingDeg);
    if (
      this.orderedCourseDeg !== null &&
      Math.abs(signedAngleDifferenceDeg(desiredCourseDeg, current)) <
        COURSE_CHANGE_DEADBAND_DEG
    ) {
      return;
    }

    // Which side of the wind she is on now is a question about the ship, not
    // about the last order: on the first order of a voyage there is no last
    // order, and a passage that starts on the wrong gybe still has to gybe.
    const fromWind = signedAngleDifferenceDeg(current, windFromDeg);
    const toWind = signedAngleDifferenceDeg(desiredCourseDeg, windFromDeg);
    const crossesTheWind = Math.sign(fromWind) !== Math.sign(toWind);
    if (!crossesTheWind) {
      this.orderedCourseDeg = desiredCourseDeg;
      this.deck.orderCompassCourse(desiredCourseDeg);
      this.record(
        'course',
        `steer ${desiredCourseDeg.toFixed(0)}`,
        desiredCourseDeg,
        distanceM,
      );
      return;
    }

    const throughTheEyeDeg = Math.abs(fromWind) + Math.abs(toWind);
    const throughAsternDeg = 360 - throughTheEyeDeg;
    if (throughTheEyeDeg <= throughAsternDeg) {
      if (
        observation.speedThroughWaterMps < TACK_ENTRY_SPEED_MPS ||
        this.elapsed < this.gatherWayUntil
      ) {
        // Not enough way on to carry her through the eye. He waits rather
        // than spends the ship's way on a tack that will hang.
        this.deferredTackCountValue++;
        this.record(
          'tack-deferred-for-way',
          `${observation.speedThroughWaterMps.toFixed(2)} m/s by the log; ` +
            `${TACK_ENTRY_SPEED_MPS} wanted`,
          desiredCourseDeg,
          distanceM,
        );
        if (this.orderedCourseDeg === null) {
          // And nobody is steering to anything. Give the helm the head she is
          // on so she has a course to hold while she gathers way.
          this.orderedCourseDeg = wrap360(Math.round(current));
          this.deck.orderCompassCourse(this.orderedCourseDeg);
          this.record(
            'course',
            `steady as she goes on ${this.orderedCourseDeg.toFixed(0)}`,
            this.orderedCourseDeg,
            distanceM,
          );
        }
        return;
      }
      this.beginEvolution('tack', current, desiredCourseDeg, distanceM);
      return;
    }
    this.beginEvolution('gybe', current, desiredCourseDeg, distanceM);
  }

  private beginEvolution(
    kind: 'tack' | 'gybe',
    courseBeforeDeg: number,
    desiredCourseDeg: number,
    distanceM: number,
  ): void {
    this.courseBeforeEvolution = courseBeforeDeg;
    this.tackSideBeforeEvolution =
      this.tackSideValue === 'port'
        ? 'starboard'
        : this.tackSideValue === 'starboard'
          ? 'port'
          : null;
    this.orderedCourseDeg = desiredCourseDeg;
    this.phaseValue = 'evolution';
    this.evolutionOrderedAt = this.elapsed;
    const order =
      kind === 'tack'
        ? this.deck.orderTack(desiredCourseDeg)
        : this.deck.orderGybe(desiredCourseDeg);
    this.evolutionOrderSequenceId = order.sequenceId;
    if (kind === 'tack') this.tackCountValue++;
    else this.gybeCountValue++;
    this.record(
      kind,
      kind === 'tack'
        ? `ready about; steer ${desiredCourseDeg.toFixed(0)} on the new board`
        : `stand by to gybe; steer ${desiredCourseDeg.toFixed(0)} after`,
      desiredCourseDeg,
      distanceM,
    );
  }

  /**
   * Watch the evolution he ordered and pick the voyage up again after it.
   *
   * He waits for the man on the tiller to be working *his* order — the order
   * number is checked, because the helmsman keeps the last evolution in his
   * readout after it finishes and a navigator reading that would call every
   * tack complete before it began.
   */
  private followEvolution(observation: Readonly<NavigatorObservation>): void {
    if (this.phaseValue !== 'evolution') return;
    const maneuver = this.deck.maneuver();
    if (
      maneuver === null ||
      maneuver.orderSequenceId !== this.evolutionOrderSequenceId
    ) {
      if (this.elapsed - this.evolutionOrderedAt >= EVOLUTION_WATCHDOG_SECONDS) {
        // Nobody took the order up. Rather than stand here, go back to the
        // chart and work it out again.
        this.phaseValue = this.tackSideValue === null ? 'making-course' : 'beating';
        this.orderedCourseDeg = this.courseBeforeEvolution;
        this.tackSideValue = this.tackSideBeforeEvolution;
        this.evolutionOrderSequenceId = 0;
        this.nextReviewAt = this.elapsed;
        this.record('evolution-failed', 'the order was never worked', null);
      }
      return;
    }
    if (maneuver.phase === 'complete') {
      this.phaseValue = this.tackSideValue === null ? 'making-course' : 'beating';
      this.evolutionOrderSequenceId = 0;
      this.nextReviewAt = this.elapsed;
      // The board starts where the evolution ended, not where it was ordered:
      // a tack costs ground, and under voyage compression it costs a great
      // deal of it. Measuring the leg from here keeps the boards even.
      this.legStartLatitudeRad = observation.fixLatitudeRad;
      this.legStartLongitudeRad = observation.fixLongitudeRad;
      this.record(
        'evolution-complete',
        `${maneuver.kind} complete; on the ${
          maneuver.entrySide === 'port' ? 'starboard' : 'port'
        } tack`,
        maneuver.newCourseDeg,
      );
      return;
    }
    if (maneuver.phase === 'failed') {
      this.failedEvolutionCountValue++;
      this.evolutionOrderSequenceId = 0;
      this.phaseValue =
        this.tackSideBeforeEvolution === null ? 'making-course' : 'beating';
      // She never went round, so she is on the board and the course she was
      // on before, and the helm has resumed it unaided. Give her a stretch to
      // gather way, and start the board's clock again from here.
      this.orderedCourseDeg = this.courseBeforeEvolution;
      this.tackSideValue = this.tackSideBeforeEvolution;
      this.legStartLatitudeRad = observation.fixLatitudeRad;
      this.legStartLongitudeRad = observation.fixLongitudeRad;
      this.gatherWayUntil = this.elapsed + GATHER_WAY_SECONDS;
      this.nextReviewAt = this.elapsed + GATHER_WAY_SECONDS;
      this.record(
        'evolution-failed',
        `${maneuver.kind} would not go round; gather way and try again`,
        null,
      );
    }
  }

  // --- canvas -----------------------------------------------------------------

  private reviewCanvas(
    observation: Readonly<NavigatorObservation>,
    windFromDeg: number,
  ): void {
    const windSpeedMps = observation.windSpeedMps!;
    const target = nextCanvasPlanIndex(this.canvasIndexValue, windSpeedMps);
    if (target === this.canvasIndexValue) {
      this.candidateCanvasIndex = null;
    } else {
      if (this.candidateCanvasIndex !== target) {
        this.candidateCanvasIndex = target;
        this.candidateCanvasSince = this.elapsed;
      }
      const sustain =
        target > this.canvasIndexValue
          ? SHORTEN_SAIL_SUSTAIN_SECONDS
          : MAKE_SAIL_SUSTAIN_SECONDS;
      if (this.elapsed - this.candidateCanvasSince >= sustain) {
        const shortening = target > this.canvasIndexValue;
        this.canvasIndexValue = target;
        this.candidateCanvasIndex = null;
        this.record(
          'canvas',
          `${shortening ? 'shorten sail' : 'make sail'} — ` +
            `${CANVAS_PLANS[target].name} at ${windSpeedMps.toFixed(1)} m/s`,
          null,
        );
      }
    }

    this.reviewStruckSails(windFromDeg);
    this.issueCanvasIfChanged();
  }

  /**
   * The answer to a hand who says his sail will not draw.
   *
   * S5 built the report and nothing listened to it, so she beat with a square
   * topsail permanently aback (FINDING S5-3). This is the listener. It hands
   * the sail — and keeps it handed until she is genuinely off the wind, so
   * that one lucky moment of drawing does not send a man aloft to set it
   * again for the next thirty seconds.
   */
  private reviewStruckSails(windFromDeg: number): void {
    const courseDeg = this.orderedCourseDeg;
    const windAngleOffBowDeg =
      courseDeg === null
        ? 0
        : Math.abs(signedAngleDifferenceDeg(courseDeg, windFromDeg));
    for (const sail of this.deck.cannotDrawReports()) {
      if (!STRIKE_WHEN_CANNOT_DRAW.has(sail) || this.struck.has(sail)) continue;
      this.struck.add(sail);
      this.record(
        'strike-cannot-draw',
        `${sail} will not draw at ${windAngleOffBowDeg.toFixed(0)}° off the wind; hand it`,
        courseDeg,
      );
    }
    if (
      this.struck.size > 0 &&
      courseDeg !== null &&
      windAngleOffBowDeg >= RESET_STRUCK_SAIL_WIND_ANGLE_DEG
    ) {
      for (const sail of [...this.struck]) {
        this.struck.delete(sail);
        this.record(
          'reset-struck-sail',
          `${windAngleOffBowDeg.toFixed(0)}° off the wind; ${sail} may draw again`,
          courseDeg,
        );
      }
    }
  }

  private issueCanvasIfChanged(): void {
    const canvas = this.intendedCanvas();
    const signature = CANVAS_SAILS.map((sail) => `${sail}:${canvas[sail]}`).join(
      ',',
    );
    if (signature === this.lastIssuedCanvas) return;
    this.lastIssuedCanvas = signature;
    this.deck.orderCanvas(CANVAS_PLANS[this.canvasIndexValue].name, canvas);
  }

  private record(
    kind: VoyageEventKind,
    detail: string,
    courseDeg: number | null,
    distanceToGoM: number | null = this.distanceToGoM,
  ): void {
    this.eventValues.push({
      timeSeconds: this.elapsed,
      kind,
      detail,
      courseDeg,
      distanceToGoM,
    });
  }
}
