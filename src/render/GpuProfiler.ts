import * as THREE from 'three';

export type GpuPass =
  | 'frame'
  | 'foamSimulation'
  | 'cloudCacheBake'
  | 'skyAndCloudDraw'
  | 'sceneOpaque'
  | 'terrain'
  | 'stars'
  | 'ocean';

export interface GpuProfilerReading {
  /** False when EXT_disjoint_timer_query_webgl2 is unavailable. */
  supported: boolean;
  /** Smoothed elapsed GPU milliseconds. Missing until the first query resolves. */
  frame?: number;
  foamSimulation?: number;
  /** Cache-band draw: view traversal and per-hit sun-shadow rays. */
  cloudCacheBake?: number;
  /** Gas sky plus cache advection, fetch, live relighting, and dome composite. */
  skyAndCloudDraw?: number;
  /**
   * The opaque scene ahead of the sea: hull, rig, fittings and interior.
   *
   * New with TERR-134, and worth stating plainly because it CHANGES WHAT
   * `ocean` MEANS. The sky endpoint is the dome's own draw at render order
   * −1000 and the ocean endpoint is the sea's, so everything between them —
   * the whole vessel at −2 and −1 — used to be counted as ocean. Baselines
   * taken before this bucket existed (`evidence/terrain/baseline`,
   * `evidence/terrain/depth-candidates`) have the ship inside their ocean
   * figure and are not comparable to a post-split one.
   */
  sceneOpaque?: number;
  /**
   * Terrain tiles alone (TERR-134).
   *
   * Bounded by whichever draw follows terrain in the active order, so the
   * bucket is terrain and nothing else in both arms of `terrainOrder`. Reads
   * about zero when no terrain is mounted, rather than stalling the rotation.
   */
  terrain?: number;
  ocean?: number;
  /** Transparent scene work up to and including the star endpoint. */
  sceneAndStars?: number;
}

/**
 * The small interface renderable systems consume. Keeping them unaware of the
 * WebGL query implementation also makes every non-production render loop a
 * no-op unless main.ts has explicitly opened a profiled frame.
 */
export interface GpuPassProfiler {
  beginPass(pass: GpuDetailPass): void;
  /**
   * Close the cumulative prefix at this point in the frame.
   *
   * Idempotent within a frame: the first call for a pass ends its query and
   * every later one is a no-op. That is load-bearing rather than defensive —
   * the terrain bucket's front edge is "just before the first terrain tile
   * draws" and a fixture has up to nine tiles, so nine meshes all announce the
   * boundary and the earliest one wins. It is also what lets the ocean supply
   * the same boundary as a fallback when no terrain is mounted at all, instead
   * of leaving an endpoint that never fires and a rotation that never
   * completes.
   */
  endPass(pass: GpuDetailPass): void;
}

interface DisjointTimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

interface PendingQuery {
  pass: GpuPass;
  query: WebGLQuery;
  cycle: number;
}

interface ActiveQuery extends PendingQuery {}

type ReadingTiming = Exclude<keyof GpuProfilerReading, 'supported'>;

export type GpuDetailPass = Exclude<GpuPass, 'frame'>;

export type GpuPrefixSamples = { frame: number } & Partial<
  Record<GpuDetailPass, number>
>;

/**
 * Every rotation carries these five, whichever order terrain draws in — they
 * are the buckets that existed before TERR-134 and every evidence consumer
 * reads them as numbers.
 */
export interface GpuDerivedPassTimings {
  frame: number;
  foamSimulation: number;
  cloudCacheBake: number;
  skyAndCloudDraw: number;
  ocean: number;
  sceneAndStars: number;
  /** Present only when the rotation splits the vessel out (TERR-134). */
  sceneOpaque?: number;
  /** Present only when the rotation carries a terrain endpoint (TERR-134). */
  terrain?: number;
}

export interface GpuRawSample {
  serial: number;
  timing: GpuDerivedPassTimings;
}

const SMOOTHING = 0.16;
const MAX_PENDING_QUERIES = 32;
const MAX_PREFIX_CYCLES = 12;

/**
 * The rotation that shipped before terrain had buckets of its own. Kept as the
 * default so every harness that constructs a profiler without an opinion —
 * the buoyancy lab, the schooner viewer, a test — measures exactly what it
 * measured before.
 */
