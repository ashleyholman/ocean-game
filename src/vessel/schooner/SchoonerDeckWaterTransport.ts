import { HULL_ATTITUDE_LIMIT_RADIANS } from '../BuoyantBody';
import {
  SHIP_WATER_STEP_SECONDS,
  type ShipWaterFlowRequest,
  type ShipWaterState,
} from './ShipWaterState';
import {
  SCHOONER_DECK_WATER_CELLS,
  SHIP_WATER_COMPARTMENT_GEOMETRY,
  type SchoonerDeckWaterCell,
} from './shipWaterCompartments';
import type { ShipWaterOpeningName } from './shipWaterOpenings';

export { SCHOONER_DECK_WATER_CELLS } from './shipWaterCompartments';
export type { SchoonerDeckWaterCell } from './shipWaterCompartments';

/**
 * Provisional propagation speed for the four-cell control model.
 *
 * This is a numerical relaxation input, not a calibrated sheet-flow velocity.
 * The interface time is its centroid-to-centroid distance divided by this value,
 * so fore/aft spreading is deliberately slower than crossing one half-deck.
 */
export const SCHOONER_DECK_WATER_RELAXATION_SPEED_MPS = 2;

export interface SchoonerDeckWaterAttitude {
  /** Production sign: positive roll lowers the starboard side. */
  readonly rollRad: number;
  /** Production sign: positive pitch lowers the bow. */
  readonly pitchRad: number;
}

interface DeckWaterInterface {
  readonly a: SchoonerDeckWaterCell;
  readonly b: SchoonerDeckWaterCell;
  readonly aToB: ShipWaterOpeningName;
  readonly bToA: ShipWaterOpeningName;
  readonly relaxationSeconds: number;
}

interface CellSnapshot {
  readonly volumeM3: number;
  readonly roomM3: number;
  readonly areaM2: number;
  readonly surfaceHeadM: number;
}

const MINIMUM_RELAXATION_SECONDS = 0.5;
const HEAD_DEADBAND_M = 1e-12;

export const NO_SCHOONER_DECK_WATER_REQUESTS: readonly ShipWaterFlowRequest[] =
  Object.freeze([] as ShipWaterFlowRequest[]);

const DECK_WATER_INTERFACES: readonly DeckWaterInterface[] = [
  deckInterface(
    'weatherDeckAftStarboard',
    'weatherDeckAftPort',
    'deckAftStarboardToPort',
    'deckAftPortToStarboard',
  ),
  deckInterface(
    'weatherDeckForeStarboard',
    'weatherDeckForePort',
    'deckForeStarboardToPort',
    'deckForePortToStarboard',
  ),
  deckInterface(
    'weatherDeckAftStarboard',
    'weatherDeckForeStarboard',
    'deckStarboardAftToFore',
    'deckStarboardForeToAft',
  ),
  deckInterface(
    'weatherDeckAftPort',
    'weatherDeckForePort',
    'deckPortAftToFore',
    'deckPortForeToAft',
  ),
];

/**
 * Resolve one 240 Hz deck-water step from the current authoritative volumes.
 *
 * Each cell's shallow-water surface is projected onto world up through the
 * production roll/pitch convention. A connected pair requests flow from the
 * higher surface to the lower one. The equalising volume is the exact amount
 * that would make those two mean surfaces meet; one fixed step moves only a
 * distance-scaled fraction of it, capped again by source water and destination
 * room. Each cell has only two interfaces, and every interface fraction is at
 * most `step / 0.5 s`, so the resolver cannot request all of a source in one
 * step even before `ShipWaterState` applies its simultaneous-source guard.
 *
 * This is intentionally headless and quasi-static. It does not model wash
 * momentum, scuppers, downflooding, free-surface forces, or motion feedback.
 */
