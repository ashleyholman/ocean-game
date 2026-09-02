/**
 * The world's one wind authority.
 *
 * The sea state remains the source of the *mean* wind — every preset carries
 * `wind { speedMps, directionDeg, gustiness }` chosen consistently with its
 * wave spectrum. This class owns the *instantaneous* wind: the mean plus a
 * deterministic gust process. Presentation systems keep reading the mean this
 * round (so nothing on screen changes); the instantaneous values exist for the
 * sailing physics and the developer readout. Feeding gusts into foam, spray or
 * cloth is a deliberate future look change, not a side effect of this file.
 *
 * DIRECTION CONVENTION — read before touching any sign
 * ----------------------------------------------------
 * `directionDeg` is the compass heading the wind blows **toward**, degrees
 * clockwise from north — identical to every sea-state direction
 * (`src/ocean/seaState.ts`). The bearing the wind blows *from* (what a sailor
 * names a wind by) is `directionDeg + 180`.
 *
 * Frame chain, matching what `main.ts` already does:
 *
 *   compass → render:  renderHeadingRad = (directionDeg + frameHeadingDeg)·π/180
 *   heading → vector:  (x, z) = (sin, −cos)·headingRad   (render axes)
 *   render  → body:    bodyX = x·cos(yaw) − z·sin(yaw)
 *                      bodyZ = x·sin(yaw) + z·cos(yaw)
 *
 * The body frame is the hull's: +z bow, +x port, −x starboard (`hullForm.ts`,
 * as relabelled by the W1 amendment — the words now agree with the compass).
 * Wind angles here are signed so that **positive means the wind comes over the
 * model +x side, the port side** — a positive true-wind angle is the port
 * tack. Every sign below is pinned by `tests/world-wind.test.ts`.
 *
 * THE GUST PROCESS
 * ----------------
 * A seeded sum of incommensurate sinusoids — mean-reverting in character like
 * an Ornstein–Uhlenbeck process, but a pure function of elapsed wind time, so
 * it is exactly caller-rate invariant and exactly reproducible: no integrated
 * noise, no `Math.random()`, no dependence on step pattern. Speed gusts have a
 * 10–60 s character; direction wanders more slowly. Excursion scale is set by
 * the preset's `gustiness`: peak speed excursion is
 * `±SPEED_GUST_AMPLITUDE_FRACTION · gustiness` of the mean, peak direction
 * offset `±DIRECTION_WANDER_DEG · gustiness`. Zero gustiness reproduces the
 * mean exactly.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** Fixed default seed; evidence and production share it deliberately. */
export const WORLD_WIND_DEFAULT_SEED = 0x57696e64; // 'Wind'

/** Peak fractional speed excursion at gustiness 1. */
export const SPEED_GUST_AMPLITUDE_FRACTION = 0.4;

/** Peak direction offset at gustiness 1, degrees. */
export const DIRECTION_WANDER_DEG = 8;

interface GustComponent {
  angularFrequency: number;
  amplitude: number;
  phase: number;
}

