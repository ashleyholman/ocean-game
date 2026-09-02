import {
  stepAdaptiveResolution,
  type AdaptiveResolutionSample,
  type AdaptiveResolutionState,
} from '../render/adaptiveResolution';
import {
  FrameCadence,
  type FrameCadenceReading,
} from '../render/FrameCadence';
import { RuntimeFrameClock } from './RuntimeFrameClock';

export interface BrowserFrameCpuProfiler {
  beginFrame(): void;
  endFrame(): void;
  start(): void;
}

export interface BrowserFrameGpuProfiler {
  beginFrame(): void;
  endFrame(): void;
  start(): void;
}

export interface BrowserFrameExecutionGate {
  active: boolean;
}

export interface BrowserFrameDriverReading {
  readonly rawRealDeltaMilliseconds: number;
  readonly rawRealDeltaSeconds: number;
  readonly presentationDeltaSeconds: number;
  readonly adaptiveFrameAverageMilliseconds: number;
  readonly profilingReady: boolean;
  readonly pixelRatioCap: number;
  readonly cadence: Readonly<FrameCadenceReading>;
}

interface MutableBrowserFrameDriverReading {
  rawRealDeltaMilliseconds: number;
  rawRealDeltaSeconds: number;
  presentationDeltaSeconds: number;
  adaptiveFrameAverageMilliseconds: number;
  profilingReady: boolean;
  pixelRatioCap: number;
  cadence: FrameCadenceReading;
}

type AdaptiveResolutionPolicy = (
  state: AdaptiveResolutionState,
  sample: AdaptiveResolutionSample,
) => AdaptiveResolutionState;

export interface BrowserFrameDriverOptions {
  initialNowMilliseconds: number;
  nowMilliseconds(): number;
  documentHidden(): boolean;
  pollViewport(): void;
  cpuProfiler: BrowserFrameCpuProfiler;
  gpuProfiler: BrowserFrameGpuProfiler;
  execution: BrowserFrameExecutionGate;
  stepSimulation(
    presentationDeltaSeconds: number,
    rawRealDeltaSeconds: number,
  ): void;
  renderFrame(): void;
  cloudCacheSwapped(): boolean;
  serviceFrameReadback(): void;
  captureIfRequested?(): void;
  fixedPixelRatio: number | undefined;
  adaptivePixelRatioTarget: number;
  initialPixelRatioCap: number;
  applyPixelRatio(cap: number): void;
  afterFrame(reading: BrowserFrameDriverReading): void;
  adaptiveResolutionPolicy?: AdaptiveResolutionPolicy;
}

/** First representative cloud generation plus twelve ordinary settle frames. */
export const PROFILING_SETTLE_FRAMES = 12;
/** Shipping cadence between adaptive-resolution policy samples. */
export const ADAPTATION_INTERVAL_SECONDS = 2.5;
/** Initial delivery-time EWMA retained from the original browser loop. */
export const INITIAL_ADAPTIVE_FRAME_AVERAGE_MS = 16.7;

/**
 * Browser-presented frame scheduler.
 *
 * Direct deterministic stepping remains outside this owner. This class only
 * coordinates the normal animation callback, using the same mutable diagnostic
 * execution gate as the diagnostics facade. Its public callback and reading are
 * stable objects so neither animation dispatch nor stats publication allocates.
 */
export class BrowserFrameDriver {
  readonly reading: BrowserFrameDriverReading;

  private readonly mutableReading: MutableBrowserFrameDriverReading;
  private readonly clock: RuntimeFrameClock;
  private readonly frameCadence = new FrameCadence();
  private readonly adaptiveResolutionPolicy: AdaptiveResolutionPolicy;
  private adaptiveFrameAverageMilliseconds =
    INITIAL_ADAPTIVE_FRAME_AVERAGE_MS;
  private adaptElapsedSeconds = 0;
  private profilingSettleFrames: number | undefined;
  private adaptiveState: AdaptiveResolutionState;

