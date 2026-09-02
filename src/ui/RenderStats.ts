/**
 * Frame cadence, render scale, main-thread work and the major GPU passes in a
 * persistent, collapsible corner readout.
 *
 * This exists because a rendering defect turned out to be invisible in the code
 * and obvious in the pixels: the adaptive resolution walk drops the framebuffer
 * below the panel's native pixel grid after any slow patch, and everything
 * downstream — the ocean's specular detail above all — aliases harder at the
 * lower sample rate. From the outside that reads as "it was fine when I started
 * and it went bad later", with nothing on screen to say why.
 *
 * So the scale is not a number buried in a diagnostic panel. It is a chip in the
 * corner that goes amber the moment the renderer stops drawing at native
 * resolution, and says by how much.
 *
 * `renderScale` is `renderer.getPixelRatio()`: backing-store pixels per CSS
 * pixel. `nativeScale` is `window.devicePixelRatio`: what the panel actually
 * has. Equal is a 1:1 image. Below it, the compositor is upscaling — usually by
 * a non-integer factor, which resamples every pixel of an already under-sampled
 * surface.
 */

import type { CpuProfilerReading } from '../render/CpuProfiler';
import type { GpuProfilerReading } from '../render/GpuProfiler';
import type {
  OceanDetailRepresentation,
  OceanResidualLoopMode,
} from '../scene/Ocean';
import type { DetailGradientTextureStyle } from '../ocean/detailGradientTexture';

export interface RenderStatsReading {
  /** False while cache bootstrap and renderer settling are intentionally omitted. */
  profilingReady: boolean;
  /** Frames per second over the recent visible wall-cadence window. */
  fps?: number;
  /** Mean interval over that same window, exactly reciprocal to `fps`. */
  frameMs?: number;
  /** Backing-store pixels per CSS pixel — `renderer.getPixelRatio()`. */
  renderScale: number;
  /** The display's own pixels per CSS pixel — `window.devicePixelRatio`. */
  nativeScale: number;
  /** Drawing-buffer size, pixels. */
  bufferWidth: number;
  bufferHeight: number;
  /** Smoothed wall-time spans inside the main-thread frame callback. */
  cpu: CpuProfilerReading;
  /** Asynchronous GPU pass timings, when the browser exposes timer queries. */
  gpu: GpuProfilerReading;
  /** Compile-time workload inside the monolithic ocean fragment shader. */
  oceanAtmosphereEvaluations: number;
  skyRadianceLutWidth: number;
  skyRadianceLutHeight: number;
  skyRadianceLutEnabled: boolean;
  oceanVertexSlots: number;
  oceanResidualSlots: number;
  oceanResidualActiveSlots: number;
  oceanResidualLoopMode: OceanResidualLoopMode;
  oceanResidualPhaseEnabled: boolean;
  oceanDetailOctaves: number;
  oceanDetailRepresentation: OceanDetailRepresentation;
  oceanDetailTextureStyle: DetailGradientTextureStyle;
  oceanFoamEnabled: boolean;
  oceanFlatFragment: boolean;
  /** Compile-time work in the cloud cache bake and live dome draw. */
  cloudViewSteps: number;
  cloudSunSteps: number;
  cloudAdvectionMappings: number;
  cloudPageTableFetches: number;
  cloudCacheFetches: number;
  cloudVisibleTiles: number;
  cloudGuardTiles: number;
  cloudResidentTiles: number;
  cloudSlotCapacity: number;
  cloudUnmappedGuardTiles: number;
  cloudUnmappedVisibleTiles: number;
  cloudCacheBytes: number;
  cloudFullCacheBytes: number;
  cloudAtlasWidth: number;
  cloudAtlasHeight: number;
  cloudBakedTiles: number;
  cloudRebaseTiles: number;
  cloudOnDemandTiles: number;
  cloudStagingTiles: number;
  cloudCatchUpTiles: number;
  cloudSteadyBudget: number;
  cloudSwapped: boolean;
}

/** Amber: the renderer is not drawing at the panel's own resolution. */
const REDUCED = '#e8a54b';
/** Green: one framebuffer pixel per display pixel. */
const NATIVE = '#7fd0a0';

