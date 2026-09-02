import * as THREE from 'three';
import type { GpuDerivedPassTimings, GpuProfiler } from '../render/GpuProfiler';
import {
  summarizeSamples,
  type SampleSummary,
} from '../render/OceanProfileProbe';
import { findSeaState, PRODUCTION_SEA_STATE } from '../ocean/presets';
import { grab, post, postText, settleSunElevation, toBlob } from './labCapture';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type TerrainBaselineEvidenceCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'clearFoam'
  | 'lighting'
  | 'oceanTemporalEnabled'
  | 'refreshLighting'
  | 'refreshWorldLighting'
  | 'renderFrame'
  | 'renderer'
  | 'setFoamFrozen'
  | 'setSeaState'
  | 'sky'
  | 'warmFoam'
  | 'waves'
  | 'world'
>;

/**
 * R0 terrain baseline: the open-water measurements every terrain experiment is
 * compared against (TERR-004) and the camera geometry those experiments build
 * on (TERR-005). See docs/terrain/terrain-project-plan.md §5.
 *
 * Run unattended via `?perf=terrain-baseline&capturePort=...` in headless
 * Chrome with the GPU forced on, with the capture server rooted at
 * `evidence/terrain/baseline`. Each view follows the freeze protocol the
 * whitewater benchmark established: world, waves, foam history and the cloud
 * cache are all held still before a sample is trusted, because absolute
 * numbers taken across a live warm-up trend measure the trend, not the view.
 */

export interface TerrainBaselineDeps {
  sim: TerrainBaselineEvidenceCapability;
  gpuProfiler: GpuProfiler;
  waitPresentedFrames(count: number): Promise<void>;
  nextPresentedFrame(): Promise<void>;
}

interface BaselineView {
  id: string;
  label: string;
  mode: 'embodied' | 'cinematic';
  seaState: string;
  /**
   * Target apparent solar elevation. Elevation and bearing are coupled through
   * real astronomy, so 90° simply lands on the day's maximum — local solar
   * noon — whatever elevation that turns out to be at this latitude and date.
   */
  sunElevationDeg: number;
  /** Explicit distance/altitude; omitted means the opening composition. */
  cinematicView?: { distanceM: number; altitudeM: number };
  embodiedLook?: 'forward' | 'toward-sun';
}

/**
 * The baseline matrix from the project plan. The maximum-high distance and
 * altitude mirror the `maximum high` diagnostic preset in main.ts.
 */
const VIEWS: readonly BaselineView[] = [
  {
    id: 'embodied-forward-production-midday',
    label: 'Embodied forward · production sea · midday',
    mode: 'embodied',
    seaState: PRODUCTION_SEA_STATE,
    sunElevationDeg: 90,
    embodiedLook: 'forward',
  },
  {
    id: 'embodied-toward-low-sun-production',
    label: 'Embodied toward low Sun · production sea',
    mode: 'embodied',
    seaState: PRODUCTION_SEA_STATE,
    sunElevationDeg: 8,
    embodiedLook: 'toward-sun',
  },
  {
    id: 'cinematic-default-production-midday',
    label: 'Default cinematic · production sea · midday',
    mode: 'cinematic',
    seaState: PRODUCTION_SEA_STATE,
    sunElevationDeg: 90,
  },
  {
    id: 'cinematic-default-rough-low-sun',
    label: 'Default cinematic · rough sea · low Sun',
    mode: 'cinematic',
    seaState: 'SOUTHERN_OCEAN_ROUGH',
    sunElevationDeg: 8,
  },
  {
    id: 'cinematic-max-production-midday',
    label: 'Maximum cinematic · production sea · midday',
    mode: 'cinematic',
    seaState: PRODUCTION_SEA_STATE,
    sunElevationDeg: 90,
    cinematicView: { distanceM: 1400, altitudeM: 267 },
  },
  {
    id: 'cinematic-max-rough-low-sun',
    label: 'Maximum cinematic · rough sea · low Sun',
    mode: 'cinematic',
    seaState: 'SOUTHERN_OCEAN_ROUGH',
    sunElevationDeg: 8,
    cinematicView: { distanceM: 1400, altitudeM: 267 },
  },
];

/** Presented frames with the world running: sea, wake and lighting settle. */
const WARMUP_RUNNING_FRAMES = 180;
/** Presented frames after each stage of the freeze before samples count. */
const WARMUP_FROZEN_FRAMES = 90;
/** Six-frame prefix rotations discarded after the profiler restarts. */
const DISCARDED_ROTATIONS = 2;
/** Rotations kept per view. */
const KEPT_ROTATIONS = 24;

const EARTH_RADIUS_M = 6_371_000;
/**
 * The detailed ocean disc radius. Ocean.ts keeps OUTER_RADIUS private; the
 * value is recorded here as evidence, and a mismatch would be caught by the
 * shader-source test the moment the disc changed.
 */
const OCEAN_DISC_RADIUS_M = 20_000;

