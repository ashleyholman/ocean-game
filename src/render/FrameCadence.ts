export interface FrameCadenceReading {
  /** Presented frames per second over the current wall-cadence window. */
  fps?: number;
  /** Mean interval between those frames, in milliseconds. */
  frameMs?: number;
  sampleCount: number;
  sampledElapsedMs: number;
}

/** One second is responsive without letting a single fast frame dominate. */
export const DEFAULT_CADENCE_WINDOW_MS = 1000;

/**
 * Actual frame delivery over a recent wall-time window.
 *
 * FPS and frame time are deliberately derived from the same interval total:
 * averaging `1000 / interval` separately biases FPS high whenever delivery is
 * uneven. Callers reset this history across tab visibility interruptions so a
 * background-throttled gap is not presented as foreground rendering speed.
 */
export class FrameCadence {
  readonly reading: FrameCadenceReading = {
    sampleCount: 0,
    sampledElapsedMs: 0,
  };

  private readonly intervalsMs: number[] = [];
  private sampledElapsedMs = 0;
  private lastFrameTimestampMs: number | undefined;

  constructor(
    private readonly windowMs: number = DEFAULT_CADENCE_WINDOW_MS,
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('Frame cadence window must be a positive duration');
    }
  }

  /**
   * Clear the window. An optional timestamp establishes a fresh first-frame
   * baseline without turning the time before it into a sample.
   */
  reset(baselineTimestampMs?: number): void {
    this.intervalsMs.length = 0;
    this.sampledElapsedMs = 0;
    this.lastFrameTimestampMs = Number.isFinite(baselineTimestampMs)
      ? baselineTimestampMs
      : undefined;
    delete this.reading.fps;
    delete this.reading.frameMs;
    this.reading.sampleCount = 0;
    this.reading.sampledElapsedMs = 0;
  }

  /** Record the monotonic timestamp at the start of a visible frame callback. */
  recordFrame(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) return;

    const previousTimestampMs = this.lastFrameTimestampMs;
    this.lastFrameTimestampMs = timestampMs;
    if (previousTimestampMs === undefined) return;

    const intervalMs = timestampMs - previousTimestampMs;
    if (intervalMs <= 0) {
      // A clock discontinuity invalidates every interval spanning it.
      if (intervalMs < 0) this.reset(timestampMs);
      return;
    }

    this.intervalsMs.push(intervalMs);
    this.sampledElapsedMs += intervalMs;

    // Retain the shortest recent suffix that still covers the requested
    // window. Keeping whole intervals makes frameCount / elapsed exact, while
    // bounding history to at most one extra frame interval beyond the window.
    while (this.intervalsMs.length > 1) {
      const oldestMs = this.intervalsMs[0];
      if (this.sampledElapsedMs - oldestMs < this.windowMs) break;
      this.intervalsMs.shift();
      this.sampledElapsedMs -= oldestMs;
    }

    const frameMs = this.sampledElapsedMs / this.intervalsMs.length;
    this.reading.frameMs = frameMs;
    this.reading.fps = 1000 / frameMs;
    this.reading.sampleCount = this.intervalsMs.length;
    this.reading.sampledElapsedMs = this.sampledElapsedMs;
  }
}