const STYLE = `
.render-stats {
  position: fixed; right: 12px; bottom: 48px; z-index: 60;
  width: 228px;
  padding: 8px 11px 9px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-left: 3px solid ${NATIVE};
  background: rgba(8, 14, 22, 0.62);
  color: #b9cede;
  font: 500 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.05em;
  backdrop-filter: blur(7px);
  pointer-events: none;
  transition: border-color 200ms ease, background 200ms ease;
}
.render-stats[hidden] { display: none; }
.render-stats-close {
  position: absolute; top: 5px; right: 5px;
  display: grid; place-items: center; width: 25px; height: 25px; padding: 0;
  border: 1px solid transparent; border-radius: 5px;
  background: transparent; color: #91a6b8; cursor: pointer;
  font: 400 18px/1 ui-sans-serif, system-ui, sans-serif;
  pointer-events: auto;
}
.render-stats-close:hover,
.render-stats-close:focus-visible {
  background: rgba(255, 255, 255, 0.08); color: #edf5fb;
  border-color: rgba(255, 255, 255, 0.10);
}
.render-stats .fps {
  padding-right: 22px;
  font-size: 15px; letter-spacing: 0.02em; color: #e6f0f8;
  font-variant-numeric: tabular-nums;
}
.render-stats .fps small {
  font-size: 10px; color: #7e93a7; margin-left: 6px; letter-spacing: 0.06em;
}
.render-stats .buffer { color: #8fb7d8; font-variant-numeric: tabular-nums; }
.render-stats .cpu,
.render-stats .gpu {
  margin-top: 6px; padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.10);
  color: #9eb2c3;
  white-space: pre;
  font-variant-numeric: tabular-nums;
  line-height: 1.55;
}
.render-stats .gpu { margin-top: 4px; }
.render-stats .cpu strong,
.render-stats .gpu strong { color: #dbe8f2; font-weight: 600; }
.render-stats .work {
  margin-top: 4px; color: #71879a; letter-spacing: 0.025em;
  white-space: pre-line; line-height: 1.35;
}
.render-stats .state {
  margin-top: 3px; text-transform: uppercase; font-weight: 600;
  font-size: 10px; letter-spacing: 0.11em; color: ${NATIVE};
}
.render-stats.is-reduced {
  border-left-color: ${REDUCED};
  background: rgba(40, 26, 8, 0.66);
}
.render-stats.is-reduced .state { color: ${REDUCED}; }
.render-stats-toggle {
  position: fixed; right: 12px; bottom: 12px; z-index: 61;
  min-width: 58px; height: 28px; padding: 0 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(8, 14, 22, 0.72);
  color: #b9cede;
  font: 600 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.08em; text-transform: uppercase;
  backdrop-filter: blur(7px);
  cursor: pointer;
}
.render-stats-toggle:hover,
.render-stats-toggle:focus-visible {
  background: rgba(18, 30, 44, 0.92);
  color: #e6f0f8;
}
.render-stats-toggle[hidden] { display: none; }
`;

export class RenderStats {
  readonly element: HTMLDivElement;

  private readonly toggleButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly fpsLine: HTMLDivElement;
  private readonly bufferLine: HTMLDivElement;
  private readonly cpuLine: HTMLDivElement;
  private readonly gpuLine: HTMLDivElement;
  private readonly workLine: HTMLDivElement;
  private readonly stateLine: HTMLDivElement;
  private sinceRefresh = 0;
  private lastSignature = '';
  /** Peak/edge events are latched until the 4 Hz DOM refresh can show them. */
  private cloudBakedPeak = 0;
  private cloudRebasePeak = 0;
  private cloudOnDemandPeak = 0;
  private cloudStagingPeak = 0;
  private cloudCatchUpPeak = 0;
  private cloudBudgetPeak = 0;
  private cloudSwapSeen = false;
  private chromeVisible = true;
  private collapsed = true;

  constructor() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.element = document.createElement('div');
    this.element.className = 'render-stats';

