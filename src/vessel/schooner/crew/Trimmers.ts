import {
  HARD_TRIM_DEG,
  WORKING_TRIM_DEG,
  type SailingControls,
} from '../SailingControls';
import { RIG_TRIM_LIMITS, type SailName } from '../rig';
import type { SailTrimObservation } from './CrewObservations';
import {
  StationOrderPipeline,
  type CrewOrder,
  type CrewOrderPhase,
  type CrewStationId,
  type StationOrderResponse,
} from './CrewOrders';
import {
  COMPETENT_HUMAN_OPERATOR_PROFILE,
  createHumanRandomStream,
  sampleShiftedLognormalSeconds,
  type HumanRandomStream,
} from './HumanOperator';

/**
 * The sails one hand can work continuously.
 *
 * The rig has eight sails and six of these: the gaff topsail is slaved to the
 * mainsail sheet by the S4 rig contract, and the fisherman has a side rather
 * than a trim, dipped as a set piece rather than trimmed against the wind.
 */
export const TRIM_STATIONS: readonly SailName[] = Object.freeze([
  'mainsail',
  'foresail',
  'foreStaysail',
  'jib',
  'flyingJib',
  'foreTopsail',
]);

export type TrimDecision =
  | 'acceptable'
  | 'haul'
  | 'ease'
  | 'overpowered-ease'
  | 'cannot-draw';

export type TrimActionPhase = 'idle' | 'considering' | 'motor-delay' | 'watching';

export interface TrimAdjustment {
  readonly sequenceId: number;
  readonly orderSequenceId: number;
  readonly station: SailName;
  readonly consideredAtSeconds: number;
  readonly decidedAtSeconds: number;
  readonly executeAtSeconds: number;
  readonly decision: Exclude<TrimDecision, 'acceptable' | 'cannot-draw'>;
  readonly requestedTrimDeg: number;
  readonly previousTrimDeg: number;
  /** What he saw when he decided, in his own words. */
  readonly cloth: SailTrimObservation['cloth'];
  readonly fullness: SailTrimObservation['fullness'];
  readonly sheetLoad: SailTrimObservation['sheetLoad'];
}

export interface TrimmerStationReadout {
  readonly station: SailName;
  readonly standing: boolean;
  readonly directTakeover: boolean;
  readonly orderPhase: CrewOrderPhase;
  readonly orderResponse: Readonly<StationOrderResponse> | null;
  readonly actionPhase: TrimActionPhase;
  readonly lastDecision: TrimDecision;
  readonly cannotDraw: boolean;
  readonly adjustmentCount: number;
  readonly latestAdjustment: Readonly<TrimAdjustment> | null;
  readonly adjustments: readonly TrimAdjustment[];
  /** Evolutions this sheet has been worked through. */
  readonly maneuverCount: number;
  /** Which part of an evolution he is on, or null between them. */
  readonly maneuverPhase: ManeuverPhase | null;
}

export interface TrimmersReadout {
  readonly stations: readonly TrimmerStationReadout[];
  readonly adjustmentCount: number;
  readonly maneuverCount: number;
}

/**
 * How much sheet one decision is worth, degrees of trim.
 *
 * A hand hauls or eases a definite amount and then looks: a foot of sheet, not
 * a continuously varying servo output. These are the sizes of those bites, and
 * they are feel numbers in the same sense the operator profile's timings are.
 */
const TRIM_STEP_DEG = Object.freeze({
  /** Cloth plainly shaking — take a real bite of it. */
  shaking: 6,
  /** A tremble along the luff — a touch. */
  trembling: 3,
  /** Sheeted too flat for the wind she is on; let her breathe. */
  stalled: 4.5,
  /** She is lying over and staying there. */
  overpressed: 8,
  /** Trying her a little further out to see whether she will take it. */
  probe: 2.5,
});

/**
 * How often a settled hand tries his sheet further out.
 *
 * Long enough that it reads as a man checking his work rather than fidgeting,
 * short enough that a badly set sail is found within a few minutes. Sampled
 * per station so six sails do not all reach for their sheets together.
 */
const PROBE_INTERVAL_SECONDS = Object.freeze({ min: 22, max: 40 });

