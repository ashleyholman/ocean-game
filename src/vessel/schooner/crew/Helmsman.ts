import type { SailingControls } from '../SailingControls';
import { RUDDER_LIMIT_DEG } from '../SailingControls';
import { signedAngleDifferenceDeg, wrap360 } from './CompassInstrument';
import {
  StationOrderPipeline,
  type CrewOrder,
  type CrewOrderPhase,
  type StationOrderResponse,
} from './CrewOrders';
import type {
  HelmFocus,
  HelmObservation,
  SwingDirection,
  SwingStrength,
} from './CrewObservations';
import {
  COMPETENT_HUMAN_OPERATOR_PROFILE,
  createHumanRandomStream,
  sampleShiftedLognormalSeconds,
  type BoundedRange,
  type HumanRandomStream,
} from './HumanOperator';

const MAX_WORKING_RUDDER_DEG = 18;
const BASE_COURSE_DEADBAND_DEG = 1.6;
/**
 * Steering by the wind is a coarser business than steering by the card.
 *
 * The vane is read to 5° at best, so a deadband inside that would be chasing
 * quantisation. A hand holding a wind angle accepts a wider berth than one
 * holding a compass course, and this is that berth.
 */
const WIND_ANGLE_DEADBAND_DEG = 6;
/** Nothing older than this is worth steering on; go and look at the vane. */
const WIND_ANGLE_STALE_SECONDS = 6;
const ANTICIPATION_SECONDS = 2.4;
const MINIMUM_TARGET_CHANGE_DEG = 1.5;
/** Prevent settled-course correction/ease/correction chatter around the rest helm. */
const SETTLED_CORRECTION_COOLDOWN_SECONDS = 3;
/**
 * How much standing helm one repeated correction teaches. A vessel that keeps
 * drifting the same way after each ease accumulates holding helm in these
 * steps until the drift stops recurring; corrections that alternate sides
 * cancel and teach nothing net.
 */
const HOLDING_HELM_LEARN_STEP_DEG = 0.5;
/** A boat wanting more standing helm than this has a trim problem, not a helm one. */
const HOLDING_HELM_LIMIT_DEG = 6;
/** Below this remaining correction beyond the holding helm there is nothing to watch. */
const MINIMUM_WATCHED_CORRECTION_DEG = 1;
/**
 * Ease when the anticipated reading is within this of the order: with the
 * correction coming off, the remaining swing carries her the rest of the way.
 */
const RELEASE_BAND_DEG = 0.8;

/**
 * How much helm goes on for a tack, degrees of rudder.
 *
 * S4's tack evidence measured this: 25° of rudder held from the order until
 * she is round completes the maneuver from every with-way entry
 * (`SailingSteeringEvidence.ts`). Less is slower through the eye, which is
 * where a tack is lost.
 */
const TACK_HELM_DEG = 25;
/**
 * A gybe is a bear-away, not a slam. Less helm, because the danger in a gybe
 * is the boom crossing fast, not failing to get round.
 */
const GYBE_HELM_DEG = 16;
/**
 * How long the wind must stay on the new cheek before he believes it.
 *
 * The vane goes 'unclear' as it swings through the bow, and a sea can throw
 * one reading across; he waits for it to settle before he calls her round.
 */
const MANEUVER_CROSS_CONFIRM_SECONDS = 1.2;
/** How long he holds the helm on after the cloth has filled on the new board. */
const MANEUVER_FILL_CONFIRM_SECONDS = 2.5;
/**
 * How long she may hang with the wind still on the old bow before he calls it
 * for what it is and shifts the helm for a stern-board.
 *
 * S4's tack evidence crosses the eye in well under this from any entry with
 * way on; past it she is not coming round on this helm.
 */
const IRONS_PATIENCE_SECONDS = 26;
/** The whole evolution's patience. Past this he gives it up and bears away. */
const MANEUVER_TIMEOUT_SECONDS = 110;
/** A gybe that has not gone round in this is not going to; she is reaching. */
const GYBE_TIMEOUT_SECONDS = 45;

export type HelmActionPhase =
  | 'idle'
  | 'considering'
  | 'motor-delay'
  | 'watching';

export type HelmInterventionReason =
  | 'course-drift'
  | 'ease-as-she-answers'
  | 'counter-swing'
  | 'reacquire'
  | 'wind-angle-drift'
  | 'sails-shaking'
  /** "Helm's a-lee" / "up helm" — the deliberate start of an evolution. */
  | 'evolution-helm-over'
  /** "Shift your helm" — the stern-board out of irons. */
  | 'evolution-shift-helm'
  /** Meeting her as she comes round and the cloth fills on the new board. */
  | 'evolution-meet-her'
  /** The evolution is off; put her back the way she was going. */
  | 'evolution-abandoned';

export type HelmManeuverKind = 'tack' | 'gybe';

/**
 * Where an evolution has got to, as the man on the tiller understands it.
 *
 * He knows only what he can feel and see: which cheek the wind is on, whether
 * the cloth is full or slatting, and whether there is any weight in the helm.
 * "In irons" is not a physics state he is told about — it is a tiller gone
 * dead in his hand with the sails shaking and the wind still on the same bow.
 */
export type HelmManeuverPhase =
  | 'helm-over'
  | 'in-irons'
  | 'through'
  | 'complete'
  | 'failed';

export interface HelmManeuverState {
  readonly kind: HelmManeuverKind;
  readonly orderSequenceId: number;
  readonly startedAtSeconds: number;
  /** The cheek the wind was on when the helm went over. */
  readonly entrySide: 'port' | 'starboard';
  /** The course to steady on once she is round. */
  readonly newCourseDeg: number;
  phase: HelmManeuverPhase;
  phaseEnteredAtSeconds: number;
  crossedAtSeconds: number | null;
  finishedAtSeconds: number | null;
  /** True once he has shifted the helm for a stern-board. */
  shiftedHelm: boolean;
}