    this.fpsLine = document.createElement('div');
    this.fpsLine.className = 'fps';
    this.bufferLine = document.createElement('div');
    this.bufferLine.className = 'buffer';
    this.cpuLine = document.createElement('div');
    this.cpuLine.className = 'cpu';
    this.gpuLine = document.createElement('div');
    this.gpuLine.className = 'gpu';
    this.workLine = document.createElement('div');
    this.workLine.className = 'work';
    this.stateLine = document.createElement('div');
    this.stateLine.className = 'state';

    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'render-stats-close';
    this.closeButton.textContent = '×';
    this.closeButton.title = 'Hide performance panel';
    this.closeButton.setAttribute('aria-label', 'Hide performance panel');
    this.closeButton.addEventListener('click', () => {
      this.collapsed = true;
      this.syncVisibility();
    });

    this.element.append(
      this.closeButton,
      this.fpsLine,
      this.bufferLine,
      this.cpuLine,
      this.gpuLine,
      this.workLine,
      this.stateLine,
    );
    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'render-stats-toggle';
    this.toggleButton.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.syncVisibility();
    });
    this.syncVisibility();
    document.body.append(this.element, this.toggleButton);
  }

  /**
   * Refresh the readout. Called every frame; the DOM is only touched a few
   * times a second, because text rewritten at 60 Hz is both a cost and an
   * unreadable flicker of its own.
   */
  update(dtSeconds: number, reading: RenderStatsReading): void {
    this.cloudBakedPeak = Math.max(
      this.cloudBakedPeak,
      reading.cloudBakedTiles,
    );
    this.cloudRebasePeak = Math.max(
      this.cloudRebasePeak,
      reading.cloudRebaseTiles,
    );
    this.cloudOnDemandPeak = Math.max(
      this.cloudOnDemandPeak,
      reading.cloudOnDemandTiles,
    );
    this.cloudStagingPeak = Math.max(
      this.cloudStagingPeak,
      reading.cloudStagingTiles,
    );
    this.cloudCatchUpPeak = Math.max(
      this.cloudCatchUpPeak,
      reading.cloudCatchUpTiles,
    );
    this.cloudBudgetPeak = Math.max(
      this.cloudBudgetPeak,
      reading.cloudSteadyBudget,
    );
    this.cloudSwapSeen ||= reading.cloudSwapped;
    this.sinceRefresh += dtSeconds;
    if (this.sinceRefresh < 0.25) return;
    this.sinceRefresh = 0;

    const { renderScale, nativeScale, bufferWidth, bufferHeight } = reading;
    // A hair of tolerance: the ratio is a float, and 2.0 must never read as
    // "reduced" because it arrived as 1.9999999.
    const reduced = renderScale < nativeScale - 1e-3;
    // Reported as a share of the PIXEL COUNT, not of the scale. The scale is a
    // linear ratio, so a 1.5x buffer on a 2x panel is 75 % as wide and 75 % as
    // tall — but only 56 % of the pixels, and it is the pixel count that decides
    // how far above Nyquist the water is being sampled. Quoting the linear
    // figure makes a serious loss sound mild.
    const areaPercent = Math.round((renderScale / Math.max(nativeScale, 1e-6)) ** 2 * 100);

    const signature = `${reduced}|${areaPercent}|${bufferWidth}x${bufferHeight}`;
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.element.classList.toggle('is-reduced', reduced);
      this.bufferLine.textContent =
        `${bufferWidth}×${bufferHeight}  ${renderScale.toFixed(2)}× of ${nativeScale}×`;
      this.stateLine.textContent = reduced
        ? `▼ ${areaPercent}% of native pixels`
        : 'native resolution';
    }

    if (
      reading.profilingReady &&
      reading.fps !== undefined &&
      reading.frameMs !== undefined
    ) {
      this.fpsLine.textContent = `${Math.round(reading.fps)} FPS`;
      const ms = document.createElement('small');
      ms.textContent = `cadence ${reading.frameMs.toFixed(1)} ms`;
      this.fpsLine.appendChild(ms);
    } else if (reading.profilingReady) {
      this.fpsLine.textContent = 'Cadence warm-up';
    } else {
      this.fpsLine.textContent = 'Profiling warm-up';
    }

    const cpu = reading.cpu;
    if (!reading.profilingReady) {
      this.cpuLine.textContent = 'CPU timing starts after cache warm-up';
    } else if (cpu.frame === undefined) {
      this.cpuLine.textContent = 'CPU profiling…';
    } else {
      const measuredPasses =
        (cpu.worldAndLighting ?? 0) +
        (cpu.vesselAndCamera ?? 0) +
        (cpu.foamAndSpray ?? 0) +
        (cpu.oceanPreparation ?? 0) +
        (cpu.skyAndScene ?? 0) +
        (cpu.renderSubmission ?? 0);
      const other = Math.max(0, cpu.frame - measuredPasses);
      this.cpuLine.textContent = [
        `CPU main        ${formatMilliseconds(cpu.frame)}`,
        `  world + light ${formatMilliseconds(cpu.worldAndLighting)}`,
        `  vessel + camera ${formatMilliseconds(cpu.vesselAndCamera)}`,
        `  foam + spray  ${formatMilliseconds(cpu.foamAndSpray)}`,
        `  ocean prep    ${formatMilliseconds(cpu.oceanPreparation)}`,
        `  sky + scene   ${formatMilliseconds(cpu.skyAndScene)}`,
        `  render submit ${formatMilliseconds(cpu.renderSubmission)}`,
        `  other         ${formatMilliseconds(other)}`,
      ].join('\n');
    }

    const gpu = reading.gpu;
    if (!reading.profilingReady) {
      this.gpuLine.textContent = 'GPU timing starts after cache warm-up';
    } else if (!gpu.supported) {
      this.gpuLine.textContent = 'GPU timing unavailable';
    } else if (gpu.frame === undefined) {
      this.gpuLine.textContent = 'GPU profiling…';
    } else {
      const passValues = [
        gpu.ocean,
        gpu.cloudCacheBake,
        gpu.skyAndCloudDraw,
        gpu.sceneAndStars,
        gpu.foamSimulation,
      ];
      // Present only when the rotation carries them (TERR-134); a rotation
      // without them has their work inside `ocean` and `sceneAndStars`.
      const splitPasses = (gpu.sceneOpaque ?? 0) + (gpu.terrain ?? 0);
      const measured = passValues.every(
        (value): value is number => value !== undefined,
      );
      const measuredPasses =
        (gpu.ocean ?? 0) +
        (gpu.cloudCacheBake ?? 0) +
        (gpu.skyAndCloudDraw ?? 0) +
        (gpu.sceneAndStars ?? 0) +
        (gpu.foamSimulation ?? 0) +
        splitPasses;
      // Cumulative queries rotate across nearby frames. During a rapid
      // adaptive-resolution transition their smoothed prefixes can briefly
      // disagree. An em dash is more honest than presenting a clamped zero as
      // measured work.
      const other =
        measured && measuredPasses <= gpu.frame * 1.001
          ? Math.max(0, gpu.frame - measuredPasses)
          : undefined;
      this.gpuLine.textContent = [
        `GPU frame async ${formatMilliseconds(gpu.frame)}`,
        `  ocean         ${formatMilliseconds(gpu.ocean)}`,
        `  cloud bake    ${formatMilliseconds(gpu.cloudCacheBake)}`,
        `  sky + clouds  ${formatMilliseconds(gpu.skyAndCloudDraw)}`,
        ...(gpu.sceneOpaque === undefined
          ? []
          : [`  vessel        ${formatMilliseconds(gpu.sceneOpaque)}`]),
        ...(gpu.terrain === undefined
          ? []
          : [`  terrain       ${formatMilliseconds(gpu.terrain)}`]),
        `  scene + stars ${formatMilliseconds(gpu.sceneAndStars)}`,
        `  foam sim      ${formatMilliseconds(gpu.foamSimulation)}`,
        `  other         ${formatMilliseconds(other)}`,
      ].join('\n');
    }
    const residualWork =
      reading.oceanResidualLoopMode === 'active'
        ? `window ≤${reading.oceanResidualActiveSlots}/${reading.oceanResidualSlots}`
        : `×${reading.oceanResidualSlots} ${reading.oceanResidualLoopMode}`;
    this.workLine.textContent =
      `cloud tiles · bake ×${this.cloudBakedPeak}` +
      ` (stage ${this.cloudStagingPeak}/${this.cloudBudgetPeak}` +
      (this.cloudRebasePeak > 0
        ? ` + rebase ${this.cloudRebasePeak}`
        : '') +
      (this.cloudOnDemandPeak > 0
        ? ` + demand ${this.cloudOnDemandPeak}`
        : '') +
      (this.cloudCatchUpPeak > 0
        ? ` + catch ${this.cloudCatchUpPeak}`
        : '') +
      `) · ${this.cloudSwapSeen ? 'tick' : 'hold'}\n` +
      `cloud set · view ${reading.cloudVisibleTiles}` +
      ` · guard ${reading.cloudGuardTiles} · sync 60f\n` +
      `cloud pool · ${reading.cloudResidentTiles}/${reading.cloudSlotCapacity}` +
      ` slots · guard miss ${reading.cloudUnmappedGuardTiles}` +
      ` · view miss ${reading.cloudUnmappedVisibleTiles}` +
      ` · ${reading.cloudAtlasWidth}×${reading.cloudAtlasHeight}\n` +
      `cloud mem · ${formatMebibytes(reading.cloudCacheBytes)}` +
      ` / ${formatMebibytes(reading.cloudFullCacheBytes)} full` +
      ` · save ${formatSavingPercent(
        reading.cloudCacheBytes,
        reading.cloudFullCacheBytes,
      )}\n` +
      `cloud bake · view ×${reading.cloudViewSteps}` +
      ` · sun ≤${reading.cloudSunSteps}/hit\n` +
      `sky draw · advect ×${reading.cloudAdvectionMappings}` +
      ` · page ×${reading.cloudPageTableFetches}` +
      ` · fetch ×${reading.cloudCacheFetches} · relight\n` +
      `gas sky · ${reading.skyRadianceLutEnabled
        ? `LUT ${reading.skyRadianceLutWidth}×${reading.skyRadianceLutHeight} ×1/frame`
        : 'analytic in ocean'}\n` +
      `ocean work · atmosphere ×${reading.oceanAtmosphereEvaluations}` +
      ` · vertex ×${reading.oceanVertexSlots}` +
      ` · residual ${residualWork}` +
      (reading.oceanResidualPhaseEnabled ? '' : ' (no phase)') +
      ` · detail ×${reading.oceanDetailOctaves}` +
      (reading.oceanDetailRepresentation === 'prefiltered'
        ? ` filtered ${reading.oceanDetailTextureStyle}`
        : reading.oceanDetailRepresentation === 'analytic'
          ? ''
          : ` ${reading.oceanDetailRepresentation}`
      ) +
      ` · foam ${reading.oceanFoamEnabled ? 'on' : 'off'}` +
      (reading.oceanFlatFragment ? ' · FLAT' : '');

    this.cloudBakedPeak = 0;
    this.cloudRebasePeak = 0;
    this.cloudOnDemandPeak = 0;
    this.cloudStagingPeak = 0;
    this.cloudCatchUpPeak = 0;
    this.cloudBudgetPeak = 0;
    this.cloudSwapSeen = false;
  }

  setVisible(visible: boolean): void {
    if (this.chromeVisible === visible) return;
    this.chromeVisible = visible;
    this.syncVisibility();
  }

  private syncVisibility(): void {
    this.element.hidden = !this.chromeVisible || this.collapsed;
    this.toggleButton.hidden = !this.chromeVisible;
    this.toggleButton.textContent = this.collapsed ? 'Perf' : 'Hide perf';
    this.toggleButton.title = this.collapsed
      ? 'Show CPU/GPU performance panel'
      : 'Hide CPU/GPU performance panel';
    this.toggleButton.setAttribute('aria-expanded', String(!this.collapsed));
    this.toggleButton.setAttribute(
      'aria-label',
      this.collapsed ? 'Show performance panel' : 'Hide performance panel',
    );
  }

  dispose(): void {
    this.element.remove();
    this.toggleButton.remove();
  }
}

function formatMilliseconds(value: number | undefined): string {
  return value === undefined ? '   —   ' : `${value.toFixed(2).padStart(6)} ms`;
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatSavingPercent(bytes: number, fullBytes: number): string {
  const saving = 1 - bytes / Math.max(fullBytes, 1);
  return `${Math.max(0, Math.round(saving * 100))}%`;
}