/**
 * How much longer he waits after a trial that had to be taken back.
 *
 * Once he has found the edge of this sail's trim he stops reaching for it
 * every half minute: the interval doubles each time a trial fails, up to the
 * limit, and returns to its base when the wind changes the answer by making
 * the sail complain on its own.
 */
const PROBE_BACKOFF_LIMIT = 6;

/**
 * How long a tremble must persist before it is worth crossing the deck for.
 * A sail shivers as she comes over a sea without anybody touching anything.
 */
const TREMBLE_PATIENCE_SECONDS = 1.4;

/**
 * How long the hand watches his own sail after moving it.
 *
 * The sheet itself takes about half a second for a bite this size, and the
 * cloth's perception filter is another half; below about two seconds he would
 * be judging the answer to a question he has not finished asking.
 */
const WATCH_AFTER_ACTION_SECONDS = Object.freeze({ min: 2.2, max: 3.6 });

/** Ordinary re-look interval when nothing wants doing. */
const SETTLED_LOOK_SECONDS = Object.freeze({ min: 2.8, max: 6.5 });

/**
 * How long a sail must stay unworkable, through repeated attempts, before the
 * hand reports that it cannot be made to draw.
 *
 * Deliberately a duration and a count rather than a flag: sustained observed
 * evidence is the contract, and a single bad glance is not evidence.
 */
const CANNOT_DRAW_SECONDS = 25;
const CANNOT_DRAW_MINIMUM_ATTEMPTS = 3;

/**
 * How long a hand waits before he believes the wind is on the other cheek.
 *
 * Same reason the helmsman waits: the wind reads unclear as it crosses the
 * bow, and hauling a sheet across on one confused moment is how a headsail
 * ends up aback.
 */
const MANEUVER_CROSS_CONFIRM_SECONDS = 1.2;
/**
 * How long the fore staysail is held on its old sheet after she crosses.
 *
 * "Hold the weather sheet till she pays off" — a backed headsail forward is
 * what pushes the bow across the fill band, and S4's tack evidence measured
 * that it is what makes the maneuver complete rather than hang. The hand lets
 * it draw when he sees her paying off, which is a few seconds of watching.
 */
const BACKED_STAYSAIL_HOLD_SECONDS = Object.freeze({ min: 4, max: 8 });
/** How long after she is round before the sheets come off the flat haul. */
const MANEUVER_SETTLE_SECONDS = Object.freeze({ min: 8, max: 14 });
/** The whole evolution's patience at a sheet, matching the helm's. */
const MANEUVER_TIMEOUT_SECONDS = 110;

type ManeuverPhase = 'hauling-flat' | 'holding-across' | 'across' | 'settling';

interface SheetManeuver {
  readonly kind: 'tack' | 'gybe';
  readonly orderSequenceId: number;
  readonly startedAtSeconds: number;
  readonly entrySide: 'port' | 'starboard';
  readonly wasStanding: boolean;
  phase: ManeuverPhase;
  crossedAtSeconds: number | null;
  crossSeenAtSeconds: number;
  actAtSeconds: number;
  pendingTrimDeg: number | null;
}

interface PendingAdjustment {
  readonly consideredAtSeconds: number;
  readonly decisionAtSeconds: number;
  readonly executeAtSeconds: number;
  readonly decision: TrimAdjustment['decision'];
  readonly candidateTrimDeg: number;
  readonly cloth: SailTrimObservation['cloth'];
  readonly fullness: SailTrimObservation['fullness'];
  readonly sheetLoad: SailTrimObservation['sheetLoad'];
  decided: TrimAdjustment | null;
}

/**
 * One hand, at one sheet, with a standing order to keep his sail drawing.
 *
 * He knows three things: what his cloth is doing, what his sheet feels like,
 * and whether she is carrying too much. He does not know his sail's angle of
 * attack, the apparent wind angle, the heel in degrees, or what the ideal trim
 * for this wind would be — the S4 best-trim schedule exists, and this class
 * cannot call it. What he does instead is what a hand does: ease until she
 * complains, harden until she stops, and otherwise leave the sheet alone.
 */