/** Which order the helmsman is working to. */
export type HelmReference = 'compass' | 'wind-angle';

export interface HelmIntervention {
  readonly sequenceId: number;
  readonly orderSequenceId: number;
  readonly consideredAtSeconds: number;
  readonly decidedAtSeconds: number;
  readonly executeAtSeconds: number;
  readonly requestedRudderDeg: number;
  readonly previousRequestedRudderDeg: number;
  /**
   * The reading he acted on and how far off it was, in whichever reference
   * the standing order is on: degrees of compass card, or degrees off the bow
   * on the dogvane.
   */
  readonly perceivedCourseDeg: number;
  readonly perceivedCourseErrorDeg: number;
  readonly reference: HelmReference;
  readonly reason: HelmInterventionReason;
}

interface PendingIntervention {
  readonly consideredAtSeconds: number;
  readonly decisionAtSeconds: number;
  readonly executeAtSeconds: number;
  readonly candidateRudderDeg: number;
  readonly perceivedCourseDeg: number;
  readonly perceivedCourseErrorDeg: number;
  readonly reference: HelmReference;
  readonly reason: HelmInterventionReason;
  decided: HelmIntervention | null;
}

export interface HelmsmanReadout {
  readonly elapsedSeconds: number;
  readonly focus: HelmFocus;
  readonly focusUntilSeconds: number;
  readonly actionPhase: HelmActionPhase;
  readonly directTakeover: boolean;
  readonly reacquiring: boolean;
  readonly reference: HelmReference;
  readonly orderedCourseDeg: number | null;
  /** The ordered angle off the bow when steering by the wind, else null. */
  readonly orderedWindAngleDeg: number | null;
  readonly orderPhase: CrewOrderPhase;
  readonly orderResponse: Readonly<StationOrderResponse> | null;
  readonly lastRequestedRudderDeg: number;
  readonly holdingHelmDeg: number;
  readonly interventionCount: number;
  readonly latestIntervention: Readonly<HelmIntervention> | null;
  readonly interventions: readonly HelmIntervention[];
  /** The evolution he is working, or the last one he worked. */
  readonly maneuver: Readonly<HelmManeuverState> | null;
  readonly maneuvers: readonly HelmManeuverState[];
}

/**
 * Event-driven compass-course helmsman.
 *
 * Its only live simulation input is `HelmObservation`: delayed compass memory
 * and coarse visual/body/tiller cues. There is no heading, yaw-rate, wind-angle
 * or heel truth in this module, and no continuous P-D target write. It leaves
 * the tiller alone between finite interventions, watches the response, then
 * checks the card again when the remembered course is old or the swing is
 * meaningful.
 *
 * Like a real helmsman, he learns the vessel's balance: when she keeps
 * drifting the same way after each ease, he starts carrying a little standing
 * helm against it, and thereafter "easing" means returning to that carried
 * helm rather than to exact amidships. The estimate comes only from his own
 * repeated corrections — never from aerodynamic truth — and is forgotten when
 * its premises change (a new course order, or the wind coming over the other
 * side).
 */
export class Helmsman {
  private readonly orders: StationOrderPipeline;
  private readonly attentionRandom: HumanRandomStream;
  private readonly actionRandom: HumanRandomStream;
  private elapsed = 0;
  private focusValue: HelmFocus = 'looking-ahead';
  private focusUntil = 0;
  private actionPhaseValue: HelmActionPhase = 'idle';
  private activeCourseDeg: number | null = null;
  private activeWindAngleDeg: number | null = null;
  private activeOrderSequenceId = 0;
  private directTakeoverValue = false;
  private needsReacquisition = false;
  private pending: PendingIntervention | null = null;
  private lastRequestedRudder = 0;
  private holdingHelm = 0;
  private lastFeltWindSide: 'port' | 'starboard' | null = null;
  private nextInterventionSequenceId = 1;
  private lastCommandAt = -Infinity;
  private readonly interventionValues: HelmIntervention[] = [];
  private maneuverValue: HelmManeuverState | null = null;
  private readonly maneuverValues: HelmManeuverState[] = [];
  private crossSeenAtSeconds = 0;
  private filledSeenAtSeconds = 0;

  constructor(
    private readonly controls: SailingControls,
    seed: number,
  ) {
    this.orders = new StationOrderPipeline('helm', seed);
    this.attentionRandom = createHumanRandomStream(
      seed,
      'helm',
      'attention',
    );
    this.actionRandom = createHumanRandomStream(seed, 'helm', 'action');
    this.enterFocus('looking-ahead', true);
  }

  get focus(): HelmFocus {
    return this.focusValue;
  }

  get elapsedSeconds(): number {
    return this.elapsed;
  }

  get directTakeover(): boolean {
    return this.directTakeoverValue;
  }

  receiveOrder(order: CrewOrder): void {
    this.orders.receive(order);
  }

  /** Immediate physical takeover. The spoken standing order is untouched. */
  setDirectTakeover(active: boolean): void {
    if (active === this.directTakeoverValue) return;
    this.directTakeoverValue = active;
    this.pending = null;
    this.actionPhaseValue = active ? 'idle' : 'watching';
    if (active) {
      // Looking ahead while the player has the bar keeps bodily/visual cues
      // ageing normally without the crew writing a target.
      this.enterFocus('looking-ahead', true);
      return;
    }
    if (this.activeCourseDeg !== null || this.activeWindAngleDeg !== null) {
      // The returning hand can feel where the tiller was left. This is control
      // position, not hidden vessel telemetry, and prevents a remembered crew
      // target from suppressing the first post-takeover correction.
      this.lastRequestedRudder = this.controls.rudderTargetDeg;
      this.needsReacquisition = true;
      this.enterFocus(
        this.activeWindAngleDeg !== null
          ? 'checking-sails-wind'
          : 'checking-compass',
        true,
      );
    }
  }

