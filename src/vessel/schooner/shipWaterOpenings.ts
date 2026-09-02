import type { ClosureName } from './closures';
import {
  HATCHWAY_AFT_Z,
  HATCHWAY_FORWARD_Z,
  HATCHWAY_HALF_BREADTH,
  STERN_WINDOWS,
} from './deckInterior';
import {
  CARGO_HATCH_HALF_BREADTH,
  CARGO_HATCH_HALF_LENGTH,
  FORE_SCUTTLE_HALF_BREADTH,
} from './hullForm';
import type { ShipWaterCompartmentName } from './shipWaterCompartments';
import { SCHOONER_SCUPPER_OPENINGS } from './SchoonerScupperGeometry';

export type ShipWaterNode = ShipWaterCompartmentName | 'sea';
export type ShipWaterOpeningKind =
  | 'overtop'
  | 'deck-transfer'
  | 'scupper'
  | 'downflood'
  | 'limber'
  | 'pump';

/** Stable identifiers used by the mass ledger and eventual save state. */
export const SHIP_WATER_OPENING_NAMES = [
  'railAftStarboard',
  'railAftPort',
  'railForeStarboard',
  'railForePort',
  'deckAftStarboardToPort',
  'deckAftPortToStarboard',
  'deckForeStarboardToPort',
  'deckForePortToStarboard',
  'deckStarboardAftToFore',
  'deckStarboardForeToAft',
  'deckPortAftToFore',
  'deckPortForeToAft',
  'scupperAftStarboard',
  'scupperAftPort',
  'scupperForeStarboard',
  'scupperForePort',
  'companionway',
  'cargoGratingStarboard',
  'cargoGratingPort',
  'foreScuttle',
  'sternDeadlights',
  'hatchwayBoards',
  'cabinLimbers',
  'landingLimbers',
  'wardroomLimbers',
  'forecastleLimbers',
  'bilgePump',
] as const;

export type ShipWaterOpeningName = (typeof SHIP_WATER_OPENING_NAMES)[number];

export interface ShipWaterOpening {
  readonly name: ShipWaterOpeningName;
  readonly kind: ShipWaterOpeningKind;
  readonly from: ShipWaterNode;
  readonly to: ShipWaterNode;
  /** Opening is a path only while this closure's canonical state is open. */
  readonly closure?: ClosureName;
  /** Known clear aperture area; null when unresolved or not a physical aperture. */
  readonly clearAreaM2: number | null;
  /** Geometry provenance, or why a fixed aperture area does not apply/remains owed. */
  readonly geometrySource: string;
  /** Round which first resolves a non-zero physical rate over this edge. */
  readonly resolvesIn: 'SURV1' | 'SURV2' | 'SURV3' | 'SURV4';
}

const scuttleArea = (2 * FORE_SCUTTLE_HALF_BREADTH) ** 2;
const cargoHalfArea = CARGO_HATCH_HALF_BREADTH * (2 * CARGO_HATCH_HALF_LENGTH);
const hatchwayArea =
  2 * HATCHWAY_HALF_BREADTH * (HATCHWAY_FORWARD_Z - HATCHWAY_AFT_Z);
const deadlightArea = STERN_WINDOWS.reduce(
  (sum, window) => sum + 4 * window.halfWidth * window.halfHeight,
  0,
);