class TrimmerStation {
  private readonly orders: StationOrderPipeline;
  private readonly actionRandom: HumanRandomStream;
  private readonly attentionRandom: HumanRandomStream;
  private readonly limits: { readonly minDeg: number; readonly maxDeg: number };
  private readonly hardTrimDeg: number;
  /** Where the sheet goes back to when an evolution is over. */
  private readonly workingTrimDeg: number;
  /** A yard, not a sheet — see `decideBrace`. */
  private readonly isBrace: boolean;
  private elapsed = 0;
  private standingValue = false;
  private activeOrderSequenceId = 0;
  private directTakeoverValue = false;
  private phase: TrimActionPhase = 'idle';
  private pending: PendingAdjustment | null = null;
  private nextLookAt = 0;
  private lastDecisionValue: TrimDecision = 'acceptable';
  private struggleSeconds = 0;
  private lastProbeAtSeconds = 0;
  private triedHerFurtherOut = false;
  private probeBackoff = 1;
  private readonly probeIntervalSeconds: number;
  private blockedAttempts = 0;
  private cannotDrawValue = false;
  private nextSequenceId = 1;
  private readonly adjustmentValues: TrimAdjustment[] = [];
  private maneuver: SheetManeuver | null = null;
  private maneuverCountValue = 0;

  constructor(
    readonly sail: SailName,
    private readonly controls: SailingControls,
    seed: number,
  ) {
    this.orders = new StationOrderPipeline(sail as CrewStationId, seed);
    this.actionRandom = createHumanRandomStream(seed, sail, 'action');
    this.attentionRandom = createHumanRandomStream(seed, sail, 'attention');
    this.limits = RIG_TRIM_LIMITS[sail];
    this.probeIntervalSeconds = this.attentionRandom.between(
      PROBE_INTERVAL_SECONDS,
    );
    this.hardTrimDeg = HARD_TRIM_DEG[sail] ?? Math.abs(this.limits.maxDeg) * 0.2;
    this.isBrace = sail === 'foreTopsail';
    // A yard has no eased working position the way a sheet does: it is braced
    // where it meets the wind and that is where it stays.
    this.workingTrimDeg = this.isBrace ? this.hardTrimDeg : WORKING_TRIM_DEG;
  }

  get standing(): boolean {
    return this.standingValue;
  }

  receiveOrder(order: CrewOrder): void {
    this.orders.receive(order);
  }

  /**
   * The player has taken this sheet in his own hands. The hand lets go at
   * once and the standing order survives — exactly the helm's rule.
   */
  setDirectTakeover(active: boolean): void {
    if (active === this.directTakeoverValue) return;
    this.directTakeoverValue = active;
    this.pending = null;
    this.maneuver = null;
    this.phase = 'idle';
    if (!active && this.standingValue) {
      // He comes back to a sheet he did not set, and has to look at the sail
      // before he touches it again.
      this.nextLookAt =
        this.elapsed + this.attentionRandom.between(WATCH_AFTER_ACTION_SECONDS);
    }
  }

  advanceSubstep(
    stepSeconds: number,
    observation: Readonly<SailTrimObservation>,
  ): void {
    this.elapsed += stepSeconds;
    this.orders.advance(this.elapsed);
    const ready = this.orders.consumeReadyOrder();
    if (ready) this.activateOrder(ready, observation);

    if (this.directTakeoverValue) return;

    // An evolution comes before the standing duty and does not need it: a hand
    // hauls his sheet across on "lee-oh" whether or not he was told to keep
    // the sail drawing beforehand.
    if (this.maneuver) {
      this.advanceManeuver(this.maneuver, observation);
      return;
    }

    if (!this.standingValue) return;

    this.advancePendingAdjustment();
    if (this.pending) return;

    // Sustained trouble is measured whether or not he is currently looking:
    // it is the state of the sail, and he is standing next to it.
    if (observation.working && observation.cloth === 'shaking') {
      this.struggleSeconds += stepSeconds;
    } else if (observation.cloth === 'drawing' || !observation.working) {
      this.struggleSeconds = 0;
      this.blockedAttempts = 0;
      this.cannotDrawValue = false;
    }
    if (observation.working && observation.fullness === 'stalled') {
      // The wind has moved enough to make her stall where she stands, so
      // whatever he learned about her edge is out of date and worth
      // re-asking sooner.
      this.probeBackoff = 1;
    }

    if (this.elapsed < this.nextLookAt) return;
    this.decide(observation);
  }