  advanceSubstep(
    stepSeconds: number,
    observation: Readonly<HelmObservation>,
  ): void {
    assertPositiveFinite(stepSeconds, 'helmsman step');
    this.elapsed += stepSeconds;
    this.orders.advance(this.elapsed);
    const ready = this.orders.consumeReadyOrder();
    if (ready) this.activateOrder(ready);

    // Which side the wind is felt on is a standing bodily cue, not a glance.
    // When it flips, whatever balance was learned belongs to the old tack.
    const feltSide = observation.windAndSails.side;
    if (feltSide === 'port' || feltSide === 'starboard') {
      if (this.lastFeltWindSide !== null && feltSide !== this.lastFeltWindSide) {
        this.holdingHelm = 0;
      }
      this.lastFeltWindSide = feltSide;
    }

    if (this.directTakeoverValue) return;

    // A decision already made is always carried out, even if the order it
    // belonged to has ended in the meantime. A hand who has decided to put the
    // helm amidships puts it amidships; he does not stand there holding it
    // over because the evolution was called off half a second ago.
    this.advancePendingIntervention();

    // An evolution owns the tiller while it runs. The standing course order is
    // not cancelled — it is simply not what he is doing this minute, and the
    // ordinary drift/ease loop would fight the turn it just started.
    const maneuver = this.maneuverValue;
    if (
      maneuver !== null &&
      maneuver.phase !== 'complete' &&
      maneuver.phase !== 'failed'
    ) {
      this.advanceManeuver(maneuver, observation);
      return;
    }

    if (this.activeCourseDeg === null && this.activeWindAngleDeg === null) {
      return;
    }

    if (this.pending) return;

    // A clear swing while looking ahead is an event worth confirming. It does
    // not itself compute a helm command: it moves attention to the compass.
    if (
      this.focusValue === 'looking-ahead' &&
      observation.shipHead.strength !== 'none' &&
      observation.shipHead.strength !== 'hint' &&
      this.elapsed + 0.2 < this.focusUntil
    ) {
      this.enterFocus(
        this.activeWindAngleDeg !== null
          ? 'checking-sails-wind'
          : 'checking-compass',
        true,
      );
      return;
    }

    if (this.elapsed < this.focusUntil) return;
    switch (this.focusValue) {
      case 'checking-compass':
        this.finishCompassCheck(observation);
        break;
      case 'watching-response':
        this.finishResponseWatch(observation);
        break;
      case 'checking-sails-wind':
        this.finishSailsWindCheck(observation);
        break;
      case 'looking-ahead':
        this.finishLookAhead(observation);
        break;
    }
  }

  reset(): void {
    this.elapsed = 0;
    this.orders.reset();
    this.focusValue = 'looking-ahead';
    this.focusUntil = 0;
    this.actionPhaseValue = 'idle';
    this.activeCourseDeg = null;
    this.activeWindAngleDeg = null;
    this.activeOrderSequenceId = 0;
    this.directTakeoverValue = false;
    this.needsReacquisition = false;
    this.pending = null;
    this.lastRequestedRudder = 0;
    this.holdingHelm = 0;
    this.lastFeltWindSide = null;
    this.nextInterventionSequenceId = 1;
    this.lastCommandAt = -Infinity;
    this.interventionValues.length = 0;
    this.maneuverValue = null;
    this.maneuverValues.length = 0;
    this.crossSeenAtSeconds = 0;
    this.filledSeenAtSeconds = 0;
    this.attentionRandom.reset();
    this.actionRandom.reset();
    this.enterFocus('looking-ahead', true);
  }

  readout(): HelmsmanReadout {
    return {
      elapsedSeconds: this.elapsed,
      focus: this.focusValue,
      focusUntilSeconds: this.focusUntil,
      actionPhase: this.actionPhaseValue,
      directTakeover: this.directTakeoverValue,
      reacquiring: this.needsReacquisition,
      reference: this.activeWindAngleDeg !== null ? 'wind-angle' : 'compass',
      orderedCourseDeg: this.activeCourseDeg,
      orderedWindAngleDeg: this.activeWindAngleDeg,
      orderPhase: this.orders.phase,
      orderResponse: this.orders.response,
      lastRequestedRudderDeg: this.lastRequestedRudder,
      holdingHelmDeg: this.holdingHelm,
      interventionCount: this.interventionValues.length,
      latestIntervention:
        this.interventionValues[this.interventionValues.length - 1] ?? null,
      interventions: this.interventionValues,
      maneuver: this.maneuverValue,
      maneuvers: this.maneuverValues,
    };
  }

