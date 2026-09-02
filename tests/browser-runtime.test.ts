import { describe, expect, it } from 'vitest';
import {
  BrowserFrameDriver,
  type BrowserFrameDriverOptions,
  type BrowserFrameDriverReading,
} from '../src/runtime/BrowserFrameDriver';
import {
  BrowserViewport,
  type BrowserViewportHost,
} from '../src/runtime/BrowserViewport';

type FailurePoint = 'gpuBegin' | 'step' | 'render';

function createFrameHarness(options: {
  fixedPixelRatio?: number;
  adaptiveResolutionPolicy?: BrowserFrameDriverOptions['adaptiveResolutionPolicy'];
} = {}) {
  const calls: string[] = [];
  const steps: Array<[number, number]> = [];
  const readings: BrowserFrameDriverReading[] = [];
  const appliedCaps: Array<{ cap: number; publishedCap: number }> = [];
  const state: {
    now: number;
    hidden: boolean;
    cloudSwapped: boolean;
    failure?: FailurePoint;
  } = {
    now: 1_000,
    hidden: false,
    cloudSwapped: false,
  };
  const execution = { active: false };
  let driver: BrowserFrameDriver;

  driver = new BrowserFrameDriver({
    initialNowMilliseconds: state.now,
    nowMilliseconds: () => state.now,
    documentHidden: () => state.hidden,
    pollViewport: () => calls.push('viewport'),
    cpuProfiler: {
      beginFrame: () => calls.push('cpu.begin'),
      endFrame: () => calls.push('cpu.end'),
      start: () => calls.push('cpu.start'),
    },
    gpuProfiler: {
      beginFrame() {
        calls.push('gpu.begin');
        if (state.failure === 'gpuBegin') throw new Error('gpu begin failed');
      },
      endFrame: () => calls.push('gpu.end'),
      start: () => calls.push('gpu.start'),
    },
    execution,
    stepSimulation(presentationDeltaSeconds, rawRealDeltaSeconds) {
      calls.push('step');
      steps.push([presentationDeltaSeconds, rawRealDeltaSeconds]);
      if (state.failure === 'step') throw new Error('step failed');
    },
    renderFrame() {
      calls.push('render');
      if (state.failure === 'render') throw new Error('render failed');
    },
    cloudCacheSwapped() {
      calls.push('cloud');
      return state.cloudSwapped;
    },
    serviceFrameReadback: () => calls.push('readback'),
    captureIfRequested: () => calls.push('capture'),
    fixedPixelRatio: options.fixedPixelRatio,
    adaptivePixelRatioTarget: 2,
    initialPixelRatioCap: 2,
    applyPixelRatio(cap) {
      calls.push('applyPixelRatio');
      appliedCaps.push({ cap, publishedCap: driver.reading.pixelRatioCap });
    },
    afterFrame(reading) {
      calls.push('afterFrame');
      readings.push(reading);
    },
    adaptiveResolutionPolicy: options.adaptiveResolutionPolicy,
  });

  return { appliedCaps, calls, driver, execution, readings, state, steps };
}

function advanceFrames(
  harness: ReturnType<typeof createFrameHarness>,
  count: number,
  milliseconds = 50,
): void {
  for (let frame = 0; frame < count; frame++) {
    harness.state.now += milliseconds;
    harness.driver.frame();
  }
}

