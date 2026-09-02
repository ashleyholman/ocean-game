import { findSeaState } from '../../ocean/presets';
import type { DeckWalker } from '../../player/DeckWalker';
import type { GpuProfiler } from '../../render/GpuProfiler';
import type { InteriorCutoutMode } from '../../scene/Ocean';
import type { SyntheticTerrainHandle } from '../../terrain/syntheticTerrainHarness';
import type { Schooner } from '../../vessel/schooner/Schooner';
import type { RuntimeDepthMode } from '../RuntimeOptions';
import type { SimHandle } from './SimHandle';

type ProgressReporter = (report: string) => void;
type ReportBenchmark = (onProgress: ProgressReporter) => Promise<string>;

// Retain the active viewer for the lifetime of this host module, matching the
// entry module's former ownership without loading its implementation eagerly.
let schoonerViewer:
  | import('../../debug/SchoonerViewer').SchoonerViewerHandle
  | undefined;

export interface PairedToggleBenchmarkSubject {
  title: string;
  apply(on: boolean): void;
  read(): boolean;
}

interface PresentedFrameDependencies {
  waitPresentedFrames(count: number): Promise<void>;
  nextPresentedFrame(): Promise<void>;
}

/**
 * Runtime capabilities used by URL-launched, unattended performance runs.
 *
 * The benchmark implementations stay with the simulation state they measure;
 * this host only owns URL dispatch and evidence publication.
 */
export interface PerformanceEvidenceHostDependencies {
  params: URLSearchParams;
  sim: SimHandle;
  schooner?: Schooner;
  deckWalker?: DeckWalker;
  cabinSoleY: number;
  setInteriorCutoutMode(mode: InteriorCutoutMode): void;
  waitPresentedFrames(count: number): Promise<void>;
  runWhitewaterCostBenchmark: ReportBenchmark;
  runPairedToggleBenchmark(
    subject: PairedToggleBenchmarkSubject,
    onProgress: ProgressReporter,
  ): Promise<string>;
  runWakeTrailCostBenchmark: ReportBenchmark;
  runWakeBowCostBenchmark: ReportBenchmark;
  runDirectShadowBenchmark: ReportBenchmark;
}

/**
 * Start every non-terrain unattended performance host selected by the URL.
 * Independent conditions deliberately mirror the original entry-module
 * dispatch: only the matching asynchronous branch is launched.
 */
