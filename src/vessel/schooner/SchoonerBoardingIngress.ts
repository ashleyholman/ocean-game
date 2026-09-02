import type { OvertopEvent } from '../BuoyantBody';
import {
  SHIP_WATER_STEP_SECONDS,
  type ShipWaterFlowRequest,
  type ShipWaterState,
} from './ShipWaterState';
import {
  SCHOONER_DECK_WATER_CELLS,
  type SchoonerDeckWaterCell,
} from './shipWaterCompartments';
import type { ShipWaterOpeningName } from './shipWaterOpenings';
import { deckHalfWidth, deckLevelAt } from './deckSurface';
import {
  STATION_COUNT,
  STATION_SPACING,
  stationZ,
} from './hullForm';
import {
  PROVISIONAL_OVERTOP_DISCHARGE_COEFFICIENT,
  resolveOvertopFlux,
} from './overtopFlux';

/**
 * Ideal critical-depth coefficient used for the first production boarding seam.
 *
 * The USBR derivation already carries `sqrt(g) * (2h/3)^(3/2)`; unity therefore
 * means the theoretical rectangular broad-crested result, not an empirical
 * claim about this rail. Until physical wash-depth evidence exists, retaining
 * that conservative upper-bound input is more honest than fitting a loss factor
 * to a desired flooding or sinking time. The finite tributary prism remains the
 * independent upper bound on every event.
 */
export const SCHOONER_BOARDING_DISCHARGE_COEFFICIENT =
  PROVISIONAL_OVERTOP_DISCHARGE_COEFFICIENT;

export { SCHOONER_DECK_WATER_CELLS } from './shipWaterCompartments';
export type { SchoonerDeckWaterCell } from './shipWaterCompartments';

interface CellRoute {
  readonly cell: SchoonerDeckWaterCell;
  readonly opening: ShipWaterOpeningName;
}

const CELL_ROUTES: Readonly<Record<SchoonerDeckWaterCell, CellRoute>> = {
  weatherDeckAftStarboard: {
    cell: 'weatherDeckAftStarboard',
    opening: 'railAftStarboard',
  },
  weatherDeckAftPort: {
    cell: 'weatherDeckAftPort',
    opening: 'railAftPort',
  },
  weatherDeckForeStarboard: {
    cell: 'weatherDeckForeStarboard',
    opening: 'railForeStarboard',
  },
  weatherDeckForePort: {
    cell: 'weatherDeckForePort',
    opening: 'railForePort',
  },
};

export interface SchoonerBoardingCellShare extends CellRoute {
  /** Fraction of this station strip lying in the named fore/aft cell. */
  readonly fraction: number;
}

export interface SchoonerBoardingIngressBatch {
  readonly physicsSteps: number;
  readonly eventSamples: number;
  readonly uniqueStationContacts: number;
  readonly duplicateStationContacts: number;
  readonly cappedEventCount: number;
  readonly requestedVolumeM3: number;
  readonly byCellM3: Readonly<Record<SchoonerDeckWaterCell, number>>;
  /** Largest sum of non-overlapping station-owned rail widths in one substep. */
  readonly maximumSimultaneousContactWidthM: number;
  readonly requestsByStep: readonly (readonly ShipWaterFlowRequest[])[];
}

interface ResolvedStationContact {
  readonly event: Readonly<OvertopEvent>;
  volumeM3: number;
  capped: boolean;
}

const NO_SHIP_WATER_FLOW_REQUESTS = Object.freeze(
  [] as ShipWaterFlowRequest[],
);
const ZERO_CELL_VOLUMES = Object.freeze(zeroCellRecord());
const dryBatchByPhysicsSteps: Array<
  SchoonerBoardingIngressBatch | undefined
> = [];

/**
 * Resolve the named deck ownership of one longitudinal station strip.
 *
 * All ordinary strips lie wholly fore or aft. The 39-station schooner has one
 * strip centred exactly at z=0; splitting that strip by its geometric overlap
 * prevents an arbitrary `>= 0` tie from putting its aft half into the fore cell.
 */