export const DEFAULT_GPU_DETAIL_PASSES: readonly GpuDetailPass[] = [
  'foamSimulation',
  'cloudCacheBake',
  'skyAndCloudDraw',
  'ocean',
  'stars',
];

/**
 * The two orders the main frame can submit in (TERR-131/134).
 *
 * A prefix profiler measures cumulative time to an endpoint, so the endpoint
 * list has to be in SUBMISSION order or the differences come out negative. The
 * only thing that moves between these two is where terrain sits relative to
 * the sea; the names, and what each bucket contains, are identical.
 */
export const GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN: readonly GpuDetailPass[] = [
  'foamSimulation',
  'cloudCacheBake',
  'skyAndCloudDraw',
  'sceneOpaque',
  'terrain',
  'ocean',
  'stars',
];

export const GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN: readonly GpuDetailPass[] = [
  'foamSimulation',
  'cloudCacheBake',
  'skyAndCloudDraw',
  'sceneOpaque',
  'ocean',
  'terrain',
  'stars',
];

/**
 * The reading key each prefix difference is published under.
 *
 * All but the last are named for the pass that closes them. The final endpoint
 * is the star draw, and the interval before it is everything transparent that
 * precedes the catalogue — `sceneAndStars` kept its name from when it also
 * carried the opaque scene, which now has its own bucket.
 */
function readingKeyFor(
  pass: GpuDetailPass,
  isLast: boolean,
): ReadingTiming | undefined {
  if (pass === 'stars') return isLast ? 'sceneAndStars' : undefined;
  return pass;
}

/**
 * Asynchronous GPU pass timings using WebGL2 timer queries.
 *
 * Isolating a draw with a timer query can force a tile-based GPU to flush work
 * that a normal frame keeps deferred; in practice that made even the star draw
 * report almost the entire frame. We therefore measure one cumulative prefix
 * per frame: frame start → foam, → cloud-cache bake, → sky/cloud draw, → …,
 * → stars, then the whole frame. Putting the full-frame sample last keeps it
 * adjacent to the final prefix used to derive `other`.
 *
 * Adjacent prefixes from the same rotation are paired first, and their
 * difference is then smoothed. Pairing raw neighbours avoids the false zero
 * that can result from subtracting two independently smoothed streams. One
 * rotation therefore costs `detailPasses.length + 1` frames — five plus one
 * before TERR-134, seven plus one with the vessel and terrain split out — and
 * any harness quoting a "frames per rotation" must read it from
 * {@link framesPerRotation} rather than writing the number down.
 *
 * Results arrive several frames later and are smoothed before display. This is
 * genuine GPU execution time, not the CPU time required to submit draw calls.
 */
export class GpuProfiler implements GpuPassProfiler {
  readonly reading: GpuProfilerReading;

  /** Monotonic counter for complete, unsmoothed six-frame prefix rotations. */
  get rawSampleSerial(): number {
    return this.rawSampleSerialValue;
  }

  /** Most recent signed pass differences before display smoothing/clamping. */
  get latestRawSample(): Readonly<GpuDerivedPassTimings> | undefined {
    return this.latestRawSampleValue;
  }

  /** Small session-local history so a collector cannot miss batched results. */
  get rawSamples(): readonly GpuRawSample[] {
    return this.rawSamplesValue;
  }

  private readonly gl: WebGL2RenderingContext;
  private readonly extension: DisjointTimerQueryExtension | null;
  private readonly pending: PendingQuery[] = [];
  private readonly prefixCycles = new Map<number, PrefixCycle>();
  private readonly smoothedMilliseconds: Partial<
    Record<ReadingTiming, number>
  > = {};
  private active: ActiveQuery | undefined;
  private running = false;
  private frameOpen = false;
  private selectedPass: GpuPass = 'frame';
  private selectedCycle = 0;
  private frameIndex = 0;
  private rawSampleSerialValue = 0;
  private latestRawSampleValue: GpuDerivedPassTimings | undefined;
  private readonly rawSamplesValue: GpuRawSample[] = [];
  private detailPassesValue: readonly GpuDetailPass[] =
    DEFAULT_GPU_DETAIL_PASSES;