  private activateOrder(order: CrewOrder): void {
    if (order.cancelled) return;
    if (order.kind === 'steer-compass-course') {
      const payload = order.payload as { readonly courseDeg: number };
      this.activeCourseDeg = wrap360(payload.courseDeg);
      this.activeWindAngleDeg = null;
      this.activeOrderSequenceId = order.sequenceId;
      this.needsReacquisition = true;
      this.pending = null;
      // A fresh standing order restarts the balance estimate: the new course
      // may carry a different weather helm, and relearning costs only the
      // first few corrections.
      this.holdingHelm = 0;
      this.actionPhaseValue = 'idle';
      this.enterFocus('checking-compass', true);
      return;
    }
    if (order.kind === 'hold-apparent-wind-angle') {
      const payload = order.payload as {
        readonly apparentWindAngleDeg: number;
      };
      // An angle off the bow, either side: 0 is head to wind, 180 dead
      // before it. Which cheek is the tack she is on, not part of the order.
      this.activeWindAngleDeg = clamp(
        Math.abs(payload.apparentWindAngleDeg),
        0,
        180,
      );
      this.activeCourseDeg = null;
      this.activeOrderSequenceId = order.sequenceId;
      this.needsReacquisition = true;
      this.pending = null;
      this.holdingHelm = 0;
      this.actionPhaseValue = 'idle';
      // The first thing a hand does on this order is look up at the vane and
      // the luff, not down at the card.
      this.enterFocus('checking-sails-wind', true);
      return;
    }
    if (order.kind === 'tack' || order.kind === 'gybe') {
      this.beginManeuver(order);
      return;
    }
    if (order.kind === 'stand-down-helm') {
      this.activeWindAngleDeg = null;
      this.activeCourseDeg = null;
      this.maneuverValue = null;
      this.activeOrderSequenceId = order.sequenceId;
      this.needsReacquisition = false;
      this.pending = null;
      this.controls.commandRudderDeg(0);
      this.lastRequestedRudder = 0;
      this.holdingHelm = 0;
      this.actionPhaseValue = 'idle';
      this.orders.markWatching(this.elapsed);
      this.enterFocus('looking-ahead', true);
    }
  }

  /**
   * "Ready about — helm's a-lee."
   *
   * An evolution is a *sequence*, and this is the man who owns the tiller half
   * of it. He puts the helm over toward the wind for a tack or away from it
   * for a gybe, holds it, and watches for the wind to come onto the other
   * cheek. Everything he does after that comes from what he can feel: the
   * vane, the cloth, the weight in his hand.
   *
   * The new course rides on the order — "and steer oh-two-oh when she's
   * round" — so there is no gap between the tack finishing and the standing
   * order resuming in which a helmsman would be steering the old course
   * through a hundred degrees of wrong.
   */
  private beginManeuver(order: CrewOrder): void {
    const payload = order.payload as { readonly courseDeg: number };
    const entrySide = this.lastFeltWindSide;
    const maneuver: HelmManeuverState = {
      kind: order.kind === 'gybe' ? 'gybe' : 'tack',
      orderSequenceId: order.sequenceId,
      startedAtSeconds: this.elapsed,
      entrySide: entrySide ?? 'starboard',
      newCourseDeg: wrap360(payload.courseDeg),
      phase: 'helm-over',
      phaseEnteredAtSeconds: this.elapsed,
      crossedAtSeconds: null,
      finishedAtSeconds: null,
      shiftedHelm: false,
    };
    this.maneuverValue = maneuver;
    this.maneuverValues.push(maneuver);
    this.pending = null;
    if (entrySide === null) {
      // He cannot tack a ship when he cannot tell where the wind is. Refusing
      // is the honest answer; the navigator will hear it and wait.
      this.finishManeuver(maneuver, 'failed');
      return;
    }
    this.enterFocus('checking-sails-wind', true);
    this.commandManeuverHelm(
      this.maneuverHelmDeg(maneuver, false),
      'evolution-helm-over',
    );
  }

  /**
   * Which way the helm goes, and how far.
   *
   * The sign is not reasoned about here — it is S4's measured tack, where the
   * wind lay on the starboard bow and 25° of *negative* rudder carried her
   * through the eye (`SailingSteeringEvidence.runTackCase`). So: helm toward
   * the wind's cheek for a tack, away from it for a gybe, and reversed again
   * when she is going astern, because the blade meets the water the other way
   * round. Pinned by test rather than by this comment.
   */
  private maneuverHelmDeg(
    maneuver: HelmManeuverState,
    sternway: boolean,
  ): number {
    const magnitude =
      maneuver.kind === 'tack' ? TACK_HELM_DEG : GYBE_HELM_DEG;
    const towardTheWind = maneuver.entrySide === 'starboard' ? -1 : 1;
    const sense = maneuver.kind === 'tack' ? towardTheWind : -towardTheWind;
    return (sternway ? -sense : sense) * magnitude;
  }

