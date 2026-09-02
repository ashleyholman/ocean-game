import { belowDecksSpace, spaceDeckheadY, spaceHalfWidthAt } from './deckInterior';
import type { BelowDecksSpace, SpaceName } from './deckInterior';
import { deckCamberHeight, deckHalfWidth, deckLevelAt, deckPoint } from './deckSurface';
import { HALF_LENGTH } from './hullForm';
import { HOLD_FLOOR_Y, HOLD_SOLE_Y, HOLD_WELL } from './holdStow';

/** The four connected SURV1 control cells over the continuous weather deck. */
export const SCHOONER_DECK_WATER_CELLS = [
  'weatherDeckAftStarboard',
  'weatherDeckAftPort',
  'weatherDeckForeStarboard',
  'weatherDeckForePort',
] as const;

export type SchoonerDeckWaterCell =
  (typeof SCHOONER_DECK_WATER_CELLS)[number];

/** Stable water-control volumes. Names are save-state/API data from SURV0 onward. */
export const SHIP_WATER_COMPARTMENT_NAMES = [
  ...SCHOONER_DECK_WATER_CELLS,
  'holdBilge',
  'cabin',
  'landing',
  'wardroom',
  'forecastle',
] as const;

export type ShipWaterCompartmentName = (typeof SHIP_WATER_COMPARTMENT_NAMES)[number];

export interface ShipWaterPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Fixed geometry behind one water record.
 *
 * Capacity is a gross geometric ceiling, not a damage/sinking threshold. Deck
 * cells integrate to the caprail; rooms integrate from sole to deckhead; the
 * bilge uses the known clear working well. Furniture and stow can reduce these
 * later without changing the compartment names or ledger contract.
 */
export interface ShipWaterCompartmentGeometry {
  readonly name: ShipWaterCompartmentName;
  readonly floorCentroid: ShipWaterPoint;
  readonly fullCentroid: ShipWaterPoint;
  readonly freeSurfacePlanAreaM2: number;
  readonly effectiveSurfaceLengthM: number;
  readonly effectiveSurfaceBreadthM: number;
  readonly maximumCapacityM3: number;
}

type Side = 'starboard' | 'port';

function deckCell(
  name: ShipWaterCompartmentName,
  zLo: number,
  zHi: number,
  side: Side,
): ShipWaterCompartmentGeometry {
  const samples = 192;
  const dz = (zHi - zLo) / samples;
  const sign = side === 'port' ? 1 : -1;
  let area = 0;
  let capacity = 0;
  let floorX = 0;
  let floorY = 0;
  let floorZ = 0;
  let fullX = 0;
  let fullY = 0;
  let fullZ = 0;

  for (let i = 0; i < samples; i++) {
    const z = zLo + (i + 0.5) * dz;
    const level = deckLevelAt(z);
    const halfWidth = deckHalfWidth(z, level);
    const stripArea = halfWidth * dz;
    if (stripArea <= 0) continue;
    // Mean of the parabolic camber across one half-deck: integral(1-u^2)=2/3.
    const meanDeckY = deckPoint(z, 0, level).y - deckCamberHeight(z, level) / 3;
    const placedZ = deckPoint(z, sign * 0.5, level).z;
    const x = sign * halfWidth * 0.5;
    const retainedDepth = level.heightAboveWalkingDeck;
    const stripCapacity = stripArea * retainedDepth;

    area += stripArea;
    floorX += x * stripArea;
    floorY += meanDeckY * stripArea;
    floorZ += placedZ * stripArea;
    capacity += stripCapacity;
    fullX += x * stripCapacity;
    fullY += (meanDeckY + retainedDepth * 0.5) * stripCapacity;
    fullZ += placedZ * stripCapacity;
  }

  const length = zHi - zLo;
  return {
    name,
    floorCentroid: { x: floorX / area, y: floorY / area, z: floorZ / area },
    fullCentroid: { x: fullX / capacity, y: fullY / capacity, z: fullZ / capacity },
    freeSurfacePlanAreaM2: area,
    effectiveSurfaceLengthM: length,
    effectiveSurfaceBreadthM: area / length,
    maximumCapacityM3: capacity,
  };
}

