import {
  COMPETENT_HUMAN_OPERATOR_PROFILE,
  createHumanRandomStream,
  sampleShiftedLognormalSeconds,
  type HumanRandomStream,
} from './HumanOperator';

/** Every independently staffed S5 station has its own response pipeline. */
export type CrewStationId =
  | 'helm'
  | 'mainsail'
  | 'foresail'
  | 'foreStaysail'
  | 'jib'
  | 'flyingJib'
  | 'foreTopsail'
  | 'mainTopmastStaysail';

/**
 * The representation includes the direct and future standing verbs even
 * though the mandatory first checkpoint activates compass-course helm only.
 *
 * S6 adds the tier-2 evolutions. They are spoken orders like any other — the
 * navigator says "ready about" and every station hears it in its own time —
 * and each one is a *sequence* the stations work, never a control write from
 * the tier above.
 */
export type CrewOrderKind =
  | 'steer-compass-course'
  | 'hold-apparent-wind-angle'
  | 'stand-down-helm'
  | 'trim-to-draw'
  | 'stand-down-trim'
  | 'direct-trim'
  | 'tack'
  | 'gybe'
  | 'set-canvas';

/** Per-sail set states, as the canvas order carries them. */
export type CanvasOrderPlan = Readonly<Partial<Record<CrewStationId, string>>>;

export type CrewOrderPayload =
  | { readonly courseDeg: number }
  | { readonly apparentWindAngleDeg: number }
  | { readonly sail: CrewStationId; readonly direction: 'haul' | 'ease' }
  | { readonly planName: string; readonly canvas: CanvasOrderPlan }
  | Readonly<Record<string, never>>;

export interface CrewOrder {
  readonly sequenceId: number;
  readonly kind: CrewOrderKind;
  readonly targetStations: readonly CrewStationId[];
  readonly issueTimeSeconds: number;
  /** Shared by every station hearing this one spoken event. */
  readonly utteranceDurationSeconds: number;
  readonly standing: boolean;
  readonly payload: CrewOrderPayload;
  cancelled: boolean;
}

export type CrewOrderPhase =
  | 'idle'
  | 'ordered'
  | 'heard'
  | 'processing'
  | 'acting'
  | 'watching';

export interface StationOrderTiming {
  readonly utteranceCompleteAtSeconds: number;
  readonly recognitionDelaySeconds: number;
  readonly heardAtSeconds: number;
  readonly processingDelaySeconds: number;
  readonly processedAtSeconds: number;
  readonly motorInitiationDelaySeconds: number;
  readonly motorStartedAtSeconds: number;
}

export interface StationOrderResponse {
  readonly station: CrewStationId;
  readonly order: CrewOrder;
  readonly timing: StationOrderTiming;
  phase: CrewOrderPhase;
  phaseEnteredAtSeconds: number;
}

export interface CrewOrderPhaseEvent {
  readonly timeSeconds: number;
  readonly orderSequenceId: number;
  readonly station: CrewStationId;
  readonly phase: Exclude<CrewOrderPhase, 'idle'> | 'utterance-complete';
}

/** Creates spoken events. Station response draws happen elsewhere. */
export class CrewOrderBook {
  private nextSequenceId = 1;
  private readonly random: HumanRandomStream;

  constructor(seed: number) {
    this.random = createHumanRandomStream(seed, 'captain', 'order');
  }

  issue(
    kind: CrewOrderKind,
    targetStations: readonly CrewStationId[],
    issueTimeSeconds: number,
    payload: CrewOrderPayload,
    standing: boolean,
  ): CrewOrder {
    if (!Number.isFinite(issueTimeSeconds) || issueTimeSeconds < 0) {
      throw new RangeError(
        `order issue time must be finite and non-negative, got ${issueTimeSeconds}`,
      );
    }
    if (targetStations.length === 0) {
      throw new RangeError('a spoken order needs at least one target station');
    }
    const utteranceDurationSeconds = sampleShiftedLognormalSeconds(
      this.random,
      COMPETENT_HUMAN_OPERATOR_PROFILE.response.utterance,
    );
    return {
      sequenceId: this.nextSequenceId++,
      kind,
      targetStations: Object.freeze([...targetStations]),
      issueTimeSeconds,
      utteranceDurationSeconds,
      standing,
      payload,
      cancelled: false,
    };
  }

  reset(): void {
    this.nextSequenceId = 1;
    this.random.reset();
  }
}

/**
 * One station's ISSUED → HEARD → PROCESSING → ACTING → WATCHING path.
 *
 * All deadlines are sampled exactly once when the order enters this station.
 * `advance` merely crosses stored deadlines; it never redraws a duration.
 */
export class StationOrderPipeline {
  private readonly random: HumanRandomStream;
  private responseValue: StationOrderResponse | null = null;
  private readyOrder: CrewOrder | null = null;
  private deliveredReadySequenceId = 0;
  private readonly eventValues: CrewOrderPhaseEvent[] = [];

  /**
   * @param streamKey Which random stream this pipeline draws its delays from,
   *   defaulting to the station's own. Two different hands can be working the
   *   same sail — the man on the sheet and the man sent aloft to hand it are
   *   not the same man, and they must not share a sequence of reaction times.
   *   Passing a distinct key is how a second pipeline at one station gets its
   *   own draws without disturbing the first (§9 stream isolation).
   */
  constructor(
    readonly station: CrewStationId,
    seed: number,
    streamKey: string = station,
  ) {
    this.random = createHumanRandomStream(
      seed,
      streamKey,
      'order-response',
    );
  }