  reset(): void {
    this.elapsed = 0;
    this.orders.reset();
    this.standingValue = false;
    this.activeOrderSequenceId = 0;
    this.directTakeoverValue = false;
    this.phase = 'idle';
    this.pending = null;
    this.nextLookAt = 0;
    this.lastDecisionValue = 'acceptable';
    this.struggleSeconds = 0;
    this.blockedAttempts = 0;
    this.cannotDrawValue = false;
    this.lastProbeAtSeconds = 0;
    this.triedHerFurtherOut = false;
    this.probeBackoff = 1;
    this.nextSequenceId = 1;
    this.adjustmentValues.length = 0;
    this.maneuver = null;
    this.maneuverCountValue = 0;
    this.actionRandom.reset();
    this.attentionRandom.reset();
  }

  /** The sustained "I cannot make her draw" report, without allocating. */
  get cannotDraw(): boolean {
    return this.cannotDrawValue;
  }

  readout(): TrimmerStationReadout {
    return {
      station: this.sail,
      standing: this.standingValue,
      directTakeover: this.directTakeoverValue,
      orderPhase: this.orders.phase,
      orderResponse: this.orders.response,
      actionPhase: this.phase,
      lastDecision: this.lastDecisionValue,
      cannotDraw: this.cannotDrawValue,
      adjustmentCount: this.adjustmentValues.length,
      latestAdjustment:
        this.adjustmentValues[this.adjustmentValues.length - 1] ?? null,
      adjustments: this.adjustmentValues,
      maneuverCount: this.maneuverCountValue,
      maneuverPhase: this.maneuver?.phase ?? null,
    };
  }

  private activateOrder(
    order: CrewOrder,
    observation: Readonly<SailTrimObservation>,
  ): void {
    if (order.cancelled) return;
    if (order.kind === 'tack' || order.kind === 'gybe') {
      this.beginManeuver(order, observation);
      return;
    }
    if (order.kind === 'trim-to-draw') {
      this.standingValue = true;
      this.activeOrderSequenceId = order.sequenceId;
      this.phase = 'idle';
      this.pending = null;
      this.struggleSeconds = 0;
      this.blockedAttempts = 0;
      this.cannotDrawValue = false;
      this.lastProbeAtSeconds = this.elapsed;
      this.triedHerFurtherOut = false;
      this.probeBackoff = 1;
      // He has heard it and turns to his sail. The first look costs what a
      // look costs; it is not free just because the order was.
      this.nextLookAt = this.elapsed;
      return;
    }
    if (order.kind === 'stand-down-trim') {
      this.standingValue = false;
      this.activeOrderSequenceId = order.sequenceId;
      this.phase = 'idle';
      this.pending = null;
      this.lastDecisionValue = 'acceptable';
      this.orders.markWatching(this.elapsed);
    }
  }

  /**
   * "Ready about — haul taut."
   *
   * The sheet half of an evolution, and it is a sequence rather than a
   * decision: haul flat for the turn, hold the weather sheet forward until
   * she pays off, then over and eased to the working trim on the new board.
   * S4's tack evidence measured that the flat haul at the *order* — not at the
   * crossing — is what makes the maneuver complete, so that is the first thing
   * this hand does.
   */
  private beginManeuver(
    order: CrewOrder,
    observation: Readonly<SailTrimObservation>,
  ): void {
    const currentTrimDeg = this.controls.trimDeg(this.sail);
    const entrySide =
      observation.windSide !== 'unclear'
        ? observation.windSide
        : // No side to the wind this instant; his own sheet says where it was.
          currentTrimDeg >= 0
          ? 'starboard'
          : 'port';
    const leewardSign = entrySide === 'port' ? -1 : 1;
    this.maneuver = {
      kind: order.kind === 'gybe' ? 'gybe' : 'tack',
      orderSequenceId: order.sequenceId,
      startedAtSeconds: this.elapsed,
      entrySide,
      wasStanding: this.standingValue,
      phase: 'hauling-flat',
      crossedAtSeconds: null,
      crossSeenAtSeconds: 0,
      actAtSeconds:
        this.elapsed +
        sampleShiftedLognormalSeconds(
          this.actionRandom,
          COMPETENT_HUMAN_OPERATOR_PROFILE.action.motorInitiation,
        ),
      pendingTrimDeg: leewardSign * this.hardTrimDeg,
    };
    this.maneuverCountValue++;
    this.pending = null;
    this.phase = 'motor-delay';
  }