export function schoonerBoardingCellShares(
  event: Pick<
    OvertopEvent,
    'boardingSide' | 'stationLocalZ' | 'contactWidthM'
  >,
): readonly SchoonerBoardingCellShare[] {
  const width = event.contactWidthM;
  if (!Number.isFinite(width) || width <= 0) return [];
  if (!Number.isFinite(event.stationLocalZ)) {
    throw new RangeError('schooner boarding station z must be finite');
  }
  // The odd station count makes the middle strip geometrically centred, but
  // the shared `stationZ` multiply can leave a sub-ulp residue around zero.
  // Snap only that negligible residue so its two cell shares stay exactly
  // half-and-half on the authoritative volume ledger.
  const stationLocalZ =
    Math.abs(event.stationLocalZ) <= width * 1e-12
      ? 0
      : event.stationLocalZ;
  const aftEdge = stationLocalZ - width / 2;
  const foreEdge = stationLocalZ + width / 2;
  const aftLength = Math.max(0, Math.min(foreEdge, 0) - aftEdge);
  const aftFraction = Math.min(1, Math.max(0, aftLength / width));
  const foreFraction = 1 - aftFraction;
  const side = event.boardingSide === 'port' ? 'Port' : 'Starboard';
  const shares: SchoonerBoardingCellShare[] = [];
  if (aftFraction > 0) {
    const cell = `weatherDeckAft${side}` as SchoonerDeckWaterCell;
    shares.push({ ...CELL_ROUTES[cell], fraction: aftFraction });
  }
  if (foreFraction > 0) {
    const cell = `weatherDeckFore${side}` as SchoonerDeckWaterCell;
    shares.push({ ...CELL_ROUTES[cell], fraction: foreFraction });
  }
  return shares;
}

/**
 * Convert a caller batch of fixed-step contact facts into named rail requests.
 *
 * A hydrostatic station owns one non-overlapping longitudinal strip. Therefore
 * simultaneous *different* station contacts add: together their widths form a
 * partition of the wet rail. A repeated `(batchStepIndex, stationIndex)` fact is
 * the only duplicate. Geometry and side must agree; the larger resolved volume
 * is retained once so input ordering cannot change the answer.
 */
export function resolveSchoonerBoardingIngress(
  events: readonly Readonly<OvertopEvent>[],
  physicsSteps: number,
  dischargeCoefficient = SCHOONER_BOARDING_DISCHARGE_COEFFICIENT,
): SchoonerBoardingIngressBatch {
  if (!Number.isInteger(physicsSteps) || physicsSteps < 0) {
    throw new RangeError(
      'schooner boarding physicsSteps must be a non-negative integer',
    );
  }
  if (!Number.isFinite(dischargeCoefficient) || dischargeCoefficient <= 0) {
    throw new RangeError(
      'schooner boarding discharge coefficient must be finite and positive',
    );
  }
  if (events.length === 0) return dryIngressBatch(physicsSteps);

  const unique = new Map<string, ResolvedStationContact>();
  let duplicateStationContacts = 0;
  for (const event of events) {
    assertEventClockIdentity(event, physicsSteps);
    const flux = resolveOvertopFlux(event, dischargeCoefficient);
    const key = `${event.batchStepIndex}:${event.stationIndex}`;
    const previous = unique.get(key);
    if (!previous) {
      unique.set(key, {
        event,
        volumeM3: flux.volumeM3,
        capped: flux.cappedByTributaryArea,
      });
      continue;
    }
    duplicateStationContacts++;
    assertDuplicateGeometry(previous.event, event);
    if (flux.volumeM3 > previous.volumeM3) {
      previous.volumeM3 = flux.volumeM3;
      previous.capped = flux.cappedByTributaryArea;
    }
  }

  const volumesByStep = Array.from(
    { length: physicsSteps },
    () => new Float64Array(SCHOONER_DECK_WATER_CELLS.length),
  );
  const contactWidthByStep = new Float64Array(physicsSteps);
  const byCellM3 = zeroCellRecord();
  let requestedVolumeM3 = 0;
  let cappedEventCount = 0;

  for (const contact of unique.values()) {
    const event = contact.event;
    contactWidthByStep[event.batchStepIndex] += event.contactWidthM;
    requestedVolumeM3 += contact.volumeM3;
    if (contact.capped) cappedEventCount++;
    for (const share of schoonerBoardingCellShares(event)) {
      const volume = contact.volumeM3 * share.fraction;
      const cellIndex = SCHOONER_DECK_WATER_CELLS.indexOf(share.cell);
      volumesByStep[event.batchStepIndex][cellIndex] += volume;
      byCellM3[share.cell] += volume;
    }
  }

  const requestsByStep = volumesByStep.map((volumes) => {
    const requests: ShipWaterFlowRequest[] = [];
    for (let index = 0; index < volumes.length; index++) {
      const volumeM3 = volumes[index];
      if (volumeM3 === 0) continue;
      const cell = SCHOONER_DECK_WATER_CELLS[index];
      requests.push({
        opening: CELL_ROUTES[cell].opening,
        rateM3PerSecond: volumeM3 / SHIP_WATER_STEP_SECONDS,
      });
    }
    return requests;
  });

  let maximumSimultaneousContactWidthM = 0;
  for (const width of contactWidthByStep) {
    maximumSimultaneousContactWidthM = Math.max(
      maximumSimultaneousContactWidthM,
      width,
    );
  }
  return {
    physicsSteps,
    eventSamples: events.length,
    uniqueStationContacts: unique.size,
    duplicateStationContacts,
    cappedEventCount,
    requestedVolumeM3,
    byCellM3,
    maximumSimultaneousContactWidthM,
    requestsByStep,
  };
}

