import type { SailingControls } from '../SailingControls';
import type { SailName } from '../rig';
import { VALID_SET_STATES, type SailSetState } from '../sailAero';
import { CANVAS_SAILS } from './CanvasPolicy';
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
 * The hands that set and hand cloth, as opposed to the hands on the sheets.
 *
 * "Shorten sail" is one spoken order and eight separate jobs. Each sail's job
 * is worked by the station that owns it: the order arrives, the man hears it,
 * understands which sail is his and what he is to do with it, and then goes
 * and does it — and the doing is the existing `SailingControls` evolution,
 * priced at the crew's own working day (`CREW_EVOLUTION_WORLD_SECONDS`). This
 * class adds no new actuator and no new rate; it only decides *when* one hand
 * starts his own job.
 *
 * It is deliberately separate from `Trimmers`: a sheet is worked continuously
 * against the sail's behaviour, and a halyard is an errand you are sent on.
 * They are different men and they draw from different streams.
 */

export interface CanvasEvolution {
  readonly sequenceId: number;
  readonly orderSequenceId: number;
  readonly sail: SailName;
  readonly from: SailSetState;
  readonly to: SailSetState;
  /** When the order reached this station's hands. */
  readonly orderedAtSeconds: number;
  /** When he actually laid hold of the halyard. */
  readonly startedAtSeconds: number;
  /** When the cloth arrived, or null while it is still travelling. */
  settledAtSeconds: number | null;
}

export interface CanvasStationReadout {
  readonly sail: SailName;
  readonly orderPhase: CrewOrderPhase;
  readonly orderResponse: Readonly<StationOrderResponse> | null;
  readonly directTakeover: boolean;
  readonly targetState: SailSetState;
  readonly working: boolean;
  readonly evolutionCount: number;
  readonly latestEvolution: Readonly<CanvasEvolution> | null;
  readonly evolutions: readonly CanvasEvolution[];
}

export interface CanvasHandsReadout {
  readonly stations: readonly CanvasStationReadout[];
  readonly evolutionCount: number;
  /** The last plan name any station heard, for the HUD and the evidence. */
  readonly planName: string | null;
}

class CanvasStation {
  private readonly orders: StationOrderPipeline;
  private readonly actionRandom: HumanRandomStream;
  private elapsed = 0;
  private directTakeoverValue = false;
  private pendingState: SailSetState | null = null;
  private pendingOrderSequenceId = 0;
  private pendingOrderedAt = 0;
  private startAtSeconds = Infinity;
  private nextSequenceId = 1;
  private readonly evolutionValues: CanvasEvolution[] = [];
  private open: CanvasEvolution | null = null;

  constructor(
    readonly sail: SailName,
    private readonly controls: SailingControls,
    seed: number,
  ) {
    // A distinct stream key: the man at the halyard is not the man at the
    // sheet, and adding him must not shift a single one of the trimmer's draws.
    this.orders = new StationOrderPipeline(
      sail as CrewStationId,
      seed,
      `${sail}-canvas`,
    );
    this.actionRandom = createHumanRandomStream(seed, `${sail}-canvas`, 'action');
  }

  receiveOrder(order: CrewOrder): void {
    this.orders.receive(order);
  }

  setDirectTakeover(active: boolean): void {
    if (active === this.directTakeoverValue) return;
    this.directTakeoverValue = active;
    if (active) {
      this.pendingState = null;
      this.startAtSeconds = Infinity;
    }
  }

  advanceSubstep(stepSeconds: number): void {
    this.elapsed += stepSeconds;
    this.orders.advance(this.elapsed);
    const ready = this.orders.consumeReadyOrder();
    if (ready) this.activateOrder(ready);

    if (this.open && this.open.settledAtSeconds === null) {
      if (
        this.controls.settledSetState(this.sail) === this.open.to &&
        this.controls.targetSetState(this.sail) === this.open.to
      ) {
        this.open.settledAtSeconds = this.elapsed;
        this.open = null;
      }
    }

    if (this.directTakeoverValue || this.pendingState === null) return;
    if (this.elapsed < this.startAtSeconds) return;

    const to = this.pendingState;
    const from = this.controls.targetSetState(this.sail);
    this.pendingState = null;
    this.startAtSeconds = Infinity;
    if (from === to) return;
    this.controls.commandSetState(this.sail, to);
    const evolution: CanvasEvolution = {
      sequenceId: this.nextSequenceId++,
      orderSequenceId: this.pendingOrderSequenceId,
      sail: this.sail,
      from,
      to,
      orderedAtSeconds: this.pendingOrderedAt,
      startedAtSeconds: this.elapsed,
      settledAtSeconds: null,
    };
    this.evolutionValues.push(evolution);
    this.open = evolution;
    this.orders.markWatching(this.elapsed);
  }

