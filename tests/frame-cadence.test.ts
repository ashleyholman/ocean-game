import { describe, expect, it } from 'vitest';
import { FrameCadence } from '../src/render/FrameCadence';

function recordIntervals(
  cadence: FrameCadence,
  intervalsMs: readonly number[],
): void {
  let timestampMs = 0;
  cadence.reset(timestampMs);
  for (const intervalMs of intervalsMs) {
    timestampMs += intervalMs;
    cadence.recordFrame(timestampMs);
  }
}

describe('frame cadence', () => {
  it('reports steady frame delivery as reciprocal FPS and frame time', () => {
    const cadence = new FrameCadence();
    recordIntervals(cadence, Array.from({ length: 60 }, () => 1000 / 60));

    expect(cadence.reading.frameMs).toBeCloseTo(1000 / 60, 10);
    expect(cadence.reading.fps).toBeCloseTo(60, 10);
    expect(cadence.reading.fps! * cadence.reading.frameMs!).toBeCloseTo(
      1000,
      10,
    );
  });

  it('does not bias FPS high when delivery alternates between fast and slow frames', () => {
    const cadence = new FrameCadence();
    recordIntervals(cadence, [10, 190, 10, 190, 10, 190, 10, 190]);

    // The old implementation separately averaged instantaneous rates:
    // mean(1000 / dt) = 52.6 FPS. Eight frames in 800 ms is actually 10 FPS.
    expect(cadence.reading.sampledElapsedMs).toBe(800);
    expect(cadence.reading.frameMs).toBe(100);
    expect(cadence.reading.fps).toBe(10);
    expect(cadence.reading.fps! * cadence.reading.frameMs!).toBe(1000);
  });

  it('ages an old slow interval out after a window of faster delivery', () => {
    const cadence = new FrameCadence(100);
    recordIntervals(cadence, [50, 50, 10, 10, 10, 10, 10]);
    expect(cadence.reading.fps).toBeCloseTo(60, 10);

    let timestampMs = 150;
    for (let index = 0; index < 5; index++) {
      timestampMs += 10;
      cadence.recordFrame(timestampMs);
    }

    expect(cadence.reading.sampledElapsedMs).toBe(100);
    expect(cadence.reading.frameMs).toBe(10);
    expect(cadence.reading.fps).toBe(100);
  });

  it('excludes a tab-resume gap after its history is reset', () => {
    const cadence = new FrameCadence();
    cadence.reset(0);
    cadence.recordFrame(16);
    expect(cadence.reading.frameMs).toBe(16);

    cadence.reset();
    expect(cadence.reading.frameMs).toBeUndefined();
    expect(cadence.reading.fps).toBeUndefined();

    // The first visible callback establishes a baseline. The ten-second
    // background gap therefore never becomes part of the visible cadence.
    cadence.recordFrame(10_000);
    expect(cadence.reading.frameMs).toBeUndefined();
    cadence.recordFrame(10_016);

    expect(cadence.reading.frameMs).toBe(16);
    expect(cadence.reading.fps).toBe(62.5);
  });
});
