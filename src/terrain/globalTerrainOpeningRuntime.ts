import { globalTerrainSource } from './GlobalTerrainSource';
import {
  formatWaterAwareOpeningDiagnostic,
  resolveWaterAwareOpening,
  type AuthoredOpening,
  type WaterAwareOpeningFailure,
  type WaterAwareOpeningSuccess,
} from './WaterAwareOpeningResolver';

export class GlobalTerrainOpeningError extends Error {
  constructor(readonly diagnostics: WaterAwareOpeningFailure) {
    super(
      `[terrain] no qualified global opening within ` +
        `${diagnostics.profile.maximumRadiusM.toFixed(0)} m of the authored point`,
    );
    this.name = 'GlobalTerrainOpeningError';
  }
}

/** Resolve and report the explicit-global opening before PlanetaryWorld exists. */
export function resolveGlobalTerrainOpening(
  authored: Readonly<AuthoredOpening>,
): WaterAwareOpeningSuccess {
  const resolution = resolveWaterAwareOpening(globalTerrainSource, authored);
  if (resolution.status === 'failed') {
    console.error('[terrain] global opening resolution failed', resolution);
    throw new GlobalTerrainOpeningError(resolution);
  }

  console.info(
    `[terrain] ${formatWaterAwareOpeningDiagnostic(resolution)}` +
      ` · ${resolution.candidatesTested} candidates`,
  );
  return resolution;
}
