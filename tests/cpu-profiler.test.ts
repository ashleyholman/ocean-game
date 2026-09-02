import { describe, expect, it } from 'vitest';
import { CpuProfiler } from '../src/render/CpuProfiler';

describe('CPU profiler', () => {
  it('reports additive main-thread spans inside the full frame callback', () => {
    let now = 0;
    const profiler = new CpuProfiler(() => now);
    profiler.start();

    profiler.beginFrame();
    now = 1;
    profiler.beginPass('worldAndLighting');
    now = 3;
    profiler.endPass('worldAndLighting');
    now = 4;
    profiler.beginPass('renderSubmission');
    now = 9;
    profiler.endPass('renderSubmission');
    now = 10;
    profiler.endFrame();

    expect(profiler.reading.frame).toBe(10);
    expect(profiler.reading.worldAndLighting).toBe(2);
    expect(profiler.reading.renderSubmission).toBe(5);
    expect(profiler.reading.vesselAndCamera).toBe(0);
  });

  it('smooths later samples rather than replacing the displayed reading', () => {
    let now = 0;
    const profiler = new CpuProfiler(() => now);
    profiler.start();

    profiler.beginFrame();
    profiler.beginPass('oceanPreparation');
    now = 2;
    profiler.endPass('oceanPreparation');
    now = 10;
    profiler.endFrame();

    now = 20;
    profiler.beginFrame();
    profiler.beginPass('oceanPreparation');
    now = 24;
    profiler.endPass('oceanPreparation');
    now = 30;
    profiler.endFrame();

    expect(profiler.reading.frame).toBe(10);
    expect(profiler.reading.oceanPreparation).toBeCloseTo(2.32);
  });

  it('closes an active pass at the frame boundary after an early exit', () => {
    let now = 0;
    const profiler = new CpuProfiler(() => now);
    profiler.start();

    profiler.beginFrame();
    now = 1;
    profiler.beginPass('skyAndScene');
    now = 6;
    profiler.endFrame();

    expect(profiler.reading.frame).toBe(6);
    expect(profiler.reading.skyAndScene).toBe(5);
  });

  it('omits startup frames before an explicit profiling session starts', () => {
    let now = 0;
    const profiler = new CpuProfiler(() => now);

    profiler.beginFrame();
    now = 80;
    profiler.endFrame();
    expect(profiler.reading.frame).toBeUndefined();

    profiler.start();
    profiler.beginFrame();
    now = 90;
    profiler.endFrame();

    expect(profiler.reading.frame).toBe(10);
  });
});
