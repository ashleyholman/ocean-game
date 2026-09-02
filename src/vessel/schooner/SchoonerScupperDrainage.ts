import { HULL_ATTITUDE_LIMIT_RADIANS } from '../BuoyantBody';
import { GRAVITY } from './hydrostatics';
import {
  SHIP_WATER_STEP_SECONDS,
  type ShipWaterFlowRequest,
  type ShipWaterState,
} from './ShipWaterState';
import {
  SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
  SCHOONER_SCUPPER_OPENINGS,
  SCHOONER_SCUPPER_OPENING_NAMES,
} from './SchoonerScupperGeometry';
import type { SchoonerScupperAperture } from './SchoonerScupperGeometry';
import { SHIP_WATER_COMPARTMENT_GEOMETRY } from './shipWaterCompartments';

export interface SchoonerScupperDrainageFrame {
  /** World height of the vessel's moulded-baseline origin. */
  readonly originWorldYM: number;
  /** Production sign: positive lowers starboard. */
  readonly rollRad: number;
  /** Production sign: positive lowers the bow. */
  readonly pitchRad: number;
  /** Outside water surface at this physical slot, in world Y metres. */
  readonly seaSurfaceWorldYM: (
    aperture: Readonly<SchoonerScupperAperture>,
    /** Along the slot from its canonical centre, positive toward the bow. */
    longitudinalOffsetM: number,
  ) => number;
}

export interface RectangularScupperOutflowInput {
  readonly widthM: number;
  readonly heightM: number;
  readonly dischargeCoefficient: number;
  /** World-Y projection of one metre along vessel-local up. */
  readonly upProjection: number;
  readonly sillWorldYM: number;
  readonly insideSurfaceWorldYM: number;
  readonly outsideSurfaceWorldYM: number;
}

export interface SpanningRectangularScupperOutflowInput
  extends Omit<
    RectangularScupperOutflowInput,
    'widthM' | 'sillWorldYM' | 'outsideSurfaceWorldYM'
  > {
  readonly widthM: number;
  readonly sillCentreWorldYM: number;
  /** Change in sill world Y per metre along the slot toward the bow. */
  readonly sillWorldYGradientPerM: number;
  /**
   * Outside wave height along the span. The resolver samples the endpoints of
   * eight fixed panels and uses the chord inside each panel, making the spatial
   * resolution explicit and exposing every sampled head crossing to clipping.
   */
  readonly outsideSurfaceWorldYM: (longitudinalOffsetM: number) => number;
}

export const NO_SCHOONER_SCUPPER_DRAINAGE_REQUESTS: readonly ShipWaterFlowRequest[] =
  Object.freeze([] as ShipWaterFlowRequest[]);

/**
 * Integrate hydrostatic head over one vertical rectangular slot.
 *
 * Below the outside surface the pressure difference is constant. Above it the
 * slot is a free outfall and head falls to zero at the inside surface. This one
 * expression therefore handles a dry outlet, a partly submerged outlet and a
 * fully submerged outlet without letting the sea drive a negative "drain" back
 * through SURV2's one-way graph edge.
 */
