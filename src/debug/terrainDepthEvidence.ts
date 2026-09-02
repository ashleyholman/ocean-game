import type * as THREE from 'three';
import { findSeaState, PRODUCTION_SEA_STATE } from '../ocean/presets';
import type { GpuProfiler } from '../render/GpuProfiler';
import { summarizeSamples, type SampleSummary } from '../render/OceanProfileProbe';
import type { TerrainSystem } from '../terrain/TerrainSystem';
import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type TerrainDepthEvidenceCapability = SimCapability<
  | 'cameras'
  | 'canvas'
  | 'clearFoam'
  | 'lighting'
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
import {
  getTerrainDrawOrder,
  OCEAN_RENDER_ORDER,
  setTerrainDrawOrder,
} from '../terrain/terrainDrawOrder';
import { grab, post, postText, settleSunElevation, toBlob } from './labCapture';

export interface TerrainDepthEvidenceDeps {
  sim: TerrainDepthEvidenceCapability;
  gpuProfiler: GpuProfiler;
  terrain: TerrainSystem;
  waitPresentedFrames(count: number): Promise<void>;
  nextPresentedFrame(): Promise<void>;
  depth: {
    requested: 'conventional' | 'log' | 'reversed';
    logarithmicActive: boolean;
    reversedActive: boolean;
    clipControl: boolean;
    depthBits: number;
  };
  fixture: {
    id: string;
    rangeKm: number;
    bearingDeg: number;
  };
}

type TimingKey = 'frame' | 'sceneOpaque' | 'terrain' | 'ocean' | 'sceneAndStars';
type Leg = Record<TimingKey, number[]>;

const TIMING_KEYS: readonly TimingKey[] = [
  'frame',
  'sceneOpaque',
  'terrain',
  'ocean',
  'sceneAndStars',
];

const emptyLeg = (): Leg => ({
  frame: [],
  sceneOpaque: [],
  terrain: [],
  ocean: [],
  sceneAndStars: [],
});

const PAIRS = 16;
const ROTATIONS_PER_LEG = 8;
const SWITCH_WARMUP_FRAMES = 12;
const RUNNING_WARMUP_FRAMES = 180;
const FROZEN_WARMUP_FRAMES = 90;

function rendererDevice(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info
    ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
    : 'unknown renderer';
}

/**
 * TERR-111/112/113 paired terrain-occlusion benchmark.
 *
 * The terrain geometry, camera and every shader remain resident in both arms;
 * only `group.visible` changes. Terrain is submitted BEFORE the sea for this
 * experiment so its depth reaches the buffer first. Conventional/reversed
 * depth can consequently reject ocean fragments hidden behind land, while r185
 * logarithmic depth's `gl_FragDepth` path cannot. The paired, alternating arm
 * order keeps thermal/session drift out of that delta.
 *
 * The order used to be forced by writing `renderOrder = -1` onto each mesh
 * here; it now goes through `setTerrainDrawOrder`, which is the same switch the
 * A/B registry and `?terrainOrder=` move — so the profiler's endpoint rotation
 * follows it and the `terrain` bucket stays a terrain bucket. Restored in the
 * `finally` like every other borrowed piece of session state.
 */