  private advanceManeuver(
    maneuver: SheetManeuver,
    observation: Readonly<SailTrimObservation>,
  ): void {
    if (
      maneuver.pendingTrimDeg !== null &&
      this.elapsed >= maneuver.actAtSeconds
    ) {
      this.controls.commandTrimDeg(this.sail, maneuver.pendingTrimDeg);
      maneuver.pendingTrimDeg = null;
      this.phase = 'watching';
    }

    const otherSide = maneuver.entrySide === 'port' ? 'starboard' : 'port';
    const leewardSign = maneuver.entrySide === 'port' ? -1 : 1;

    if (maneuver.phase === 'hauling-flat') {
      if (observation.windSide === otherSide) {
        if (maneuver.crossSeenAtSeconds === 0) {
          maneuver.crossSeenAtSeconds = this.elapsed;
        }
        if (
          this.elapsed - maneuver.crossSeenAtSeconds >=
          MANEUVER_CROSS_CONFIRM_SECONDS
        ) {
          maneuver.crossedAtSeconds = this.elapsed;
          if (this.sail === 'foreStaysail' && maneuver.kind === 'tack') {
            // The one sheet that is deliberately left aback.
            maneuver.phase = 'holding-across';
            maneuver.actAtSeconds =
              this.elapsed +
              this.attentionRandom.between(BACKED_STAYSAIL_HOLD_SECONDS);
          } else {
            maneuver.phase = 'across';
            maneuver.pendingTrimDeg = -leewardSign * this.hardTrimDeg;
            maneuver.actAtSeconds =
              this.elapsed +
              sampleShiftedLognormalSeconds(
                this.actionRandom,
                COMPETENT_HUMAN_OPERATOR_PROFILE.action.motorInitiation,
              );
          }
        }
      } else {
        maneuver.crossSeenAtSeconds = 0;
      }
    } else if (
      maneuver.phase === 'holding-across' &&
      this.elapsed >= maneuver.actAtSeconds
    ) {
      maneuver.phase = 'across';
      maneuver.pendingTrimDeg = -leewardSign * this.hardTrimDeg;
      maneuver.actAtSeconds = this.elapsed;
    } else if (
      maneuver.phase === 'across' &&
      maneuver.pendingTrimDeg === null &&
      maneuver.crossedAtSeconds !== null
    ) {
      maneuver.phase = 'settling';
      maneuver.actAtSeconds =
        this.elapsed + this.attentionRandom.between(MANEUVER_SETTLE_SECONDS);
    } else if (
      maneuver.phase === 'settling' &&
      this.elapsed >= maneuver.actAtSeconds
    ) {
      // Off the flat maneuvering haul and onto the steady working trim of the
      // new board; from here the standing duty has her again.
      this.controls.commandTrimDeg(
        this.sail,
        -leewardSign * this.workingTrimDeg,
      );
      this.endManeuver(maneuver);
      return;
    }

    if (this.elapsed - maneuver.startedAtSeconds >= MANEUVER_TIMEOUT_SECONDS) {
      // She never went round. The sheets belong back on the board she is
      // actually on, which is the one she started on.
      this.controls.commandTrimDeg(
        this.sail,
        leewardSign * this.workingTrimDeg,
      );
      this.endManeuver(maneuver);
    }
  }