  get response(): Readonly<StationOrderResponse> | null {
    return this.responseValue;
  }

  get phase(): CrewOrderPhase {
    return this.responseValue?.phase ?? 'idle';
  }

  get events(): readonly CrewOrderPhaseEvent[] {
    return this.eventValues;
  }

  receive(order: CrewOrder): StationOrderResponse {
    if (!order.targetStations.includes(this.station)) {
      throw new RangeError(
        `${this.station} cannot receive order ${order.sequenceId}: it is not a target`,
      );
    }
    const responseProfile = COMPETENT_HUMAN_OPERATOR_PROFILE.response;
    const recognitionDelaySeconds = sampleShiftedLognormalSeconds(
      this.random,
      responseProfile.recognition,
    );
    const processingDelaySeconds = sampleShiftedLognormalSeconds(
      this.random,
      responseProfile.processing,
    );
    const motorInitiationDelaySeconds = sampleShiftedLognormalSeconds(
      this.random,
      responseProfile.motorInitiation,
    );
    const utteranceCompleteAtSeconds =
      order.issueTimeSeconds + order.utteranceDurationSeconds;
    const heardAtSeconds =
      utteranceCompleteAtSeconds + recognitionDelaySeconds;
    const processedAtSeconds = heardAtSeconds + processingDelaySeconds;
    const motorStartedAtSeconds =
      processedAtSeconds + motorInitiationDelaySeconds;
    const response: StationOrderResponse = {
      station: this.station,
      order,
      timing: Object.freeze({
        utteranceCompleteAtSeconds,
        recognitionDelaySeconds,
        heardAtSeconds,
        processingDelaySeconds,
        processedAtSeconds,
        motorInitiationDelaySeconds,
        motorStartedAtSeconds,
      }),
      phase: 'ordered',
      phaseEnteredAtSeconds: order.issueTimeSeconds,
    };
    this.responseValue = response;
    this.readyOrder = null;
    this.deliveredReadySequenceId = 0;
    this.eventValues.push({
      timeSeconds: order.issueTimeSeconds,
      orderSequenceId: order.sequenceId,
      station: this.station,
      phase: 'ordered',
    });
    return response;
  }

  advance(timeSeconds: number): void {
    const response = this.responseValue;
    if (!response) return;
    if (!Number.isFinite(timeSeconds) || timeSeconds < response.order.issueTimeSeconds) {
      throw new RangeError(`station time moved before its order: ${timeSeconds}`);
    }
    const timing = response.timing;
    if (
      response.phase === 'ordered' &&
      timeSeconds >= timing.utteranceCompleteAtSeconds
    ) {
      this.eventValues.push({
        timeSeconds: timing.utteranceCompleteAtSeconds,
        orderSequenceId: response.order.sequenceId,
        station: this.station,
        phase: 'utterance-complete',
      });
      this.enterPhase('heard', timing.utteranceCompleteAtSeconds);
    }
    if (response.phase === 'heard' && timeSeconds >= timing.heardAtSeconds) {
      this.enterPhase('processing', timing.heardAtSeconds);
    }
    if (
      response.phase === 'processing' &&
      timeSeconds >= timing.processedAtSeconds
    ) {
      this.enterPhase('acting', timing.processedAtSeconds);
    }
    if (
      timeSeconds >= timing.motorStartedAtSeconds &&
      this.readyOrder === null &&
      this.deliveredReadySequenceId !== response.order.sequenceId
    ) {
      // Delivery is decided by the clock, not by the phase.
      //
      // FINDING S6-1: it used to require `phase === 'acting'`, and the operator
      // marks WATCHING from any action he happens to complete — including one
      // begun under the *previous* order. An order that arrived while a hand
      // was mid-correction therefore had its phase stolen in the half-second
      // between understanding it and beginning it, and was then never
      // delivered at all: the station simply never heard it. S5 never saw this
      // because every one of its orders was given at t=0 with the deck idle;
      // S6's navigator gives them all voyage long, and three of the first four
      // tacks he ordered vanished.
      this.readyOrder = response.order;
      this.deliveredReadySequenceId = response.order.sequenceId;
    }
  }

  consumeReadyOrder(): CrewOrder | null {
    const ready = this.readyOrder;
    this.readyOrder = null;
    return ready;
  }

  markWatching(timeSeconds: number): void {
    if (!this.responseValue || this.responseValue.phase !== 'acting') return;
    if (this.deliveredReadySequenceId !== this.responseValue.order.sequenceId) {
      // He is finishing something he began under the last order. That is not
      // this order being worked, and calling it so would report a lie.
      return;
    }
    this.enterPhase('watching', timeSeconds);
  }

  reset(): void {
    this.responseValue = null;
    this.readyOrder = null;
    this.deliveredReadySequenceId = 0;
    this.eventValues.length = 0;
    this.random.reset();
  }

  private enterPhase(
    phase: Exclude<CrewOrderPhase, 'idle' | 'ordered'>,
    timeSeconds: number,
  ): void {
    const response = this.responseValue!;
    response.phase = phase;
    response.phaseEnteredAtSeconds = timeSeconds;
    this.eventValues.push({
      timeSeconds,
      orderSequenceId: response.order.sequenceId,
      station: this.station,
      phase,
    });
  }
}
