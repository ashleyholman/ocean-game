import {
  BULWARK_THICKNESS,
  HALF_LENGTH,
  HULL_LENGTH,
  bulwarkOuterHalfBeam,
  counterRakeShift,
} from './hullForm';
import {
  deckLevelAt,
  deckPoint,
  levelWalkingY,
} from './deckSurface';
import type {
  SchoonerDeckWaterCell,
  ShipWaterPoint,
} from './shipWaterCompartments';

/** The four aggregate drainage edges already named by SURV0's water graph. */
export const SCHOONER_SCUPPER_OPENING_NAMES = [
  'scupperAftStarboard',
  'scupperAftPort',
  'scupperForeStarboard',
  'scupperForePort',
] as const;

export type SchoonerScupperOpeningName =
  (typeof SCHOONER_SCUPPER_OPENING_NAMES)[number];

export type SchoonerScupperSide = 'starboard' | 'port';

/**
 * One clear freeing slot through the bulwark at deck level.
 *
 * `zParam` addresses the canonical hull station. `sill` is the actual placed
 * ship-local point after the counter rake, at the centre of the wall thickness.
 */
export interface SchoonerScupperAperture {
  readonly id: string;
  readonly opening: SchoonerScupperOpeningName;
  readonly cell: SchoonerDeckWaterCell;
  readonly side: SchoonerScupperSide;
  readonly zParam: number;
  readonly sill: ShipWaterPoint;
  readonly widthM: number;
  readonly heightM: number;
  readonly clearAreaM2: number;
  readonly effectiveAreaM2: number;
}

export interface SchoonerScupperOpeningGeometry {
  readonly name: SchoonerScupperOpeningName;
  readonly cell: SchoonerDeckWaterCell;
  readonly side: SchoonerScupperSide;
  readonly apertures: readonly SchoonerScupperAperture[];
  /** Canonical deck-edge quadrature controlling the cell's lowest water level. */
  readonly deckEdgeControlPoints: readonly ShipWaterPoint[];
  readonly clearAreaM2: number;
  readonly effectiveAreaM2: number;
}

/** Four slots per fore/aft cell, hence eight on each side of the vessel. */
export const SCHOONER_SCUPPER_APERTURES_PER_OPENING = 4;
export const SCHOONER_SCUPPER_SLOT_WIDTH_M = 0.42;
export const SCHOONER_SCUPPER_SLOT_HEIGHT_M = 0.13;

/**
 * Provisional sharp-edged rectangular-orifice coefficient.
 *
 * USBR's Water Measurement Manual gives about 0.61 for a fully contracted
 * sharp-edged rectangular slot. A 90 mm timber bulwark is not its laboratory
 * apparatus, so this is a provisional named SURV2 input, not a calibration.
 * https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_08.html
 */
export const SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT = 0.61;

/**
 * Modern exposed-water sizing reference, not a certification claim.
 *
 * 46 CFR 171.150's 36 in bulwark row asks for 423.2 cm² of freeing-port area
 * per metre over the after two-thirds of a vessel. The schooner's working
 * bulwark is 0.9 m and the hull is 15.5 m, so the comparable reference is
 * 0.04232 * (2/3) * 15.5 = 0.4373 m² per side. The authored eight slots on each
 * side land within 0.2% while remaining a period-plausible geometry choice.
 * https://www.govinfo.gov/content/pkg/CFR-1997-title46-vol7/pdf/CFR-1997-title46-vol7-part171.pdf
 */
export const SCHOONER_SCUPPER_MODERN_REFERENCE_AREA_PER_SIDE_M2 =
  0.04232 * ((2 * HULL_LENGTH) / 3);

const SLOT_AREA_M2 =
  SCHOONER_SCUPPER_SLOT_WIDTH_M * SCHOONER_SCUPPER_SLOT_HEIGHT_M;
const DECK_EDGE_CONTROL_SAMPLES = 192;

interface OpeningLayout {
  readonly name: SchoonerScupperOpeningName;
  readonly cell: SchoonerDeckWaterCell;
  readonly side: SchoonerScupperSide;
  readonly zParams: readonly number[];
}

// The lowest sheer is at z=-1.5. Slots are distributed through all three deck
// levels, with the middle stations closer together so drainage is not all sent
// to the fine ends. None straddles either deck break.
const AFT_SCUPPER_Z_PARAMS = [-6.4, -4.55, -2.8, -1.15] as const;
const FORE_SCUPPER_Z_PARAMS = [0.65, 2.1, 3.55, 5.65] as const;