  reset(): void {
    this.elapsed = 0;
    this.orders.reset();
    this.directTakeoverValue = false;
    this.pendingState = null;
    this.pendingOrderSequenceId = 0;
    this.pendingOrderedAt = 0;
    this.startAtSeconds = Infinity;
    this.nextSequenceId = 1;
    this.evolutionValues.length = 0;
    this.open = null;
    this.actionRandom.reset();
  }

  readout(): CanvasStationReadout {
    return {
      sail: this.sail,
      orderPhase: this.orders.phase,
      orderResponse: this.orders.response,
      directTakeover: this.directTakeoverValue,
      targetState: this.controls.targetSetState(this.sail),
      working:
        this.controls.settledSetState(this.sail) !==
        this.controls.targetSetState(this.sail),
      evolutionCount: this.evolutionValues.length,
      latestEvolution:
        this.evolutionValues[this.evolutionValues.length - 1] ?? null,
      evolutions: this.evolutionValues,
    };
  }

  private activateOrder(order: CrewOrder): void {
    if (order.cancelled || order.kind !== 'set-canvas') return;
    const payload = order.payload as {
      readonly canvas: Readonly<Partial<Record<string, string>>>;
    };
    const requested = payload.canvas[this.sail];
    if (requested === undefined) return;
    if (!VALID_SET_STATES[this.sail].includes(requested as SailSetState)) {
      throw new RangeError(
        `canvas order ${order.sequenceId} gives ${this.sail} the state "${requested}"`,
      );
    }
    const state = requested as SailSetState;
    if (state === this.controls.targetSetState(this.sail)) return;
    // He has understood the order; laying hold of the gear is one more human
    // beat on top of the pipeline's own recognition and processing.
    this.pendingState = state;
    this.pendingOrderSequenceId = order.sequenceId;
    this.pendingOrderedAt = this.elapsed;
    this.startAtSeconds =
      this.elapsed +
      sampleShiftedLognormalSeconds(
        this.actionRandom,
        COMPETENT_HUMAN_OPERATOR_PROFILE.action.motorInitiation,
      );
  }
}

export class CanvasHands {
  private readonly stations = new Map<SailName, CanvasStation>();
  private planNameValue: string | null = null;

  constructor(controls: SailingControls, seed: number) {
    for (const sail of CANVAS_SAILS) {
      this.stations.set(sail, new CanvasStation(sail, controls, seed));
    }
  }

  get stationIds(): readonly SailName[] {
    return CANVAS_SAILS;
  }

  receiveOrder(order: CrewOrder): void {
    if (order.kind === 'set-canvas') {
      this.planNameValue = (order.payload as { readonly planName: string })
        .planName;
    }
    for (const station of order.targetStations) {
      this.stations.get(station as SailName)?.receiveOrder(order);
    }
  }

  setDirectTakeover(sail: SailName, active: boolean): void {
    this.stations.get(sail)?.setDirectTakeover(active);
  }

  advanceSubstep(stepSeconds: number): void {
    for (const sail of CANVAS_SAILS) {
      this.stations.get(sail)!.advanceSubstep(stepSeconds);
    }
  }

  reset(): void {
    this.planNameValue = null;
    for (const station of this.stations.values()) station.reset();
  }

  readout(): CanvasHandsReadout {
    let evolutionCount = 0;
    const stations: CanvasStationReadout[] = [];
    for (const sail of CANVAS_SAILS) {
      const readout = this.stations.get(sail)!.readout();
      evolutionCount += readout.evolutionCount;
      stations.push(readout);
    }
    return { stations, evolutionCount, planName: this.planNameValue };
  }
}