export function resolveSchoonerDeckWaterTransport(
  water: ShipWaterState,
  attitude: Readonly<SchoonerDeckWaterAttitude>,
): readonly ShipWaterFlowRequest[] {
  assertSchoonerDeckWaterAttitude(attitude);
  if (water.onboardVolumeM3 === 0) {
    return NO_SCHOONER_DECK_WATER_REQUESTS;
  }

  const sinRoll = Math.sin(attitude.rollRad);
  const cosRoll = Math.cos(attitude.rollRad);
  const sinPitch = Math.sin(attitude.pitchRad);
  const cosPitch = Math.cos(attitude.pitchRad);
  const upProjection = cosRoll * cosPitch;
  const xHeightGradient = sinRoll * cosPitch;
  const zHeightGradient = -sinPitch;
  const cells = {} as Record<SchoonerDeckWaterCell, CellSnapshot>;

  for (const name of SCHOONER_DECK_WATER_CELLS) {
    const geometry = SHIP_WATER_COMPARTMENT_GEOMETRY[name];
    const volumeM3 = water.volumeM3(name);
    const depthM = volumeM3 / geometry.freeSurfacePlanAreaM2;
    cells[name] = {
      volumeM3,
      roomM3: geometry.maximumCapacityM3 - volumeM3,
      areaM2: geometry.freeSurfacePlanAreaM2,
      // The cells are artificial control volumes over one continuous deck.
      // Their own mean deck elevations are therefore not a sill between them;
      // only mean water depth and the attitude gradient cross an interface.
      surfaceHeadM:
        depthM * upProjection +
        geometry.floorCentroid.x * xHeightGradient +
        geometry.floorCentroid.z * zHeightGradient,
    };
  }

  const requests: ShipWaterFlowRequest[] = [];
  for (const edge of DECK_WATER_INTERFACES) {
    const a = cells[edge.a];
    const b = cells[edge.b];
    const signedHeadM = a.surfaceHeadM - b.surfaceHeadM;
    if (Math.abs(signedHeadM) <= HEAD_DEADBAND_M) continue;
    const source = signedHeadM > 0 ? a : b;
    const destination = signedHeadM > 0 ? b : a;
    if (source.volumeM3 === 0 || destination.roomM3 <= 0) continue;

    const equalisingVolumeM3 =
      Math.abs(signedHeadM) /
      (upProjection * (1 / source.areaM2 + 1 / destination.areaM2));
    const relaxationFraction =
      SHIP_WATER_STEP_SECONDS / edge.relaxationSeconds;
    const volumeM3 =
      Math.min(
        equalisingVolumeM3,
        source.volumeM3,
        destination.roomM3,
      ) * relaxationFraction;
    if (!(volumeM3 > 0)) continue;
    requests.push({
      opening: signedHeadM > 0 ? edge.aToB : edge.bToA,
      rateM3PerSecond: volumeM3 / SHIP_WATER_STEP_SECONDS,
    });
  }
  return requests.length > 0 ? requests : NO_SCHOONER_DECK_WATER_REQUESTS;
}

function deckInterface(
  a: SchoonerDeckWaterCell,
  b: SchoonerDeckWaterCell,
  aToB: ShipWaterOpeningName,
  bToA: ShipWaterOpeningName,
): DeckWaterInterface {
  const pointA = SHIP_WATER_COMPARTMENT_GEOMETRY[a].floorCentroid;
  const pointB = SHIP_WATER_COMPARTMENT_GEOMETRY[b].floorCentroid;
  const distanceM = Math.hypot(pointB.x - pointA.x, pointB.z - pointA.z);
  return {
    a,
    b,
    aToB,
    bToA,
    relaxationSeconds: Math.max(
      MINIMUM_RELAXATION_SECONDS,
      distanceM / SCHOONER_DECK_WATER_RELAXATION_SPEED_MPS,
    ),
  };
}

/** Reject an attitude the current head projection is not authorised to model. */
export function assertSchoonerDeckWaterAttitude(
  attitude: Readonly<SchoonerDeckWaterAttitude>,
): void {
  if (!Number.isFinite(attitude.rollRad) || !Number.isFinite(attitude.pitchRad)) {
    throw new RangeError('deck-water roll and pitch must be finite');
  }
  if (
    Math.abs(attitude.rollRad) > HULL_ATTITUDE_LIMIT_RADIANS ||
    Math.abs(attitude.pitchRad) > HULL_ATTITUDE_LIMIT_RADIANS
  ) {
    throw new RangeError(
      'deck-water transport is credible only inside the production attitude limiter',
    );
  }
}
