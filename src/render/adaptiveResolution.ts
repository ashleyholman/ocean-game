/**
 * Quality-first adaptive resolution, expressed as a pure policy.
 *
 * The controller watches presented frame cadence, not GPU cost. Cadence can be
 * slow because of fragment work, but it can just as easily be slow because of
 * JavaScript, fixed-resolution render targets, browser scheduling or thermal
 * throttling. A blind downward walk therefore destroys the image on machines
 * where fewer framebuffer pixels do not address the bottleneck.
 *
 * Every reduction is now a measured trial. The lower cap is retained only if
 * the following adaptation window either recovers the 30 FPS quality budget or
 * improves frame time materially. An ineffective trial is rolled back and
 * another is suppressed for a while. Resolution can still recover upward, but
 * a higher cap is kept only when it sustains the same 30 FPS budget.
 */

export type AdaptiveResolutionTrial =
  | {
      direction: 'down';
      previousCap: number;
      baselineFrameMs: number;
    }
  | {
      direction: 'up';
      previousCap: number;
    };

export interface AdaptiveResolutionState {
  /** Current cap on `devicePixelRatio`. */
  cap: number;
  /** Consecutive windows with enough headroom to test a higher cap. */
  recoveryWindows: number;
  /** A one-step experiment awaiting the next representative cadence sample. */
  trial?: AdaptiveResolutionTrial;
  /** Do not repeat a resolution-insensitive downward experiment before this. */
  downscaleRetryAtSeconds: number;
  /** The higher cap most recently observed below the 30 FPS quality budget. */
  failedUpscaleCap: number;
  /** Earliest time the failed higher cap may be probed again. */
  upscaleRetryAtSeconds: number;
  /** Current exponential backoff for repeated probes of that higher cap. */
  upscaleRetryBackoffSeconds: number;
}

export interface AdaptiveResolutionSample {
  /** Smoothed presented-frame interval, milliseconds. */
  frameAverageMs: number;
  /** The quality cap this device is allowed to recover to. */
  targetCap: number;
  /** Monotonic seconds, for trial cooldowns. */
  nowSeconds: number;
}

/** A steady 30 FPS is an acceptable quality-first presentation. */
export const TARGET_FRAME_MS = 1000 / 30;
/** Allow normal EWMA/vsync jitter while deciding whether a trial reached 30 FPS. */
export const TARGET_FRAME_TOLERANCE_MS = 0.75;
/**
 * Begin sacrificing resolution only below roughly 28 FPS. The gap above the
 * target absorbs normal cadence jitter instead of turning every 30 FPS vsync
 * interval into a resize experiment.
 */
export const DOWNSCALE_TRIGGER_MS = 1000 / 28;
/** Require roughly 32 FPS before risking a higher-resolution probe. */
export const RECOVERY_TRIGGER_MS = 1000 / 32;
/** Cap step per experiment. */
export const CAP_STEP = 0.25;
/** Never draw below one framebuffer pixel per CSS pixel automatically. */
export const ABSOLUTE_CAP_FLOOR = 1;
/**
 * Automatic mode keeps at least 75% of the starting width and height: 56.25%
 * of its pixels. More aggressive scaling belongs in an explicit performance
 * mode with an appropriate reconstruction filter.
 */
export const MINIMUM_CAP_RATIO = 0.75;
/** Relative frame-time improvement required when a trial does not reach 30 FPS. */
export const MINIMUM_TRIAL_IMPROVEMENT_RATIO = 0.1;
/** Ignore tiny apparent wins that fit inside normal frame-time noise. */
export const MINIMUM_TRIAL_IMPROVEMENT_MS = 2;
/** Wait this long before repeating a downward trial that bought no performance. */
export const DOWNSCALE_RETRY_SECONDS = 60;
/** Initial wait before retrying a higher cap known to miss the quality budget. */
export const UPSCALE_RETRY_BASE_SECONDS = 15;
/** Ceiling on repeated higher-cap probes. */
export const UPSCALE_RETRY_MAX_SECONDS = 120;
/** Two adjacent 2.5-second windows prevent one lucky interval from probing up. */
export const RECOVERY_WINDOWS_REQUIRED = 2;

function capFloor(targetCap: number): number {
  return Math.min(
    targetCap,
    Math.max(ABSOLUTE_CAP_FLOOR, targetCap * MINIMUM_CAP_RATIO),
  );
}

