import type {
  BuoyantBodySubstepAttitude,
  OvertopEvent,
} from '../BuoyantBody';
import {
  resolveSchoonerBoardingIngress,
  type SchoonerBoardingIngressBatch,
} from './SchoonerBoardingIngress';
import {
  NO_SCHOONER_DECK_WATER_REQUESTS,
  assertSchoonerDeckWaterAttitude,
  resolveSchoonerDeckWaterTransport,
} from './SchoonerDeckWaterTransport';
import {
  SHIP_WATER_STEP_SECONDS,
  type ShipWaterFlowRequest,
  type ShipWaterState,
} from './ShipWaterState';

/**
 * Apply one completed body batch to the authoritative deck-water clock.
 *
 * Boarding and transport requests for a step are resolved from the same
 * pre-step water state and applied simultaneously by `ShipWaterState`. Newly
 * boarded water therefore becomes available to move on the following step,
 * rather than gaining an order-dependent pass through the deck graph.
 */
export function advanceSchoonerDeckWater(
  water: ShipWaterState,
  physicsSteps: number,
  events: readonly Readonly<OvertopEvent>[],
  attitudes: readonly Readonly<BuoyantBodySubstepAttitude>[],
): SchoonerBoardingIngressBatch {
  assertAttitudeClock(attitudes, physicsSteps);
  for (const attitude of attitudes) {
    assertSchoonerDeckWaterAttitude(attitude);
  }

  const ingress = resolveSchoonerBoardingIngress(events, physicsSteps);
  const waterStepBefore = water.stepIndex;

  // Ordinary sailing owns neither ingress nor carried deck water. Keep that
  // path on one shared resolver: no request buffers, maps, closures or trig.
  if (events.length === 0 && water.onboardVolumeM3 === 0) {
    water.advance(
      physicsSteps * SHIP_WATER_STEP_SECONDS,
      noSchoonerDeckWaterRequests,
    );
    assertWaterClock(water, waterStepBefore, physicsSteps, physicsSteps);
    return ingress;
  }

  let requestStep = 0;
  water.advance(
    physicsSteps * SHIP_WATER_STEP_SECONDS,
    ({ water: state }) => {
      const boarding =
        ingress.requestsByStep[requestStep] ??
        NO_SCHOONER_DECK_WATER_REQUESTS;
      const transport = resolveSchoonerDeckWaterTransport(
        state,
        attitudes[requestStep],
      );
      requestStep++;
      return combineRequests(boarding, transport);
    },
  );
  assertWaterClock(water, waterStepBefore, physicsSteps, requestStep);
  return ingress;
}

function assertAttitudeClock(
  attitudes: readonly Readonly<BuoyantBodySubstepAttitude>[],
  physicsSteps: number,
): void {
  if (!Number.isInteger(physicsSteps) || physicsSteps < 0) {
    throw new RangeError(
      'schooner deck-water physicsSteps must be a non-negative integer',
    );
  }
  if (attitudes.length !== physicsSteps) {
    throw new Error(
      'schooner deck-water batch must contain one attitude fact per physics step',
    );
  }
  for (let index = 0; index < attitudes.length; index++) {
    const fact = attitudes[index];
    if (
      fact.batchStepIndex !== index ||
      Math.abs(fact.durationSeconds - SHIP_WATER_STEP_SECONDS) >
        SHIP_WATER_STEP_SECONDS * 1e-12
    ) {
      throw new Error(
        'schooner deck-water attitude fact is not on the body/water clock',
      );
    }
  }
}

function combineRequests(
  boarding: readonly ShipWaterFlowRequest[],
  transport: readonly ShipWaterFlowRequest[],
): readonly ShipWaterFlowRequest[] {
  if (boarding.length === 0) return transport;
  if (transport.length === 0) return boarding;
  return [...boarding, ...transport];
}

function noSchoonerDeckWaterRequests(): readonly ShipWaterFlowRequest[] {
  return NO_SCHOONER_DECK_WATER_REQUESTS;
}

function assertWaterClock(
  water: ShipWaterState,
  stepBefore: number,
  physicsSteps: number,
  resolvedSteps: number,
): void {
  if (
    resolvedSteps !== physicsSteps ||
    water.stepIndex - stepBefore !== physicsSteps
  ) {
    throw new Error(
      'schooner deck water and body fixed clocks are out of sync',
    );
  }
}
