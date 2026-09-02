import type * as THREE from 'three';

import type { CameraSystem } from '../../camera/CameraSystem';
import type { SeaStateController } from '../../ocean/SeaStateController';
import type { GpuProfiler } from '../../render/GpuProfiler';
import type { FoamField } from '../../scene/FoamField';
import type { Ocean, OceanQuality } from '../../scene/Ocean';
import type { SkySystem } from '../../scene/SkySystem';
import type { TimeOfDay } from '../../scene/TimeOfDay';
import type { WaveField } from '../../scene/Waves';
import type { PlanetaryWorld } from '../../world/PlanetaryWorld';
import type { WakeBowFeature } from '../WakePresentationController';
import type { SimHandle } from './SimHandle';

export interface DiagnosticExecutionGate {
  /** True from the first state mutation through the final restoration warm-up. */
  active: boolean;
}

export function createDiagnosticExecutionGate(): DiagnosticExecutionGate {
  return { active: false };
}

export type DiagnosticSunShadowMode =
  | 'off'
  | 'solid-only'
  | 'water-receiver'
  | 'full';

/** Stable production resources plus narrow adapters for cold diagnostic state. */
export interface RuntimeDiagnosticsDependencies {
  execution: DiagnosticExecutionGate;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  gpuProfiler: GpuProfiler;
  ocean: Ocean;
  sky: SkySystem;
  waves: WaveField;
  foam: FoamField;
  world: PlanetaryWorld;
  seaStates: SeaStateController;
  cameras: CameraSystem;
  lighting: TimeOfDay;
  quality: Pick<OceanQuality, 'detailOctaves'>;
  nextPresentedFrame(): Promise<void>;
  waitPresentedFrames(count: number): Promise<void>;
  foamFreeze: {
    value: boolean;
  };
  wakeState: {
    wakeEffectsEnabled(): boolean;
    setWakeEffectsEnabled(enabled: boolean): void;
    wakeBowFeatureEnabled(feature: WakeBowFeature): boolean;
    setWakeBowFeatureEnabled(feature: WakeBowFeature, enabled: boolean): void;
    wakeSpeedThroughWaterMps(): number;
  };
  shadowing: {
    snapshot(): { sun: boolean; lantern: boolean };
    setBenchmarkSunMode(mode: DiagnosticSunShadowMode): void;
    setSunShadowing(enabled: boolean): void;
    setLanternShadowing(enabled: boolean): void;
  };
  /** Resolved only when a dynamically imported visual-evidence command runs. */
  getSimHandle(): SimHandle;
  capturePort: number;
}

type SimDiagnosticCommands = Pick<
  SimHandle,
  | 'runWakeContactSheet'
  | 'runWakeWk2ContactSheet'
  | 'runDirectShadowBenchmark'
  | 'runOceanProfileProbe'
  | 'runOceanDetailBenchmark'
  | 'runOceanDetailRepresentationBenchmark'
  | 'runOceanDetailContactSheet'
  | 'runOceanCloudHazeContactSheet'
  | 'runOceanViolenceEvidence'
  | 'runFoamGainLadder'
  | 'runShapeLadder'
  | 'runWhitewaterCostBenchmark'
  | 'runOceanDetailCategoryMatrix'
  | 'runOceanDetailCategoryProbe'
  | 'runOceanResidualActiveBenchmark'
  | 'runOceanResidualCategoryMatrix'
  | 'runOceanResidualCategoryProbe'
  | 'runOceanResidualDiff'
>;

/** Public facade consumed by SimHandle assembly and URL evidence hosts. */
export interface RuntimeDiagnostics extends SimDiagnosticCommands {
  runPairedToggleBenchmark(
    subject: {
      title: string;
      apply(on: boolean): void;
      read(): boolean;
    },
    onProgress: (report: string) => void,
  ): Promise<string>;
  runWakeTrailCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  runWakeBowCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Must run immediately after the requested frame has rendered. */
  serviceFrameReadback(): void;
  captureIfRequested(): void;
}