/** Deterministic 32-bit LCG (Numerical Recipes constants). */
function lcgNext(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

/**
 * A bounded, zero-mean, seeded signal of time.
 *
 * Components are log-spaced across the period band with seeded jitter and
 * phases, amplitudes weighted toward the long periods and normalised so the
 * sum can never leave [−1, 1].
 */
class GustSeries {
  private readonly components: readonly GustComponent[];

  /** @returns the LCG state after consuming this series' draws. */
  static consumeDraws(seed: number, count: number): number {
    let state = seed >>> 0;
    for (let i = 0; i < count * 2; i++) state = lcgNext(state);
    return state;
  }

  constructor(
    seed: number,
    count: number,
    shortestPeriodSeconds: number,
    longestPeriodSeconds: number,
  ) {
    let state = seed >>> 0;
    const draw = (): number => {
      state = lcgNext(state);
      return state / 0x1_0000_0000;
    };
    const built: GustComponent[] = [];
    const ratio = longestPeriodSeconds / shortestPeriodSeconds;
    let amplitudeSum = 0;
    for (let i = 0; i < count; i++) {
      const spacing = count > 1 ? i / (count - 1) : 0;
      const jitter = 0.85 + 0.3 * draw();
      const period = shortestPeriodSeconds * ratio ** spacing * jitter;
      const phase = draw() * TWO_PI;
      // Red-ish spectrum: long periods carry more energy, as real gusts do.
      const amplitude = Math.sqrt(period);
      amplitudeSum += amplitude;
      built.push({ angularFrequency: TWO_PI / period, amplitude, phase });
    }
    for (const component of built) component.amplitude /= amplitudeSum;
    this.components = built;
  }

  /** Signed value in [−1, 1]. Pure in `timeSeconds`. */
  valueAt(timeSeconds: number): number {
    let sum = 0;
    for (const component of this.components) {
      sum +=
        component.amplitude *
        Math.sin(component.angularFrequency * timeSeconds + component.phase);
    }
    return sum;
  }
}

const SPEED_COMPONENTS = 6;
const SPEED_PERIOD_SHORTEST_S = 8;
const SPEED_PERIOD_LONGEST_S = 70;
const DIRECTION_COMPONENTS = 4;
const DIRECTION_PERIOD_SHORTEST_S = 40;
const DIRECTION_PERIOD_LONGEST_S = 240;

export class WorldWind {
  private meanSpeed = 0;
  private meanDirection = 0;
  private gustinessValue = 0;
  private clockSeconds = 0;
  private readonly speedSeries: GustSeries;
  private readonly directionSeries: GustSeries;

  constructor(seed: number = WORLD_WIND_DEFAULT_SEED) {
    this.speedSeries = new GustSeries(
      seed,
      SPEED_COMPONENTS,
      SPEED_PERIOD_SHORTEST_S,
      SPEED_PERIOD_LONGEST_S,
    );
    this.directionSeries = new GustSeries(
      GustSeries.consumeDraws(seed, SPEED_COMPONENTS),
      DIRECTION_COMPONENTS,
      DIRECTION_PERIOD_SHORTEST_S,
      DIRECTION_PERIOD_LONGEST_S,
    );
  }

  /** Adopt the sea state's mean wind. Safe to call every frame. */
  setMean(
    speedMps: number,
    directionTowardDeg: number,
    gustiness: number,
  ): void {
    if (!Number.isFinite(speedMps) || speedMps < 0) {
      throw new RangeError(`wind speed must be finite and >= 0, got ${speedMps}`);
    }
    if (!Number.isFinite(directionTowardDeg)) {
      throw new RangeError(`wind direction must be finite, got ${directionTowardDeg}`);
    }
    if (!Number.isFinite(gustiness) || gustiness < 0 || gustiness > 1) {
      throw new RangeError(`gustiness must be in [0, 1], got ${gustiness}`);
    }
    this.meanSpeed = speedMps;
    this.meanDirection = directionTowardDeg;
    this.gustinessValue = gustiness;
  }

  /** Advance the wind clock by ordinary physics seconds — never voyage time. */
  advance(dtSeconds: number): void {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
      throw new RangeError(`wind dt must be finite and >= 0, got ${dtSeconds}`);
    }
    this.clockSeconds += dtSeconds;
  }

  /**
   * Rewind the gust clock to zero — the instant a fresh page starts at.
   *
   * Both series are deterministic functions of this one number and the seed
   * (the header's boast about having no `Math.random()` is what makes that
   * true), so rewinding it is the whole of the reset: at t = 0 every page,
   * every session and every restart meets the same gust.
   *
   * `resetSimulation` calls this. Without it a harness that restarted the
   * simulation twice met a different gust each time, and the difference
   * reached the sails, then the yaw, then the camera — measured at 1.1e-5 rad
   * of heading after forty settling frames. Small, growing, and avoidable. The
   * mean fields are left alone because the sea state republishes them every
   * frame.
   */
  reset(): void {
    this.clockSeconds = 0;
  }

  get elapsedSeconds(): number {
    return this.clockSeconds;
  }

  get meanSpeedMps(): number {
    return this.meanSpeed;
  }

  get meanDirectionTowardDeg(): number {
    return this.meanDirection;
  }

  get gustiness(): number {
    return this.gustinessValue;
  }

  /** Signed gust state in roughly [−1, 1], before gustiness scaling. */
  get gustSpeedFraction(): number {
    return this.speedSeries.valueAt(this.clockSeconds);
  }

  get gustDirectionOffsetDeg(): number {
    return this.gustDirectionOffsetDegAt(this.clockSeconds);
  }

  get instantaneousSpeedMps(): number {
    return this.instantaneousSpeedMpsAt(this.clockSeconds);
  }

  get instantaneousDirectionTowardDeg(): number {
    return this.instantaneousDirectionTowardDegAt(this.clockSeconds);
  }

  // The `At` forms exist for the 240 Hz substep loop: the gust process is a
  // pure function of elapsed wind time, so sub-frame consumers evaluate the
  // series at their own instant instead of advancing a second clock.

  gustDirectionOffsetDegAt(elapsedSeconds: number): number {
    const offset =
      DIRECTION_WANDER_DEG *
      this.gustinessValue *
      this.directionSeries.valueAt(elapsedSeconds);
    // Adding zero folds IEEE -0 (zero gustiness, negative series) into +0.
    return offset + 0;
  }

  instantaneousSpeedMpsAt(elapsedSeconds: number): number {
    const factor =
      1 +
      SPEED_GUST_AMPLITUDE_FRACTION *
        this.gustinessValue *
        this.speedSeries.valueAt(elapsedSeconds);
    return this.meanSpeed * Math.max(0, factor);
  }

  instantaneousDirectionTowardDegAt(elapsedSeconds: number): number {
    return this.meanDirection + this.gustDirectionOffsetDegAt(elapsedSeconds);
  }
}