/**
 * The buckets this harness summarises.
 *
 * `sceneOpaque` and `terrain` arrive with TERR-134 and are optional: a
 * profiler constructed with the pre-terrain rotation never produces them, and
 * a baseline run with `?terrain=off` produces a terrain figure of about zero.
 * Anything absent is dropped rather than summarised as a column of undefined —
 * see `summarizePass`.
 */
const GPU_PASSES = [
  'frame',
  'foamSimulation',
  'cloudCacheBake',
  'skyAndCloudDraw',
  'sceneOpaque',
  'terrain',
  'ocean',
  'sceneAndStars',
] as const;

function wrapPi(angle: number): number {
  let x = (angle + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

function azimuthRad(direction: THREE.Vector3): number {
  return Math.atan2(direction.x, direction.z);
}

function rendererDevice(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info
    ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : 'unknown renderer';
}

/**
 * Aim the embodied camera at the sun's bearing without assuming the look-yaw
 * convention. Two probe yaws recover the controller's zero and sign
 * empirically, which survives any future re-parenting of the embodied rig.
 */
async function aimEmbodiedAtSun(deps: TerrainBaselineDeps): Promise<void> {
  const { sim, nextPresentedFrame } = deps;
  const forward = new THREE.Vector3();
  const forwardAzimuth = async (yaw: number): Promise<number> => {
    sim.cameras.look = { yaw, pitch: 0 };
    await nextPresentedFrame();
    sim.cameras.camera.getWorldDirection(forward);
    return azimuthRad(forward);
  };
  const a0 = await forwardAzimuth(0);
  const a1 = await forwardAzimuth(0.5);
  const slope = wrapPi(a1 - a0) / 0.5;
  if (Math.abs(slope) < 0.5) {
    throw new Error(`Embodied yaw calibration failed: slope ${slope}`);
  }
  const sunAzimuth = azimuthRad(sim.lighting.sunDirection);
  sim.cameras.look = { yaw: wrapPi(sunAzimuth - a0) / slope, pitch: 0 };
  await nextPresentedFrame();
}

interface RotationCollection {
  rotations: GpuDerivedPassTimings[];
  presentedDeltasMs: number[];
}

async function collectRotations(
  deps: TerrainBaselineDeps,
): Promise<RotationCollection> {
  const { gpuProfiler, nextPresentedFrame } = deps;
  gpuProfiler.start();
  const rotations: GpuDerivedPassTimings[] = [];
  const presentedDeltasMs: number[] = [];
  let lastSerial = 0;
  let seen = 0;
  let lastStamp = performance.now();
  const deadline = performance.now() + 45_000;
  while (rotations.length < KEPT_ROTATIONS) {
    await nextPresentedFrame();
    const now = performance.now();
    presentedDeltasMs.push(now - lastStamp);
    lastStamp = now;
    for (const sample of gpuProfiler.rawSamples) {
      if (sample.serial <= lastSerial) continue;
      lastSerial = sample.serial;
      seen += 1;
      if (seen <= DISCARDED_ROTATIONS) continue;
      rotations.push({ ...sample.timing });
      if (rotations.length >= KEPT_ROTATIONS) break;
    }
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for GPU rotations');
    }
  }
  return { rotations, presentedDeltasMs };
}

export async function runTerrainBaselineEvidence(
  deps: TerrainBaselineDeps,
): Promise<string> {
  const { sim, gpuProfiler, waitPresentedFrames } = deps;
  if (!gpuProfiler.reading.supported) {
    throw new Error('This browser/GPU does not expose WebGL timer queries');
  }

  const worldState = sim.world.state;
  const restore = {
    rate: worldState.worldSecondsPerRealSecond,
    paused: worldState.paused,
    instant: worldState.worldInstantUtcSeconds,
  };

  const performanceViews: Record<string, unknown>[] = [];
  const geometryViews: Record<string, unknown>[] = [];
  const cameraWorldPosition = new THREE.Vector3();

  try {
    for (const view of VIEWS) {
      // --- conditions -----------------------------------------------------
      sim.setSeaState(findSeaState(view.seaState), 0);
      sim.clearFoam();
      sim.warmFoam();
      const sunElevationDeg = settleSunElevation(sim, view.sunElevationDeg);
      sim.refreshWorldLighting();

      sim.cameras.setDiagnosticMode(view.mode);
      if (view.mode === 'cinematic') {
        sim.cameras.resetCinematic();
        if (view.cinematicView) {
          sim.cameras.setDiagnosticView(
            view.cinematicView.distanceM,
            view.cinematicView.altitudeM,
          );
        }
      } else {
        sim.cameras.resetEmbodiedLook();
        if (view.embodiedLook === 'toward-sun') await aimEmbodiedAtSun(deps);
      }

      // --- warm, then freeze in stages ------------------------------------
      worldState.paused = false;
      worldState.worldSecondsPerRealSecond = restore.rate;
      await waitPresentedFrames(WARMUP_RUNNING_FRAMES);
      worldState.worldSecondsPerRealSecond = 0;
      worldState.paused = true;
      sim.waves.frozen = true;
      sim.setFoamFrozen(true);
      await waitPresentedFrames(WARMUP_FROZEN_FRAMES);
      sim.sky.cloudDome.setFrozen(true);
      await waitPresentedFrames(WARMUP_FROZEN_FRAMES);

      // --- measure ---------------------------------------------------------
      const { rotations, presentedDeltasMs } = await collectRotations(deps);
      const gpuMs: Record<string, SampleSummary> = {};
      for (const pass of GPU_PASSES) {
        const samples = rotations
          .map((rotation) => rotation[pass])
          .filter((value): value is number => value !== undefined);
        if (samples.length === 0) continue;
        gpuMs[pass] = summarizeSamples(samples);
      }

      // --- still -----------------------------------------------------------
      // Render and copy in one task; the drawing buffer is not preserved
      // across the compositor, so the grab has to happen before yielding.
      sim.renderFrame();
      const still = grab(sim.canvas);
      await post(`captures/${view.id}.jpg`, await toBlob(still));

      // --- geometry --------------------------------------------------------
      const camera = sim.cameras.camera;
      camera.getWorldPosition(cameraWorldPosition);
      const heightM = cameraWorldPosition.y;
      const sun = sim.lighting.sunDirection;
      const geometry = {
        id: view.id,
        label: view.label,
        mode: view.mode,
        nearPlaneM: camera.near,
        farPlaneM: camera.far,
        verticalFovDeg: camera.fov,
        aspect: camera.aspect,
        /** Render-frame height; mean sea level sits at y = 0 near the origin. */
        cameraHeightAboveMeanSeaM: heightM,
        /** Spherical-Earth horizon for this height — what curvature will show. */
        geometricHorizonM: Math.sqrt(
          2 * EARTH_RADIUS_M * Math.max(heightM, 0) + heightM * heightM,
        ),
        /** Where sea actually ends today: the flat disc's rim. */
        oceanDiscRadiusM: OCEAN_DISC_RADIUS_M,
        seaSurfaceModel: 'flat vessel-centred tangent disc',
        drawingBuffer: {
          width: sim.canvas.width,
          height: sim.canvas.height,
          pixelRatio: sim.renderer.getPixelRatio(),
        },
      };
      geometryViews.push(geometry);

      performanceViews.push({
        id: view.id,
        label: view.label,
        seaState: view.seaState,
        sun: {
          targetElevationDeg: view.sunElevationDeg,
          achievedElevationDeg: sunElevationDeg,
          azimuthDeg: (azimuthRad(sun) * 180) / Math.PI,
          worldInstantUtcSeconds: worldState.worldInstantUtcSeconds,
        },
        gpuMs,
        presentedFrameMs: summarizeSamples(presentedDeltasMs),
        rotationsKept: KEPT_ROTATIONS,
        capture: `captures/${view.id}.jpg`,
      });

      // --- unfreeze for the next view --------------------------------------
      sim.sky.cloudDome.setFrozen(false);
      sim.waves.frozen = false;
      sim.setFoamFrozen(false);
      worldState.worldSecondsPerRealSecond = restore.rate;
      worldState.paused = false;
    }
  } finally {
    sim.sky.cloudDome.setFrozen(false);
    sim.waves.frozen = false;
    sim.setFoamFrozen(false);
    worldState.worldInstantUtcSeconds = restore.instant;
    worldState.worldSecondsPerRealSecond = restore.rate;
    worldState.paused = restore.paused;
    sim.refreshLighting();
    sim.refreshWorldLighting();
    sim.cameras.reset();
  }

  const common = {
    generatedAtIso: new Date().toISOString(),
    purpose:
      'R0 terrain baseline: TERR-004 open-water performance and TERR-005 camera geometry',
    device: rendererDevice(sim.renderer),
    userAgent: navigator.userAgent,
    oceanTemporalEnabled: sim.oceanTemporalEnabled(),
    notes: [
      'World, waves, foam history and cloud cache frozen during sampling.',
      'GPU times are six-frame prefix-rotation derivations (see GpuProfiler).',
      'Machine may be contended; medians with spread, not tight bounds.',
    ],
  };

  await postText(
    'performance.json',
    JSON.stringify({ ...common, views: performanceViews }, null, 2),
    'application/json',
  );
  await postText(
    'camera-geometry.json',
    JSON.stringify({ ...common, views: geometryViews }, null, 2),
    'application/json',
  );

  const lines = performanceViews.map((entry) => {
    const gpu = entry.gpuMs as Record<string, SampleSummary>;
    return `${entry.id}: frame ${gpu.frame.median.toFixed(2)} ms · ocean ${gpu.ocean.median.toFixed(2)} ms`;
  });
  return ['terrain baseline complete', ...lines].join('\n');
}