describe('browser frame driver', () => {
  it('preserves normal callback order and the bounded/raw frame deltas', () => {
    const harness = createFrameHarness();
    harness.state.now = 1_120;

    harness.driver.frame();

    expect(harness.calls).toEqual([
      'cpu.begin',
      'viewport',
      'gpu.begin',
      'step',
      'render',
      'gpu.end',
      'cloud',
      'readback',
      'capture',
      'afterFrame',
      'cpu.end',
    ]);
    expect(harness.steps).toEqual([[0.05, 0.12]]);
    expect(harness.driver.reading).toMatchObject({
      rawRealDeltaMilliseconds: 120,
      rawRealDeltaSeconds: 0.12,
      presentationDeltaSeconds: 0.05,
      adaptiveFrameAverageMilliseconds: 21.865,
      profilingReady: false,
      pixelRatioCap: 2,
    });
  });

  it('freezes only normal-loop deltas for diagnostics and retains the hidden tail', () => {
    const harness = createFrameHarness();
    harness.execution.active = true;
    harness.state.now = 1_120;
    harness.driver.frame();
    const visibleAverage =
      harness.driver.reading.adaptiveFrameAverageMilliseconds;

    harness.execution.active = false;
    harness.state.hidden = true;
    harness.state.now = 1_240;
    harness.driver.frame();

    expect(harness.steps).toEqual([
      [0, 0],
      [0.05, 0.12],
    ]);
    expect(harness.driver.reading.adaptiveFrameAverageMilliseconds).toBe(
      visibleAverage,
    );
    expect(harness.calls.filter((call) => call === 'render')).toHaveLength(2);
    expect(harness.calls.filter((call) => call === 'readback')).toHaveLength(2);
    expect(harness.calls.filter((call) => call === 'capture')).toHaveLength(2);
    expect(harness.calls.filter((call) => call === 'afterFrame')).toHaveLength(2);
    expect(harness.calls.filter((call) => call === 'cpu.end')).toHaveLength(2);
  });

  it('closes only an opened GPU frame when simulation or rendering fails', () => {
    for (const failure of ['gpuBegin', 'step', 'render'] as const) {
      const harness = createFrameHarness();
      harness.state.failure = failure;
      harness.state.now += 16;

      expect(() => harness.driver.frame()).toThrow();

      if (failure === 'gpuBegin') {
        expect(harness.calls).toEqual([
          'cpu.begin',
          'viewport',
          'gpu.begin',
        ]);
      } else if (failure === 'step') {
        expect(harness.calls).toEqual([
          'cpu.begin',
          'viewport',
          'gpu.begin',
          'step',
          'gpu.end',
        ]);
      } else {
        expect(harness.calls).toEqual([
          'cpu.begin',
          'viewport',
          'gpu.begin',
          'step',
          'render',
          'gpu.end',
        ]);
      }
      expect(harness.calls).not.toContain('readback');
      expect(harness.calls).not.toContain('cpu.end');
    }
  });

  it('starts profiling on the thirteenth callback after swap detection', () => {
    const harness = createFrameHarness();
    harness.state.cloudSwapped = true;
    advanceFrames(harness, 1, 16);
    harness.state.cloudSwapped = false;

    advanceFrames(harness, 12, 16);
    expect(harness.driver.reading.profilingReady).toBe(false);
    expect(harness.calls).not.toContain('cpu.start');

    harness.calls.length = 0;
    advanceFrames(harness, 1, 16);

    expect(harness.driver.reading.profilingReady).toBe(true);
    expect(harness.calls.indexOf('gpu.end')).toBeLessThan(
      harness.calls.indexOf('cpu.start'),
    );
    expect(harness.calls.indexOf('cpu.start')).toBeLessThan(
      harness.calls.indexOf('gpu.start'),
    );
    expect(harness.calls.indexOf('gpu.start')).toBeLessThan(
      harness.calls.indexOf('readback'),
    );
  });

  it('keeps the strict adaptive interval, gates, and publish-before-apply order', () => {
    const policyCalls: string[] = [];
    const policy: NonNullable<
      BrowserFrameDriverOptions['adaptiveResolutionPolicy']
    > = (state, sample) => {
      policyCalls.push(`policy:${sample.nowSeconds.toFixed(2)}`);
      return { ...state, cap: 1.5 };
    };
    const normal = createFrameHarness({ adaptiveResolutionPolicy: policy });

    advanceFrames(normal, 50);
    expect(policyCalls).toEqual([]);
    normal.calls.length = 0;
    advanceFrames(normal, 1);

    expect(policyCalls).toEqual(['policy:3.55']);
    expect(normal.appliedCaps).toEqual([{ cap: 1.5, publishedCap: 1.5 }]);
    expect(normal.calls.indexOf('capture')).toBeLessThan(
      normal.calls.indexOf('applyPixelRatio'),
    );
    expect(normal.calls.indexOf('applyPixelRatio')).toBeLessThan(
      normal.calls.indexOf('afterFrame'),
    );

    for (const gate of ['fixed', 'diagnostic', 'hidden'] as const) {
      let calls = 0;
      const gated = createFrameHarness({
        fixedPixelRatio: gate === 'fixed' ? 2 : undefined,
        adaptiveResolutionPolicy: (state) => {
          calls++;
          return state;
        },
      });
      gated.execution.active = gate === 'diagnostic';
      gated.state.hidden = gate === 'hidden';
      advanceFrames(gated, 51);
      expect(calls, gate).toBe(0);

      if (gate !== 'fixed') {
        gated.execution.active = false;
        gated.state.hidden = false;
        advanceFrames(gated, 1);
        expect(calls, gate).toBe(1);
      }
    }
  });

  it('reuses its public callback and reading objects across frames', () => {
    const harness = createFrameHarness();
    const frame = harness.driver.frame;
    const resetCadence = harness.driver.resetCadence;
    const reading = harness.driver.reading;
    const cadence = harness.driver.reading.cadence;

    advanceFrames(harness, 2, 16);

    expect(harness.driver.frame).toBe(frame);
    expect(harness.driver.resetCadence).toBe(resetCadence);
    expect(harness.driver.reading).toBe(reading);
    expect(harness.driver.reading.cadence).toBe(cadence);
    expect(harness.readings).toEqual([reading, reading]);
  });
});