const OPENING_LAYOUTS: readonly OpeningLayout[] = [
  {
    name: 'scupperAftStarboard',
    cell: 'weatherDeckAftStarboard',
    side: 'starboard',
    zParams: AFT_SCUPPER_Z_PARAMS,
  },
  {
    name: 'scupperAftPort',
    cell: 'weatherDeckAftPort',
    side: 'port',
    zParams: AFT_SCUPPER_Z_PARAMS,
  },
  {
    name: 'scupperForeStarboard',
    cell: 'weatherDeckForeStarboard',
    side: 'starboard',
    zParams: FORE_SCUPPER_Z_PARAMS,
  },
  {
    name: 'scupperForePort',
    cell: 'weatherDeckForePort',
    side: 'port',
    zParams: FORE_SCUPPER_Z_PARAMS,
  },
];

function apertureAt(
  layout: OpeningLayout,
  zParam: number,
  index: number,
): SchoonerScupperAperture {
  const level = deckLevelAt(zParam);
  const sillY = levelWalkingY(zParam, level);
  const outerHalfBeam = bulwarkOuterHalfBeam(zParam, sillY);
  const sideSign = layout.side === 'port' ? 1 : -1;
  const sill = Object.freeze({
    x: sideSign * (outerHalfBeam - BULWARK_THICKNESS * 0.5),
    y: sillY,
    z: zParam - counterRakeShift(zParam, sillY),
  });
  return Object.freeze({
    id: `${layout.name}:${index + 1}`,
    opening: layout.name,
    cell: layout.cell,
    side: layout.side,
    zParam,
    sill,
    widthM: SCHOONER_SCUPPER_SLOT_WIDTH_M,
    heightM: SCHOONER_SCUPPER_SLOT_HEIGHT_M,
    clearAreaM2: SLOT_AREA_M2,
    effectiveAreaM2:
      SLOT_AREA_M2 * SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
  });
}

function deckEdgeControlPoints(
  layout: OpeningLayout,
  apertures: readonly SchoonerScupperAperture[],
): readonly ShipWaterPoint[] {
  const zLo = layout.cell.includes('Aft') ? -HALF_LENGTH : 0;
  const zHi = layout.cell.includes('Aft') ? 0 : HALF_LENGTH;
  const dz = (zHi - zLo) / DECK_EDGE_CONTROL_SAMPLES;
  const side = layout.side === 'port' ? 1 : -1;
  const points: ShipWaterPoint[] = [];
  for (let i = 0; i <= DECK_EDGE_CONTROL_SAMPLES; i++) {
    const z = zLo + i * dz;
    const level = deckLevelAt(z);
    // A cambered half-deck is concave between centreline and side, so its
    // lowest world-height candidate under roll is on one of those boundaries.
    points.push(Object.freeze(deckPoint(z, 0, level)));
    points.push(Object.freeze(deckPoint(z, side, level)));
  }
  // Both physical ends of every linear aperture sill are exact controls. A
  // pitched slot's low end can sit below its centre; omitting it would make an
  // infinitesimal cell volume begin with a finite hydraulic head which only
  // the source-availability cap concealed.
  for (const aperture of apertures) {
    const halfWidthM = aperture.widthM * 0.5;
    points.push(
      Object.freeze({ ...aperture.sill, z: aperture.sill.z - halfWidthM }),
      aperture.sill,
      Object.freeze({ ...aperture.sill, z: aperture.sill.z + halfWidthM }),
    );
  }
  return Object.freeze(points);
}

const openingRows = OPENING_LAYOUTS.map(
  (layout): SchoonerScupperOpeningGeometry => {
    const apertures = Object.freeze(
      layout.zParams.map((z, index) => apertureAt(layout, z, index)),
    );
    const clearAreaM2 = apertures.reduce(
      (sum, aperture) => sum + aperture.clearAreaM2,
      0,
    );
    return Object.freeze({
      name: layout.name,
      cell: layout.cell,
      side: layout.side,
      apertures,
      deckEdgeControlPoints: deckEdgeControlPoints(layout, apertures),
      clearAreaM2,
      effectiveAreaM2:
        clearAreaM2 * SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
    });
  },
);

export const SCHOONER_SCUPPER_OPENINGS: Readonly<
  Record<SchoonerScupperOpeningName, SchoonerScupperOpeningGeometry>
> = Object.freeze(
  Object.fromEntries(openingRows.map((opening) => [opening.name, opening])) as
    Record<SchoonerScupperOpeningName, SchoonerScupperOpeningGeometry>,
);

export const SCHOONER_SCUPPER_APERTURES: readonly SchoonerScupperAperture[] =
  Object.freeze(openingRows.flatMap((opening) => opening.apertures));

export const SCHOONER_SCUPPER_CLEAR_AREA_PER_SIDE_M2 =
  SCHOONER_SCUPPER_APERTURES.filter(
    (aperture) => aperture.side === 'starboard',
  ).reduce((sum, aperture) => sum + aperture.clearAreaM2, 0);

export function schoonerScupperOpeningGeometry(
  name: SchoonerScupperOpeningName,
): SchoonerScupperOpeningGeometry {
  return SCHOONER_SCUPPER_OPENINGS[name];
}
