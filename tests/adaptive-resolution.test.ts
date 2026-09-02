import { describe, expect, it } from 'vitest';
import {
  CAP_STEP,
  DOWNSCALE_RETRY_SECONDS,
  DOWNSCALE_TRIGGER_MS,
  MINIMUM_CAP_RATIO,
  RECOVERY_TRIGGER_MS,
  stepAdaptiveResolution,
  TARGET_FRAME_MS,
  TARGET_FRAME_TOLERANCE_MS,
  UPSCALE_RETRY_BASE_SECONDS,
} from '../src/render/adaptiveResolution';
import type { AdaptiveResolutionState } from '../src/render/adaptiveResolution';

const VSYNC_30 = 1000 / 30;
const VSYNC_60 = 1000 / 60;

function state(overrides: Partial<AdaptiveResolutionState> = {}): AdaptiveResolutionState {
  return {
    cap: 2,
    recoveryWindows: 0,
    downscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
    failedUpscaleCap: Number.POSITIVE_INFINITY,
    upscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
    upscaleRetryBackoffSeconds: 0,
    ...overrides,
  };
}

function step(
  current: AdaptiveResolutionState,
  frameAverageMs: number,
  nowSeconds: number,
  targetCap = 2,
): AdaptiveResolutionState {
  return stepAdaptiveResolution(current, {
    frameAverageMs,
    targetCap,
    nowSeconds,
  });
}