// ---------------------------------------------------------------------------
// Pure frame and angle helpers. These restate no geometry of their own: each
// matches an expression that already exists in main.ts, WindSystem or the
// horizontal-dynamics evidence, and the parity is asserted by test.
// ---------------------------------------------------------------------------

export interface WindVector {
  x: number;
  z: number;
}

/**
 * Compass wind heading to a render-frame heading in radians — the exact
 * expression `main.ts` uses to push the sea wind into `WindSystem`.
 */
export function windRenderHeadingRad(
  directionTowardDeg: number,
  frameHeadingDeg: number,
): number {
  return (directionTowardDeg + frameHeadingDeg) * DEG_TO_RAD;
}

/** Render-frame wind vector for a heading — matches `WindSystem.setOceanWind`. */
export function windRenderVector(
  renderHeadingRad: number,
  speedMps: number,
  out: WindVector,
): WindVector {
  out.x = Math.sin(renderHeadingRad) * speedMps;
  out.z = -Math.cos(renderHeadingRad) * speedMps;
  return out;
}

/**
 * Apparent wind at a point: true wind minus the point's own velocity, both in
 * render axes. The point velocity should be the full rigid-body velocity of
 * the location that feels the wind (a rolling masthead sweeps air), though any
 * consistent frame pair works.
 */
export function apparentWindRender(
  trueWindX: number,
  trueWindZ: number,
  pointVelocityX: number,
  pointVelocityZ: number,
  out: WindVector,
): WindVector {
  out.x = trueWindX - pointVelocityX;
  out.z = trueWindZ - pointVelocityZ;
  return out;
}

/**
 * Rotate a render-frame vector into the model/body frame — the same rows the
 * horizontal-dynamics evidence uses for forward/side speeds.
 */
export function windRenderToBody(
  renderX: number,
  renderZ: number,
  modelYawRad: number,
  out: WindVector,
): WindVector {
  const sy = Math.sin(modelYawRad);
  const cy = Math.cos(modelYawRad);
  out.x = renderX * cy - renderZ * sy;
  out.z = renderX * sy + renderZ * cy;
  return out;
}

/** Wrap to (−180, 180]. */
export function wrapDegrees180(deg: number): number {
  let wrapped = ((deg % 360) + 540) % 360;
  if (wrapped === 0) wrapped = 360;
  return wrapped - 180;
}

/**
 * Angle of the wind *source* off the bow, from a body-frame wind vector.
 * 0 = wind dead ahead, ±180 = dead astern, positive = wind over the model +x
 * side, the port side. This is the quantity a sail trims against once the
 * input is the apparent wind.
 */
export function windAngleOffBowDeg(
  bodyWindX: number,
  bodyWindZ: number,
): number {
  return Math.atan2(-bodyWindX, -bodyWindZ) * RAD_TO_DEG;
}

/**
 * The same signed angle from compass quantities: vessel true heading and the
 * heading the wind blows toward. Positive = wind over the port side = the
 * port tack. Matched to `windAngleOffBowDeg`'s sign by test, so the two
 * routes can never drift apart silently.
 */
export function trueWindAngleDeg(
  trueHeadingDeg: number,
  windDirectionTowardDeg: number,
): number {
  const sourceDeg = windDirectionTowardDeg + 180;
  return wrapDegrees180(trueHeadingDeg - sourceDeg);
}

export type PointOfSail =
  | 'head-to-wind'
  | 'close-hauled'
  | 'beam-reach'
  | 'broad-reach'
  | 'run';

/**
 * Naming aid for readouts and tests — sector labels over |angle off bow|,
 * deliberately chirality-free. The rig's actual no-go arc is a physics result
 * for the sailing rounds, not these thresholds.
 */
export function pointOfSailName(angleOffBowDeg: number): PointOfSail {
  const a = Math.abs(wrapDegrees180(angleOffBowDeg));
  if (a < 45) return 'head-to-wind';
  if (a < 80) return 'close-hauled';
  if (a < 100) return 'beam-reach';
  if (a < 150) return 'broad-reach';
  return 'run';
}
