import { describe, expect, it } from 'vitest';
import { deriveGpuPassTimings } from '../src/render/GpuProfiler';

describe('GPU prefix timing derivation', () => {
  it('turns one rotation of cumulative endpoints into additive pass costs', () => {
    const timing = deriveGpuPassTimings({
      frame: 20,
      foamSimulation: 0.5,
      cloudCacheBake: 9.5,
      skyAndCloudDraw: 10.3,
      ocean: 18,
      stars: 18.4,
    });

    expect(timing.frame).toBe(20);
    expect(timing.foamSimulation).toBe(0.5);
    expect(timing.cloudCacheBake).toBe(9);
    expect(timing.skyAndCloudDraw).toBeCloseTo(0.8);
    expect(timing.ocean).toBeCloseTo(7.7);
    expect(timing.sceneAndStars).toBeCloseTo(0.4);
  });

  it('preserves signed noise so smoothing is not biased upward', () => {
    const timing = deriveGpuPassTimings({
      frame: 20,
      foamSimulation: 0.5,
      cloudCacheBake: 10,
      skyAndCloudDraw: 9.8,
      ocean: 18,
      stars: 18.4,
    });

    expect(timing.skyAndCloudDraw).toBeCloseTo(-0.2);
    expect(timing.cloudCacheBake).toBe(9.5);
    expect(timing.ocean).toBeCloseTo(8.2);
  });
});
