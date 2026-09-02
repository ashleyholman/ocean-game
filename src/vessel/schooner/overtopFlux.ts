import type { OvertopEvent } from '../BuoyantBody';

/** Unity leaves the provisional broad-crested result theoretical, not tuned. */
export const PROVISIONAL_OVERTOP_DISCHARGE_COEFFICIENT = 1;
const GRAVITY_MPS2 = 9.81;

export interface OvertopFluxResolution {
  /** Uncapped broad-crested-weir result. */
  readonly weirRateM3PerSecond: number;
  /** Event rate after its finite tributary-water prism is enforced. */
  readonly resolvedRateM3PerSecond: number;
  readonly uncappedVolumeM3: number;
  readonly volumeM3: number;
  readonly waterPrismCapM3: number;
  readonly cappedByTributaryArea: boolean;
}

export const ZERO_OVERTOP_FLUX: OvertopFluxResolution = Object.freeze({
  weirRateM3PerSecond: 0,
  resolvedRateM3PerSecond: 0,
  uncappedVolumeM3: 0,
  volumeM3: 0,
  waterPrismCapM3: 0,
  cappedByTributaryArea: false,
});

/**
 * Resolve one contact fact into volume without mutating ship or sea state.
 *
 * Q = Cd b sqrt(g) (2h/3)^(3/2) follows the critical-depth derivation for a
 * rectangular broad-crested weir in the US Bureau of Reclamation Water
 * Measurement Manual, chapter 2 section 13:
 * https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_13.html
 * Here it is a transparent SURV1 placeholder, not a
 * calibrated boarding-sea claim. The event cannot contribute more than the
 * finite prism `h * tributaryArea` represented by its contact station.
 */
export function resolveOvertopFlux(
  event: Readonly<OvertopEvent>,
  dischargeCoefficient = PROVISIONAL_OVERTOP_DISCHARGE_COEFFICIENT,
): OvertopFluxResolution {
  const depth = event.depth;
  const duration = event.durationSeconds;
  const width = event.contactWidthM;
  const tributaryArea = event.tributaryAreaM2;
  if (
    !Number.isFinite(depth) ||
    !Number.isFinite(duration) ||
    !Number.isFinite(width) ||
    !Number.isFinite(tributaryArea) ||
    !Number.isFinite(dischargeCoefficient) ||
    depth <= 0 ||
    duration <= 0 ||
    width <= 0 ||
    tributaryArea <= 0 ||
    dischargeCoefficient <= 0
  ) {
    return ZERO_OVERTOP_FLUX;
  }

  const weirRateM3PerSecond =
    dischargeCoefficient *
    width *
    Math.sqrt(GRAVITY_MPS2) *
    ((2 * depth) / 3) ** 1.5;
  const uncappedVolumeM3 = weirRateM3PerSecond * duration;
  const waterPrismCapM3 = depth * tributaryArea;
  const volumeM3 = Math.min(uncappedVolumeM3, waterPrismCapM3);
  return {
    weirRateM3PerSecond,
    resolvedRateM3PerSecond: volumeM3 / duration,
    uncappedVolumeM3,
    volumeM3,
    waterPrismCapM3,
    cappedByTributaryArea: uncappedVolumeM3 > waterPrismCapM3,
  };
}