  constructor(private readonly options: BrowserFrameDriverOptions) {
    this.clock = new RuntimeFrameClock(options.initialNowMilliseconds);
    this.adaptiveResolutionPolicy =
      options.adaptiveResolutionPolicy ?? stepAdaptiveResolution;
    this.adaptiveState = {
      cap: options.initialPixelRatioCap,
      recoveryWindows: 0,
      downscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
      failedUpscaleCap: Number.POSITIVE_INFINITY,
      upscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
      upscaleRetryBackoffSeconds: 0,
    };
    this.mutableReading = {
      rawRealDeltaMilliseconds: 0,
      rawRealDeltaSeconds: 0,
      presentationDeltaSeconds: 0,
      adaptiveFrameAverageMilliseconds:
        INITIAL_ADAPTIVE_FRAME_AVERAGE_MS,
      profilingReady: false,
      pixelRatioCap: options.initialPixelRatioCap,
      cadence: this.frameCadence.reading,
    };
    this.reading = this.mutableReading;
  }

  /** Stable visibility-change callback. */
  readonly resetCadence = (): void => {
    this.frameCadence.reset();
  };

  /** Stable callback passed directly to WebGLRenderer.setAnimationLoop(). */
  readonly frame = (): void => {
    const { options } = this;
    options.cpuProfiler.beginFrame();
    options.pollViewport();

    const nowMilliseconds = options.nowMilliseconds();
    const deltas = this.clock.sample(nowMilliseconds);
    const rawRealDeltaMilliseconds = deltas.rawRealMilliseconds;
    const rawRealDeltaSeconds = deltas.rawRealSeconds;
    const presentationDeltaSeconds = deltas.presentationSeconds;

    this.mutableReading.rawRealDeltaMilliseconds = rawRealDeltaMilliseconds;
    this.mutableReading.rawRealDeltaSeconds = rawRealDeltaSeconds;
    this.mutableReading.presentationDeltaSeconds = presentationDeltaSeconds;

    // Ignore throttled frames only for the adaptive-resolution estimate.
    if (!options.documentHidden() && rawRealDeltaMilliseconds < 200) {
      this.adaptiveFrameAverageMilliseconds +=
        (rawRealDeltaMilliseconds -
          this.adaptiveFrameAverageMilliseconds) *
        0.05;
      this.mutableReading.adaptiveFrameAverageMilliseconds =
        this.adaptiveFrameAverageMilliseconds;
    }
    if (this.mutableReading.profilingReady && !options.documentHidden()) {
      this.frameCadence.recordFrame(nowMilliseconds);
    }

    options.gpuProfiler.beginFrame();
    try {
      options.stepSimulation(
        options.execution.active ? 0 : presentationDeltaSeconds,
        options.execution.active ? 0 : rawRealDeltaSeconds,
      );
      options.renderFrame();
    } finally {
      options.gpuProfiler.endFrame();
    }

    // Omit the exceptional initial cloud fill and twelve settle callbacks from
    // every fresh CPU, GPU and wall-cadence profiling history.
    if (!this.mutableReading.profilingReady) {
      if (this.profilingSettleFrames === undefined) {
        if (options.cloudCacheSwapped()) {
          this.profilingSettleFrames = PROFILING_SETTLE_FRAMES;
        }
      } else if (this.profilingSettleFrames > 0) {
        this.profilingSettleFrames--;
      } else {
        this.mutableReading.profilingReady = true;
        this.frameCadence.reset(nowMilliseconds);
        options.cpuProfiler.start();
        options.gpuProfiler.start();
      }
    }

    options.serviceFrameReadback();
    if (import.meta.env.DEV) options.captureIfRequested?.();

    this.adaptElapsedSeconds += presentationDeltaSeconds;
    if (
      options.fixedPixelRatio === undefined &&
      !options.execution.active &&
      this.adaptElapsedSeconds > ADAPTATION_INTERVAL_SECONDS &&
      !options.documentHidden()
    ) {
      this.adaptElapsedSeconds = 0;
      this.adaptiveState = this.adaptiveResolutionPolicy(this.adaptiveState, {
        frameAverageMs: this.adaptiveFrameAverageMilliseconds,
        targetCap: options.adaptivePixelRatioTarget,
        nowSeconds: options.nowMilliseconds() / 1000,
      });
      if (this.adaptiveState.cap !== this.mutableReading.pixelRatioCap) {
        this.mutableReading.pixelRatioCap = this.adaptiveState.cap;
        options.applyPixelRatio(this.adaptiveState.cap);
      }
    }

    options.afterFrame(this.reading);
    options.cpuProfiler.endFrame();
  };
}