/**
 * Apply ingress alone for focused flux/ledger evidence.
 *
 * Production uses `advanceSchoonerDeckWater`, which composes these canonical
 * per-step requests with deck transport before advancing the same clock.
 */
export function advanceSchoonerBoardingIngress(
  water: ShipWaterState,
  physicsSteps: number,
  events: readonly Readonly<OvertopEvent>[],
): SchoonerBoardingIngressBatch {
  const batch = resolveSchoonerBoardingIngress(events, physicsSteps);
  const waterStepBefore = water.stepIndex;
  if (events.length === 0) {
    water.advance(
      physicsSteps * SHIP_WATER_STEP_SECONDS,
      noShipWaterFlowRequests,
    );
    if (water.stepIndex - waterStepBefore !== physicsSteps) {
      throw new Error(
        'schooner boarding ingress and ShipWaterState fixed clocks are out of sync',
      );
    }
    return batch;
  }

  let requestStep = 0;
  water.advance(physicsSteps * SHIP_WATER_STEP_SECONDS, () => {
    const requests = batch.requestsByStep[requestStep];
    requestStep++;
    return requests ?? [];
  });
  if (
    requestStep !== physicsSteps ||
    water.stepIndex - waterStepBefore !== physicsSteps
  ) {
    throw new Error(
      'schooner boarding ingress and ShipWaterState fixed clocks are out of sync',
    );
  }
  return batch;
}

function assertEventClockIdentity(
  event: Readonly<OvertopEvent>,
  physicsSteps: number,
): void {
  if (
    !Number.isInteger(event.stationIndex) ||
    event.stationIndex < 0 ||
    event.stationIndex >= STATION_COUNT ||
    !Number.isInteger(event.batchStepIndex) ||
    event.batchStepIndex < 0 ||
    event.batchStepIndex >= physicsSteps
  ) {
    throw new RangeError(
      'schooner boarding event has invalid station/step identity',
    );
  }
  if (
    Math.abs(event.durationSeconds - SHIP_WATER_STEP_SECONDS) >
    SHIP_WATER_STEP_SECONDS * 1e-12
  ) {
    throw new RangeError(
      'schooner boarding event must represent one water-clock step',
    );
  }
  const expectedZ = stationZ(event.stationIndex);
  const expectedTributaryAreaM2 =
    STATION_SPACING * deckHalfWidth(expectedZ, deckLevelAt(expectedZ));
  if (
    event.stationLocalZ !== expectedZ ||
    event.contactWidthM !== STATION_SPACING ||
    event.tributaryAreaM2 !== expectedTributaryAreaM2 ||
    (event.boardingSide !== 'starboard' && event.boardingSide !== 'port')
  ) {
    throw new RangeError(
      'schooner boarding event does not match its canonical station-owned strip',
    );
  }
}

function assertDuplicateGeometry(
  previous: Readonly<OvertopEvent>,
  event: Readonly<OvertopEvent>,
): void {
  if (
    previous.boardingSide !== event.boardingSide ||
    previous.stationLocalZ !== event.stationLocalZ ||
    previous.contactWidthM !== event.contactWidthM ||
    previous.tributaryAreaM2 !== event.tributaryAreaM2 ||
    previous.durationSeconds !== event.durationSeconds
  ) {
    throw new Error(
      'duplicate schooner boarding station/step facts disagree on owned geometry',
    );
  }
}

function zeroCellRecord(): Record<SchoonerDeckWaterCell, number> {
  return {
    weatherDeckAftStarboard: 0,
    weatherDeckAftPort: 0,
    weatherDeckForeStarboard: 0,
    weatherDeckForePort: 0,
  };
}

function noShipWaterFlowRequests(): readonly ShipWaterFlowRequest[] {
  return NO_SHIP_WATER_FLOW_REQUESTS;
}

/**
 * Dry frames dominate ordinary sailing. Cache the whole immutable answer by
 * substep count so that path allocates neither a Map nor per-step buffers.
 * Both the ingress-only evidence helper and production composer reuse it.
 */
function dryIngressBatch(physicsSteps: number): SchoonerBoardingIngressBatch {
  const cached = dryBatchByPhysicsSteps[physicsSteps];
  if (cached) return cached;
  const requestsByStep = Object.freeze(
    Array.from(
      { length: physicsSteps },
      () => NO_SHIP_WATER_FLOW_REQUESTS,
    ),
  );
  const batch: SchoonerBoardingIngressBatch = Object.freeze({
    physicsSteps,
    eventSamples: 0,
    uniqueStationContacts: 0,
    duplicateStationContacts: 0,
    cappedEventCount: 0,
    requestedVolumeM3: 0,
    byCellM3: ZERO_CELL_VOLUMES,
    maximumSimultaneousContactWidthM: 0,
    requestsByStep,
  });
  dryBatchByPhysicsSteps[physicsSteps] = batch;
  return batch;
}