  private endManeuver(maneuver: SheetManeuver): void {
    this.maneuver = null;
    this.standingValue = maneuver.wasStanding;
    this.pending = null;
    this.struggleSeconds = 0;
    this.blockedAttempts = 0;
    this.cannotDrawValue = false;
    this.triedHerFurtherOut = false;
    this.probeBackoff = 1;
    this.lastProbeAtSeconds = this.elapsed;
    this.lastDecisionValue = 'acceptable';
    this.phase = maneuver.wasStanding ? 'watching' : 'idle';
    this.nextLookAt =
      this.elapsed + this.attentionRandom.between(WATCH_AFTER_ACTION_SECONDS);
  }

  /**
   * One look at his own sail, and at most one decision from it.
   *
   * The order of the tests is the order of a hand's attention: she is lying
   * over hard, or the cloth is shaking, or the sail is dead — and if none of
   * those, it is drawing and he leaves it alone.
   */
  private decide(observation: Readonly<SailTrimObservation>): void {
    if (!observation.working) {
      this.lastDecisionValue = 'acceptable';
      this.scheduleNextLook();
      return;
    }
    const leewardSign = observation.windSide === 'port' ? -1 : 1;
    if (observation.windSide === 'unclear') {
      // Nothing to trim to. He waits for the wind to declare itself rather
      // than guessing a side and hauling the sail across the ship.
      this.lastDecisionValue = 'acceptable';
      this.scheduleNextLook();
      return;
    }
    const current = this.controls.trimDeg(this.sail);
    if (this.isBrace) {
      this.decideBrace(observation, current, leewardSign);
      return;
    }

    if (observation.overpressed && observation.sheetLoad !== 'slack') {
      this.propose('overpowered-ease', current, leewardSign, TRIM_STEP_DEG.overpressed, observation);
      return;
    }
    if (
      this.triedHerFurtherOut &&
      (observation.cloth === 'shaking' || observation.cloth === 'trembling')
    ) {
      // He let her out to see whether she would take it and she would not.
      // That is the answer to the question he asked, and the answer is to put
      // the sheet back where it was — not to keep easing a complaining sail
      // into the stops, which is what "a dead sail wants letting out" would
      // otherwise tell him to do.
      this.triedHerFurtherOut = false;
      this.probeBackoff = Math.min(this.probeBackoff * 2, PROBE_BACKOFF_LIMIT);
      this.propose('haul', current, leewardSign, TRIM_STEP_DEG.probe * 1.3, observation);
      return;
    }
    if (observation.cloth === 'shaking') {
      if (this.strugglingBeyondHisSheet()) {
        // He has tried three times and the rope will not go any further. The
        // sheet is not the problem, and a fourth pull would not be work — it
        // would be fidgeting. He reports it and keeps watching.
        this.cannotDrawValue = true;
        this.lastDecisionValue = 'cannot-draw';
        this.scheduleNextLook();
        return;
      }
      this.propose('haul', current, leewardSign, TRIM_STEP_DEG.shaking, observation);
      return;
    }
    if (
      observation.cloth === 'trembling' &&
      observation.unsettledSeconds >= TREMBLE_PATIENCE_SECONDS
    ) {
      this.propose('haul', current, leewardSign, TRIM_STEP_DEG.trembling, observation);
      return;
    }
    if (observation.fullness === 'stalled') {
      this.propose('ease', current, leewardSign, TRIM_STEP_DEG.stalled, observation);
      return;
    }
    if (this.wantsToTryHerFurtherOut(observation)) {
      // "Ease until she complains" — the other half of the only method a hand
      // has. Without it a sheet that nothing objects to stays wherever it was
      // last hauled, however flat that is, because a sail sheeted too hard
      // does not shake to tell you so. The trial is small and the ordinary
      // haul rule takes it straight back if the luff answers.
      this.lastProbeAtSeconds = this.elapsed;
      this.triedHerFurtherOut = true;
      this.propose('ease', current, leewardSign, TRIM_STEP_DEG.probe, observation);
      return;
    }
    this.lastDecisionValue = 'acceptable';
    this.scheduleNextLook();
  }

