import {
  globalTerrainSource,
  type GlobalTerrainSource,
} from './GlobalTerrainSource';
import {
  formatWaterAwareTeleportDiagnostic,
  resolveWaterAwareTeleport,
  type OpeningCoordinate,
  type WaterAwareTeleportDecision,
} from './WaterAwareOpeningResolver';

/**
 * Resolve one explicit-global globe click and publish any surprising outcome.
 * Accepted open-water clicks stay quiet; relocated and rejected clicks are
 * visible in diagnostics without creating a second mutable position authority.
 */
export function resolveGlobalTerrainTeleport(
  selected: Readonly<OpeningCoordinate>,
  source: GlobalTerrainSource = globalTerrainSource,
): WaterAwareTeleportDecision {
  const decision = resolveWaterAwareTeleport(source, selected);
  if (decision.status === 'relocated') {
    console.info(`[terrain] ${formatWaterAwareTeleportDiagnostic(decision)}`);
  } else if (decision.status === 'rejected') {
    console.warn(`[terrain] ${formatWaterAwareTeleportDiagnostic(decision)}`);
  }
  return decision;
}
