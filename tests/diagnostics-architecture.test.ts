import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createDiagnosticExecutionGate } from '../src/runtime/diagnostics/RuntimeDiagnostics';
import { DIRECT_SHADOW_LADDER } from '../src/runtime/diagnostics/RuntimeBenchmarkDiagnostics';
import type {
  SimCapability,
  SimHandle,
} from '../src/runtime/diagnostics/SimHandle';

describe('diagnostics architecture', () => {
  it('shares one mutable, allocation-free execution gate', () => {
    const gate = createDiagnosticExecutionGate();
    const sameGate = gate;
    expect(gate.active).toBe(false);
    gate.active = true;
    expect(sameGate.active).toBe(true);
  });

  /**
   * A benchmark rung's NAME is the only thing between its number and a wrong
   * conclusion, and this ladder's names went stale in silence.
   *
   * `?perf=direct-shadows` was written when the sea cast into the Sun's map by
   * default, so its top rung was production and its "all new direct-water
   * shadows" line was the price of the feature. The sea stopped casting; the
   * ladder went on describing the old world (`SHADOW_ROUND_HANDOVER`, "row
   * labels are stale — the levers work; the names describe the old world").
   *
   * What must hold is that the ladder says which of its rungs the game actually
   * renders, and that the sun modes it drives still match that claim.
   */
  it('names the shipped rung of the direct-shadow ladder', () => {
    const shipped = DIRECT_SHADOW_LADDER.filter((rung) => rung.shipped);
    // The paired A-B-C-D-D-C-B-A bracket visits the shipped rung twice.
    expect(shipped).toHaveLength(2);
    for (const rung of shipped) {
      // Production is the water RECEIVER: the sea takes the hull's shadow and
      // does not cast into the map. `EnvironmentRuntime.setSunShadowing` says
      // the same thing — "never full casting".
      expect(rung.sunMode).toBe('water-receiver');
      expect(rung.lantern).toBe(false);
      expect(rung.label).toContain('SHIPPED');
    }
    for (const rung of DIRECT_SHADOW_LADDER) {
      if (rung.shipped) continue;
      expect(rung.label, rung.label).not.toMatch(/\[SHIPPED\]/);
      // Every unshipped rung has to say so, one way or another, so no row of
      // the report can be read as the price of production.
      expect(
        /NOT shipped|on top of C|old solid Sun map/.test(rung.label)
          ? null
          : `unmarked rung "${rung.label}"`,
      ).toBeNull();
    }
    // The bracket has to be symmetric or it cancels drift into the feature.
    const modes = DIRECT_SHADOW_LADDER.map((rung) => rung.sunMode);
    expect(modes).toEqual([...modes].reverse());
  });

  it('keeps debug modules independent of the browser entry module', () => {
    const entryImport =
      /(?:from\s+|import\s*(?:\(\s*)?)["']\.\.\/main(?:\.ts)?["']/;
    const offenders = readdirSync('src/debug')
      .filter((file) => file.endsWith('.ts'))
      .filter((file) =>
        entryImport.test(readFileSync(join('src/debug', file), 'utf8')),
      );

    expect(offenders).toEqual([]);
  });

  it('gives each ordinary debug tool an explicit narrow capability', () => {
    const debugFiles = readdirSync('src/debug')
      .filter((file) => file.endsWith('.ts'));
    const broadFacadeOffenders = debugFiles.filter((file) => {
      const source = readFileSync(join('src/debug', file), 'utf8')
        .replaceAll('../runtime/diagnostics/SimHandle', '');
      return /\bSimHandle\b/.test(source);
    });
    const unnamedCapabilityOffenders = debugFiles.flatMap((file) => {
      const source = readFileSync(join('src/debug', file), 'utf8');
      return Array.from(source.matchAll(/\bsim\s*:\s*([A-Za-z_$][\w$]*)/g))
        .filter((match) => !match[1]?.endsWith('Capability'))
        .map((match) => `${file}:${match[1]}`);
    });

    expect(broadFacadeOffenders).toEqual([]);
    expect(unnamedCapabilityOffenders).toEqual([]);
    expectTypeOf<keyof SimCapability<'renderFrame' | 'stepSimulation'>>()
      .toEqualTypeOf<'renderFrame' | 'stepSimulation'>();
    expectTypeOf<SimHandle>()
      .toMatchTypeOf<SimCapability<'renderFrame' | 'stepSimulation'>>();
    expectTypeOf<SimCapability<'renderFrame'>>()
      .not.toMatchTypeOf<SimHandle>();
  });

  it('owns URL evidence dispatch without eagerly loading debug implementations', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const host = readFileSync(
      'src/runtime/diagnostics/startEvidenceHosts.ts',
      'utf8',
    );

    expect(host).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(host).toContain("await import('../../debug/labCapture')");
    expect(host).toContain("import('../../debug/SchoonerViewer')");
    expect(main).not.toContain("import('./debug/labCapture')");
    expect(main).not.toContain("import('./debug/terrainDepthEvidence')");
    expect(main).not.toContain("import('./debug/terrainBaselineEvidence')");
    expect(main).not.toContain("import('./debug/SchoonerViewer')");

    const binding = main.indexOf(
      'const simHandleBinding = createSimHandleBinding();',
    );
    const ui = main.indexOf(
      'const runtimeUi: RuntimeUi = new RuntimeUi({',
    );
    const diagnostics = main.indexOf(
      'const runtimeDiagnostics = createRuntimeDiagnostics({',
    );
    const sim = main.indexOf(
      'const sim: SimHandle = simHandleBinding.bind(',
    );

    const performanceHosts = main.indexOf('startPerformanceEvidenceHosts({');
    const terrainMount = main.indexOf(
      'if (runtimeOptions.syntheticTerrainEnabled)',
    );
    const terrainHosts = main.indexOf(
      'startTerrainAndViewerEvidenceHosts({',
    );
    const animationLoopSelection = main.indexOf(
      'if (buoyancyLabEnabled) {',
      terrainHosts,
    );

    expect(binding).toBeGreaterThan(-1);
    expect(binding).toBeLessThan(ui);
    expect(ui).toBeLessThan(diagnostics);
    expect(diagnostics).toBeLessThan(sim);
    expect(sim).toBeLessThan(performanceHosts);
    expect(performanceHosts).toBeLessThan(terrainMount);
    expect(terrainMount).toBeLessThan(terrainHosts);
    expect(terrainHosts).toBeLessThan(animationLoopSelection);
  });

  it('assembles and synchronously binds SimHandle outside the browser entry', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const factory = readFileSync(
      'src/runtime/diagnostics/createSimHandle.ts',
      'utf8',
    );

    expect(main).toContain('createSimHandle(');
    expect(main).toContain('getSimHandle: simHandleBinding.get,');
    expect(main).not.toContain('const sim: SimHandle = {');
    expect(main).not.toContain('function foamOptions()');
    expect(factory).toContain('export function createSimHandleBinding()');
    expect(factory).toContain('export function createSimHandle(');
    expect(factory).toContain('function foamOptions()');
    expect(factory).not.toContain("from '../../main'");
    expect(factory).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(factory).not.toContain('startPerformanceEvidenceHosts');
    expect(factory).not.toContain('startTerrainAndViewerEvidenceHosts');
    expect(factory).toContain("import type { SimHandle } from './SimHandle'");
    expect(factory).toContain(
      "import type { RuntimeDiagnostics } from './RuntimeDiagnosticsContract'",
    );
  });

  it('keeps benchmark execution and frame readback behind one runtime gate', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const facade = readFileSync(
      'src/runtime/diagnostics/RuntimeDiagnostics.ts',
      'utf8',
    );
    const contract = readFileSync(
      'src/runtime/diagnostics/RuntimeDiagnosticsContract.ts',
      'utf8',
    );
    const benchmarks = readFileSync(
      'src/runtime/diagnostics/RuntimeBenchmarkDiagnostics.ts',
      'utf8',
    );
    const visual = readFileSync(
      'src/runtime/diagnostics/RuntimeVisualDiagnostics.ts',
      'utf8',
    );
    const frameDriver = readFileSync(
      'src/runtime/BrowserFrameDriver.ts',
      'utf8',
    );

    expect(main).not.toContain('async function runOceanProfileProbe(');
    expect(main).not.toContain('async function runWhitewaterCostBenchmark(');
    expect(main).not.toContain('function serviceFrameReadback()');
    expect(main).not.toContain('pendingFrameReadback');
    expect(facade).not.toContain('async function runOceanProfileProbe(');
    expect(benchmarks).toContain('async function runOceanProfileProbe(');
    expect(benchmarks).toContain('async function runWhitewaterCostBenchmark(');
    expect(visual).toContain('function serviceFrameReadback()');
    expect(visual).toContain('let pendingFrameReadback:');
    expect(benchmarks).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(visual).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(visual).toContain(
      "await import('../../debug/oceanViolenceContactSheet')",
    );

    expect(facade).toContain("from './RuntimeBenchmarkDiagnostics'");
    expect(facade).toContain("from './RuntimeVisualDiagnostics'");
    expect(benchmarks).toContain("from './RuntimeDiagnosticsContract'");
    expect(visual).toContain("from './RuntimeDiagnosticsContract'");
    expect(contract).not.toContain('RuntimeBenchmarkDiagnostics');
    expect(contract).not.toContain('RuntimeVisualDiagnostics');
    expect(benchmarks).not.toContain('RuntimeVisualDiagnostics');
    expect(visual).not.toContain('RuntimeBenchmarkDiagnostics');
    expect(contract).not.toContain("from '../../main'");

    expect(main).toContain(
      'const diagnosticExecution = createDiagnosticExecutionGate();',
    );
    expect(main).toContain('execution: diagnosticExecution,');
    expect(frameDriver.match(/options\.execution\.active/g)).toHaveLength(3);
    expect(main.indexOf('const initialFrameClockMilliseconds = performance.now();'))
      .toBeLessThan(
        main.indexOf(
          'const diagnosticExecution = createDiagnosticExecutionGate();',
        ),
      );

    const render = frameDriver.indexOf('options.renderFrame();');
    const gpuEnd = frameDriver.indexOf('options.gpuProfiler.endFrame();', render);
    const readback = frameDriver.indexOf(
      'options.serviceFrameReadback();',
      gpuEnd,
    );
    const capture = frameDriver.indexOf(
      'if (import.meta.env.DEV) options.captureIfRequested?.();',
      readback,
    );
    const adaptation = frameDriver.indexOf(
      'this.adaptElapsedSeconds += presentationDeltaSeconds;',
      capture,
    );

    expect(render).toBeGreaterThan(-1);
    expect(render).toBeLessThan(gpuEnd);
    expect(gpuEnd).toBeLessThan(readback);
    expect(readback).toBeLessThan(capture);
    expect(capture).toBeLessThan(adaptation);
  });
});