describe('quality-first adaptive resolution', () => {
  it('holds native resolution at a steady 30 FPS', () => {
    let current = state();
    for (let i = 0; i < 20; i++) current = step(current, VSYNC_30, 1000 + i * 2.5);
    expect(current.cap).toBe(2);
    expect(current.trial).toBeUndefined();
  });

  it('absorbs cadence jitter around 30 FPS without starting a trial', () => {
    const nearBudget = step(state(), DOWNSCALE_TRIGGER_MS - 0.1, 1000);
    expect(nearBudget.cap).toBe(2);
    expect(nearBudget.trial).toBeUndefined();
  });

  it('starts a single-step trial only after cadence falls below roughly 28 FPS', () => {
    const trial = step(state(), DOWNSCALE_TRIGGER_MS + 1, 1000);
    expect(trial.cap).toBe(2 - CAP_STEP);
    expect(trial.trial).toEqual({
      direction: 'down',
      previousCap: 2,
      baselineFrameMs: DOWNSCALE_TRIGGER_MS + 1,
    });
  });

  it('keeps a downscale that restores the 30 FPS quality budget', () => {
    const trial = step(state(), 40, 1000);
    const measured = step(
      trial,
      TARGET_FRAME_MS + TARGET_FRAME_TOLERANCE_MS,
      1002.5,
    );
    expect(measured.cap).toBe(1.75);
    expect(measured.trial).toBeUndefined();
    expect(measured.failedUpscaleCap).toBe(2);
  });

  it('keeps a materially beneficial step even when more work remains', () => {
    const trial = step(state(), 50, 1000);
    const measured = step(trial, 44, 1002.5);
    expect(measured.cap).toBe(1.75);
    expect(measured.trial).toBeUndefined();

    // The next strained window may test another step, but only after the first
    // step has separately demonstrated its value.
    const nextTrial = step(measured, 44, 1005);
    expect(nextTrial.cap).toBe(1.5);
    expect(nextTrial.trial?.direction).toBe('down');
  });

  it('reverts an ineffective downscale instead of walking toward the floor', () => {
    const trial = step(state(), 40, 1000);
    const reverted = step(trial, 39, 1002.5);
    expect(reverted.cap).toBe(2);
    expect(reverted.trial).toBeUndefined();
    expect(reverted.downscaleRetryAtSeconds).toBe(1002.5 + DOWNSCALE_RETRY_SECONDS);
  });

  it('suppresses another ineffective trial for one minute', () => {
    const trial = step(state(), 40, 1000);
    const reverted = step(trial, 40, 1002.5);
    const stillNative = step(reverted, 45, 1002.5 + DOWNSCALE_RETRY_SECONDS - 0.1);
    expect(stillNative.cap).toBe(2);
    expect(stillNative.trial).toBeUndefined();

    const retry = step(reverted, 45, 1002.5 + DOWNSCALE_RETRY_SECONDS);
    expect(retry.cap).toBe(1.75);
    expect(retry.trial?.direction).toBe('down');
  });

  it('keeps automatic mode above 75% linear scale and 56% of starting pixels', () => {
    let current = state();
    let nowSeconds = 1000;
    let baselineMs = 80;
    for (let i = 0; i < 10; i++) {
      current = step(current, baselineMs, nowSeconds);
      nowSeconds += 2.5;
      if (current.trial?.direction === 'down') {
        baselineMs *= 0.8;
        current = step(current, baselineMs, nowSeconds);
        nowSeconds += 2.5;
      }
    }
    expect(current.cap).toBe(2 * MINIMUM_CAP_RATIO);
    expect((current.cap / 2) ** 2).toBeCloseTo(0.5625);
  });

  it('never goes below one framebuffer pixel per CSS pixel on a low-DPR target', () => {
    let current = state({ cap: 1.25 });
    current = step(current, 50, 1000, 1.25);
    current = step(current, 40, 1002.5, 1.25);
    expect(current.cap).toBe(1);
    expect(current.trial).toBeUndefined();

    current = step(current, 50, 1005, 1.25);
    expect(current.cap).toBe(1);
    expect(current.trial).toBeUndefined();
  });

  it('requires two headroom windows and the retry timer before probing upward', () => {
    const reduced = state({
      cap: 1.75,
      failedUpscaleCap: 2,
      upscaleRetryAtSeconds: 1015,
      upscaleRetryBackoffSeconds: UPSCALE_RETRY_BASE_SECONDS,
    });
    const first = step(reduced, RECOVERY_TRIGGER_MS - 1, 1002.5);
    expect(first.recoveryWindows).toBe(1);
    const blocked = step(first, RECOVERY_TRIGGER_MS - 1, 1005);
    expect(blocked.cap).toBe(1.75);
    expect(blocked.trial).toBeUndefined();

    const retry = step(blocked, RECOVERY_TRIGGER_MS - 1, 1015);
    expect(retry.cap).toBe(2);
    expect(retry.trial?.direction).toBe('up');
  });

  it('keeps a higher-resolution probe when it sustains 30 FPS', () => {
    const probing = state({
      cap: 2,
      trial: { direction: 'up', previousCap: 1.75 },
      failedUpscaleCap: 2,
      upscaleRetryAtSeconds: 1000,
      upscaleRetryBackoffSeconds: UPSCALE_RETRY_BASE_SECONDS,
    });
    const kept = step(probing, VSYNC_30, 1002.5);
    expect(kept.cap).toBe(2);
    expect(kept.trial).toBeUndefined();
    expect(kept.failedUpscaleCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('rolls back a higher-resolution probe that cannot sustain 30 FPS', () => {
    const probing = state({
      cap: 2,
      trial: { direction: 'up', previousCap: 1.75 },
      failedUpscaleCap: 2,
      upscaleRetryAtSeconds: 1000,
      upscaleRetryBackoffSeconds: UPSCALE_RETRY_BASE_SECONDS,
    });
    const reverted = step(probing, TARGET_FRAME_MS + 1, 1002.5);
    expect(reverted.cap).toBe(1.75);
    expect(reverted.trial).toBeUndefined();
    expect(reverted.upscaleRetryBackoffSeconds).toBe(UPSCALE_RETRY_BASE_SECONDS * 2);
  });

  it('recovers all the way to native when higher caps remain healthy', () => {
    let current = state({ cap: 1.5 });
    current = step(current, VSYNC_60, 1000);
    current = step(current, VSYNC_60, 1002.5);
    expect(current.cap).toBe(1.75);
    expect(current.trial?.direction).toBe('up');
    current = step(current, VSYNC_60, 1005);
    expect(current.cap).toBe(1.75);
    expect(current.trial).toBeUndefined();
    current = step(current, VSYNC_60, 1007.5);
    current = step(current, VSYNC_60, 1010);
    expect(current.cap).toBe(2);
    expect(current.trial?.direction).toBe('up');
    current = step(current, VSYNC_30, 1012.5);
    expect(current.cap).toBe(2);
    expect(current.trial).toBeUndefined();
  });
});