function roomCompartment(
  name: Extract<ShipWaterCompartmentName, SpaceName>,
): ShipWaterCompartmentGeometry {
  const space: BelowDecksSpace = belowDecksSpace(name);
  const nz = 128;
  const nx = 48;
  const dz = (space.zForward - space.zAft) / nz;
  let area = 0;
  let capacity = 0;
  let floorX = 0;
  let floorZ = 0;
  let fullX = 0;
  let fullY = 0;
  let fullZ = 0;

  for (let iz = 0; iz < nz; iz++) {
    const z = space.zAft + (iz + 0.5) * dz;
    const halfWidth = spaceHalfWidthAt(space, z);
    const dx = (2 * halfWidth) / nx;
    for (let ix = 0; ix < nx; ix++) {
      const x = -halfWidth + (ix + 0.5) * dx;
      const ceiling = spaceDeckheadY(space, x, z);
      if (ceiling === null || ceiling <= space.soleY) continue;
      const plan = dx * dz;
      const volume = plan * (ceiling - space.soleY);
      area += plan;
      floorX += x * plan;
      floorZ += z * plan;
      capacity += volume;
      fullX += x * volume;
      fullY += ((space.soleY + ceiling) / 2) * volume;
      fullZ += z * volume;
    }
  }

  const length = space.zForward - space.zAft;
  return {
    name,
    floorCentroid: { x: floorX / area, y: space.soleY, z: floorZ / area },
    fullCentroid: { x: fullX / capacity, y: fullY / capacity, z: fullZ / capacity },
    freeSurfacePlanAreaM2: area,
    effectiveSurfaceLengthM: length,
    effectiveSurfaceBreadthM: area / length,
    maximumCapacityM3: capacity,
  };
}

function holdBilge(): ShipWaterCompartmentGeometry {
  const width = HOLD_WELL.xHi - HOLD_WELL.xLo;
  const length = HOLD_WELL.zForward - HOLD_WELL.zAft;
  const area = width * length;
  const depth = HOLD_SOLE_Y - HOLD_FLOOR_Y;
  const x = (HOLD_WELL.xLo + HOLD_WELL.xHi) / 2;
  const z = (HOLD_WELL.zAft + HOLD_WELL.zForward) / 2;
  return {
    name: 'holdBilge',
    floorCentroid: { x, y: HOLD_FLOOR_Y, z },
    fullCentroid: { x, y: HOLD_FLOOR_Y + depth / 2, z },
    freeSurfacePlanAreaM2: area,
    effectiveSurfaceLengthM: length,
    effectiveSurfaceBreadthM: width,
    maximumCapacityM3: area * depth,
  };
}

/** Geometry is constructed once from the same surfaces the ship draws/walks. */
export const SHIP_WATER_COMPARTMENT_GEOMETRY: Readonly<
  Record<ShipWaterCompartmentName, ShipWaterCompartmentGeometry>
> = (() => {
  const rows: ShipWaterCompartmentGeometry[] = [
    deckCell('weatherDeckAftStarboard', -HALF_LENGTH, 0, 'starboard'),
    deckCell('weatherDeckAftPort', -HALF_LENGTH, 0, 'port'),
    deckCell('weatherDeckForeStarboard', 0, HALF_LENGTH, 'starboard'),
    deckCell('weatherDeckForePort', 0, HALF_LENGTH, 'port'),
    holdBilge(),
    roomCompartment('cabin'),
    roomCompartment('landing'),
    roomCompartment('wardroom'),
    roomCompartment('forecastle'),
  ];
  return Object.fromEntries(rows.map((row) => [row.name, row])) as Record<
    ShipWaterCompartmentName,
    ShipWaterCompartmentGeometry
  >;
})();