  private advanceManeuver(
    maneuver: HelmManeuverState,
    observation: Readonly<HelmObservation>,
  ): void {
    const elapsedInManeuver = this.elapsed - maneuver.startedAtSeconds;
    const otherSide = maneuver.entrySide === 'port' ? 'starboard' : 'port';
    const side = observation.windAndSails.side;

    if (maneuver.phase === 'helm-over' || maneuver.phase === 'in-irons') {
      if (side === otherSide) {
        if (this.crossSeenAtSeconds === 0) this.crossSeenAtSeconds = this.elapsed;
        if (
          this.elapsed - this.crossSeenAtSeconds >=
          MANEUVER_CROSS_CONFIRM_SECONDS
        ) {
          maneuver.crossedAtSeconds = this.elapsed;
          this.enterManeuverPhase(maneuver, 'through');
          this.filledSeenAtSeconds = 0;
          // The helm stays over: she is through the wind but not yet full,
          // and taking it off here is how a tack is lost within sight of
          // finishing it.
        }
      } else {
        this.crossSeenAtSeconds = 0;
      }
    }

    switch (maneuver.phase) {
      case 'helm-over': {
        if (
          maneuver.kind === 'tack' &&
          !maneuver.shiftedHelm &&
          elapsedInManeuver >= IRONS_PATIENCE_SECONDS &&
          this.feelsStopped(observation)
        ) {
          // "Shift your helm." She is hanging in stays with the tiller dead
          // in his hand and the sails slatting; the way she has left is
          // astern, and astern the rudder answers the other way round.
          maneuver.shiftedHelm = true;
          this.enterManeuverPhase(maneuver, 'in-irons');
          this.commandManeuverHelm(
            this.maneuverHelmDeg(maneuver, true),
            'evolution-shift-helm',
          );
          return;
        }
        if (elapsedInManeuver >= this.maneuverTimeoutSeconds(maneuver)) {
          this.abandonManeuver(maneuver);
        }
        return;
      }
      case 'in-irons': {
        if (elapsedInManeuver >= this.maneuverTimeoutSeconds(maneuver)) {
          this.abandonManeuver(maneuver);
        }
        return;
      }
      case 'through': {
        const filling = observation.windAndSails.cloth !== 'luffing';
        if (!filling) {
          this.filledSeenAtSeconds = 0;
        } else {
          if (this.filledSeenAtSeconds === 0) {
            this.filledSeenAtSeconds = this.elapsed;
          }
          if (
            this.elapsed - this.filledSeenAtSeconds >=
            MANEUVER_FILL_CONFIRM_SECONDS
          ) {
            this.completeManeuver(maneuver);
            return;
          }
        }
        if (elapsedInManeuver >= this.maneuverTimeoutSeconds(maneuver)) {
          // She is round and drawing badly, but she is round. Steady her on
          // the new course and let the standing order sort the rest out.
          this.completeManeuver(maneuver);
        }
        return;
      }
      default:
        return;
    }
  }

  private maneuverTimeoutSeconds(maneuver: HelmManeuverState): number {
    return maneuver.kind === 'gybe'
      ? GYBE_TIMEOUT_SECONDS
      : MANEUVER_TIMEOUT_SECONDS;
  }

  /**
   * The tiller has gone dead and the cloth is slatting: no water over the
   * blade and no drive. This is what being in irons *feels* like, and it is
   * the only definition this module is allowed to have.
   */
  private feelsStopped(observation: Readonly<HelmObservation>): boolean {
    return (
      observation.tillerLoad.weight === 'light' &&
      observation.windAndSails.cloth === 'luffing'
    );
  }

  private completeManeuver(maneuver: HelmManeuverState): void {
    this.commandManeuverHelm(0, 'evolution-meet-her');
    this.finishManeuver(maneuver, 'complete');
    // "Steady as she goes on the new course." The order rode in with the
    // evolution, so the standing duty resumes on this board without the
    // captain having to say a second word.
    this.activeCourseDeg = maneuver.newCourseDeg;
    this.activeWindAngleDeg = null;
    this.activeOrderSequenceId = maneuver.orderSequenceId;
    this.holdingHelm = 0;
    this.needsReacquisition = true;
    this.enterFocus('checking-compass', true);
  }

  private abandonManeuver(maneuver: HelmManeuverState): void {
    this.commandManeuverHelm(0, 'evolution-abandoned');
    this.finishManeuver(maneuver, 'failed');
    // The old standing order is still his: she never went round, so she is
    // still on the board she started on and still wants that course.
    this.needsReacquisition = true;
    this.enterFocus('checking-compass', true);
  }

  private finishManeuver(
    maneuver: HelmManeuverState,
    phase: 'complete' | 'failed',
  ): void {
    this.enterManeuverPhase(maneuver, phase);
    maneuver.finishedAtSeconds = this.elapsed;
    this.crossSeenAtSeconds = 0;
    this.filledSeenAtSeconds = 0;
    this.orders.markWatching(this.elapsed);
  }

  private enterManeuverPhase(
    maneuver: HelmManeuverState,
    phase: HelmManeuverPhase,
  ): void {
    maneuver.phase = phase;
    maneuver.phaseEnteredAtSeconds = this.elapsed;
  }

  /**
   * A helm movement that belongs to an evolution rather than to course-keeping.
   *
   * It goes through the same pending decision/motor delay and the same single
   * `commandRudderDeg` path as every other thing he does — but it is not
   * subject to the settled-course cooldown or the minimum-change guard, which
   * exist to stop a bored hand fidgeting at a course he is holding. Ordering a
   * tack is not fidgeting.
   */
  private commandManeuverHelm(
    candidateRudderDeg: number,
    reason: HelmInterventionReason,
  ): void {
    const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.action;
    const decisionDelay = sampleShiftedLognormalSeconds(
      this.actionRandom,
      profile.decision,
    );
    const motorDelay = sampleShiftedLognormalSeconds(
      this.actionRandom,
      profile.motorInitiation,
    );
    this.pending = {
      consideredAtSeconds: this.elapsed,
      decisionAtSeconds: this.elapsed + decisionDelay,
      executeAtSeconds: this.elapsed + decisionDelay + motorDelay,
      candidateRudderDeg,
      perceivedCourseDeg: this.activeCourseDeg ?? 0,
      perceivedCourseErrorDeg: 0,
      reference: 'compass',
      reason,
      decided: null,
    };
    this.actionPhaseValue = 'considering';
  }

  /**
   * A look at the vane and the luff, which is what steering by the wind is.
   *
   * On a compass order this is just a glance at the sails and he goes back to
   * his card. On a wind-angle order it is the working observation, and the
   * only place a wind-driven correction can be born.
   */
  private finishSailsWindCheck(observation: Readonly<HelmObservation>): void {
    if (this.activeWindAngleDeg === null) {
      this.enterFocus(
        observation.compass.ageSeconds > 3.5
          ? 'checking-compass'
          : 'looking-ahead',
      );
      return;
    }
    const scheduled = this.considerWindAngleIntervention(observation);
    this.orders.markWatching(this.elapsed);
    if (!scheduled) {
      this.needsReacquisition = false;
      this.actionPhaseValue = 'watching';
      this.enterFocus('looking-ahead');
    }
  }