  constructor(
    renderer: THREE.WebGLRenderer,
    detailPasses: readonly GpuDetailPass[] = DEFAULT_GPU_DETAIL_PASSES,
  ) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.extension = this.gl.getExtension(
      'EXT_disjoint_timer_query_webgl2',
    ) as DisjointTimerQueryExtension | null;
    this.reading = { supported: this.extension !== null };
    this.detailPassesValue = [...detailPasses];
  }

  /** The endpoint rotation in submission order. */
  get detailPasses(): readonly GpuDetailPass[] {
    return this.detailPassesValue;
  }

  /** Frames one complete raw sample costs, including the whole-frame query. */
  get framesPerRotation(): number {
    return this.detailPassesValue.length + 1;
  }

  /**
   * Re-declare the endpoint rotation, in submission order.
   *
   * The draw order can move under a live A/B switch, and a prefix list that no
   * longer matches submission order does not read wrong — it reads NEGATIVE,
   * which the smoother then hides. Restarting the session on every change is
   * cheap and leaves no half-collected rotation straddling the two orders.
   */
  setDetailPasses(detailPasses: readonly GpuDetailPass[]): void {
    const next = [...detailPasses];
    if (
      next.length === this.detailPassesValue.length &&
      next.every((pass, index) => pass === this.detailPassesValue[index])
    ) {
      return;
    }
    const wasRunning = this.running;
    this.detailPassesValue = next;
    if (wasRunning) this.start();
  }

  /**
   * Begin a fresh asynchronous query session.
   *
   * The render loop calls this only after scene bootstrap is complete, so
   * shader compilation and the cloud cache's first full guard fill never enter
   * either the prefix rotation or its exponential smoothing history.
   */
  start(): void {
    if (this.active) this.cancelActiveQuery();
    for (const pending of this.pending) this.gl.deleteQuery(pending.query);
    this.pending.length = 0;
    this.prefixCycles.clear();
    for (const key of Object.keys(this.smoothedMilliseconds) as ReadingTiming[]) {
      delete this.smoothedMilliseconds[key];
      delete this.reading[key];
    }
    this.frameOpen = false;
    this.frameIndex = 0;
    this.rawSampleSerialValue = 0;
    this.latestRawSampleValue = undefined;
    this.rawSamplesValue.length = 0;
    this.running = true;
  }

  beginFrame(): void {
    this.collect();
    if (!this.extension || !this.running || this.frameOpen) return;

    this.frameOpen = true;
    const sampleIndex = this.frameIndex++;
    const passes = this.detailPassesValue;
    const cycleLength = passes.length + 1;
    const slot = sampleIndex % cycleLength;
    this.selectedCycle = Math.floor(sampleIndex / cycleLength);
    this.selectedPass = slot === passes.length ? 'frame' : passes[slot];
    this.beginQuery(this.selectedPass, this.selectedCycle);
  }

  endFrame(): void {
    if (!this.extension || !this.frameOpen) return;
    if (this.selectedPass === 'frame') this.endQuery('frame');
    else this.cancelActiveQuery();
    this.frameOpen = false;
  }

  beginPass(_pass: GpuDetailPass): void {
    // Prefix queries always begin at the frame boundary. Pass starts remain in
    // the interface so render systems expose symmetric, self-documenting hooks.
  }

  endPass(pass: GpuDetailPass): void {
    if (!this.frameOpen || this.selectedPass !== pass) return;
    // `endQuery` is itself a no-op once the active query has been closed, which
    // is what makes repeated calls in one frame safe. See GpuPassProfiler.
    this.endQuery(pass);
  }

  dispose(): void {
    this.running = false;
    if (this.active && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active.query);
      this.active = undefined;
    }
    for (const pending of this.pending) this.gl.deleteQuery(pending.query);
    this.pending.length = 0;
  }

  private beginQuery(pass: GpuPass, cycle: number): void {
    if (
      !this.extension ||
      this.active ||
      this.pending.length >= MAX_PENDING_QUERIES
    ) {
      return;
    }
    const query = this.gl.createQuery();
    if (!query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.active = { pass, query, cycle };
  }

  private endQuery(pass: GpuPass): void {
    if (!this.extension || this.active?.pass !== pass) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = undefined;
  }

  private cancelActiveQuery(): void {
    if (!this.extension || !this.active) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.gl.deleteQuery(this.active.query);
    this.active = undefined;
  }

  private collect(): void {
    if (!this.extension) return;

    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      for (const pending of this.pending) this.gl.deleteQuery(pending.query);
      this.pending.length = 0;
      this.prefixCycles.clear();
      return;
    }

    for (let index = 0; index < this.pending.length; ) {
      const pending = this.pending[index];
      const available = this.gl.getQueryParameter(
        pending.query,
        this.gl.QUERY_RESULT_AVAILABLE,
      ) as boolean;
      if (!available) {
        index++;
        continue;
      }

      const nanoseconds = this.gl.getQueryParameter(
        pending.query,
        this.gl.QUERY_RESULT,
      ) as number;
      this.gl.deleteQuery(pending.query);
      this.pending.splice(index, 1);

      const milliseconds = nanoseconds / 1e6;
      if (!Number.isFinite(milliseconds) || milliseconds < 0) continue;
      this.recordPrefix(pending.cycle, pending.pass, milliseconds);
    }
  }

  private recordPrefix(cycleIndex: number, pass: GpuPass, value: number): void {
    let cycle = this.prefixCycles.get(cycleIndex);
    if (!cycle) {
      cycle = { values: {} };
      this.prefixCycles.set(cycleIndex, cycle);
    }
    cycle.values[pass] = value;

    if (isCompletePrefixCycle(cycle.values, this.detailPassesValue)) {
      const timing = deriveGpuPassTimings(cycle.values, this.detailPassesValue);
      this.latestRawSampleValue = timing;
      this.rawSampleSerialValue++;
      this.rawSamplesValue.push({
        serial: this.rawSampleSerialValue,
        timing,
      });
      if (this.rawSamplesValue.length > 64) this.rawSamplesValue.shift();
      for (const [key, sample] of Object.entries(timing) as Array<
        [ReadingTiming, number]
      >) {
        this.smooth(key, sample);
      }
      this.prefixCycles.delete(cycleIndex);
    }
    while (this.prefixCycles.size > MAX_PREFIX_CYCLES) {
      const oldest = Math.min(...this.prefixCycles.keys());
      this.prefixCycles.delete(oldest);
    }
  }

  private smooth(key: ReadingTiming, sample: number): void {
    const previous = this.smoothedMilliseconds[key];
    const smoothed =
      previous === undefined
        ? sample
        : previous + (sample - previous) * SMOOTHING;
    this.smoothedMilliseconds[key] = smoothed;
    // Prefixes come from adjacent frames. Their unbiased difference can be
    // briefly negative when those frames vary; keep smoothing the signed value
    // but do not put a physically impossible negative duration on screen.
    if (smoothed >= 0) this.reading[key] = smoothed;
    else delete this.reading[key];
  }
}

