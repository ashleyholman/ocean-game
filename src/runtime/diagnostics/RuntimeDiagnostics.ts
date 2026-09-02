import { createRuntimeBenchmarkDiagnostics } from './RuntimeBenchmarkDiagnostics';
import {
  createRuntimeVisualDiagnostics,
} from './RuntimeVisualDiagnostics';
import type {
  RuntimeDiagnostics,
  RuntimeDiagnosticsDependencies,
} from './RuntimeDiagnosticsContract';

export { createDiagnosticExecutionGate } from './RuntimeDiagnosticsContract';
export type {
  DiagnosticExecutionGate,
  DiagnosticSunShadowMode,
  RuntimeDiagnostics,
  RuntimeDiagnosticsDependencies,
} from './RuntimeDiagnosticsContract';

/**
 * Compose cold diagnostic capabilities around one shared execution gate.
 *
 * The benchmark and visual suites receive the same dependency record. Neither
 * suite constructs runtime state or reaches back into the browser entry module.
 */
export function createRuntimeDiagnostics(
  dependencies: RuntimeDiagnosticsDependencies,
): RuntimeDiagnostics {
  const benchmarks = createRuntimeBenchmarkDiagnostics(dependencies);
  const visual = createRuntimeVisualDiagnostics(dependencies);

  // Keep the public facade's insertion order stable for development consumers.
  return {
    runOceanProfileProbe: benchmarks.runOceanProfileProbe,
    runDirectShadowBenchmark: benchmarks.runDirectShadowBenchmark,
    runPairedToggleBenchmark: benchmarks.runPairedToggleBenchmark,
    runWakeTrailCostBenchmark: benchmarks.runWakeTrailCostBenchmark,
    runWakeBowCostBenchmark: benchmarks.runWakeBowCostBenchmark,
    runOceanResidualActiveBenchmark:
      benchmarks.runOceanResidualActiveBenchmark,
    runOceanDetailBenchmark: benchmarks.runOceanDetailBenchmark,
    runOceanDetailRepresentationBenchmark:
      benchmarks.runOceanDetailRepresentationBenchmark,
    runOceanDetailContactSheet: visual.runOceanDetailContactSheet,
    runWhitewaterCostBenchmark: benchmarks.runWhitewaterCostBenchmark,
    runOceanViolenceEvidence: visual.runOceanViolenceEvidence,
    runShapeLadder: visual.runShapeLadder,
    runFoamGainLadder: visual.runFoamGainLadder,
    runOceanCloudHazeContactSheet: visual.runOceanCloudHazeContactSheet,
    runWakeContactSheet: visual.runWakeContactSheet,
    runWakeWk2ContactSheet: visual.runWakeWk2ContactSheet,
    runOceanResidualDiff: visual.runOceanResidualDiff,
    runOceanDetailCategoryProbe: visual.runOceanDetailCategoryProbe,
    runOceanDetailCategoryMatrix: visual.runOceanDetailCategoryMatrix,
    runOceanResidualCategoryProbe: visual.runOceanResidualCategoryProbe,
    runOceanResidualCategoryMatrix: visual.runOceanResidualCategoryMatrix,
    serviceFrameReadback: visual.serviceFrameReadback,
    captureIfRequested: visual.captureIfRequested,
  };
}