export function startPerformanceEvidenceHosts(
  dependencies: PerformanceEvidenceHostDependencies,
): void {
  const {
    params,
    sim,
    schooner,
    deckWalker,
    cabinSoleY,
    setInteriorCutoutMode,
    waitPresentedFrames,
    runWhitewaterCostBenchmark,
    runPairedToggleBenchmark,
    runWakeTrailCostBenchmark,
    runWakeBowCostBenchmark,
    runDirectShadowBenchmark,
  } = dependencies;
  const { canvas, cameras, ocean, renderer, vessel } = sim;
  const DEG_TO_RAD = Math.PI / 180;

  /**
   * Unattended whitewater cost run.
   *
   * `?perf=whitewater` sets the conditions, runs the A-B-B-A bracket and POSTs the
   * table to the capture server. It exists because the measurement needs a browser
   * that is actually presenting frames: GPU timer queries are retired by the
   * compositor, so a hidden or headless-software tab collects nothing at all,
   * which is a much worse failure than a wrong number because it looks like a
   * hang. Driving a real Chrome window at this URL is the whole harness.
   */
  if (params.get('perf') === 'whitewater') {
    void (async () => {
      const { findSeaState } = await import('../../ocean/presets');
      const { post } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        sim.setSeaState(findSeaState(params.get('sea') ?? 'SOUTHERN_OCEAN_ROUGH'), 0);
        // The gain scales how much of the frame takes the foam shading branch, so
        // the cost and the look decision are the same decision. Sweeping it here
        // is how the ladder's rungs get a price as well as a picture.
        const gain = Number(params.get('gain'));
        if (Number.isFinite(gain) && gain > 0) ocean.setFoamCoverageGain(gain);
        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(34, 11);
        sim.clearFoam();
        sim.warmFoam();
        // Let the cloud cache finish its first generation. Its bake is the
        // largest thing on the GPU besides the ocean, and measuring across a
        // warm-up would attribute it to whichever variant went first.
        await waitPresentedFrames(180);
        lines.push(await runWhitewaterCostBenchmark(() => undefined));
      } catch (error) {
        lines.push(`whitewater cost failed: ${String(error)}`);
      }
      const text = lines.join('\n');
      console.info(text);
      await post(
        `whitewater-cost-gain-${params.get('gain') ?? 'default'}.txt`,
        new Blob([text], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  if (params.get('perf') === 'vessel-ao' || params.get('perf') === 'soft-shadow') {
    void (async () => {
      const { post, settleSunElevation } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        sim.setSeaState(findSeaState('SOUTHERN_OCEAN_ROUGH'), 0);
        // Mid-afternoon and close aboard: the framing where the hull fills the
        // most screen-space water, which is the worst case for a term whose cost
        // is per water pixel. A distant vista would price it at nearly nothing
        // and say nothing about the shot anybody actually looks at.
        settleSunElevation(sim, 38);
        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(30, 16);
        await waitPresentedFrames(180);
        lines.push(
          await runPairedToggleBenchmark(
            params.get('perf') === 'soft-shadow'
              ? {
                  title: 'variable-penumbra soft shadow cost (12 taps vs three\'s 5)',
                  apply: (on) => ocean.setSunSoftShadow(on),
                  read: () => ocean.sunSoftShadowEnabled,
                }
              : {
                  title: 'hull sky-occlusion (AO) cost',
                  apply: (on) => ocean.setVesselSkyOcclusion(on),
                  read: () => ocean.vesselSkyOcclusionEnabled,
                },
            () => undefined,
          ),
        );
      } catch (error) {
        lines.push(`${params.get('perf')} cost failed: ${String(error)}`);
      }
      const report = lines.join('\n');
      console.info(report);
      const dprTag = renderer.getPixelRatio().toFixed(2).replace('.', 'p');
      await post(
        `${params.get('perf')}-cost-dpr-${dprTag}.txt`,
        new Blob([report], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  /**
   * The shipping world-volume cutout against the fallback stencil, in the two framings
   * requested by OCEAN_INTERIOR_CUTOUT_HANDOVER.md. `on` is the shader volume;
   * `off` is the stencil, and each switch selects a separately compiled pipeline.
   */
  if (params.get('perf') === 'interior-cutout') {
    void (async () => {
      const { post, settleSunElevation } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        if (!schooner || !deckWalker) {
          throw new Error('Interior-cutout benchmark requires the schooner');
        }
        sim.setSeaState(findSeaState('SOUTHERN_OCEAN_ROUGH'), 0);
        settleSunElevation(sim, 38);
        const subject = {
          title: 'interior cutout: shader volume test vs stencil',
          apply: (on: boolean) =>
            setInteriorCutoutMode(on ? 'shader' : 'stencil'),
          read: () => ocean.interiorCutoutMode === 'shader',
        };

        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(30, 16);
        await waitPresentedFrames(180);
        lines.push(
          'FRAMING: close exterior · Southern rough · sun 38° · camera (30, 16)',
          await runPairedToggleBenchmark(subject, () => undefined),
        );

        if (!deckWalker.placeAt(0, -5.9, cabinSoleY)) {
          throw new Error('Could not place the benchmark camera in the cabin');
        }
        cameras.setDiagnosticMode('embodied');
        cameras.look = { yaw: Math.PI, pitch: (-24 * Math.PI) / 180 };
        await waitPresentedFrames(180);
        lines.push(
          '',
          'FRAMING: cabin interior · Southern rough · sun 38° · eye at (0, -5.9)',
          await runPairedToggleBenchmark(subject, () => undefined),
        );
      } catch (error) {
        lines.push(`interior-cutout cost failed: ${String(error)}`);
      }
      const report = lines.join('\n');
      console.info(report);
      const dprTag = renderer.getPixelRatio().toFixed(2).replace('.', 'p');
      await post(
        `interior-cutout-cost-dpr-${dprTag}.txt`,
        new Blob([report], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  /**
   * Unattended WK1 trail bracket for the documented GPU-enabled headless Chrome
   * lane. The reference leg is the committed moderate polar reach; a real trail
   * is built before the paired measurement so the ocean arm prices the intended
   * B-channel footprint rather than a freshly cleared field.
   */
  if (params.get('perf') === 'wake-trail') {
    void (async () => {
      const { post, settleSunElevation } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        const sea = findSeaState('CURRENT_MODERATE');
        const heading = sim.wakeDiagnosticMotionState().trueHeadingRad;
        sim.setWakeDiagnosticTow(3.592773, heading, 1.015625 * DEG_TO_RAD);
        sim.setWakeEffectsEnabled(true);
        sim.setWakeTrailFeatureEnabled('injection', true);
        sim.setWakeTrailFeatureEnabled('bubbleHaze', true);
        sim.setWakeTrailFeatureEnabled('whitecapSuppression', true);
        sim.resetSimulation(sea, 0, 0);
        settleSunElevation(sim, 34);
        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(52, 17);
        cameras.cinematic.setAzimuth(-vessel.group.rotation.y - 0.48);
        for (let frameIndex = 0; frameIndex < 28 * 60; frameIndex++) {
          sim.stepSimulation(1 / 60);
        }
        sim.refreshWorldLighting();
        await waitPresentedFrames(180);
        lines.push(await runWakeTrailCostBenchmark(() => undefined));
      } catch (error) {
        lines.push(`wake trail cost failed: ${String(error)}`);
      }
      const report = lines.join('\n');
      console.info(report);
      await post(
        `wake-trail-cost-${canvas.width}x${canvas.height}.txt`,
        new Blob([report], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  /** Unattended WK2 incremental bracket on the documented moderate reference. */
  if (params.get('perf') === 'wake-bow') {
    void (async () => {
      const { post, settleSunElevation } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        const sea = findSeaState('CURRENT_MODERATE');
        const heading = sim.wakeDiagnosticMotionState().trueHeadingRad;
        sim.setWakeDiagnosticTow(3.592773, heading, 1.015625 * DEG_TO_RAD);
        sim.setWakeEffectsEnabled(true);
        sim.setWakeTrailFeatureEnabled('injection', true);
        sim.setWakeTrailFeatureEnabled('bubbleHaze', true);
        sim.setWakeTrailFeatureEnabled('whitecapSuppression', true);
        sim.setWakeBowFeatureEnabled('collar', true);
        sim.setWakeBowFeatureEnabled('wetHull', true);
        sim.setWakeBowFeatureEnabled('bowMound', true);
        sim.resetSimulation(sea, 0, 0);
        settleSunElevation(sim, 34);
        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(34, 11);
        cameras.cinematic.setAzimuth(
          -vessel.group.rotation.y + Math.PI - 0.52,
        );
        for (let frameIndex = 0; frameIndex < 18 * 60; frameIndex++) {
          sim.stepSimulation(1 / 60);
        }
        sim.refreshWorldLighting();
        await waitPresentedFrames(180);
        lines.push(await runWakeBowCostBenchmark(() => undefined));
      } catch (error) {
        lines.push(`wake WK2 cost failed: ${String(error)}`);
      }
      const report = lines.join('\n');
      console.info(report);
      await post(
        `wake-bow-cost-${canvas.width}x${canvas.height}.txt`,
        new Blob([report], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  if (params.get('perf') === 'direct-shadows') {
    void (async () => {
      const { post } = await import('../../debug/labCapture');
      const { settleSunElevation } = await import('../../debug/labCapture');
      const lines: string[] = [];
      try {
        sim.setSeaState(findSeaState('SOUTHERN_OCEAN_ROUGH'), 0);
        settleSunElevation(sim, 8);
        cameras.setDiagnosticMode('cinematic');
        cameras.setDiagnosticView(34, 9);
        vessel.lamp.mode = 'on';
        // Warm the lamp ramp, cloud cache and every initial shader before the
        // A-B-C bracket. The benchmark itself freezes all presentation state.
        await waitPresentedFrames(180);
        lines.push(await runDirectShadowBenchmark(() => undefined));
      } catch (error) {
        lines.push(`direct shadow cost failed: ${String(error)}`);
      }
      const report = lines.join('\n');
      console.info(report);
      const dprTag = renderer.getPixelRatio().toFixed(2).replace('.', 'p');
      await post(
        `direct-light-shadow-cost-dpr-${dprTag}.txt`,
        new Blob([report], { type: 'text/plain' }),
      );
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }
}

export interface TerrainAndViewerEvidenceHostDependencies
  extends PresentedFrameDependencies {
  params: URLSearchParams;
  sim: SimHandle;
  gpuProfiler: GpuProfiler;
  requestedDepthMode: RuntimeDepthMode;
  terrainHandlePromise?: Promise<SyntheticTerrainHandle | undefined>;
  schoonerViewerEnabled: boolean;
  schooner?: Schooner;
}

/**
 * Start terrain evidence and the schooner viewer after the synthetic terrain
 * mount has been dispatched. Keeping this as a second phase preserves the
 * original ordering of URL-host dynamic imports around that mount.
 */
export function startTerrainAndViewerEvidenceHosts(
  dependencies: TerrainAndViewerEvidenceHostDependencies,
): void {
  const {
    params,
    sim,
    gpuProfiler,
    requestedDepthMode,
    terrainHandlePromise,
    schoonerViewerEnabled,
    schooner,
    waitPresentedFrames,
    nextPresentedFrame,
  } = dependencies;
  const { renderer } = sim;

  /**
   * TERR-111/112/113 quiet-GPU evidence. Requires the synthetic fixture URL and
   * pairs the same resident terrain scene hidden/visible so session drift is not
   * charged to the depth strategy.
   */
  if (params.get('perf') === 'terrain-depth') {
    void (async () => {
      const { post } = await import('../../debug/labCapture');
      try {
        const handle = await terrainHandlePromise;
        if (!handle) {
          throw new Error('?perf=terrain-depth requires ?terrain=synthetic');
        }
        const gl = renderer.getContext();
        const { runTerrainDepthEvidence } = await import(
          '../../debug/terrainDepthEvidence'
        );
        const report = await runTerrainDepthEvidence({
          sim,
          gpuProfiler,
          terrain: handle.system,
          waitPresentedFrames,
          nextPresentedFrame,
          depth: {
            requested: requestedDepthMode,
            logarithmicActive: renderer.capabilities.logarithmicDepthBuffer,
            reversedActive: renderer.capabilities.reversedDepthBuffer,
            clipControl: gl.getExtension('EXT_clip_control') !== null,
            depthBits: gl.getParameter(gl.DEPTH_BITS) as number,
          },
          fixture: {
            id: handle.fixtureId,
            rangeKm: Number(params.get('range') ?? 8),
            bearingDeg: Number(params.get('bearing') ?? 0),
          },
        });
        console.info(report);
      } catch (error) {
        console.error(error);
        await post(
          'terrain-depth-FAILED.txt',
          new Blob([String(error)], { type: 'text/plain' }),
        );
      }
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  /**
   * R0 terrain baseline (TERR-004/TERR-005). Unattended: sets each baseline-
   * matrix view, freezes the world, samples the GPU passes and POSTs JSON plus
   * stills to the capture server. See src/debug/terrainBaselineEvidence.ts.
   */
  if (params.get('perf') === 'terrain-baseline') {
    void (async () => {
      const { post } = await import('../../debug/labCapture');
      try {
        const { runTerrainBaselineEvidence } = await import(
          '../../debug/terrainBaselineEvidence'
        );
        const report = await runTerrainBaselineEvidence({
          sim,
          gpuProfiler,
          waitPresentedFrames,
          nextPresentedFrame,
        });
        console.info(report);
      } catch (error) {
        console.error(error);
        await post(
          'terrain-baseline-FAILED.txt',
          new Blob([String(error)], { type: 'text/plain' }),
        );
      }
      (window as unknown as Record<string, unknown>).__perfDone = true;
    })();
  }

  if (schoonerViewerEnabled) {
    // Code-split alongside the labs: none of the ship reaches the production
    // entry chunk, and it cannot run without the query parameter.
    void import('../../debug/SchoonerViewer').then(async ({ startSchoonerViewer }) => {
      if (!schooner) throw new Error('the schooner viewer requires the schooner vessel');
      schoonerViewer = startSchoonerViewer(sim, schooner);
      if (params.get('sheet') === '1') {
        // Give the cloud cache a moment to warm before the first frame is taken,
        // or the sheet records the warm-up rather than the ship.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await schoonerViewer.contactSheet();
      }
      if (params.get('occlusionEvidence') === '1') {
        // Warm shader programs and the cloud cache before freezing the evidence
        // scenes. The harness itself takes every A/B synchronously.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const sheet = await schoonerViewer.occlusionEvidence();
        sheet.style.cssText =
          'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#0b0f14;z-index:10000';
        sheet.setAttribute('aria-label', 'Direct-light geometry shadow A/B evidence');
        document.body.appendChild(sheet);
        (window as unknown as Record<string, unknown>).__occlusionEvidenceDone = true;
      }
      const sealAuditParam = params.get('sealAudit');
      if (sealAuditParam) {
        // Use the same real meshes in a deliberately plain inspection render. The
        // returned sheet is also mounted full-screen so browser QA can capture it
        // without reaching into application internals.
        const preset =
          sealAuditParam === 'keel-bow-closeup' || sealAuditParam === 'underside-quarters'
            ? sealAuditParam
            : 'standard';
        const sheet = await schoonerViewer.sealAudit({
          name: params.get('auditName') ?? 'hull-seal-audit',
          preset,
          publishFrames: preset !== 'standard',
        });
        sheet.style.cssText =
          'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#0b0f14;z-index:10000';
        sheet.setAttribute('aria-label', 'Hull seal audit contact sheet');
        document.body.appendChild(sheet);
        (window as unknown as Record<string, unknown>).__hullSealAuditDone = true;
      }
    });
  }
}