export async function runTerrainDepthEvidence(
  deps: TerrainDepthEvidenceDeps,
): Promise<string> {
  const { sim, gpuProfiler, terrain, waitPresentedFrames, nextPresentedFrame } = deps;
  if (!gpuProfiler.reading.supported) {
    throw new Error('This browser/GPU does not expose WebGL timer queries');
  }

  const worldState = sim.world.state;
  const restore = {
    rate: worldState.worldSecondsPerRealSecond,
    paused: worldState.paused,
    instant: worldState.worldInstantUtcSeconds,
    wavesFrozen: sim.waves.frozen,
    cloudFrozen: sim.sky.cloudDome.frozen,
    terrainVisible: terrain.group.visible,
  };
  const restoreDrawOrder = getTerrainDrawOrder();
  setTerrainDrawOrder('before');

  const collectLeg = async (): Promise<Leg> => {
    const samples: Leg = emptyLeg();
    gpuProfiler.start();
    let lastSerial = 0;
    const deadline = performance.now() + 30_000;
    while (samples.frame.length < ROTATIONS_PER_LEG) {
      await nextPresentedFrame();
      for (const sample of gpuProfiler.rawSamples) {
        if (sample.serial <= lastSerial) continue;
        lastSerial = sample.serial;
        for (const key of TIMING_KEYS) {
          // `sceneOpaque` and `terrain` are only present when the profiler was
          // built with the TERR-134 rotation; a zero here would be a claim, so
          // an absent bucket stays absent.
          const value = sample.timing[key];
          if (value !== undefined) samples[key].push(value);
        }
        if (samples.frame.length >= ROTATIONS_PER_LEG) break;
      }
      if (performance.now() > deadline) {
        throw new Error('Timed out waiting for terrain depth GPU samples');
      }
    }
    return samples;
  };

  const median = (leg: Leg, key: TimingKey): number =>
    summarizeSamples(leg[key]).median;

  const offMedians: Leg = emptyLeg();
  const onMedians: Leg = emptyLeg();
  const deltas: Leg = emptyLeg();

  try {
    sim.setSeaState(findSeaState(PRODUCTION_SEA_STATE), 0);
    sim.clearFoam();
    sim.warmFoam();
    settleSunElevation(sim, 90);
    sim.refreshWorldLighting();
    sim.cameras.setDiagnosticMode('cinematic');
    sim.cameras.resetCinematic();
    sim.cameras.cinematic.setAzimuth(
      ((deps.fixture.bearingDeg + 180) * Math.PI) / 180,
    );
    terrain.group.visible = true;

    worldState.paused = false;
    worldState.worldSecondsPerRealSecond = restore.rate;
    await waitPresentedFrames(RUNNING_WARMUP_FRAMES);
    worldState.worldSecondsPerRealSecond = 0;
    worldState.paused = true;
    sim.waves.frozen = true;
    sim.setFoamFrozen(true);
    await waitPresentedFrames(FROZEN_WARMUP_FRAMES);
    sim.sky.cloudDome.setFrozen(true);
    await waitPresentedFrames(FROZEN_WARMUP_FRAMES);

    for (let pair = 0; pair < PAIRS; pair++) {
      const order = pair % 2 === 0 ? [false, true] : [true, false];
      const legs = new Map<boolean, Leg>();
      for (const visible of order) {
        terrain.group.visible = visible;
        await waitPresentedFrames(SWITCH_WARMUP_FRAMES);
        legs.set(visible, await collectLeg());
      }
      const off = legs.get(false);
      const on = legs.get(true);
      if (!off || !on) throw new Error(`Incomplete terrain pair ${pair + 1}`);
      for (const key of TIMING_KEYS) {
        if (off[key].length === 0 || on[key].length === 0) continue;
        const offMedian = median(off, key);
        const onMedian = median(on, key);
        offMedians[key].push(offMedian);
        onMedians[key].push(onMedian);
        deltas[key].push(onMedian - offMedian);
      }
    }

    terrain.group.visible = true;
    sim.renderFrame();
    await post('terrain-on.jpg', await toBlob(grab(sim.canvas)));

    interface DeltaSummary {
      offLegMediansMs: SampleSummary;
      onLegMediansMs: SampleSummary;
      pairedOnMinusOffMs: SampleSummary;
      standardErrorMs: number;
    }
    const summarizeOf = (
      off: number[],
      on: number[],
      delta: number[],
    ): DeltaSummary => {
      const summary = summarizeSamples(delta);
      return {
        offLegMediansMs: summarizeSamples(off),
        onLegMediansMs: summarizeSamples(on),
        pairedOnMinusOffMs: summary,
        standardErrorMs: summary.standardDeviation / Math.sqrt(summary.count),
      };
    };
    const summarizeDelta = (key: TimingKey): DeltaSummary =>
      summarizeOf(offMedians[key], onMedians[key], deltas[key]);
    /** Pairwise sum of two buckets, so a combined figure stays paired. */
    const combine = (leg: Leg, keys: TimingKey[]): number[] => {
      const length = Math.min(...keys.map((key) => leg[key].length));
      return Array.from({ length }, (_, index) =>
        keys.reduce((sum, key) => sum + leg[key][index], 0),
      );
    };
    const result = {
      generatedAtIso: new Date().toISOString(),
      purpose:
        'TERR-111/112/113 paired depth-strategy terrain occlusion GPU comparison',
      revision: document.documentElement.dataset.revision ?? 'runtime build',
      device: rendererDevice(sim.renderer),
      userAgent: navigator.userAgent,
      drawingBuffer: {
        width: sim.canvas.width,
        height: sim.canvas.height,
        pixelRatio: sim.renderer.getPixelRatio(),
      },
      depth: deps.depth,
      fixture: deps.fixture,
      terrain: {
        ...terrain.stats,
        oceanRenderOrder: OCEAN_RENDER_ORDER,
      },
      protocol: {
        pairs: PAIRS,
        rotationsPerLeg: ROTATIONS_PER_LEG,
        // Read, never written down: the rotation grew when TERR-134 split the
        // vessel and terrain out of the ocean bucket.
        framesPerRotation: gpuProfiler.framesPerRotation,
        switchWarmupFrames: SWITCH_WARMUP_FRAMES,
        armOrder: 'alternating off/on then on/off',
        frozen: ['world', 'waves', 'foam history', 'cloud cache'],
      },
      timings: {
        frame: summarizeDelta('frame'),
        // Split for real since TERR-134: with the terrain endpoint in the
        // rotation, `ocean` is the sea alone and `terrain` is the land alone.
        // The combined figure stays because the committed 2026-08-07 evidence
        // is quoted in that form and a decision record should stay checkable.
        vessel: summarizeDelta('sceneOpaque'),
        terrain: summarizeDelta('terrain'),
        ocean: summarizeDelta('ocean'),
        terrainAndOceanPrefix: summarizeOf(
          combine(offMedians, ['terrain', 'ocean']),
          combine(onMedians, ['terrain', 'ocean']),
          combine(deltas, ['terrain', 'ocean']),
        ),
        sceneAndStars: summarizeDelta('sceneAndStars'),
      },
      capture: 'terrain-on.jpg',
    };
    await postText(
      'paired-terrain-cost.json',
      JSON.stringify(result, null, 2),
      'application/json',
    );

    const frame = result.timings.frame.pairedOnMinusOffMs;
    const terrainAndOcean =
      result.timings.terrainAndOceanPrefix.pairedOnMinusOffMs;
    return [
      `terrain depth benchmark complete (${deps.depth.requested})`,
      `frame terrain-on minus off: ${frame.mean.toFixed(3)} ± ${result.timings.frame.standardErrorMs.toFixed(3)} ms`,
      `terrain+ocean prefix on minus off: ${terrainAndOcean.mean.toFixed(3)} ± ${result.timings.terrainAndOceanPrefix.standardErrorMs.toFixed(3)} ms`,
    ].join('\n');
  } finally {
    terrain.group.visible = restore.terrainVisible;
    setTerrainDrawOrder(restoreDrawOrder);
    sim.sky.cloudDome.setFrozen(restore.cloudFrozen);
    sim.waves.frozen = restore.wavesFrozen;
    sim.setFoamFrozen(false);
    worldState.worldInstantUtcSeconds = restore.instant;
    worldState.worldSecondsPerRealSecond = restore.rate;
    worldState.paused = restore.paused;
    sim.refreshLighting();
    sim.refreshWorldLighting();
    sim.cameras.reset();
  }
}