  /**
   * The square topsail's yard, which is not a sheet and does not behave like
   * one.
   *
   * A fore-and-aft sail is trimmed between hauled flat and eased out to
   * leeward, and hardening is the cure for a shaking luff. A yard has no such
   * geometry: it is braced round until its face meets the wind, and a yard
   * whose cloth is dead or aback wants bracing further round, never flatter.
   * Close-hauled she runs out of brace before the sail will draw at all,
   * which is exactly when the hand should say so rather than keep pulling.
   */
  private decideBrace(
    observation: Readonly<SailTrimObservation>,
    currentTrimDeg: number,
    leewardSign: number,
  ): void {
    if (observation.cloth === 'drawing') {
      this.lastDecisionValue = 'acceptable';
      this.scheduleNextLook();
      return;
    }
    if (this.strugglingBeyondHisSheet()) {
      this.cannotDrawValue = true;
      this.lastDecisionValue = 'cannot-draw';
      this.scheduleNextLook();
      return;
    }
    if (
      observation.cloth === 'shaking' ||
      observation.unsettledSeconds >= TREMBLE_PATIENCE_SECONDS
    ) {
      this.propose(
        'ease',
        currentTrimDeg,
        leewardSign,
        TRIM_STEP_DEG.shaking,
        observation,
      );
      return;
    }
    this.lastDecisionValue = 'acceptable';
    this.scheduleNextLook();
  }

  /**
   * Whether he is comfortable enough, and has been for long enough, to try
   * the sheet a little further out.
   *
   * Only from a sail that is genuinely drawing with weight in it: probing a
   * soft or shaking sail would be fiddling, not trimming.
   */
  private wantsToTryHerFurtherOut(
    observation: Readonly<SailTrimObservation>,
  ): boolean {
    if (observation.cloth !== 'drawing') return false;
    if (observation.unsettledSeconds > 0.5) return false;
    if (observation.sheetLoad === 'slack' || observation.sheetLoad === 'light') {
      return false;
    }
    if (observation.overpressed) return false;
    return (
      this.elapsed - this.lastProbeAtSeconds >=
      this.probeIntervalSeconds * this.probeBackoff
    );
  }

  /**
   * Whether this sail's trouble has stopped being a trim problem.
   *
   * It takes a long-running shake *and* repeated attempts that found the rope
   * already at the end of its travel — either hauled as flat as she is ever
   * sheeted, or eased right out to the rig's stop. Sustained observed
   * evidence, in other words: never one glance, and never a physics flag.
   */
  private strugglingBeyondHisSheet(): boolean {
    return (
      this.struggleSeconds >= CANNOT_DRAW_SECONDS &&
      this.blockedAttempts >= CANNOT_DRAW_MINIMUM_ATTEMPTS
    );
  }

