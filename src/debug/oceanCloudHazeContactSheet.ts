import { findSeaState } from '../ocean/presets';
import type {
  OceanDetailContactSheet,
  SimCapability,
} from '../runtime/diagnostics/SimHandle';

export type OceanCloudHazeContactSheetCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'clearFoam'
  | 'lighting'
  | 'ocean'
  | 'refreshLighting'
  | 'renderFrame'
  | 'renderer'
  | 'seaStates'
  | 'setSeaState'
  | 'sky'
  | 'stepSimulation'
  | 'warmFoam'
  | 'waves'
  | 'world'
>;
import { buildContactSheet, grab, post, postText, toBlob } from './labCapture';
import type { SheetFrame } from './labCapture';

interface OceanHazeShot {
  label: string;
  seaState: string;
  sunElevationDeg: number;
  waveTimeSeconds: number;
}

/**
 * Rough seas dominate because they contain the geometry that exposed the cost
 * cliff. The calmer control distinguishes a broad colour shift from something
 * visible only where a close face crosses the eye line.
 */
export const OCEAN_HAZE_AB_SHOTS: readonly OceanHazeShot[] = [
  { label: 'Southern rough · midday', seaState: 'SOUTHERN_OCEAN_ROUGH', sunElevationDeg: 48, waveTimeSeconds: 118 },
  { label: 'Southern rough · low sun', seaState: 'SOUTHERN_OCEAN_ROUGH', sunElevationDeg: 9, waveTimeSeconds: 151 },
  { label: 'Southern rough · blue hour', seaState: 'SOUTHERN_OCEAN_ROUGH', sunElevationDeg: -5, waveTimeSeconds: 184 },
  { label: 'Crossing seas · afternoon', seaState: 'CROSSING_SEAS', sunElevationDeg: 30, waveTimeSeconds: 137 },
  { label: 'Mature wind sea · sunset', seaState: 'MATURE_WIND_SEA', sunElevationDeg: 2, waveTimeSeconds: 163 },
  { label: 'Moderate control · daylight', seaState: 'CURRENT_MODERATE', sunElevationDeg: 38, waveTimeSeconds: 109 },
];

export interface OceanHazeContactSheetOptions {
  onProgress?: (report: string) => void;
  renderWidth?: number;
  renderHeight?: number;
  frameScale?: number;
  publish?: boolean;
  name?: string;
}

function setSunElevation(
  sim: OceanCloudHazeContactSheetCapability,
  searchBaseUtcSeconds: number,
  targetElevationDeg: number,
): number {
  const state = sim.world.state;
  let bestInstant = searchBaseUtcSeconds;
  let bestElevation = 0;
  let bestError = Infinity;
  for (let minute = 0; minute < 1440; minute += 2) {
    state.worldInstantUtcSeconds = searchBaseUtcSeconds + minute * 60;
    sim.refreshLighting();
    const y = Math.min(Math.max(sim.lighting.sunDirection.y, -1), 1);
    const elevationDeg = (Math.asin(y) * 180) / Math.PI;
    const error = Math.abs(elevationDeg - targetElevationDeg);
    if (error < bestError) {
      bestError = error;
      bestInstant = state.worldInstantUtcSeconds;
      bestElevation = elevationDeg;
    }
  }
  state.worldInstantUtcSeconds = bestInstant;
  sim.refreshLighting();
  return bestElevation;
}

