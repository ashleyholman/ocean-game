import * as THREE from 'three';

import {
  createOceanProbeVariants,
  formatOceanProbeResults,
  OCEAN_PROBE_SAMPLE_COUNT,
  OCEAN_PROBE_WARMUP_FRAMES,
  summarizeSamples,
} from '../../render/OceanProfileProbe';
import type { OceanProbeResult } from '../../render/OceanProfileProbe';
import type { OceanDetailRepresentation } from '../../scene/Ocean';
import type {
  DiagnosticSunShadowMode,
  RuntimeDiagnostics,
  RuntimeDiagnosticsDependencies,
} from './RuntimeDiagnosticsContract';

export type RuntimeBenchmarkDiagnostics = Pick<
  RuntimeDiagnostics,
  | 'runOceanProfileProbe'
  | 'runDirectShadowBenchmark'
  | 'runPairedToggleBenchmark'
  | 'runWakeTrailCostBenchmark'
  | 'runWakeBowCostBenchmark'
  | 'runOceanResidualActiveBenchmark'
  | 'runOceanDetailBenchmark'
  | 'runOceanDetailRepresentationBenchmark'
  | 'runWhitewaterCostBenchmark'
>;

/**
 * The `?perf=direct-shadows` ladder, at module scope so its labels can be read
 * without a GPU.
 *
 * A rung's NAME is the only thing standing between a number and a wrong
 * conclusion, and these names went stale silently. The ladder was authored when
 * the sea cast into the Sun's map by default, so its top rung WAS production and
 * the "all new" line WAS the price of the feature. The sea then stopped casting
 * — a shadow map cannot resolve that surface — and nothing renamed anything.
 * `shipped` is carried per rung rather than left to the prose so the report and
 * the test read the same field.
 */
export const DIRECT_SHADOW_LADDER: ReadonlyArray<{
  label: string;
  sunMode: DiagnosticSunShadowMode;
  lantern: boolean;
  /** True where this rung is a configuration the game actually renders. */
  shipped: boolean;
}> = [
  { label: 'A1 old solid Sun map', sunMode: 'solid-only', lantern: false, shipped: false },
  { label: 'B1 + water receiver [SHIPPED]', sunMode: 'water-receiver', lantern: false, shipped: true },
  { label: 'C1 + displaced swell caster [NOT shipped]', sunMode: 'full', lantern: false, shipped: false },
  { label: 'D1 + active lantern [on top of C]', sunMode: 'full', lantern: true, shipped: false },
  { label: 'D2 + active lantern [on top of C]', sunMode: 'full', lantern: true, shipped: false },
  { label: 'C2 + displaced swell caster [NOT shipped]', sunMode: 'full', lantern: false, shipped: false },
  { label: 'B2 + water receiver [SHIPPED]', sunMode: 'water-receiver', lantern: false, shipped: true },
  { label: 'A2 old solid Sun map', sunMode: 'solid-only', lantern: false, shipped: false },
];