  private finishCompassCheck(observation: Readonly<HelmObservation>): void {
    if (this.activeWindAngleDeg !== null) {
      // The card is the slow reference on this order: he confirms roughly
      // where her head is and goes back to the sails. It writes no helm.
      this.enterFocus('looking-ahead');
      return;
    }
    if (
      observation.compass.readingDeg === null ||
      observation.compass.confidence !== 'focused'
    ) {
      // Acquisition has its own sampled delay. Stay engaged without turning a
      // failed glance into a new random dwell every substep.
      this.focusUntil = this.elapsed + 0.18;
      return;
    }
    const wasReacquiring = this.needsReacquisition;
    this.needsReacquisition = false;
    const scheduled = this.considerCourseIntervention(
      observation,
      wasReacquiring ? 'reacquire' : 'course-drift',
    );
    this.orders.markWatching(this.elapsed);
    if (!scheduled) {
      this.actionPhaseValue = 'watching';
      this.enterFocus('looking-ahead');
    }
  }

  private finishResponseWatch(observation: Readonly<HelmObservation>): void {
    if (this.activeWindAngleDeg !== null) {
      this.finishWindResponseWatch(observation);
      return;
    }
    // The turn being watched is the correction beyond the carried helm; a
    // vessel holding her balance helm is at rest, not mid-manoeuvre.
    const correction = this.lastRequestedRudder - this.holdingHelm;
    if (Math.abs(correction) >= MINIMUM_WATCHED_CORRECTION_DEG) {
      const requestedTurn: SwingDirection =
        correction > 0 ? 'port' : 'starboard';
      const answering = observation.shipHead.swing === requestedTurn;
      const course = observation.compass.readingDeg;
      // She answering is necessary but never sufficient: the helm comes off
      // when the card has crossed the order, or when the felt swing will
      // plainly carry her there — the same lead a hand uses to "meet her".
      // A coarse trend label alone no longer releases material course error,
      // and with no reading there is no release at all.
      if (answering && course !== null && this.activeCourseDeg !== null) {
        const error = signedAngleDifferenceDeg(this.activeCourseDeg, course);
        const hasCrossed = Math.sign(error) === Math.sign(correction);
        const anticipatedError =
          error -
          perceivedHeadingRateDegPerS(
            observation.shipHead.swing,
            observation.shipHead.strength,
          ) *
            ANTICIPATION_SECONDS;
        const arriving =
          Math.sign(anticipatedError) === Math.sign(correction) ||
          Math.abs(anticipatedError) <= RELEASE_BAND_DEG;
        if (
          (hasCrossed || arriving) &&
          this.scheduleIntervention(
            this.holdingHelm,
            course,
            error,
            hasCrossed ? 'counter-swing' : 'ease-as-she-answers',
          )
        ) {
          return;
        }
      }
    }
    this.enterFocus(
      observation.compass.ageSeconds > 2.3
        ? 'checking-compass'
        : 'looking-ahead',
    );
  }

  /**
   * Watching her answer on a wind order.
   *
   * The cloth settling is the first thing he gets — quicker than the vane and
   * quicker than the card — so a correction made because the luff shook comes
   * off when the luff stops. Otherwise he waits for the next vane reading to
   * say she has arrived, and looks again if it has not come.
   */
  private finishWindResponseWatch(
    observation: Readonly<HelmObservation>,
  ): void {
    const target = this.activeWindAngleDeg!;
    const correction = this.lastRequestedRudder - this.holdingHelm;
    if (Math.abs(correction) >= MINIMUM_WATCHED_CORRECTION_DEG) {
      const wind = observation.windAndSails;
      const settled = wind.cloth === 'drawing';
      const reading = wind.angleOffBowDeg;
      const fresh =
        reading !== null && wind.angleAgeSeconds <= WIND_ANGLE_STALE_SECONDS;
      const arrived =
        fresh && Math.abs(reading! - target) <= WIND_ANGLE_DEADBAND_DEG;
      if (
        (settled || arrived) &&
        this.scheduleIntervention(
          this.holdingHelm,
          reading ?? target,
          fresh ? reading! - target : 0,
          'ease-as-she-answers',
          'wind-angle',
        )
      ) {
        return;
      }
    }
    this.enterFocus('checking-sails-wind');
  }

  private finishLookAhead(observation: Readonly<HelmObservation>): void {
    if (this.activeWindAngleDeg !== null) {
      // On a wind order his attention lives with the sails; the card is only
      // worth a glance when it has gone properly stale.
      this.enterFocus(
        observation.windAndSails.cloth !== 'drawing' ||
          observation.windAndSails.angleAgeSeconds > 3
          ? 'checking-sails-wind'
          : observation.compass.ageSeconds > 20
            ? 'checking-compass'
            : 'looking-ahead',
      );
      return;
    }
    if (
      observation.compass.ageSeconds > 3.4 ||
      observation.shipHead.strength === 'clear' ||
      observation.shipHead.strength === 'fast' ||
      observation.tillerLoad.trend === 'loading'
    ) {
      this.enterFocus('checking-compass');
      return;
    }
    if (
      observation.windAndSails.cloth !== 'drawing' &&
      this.attentionRandom.next() < 0.35
    ) {
      this.enterFocus('checking-sails-wind');
      return;
    }
    this.enterFocus('looking-ahead');
  }

