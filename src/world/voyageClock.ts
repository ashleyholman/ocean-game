import { assertNonNegativeFinite } from './math';
import type { PlanetaryWorld } from './PlanetaryWorld';

/**
 * The voyage clock: live policy over `PlanetaryWorld`'s voyage-time
 * compression.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ship, sea, and sky animate at 1×, so any world-anchored object in view
 * is a witness to the voyage rate: land crossing the horizon at 30× while the
 * ocean reads 1× looks like the island is moving on its own. The witness's
 * testimony is the apparent angular rate of the nearest land,
 *
 *     ω = (speed over ground × voyage rate) / distance to land,
 *
 * and that is the only honest lever — uniform world scaling cancels out of
 * ω entirely, which is why "shrink the planet" was rejected.
 *
 * Two modes:
 *  - `fixed`: the rate is whatever the slider says (default honest 1×).
 *  - `governed`: the rate is the largest value keeping ω at or under a slide
 *    budget `omegaMaxDegPerS`, so open ocean runs at full compression and
 *    land can only ever appear through a ramp that has already slowed the
 *    voyage down.
 *
 * Rate changes ease over a few seconds; a stepped rate reads as the world
 * lurching.
 */

export const VOYAGE_RATE_RANGE = { min: 1, max: 30 } as const;

/**
 * Slide budget default, degrees of bearing drift per second for the nearest
 * land. 0.2°/s is "brisk": a full-moon width every 2.5 s, fast enough to feel
 * the passage and slow enough that the land reads as terrain, not scenery on
 * rails. A true 6 kn passage 5 km off shows about 0.04°/s.
 */
export const DEFAULT_VOYAGE_OMEGA_MAX_DEG_PER_S = 0.2;
export const VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE = {
  min: 0.02,
  max: 2,
} as const;

/** E-folding time for rate changes, real seconds. */
const RATE_RESPONSE_SECONDS = 2;

/**
 * Below steering way the slide rate is negligible at any compression, and the
 * quotient ω_max·d/v explodes; treat the vessel as stationary and allow full
 * compression.
 */
const GOVERNOR_MINIMUM_SPEED_MPS = 0.05;

const DEG_TO_RAD = Math.PI / 180;

export type VoyageClockMode = 'fixed' | 'governed';

/**
 * Largest voyage rate that keeps the nearest land's apparent bearing drift at
 * or under the slide budget: rate = ω_max·d / v, clamped to the voyage range.
 * `nearestLandM` is distance to the nearest above-water terrain;
 * `speedOverGroundMps` is the vessel's own 1× speed (compression multiplies
 * it back in, so it must not be pre-multiplied here).
 */
export function governedVoyageRate(
  nearestLandM: number,
  speedOverGroundMps: number,
  omegaMaxDegPerS: number,
): number {
  assertNonNegativeFinite(nearestLandM, 'nearestLandM');
  assertNonNegativeFinite(speedOverGroundMps, 'speedOverGroundMps');
  assertNonNegativeFinite(omegaMaxDegPerS, 'omegaMaxDegPerS');
  if (speedOverGroundMps < GOVERNOR_MINIMUM_SPEED_MPS) {
    return VOYAGE_RATE_RANGE.max;
  }
  const rate =
    (omegaMaxDegPerS * DEG_TO_RAD * nearestLandM) / speedOverGroundMps;
  return Math.min(
    VOYAGE_RATE_RANGE.max,
    Math.max(VOYAGE_RATE_RANGE.min, rate),
  );
}

export interface VoyageClockOptions {
  mode?: VoyageClockMode;
  /** Rate used in `fixed` mode. Defaults to the world's starting rate. */
  fixedRate?: number;
  omegaMaxDegPerS?: number;
}

export interface VoyageClockSample {
  /** Distance to the nearest above-water land, metres; undefined = no land. */
  nearestLandM: number | undefined;
  /** The vessel's own 1× speed over ground, m/s. */
  speedOverGroundMps: number;
}