export function createRuntimeBenchmarkDiagnostics(
  dependencies: RuntimeDiagnosticsDependencies,
): RuntimeBenchmarkDiagnostics {
  const {
    execution,
    renderer,
    canvas,
    gpuProfiler,
    ocean,
    sky,
    waves,
    foam,
    world,
    seaStates,
    quality,
    nextPresentedFrame,
    waitPresentedFrames,
    foamFreeze,
    wakeState,
    shadowing,
  } = dependencies;

  /**
   * Measure compile-time ocean counterfactuals through complete, unsmoothed GPU
   * prefix rotations. One rotation is six adjacent frames; taking a dozen of them
   * gives each row enough history to show its variance instead of laundering
   * frame-to-frame noise through the live overlay's exponential smoother.
   */
  async function runOceanProfileProbe(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) {
      throw new Error('Ocean component probe is already running');
    }
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const originalSettings = { ...ocean.profileSettings };
    const originalLutEnabled = ocean.skyRadianceLutEnabled;
    const variants = createOceanProbeVariants(quality.detailOctaves);
    const results: OceanProbeResult[] = [];
    const metadata = () =>
      [
        `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}`,
        `world/camera frozen · ${OCEAN_PROBE_WARMUP_FRAMES} warm-up frames · ${OCEAN_PROBE_SAMPLE_COUNT} raw rotations`,
        '',
      ].join('\n');

    execution.active = true;
    try {
      for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
        const variant = variants[variantIndex];
        ocean.setProfileSettings(variant.settings);
        sky.setRadianceLutEnabled(variant.lutEnabled);
        ocean.setSkyRadianceLutEnabled(variant.lutEnabled);
        onProgress(
          `${metadata()}warming ${variantIndex + 1}/${variants.length}: ${variant.label}`,
        );
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);

        gpuProfiler.start();
        const oceanSamples: number[] = [];
        const frameSamples: number[] = [];
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (oceanSamples.length < OCEAN_PROBE_SAMPLE_COUNT) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            oceanSamples.push(sample.timing.ocean);
            frameSamples.push(sample.timing.frame);
            if (oceanSamples.length >= OCEAN_PROBE_SAMPLE_COUNT) break;
          }
          onProgress(
            `${metadata()}measuring ${variantIndex + 1}/${variants.length}: ${variant.label}\n` +
              `raw rotations ${oceanSamples.length}/${OCEAN_PROBE_SAMPLE_COUNT}`,
          );
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for “${variant.label}”`);
          }
        }

        results.push({
          variant,
          ocean: summarizeSamples(oceanSamples),
          frame: summarizeSamples(frameSamples),
        });
        onProgress(`${metadata()}${formatOceanProbeResults(results)}`);
      }
      return `${metadata()}${formatOceanProbeResults(results)}`;
    } finally {
      ocean.setProfileSettings(originalSettings);
      sky.setRadianceLutEnabled(originalLutEnabled);
      ocean.setSkyRadianceLutEnabled(originalLutEnabled);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  interface DirectShadowBenchmarkRow {
    label: string;
    sunMode: DiagnosticSunShadowMode;
    lantern: boolean;
    frame: number[];
  }

  const DIRECT_SHADOW_SAMPLE_COUNT = 24;

  /**
   * The AO bracket needs far more rotations than the shadow one.
   *
   * It is looking for a handful of ALU instructions inside a frame that also
   * marches clouds, so the effect is orders of magnitude below the frame's own
   * variance and only the standard error can shrink to meet it. Four times the
   * rotations halves it; the rest of the resolution has to come from a quiet
   * machine.
   */
  const VESSEL_AO_PAIRS = 8;
  const VESSEL_AO_BLOCK = 16;

  /**
   * Price the real shadow system through the complete frame.
   *
   * A-B-C-D-D-C-B-A brackets drift while splitting the new work from the shadow
   * cost the solid scene already paid before this change. A retains the original
   * vessel-only Sun map; B adds the ocean's lookup (hull shadow); C adds the
   * displaced-ocean caster (swell self-shadow); D adds the active lantern's six
   * vessel-only faces and cube lookup. Full-frame timers are primary because
   * three.js renders all shadow maps before the visible scene, so no visible-mesh
   * pass boundary can honestly own their cost.
   *
   * **Which rung ships, and why the labels now say so.** This ladder was written
   * when the sea cast into the Sun's map by default, so its top was the shipped
   * world and "all new direct-water shadows" was the price of the feature. The
   * sea stopped casting — a shadow map cannot resolve that surface, see
   * `SHADOW_VERTEX_SHADER` — and the names went on describing the old world
   * (`SHADOW_ROUND_HANDOVER`, "row labels are stale"). The levers all still work;
   * a reader was simply being handed C and D as if they were production.
   *
   * Today the shipped configuration is B by day and B-plus-lantern by night. C
   * is off by default and D is measured on top of C, so NO single row of this
   * ladder prices what actually ships. The rows and the summary lines are
   * labelled accordingly rather than restructured: the ladder is monotone by
   * construction and adding a rung would change what the paired A-B-C-D-D-C-B-A
   * bracket is cancelling. The shipped night figure wants its own paired
   * lantern-on/lantern-off bracket at `water-receiver`, on a cold machine.
   */
  async function runDirectShadowBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const original = shadowing.snapshot();
    const gl = renderer.getContext();
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = rendererInfo
      ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
      : 'unreported WebGL renderer';
    const rows: DirectShadowBenchmarkRow[] = DIRECT_SHADOW_LADDER.map((rung) => ({
      ...rung,
      frame: [],
    }));
    const metadata = () =>
      `direct-light geometry shadow benchmark\n` +
      `GPU ${gpuName}\n` +
      `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}\n` +
      `A-B-C-D-D-C-B-A · ${OCEAN_PROBE_WARMUP_FRAMES} warm-up frames · ` +
      `${DIRECT_SHADOW_SAMPLE_COUNT} raw GPU rotations/row\n` +
      `A baseline: pre-existing 2048² vessel-only directional map\n` +
      `Sun path under test: water lookup + 83k-vertex displaced-ocean caster\n` +
      `lantern: 6 × 256² cube faces, vessel-only layer (ocean excluded)\n` +
      `SHIPPED = rung B by day, B + lantern by night. C (the displaced caster)\n` +
      `is off by default, and D is measured on top of C — so no row below is\n` +
      `the price of production. See runDirectShadowBenchmark's note.\n`;

    execution.active = true;
    try {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        shadowing.setBenchmarkSunMode(row.sunMode);
        shadowing.setLanternShadowing(row.lantern);
        onProgress(`${metadata()}\nwarming ${rowIndex + 1}/${rows.length}: ${row.label}`);
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
        gpuProfiler.start();
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (row.frame.length < DIRECT_SHADOW_SAMPLE_COUNT) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            row.frame.push(sample.timing.frame);
            if (row.frame.length >= DIRECT_SHADOW_SAMPLE_COUNT) break;
          }
          onProgress(
            `${metadata()}\nmeasuring ${rowIndex + 1}/${rows.length}: ${row.label}\n` +
              `raw rotations ${row.frame.length}/${DIRECT_SHADOW_SAMPLE_COUNT}`,
          );
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for “${row.label}”`);
          }
        }
      }

      const oldSolid = summarizeSamples([...rows[0].frame, ...rows[7].frame]);
      const receiver = summarizeSamples([...rows[1].frame, ...rows[6].frame]);
      const sunFull = summarizeSamples([...rows[2].frame, ...rows[5].frame]);
      const allNew = summarizeSamples([...rows[3].frame, ...rows[4].frame]);
      const receiverDelta = receiver.mean - oldSolid.mean;
      const swellCasterDelta = sunFull.mean - receiver.mean;
      const sunTotalDelta = sunFull.mean - oldSolid.mean;
      const lanternDelta = allNew.mean - sunFull.mean;
      const totalDelta = allNew.mean - oldSolid.mean;
      const standardError = (
        upper: ReturnType<typeof summarizeSamples>,
        lower: ReturnType<typeof summarizeSamples>,
      ): number =>
        Math.sqrt(
          upper.standardDeviation ** 2 / upper.count +
            lower.standardDeviation ** 2 / lower.count,
        );
      const lines = [
        metadata(),
        ...rows.map((row) => {
          const frame = summarizeSamples(row.frame);
          return `${row.label}: ${frame.mean.toFixed(2)} ± ${frame.standardDeviation.toFixed(2)} ms`;
        }),
        '',
        `A old solid-map baseline: ${oldSolid.mean.toFixed(2)} ± ${oldSolid.standardDeviation.toFixed(2)} ms · n=${oldSolid.count}`,
        `B + water receiver [SHIPPED]: ${receiver.mean.toFixed(2)} ± ${receiver.standardDeviation.toFixed(2)} ms · n=${receiver.count}`,
        `C + displaced swell caster [NOT shipped]: ${sunFull.mean.toFixed(2)} ± ${sunFull.standardDeviation.toFixed(2)} ms · n=${sunFull.count}`,
        `D + active lantern [on top of C]: ${allNew.mean.toFixed(2)} ± ${allNew.standardDeviation.toFixed(2)} ms · n=${allNew.count}`,
        '',
        `marginal water shadow lookup [SHIPPED daytime cost]: ${receiverDelta >= 0 ? '+' : ''}${receiverDelta.toFixed(2)} ± ${standardError(receiver, oldSolid).toFixed(2)} ms/frame`,
        `marginal displaced swell caster [NOT shipped]: ${swellCasterDelta >= 0 ? '+' : ''}${swellCasterDelta.toFixed(2)} ± ${standardError(sunFull, receiver).toFixed(2)} ms/frame`,
        `Sun total INCLUDING the unshipped caster: ${sunTotalDelta >= 0 ? '+' : ''}${sunTotalDelta.toFixed(2)} ± ${standardError(sunFull, oldSolid).toFixed(2)} ms/frame (${((sunTotalDelta / oldSolid.mean) * 100).toFixed(1)}%)`,
        `marginal active lantern shadow, measured over C: ${lanternDelta >= 0 ? '+' : ''}${lanternDelta.toFixed(2)} ± ${standardError(allNew, sunFull).toFixed(2)} ms/frame (${((lanternDelta / sunFull.mean) * 100).toFixed(1)}%)`,
        `A-to-D ladder total (includes the unshipped caster): ${totalDelta >= 0 ? '+' : ''}${totalDelta.toFixed(2)} ± ${standardError(allNew, oldSolid).toFixed(2)} ms/frame (${((totalDelta / oldSolid.mean) * 100).toFixed(1)}%)`,
        'The shipped night configuration (B + lantern) is not a rung here; it wants its own paired bracket.',
        'Lantern shadow cost is zero while its flame contribution is below 1e-4 (normally all daylight).',
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      shadowing.setSunShadowing(original.sun);
      shadowing.setLanternShadowing(original.lantern);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  /**
   * Price the hull's sky occlusion, A-B-B-A against itself.
   *
   * One uniform is the whole experiment: the shader path, the vertex count, the
   * draw calls and the shadow maps are byte-identical between rows, so anything
   * the bracket reports is the eight instructions of vesselSkyVisibility and
   * nothing else. A-B-B-A because the machine drifts — thermal state and other
   * windows move a full-frame mean by more than this term is likely to cost, and
   * a straight A-then-B would hand that drift to the feature as its price.
   *
   * Full-frame GPU timers, because a per-pass timer cannot see a term folded into
   * the ocean's existing fragment shader.
   */
  interface PairedToggleSubject {
    /** Appears at the head of the report. */
    title: string;
    /** Flip the one thing under test. Nothing else may differ between arms. */
    apply(on: boolean): void;
    /** Read the current state so the bracket can put it back afterwards. */
    read(): boolean;
  }

  async function runPairedToggleBenchmark(
    subject: PairedToggleSubject,
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const original = subject.read();
    const gl = renderer.getContext();
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = rendererInfo
      ? String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
      : 'unreported WebGL renderer';

    const blocks: { ao: boolean; frame: number[] }[] = [];
    for (let pair = 0; pair < VESSEL_AO_PAIRS; pair++) {
      blocks.push({ ao: false, frame: [] });
      blocks.push({ ao: true, frame: [] });
    }
    const metadata = () =>
      `${subject.title}\n` +
      `GPU ${gpuName}\n` +
      `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}\n` +
      `${VESSEL_AO_PAIRS} interleaved off/on pairs · ${VESSEL_AO_BLOCK} rotations per block\n` +
      `paired differences, so drift between pairs cancels instead of being charged to the feature\n`;

    execution.active = true;
    try {
      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        subject.apply(block.ao);
        onProgress(
          `${metadata()}\nblock ${index + 1}/${blocks.length} (${block.ao ? 'on' : 'off'})`,
        );
        // Timer queries retire several frames behind submission, so samples taken
        // straight after a switch still describe the previous state. Discarding a
        // warm-up window is what keeps the two arms from contaminating each other.
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
        gpuProfiler.start();
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (block.frame.length < VESSEL_AO_BLOCK) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            block.frame.push(sample.timing.frame);
            if (block.frame.length >= VESSEL_AO_BLOCK) break;
          }
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for block ${index + 1}`);
          }
        }
      }

      const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      const pairDeltas: number[] = [];
      for (let pair = 0; pair < VESSEL_AO_PAIRS; pair++) {
        const off = blocks[pair * 2];
        const on = blocks[pair * 2 + 1];
        pairDeltas.push(mean(on.frame) - mean(off.frame));
      }
      const deltaMean = mean(pairDeltas);
      const deltaSd = Math.sqrt(
        pairDeltas.reduce((a, d) => a + (d - deltaMean) ** 2, 0) /
          Math.max(pairDeltas.length - 1, 1),
      );
      const deltaSe = deltaSd / Math.sqrt(pairDeltas.length);
      const offAll = summarizeSamples(blocks.filter((b) => !b.ao).flatMap((b) => b.frame));
      const onAll = summarizeSamples(blocks.filter((b) => b.ao).flatMap((b) => b.frame));
      const lines = [
        metadata(),
        `frame time off: ${offAll.mean.toFixed(2)} ± ${offAll.standardDeviation.toFixed(2)} ms · n=${offAll.count}`,
        `frame time on:  ${onAll.mean.toFixed(2)} ± ${onAll.standardDeviation.toFixed(2)} ms · n=${onAll.count}`,
        '',
        `per-pair deltas (ms): ${pairDeltas.map((d) => d.toFixed(2)).join(', ')}`,
        `marginal cost: ${deltaMean >= 0 ? '+' : ''}${deltaMean.toFixed(3)} ± ${deltaSe.toFixed(3)} ms/frame ` +
          `(${((deltaMean / offAll.mean) * 100).toFixed(2)}%)`,
        `95% bound on the true cost: |cost| < ${(Math.abs(deltaMean) + 2 * deltaSe).toFixed(2)} ms/frame`,
        Math.abs(deltaMean) < 2 * deltaSe
          ? 'Not resolvable: the term is smaller than this machine can measure.'
          : 'Resolved above noise.',
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      subject.apply(original);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  interface WakeCostBenchmarkSubject {
    title: string;
    budgetMs: number;
    condition: () => string;
    apply(enabled: boolean): void;
    read(): boolean;
  }

  /**
   * Price a wake round through adjacent off/on pairs in both affected GPU passes.
   *
   * A prebuilt field keeps the intended R/G/B footprint representative in every
   * arm. World, waves and cloud cache are frozen, but FoamField keeps stepping so
   * the source-uniform loop is included rather than measured as dead history.
   */
  async function runWakeFeatureCostBenchmark(
    subject: WakeCostBenchmarkSubject,
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const PAIRS = 24;
    // Sixteen rotations makes each leg itself stable before pair differencing.
    // The first uncontended run used four and retained multi-millisecond leg
    // scatter even across 24 pairs; that evidence is preserved, but a future
    // rerun should spend the extra samples rather than over-read its mean.
    const ROTATIONS = 16;
    const SWITCH_WARMUP_FRAMES = 12;
    const STEADY_WARMUP_FRAMES = 90;
    const BUDGET_MS = subject.budgetMs;
    type TimingKey = 'frame' | 'ocean' | 'foamSimulation';
    type Leg = Record<TimingKey, number[]>;

    const originalSubject = subject.read();
    const worldState = world.state;
    const originalWorldRate = worldState.worldSecondsPerRealSecond;
    const originalWorldPaused = worldState.paused;
    const originalWaveFrozen = waves.frozen;
    const originalCloudFrozen = sky.cloudDome.frozen;
    const originalFoamFrozen = foamFreeze.value;

    const collectLeg = async (): Promise<Leg> => {
      const samples: Leg = { frame: [], ocean: [], foamSimulation: [] };
      gpuProfiler.start();
      let lastSerial = 0;
      const deadline = performance.now() + 30_000;
      while (samples.frame.length < ROTATIONS) {
        await nextPresentedFrame();
        for (const sample of gpuProfiler.rawSamples) {
          if (sample.serial <= lastSerial) continue;
          lastSerial = sample.serial;
          samples.frame.push(sample.timing.frame);
          samples.ocean.push(sample.timing.ocean);
          samples.foamSimulation.push(sample.timing.foamSimulation);
          if (samples.frame.length >= ROTATIONS) break;
        }
        if (performance.now() > deadline) {
          throw new Error('Timed out waiting for wake GPU samples');
        }
      }
      return samples;
    };

    const median = (leg: Leg, key: TimingKey): number =>
      summarizeSamples(leg[key]).median;
    const offMedians: Record<TimingKey, number[]> = {
      frame: [],
      ocean: [],
      foamSimulation: [],
    };
    const onMedians: Record<TimingKey, number[]> = {
      frame: [],
      ocean: [],
      foamSimulation: [],
    };
    const deltas: Record<TimingKey, number[]> = {
      frame: [],
      ocean: [],
      foamSimulation: [],
    };

    execution.active = true;
    try {
      worldState.worldSecondsPerRealSecond = 0;
      worldState.paused = true;
      waves.frozen = true;
      foamFreeze.value = false;
      await waitPresentedFrames(STEADY_WARMUP_FRAMES);
      sky.cloudDome.setFrozen(true);
      await waitPresentedFrames(STEADY_WARMUP_FRAMES);

      for (let pair = 0; pair < PAIRS; pair++) {
        subject.apply(false);
        await waitPresentedFrames(SWITCH_WARMUP_FRAMES);
        const off = await collectLeg();

        subject.apply(true);
        await waitPresentedFrames(SWITCH_WARMUP_FRAMES);
        const on = await collectLeg();

        for (const key of ['frame', 'ocean', 'foamSimulation'] as const) {
          const offMedian = median(off, key);
          const onMedian = median(on, key);
          offMedians[key].push(offMedian);
          onMedians[key].push(onMedian);
          deltas[key].push(onMedian - offMedian);
        }
        onProgress(`${subject.title}: pair ${pair + 1}/${PAIRS}`);
      }

      const gl = renderer.getContext() as WebGL2RenderingContext;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const device = info
        ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
        : 'unknown renderer';
      const describe = (label: string, key: TimingKey): string => {
        const off = summarizeSamples(offMedians[key]);
        const on = summarizeSamples(onMedians[key]);
        const delta = summarizeSamples(deltas[key]);
        const standardError = delta.standardDeviation / Math.sqrt(delta.count);
        return [
          `${label}`,
          `  off ${off.median.toFixed(3)} ms median · on ${on.median.toFixed(3)} ms median`,
          `  paired on−off ${delta.mean >= 0 ? '+' : ''}${delta.mean.toFixed(3)} ± ${standardError.toFixed(3)} ms (mean ± SE)`,
          `  median ${delta.median.toFixed(3)} · sd ${delta.standardDeviation.toFixed(3)} · range ${delta.minimum.toFixed(3)} to ${delta.maximum.toFixed(3)}`,
        ].join('\n');
      };
      const frameDelta = summarizeSamples(deltas.frame);
      const frameSe = frameDelta.standardDeviation / Math.sqrt(frameDelta.count);
      const lower95 = frameDelta.mean - 2 * frameSe;
      const upper95 = frameDelta.mean + 2 * frameSe;
      const verdict =
        upper95 <= BUDGET_MS
          ? `PASS: 95% upper estimate ${upper95.toFixed(3)} ms ≤ ${BUDGET_MS.toFixed(1)} ms budget.`
          : lower95 > BUDGET_MS
            ? `FAIL: 95% lower estimate ${lower95.toFixed(3)} ms exceeds ${BUDGET_MS.toFixed(1)} ms budget.`
            : `INCONCLUSIVE: estimate ${frameDelta.mean.toFixed(3)} ± ${frameSe.toFixed(3)} ms does not resolve the ${BUDGET_MS.toFixed(1)} ms budget boundary.`;

      return [
        subject.title,
        `GPU ${device}`,
        `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}`,
        subject.condition(),
        'world, waves and cloud cache frozen · FoamField stepping',
        `${PAIRS} adjacent off/on pairs · ${ROTATIONS} raw six-frame rotations per leg · ${SWITCH_WARMUP_FRAMES} switch warm-up frames`,
        '',
        describe('complete GPU frame', 'frame'),
        '',
        describe('ocean pass', 'ocean'),
        '',
        describe('foam simulation prefix', 'foamSimulation'),
        '',
        `per-pair frame deltas (ms): ${deltas.frame.map((value) => value.toFixed(3)).join(', ')}`,
        verdict,
      ].join('\n');
    } finally {
      subject.apply(originalSubject);
      sky.cloudDome.setFrozen(originalCloudFrozen);
      foamFreeze.value = originalFoamFrozen;
      waves.frozen = originalWaveFrozen;
      worldState.worldSecondsPerRealSecond = originalWorldRate;
      worldState.paused = originalWorldPaused;
      await waitPresentedFrames(10);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  /** Price WK1's complete trail through master-off/master-on pairs. */
  async function runWakeTrailCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    const originalBow = {
      collar: wakeState.wakeBowFeatureEnabled('collar'),
      wetHull: wakeState.wakeBowFeatureEnabled('wetHull'),
      mound: wakeState.wakeBowFeatureEnabled('bowMound'),
    };
    // The master owns every wake round. Hold WK2 off while pricing WK1 so this
    // strengthened rerun remains comparable with its first-run evidence.
    wakeState.setWakeBowFeatureEnabled('collar', false);
    wakeState.setWakeBowFeatureEnabled('wetHull', false);
    wakeState.setWakeBowFeatureEnabled('bowMound', false);
    try {
      return await runWakeFeatureCostBenchmark(
        {
          title: 'WK1 hull wake trail GPU cost',
          budgetMs: 0.6,
          condition: () =>
            `sea ${seaStates.state.name} · speed ` +
            `${wakeState.wakeSpeedThroughWaterMps().toFixed(3)} m/s · ` +
            'WK2 off · prebuilt 28 s trail',
          apply: (enabled) => {
            wakeState.setWakeEffectsEnabled(enabled);
          },
          read: () => wakeState.wakeEffectsEnabled(),
        },
        onProgress,
      );
    } finally {
      wakeState.setWakeBowFeatureEnabled('collar', originalBow.collar);
      wakeState.setWakeBowFeatureEnabled('wetHull', originalBow.wetHull);
      wakeState.setWakeBowFeatureEnabled('bowMound', originalBow.mound);
    }
  }

  /** Price WK2 incrementally while WK1 and the wake master remain enabled. */
  async function runWakeBowCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    const original = {
      collar: wakeState.wakeBowFeatureEnabled('collar'),
      wetHull: wakeState.wakeBowFeatureEnabled('wetHull'),
      mound: wakeState.wakeBowFeatureEnabled('bowMound'),
    };
    wakeState.setWakeBowFeatureEnabled('collar', true);
    wakeState.setWakeBowFeatureEnabled('wetHull', true);
    wakeState.setWakeBowFeatureEnabled('bowMound', true);
    try {
      return await runWakeFeatureCostBenchmark(
        {
          title: 'WK2 bow collar + wet hull + mound GPU cost',
          budgetMs: 0.2,
          condition: () =>
            `sea ${seaStates.state.name} · speed ` +
            `${wakeState.wakeSpeedThroughWaterMps().toFixed(3)} m/s · ` +
            'WK1 on · prebuilt 18 s bow collar',
          apply: (enabled) => {
            wakeState.setWakeBowFeatureEnabled('collar', enabled);
            wakeState.setWakeBowFeatureEnabled('wetHull', enabled);
            wakeState.setWakeBowFeatureEnabled('bowMound', enabled);
          },
          read: () =>
            wakeState.wakeBowFeatureEnabled('collar') &&
            wakeState.wakeBowFeatureEnabled('wetHull') &&
            wakeState.wakeBowFeatureEnabled('bowMound'),
        },
        onProgress,
      );
    } finally {
      wakeState.setWakeBowFeatureEnabled('collar', original.collar);
      wakeState.setWakeBowFeatureEnabled('wetHull', original.wetHull);
      wakeState.setWakeBowFeatureEnabled('bowMound', original.mound);
    }
  }

  /**
   * Bracket the complete legacy and active-window oceans A-B-B-A. This is the
   * landing metric: unlike the component sweep it includes every interaction in
   * the real shipping shader, while changing only the residual loop structure.
   */
  async function runOceanResidualActiveBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const originalSettings = { ...ocean.profileSettings };
    const originalLutEnabled = ocean.skyRadianceLutEnabled;
    const fullSettings = {
      ...originalSettings,
      vertexWaveSlots: 48,
      residualWaveSlots: 48,
      residualPhaseEnabled: true,
      detailOctaves: quality.detailOctaves,
      foamEnabled: true,
      flatFragment: false,
    };
    const rows: Array<{
      label: string;
      mode: 'shipping' | 'active';
      frame: number[];
      ocean: number[];
    }> = [
      { label: 'A1 legacy', mode: 'shipping', frame: [], ocean: [] },
      { label: 'B1 active', mode: 'active', frame: [], ocean: [] },
      { label: 'B2 active', mode: 'active', frame: [], ocean: [] },
      { label: 'A2 legacy', mode: 'shipping', frame: [], ocean: [] },
    ];
    const metadata = () =>
      `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}\n` +
      `full ocean · A-B-B-A · ${OCEAN_PROBE_WARMUP_FRAMES} warm-up frames · ${OCEAN_PROBE_SAMPLE_COUNT} raw rotations/row\n`;

    execution.active = true;
    try {
      sky.setRadianceLutEnabled(true);
      ocean.setSkyRadianceLutEnabled(true);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        ocean.setProfileSettings({ ...fullSettings, residualLoopMode: row.mode });
        onProgress(`${metadata()}\nwarming ${rowIndex + 1}/${rows.length}: ${row.label}`);
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
        gpuProfiler.start();
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (row.frame.length < OCEAN_PROBE_SAMPLE_COUNT) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            row.frame.push(sample.timing.frame);
            row.ocean.push(sample.timing.ocean);
            if (row.frame.length >= OCEAN_PROBE_SAMPLE_COUNT) break;
          }
          onProgress(
            `${metadata()}\nmeasuring ${rowIndex + 1}/${rows.length}: ${row.label}\n` +
              `raw rotations ${row.frame.length}/${OCEAN_PROBE_SAMPLE_COUNT}`,
          );
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for “${row.label}”`);
          }
        }
      }

      const legacyFrame = [...rows[0].frame, ...rows[3].frame];
      const activeFrame = [...rows[1].frame, ...rows[2].frame];
      const legacyOcean = [...rows[0].ocean, ...rows[3].ocean];
      const activeOcean = [...rows[1].ocean, ...rows[2].ocean];
      const legacy = summarizeSamples(legacyFrame);
      const active = summarizeSamples(activeFrame);
      const legacyOceanSummary = summarizeSamples(legacyOcean);
      const activeOceanSummary = summarizeSamples(activeOcean);
      const delta = active.mean - legacy.mean;
      const deltaStandardError = Math.sqrt(
        active.standardDeviation ** 2 / active.count +
          legacy.standardDeviation ** 2 / legacy.count,
      );
      const percent = (-delta / legacy.mean) * 100;
      const lines = [
        'residual active-window benchmark',
        metadata(),
        ...rows.flatMap((row) => {
          const frame = summarizeSamples(row.frame);
          return [
            `${row.label}: frame ${frame.mean.toFixed(2)} ± ${frame.standardDeviation.toFixed(2)} ms`,
          ];
        }),
        '',
        `legacy aggregate: ${legacy.mean.toFixed(2)} ± ${legacy.standardDeviation.toFixed(2)} ms · n=${legacy.count}`,
        `active aggregate: ${active.mean.toFixed(2)} ± ${active.standardDeviation.toFixed(2)} ms · n=${active.count}`,
        `whole-frame gain: ${(-delta).toFixed(2)} ± ${deltaStandardError.toFixed(2)} ms (${percent.toFixed(1)}%)`,
        `ocean-prefix cross-check: ${legacyOceanSummary.mean.toFixed(2)} → ${activeOceanSummary.mean.toFixed(2)} ms`,
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      ocean.setProfileSettings(originalSettings);
      sky.setRadianceLutEnabled(originalLutEnabled);
      ocean.setSkyRadianceLutEnabled(originalLutEnabled);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  /**
   * Bracket the complete five-octave and detail-disabled oceans A-B-B-A while
   * holding the new residual active window and every other shader region fixed.
   * This is the recoverable ceiling for the detail lane in the real shader.
   */
  async function runOceanDetailBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const originalSettings = { ...ocean.profileSettings };
    const originalLutEnabled = ocean.skyRadianceLutEnabled;
    const fullSettings = {
      ...originalSettings,
      vertexWaveSlots: 48,
      residualWaveSlots: 48,
      residualPhaseEnabled: true,
      residualLoopMode: 'active' as const,
      foamEnabled: true,
      flatFragment: false,
    };
    const rows: Array<{
      label: string;
      octaves: number;
      frame: number[];
      ocean: number[];
    }> = [
      { label: `A1 detail ×${quality.detailOctaves}`, octaves: quality.detailOctaves, frame: [], ocean: [] },
      { label: 'B1 detail disabled', octaves: 0, frame: [], ocean: [] },
      { label: 'B2 detail disabled', octaves: 0, frame: [], ocean: [] },
      { label: `A2 detail ×${quality.detailOctaves}`, octaves: quality.detailOctaves, frame: [], ocean: [] },
    ];
    const metadata = () =>
      `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}\n` +
      `full active-window ocean · detail ${quality.detailOctaves} vs 0 · A-B-B-A\n` +
      `${OCEAN_PROBE_WARMUP_FRAMES} warm-up frames · ${OCEAN_PROBE_SAMPLE_COUNT} raw rotations/row\n`;

    execution.active = true;
    try {
      sky.setRadianceLutEnabled(true);
      ocean.setSkyRadianceLutEnabled(true);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        ocean.setProfileSettings({ ...fullSettings, detailOctaves: row.octaves });
        onProgress(`${metadata()}\nwarming ${rowIndex + 1}/${rows.length}: ${row.label}`);
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
        gpuProfiler.start();
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (row.frame.length < OCEAN_PROBE_SAMPLE_COUNT) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            row.frame.push(sample.timing.frame);
            row.ocean.push(sample.timing.ocean);
            if (row.frame.length >= OCEAN_PROBE_SAMPLE_COUNT) break;
          }
          onProgress(
            `${metadata()}\nmeasuring ${rowIndex + 1}/${rows.length}: ${row.label}\n` +
              `raw rotations ${row.frame.length}/${OCEAN_PROBE_SAMPLE_COUNT}`,
          );
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for “${row.label}”`);
          }
        }
      }

      const detailFrame = [...rows[0].frame, ...rows[3].frame];
      const disabledFrame = [...rows[1].frame, ...rows[2].frame];
      const detailOcean = [...rows[0].ocean, ...rows[3].ocean];
      const disabledOcean = [...rows[1].ocean, ...rows[2].ocean];
      const detail = summarizeSamples(detailFrame);
      const disabled = summarizeSamples(disabledFrame);
      const detailOceanSummary = summarizeSamples(detailOcean);
      const disabledOceanSummary = summarizeSamples(disabledOcean);
      const cost = detail.mean - disabled.mean;
      const standardError = Math.sqrt(
        detail.standardDeviation ** 2 / detail.count +
          disabled.standardDeviation ** 2 / disabled.count,
      );
      const percent = (cost / detail.mean) * 100;
      const lines = [
        'detail stack benchmark',
        metadata(),
        ...rows.map((row) => {
          const frame = summarizeSamples(row.frame);
          return `${row.label}: frame ${frame.mean.toFixed(2)} ± ${frame.standardDeviation.toFixed(2)} ms`;
        }),
        '',
        `detail aggregate: ${detail.mean.toFixed(2)} ± ${detail.standardDeviation.toFixed(2)} ms · n=${detail.count}`,
        `disabled aggregate: ${disabled.mean.toFixed(2)} ± ${disabled.standardDeviation.toFixed(2)} ms · n=${disabled.count}`,
        `whole-frame detail cost: ${cost.toFixed(2)} ± ${standardError.toFixed(2)} ms (${percent.toFixed(1)}%)`,
        `ocean-prefix cross-check: ${detailOceanSummary.mean.toFixed(2)} → ${disabledOceanSummary.mean.toFixed(2)} ms`,
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      ocean.setProfileSettings(originalSettings);
      sky.setRadianceLutEnabled(originalLutEnabled);
      ocean.setSkyRadianceLutEnabled(originalLutEnabled);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  const detailRepresentationLabel = (
    representation: OceanDetailRepresentation,
    textureStyle: string,
  ): string => {
    if (representation === 'analytic') return 'analytic';
    if (representation === 'prefiltered') return `prefiltered ${textureStyle}`;
    if (representation === 'cached-256') return 'faithful cache 256²';
    if (representation === 'cached-512') return 'faithful cache 512²';
    if (representation === 'cached-768') return 'faithful cache 768²';
    if (representation === 'cached-1024') return 'faithful cache 1024²';
    if (representation === 'cached-2048') return 'faithful cache 2048²';
    return 'hybrid analytic 0–2 + filtered micro';
  };

  /** Compare shipping analytic detail with the selected replacement candidate. */
  async function runOceanDetailRepresentationBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    const originalSettings = { ...ocean.profileSettings };
    const originalLutEnabled = ocean.skyRadianceLutEnabled;
    const candidateRepresentation: OceanDetailRepresentation =
      originalSettings.detailRepresentation === 'analytic'
        ? 'cached-2048'
        : originalSettings.detailRepresentation;
    const fullSettings = {
      ...originalSettings,
      vertexWaveSlots: 48,
      residualWaveSlots: 48,
      residualPhaseEnabled: true,
      residualLoopMode: 'active' as const,
      detailOctaves: quality.detailOctaves,
      foamEnabled: true,
      flatFragment: false,
    };
    const rows: Array<{
      label: string;
      representation: OceanDetailRepresentation;
      frame: number[];
      ocean: number[];
    }> = [
      { label: 'A1 analytic', representation: 'analytic', frame: [], ocean: [] },
      {
        label: `B1 ${detailRepresentationLabel(candidateRepresentation, fullSettings.detailTextureStyle)}`,
        representation: candidateRepresentation,
        frame: [],
        ocean: [],
      },
      {
        label: `B2 ${detailRepresentationLabel(candidateRepresentation, fullSettings.detailTextureStyle)}`,
        representation: candidateRepresentation,
        frame: [],
        ocean: [],
      },
      { label: 'A2 analytic', representation: 'analytic', frame: [], ocean: [] },
    ];
    const metadata = () =>
      `buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}\n` +
      `full active-window ocean · analytic vs ${detailRepresentationLabel(candidateRepresentation, fullSettings.detailTextureStyle)} · A-B-B-A\n` +
      `${OCEAN_PROBE_WARMUP_FRAMES} warm-up frames · ${OCEAN_PROBE_SAMPLE_COUNT} raw rotations/row\n`;

    execution.active = true;
    try {
      sky.setRadianceLutEnabled(true);
      ocean.setSkyRadianceLutEnabled(true);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        ocean.setProfileSettings({
          ...fullSettings,
          detailRepresentation: row.representation,
        });
        onProgress(`${metadata()}\nwarming ${rowIndex + 1}/${rows.length}: ${row.label}`);
        await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
        gpuProfiler.start();
        let lastSerial = 0;
        const deadline = performance.now() + 30_000;
        while (row.frame.length < OCEAN_PROBE_SAMPLE_COUNT) {
          await nextPresentedFrame();
          for (const sample of gpuProfiler.rawSamples) {
            if (sample.serial <= lastSerial) continue;
            lastSerial = sample.serial;
            row.frame.push(sample.timing.frame);
            row.ocean.push(sample.timing.ocean);
            if (row.frame.length >= OCEAN_PROBE_SAMPLE_COUNT) break;
          }
          onProgress(
            `${metadata()}\nmeasuring ${rowIndex + 1}/${rows.length}: ${row.label}\n` +
              `raw rotations ${row.frame.length}/${OCEAN_PROBE_SAMPLE_COUNT}`,
          );
          if (performance.now() > deadline) {
            throw new Error(`Timed out waiting for GPU samples for “${row.label}”`);
          }
        }
      }

      const analytic = summarizeSamples([...rows[0].frame, ...rows[3].frame]);
      const candidate = summarizeSamples([...rows[1].frame, ...rows[2].frame]);
      const analyticOcean = summarizeSamples([...rows[0].ocean, ...rows[3].ocean]);
      const candidateOcean = summarizeSamples([...rows[1].ocean, ...rows[2].ocean]);
      const saving = analytic.mean - candidate.mean;
      const standardError = Math.sqrt(
        analytic.standardDeviation ** 2 / analytic.count +
          candidate.standardDeviation ** 2 / candidate.count,
      );
      const lines = [
        'detail representation benchmark',
        metadata(),
        ...rows.map((row) => {
          const frame = summarizeSamples(row.frame);
          return `${row.label}: frame ${frame.mean.toFixed(2)} ± ${frame.standardDeviation.toFixed(2)} ms`;
        }),
        '',
        `analytic aggregate: ${analytic.mean.toFixed(2)} ± ${analytic.standardDeviation.toFixed(2)} ms · n=${analytic.count}`,
        `candidate aggregate: ${candidate.mean.toFixed(2)} ± ${candidate.standardDeviation.toFixed(2)} ms · n=${candidate.count}`,
        `whole-frame saving: ${saving.toFixed(2)} ± ${standardError.toFixed(2)} ms (${((saving / analytic.mean) * 100).toFixed(1)}%)`,
        `ocean-prefix cross-check: ${analyticOcean.mean.toFixed(2)} → ${candidateOcean.mean.toFixed(2)} ms`,
      ];
      const report = lines.join('\n');
      onProgress(report);
      return report;
    } finally {
      ocean.setProfileSettings(originalSettings);
      sky.setRadianceLutEnabled(originalLutEnabled);
      ocean.setSkyRadianceLutEnabled(originalLutEnabled);
      await waitPresentedFrames(OCEAN_PROBE_WARMUP_FRAMES);
      gpuProfiler.start();
      execution.active = false;
    }
  }

  /**
   * What the repaired whitewater layer costs.
   *
   * The registration fix does not add a pass to the ocean shader. It makes an
   * existing one run. `coverage > 0.004` was false almost everywhere while the
   * persistent field was being faded to zero, so the breakup fBm, the second fine
   * cut, the relief `noised` and the foam BRDF were all being branched over on
   * nearly every water pixel; now they execute. That is the whole cost question,
   * and it is measurable without a second build: park the foam window back out at
   * the offset the drift used to leave it at, and the same shader takes the same
   * branch it used to.
   *
   * Bracketed A-B-B-A so a thermal ramp across the run cannot masquerade as the
   * difference.
   */
  async function runWhitewaterCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string> {
    if (execution.active) throw new Error('Ocean component probe is already running');
    if (!gpuProfiler.reading.supported) {
      throw new Error('This browser/GPU does not expose WebGL timer queries');
    }

    // The measured origin at which both fades evaluated to zero, from the running
    // app before the fix.
    const UNREGISTERED = new THREE.Vector2(38.3, 1520.6);
    const REGISTERED = new THREE.Vector2(0, 0);
    /** Alternations. Each contributes one paired A−B difference. */
    const PAIRS = 24;
    /** Raw six-frame prefix rotations collected per leg. */
    const ROTATIONS = 4;
    const WARMUP = 90;

    // The probe reproduces the historical unregistered window by moving both
    // level origins; the foam sim is frozen for the whole run, so only the
    // lookup consumes them and the sub-texel scroll remainders are undisturbed
    // state to restore afterwards.
    const restoreNearOrigin = foam.nearOrigin.clone();
    const restoreFarOrigin = foam.farOrigin.clone();
    const worldState = world.state;
    const restoreRate = worldState.worldSecondsPerRealSecond;
    const restorePaused = worldState.paused;
    const restoreWaveTime = waves.time;
    const restoreCloudFrozen = sky.cloudDome.frozen;
    const restoreFoamFrozen = foamFreeze.value;

    let lastSerial = 0;
    /** Collect from one leg, at the origin already set. */
    const collect = async (rotations: number): Promise<number[]> => {
      const samples: number[] = [];
      const deadline = performance.now() + 20_000;
      while (samples.length < rotations) {
        await nextPresentedFrame();
        for (const sample of gpuProfiler.rawSamples) {
          if (sample.serial <= lastSerial) continue;
          lastSerial = sample.serial;
          samples.push(sample.timing.ocean);
          if (samples.length >= rotations) break;
        }
        if (performance.now() > deadline) throw new Error('Timed out waiting for GPU samples');
      }
      return samples;
    };

    execution.active = true;
    try {
      // Freeze everything that could differ between two samples. The first
      // attempt at this measurement left the world running and the cloud cache
      // baking, and the per-leg medians simply fell monotonically across the run:
      // a thermal and warm-up trend an order of magnitude larger than the effect,
      // with A and B indistinguishable inside it.
      worldState.worldSecondsPerRealSecond = 0;
      worldState.paused = true;
      waves.frozen = true;
      foamFreeze.value = true;
      foam.nearOrigin.copy(REGISTERED);
      foam.farOrigin.copy(REGISTERED);
      await waitPresentedFrames(WARMUP);
      sky.cloudDome.setFrozen(true);
      await waitPresentedFrames(WARMUP);

      gpuProfiler.start();
      await collect(4);

      const unregistered: number[] = [];
      const registered: number[] = [];
      const differences: number[] = [];
      for (let pair = 0; pair < PAIRS; pair++) {
        foam.nearOrigin.copy(UNREGISTERED);
        foam.farOrigin.copy(UNREGISTERED);
        const a = await collect(ROTATIONS);
        foam.nearOrigin.copy(REGISTERED);
        foam.farOrigin.copy(REGISTERED);
        const b = await collect(ROTATIONS);
        const aMedian = summarizeSamples(a).median;
        const bMedian = summarizeSamples(b).median;
        unregistered.push(aMedian);
        registered.push(bMedian);
        // Paired, and adjacent in time: any drift shared by the two legs cancels
        // instead of being attributed to whichever went first.
        differences.push(bMedian - aMedian);
        onProgress(`whitewater cost: pair ${pair + 1}/${PAIRS}`);
      }

      const a = summarizeSamples(unregistered);
      const b = summarizeSamples(registered);
      const d = summarizeSamples(differences);
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const device = info
        ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
        : 'unknown renderer';

      return [
        `whitewater cost · buffer ${canvas.width}×${canvas.height} · DPR ${renderer.getPixelRatio().toFixed(2)}`,
        `sea ${seaStates.state.name} · world, waves, foam history and cloud cache all frozen`,
        `${PAIRS} alternating pairs · ${ROTATIONS} raw rotations per leg`,
        device,
        '',
        `A unregistered (the old behaviour, foam faded to nothing)`,
        `  ocean ${a.median.toFixed(3)} ms median, sd ${a.standardDeviation.toFixed(3)}`,
        `B registered (foam drawn)`,
        `  ocean ${b.median.toFixed(3)} ms median, sd ${b.standardDeviation.toFixed(3)}`,
        '',
        `paired B−A  ${d.median.toFixed(3)} ms median, mean ${d.mean.toFixed(3)}, sd ${d.standardDeviation.toFixed(3)}`,
        `            range ${d.minimum.toFixed(3)} to ${d.maximum.toFixed(3)} over ${d.count} pairs`,
      ].join('\n');
    } finally {
      foam.nearOrigin.copy(restoreNearOrigin);
      foam.farOrigin.copy(restoreFarOrigin);
      sky.cloudDome.setFrozen(restoreCloudFrozen);
      foamFreeze.value = restoreFoamFrozen;
      waves.frozen = seaStates.state.frozen === true;
      worldState.worldSecondsPerRealSecond = restoreRate;
      worldState.paused = restorePaused;
      waves.setTime(restoreWaveTime);
      await waitPresentedFrames(10);
      gpuProfiler.start();
      execution.active = false;
    }
  }
  return {
    runOceanProfileProbe,
    runDirectShadowBenchmark,
    runPairedToggleBenchmark,
    runWakeTrailCostBenchmark,
    runWakeBowCostBenchmark,
    runOceanResidualActiveBenchmark,
    runOceanDetailBenchmark,
    runOceanDetailRepresentationBenchmark,
    runWhitewaterCostBenchmark,
  };
}
