export type CpuPass =
  | 'worldAndLighting'
  | 'vesselAndCamera'
  | 'foamAndSpray'
  | 'oceanPreparation'
  | 'skyAndScene'
  | 'renderSubmission';

export interface CpuProfilerReading {
  /** Main-thread wall time from the start to the end of the frame callback. */
  frame?: number;
  worldAndLighting?: number;
  vesselAndCamera?: number;
  foamAndSpray?: number;
  oceanPreparation?: number;
  skyAndScene?: number;
  /**
   * CPU time inside `renderer.render()`. This is command preparation and
   * submission, and can include a driver wait when the GPU queue is saturated.
   */
  renderSubmission?: number;
}

type Clock = () => number;

const SMOOTHING = 0.16;
const PASSES: readonly CpuPass[] = [
  'worldAndLighting',
  'vesselAndCamera',
  'foamAndSpray',
  'oceanPreparation',
  'skyAndScene',
  'renderSubmission',
];

/**
 * Low-overhead main-thread profiling for the production animation loop.
 *
 * Unlike the asynchronous GPU timer queries, these spans are ordinary
 * `performance.now()` wall times on the JavaScript thread. The pass spans are
 * flat and additive. `frame` covers the whole callback, so the difference
 * between it and the named passes is resize, adaptive-resolution, stats UI,
 * developer tools, and profiler overhead.
 */
export class CpuProfiler {
  readonly reading: CpuProfilerReading = {};

  private readonly clock: Clock;
  private readonly frameDurations: Partial<Record<CpuPass, number>> = {};
  private running = false;
  private frameStart: number | undefined;
  private activePass: CpuPass | undefined;
  private passStart = 0;

  constructor(clock: Clock = () => performance.now()) {
    this.clock = clock;
  }

  /**
   * Begin a fresh profiling session.
   *
   * Profiling is deliberately opt-in so startup allocation, shader compilation
   * and cache bootstrap cannot seed the smoothed production reading. The
   * render loop decides when the scene is representative, then opens the
   * session once.
   */
  start(): void {
    this.running = true;
    this.frameStart = undefined;
    this.activePass = undefined;
    for (const key of Object.keys(this.reading) as Array<
      keyof CpuProfilerReading
    >) {
      delete this.reading[key];
    }
  }

  beginFrame(): void {
    if (!this.running || this.frameStart !== undefined) return;
    for (const pass of PASSES) delete this.frameDurations[pass];
    this.activePass = undefined;
    this.frameStart = this.clock();
  }

  beginPass(pass: CpuPass): void {
    if (this.frameStart === undefined || this.activePass !== undefined) return;
    this.activePass = pass;
    this.passStart = this.clock();
  }

  endPass(pass: CpuPass): void {
    if (this.activePass !== pass) return;
    const elapsed = finiteElapsed(this.clock() - this.passStart);
    this.frameDurations[pass] =
      (this.frameDurations[pass] ?? 0) + elapsed;
    this.activePass = undefined;
  }

  endFrame(): void {
    if (this.frameStart === undefined) return;
    const now = this.clock();
    if (this.activePass !== undefined) {
      const pass = this.activePass;
      this.frameDurations[pass] =
        (this.frameDurations[pass] ?? 0) +
        finiteElapsed(now - this.passStart);
      this.activePass = undefined;
    }

    this.smooth('frame', finiteElapsed(now - this.frameStart));
    for (const pass of PASSES) {
      this.smooth(pass, this.frameDurations[pass] ?? 0);
    }
    this.frameStart = undefined;
  }

  private smooth(
    key: keyof CpuProfilerReading,
    sampleMilliseconds: number,
  ): void {
    const previous = this.reading[key];
    this.reading[key] =
      previous === undefined
        ? sampleMilliseconds
        : previous + (sampleMilliseconds - previous) * SMOOTHING;
  }
}

function finiteElapsed(milliseconds: number): number {
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
}