  /**
   * "Keep her full and by" — the wind-angle correction, from cues only.
   *
   * Two things can start one. The vane says she has wandered off the angle he
   * was given, or the luff shakes, which says she has come too close whatever
   * the vane last read. Both are delayed perceptions; neither is the
   * mathematical apparent-wind angle, which this class never receives.
   *
   * Which way the helm goes depends on the cheek the wind is on: bearing away
   * from a starboard wind turns her head to port. With no felt side there is
   * no correction to make — he goes and looks again.
   */
  private considerWindAngleIntervention(
    observation: Readonly<HelmObservation>,
  ): boolean {
    const target = this.activeWindAngleDeg;
    if (target === null) return false;
    const wind = observation.windAndSails;
    if (wind.side === 'unclear') return false;
    // Bearing away from the wind means turning the bow away from the cheek it
    // is on, and positive helm turns her head to port.
    const bearAwayHelmSign = wind.side === 'starboard' ? 1 : -1;

    const reading = wind.angleOffBowDeg;
    const fresh = reading !== null && wind.angleAgeSeconds <= WIND_ANGLE_STALE_SECONDS;
    // Shaking cloth is its own evidence that she is too close to the wind,
    // and it arrives before a fresh vane reading does.
    const shaking = wind.cloth === 'luffing';

    let errorDeg: number;
    let reason: HelmInterventionReason;
    if (shaking && (!fresh || reading! <= target)) {
      // Treat the shake as "a deadband too close", so the answer is a real
      // but modest bear-away rather than a number invented from the flag.
      errorDeg = -WIND_ANGLE_DEADBAND_DEG * 1.5;
      reason = 'sails-shaking';
    } else if (fresh) {
      errorDeg = reading! - target;
      reason = 'wind-angle-drift';
    } else {
      return false;
    }

    if (Math.abs(errorDeg) <= WIND_ANGLE_DEADBAND_DEG) {
      const previousCorrection = this.lastRequestedRudder - this.holdingHelm;
      if (Math.abs(previousCorrection) < MINIMUM_TARGET_CHANGE_DEG) return false;
      return this.scheduleIntervention(
        this.holdingHelm,
        reading ?? target,
        errorDeg,
        'ease-as-she-answers',
        'wind-angle',
      );
    }

    // Too small an angle means she is pinching and must be borne away; too
    // large means she has fallen off and must be brought up.
    const correction = clamp(
      this.holdingHelm + bearAwayHelmSign * -errorDeg * 0.32,
      -MAX_WORKING_RUDDER_DEG,
      MAX_WORKING_RUDDER_DEG,
    );
    const scheduled = this.scheduleIntervention(
      correction,
      reading ?? target,
      errorDeg,
      reason,
      'wind-angle',
    );
    if (scheduled && reason === 'wind-angle-drift') {
      this.holdingHelm = clamp(
        this.holdingHelm +
          Math.sign(correction - this.holdingHelm) * HOLDING_HELM_LEARN_STEP_DEG,
        -HOLDING_HELM_LIMIT_DEG,
        HOLDING_HELM_LIMIT_DEG,
      );
    }
    return scheduled;
  }

  private considerCourseIntervention(
    observation: Readonly<HelmObservation>,
    fallbackReason: HelmInterventionReason,
  ): boolean {
    const reading = observation.compass.readingDeg;
    const target = this.activeCourseDeg;
    if (reading === null || target === null) return false;
    const errorDeg = signedAngleDifferenceDeg(target, reading);
    const trendDegPerS = perceivedHeadingRateDegPerS(
      observation.shipHead.swing,
      observation.shipHead.strength,
    );
    const anticipatedReading = wrap360(
      reading + trendDegPerS * ANTICIPATION_SECONDS,
    );
    const anticipatedErrorDeg = signedAngleDifferenceDeg(
      target,
      anticipatedReading,
    );
    const deadband =
      BASE_COURSE_DEADBAND_DEG +
      (observation.compass.confidence === 'focused' ? 0 : 0.6);

    let desired = this.lastRequestedRudder;
    let reason = fallbackReason;
    const previousCorrection = this.lastRequestedRudder - this.holdingHelm;
    if (Math.abs(errorDeg) <= deadband) {
      // Inside the deadband, rest is the carried balance helm, not amidships:
      // taking the standing helm off is what restarts the weather-helm drift.
      if (Math.abs(previousCorrection) < MINIMUM_TARGET_CHANGE_DEG) {
        return false;
      }
      desired = this.holdingHelm;
      reason = 'ease-as-she-answers';
    } else {
      // The finite correction rides on top of the carried helm, and the
      // minimum-pulse floor applies to the correction, not the total.
      const correction = -anticipatedErrorDeg * 0.82;
      desired = clamp(
        this.holdingHelm +
          (Math.abs(correction) < 3 ? -Math.sign(errorDeg) * 3 : correction),
        -MAX_WORKING_RUDDER_DEG,
        MAX_WORKING_RUDDER_DEG,
      );
      if (
        Math.abs(previousCorrection) >= MINIMUM_WATCHED_CORRECTION_DEG &&
        Math.sign(anticipatedErrorDeg) !== Math.sign(errorDeg)
      ) {
        desired = clamp(
          this.holdingHelm + Math.sign(previousCorrection) * -4,
          -MAX_WORKING_RUDDER_DEG,
          MAX_WORKING_RUDDER_DEG,
        );
        reason = 'counter-swing';
      }
    }
    const scheduled = this.scheduleIntervention(
      desired,
      reading,
      errorDeg,
      reason,
    );
    if (
      scheduled &&
      (reason === 'course-drift' || reason === 'reacquire')
    ) {
      // Each drift he has to correct teaches a little standing helm on the
      // corrective side; alternating corrections cancel and teach nothing.
      // This is the felt "she carries weather helm on this course", learned
      // from his own hands rather than from hidden telemetry.
      this.holdingHelm = clamp(
        this.holdingHelm +
          Math.sign(desired - this.holdingHelm) * HOLDING_HELM_LEARN_STEP_DEG,
        -HOLDING_HELM_LIMIT_DEG,
        HOLDING_HELM_LIMIT_DEG,
      );
    }
    return scheduled;
  }