  private propose(
    decision: TrimAdjustment['decision'],
    currentTrimDeg: number,
    leewardSign: number,
    stepDeg: number,
    observation: Readonly<SailTrimObservation>,
  ): void {
    // Hauling brings the clew in toward the centreline; easing lets it out to
    // leeward. Neither crosses the ship: hardening stops at the flattest she
    // is ever sheeted, and easing stops at the rig's own mechanical limit.
    const towardLeeward = decision === 'haul' ? -1 : 1;
    const candidate = clamp(
      currentTrimDeg + leewardSign * towardLeeward * stepDeg,
      this.limits.minDeg,
      this.limits.maxDeg,
    );
    const hardInLimit = leewardSign > 0 ? this.hardTrimDeg : -this.hardTrimDeg;
    const bounded =
      decision === 'haul'
        ? leewardSign > 0
          ? Math.max(candidate, hardInLimit)
          : Math.min(candidate, hardInLimit)
        : candidate;

    this.lastDecisionValue = decision;
    if (Math.abs(bounded - currentTrimDeg) < 0.4) {
      // The rope is already where his decision would put it. That is not
      // nothing: a hand who reaches three times and finds the sheet at its
      // stop every time has learned something about the sail rather than
      // about his arm, so the blocked attempt is counted before he lets go.
      this.blockedAttempts++;
      this.scheduleNextLook();
      return;
    }
    this.blockedAttempts = 0;

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
      decision,
      candidateTrimDeg: bounded,
      cloth: observation.cloth,
      fullness: observation.fullness,
      sheetLoad: observation.sheetLoad,
      decided: null,
    };
    this.phase = 'considering';
  }

  private advancePendingAdjustment(): void {
    const pending = this.pending;
    if (!pending) return;
    if (!pending.decided && this.elapsed >= pending.decisionAtSeconds) {
      const inaccurate =
        pending.candidateTrimDeg +
        this.actionRandom.normal() *
          COMPETENT_HUMAN_OPERATOR_PROFILE.action.trimErrorStdDeg;
      const requested = clamp(
        inaccurate,
        this.limits.minDeg,
        this.limits.maxDeg,
      );
      const adjustment: TrimAdjustment = {
        sequenceId: this.nextSequenceId++,
        orderSequenceId: this.activeOrderSequenceId,
        station: this.sail,
        consideredAtSeconds: pending.consideredAtSeconds,
        decidedAtSeconds: pending.decisionAtSeconds,
        executeAtSeconds: pending.executeAtSeconds,
        decision: pending.decision,
        requestedTrimDeg: requested,
        previousTrimDeg: this.controls.trimDeg(this.sail),
        cloth: pending.cloth,
        fullness: pending.fullness,
        sheetLoad: pending.sheetLoad,
      };
      pending.decided = adjustment;
      this.adjustmentValues.push(adjustment);
      this.phase = 'motor-delay';
    }
    if (pending.decided && this.elapsed >= pending.executeAtSeconds) {
      this.controls.commandTrimDeg(this.sail, pending.decided.requestedTrimDeg);
      this.lastProbeAtSeconds = this.elapsed;
      this.pending = null;
      this.phase = 'watching';
      this.orders.markWatching(this.elapsed);
      // Now he watches his own cloth, which is the whole point of a finite
      // bite: the next decision is made on what this one did.
      this.nextLookAt =
        this.elapsed + this.attentionRandom.between(WATCH_AFTER_ACTION_SECONDS);
    }
  }

  private scheduleNextLook(): void {
    this.phase = this.standingValue ? 'watching' : 'idle';
    this.nextLookAt =
      this.elapsed + this.attentionRandom.between(SETTLED_LOOK_SECONDS);
  }
}

/**
 * Every staffed sheet, working independently.
 *
 * There is no scheduler here and deliberately none: each station owns its own
 * order response, its own attention and its own action timers, drawn from its
 * own seeded streams. Two sails moving together is a coincidence this design
 * permits rather than a fault it prevents.
 */
export class Trimmers {
  private readonly stations = new Map<SailName, TrimmerStation>();

  constructor(controls: SailingControls, seed: number) {
    for (const sail of TRIM_STATIONS) {
      this.stations.set(sail, new TrimmerStation(sail, controls, seed));
    }
  }

  get stationIds(): readonly SailName[] {
    return TRIM_STATIONS;
  }

  receiveOrder(order: CrewOrder): void {
    for (const station of order.targetStations) {
      this.stations.get(station as SailName)?.receiveOrder(order);
    }
  }

  setDirectTakeover(sail: SailName, active: boolean): void {
    this.stations.get(sail)?.setDirectTakeover(active);
  }

  /**
   * Whether the hand at this station has reported he cannot make her draw.
   *
   * An accessor rather than a trip through `readout()` because the M6 cloth
   * reads it on the frames the rig re-lofts, and `readout()` allocates a
   * record per station per call.
   */
  cannotDraw(sail: SailName): boolean {
    return this.stations.get(sail)?.cannotDraw ?? false;
  }

  advanceSubstep(
    stepSeconds: number,
    observationFor: (sail: SailName) => Readonly<SailTrimObservation>,
  ): void {
    for (const sail of TRIM_STATIONS) {
      this.stations.get(sail)!.advanceSubstep(stepSeconds, observationFor(sail));
    }
  }

  reset(): void {
    for (const station of this.stations.values()) station.reset();
  }

  readout(): TrimmersReadout {
    let adjustmentCount = 0;
    let maneuverCount = 0;
    const stations: TrimmerStationReadout[] = [];
    for (const sail of TRIM_STATIONS) {
      const readout = this.stations.get(sail)!.readout();
      adjustmentCount += readout.adjustmentCount;
      maneuverCount += readout.maneuverCount;
      stations.push(readout);
    }
    return { stations, adjustmentCount, maneuverCount };
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