function failedUpscaleMemory(
  state: AdaptiveResolutionState,
  failedCap: number,
  nowSeconds: number,
): Pick<
  AdaptiveResolutionState,
  'failedUpscaleCap' | 'upscaleRetryAtSeconds' | 'upscaleRetryBackoffSeconds'
> {
  const repeated = failedCap === state.failedUpscaleCap;
  const backoff = repeated
    ? Math.min(
        Math.max(state.upscaleRetryBackoffSeconds, UPSCALE_RETRY_BASE_SECONDS) * 2,
        UPSCALE_RETRY_MAX_SECONDS,
      )
    : UPSCALE_RETRY_BASE_SECONDS;
  return {
    failedUpscaleCap: failedCap,
    upscaleRetryAtSeconds: nowSeconds + backoff,
    upscaleRetryBackoffSeconds: backoff,
  };
}

function downscaleTrialHelped(baselineMs: number, trialMs: number): boolean {
  const improvementMs = baselineMs - trialMs;
  const recoveredBudget = trialMs <= TARGET_FRAME_MS + TARGET_FRAME_TOLERANCE_MS;
  const materialImprovement =
    improvementMs >= MINIMUM_TRIAL_IMPROVEMENT_MS &&
    improvementMs / baselineMs >= MINIMUM_TRIAL_IMPROVEMENT_RATIO;
  return recoveredBudget || materialImprovement;
}

/** Evaluate one 2.5-second adaptation window. */
export function stepAdaptiveResolution(
  state: AdaptiveResolutionState,
  sample: AdaptiveResolutionSample,
): AdaptiveResolutionState {
  const { frameAverageMs, targetCap, nowSeconds } = sample;

  if (state.trial?.direction === 'down') {
    if (downscaleTrialHelped(state.trial.baselineFrameMs, frameAverageMs)) {
      return {
        ...state,
        recoveryWindows: 0,
        trial: undefined,
        downscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
        ...failedUpscaleMemory(state, state.trial.previousCap, nowSeconds),
      };
    }

    // This workload was not resolution-sensitive. Restore the exact cap that
    // preceded the experiment and leave the image alone for the next minute.
    return {
      ...state,
      cap: state.trial.previousCap,
      recoveryWindows: 0,
      trial: undefined,
      downscaleRetryAtSeconds: nowSeconds + DOWNSCALE_RETRY_SECONDS,
    };
  }

  if (state.trial?.direction === 'up') {
    if (frameAverageMs <= TARGET_FRAME_MS + TARGET_FRAME_TOLERANCE_MS) {
      return {
        ...state,
        recoveryWindows: 0,
        trial: undefined,
        failedUpscaleCap: Number.POSITIVE_INFINITY,
        upscaleRetryAtSeconds: Number.NEGATIVE_INFINITY,
        upscaleRetryBackoffSeconds: 0,
      };
    }

    // The higher cap cannot sustain the quality budget. Return immediately to
    // the last known-good cap and probe it exponentially less often.
    return {
      ...state,
      cap: state.trial.previousCap,
      recoveryWindows: 0,
      trial: undefined,
      ...failedUpscaleMemory(state, state.cap, nowSeconds),
    };
  }

  const minimumCap = capFloor(targetCap);
  const strained = frameAverageMs > DOWNSCALE_TRIGGER_MS;
  if (
    strained &&
    state.cap > minimumCap &&
    nowSeconds >= state.downscaleRetryAtSeconds
  ) {
    return {
      ...state,
      cap: Math.max(minimumCap, state.cap - CAP_STEP),
      recoveryWindows: 0,
      trial: {
        direction: 'down',
        previousCap: state.cap,
        baselineFrameMs: frameAverageMs,
      },
    };
  }

  const recoveryWindows =
    state.cap < targetCap && frameAverageMs < RECOVERY_TRIGGER_MS
      ? state.recoveryWindows + 1
      : 0;
  const nextCap = Math.min(targetCap, state.cap + CAP_STEP);
  const upscaleAllowed =
    nextCap < state.failedUpscaleCap || nowSeconds >= state.upscaleRetryAtSeconds;

  if (
    recoveryWindows >= RECOVERY_WINDOWS_REQUIRED &&
    state.cap < targetCap &&
    upscaleAllowed
  ) {
    return {
      ...state,
      cap: nextCap,
      recoveryWindows: 0,
      trial: {
        direction: 'up',
        previousCap: state.cap,
      },
    };
  }

  return {
    ...state,
    recoveryWindows,
  };
}