interface PrefixCycle {
  values: Partial<Record<GpuPass, number>>;
}

/**
 * Convert tile-safe cumulative query endpoints from one rotation into pass
 * durations: each bucket is the difference between its own endpoint and the
 * one submitted before it.
 *
 * Differences stay signed here: adjacent frames can vary by more than a small
 * pass costs, and smoothing signed noise is unbiased. The live reading simply
 * hides a phase while its smoothed estimate is negative.
 *
 * `detailPasses` must be in SUBMISSION order — it is the only thing that says
 * which prefix precedes which, and a stale list turns a small bucket into a
 * negative one rather than into an error.
 */
export function deriveGpuPassTimings(
  prefix: GpuPrefixSamples,
  detailPasses: readonly GpuDetailPass[] = DEFAULT_GPU_DETAIL_PASSES,
): GpuDerivedPassTimings {
  const timing: Partial<Record<ReadingTiming, number>> = {
    frame: prefix.frame,
  };
  let previous = 0;
  detailPasses.forEach((pass, index) => {
    const value = prefix[pass];
    if (value === undefined) return;
    const key = readingKeyFor(pass, index === detailPasses.length - 1);
    if (key) timing[key] = value - previous;
    previous = value;
  });
  return timing as GpuDerivedPassTimings;
}

function isCompletePrefixCycle(
  values: Partial<Record<GpuPass, number>>,
  detailPasses: readonly GpuDetailPass[],
): values is GpuPrefixSamples {
  if (values.frame === undefined) return false;
  return detailPasses.every((pass) => values[pass] !== undefined);
}
