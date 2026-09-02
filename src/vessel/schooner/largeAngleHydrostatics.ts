import { HULL_ATTITUDE_LIMIT_RADIANS } from '../BuoyantBody';
import { MAX_BEAM } from './hullForm';
import { GRAVITY, RHO_WATER, hullStations } from './hydrostatics';
import { createSectionImmersion } from './hullSection';
import { buildLoadedShip } from './massModel';

export const SCHOONER_LARGE_ANGLE_BOUNDARY = Object.freeze({
  /** Only this band is exercised by, and representable in, production motion. */
  productionCredibilityRadians: HULL_ATTITUDE_LIMIT_RADIANS,
  /** `y = intercept + slope*x` becomes singular and changes half-plane here. */
  graphRepresentationLimitRadians: Math.PI / 2,
  invertedHydrostaticsSupported: false,
});

export type LargeAngleCredibility =
  | 'inside-production-limiter'
  | 'diagnostic-geometry-only'
  | 'unsupported';

export interface LargeAngleHydrostaticsProbe {
  readonly rollRadians: number;
  readonly rollDegrees: number;
  readonly credibility: LargeAngleCredibility;
  readonly quasiStaticSupported: boolean;
  readonly centrelineWaterInterceptY: number | null;
  readonly displacedVolumeM3: number | null;
  readonly centreOfBuoyancy: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** World-horizontal transverse arm from mass centre to buoyancy line. */
  readonly rightingLeverM: number | null;
  /** Signed vertical-buoyancy moment about the longitudinal roll axis. */
  readonly restoringMomentNm: number | null;
  readonly boundaryReason: string;
}

/**
 * Quasi-static imposed-heel diagnostic over the production hull sections.
 *
 * This is intentionally not a capsize model. It solves a flat-world waterline
 * through the existing graph-clipping section API. That API is geometrically
 * useful above the runtime's 0.7-rad guard, but at 90 degrees its slope is
 * singular; beyond 90 degrees the submerged side is the opposite half-plane.
 * Production also clamps local-up positive. Therefore 0.7..90 degrees is a
 * geometry probe only, and inversion is reported unsupported rather than
 * returning plausible-looking fiction.
 */
export function probeSchoonerRollHydrostatics(
  rollRadians: number,
): LargeAngleHydrostaticsProbe {
  const absoluteRoll = Math.abs(rollRadians);
  const rollDegrees = rollRadians * 180 / Math.PI;
  if (!Number.isFinite(rollRadians) || absoluteRoll >= Math.PI / 2) {
    return {
      rollRadians,
      rollDegrees,
      credibility: 'unsupported',
      quasiStaticSupported: false,
      centrelineWaterInterceptY: null,
      displacedVolumeM3: null,
      centreOfBuoyancy: null,
      rightingLeverM: null,
      restoringMomentNm: null,
      boundaryReason:
        'At 90 degrees the section waterline graph is singular; inverted water needs the opposite clipping half-plane, while production also clamps local-up positive.',
    };
  }

  const loaded = buildLoadedShip().properties;
  const targetVolume = loaded.mass / RHO_WATER;
  const slope = -Math.tan(rollRadians);
  const stations = hullStations();
  const scratch = createSectionImmersion();
  const graphAllowance = Math.abs(slope) * MAX_BEAM;
  let lo = Infinity;
  let hi = -Infinity;
  for (const station of stations) {
    lo = Math.min(lo, station.section.floorY - graphAllowance - 1);
    hi = Math.max(hi, station.section.crownY + graphAllowance + 1);
  }

  const volumeAt = (intercept: number): number => {
    let volume = 0;
    for (const station of stations) {
      station.section.immerse(intercept, slope, scratch);
      volume += scratch.area * station.length;
    }
    return volume;
  };

  for (let iteration = 0; iteration < 64; iteration++) {
    const mid = (lo + hi) / 2;
    if (volumeAt(mid) < targetVolume) lo = mid;
    else hi = mid;
  }
  const centrelineWaterInterceptY = (lo + hi) / 2;

  let displacedVolumeM3 = 0;
  let momentX = 0;
  let momentY = 0;
  let momentZ = 0;
  for (const station of stations) {
    station.section.immerse(centrelineWaterInterceptY, slope, scratch);
    const volume = scratch.area * station.length;
    displacedVolumeM3 += volume;
    momentX += scratch.centroidX * volume;
    momentY += scratch.centroidY * volume;
    momentZ += station.z * volume;
  }
  const centreOfBuoyancy = {
    x: momentX / displacedVolumeM3,
    y: momentY / displacedVolumeM3,
    z: momentZ / displacedVolumeM3,
  };
  const rightingLeverM =
    (centreOfBuoyancy.x - loaded.comX) * Math.cos(rollRadians) -
    (centreOfBuoyancy.y - loaded.comY) * Math.sin(rollRadians);
  const restoringMomentNm = rightingLeverM * loaded.mass * GRAVITY;
  const insideLimiter = absoluteRoll <= HULL_ATTITUDE_LIMIT_RADIANS;

  return {
    rollRadians,
    rollDegrees,
    credibility: insideLimiter
      ? 'inside-production-limiter'
      : 'diagnostic-geometry-only',
    quasiStaticSupported: true,
    centrelineWaterInterceptY,
    displacedVolumeM3,
    centreOfBuoyancy,
    rightingLeverM,
    restoringMomentNm,
    boundaryReason: insideLimiter
      ? 'Inside the production attitude limiter; still a quasi-static flat-water probe, not a motion integration.'
      : 'Outside the production 0.7-rad limiter: section geometry is finite, but runtime motion never represents this attitude.',
  };
}