  private scheduleIntervention(
    candidateRudderDeg: number,
    perceivedCourseDeg: number,
    perceivedCourseErrorDeg: number,
    reason: HelmInterventionReason,
    reference: HelmReference = 'compass',
  ): boolean {
    // Settled means resting at the carried balance helm, which is only
    // amidships until the vessel has taught him otherwise.
    const settledAtRest =
      Math.abs(this.lastRequestedRudder - this.holdingHelm) <
      MINIMUM_TARGET_CHANGE_DEG;
    if (
      this.pending ||
      this.directTakeoverValue ||
      this.elapsed - this.lastCommandAt < 0.8 ||
      (reason === 'course-drift' &&
        settledAtRest &&
        this.elapsed - this.lastCommandAt <
          SETTLED_CORRECTION_COOLDOWN_SECONDS) ||
      Math.abs(candidateRudderDeg - this.lastRequestedRudder) <
        MINIMUM_TARGET_CHANGE_DEG
    ) {
      return false;
    }
    const profile = COMPETENT_HUMAN_OPERATOR_PROFILE.action;
    const decisionDelay = sampleShiftedLognormalSeconds(
      this.actionRandom,
      profile.decision,
    );
    const motorDelay = sampleShiftedLognormalSeconds(
      this.actionRandom,
      profile.motorInitiation,
    );
    this.pending = {
      consideredAtSeconds: this.elapsed,
      decisionAtSeconds: this.elapsed + decisionDelay,
      executeAtSeconds: this.elapsed + decisionDelay + motorDelay,
      candidateRudderDeg,
      perceivedCourseDeg,
      perceivedCourseErrorDeg,
      reference,
      reason,
      decided: null,
    };
    this.actionPhaseValue = 'considering';
    this.focusUntil = this.pending.executeAtSeconds;
    return true;
  }

  private advancePendingIntervention(): void {
    const pending = this.pending;
    if (!pending) return;
    if (!pending.decided && this.elapsed >= pending.decisionAtSeconds) {
      const inaccurate =
        pending.candidateRudderDeg +
        this.actionRandom.normal() *
          COMPETENT_HUMAN_OPERATOR_PROFILE.action.rudderErrorStdDeg;
      const requested =
        Math.abs(pending.candidateRudderDeg) < 0.5
          ? 0
          : Math.round(
              clamp(inaccurate, -RUDDER_LIMIT_DEG, RUDDER_LIMIT_DEG),
            );
      const intervention: HelmIntervention = {
        sequenceId: this.nextInterventionSequenceId++,
        orderSequenceId: this.activeOrderSequenceId,
        consideredAtSeconds: pending.consideredAtSeconds,
        decidedAtSeconds: pending.decisionAtSeconds,
        executeAtSeconds: pending.executeAtSeconds,
        requestedRudderDeg: requested,
        previousRequestedRudderDeg: this.lastRequestedRudder,
        perceivedCourseDeg: pending.perceivedCourseDeg,
        perceivedCourseErrorDeg: pending.perceivedCourseErrorDeg,
        reference: pending.reference,
        reason: pending.reason,
      };
      pending.decided = intervention;
      this.interventionValues.push(intervention);
      this.actionPhaseValue = 'motor-delay';
    }
    if (pending.decided && this.elapsed >= pending.executeAtSeconds) {
      this.controls.commandRudderDeg(pending.decided.requestedRudderDeg);
      this.lastRequestedRudder = pending.decided.requestedRudderDeg;
      this.lastCommandAt = this.elapsed;
      this.pending = null;
      this.actionPhaseValue = 'watching';
      this.orders.markWatching(this.elapsed);
      this.enterFocus('watching-response', true);
    }
  }

  private enterFocus(focus: HelmFocus, immediate = false): void {
    this.focusValue = focus;
    const attention = COMPETENT_HUMAN_OPERATOR_PROFILE.attention;
    let range: Readonly<BoundedRange>;
    switch (focus) {
      case 'checking-compass':
        range = attention.checkingCompassSeconds;
        break;
      case 'watching-response':
        range = attention.watchingResponseSeconds;
        break;
      case 'checking-sails-wind':
        range = attention.checkingSailsWindSeconds;
        break;
      case 'looking-ahead':
        // Busy means a live correction is in beyond the carried helm; resting
        // at the balance helm is the comfortable state, exactly as amidships
        // was before the vessel taught him to carry any.
        range =
          (this.activeCourseDeg !== null || this.activeWindAngleDeg !== null) &&
          (Math.abs(this.lastRequestedRudder - this.holdingHelm) >=
            MINIMUM_WATCHED_CORRECTION_DEG ||
            this.needsReacquisition)
            ? attention.lookingAheadBusySeconds
            : attention.lookingAheadComfortableSeconds;
        break;
    }
    const dwell = this.attentionRandom.between(range);
    this.focusUntil = this.elapsed + (immediate ? Math.max(dwell, range.min) : dwell);
  }
}

function perceivedHeadingRateDegPerS(
  direction: SwingDirection,
  strength: SwingStrength,
): number {
  if (direction === 'steady') return 0;
  const magnitude =
    strength === 'fast'
      ? 1.4
      : strength === 'clear'
        ? 0.72
        : strength === 'hint'
          ? 0.25
          : 0;
  return direction === 'starboard' ? magnitude : -magnitude;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive, got ${value}`);
  }
}
