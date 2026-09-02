/**
 * The S5 magnetic compass: a damped card beneath a fixed lubber line.
 *
 * Magnetic north equals true north in this round. The card is nevertheless a
 * physical angular system: it has inertia, damping, finite response and a
 * bounded seaway displacement driven by hull motion. Human perception reads
 * this instrument (through delayed history in `CrewObservations`); it never
 * reads the vessel heading directly.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

export const COMPASS_INSTRUMENT_PROFILE = Object.freeze({
  /** Undamped natural period of the card. */
  naturalPeriodSeconds: 3.6,
  /** Slightly underdamped: a small overshoot is possible, ringing is brief. */
  dampingRatio: 0.72,
  /** Low-pass time for roll-rate-induced seaway displacement. */
  seawayTimeConstantSeconds: 0.7,
  /** Seconds of indicated angular displacement per radian/second of roll. */
  rollRateCouplingSeconds: 0.24,
  /** Physical stop on seaway displacement, either side. */
  maximumSeawayDisplacementDeg: 2.4,
  /** Safety bound on a violently disturbed card, not an authored response. */
  maximumCardRateDegPerSecond: 100,
} as const);

export interface CompassInstrumentInput {
  /** Exact vessel truth; only the instrument/observation boundary accepts it. */
  trueHeadingDeg: number;
  /** Exact hull roll rate used only to make a correlated physical disturbance. */
  rollRateRadPerSecond: number;
}

export interface CompassInstrumentReadout {
  /** Compass indication under the lubber line, wrapped into [0, 360). */
  indicatedHeadingDeg: number;
  /** Signed physical card rate; positive follows increasing compass heading. */
  cardRateDegPerSecond: number;
  /** Correlated bounded displacement of the card's equilibrium. */
  seawayDisplacementDeg: number;
}

export class CompassInstrument {
  private trueWrappedRad = 0;
  private trueUnwrappedRad = 0;
  private cardUnwrappedRad = 0;
  private cardRateRadPerSecond = 0;
  private seawayDisplacementRad = 0;
  private initialized = false;

  readonly readout: CompassInstrumentReadout = {
    indicatedHeadingDeg: 0,
    cardRateDegPerSecond: 0,
    seawayDisplacementDeg: 0,
  };

  constructor(
    readonly profile: Readonly<typeof COMPASS_INSTRUMENT_PROFILE> =
      COMPASS_INSTRUMENT_PROFILE,
  ) {}

  reset(headingDeg?: number): void {
    this.initialized = headingDeg !== undefined;
    const headingRad = (headingDeg ?? 0) * DEG_TO_RAD;
    this.trueWrappedRad = wrapTwoPi(headingRad);
    this.trueUnwrappedRad = headingRad;
    this.cardUnwrappedRad = headingRad;
    this.cardRateRadPerSecond = 0;
    this.seawayDisplacementRad = 0;
    this.refreshReadout();
  }

  advance(
    stepSeconds: number,
    input: Readonly<CompassInstrumentInput>,
  ): CompassInstrumentReadout {
    assertPositiveFinite(stepSeconds, 'compass step');
    assertFinite(input.trueHeadingDeg, 'true heading');
    assertFinite(input.rollRateRadPerSecond, 'roll rate');

    const nextWrapped = wrapTwoPi(input.trueHeadingDeg * DEG_TO_RAD);
    if (!this.initialized) {
      this.reset(input.trueHeadingDeg);
      return this.readout;
    }
    this.trueUnwrappedRad += wrapPi(nextWrapped - this.trueWrappedRad);
    this.trueWrappedRad = nextWrapped;

    const profile = this.profile;
    const maximumSeaway = profile.maximumSeawayDisplacementDeg * DEG_TO_RAD;
    const disturbanceTarget = clamp(
      input.rollRateRadPerSecond * profile.rollRateCouplingSeconds,
      -maximumSeaway,
      maximumSeaway,
    );
    const disturbanceBlend =
      1 - Math.exp(-stepSeconds / profile.seawayTimeConstantSeconds);
    this.seawayDisplacementRad +=
      (disturbanceTarget - this.seawayDisplacementRad) * disturbanceBlend;

    const naturalFrequency = TWO_PI / profile.naturalPeriodSeconds;
    const equilibrium = this.trueUnwrappedRad + this.seawayDisplacementRad;
    const acceleration =
      naturalFrequency * naturalFrequency *
        (equilibrium - this.cardUnwrappedRad) -
      2 *
        profile.dampingRatio *
        naturalFrequency *
        this.cardRateRadPerSecond;
    this.cardRateRadPerSecond += acceleration * stepSeconds;
    const maximumRate = profile.maximumCardRateDegPerSecond * DEG_TO_RAD;
    this.cardRateRadPerSecond = clamp(
      this.cardRateRadPerSecond,
      -maximumRate,
      maximumRate,
    );
    // Semi-implicit Euler is stable at the fixed 240 Hz grid and lets the
    // velocity respond before the card advances, as a physical state should.
    this.cardUnwrappedRad += this.cardRateRadPerSecond * stepSeconds;
    this.refreshReadout();
    return this.readout;
  }

  /** Continuous angle used by the delayed history; never shown as truth. */
  get indicatedUnwrappedHeadingDeg(): number {
    return this.cardUnwrappedRad * RAD_TO_DEG;
  }

  private refreshReadout(): void {
    this.readout.indicatedHeadingDeg = wrap360(
      this.cardUnwrappedRad * RAD_TO_DEG,
    );
    this.readout.cardRateDegPerSecond =
      this.cardRateRadPerSecond * RAD_TO_DEG;
    this.readout.seawayDisplacementDeg =
      this.seawayDisplacementRad * RAD_TO_DEG;
  }
}

export function wrap360(degrees: number): number {
  let wrapped = degrees % 360;
  if (wrapped < 0) wrapped += 360;
  return wrapped;
}

export function signedAngleDifferenceDeg(to: number, from: number): number {
  let difference = ((to - from + 180) % 360 + 360) % 360 - 180;
  // Keep the half-turn deterministic rather than changing sign through a
  // round-trip conversion.
  if (difference === -180) difference = 180;
  return difference;
}

function wrapTwoPi(angle: number): number {
  let wrapped = angle % TWO_PI;
  if (wrapped < 0) wrapped += TWO_PI;
  return wrapped;
}

function wrapPi(angle: number): number {
  let wrapped = (angle + Math.PI) % TWO_PI;
  if (wrapped < 0) wrapped += TWO_PI;
  return wrapped - Math.PI;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) {
    throw new RangeError(`${name} must be positive, got ${value}`);
  }
}