export function rectangularScupperOutflowM3PerSecond(
  input: Readonly<RectangularScupperOutflowInput>,
): number {
  assertPositiveFinite(input.widthM, 'scupper width');
  assertPositiveFinite(input.heightM, 'scupper height');
  assertPositiveFinite(input.upProjection, 'scupper up projection');
  if (input.upProjection > 1) {
    throw new RangeError(
      `scupper up projection must not exceed 1, got ${input.upProjection}`,
    );
  }
  if (
    !Number.isFinite(input.dischargeCoefficient) ||
    input.dischargeCoefficient < 0 ||
    input.dischargeCoefficient > 1
  ) {
    throw new RangeError(
      `scupper discharge coefficient must be finite in [0, 1], got ${input.dischargeCoefficient}`,
    );
  }
  for (const [label, value] of [
    ['scupper sill world Y', input.sillWorldYM],
    ['inside water surface world Y', input.insideSurfaceWorldYM],
    ['outside water surface world Y', input.outsideSurfaceWorldYM],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${label} must be finite, got ${value}`);
    }
  }
  if (
    input.dischargeCoefficient === 0 ||
    input.insideSurfaceWorldYM <= input.outsideSurfaceWorldYM ||
    input.insideSurfaceWorldYM <= input.sillWorldYM
  ) {
    return 0;
  }

  const slotLo = input.sillWorldYM;
  const slotHi =
    input.sillWorldYM + input.heightM * input.upProjection;
  const activeHi = Math.min(slotHi, input.insideSurfaceWorldYM);
  if (activeHi <= slotLo) return 0;

  const root2g = Math.sqrt(2 * GRAVITY);
  let headIntegralM3PerSecondPerM = 0;

  // The submerged part sees the same inside-minus-outside pressure head at
  // every elevation. It may occupy none, some or all of the active slot.
  const submergedHi = Math.min(
    activeHi,
    Math.max(input.outsideSurfaceWorldYM, slotLo),
  );
  if (submergedHi > slotLo) {
    headIntegralM3PerSecondPerM +=
      (submergedHi - slotLo) *
      root2g *
      Math.sqrt(input.insideSurfaceWorldYM - input.outsideSurfaceWorldYM);
  }

  // Above the outside surface, integrate sqrt(2g * (insideY - y)) dy.
  const freeLo = Math.max(slotLo, input.outsideSurfaceWorldYM);
  if (activeHi > freeLo) {
    headIntegralM3PerSecondPerM +=
      (2 / 3) *
      root2g *
      ((input.insideSurfaceWorldYM - freeLo) ** 1.5 -
        (input.insideSurfaceWorldYM - activeHi) ** 1.5);
  }

  // The integral is in world-Y metres. Divide by the projection to recover
  // actual slot height before multiplying by its physical width.
  return (
    input.dischargeCoefficient *
    (input.widthM / input.upProjection) *
    headIntegralM3PerSecondPerM
  );
}

// Eight-point Gauss-Legendre quadrature on [-1, 1]. The caller first clips the
// span at the exact linear sill/water intersection, so even an arbitrarily
// narrow pitched wet sliver is mapped across all eight fixed nodes instead of
// hiding between the final node and the physical slot end.
const SPAN_NODES = [
  -0.9602898564975363,
  -0.7966664774136267,
  -0.525532409916329,
  -0.1834346424956498,
  0.1834346424956498,
  0.525532409916329,
  0.7966664774136267,
  0.9602898564975363,
] as const;
const SPAN_WEIGHTS = [
  0.1012285362903763,
  0.2223810344533745,
  0.3137066458778873,
  0.362683783378362,
  0.362683783378362,
  0.3137066458778873,
  0.2223810344533745,
  0.1012285362903763,
] as const;
const OUTSIDE_WAVE_SPAN_PANELS = 8;

/** Integrate one slot across the world-height gradient created by pitch. */
export function spanningRectangularScupperOutflowM3PerSecond(
  input: Readonly<SpanningRectangularScupperOutflowInput>,
): number {
  assertPositiveFinite(input.widthM, 'spanning scupper width');
  if (!Number.isFinite(input.sillWorldYGradientPerM)) {
    throw new RangeError(
      `scupper sill span gradient must be finite, got ${input.sillWorldYGradientPerM}`,
    );
  }
  const halfWidthM = input.widthM * 0.5;
  let sillActiveLoM = -halfWidthM;
  let sillActiveHiM = halfWidthM;
  if (input.sillWorldYGradientPerM === 0) {
    if (input.insideSurfaceWorldYM <= input.sillCentreWorldYM) return 0;
  } else {
    const wetDryOffsetM =
      (input.insideSurfaceWorldYM - input.sillCentreWorldYM) /
      input.sillWorldYGradientPerM;
    if (input.sillWorldYGradientPerM > 0) {
      sillActiveHiM = Math.min(sillActiveHiM, wetDryOffsetM);
    } else {
      sillActiveLoM = Math.max(sillActiveLoM, wetDryOffsetM);
    }
    if (sillActiveHiM <= sillActiveLoM) return 0;
  }

  let rateM3PerSecond = 0;
  const panelWidthM = input.widthM / OUTSIDE_WAVE_SPAN_PANELS;
  for (let panel = 0; panel < OUTSIDE_WAVE_SPAN_PANELS; panel++) {
    const panelLoM = -halfWidthM + panel * panelWidthM;
    const panelHiM = panelLoM + panelWidthM;
    let activeLoM = Math.max(panelLoM, sillActiveLoM);
    let activeHiM = Math.min(panelHiM, sillActiveHiM);
    if (activeHiM <= activeLoM) continue;

    const outsideLoM = input.outsideSurfaceWorldYM(panelLoM);
    const outsideHiM = input.outsideSurfaceWorldYM(panelHiM);
    if (!Number.isFinite(outsideLoM) || !Number.isFinite(outsideHiM)) {
      throw new RangeError(
        `spanning scupper outside surface must be finite, got ${outsideLoM}, ${outsideHiM}`,
      );
    }
    const outsideGradientPerM =
      (outsideHiM - outsideLoM) / panelWidthM;
    if (outsideGradientPerM === 0) {
      if (input.insideSurfaceWorldYM <= outsideLoM) continue;
    } else {
      const headCrossingOffsetM =
        panelLoM +
        (input.insideSurfaceWorldYM - outsideLoM) / outsideGradientPerM;
      if (outsideGradientPerM > 0) {
        activeHiM = Math.min(activeHiM, headCrossingOffsetM);
      } else {
        activeLoM = Math.max(activeLoM, headCrossingOffsetM);
      }
      if (activeHiM <= activeLoM) continue;
    }

    const activeCentreM = (activeLoM + activeHiM) * 0.5;
    const activeHalfWidthM = (activeHiM - activeLoM) * 0.5;
    for (let i = 0; i < SPAN_NODES.length; i++) {
      const offsetM = activeCentreM + activeHalfWidthM * SPAN_NODES[i];
      rateM3PerSecond += rectangularScupperOutflowM3PerSecond({
        widthM: activeHalfWidthM * SPAN_WEIGHTS[i],
        heightM: input.heightM,
        dischargeCoefficient: input.dischargeCoefficient,
        upProjection: input.upProjection,
        sillWorldYM:
          input.sillCentreWorldYM +
          input.sillWorldYGradientPerM * offsetM,
        insideSurfaceWorldYM: input.insideSurfaceWorldYM,
        outsideSurfaceWorldYM:
          outsideLoM + outsideGradientPerM * (offsetM - panelLoM),
      });
    }
  }
  return rateM3PerSecond;
}

/**
 * Resolve one fixed water step's four aggregate overboard drainage requests.
 *
 * The current four-cell approximation spreads each cell's volume over its
 * canonical plan area above the lowest sampled deck edge. Each physical slot
 * is then integrated across its pitched span against its own sill and outside
 * wave height. `ShipWaterState` remains the authority that caps simultaneous
 * requests by the water actually present.
 */
export function resolveSchoonerScupperDrainage(
  water: ShipWaterState,
  frame: Readonly<SchoonerScupperDrainageFrame>,
): readonly ShipWaterFlowRequest[] {
  assertFrame(frame);
  if (water.onboardVolumeM3 === 0) {
    return NO_SCHOONER_SCUPPER_DRAINAGE_REQUESTS;
  }

  const sinRoll = Math.sin(frame.rollRad);
  const cosRoll = Math.cos(frame.rollRad);
  const sinPitch = Math.sin(frame.pitchRad);
  const cosPitch = Math.cos(frame.pitchRad);
  const upProjection = cosRoll * cosPitch;
  const xHeightGradient = sinRoll * cosPitch;
  const zHeightGradient = -sinPitch;
  const requests: ShipWaterFlowRequest[] = [];

  for (const name of SCHOONER_SCUPPER_OPENING_NAMES) {
    const opening = SCHOONER_SCUPPER_OPENINGS[name];
    const volumeM3 = water.volumeM3(opening.cell);
    if (volumeM3 === 0) continue;
    const cell = SHIP_WATER_COMPARTMENT_GEOMETRY[opening.cell];
    const depthM = volumeM3 / cell.freeSurfacePlanAreaM2;
    let lowestDeckEdgeWorldYM = Infinity;
    for (const point of opening.deckEdgeControlPoints) {
      lowestDeckEdgeWorldYM = Math.min(
        lowestDeckEdgeWorldYM,
        frame.originWorldYM +
          point.y * upProjection +
          point.x * xHeightGradient +
          point.z * zHeightGradient,
      );
    }
    // Rise from the actual low edge rather than the multi-level cell's mean
    // floor centroid. Besides keeping raised decks honest, this makes the
    // drainage request converge continuously to zero with onboard volume.
    const insideSurfaceWorldYM =
      lowestDeckEdgeWorldYM + depthM * upProjection;

    let rateM3PerSecond = 0;
    for (const aperture of opening.apertures) {
      const sillWorldYM =
        frame.originWorldYM +
        aperture.sill.y * upProjection +
        aperture.sill.x * xHeightGradient +
        aperture.sill.z * zHeightGradient;
      rateM3PerSecond += spanningRectangularScupperOutflowM3PerSecond({
        widthM: aperture.widthM,
        heightM: aperture.heightM,
        dischargeCoefficient: SCHOONER_SCUPPER_DISCHARGE_COEFFICIENT,
        upProjection,
        sillCentreWorldYM: sillWorldYM,
        sillWorldYGradientPerM: zHeightGradient,
        insideSurfaceWorldYM,
        outsideSurfaceWorldYM: (offsetM) => {
          const outsideSurfaceWorldYM = frame.seaSurfaceWorldYM(
            aperture,
            offsetM,
          );
          if (!Number.isFinite(outsideSurfaceWorldYM)) {
            throw new RangeError(
              `outside water surface at ${aperture.id} offset ${offsetM} must be finite, got ${outsideSurfaceWorldYM}`,
            );
          }
          return outsideSurfaceWorldYM;
        },
      });
    }
    // The graph has one outlet per cell, so this is the exact source-availability
    // ceiling before ShipWaterState applies its own independent guard. The
    // aperture endpoint controls supply the real dry-limit law; this cap is a
    // final conservation guard against a future geometry/sample mismatch.
    rateM3PerSecond = Math.min(
      rateM3PerSecond,
      volumeM3 / SHIP_WATER_STEP_SECONDS,
    );
    if (rateM3PerSecond > 0) {
      requests.push({ opening: name, rateM3PerSecond });
    }
  }

  return requests.length > 0
    ? requests
    : NO_SCHOONER_SCUPPER_DRAINAGE_REQUESTS;
}

function assertFrame(frame: Readonly<SchoonerScupperDrainageFrame>): void {
  if (!Number.isFinite(frame.originWorldYM)) {
    throw new RangeError(
      `scupper origin world Y must be finite, got ${frame.originWorldYM}`,
    );
  }
  for (const [label, value] of [
    ['roll', frame.rollRad],
    ['pitch', frame.pitchRad],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`scupper ${label} must be finite, got ${value}`);
    }
    if (Math.abs(value) > HULL_ATTITUDE_LIMIT_RADIANS) {
      throw new RangeError(
        `scupper ${label} ${value} exceeds the current ${HULL_ATTITUDE_LIMIT_RADIANS} rad production credibility boundary`,
      );
    }
  }
}

function assertPositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be positive and finite, got ${value}`);
  }
}