export class VoyageClockControl {
  private mode: VoyageClockMode;
  private fixedRate: number;
  private omegaMaxDegPerS: number;
  private rate: number;
  private lastSample: VoyageClockSample = {
    nearestLandM: undefined,
    speedOverGroundMps: 0,
  };

  constructor(
    private readonly world: PlanetaryWorld,
    options: VoyageClockOptions = {},
  ) {
    this.mode = options.mode ?? 'fixed';
    this.fixedRate = clampRate(
      options.fixedRate ?? world.voyageSecondsPerRealSecond,
    );
    this.omegaMaxDegPerS = clampOmega(
      options.omegaMaxDegPerS ?? DEFAULT_VOYAGE_OMEGA_MAX_DEG_PER_S,
    );
    this.rate = this.mode === 'fixed' ? this.fixedRate : clampRate(
      world.voyageSecondsPerRealSecond,
    );
    this.world.setVoyageSecondsPerRealSecond(this.rate);
  }

  /**
   * Ease the live rate toward the mode's target and write it to the world.
   * Call once per simulated frame with real elapsed seconds; a zero delta
   * (capture harnesses re-rendering a frozen world) changes nothing.
   */
  update(realDeltaSeconds: number, sample: VoyageClockSample): void {
    assertNonNegativeFinite(realDeltaSeconds, 'realDeltaSeconds');
    this.lastSample = sample;
    if (realDeltaSeconds === 0) return;
    const target = this.targetRate();
    const blend = 1 - Math.exp(-realDeltaSeconds / RATE_RESPONSE_SECONDS);
    this.rate += (target - this.rate) * blend;
    if (Math.abs(this.rate - target) < 0.01) this.rate = target;
    this.world.setVoyageSecondsPerRealSecond(this.rate);
  }

  targetRate(): number {
    if (this.mode === 'fixed') return this.fixedRate;
    const { nearestLandM, speedOverGroundMps } = this.lastSample;
    if (nearestLandM === undefined) return VOYAGE_RATE_RANGE.max;
    return governedVoyageRate(
      nearestLandM,
      speedOverGroundMps,
      this.omegaMaxDegPerS,
    );
  }

  /** The apparent bearing drift of the nearest land right now, °/s. */
  apparentSlideDegPerS(): number | undefined {
    const { nearestLandM, speedOverGroundMps } = this.lastSample;
    if (nearestLandM === undefined || nearestLandM <= 0) return undefined;
    return (
      ((speedOverGroundMps * this.rate) / nearestLandM) / DEG_TO_RAD
    );
  }

  get currentRate(): number {
    return this.rate;
  }

  get currentMode(): VoyageClockMode {
    return this.mode;
  }

  setMode(mode: VoyageClockMode): void {
    this.mode = mode;
  }

  get currentFixedRate(): number {
    return this.fixedRate;
  }

  setFixedRate(rate: number): void {
    this.fixedRate = clampRate(rate);
  }

  get currentOmegaMaxDegPerS(): number {
    return this.omegaMaxDegPerS;
  }

  setOmegaMaxDegPerS(omegaMaxDegPerS: number): void {
    this.omegaMaxDegPerS = clampOmega(omegaMaxDegPerS);
  }

  get sample(): Readonly<VoyageClockSample> {
    return this.lastSample;
  }
}

function clampRate(rate: number): number {
  assertNonNegativeFinite(rate, 'voyage rate');
  return Math.min(
    VOYAGE_RATE_RANGE.max,
    Math.max(VOYAGE_RATE_RANGE.min, rate),
  );
}

function clampOmega(omegaMaxDegPerS: number): number {
  assertNonNegativeFinite(omegaMaxDegPerS, 'omegaMaxDegPerS');
  return Math.min(
    VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.max,
    Math.max(VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.min, omegaMaxDegPerS),
  );
}
