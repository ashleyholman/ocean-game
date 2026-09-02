/**
 * Deterministic human-operator timing and randomness for S5.
 *
 * Every station/purpose pair gets a separately hashed stream. Adding a new
 * trimmer therefore cannot consume a draw that used to belong to the helm,
 * and adding a new kind of perceptual sample cannot move order-response
 * timings. Draws happen only when a state is entered or a scheduled sample is
 * taken; there is no render-frame randomness anywhere in this layer.
 */

export const DEFAULT_SAILING_CREW_SEED = 0x43524557; // 'CREW'

export type HumanRandomPurpose =
  | 'order'
  | 'order-response'
  | 'attention'
  | 'perception'
  | 'action';

export interface ShiftedLognormalProfile {
  /** Hard positive reaction floor. */
  readonly shiftSeconds: number;
  /** Median of the complete shifted sample. */
  readonly medianSeconds: number;
  /** Log-space spread; larger values make the right tail longer. */
  readonly sigma: number;
  readonly minSeconds: number;
  readonly maxSeconds: number;
}

export interface BoundedRange {
  readonly min: number;
  readonly max: number;
}

/**
 * One auditable, deliberately provisional competent-crew profile.
 *
 * These are feel parameters, not claims about a named individual. Event to
 * event variation comes from the bounded shifted-lognormal profiles; there is
 * no persistent fast/slow multiplier or left/right reading bias.
 */
export const COMPETENT_HUMAN_OPERATOR_PROFILE = Object.freeze({
  response: Object.freeze({
    utterance: Object.freeze({
      shiftSeconds: 0.5,
      medianSeconds: 1.05,
      sigma: 0.24,
      minSeconds: 0.72,
      maxSeconds: 1.65,
    }),
    recognition: Object.freeze({
      shiftSeconds: 0.08,
      medianSeconds: 0.3,
      sigma: 0.52,
      minSeconds: 0.12,
      maxSeconds: 0.9,
    }),
    processing: Object.freeze({
      shiftSeconds: 0.2,
      medianSeconds: 0.62,
      sigma: 0.46,
      minSeconds: 0.3,
      maxSeconds: 1.65,
    }),
    motorInitiation: Object.freeze({
      shiftSeconds: 0.12,
      medianSeconds: 0.4,
      sigma: 0.44,
      minSeconds: 0.18,
      maxSeconds: 0.95,
    }),
  }),
  perception: Object.freeze({
    compassDelaySeconds: Object.freeze({ min: 0.16, max: 0.42 }),
    compassAcquisitionSeconds: Object.freeze({ min: 0.24, max: 0.58 }),
    compassFocusedSampleSeconds: Object.freeze({ min: 0.18, max: 0.34 }),
    compassFocusedNoiseStdDeg: 0.38,
    compassPeripheralNoiseStdDeg: 1.15,
    compassFocusedResolutionDeg: 0.5,
    compassPeripheralResolutionDeg: 1,
    headFocusedSampleSeconds: Object.freeze({ min: 0.1, max: 0.22 }),
    headPeripheralSampleSeconds: Object.freeze({ min: 0.28, max: 0.52 }),
    headFocusedNoiseStdDegPerS: 0.12,
    headPeripheralNoiseStdDegPerS: 0.32,
    tillerSampleSeconds: Object.freeze({ min: 0.16, max: 0.34 }),
    tillerNoiseStdN: 4,
    /** The dogvane, looked at directly and then remembered. */
    windVaneAcquisitionSeconds: Object.freeze({ min: 0.2, max: 0.5 }),
    windVaneSampleSeconds: Object.freeze({ min: 0.3, max: 0.7 }),
    windVaneDelaySeconds: Object.freeze({ min: 0.15, max: 0.4 }),
    /** A vane on a stick is a coarse instrument, and it is never still. */
    windVaneFocusedResolutionDeg: 5,
    windVanePeripheralResolutionDeg: 15,
    windVaneFocusedNoiseStdDeg: 2.2,
    windVanePeripheralNoiseStdDeg: 6,
    /** How often a hand at a sheet looks properly at his own cloth. */
    sailSampleSeconds: Object.freeze({ min: 0.35, max: 0.85 }),
    /** Perceptual noise on shake, shape and sheet load respectively. */
    clothNoiseStd: 0.12,
    sailShapeNoiseStdDeg: 3.5,
    sheetLoadNoiseStdNPerM2: 3,
  }),
  attention: Object.freeze({
    checkingCompassSeconds: Object.freeze({ min: 0.72, max: 1.35 }),
    lookingAheadBusySeconds: Object.freeze({ min: 0.7, max: 1.55 }),
    lookingAheadComfortableSeconds: Object.freeze({ min: 1.6, max: 4.4 }),
    watchingResponseSeconds: Object.freeze({ min: 0.75, max: 1.65 }),
    checkingSailsWindSeconds: Object.freeze({ min: 0.65, max: 1.3 }),
  }),
  action: Object.freeze({
    decision: Object.freeze({
      shiftSeconds: 0.1,
      medianSeconds: 0.34,
      sigma: 0.42,
      minSeconds: 0.15,
      maxSeconds: 0.78,
    }),
    motorInitiation: Object.freeze({
      shiftSeconds: 0.12,
      medianSeconds: 0.38,
      sigma: 0.45,
      minSeconds: 0.18,
      maxSeconds: 0.9,
    }),
    rudderErrorStdDeg: 0.7,
    /** A haul is a length of rope, not a protractor reading. */
    trimErrorStdDeg: 0.9,
  }),
} as const);

/** Small stateful generator with an inspectable, reproducible sequence. */
export class HumanRandomStream {
  private readonly initialState: number;
  private stateValue: number;

  constructor(seed: number) {
    this.initialState = seed >>> 0;
    this.stateValue = this.initialState;
  }

  get state(): number {
    return this.stateValue;
  }

  /** Uniform draw in [0, 1). */
  next(): number {
    // Mulberry32. It is compact, deterministic on JS's specified 32-bit
    // integer operations, and good enough for timing/perception variation.
    this.stateValue = (this.stateValue + 0x6d2b79f5) >>> 0;
    let value = Math.imul(
      this.stateValue ^ (this.stateValue >>> 15),
      1 | this.stateValue,
    );
    value =
      (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  }

  /** Zero-mean unit normal. Two fresh draws keep event consumption explicit. */
  normal(): number {
    const u1 = Math.max(this.next(), 1 / 0x1_0000_0000);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  between(range: Readonly<BoundedRange>): number {
    return range.min + (range.max - range.min) * this.next();
  }

  reset(): void {
    this.stateValue = this.initialState;
  }
}

/** Stable string hashing followed by an avalanche mix. */
function streamSeed(
  seed: number,
  station: string,
  purpose: HumanRandomPurpose,
): number {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  const key = `${station}\u0000${purpose}`;
  for (let i = 0; i < key.length; i++) {
    value ^= key.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function createHumanRandomStream(
  seed: number,
  station: string,
  purpose: HumanRandomPurpose,
): HumanRandomStream {
  return new HumanRandomStream(streamSeed(seed, station, purpose));
}

/** Positive, right-skewed response time, sampled once on phase entry. */
export function sampleShiftedLognormalSeconds(
  random: HumanRandomStream,
  profile: Readonly<ShiftedLognormalProfile>,
): number {
  const unshiftedMedian = Math.max(
    profile.medianSeconds - profile.shiftSeconds,
    1e-6,
  );
  const sample =
    profile.shiftSeconds +
    Math.exp(Math.log(unshiftedMedian) + profile.sigma * random.normal());
  return clamp(sample, profile.minSeconds, profile.maxSeconds);
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