/** Capture a deterministic two-column A/B matrix and publish the composite. */
export async function captureOceanCloudHazeContactSheet(
  sim: OceanCloudHazeContactSheetCapability,
  options: OceanHazeContactSheetOptions = {},
): Promise<OceanDetailContactSheet> {
  const renderWidth = options.renderWidth ?? 1280;
  const renderHeight = options.renderHeight ?? 720;
  const frameScale = options.frameScale ?? 0.5;
  const progress = options.onProgress ?? (() => undefined);
  const state = sim.world.state;
  const restoreRate = state.worldSecondsPerRealSecond;
  const restorePaused = state.paused;
  const restoreInstant = state.worldInstantUtcSeconds;
  const restoreSeaState = sim.seaStates.state;
  const restoreWaveTime = sim.waves.time;
  const restoreCameraMode = sim.cameras.modeName;
  const restoreLook = sim.cameras.look;
  const restoreCloudsInHaze = sim.ocean.cloudsInHazeEnabled;
  const restoreCloudCacheFrozen = sim.sky.cloudDome.frozen;
  const restorePixelRatio = sim.renderer.getPixelRatio();
  const restoreWidth = sim.renderer.domElement.width / restorePixelRatio;
  const restoreHeight = sim.renderer.domElement.height / restorePixelRatio;
  const frames: SheetFrame[] = [];
  const captures: OceanDetailContactSheet['captures'] = [];
  const notes: string[] = [];

  const pinSize = (): void => {
    sim.renderer.setPixelRatio(1);
    sim.renderer.setSize(renderWidth, renderHeight, false);
    sim.cameras.setViewport(renderWidth, renderHeight);
  };

  const settleAndRender = (framesToSettle: number): void => {
    for (let index = 0; index < framesToSettle; index++) {
      pinSize();
      sim.stepSimulation(0);
      sim.renderFrame();
    }
  };

  state.worldSecondsPerRealSecond = 0;
  state.paused = true;
  pinSize();

  try {
    for (let index = 0; index < OCEAN_HAZE_AB_SHOTS.length; index++) {
      const shot = OCEAN_HAZE_AB_SHOTS[index];
      progress(`Ocean haze A/B ${index + 1}/${OCEAN_HAZE_AB_SHOTS.length} · ${shot.label}`);
      sim.setSeaState(findSeaState(shot.seaState), 0);
      sim.waves.setTime(shot.waveTimeSeconds);
      const measuredSun = setSunElevation(sim, restoreInstant, shot.sunElevationDeg);

      sim.clearFoam();
      sim.warmFoam();
      sim.cameras.setDiagnosticMode('embodied');
      sim.cameras.embodied.reset();
      // Out through the forward-side quarter, level with the horizon: close
      // water and approaching faces, with both the deck logs and side stay
      // behind the sightline.
      sim.cameras.look = { yaw: (140 * Math.PI) / 180, pitch: 0 };

      // Give the cloud cache a complete ordinary generation at this frozen
      // camera before either shader variant is photographed.
      sim.sky.cloudDome.setFrozen(false);
      settleAndRender(72);
      sim.sky.cloudDome.setFrozen(true);

      for (const variant of [
        { prefix: 'A', label: 'legacy cloud haze', enabled: true },
        { prefix: 'B', label: 'fixed gas-only haze', enabled: false },
      ] as const) {
        sim.ocean.setCloudsInHazeEnabled(variant.enabled);
        settleAndRender(4);
        const image = grab(sim.canvas, frameScale);
        const label = `${variant.prefix} · ${shot.label} · sun ${measuredSun.toFixed(0)}°`;
        frames.push({ image, label });
        captures.push({
          label: `${label} · ${variant.label}`,
          dataUrl: image.toDataURL('image/jpeg', 0.94),
        });
      }
      notes.push(
        `${shot.label} | ${shot.seaState} | wave t=${shot.waveTimeSeconds}s | sun ${measuredSun.toFixed(1)}deg | yaw 140deg pitch 0deg`,
      );
    }

    const sheet = buildContactSheet(frames, {
      columns: 2,
      cellWidth: 640,
      title: 'Ocean cloud-haze A/B — sideways embodied view',
      subtitle: 'A = legacy per-pixel cloud march · B = fixed gas-only haze · frozen pairs',
    });
    if (options.publish !== false) {
      const name = options.name ?? 'ocean-cloud-haze-ab';
      const published = await post(`${name}.png`, await toBlob(sheet, 'image/png'));
      await postText(`${name}.txt`, notes.join('\n'), 'text/plain');
      if (!published) {
        const link = document.createElement('a');
        link.href = sheet.toDataURL('image/png');
        link.download = `${name}.png`;
        link.click();
      }
    }

    return {
      title: 'Ocean cloud-haze A/B',
      condition: 'six frozen seas/lights · sideways embodied view · A legacy / B fixed',
      captures,
    };
  } finally {
    sim.ocean.setCloudsInHazeEnabled(restoreCloudsInHaze);
    sim.sky.cloudDome.setFrozen(restoreCloudCacheFrozen);
    sim.setSeaState(restoreSeaState, 0);
    sim.waves.setTime(restoreWaveTime);
    state.worldInstantUtcSeconds = restoreInstant;
    state.worldSecondsPerRealSecond = restoreRate;
    state.paused = restorePaused;
    sim.refreshLighting();
    sim.clearFoam();
    sim.warmFoam();
    sim.cameras.look = restoreLook;
    sim.cameras.setDiagnosticMode(restoreCameraMode);
    sim.renderer.setPixelRatio(restorePixelRatio);
    sim.renderer.setSize(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1), false);
    sim.cameras.setViewport(Math.max(restoreWidth, 1), Math.max(restoreHeight, 1));
    sim.stepSimulation(0);
    sim.renderFrame();
  }
}