const rows: readonly ShipWaterOpening[] = [
  {
    name: 'railAftStarboard',
    kind: 'overtop',
    from: 'sea',
    to: 'weatherDeckAftStarboard',
    clearAreaM2: null,
    geometrySource: 'BuoyantBody OvertopEvent tributary geometry',
    resolvesIn: 'SURV1',
  },
  {
    name: 'railAftPort',
    kind: 'overtop',
    from: 'sea',
    to: 'weatherDeckAftPort',
    clearAreaM2: null,
    geometrySource: 'BuoyantBody OvertopEvent tributary geometry',
    resolvesIn: 'SURV1',
  },
  {
    name: 'railForeStarboard',
    kind: 'overtop',
    from: 'sea',
    to: 'weatherDeckForeStarboard',
    clearAreaM2: null,
    geometrySource: 'BuoyantBody OvertopEvent tributary geometry',
    resolvesIn: 'SURV1',
  },
  {
    name: 'railForePort',
    kind: 'overtop',
    from: 'sea',
    to: 'weatherDeckForePort',
    clearAreaM2: null,
    geometrySource: 'BuoyantBody OvertopEvent tributary geometry',
    resolvesIn: 'SURV1',
  },
  ...([
    [
      'deckAftStarboardToPort',
      'weatherDeckAftStarboard',
      'weatherDeckAftPort',
    ],
    [
      'deckAftPortToStarboard',
      'weatherDeckAftPort',
      'weatherDeckAftStarboard',
    ],
    [
      'deckForeStarboardToPort',
      'weatherDeckForeStarboard',
      'weatherDeckForePort',
    ],
    [
      'deckForePortToStarboard',
      'weatherDeckForePort',
      'weatherDeckForeStarboard',
    ],
    [
      'deckStarboardAftToFore',
      'weatherDeckAftStarboard',
      'weatherDeckForeStarboard',
    ],
    [
      'deckStarboardForeToAft',
      'weatherDeckForeStarboard',
      'weatherDeckAftStarboard',
    ],
    [
      'deckPortAftToFore',
      'weatherDeckAftPort',
      'weatherDeckForePort',
    ],
    [
      'deckPortForeToAft',
      'weatherDeckForePort',
      'weatherDeckAftPort',
    ],
  ] as const).map(([name, from, to]) => ({
    name,
    kind: 'deck-transfer' as const,
    from,
    to,
    clearAreaM2: null,
    geometrySource:
      'SURV1 four-cell numerical control interface; not a physical aperture',
    resolvesIn: 'SURV1' as const,
  })),
  ...([
    ['scupperAftStarboard', 'weatherDeckAftStarboard'],
    ['scupperAftPort', 'weatherDeckAftPort'],
    ['scupperForeStarboard', 'weatherDeckForeStarboard'],
    ['scupperForePort', 'weatherDeckForePort'],
  ] as const).map(([name, from]) => ({
    name,
    kind: 'scupper' as const,
    from,
    to: 'sea' as const,
    clearAreaM2: SCHOONER_SCUPPER_OPENINGS[name].clearAreaM2,
    geometrySource:
      'SchoonerScupperGeometry authored freeing slots placed from the canonical deck edge and bulwark',
    resolvesIn: 'SURV2' as const,
  })),
  {
    name: 'companionway',
    kind: 'downflood',
    from: 'weatherDeckAftPort',
    to: 'landing',
    clearAreaM2: null,
    geometrySource: 'hullForm.companionOpening; curved side limit requires SURV3 integration',
    resolvesIn: 'SURV3',
  },
  {
    name: 'cargoGratingStarboard',
    kind: 'downflood',
    from: 'weatherDeckForeStarboard',
    to: 'wardroom',
    clearAreaM2: cargoHalfArea,
    geometrySource: 'hullForm cargo-hatch footprint, starboard half',
    resolvesIn: 'SURV3',
  },
  {
    name: 'cargoGratingPort',
    kind: 'downflood',
    from: 'weatherDeckForePort',
    to: 'wardroom',
    clearAreaM2: cargoHalfArea,
    geometrySource: 'hullForm cargo-hatch footprint, port half',
    resolvesIn: 'SURV3',
  },
  {
    name: 'foreScuttle',
    kind: 'downflood',
    from: 'weatherDeckForeStarboard',
    to: 'forecastle',
    closure: 'foreScuttleLid',
    clearAreaM2: scuttleArea,
    geometrySource: 'hullForm fore-scuttle clear square',
    resolvesIn: 'SURV3',
  },
  {
    name: 'sternDeadlights',
    kind: 'downflood',
    from: 'sea',
    to: 'cabin',
    closure: 'sternDeadlights',
    clearAreaM2: deadlightArea,
    geometrySource: 'deckInterior stern-window apertures',
    resolvesIn: 'SURV3',
  },
  {
    name: 'hatchwayBoards',
    kind: 'downflood',
    from: 'wardroom',
    to: 'holdBilge',
    closure: 'hatchwayBoards',
    clearAreaM2: hatchwayArea,
    geometrySource: 'deckInterior platform hatchway footprint',
    resolvesIn: 'SURV3',
  },
  ...([
    ['cabinLimbers', 'cabin'],
    ['landingLimbers', 'landing'],
    ['wardroomLimbers', 'wardroom'],
    ['forecastleLimbers', 'forecastle'],
  ] as const).map(([name, from]) => ({
    name,
    kind: 'limber' as const,
    from,
    to: 'holdBilge' as const,
    clearAreaM2: null,
    geometrySource: 'limber-hole area/path not authored until SURV3',
    resolvesIn: 'SURV3' as const,
  })),
  {
    name: 'bilgePump',
    kind: 'pump',
    from: 'holdBilge',
    to: 'sea',
    clearAreaM2: null,
    geometrySource: 'pump stroke, suction and labour model not authored until SURV4',
    resolvesIn: 'SURV4',
  },
];

export const SHIP_WATER_OPENINGS: Readonly<Record<ShipWaterOpeningName, ShipWaterOpening>> =
  Object.fromEntries(rows.map((row) => [row.name, row])) as Record<
    ShipWaterOpeningName,
    ShipWaterOpening
  >;

export function shipWaterOpening(name: ShipWaterOpeningName): ShipWaterOpening {
  return SHIP_WATER_OPENINGS[name];
}

/** Closure polarity is shared with interaction: `true` means the path is open. */
export function shipWaterOpeningIsOpen(
  opening: ShipWaterOpening,
  closureIsOpen?: (name: ClosureName) => boolean,
): boolean {
  if (!opening.closure) return true;
  return closureIsOpen?.(opening.closure) ?? false;
}