describe('browser viewport', () => {
  it('applies startup/polled sizes synchronously and coalesces host events', () => {
    const calls: Array<readonly unknown[]> = [];
    const timers = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextTimer = 1;
    const host: BrowserViewportHost & {
      innerWidth: number;
      innerHeight: number;
    } = {
      innerWidth: 0,
      innerHeight: 0,
      setTimeout(callback, delayMilliseconds) {
        calls.push(['timer', delayMilliseconds]);
        const handle = nextTimer++;
        timers.set(handle, callback);
        return handle;
      },
      clearTimeout(handle) {
        cleared.push(handle);
        timers.delete(handle);
      },
    };
    const viewport = new BrowserViewport(
      host,
      {
        setSize: (width, height, updateStyle) =>
          calls.push(['renderer', width, height, updateStyle]),
      },
      {
        setViewport: (width, height) =>
          calls.push(['camera', width, height]),
      },
    );
    const reading = viewport.reading;

    viewport.resize();
    viewport.resize();
    expect(calls).toEqual([
      ['renderer', 1, 1, false],
      ['camera', 1, 1],
    ]);

    host.innerWidth = 800;
    host.innerHeight = 600;
    viewport.scheduleResize();
    host.innerWidth = 900;
    host.innerHeight = 700;
    viewport.scheduleResize();
    expect(cleared).toEqual([1]);
    expect(calls.slice(-2)).toEqual([
      ['timer', 90],
      ['timer', 90],
    ]);
    timers.get(2)?.();
    expect(calls.slice(-2)).toEqual([
      ['renderer', 900, 700, false],
      ['camera', 900, 700],
    ]);

    viewport.scheduleResize();
    host.innerWidth = 1_000;
    host.innerHeight = 750;
    viewport.poll();
    const appliedCallCount = calls.length;
    timers.get(3)?.();
    expect(calls).toHaveLength(appliedCallCount);
    expect(viewport.reading).toBe(reading);
    expect(viewport.reading).toEqual({ width: 1_000, height: 750 });
  });

  it('exposes stable event and polling callbacks', () => {
    const host: BrowserViewportHost = {
      innerWidth: 320,
      innerHeight: 200,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    const viewport = new BrowserViewport(
      host,
      { setSize: () => undefined },
      { setViewport: () => undefined },
    );

    expect(viewport.resize).toBe(viewport.resize);
    expect(viewport.scheduleResize).toBe(viewport.scheduleResize);
    expect(viewport.poll).toBe(viewport.poll);
  });
});
