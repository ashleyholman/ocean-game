import { REGRESSION_ORDER, SEA_STATES } from '../../ocean/presets';
import type { SeaState } from '../../ocean/seaState';
import {
  HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
  HULL_ATTITUDE_LIMIT_RADIANS,
  HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND,
  PHYSICS_STEP,
} from '../BuoyantBody';
import { WaveField } from '../../scene/Waves';
import {
  CABIN_AFT_Z,
  CABIN_FORWARD_Z,
  CABIN_SOLE_Y,
  DESIGN_DRAUGHT,
  HULL_LENGTH,
  MAX_BEAM,
  walkingDeckY,
} from './hullForm';
import { GRAVITY, RHO_WATER, hydrostaticsAt } from './hydrostatics';
import { buildLoadedShip } from './massModel';
import { prescribedThroughWaterVelocity } from './EncounterMotion';
import {
  buildSchoonerBuoyancy,
  measurePitchDecay,
  measureRollDecay,
} from './SchoonerBuoyancy';
import { CROSSTREES } from './rig';

const DEG = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export const SHIP_RESPONSE_FORMAT_VERSION = 2;
export const SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES = {
  rmsRelativeDifference: 0.05,
  peakRelativeDifference: 0.12,
} as const;

/**
 * The committed baseline is deliberately the same long window used by the
 * original heading audit: settle for 20 seconds, then measure 70 seconds. The
 * CI suite uses shorter, selected cases and never rewrites the baseline.
 */
export const SHIP_RESPONSE_BASELINE_CONFIG = {
  headingStepDeg: 15,
  warmupSeconds: 20,
  measurementSeconds: 70,
  callerHz: 60,
} as const;

/**
 * Small committed moving-hull matrix. The headings are spaced around the
 * CURRENT_MODERATE primary swell's 54 degree travel heading, so the set covers
 * following, both quarters, both beams and head seas without implying steering
 * or a sailing-speed model.
 */
export const SHIP_RESPONSE_ENCOUNTER_CONFIG = {
  seaStateNames: ['CURRENT_MODERATE'] as const,
  referenceWaveHeadingDeg: 54,
  headingsDeg: [9, 54, 99, 144, 189, 234, 279, 324] as const,
  speedThroughWaterMps: 4,
  warmupSeconds: 20,
  measurementSeconds: 70,
  callerHz: 60,
} as const;

/** All non-debug states in the established buoyancy regression order. */
export const SHIP_RESPONSE_BASELINE_SEAS: readonly string[] = REGRESSION_ORDER.filter(
  (name) => SEA_STATES.find((state) => state.name === name)?.purpose === 'PLAYABLE',
);

export interface ShipResponsePoint {
  name: 'deck' | 'cabin' | 'lookout';
  localMetres: { x: number; y: number; z: number };
  description: string;
}

const foreLookout = CROSSTREES.find((platform) => platform.name === 'foreCrosstrees');
if (!foreLookout) throw new Error('rig has no foremast lookout point');

/** Representative standing-body points used for comfort acceleration history. */
export const SHIP_RESPONSE_POINTS: readonly ShipResponsePoint[] = [
  {
    name: 'deck',
    localMetres: { x: 0, y: walkingDeckY(0) + 1, z: 0 },
    description: 'Standing-body centre one metre above the working deck amidships.',
  },
  {
    name: 'cabin',
    localMetres: {
      x: 0,
      y: CABIN_SOLE_Y + 1,
      z: (CABIN_AFT_Z + CABIN_FORWARD_Z) / 2,
    },
    description: "Standing-body centre one metre above the captain's-cabin sole.",
  },
  {
    name: 'lookout',
    localMetres: { x: 0, y: foreLookout.y + 1, z: foreLookout.z },
    description: 'Standing-body centre one metre above the foremast lookout platform.',
  },
];

export interface ScalarSummary {
  min: number;
  max: number;
  mean: number;
  rms: number;
  standardDeviation: number;
  peakAbsolute: number;
}

export interface PointMotionSummary {
  accelerationMagnitudeMps2: ScalarSummary;
  jerkMagnitudeMps3: ScalarSummary;
  peakAccelerationG: number;
}

export interface ShipResponseCase {
  seaState: string;
  presetPurpose: SeaState['purpose'];
  presentationHeadingDeg: number;
  modelYawDeg: number;
  /** Prescribed bow-forward tow speed through still mean water. */
  speedThroughWaterMps: number;
  sampleFrames: number;
  finite: boolean;
  motion: {
    /** Absolute mean COM height; the wave field's vertical datum is arbitrary. */
    meanComWorldYMetres: number;
    /** Vertical COM displacement about that case's own measured mean. */
    heaveDisplacementMetres: ScalarSummary;
    verticalSpeedMps: ScalarSummary;
    pitchDeg: ScalarSummary;
    rollDeg: ScalarSummary;
    pitchRateDegPerSecond: ScalarSummary;
    rollRateDegPerSecond: ScalarSummary;
    verticalAccelerationMps2: ScalarSummary;
    pitchAccelerationDegPerSecond2: ScalarSummary;
    rollAccelerationDegPerSecond2: ScalarSummary;
    verticalJerkMps3: ScalarSummary;
  };
  locations: Record<ShipResponsePoint['name'], PointMotionSummary>;
  contact: {
    wetStationFraction: ScalarSummary;
    submergedVolumeRatio: ScalarSummary;
    fullAirborneFrames: number;
    longestFullAirborneSeconds: number;
    overtoppingFrames: number;
    overtoppingFrameFraction: number;
    overtoppingEventSamples: number;
    maxOvertoppingDepthMetres: number;
    maxOvertoppingVerticalEntrySpeedMps: number;
  };
  limits: {
    attitudeLimitDeg: number;
    angularRateLimitDegPerSecond: number;
    verticalSpeedLimitMps: number;
    pitchMarginDeg: number;
    rollMarginDeg: number;
    pitchRateMarginDegPerSecond: number;
    rollRateMarginDegPerSecond: number;
    verticalSpeedMarginMps: number;
    touchedAttitudeLimit: boolean;
    touchedAngularRateLimit: boolean;
    touchedVerticalSpeedLimit: boolean;
  };
  maxWaveInverseSolveResidualMetres: number;
}

export interface FreeDecayEvidence {
  initialAngleDeg: number;
  durationSeconds: number;
  roll: {
    measuredPeriodSeconds: number;
    zeroCrossingCount: number;
  };
  pitch: {
    measuredPeriodSeconds: number;
    effectiveDampingRatio: number;
    closedFormUndampedPeriodSeconds: number;
    measuredToClosedFormRatio: number;
    zeroCrossingsSeconds: number[];
    peaks: Array<{ timeSeconds: number; pitchDeg: number }>;
  };
}

export interface ShipResponseMatrix {
  formatVersion: typeof SHIP_RESPONSE_FORMAT_VERSION;
  note: string;
  limitations: readonly string[];
  regenerateCommand: string;
  configuration: {
    seaStates: readonly string[];
    headingsDeg: readonly number[];
    /** Optional wave-system heading used to choose a diagnostic heading set. */
    referenceWaveHeadingDeg?: number;
    headingConvention: string;
    warmupSeconds: number;
    measurementSeconds: number;
    callerHz: number;
    physicsHz: number;
    speedThroughWaterMps: number;
    waveInitialTimeSeconds: 0;
    representativePoints: readonly ShipResponsePoint[];
  };
  vessel: {
    hullLengthMetres: number;
    maximumBeamMetres: number;
    designDraughtMetres: number;
    displacementTonnes: number;
    stationCount: number;
  };
  freeDecay: FreeDecayEvidence;
  summary: {
    caseCount: number;
    maximumPeakHeave: MatrixExtreme;
    maximumRmsHeave: MatrixExtreme;
    maximumPeakRoll: MatrixExtreme;
    maximumPeakPitch: MatrixExtreme;
    maximumVerticalAcceleration: MatrixExtreme;
    maximumLookoutAcceleration: MatrixExtreme;
    smallestRollLimiterMargin: MatrixExtreme;
    overtoppingCaseCount: number;
    limiterContactCaseCount: number;
  };
  cases: ShipResponseCase[];
}

export interface MatrixExtreme {
  seaState: string;
  presentationHeadingDeg: number;
  value: number;
}

export interface ShipResponseOptions {
  seaStateNames?: readonly string[];
  headingsDeg?: readonly number[];
  /** Evidence metadata only; it does not rotate the sea or hull. */
  referenceWaveHeadingDeg?: number;
  /** One prescribed bow-forward speed for every case in this matrix. */
  speedThroughWaterMps?: number;
  warmupSeconds?: number;
  measurementSeconds?: number;
  callerHz?: number;
  onCaseComplete?: (
    completed: number,
    total: number,
    result: ShipResponseCase,
  ) => void;
}

class RunningStats {
  private count = 0;
  private sum = 0;
  private sumSquares = 0;
  private minimum = Infinity;
  private maximum = -Infinity;

  add(value: number): void {
    if (!Number.isFinite(value)) throw new Error(`non-finite response metric: ${value}`);
    this.count++;
    this.sum += value;
    this.sumSquares += value * value;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
  }

  summary(): ScalarSummary {
    if (this.count === 0) {
      return { min: 0, max: 0, mean: 0, rms: 0, standardDeviation: 0, peakAbsolute: 0 };
    }
    const mean = this.sum / this.count;
    const meanSquare = this.sumSquares / this.count;
    return {
      min: round(this.minimum),
      max: round(this.maximum),
      mean: round(mean),
      rms: round(Math.sqrt(meanSquare)),
      standardDeviation: round(Math.sqrt(Math.max(meanSquare - mean * mean, 0))),
      peakAbsolute: round(Math.max(Math.abs(this.minimum), Math.abs(this.maximum))),
    };
  }

  /**
   * Summarise motion about its measured mean rather than the world's arbitrary
   * zero. This is the physically useful form for heave response.
   */
  centredSummary(): ScalarSummary {
    if (this.count === 0) {
      return { min: 0, max: 0, mean: 0, rms: 0, standardDeviation: 0, peakAbsolute: 0 };
    }
    const mean = this.sum / this.count;
    const meanSquare = this.sumSquares / this.count;
    const standardDeviation = Math.sqrt(Math.max(meanSquare - mean * mean, 0));
    const minimum = this.minimum - mean;
    const maximum = this.maximum - mean;
    return {
      min: round(minimum),
      max: round(maximum),
      mean: 0,
      rms: round(standardDeviation),
      standardDeviation: round(standardDeviation),
      peakAbsolute: round(Math.max(Math.abs(minimum), Math.abs(maximum))),
    };
  }
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface PointKinematicsSample {
  accelerationMagnitude: number | null;
  jerkMagnitude: number | null;
}

class PointKinematics {
  private previousPosition: Vec3 | null = null;
  private previousVelocity: Vec3 | null = null;
  private previousAcceleration: Vec3 | null = null;

  update(position: Vec3, dt: number): PointKinematicsSample {
    if (!this.previousPosition) {
      this.previousPosition = { ...position };
      return { accelerationMagnitude: null, jerkMagnitude: null };
    }

    const velocity = difference(position, this.previousPosition, dt);
    this.previousPosition = { ...position };
    if (!this.previousVelocity) {
      this.previousVelocity = velocity;
      return { accelerationMagnitude: null, jerkMagnitude: null };
    }

    const acceleration = difference(velocity, this.previousVelocity, dt);
    this.previousVelocity = velocity;
    const accelerationMagnitude = magnitude(acceleration);
    if (!this.previousAcceleration) {
      this.previousAcceleration = acceleration;
      return { accelerationMagnitude, jerkMagnitude: null };
    }

    const jerk = difference(acceleration, this.previousAcceleration, dt);
    this.previousAcceleration = acceleration;
    return { accelerationMagnitude, jerkMagnitude: magnitude(jerk) };
  }
}

function difference(a: Vec3, b: Vec3, dt: number): Vec3 {
  return { x: (a.x - b.x) / dt, y: (a.y - b.y) / dt, z: (a.z - b.z) / dt };
}

function magnitude(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function normaliseDegrees(value: number): number {
  const normalised = ((value % 360) + 360) % 360;
  return Math.abs(normalised - 360) < 1e-9 ? 0 : normalised;
}

/** Local +z is the bow; in render bearings +z is presentation south (180 deg). */
export function presentationHeadingToModelYawRadians(headingDeg: number): number {
  return normaliseDegrees(180 - headingDeg) * DEG;
}

export function responseHeadings(stepDeg = SHIP_RESPONSE_BASELINE_CONFIG.headingStepDeg): number[] {
  if (!Number.isFinite(stepDeg) || stepDeg <= 0 || 360 % stepDeg !== 0) {
    throw new Error(`heading step must be a positive divisor of 360, got ${stepDeg}`);
  }
  return Array.from({ length: 360 / stepDeg }, (_, index) => index * stepDeg);
}

function findExactSeaState(name: string): SeaState {
  const state = SEA_STATES.find((candidate) => candidate.name === name);
  if (!state) throw new Error(`unknown sea state: ${name}`);
  return state;
}

function representativeWorldPoints(
  body: ReturnType<typeof buildSchoonerBuoyancy>,
  localX: number,
  localZ: number,
  yaw: number,
): Record<ShipResponsePoint['name'], Vec3> {
  const result = {} as Record<ShipResponsePoint['name'], Vec3>;
  for (const point of SHIP_RESPONSE_POINTS) {
    const world = { x: 0, y: 0, z: 0 };
    body.worldPoint(
      point.localMetres.x,
      point.localMetres.y,
      point.localMetres.z,
      localX,
      localZ,
      yaw,
      world,
    );
    result[point.name] = world;
  }
  return result;
}

/**
 * Run one headless response case. Horizontal motion, when requested, is a
 * prescribed bow-forward tow through wave coordinates; only heave, pitch and
 * roll are force-integrated.
 */
export function runShipResponseCase(options: {
  seaStateName: string;
  presentationHeadingDeg: number;
  speedThroughWaterMps?: number;
  warmupSeconds: number;
  measurementSeconds: number;
  callerHz: number;
}): ShipResponseCase {
  const seaState = findExactSeaState(options.seaStateName);
  const headingDeg = normaliseDegrees(options.presentationHeadingDeg);
  const yaw = presentationHeadingToModelYawRadians(headingDeg);
  const speedThroughWaterMps = options.speedThroughWaterMps ?? 0;
  const velocityThroughWater = prescribedThroughWaterVelocity(
    headingDeg,
    speedThroughWaterMps,
  );
  const callerDt = 1 / options.callerHz;
  const warmupFrames = Math.round(options.warmupSeconds * options.callerHz);
  const measurementFrames = Math.round(options.measurementSeconds * options.callerHz);
  if (warmupFrames < 0 || measurementFrames < 1 || !Number.isFinite(callerDt)) {
    throw new Error('response durations and caller frequency must be finite and positive');
  }
  const physicsSubstepsPerFrame = Math.round(callerDt / PHYSICS_STEP);
  if (
    speedThroughWaterMps > 0 &&
    (physicsSubstepsPerFrame < 1 ||
      Math.abs(physicsSubstepsPerFrame * PHYSICS_STEP - callerDt) > 1e-10)
  ) {
    throw new Error(
      `moving response caller frequency ${options.callerHz} Hz must divide the ` +
        `${1 / PHYSICS_STEP} Hz physics frequency exactly`,
    );
  }

  const waves = new WaveField(seaState);
  const body = buildSchoonerBuoyancy();
  let localX = 0;
  let localZ = 0;
  body.snapToSurface(waves, localX, localZ, yaw);

  const heave = new RunningStats();
  const verticalSpeed = new RunningStats();
  const pitch = new RunningStats();
  const roll = new RunningStats();
  const pitchRate = new RunningStats();
  const rollRate = new RunningStats();
  const verticalAcceleration = new RunningStats();
  const pitchAcceleration = new RunningStats();
  const rollAcceleration = new RunningStats();
  const verticalJerk = new RunningStats();
  const wetStationFraction = new RunningStats();
  const submergedVolumeRatio = new RunningStats();

  const pointKinematics = Object.fromEntries(
    SHIP_RESPONSE_POINTS.map((point) => [point.name, new PointKinematics()]),
  ) as Record<ShipResponsePoint['name'], PointKinematics>;
  const pointAcceleration = Object.fromEntries(
    SHIP_RESPONSE_POINTS.map((point) => [point.name, new RunningStats()]),
  ) as Record<ShipResponsePoint['name'], RunningStats>;
  const pointJerk = Object.fromEntries(
    SHIP_RESPONSE_POINTS.map((point) => [point.name, new RunningStats()]),
  ) as Record<ShipResponsePoint['name'], RunningStats>;

  const initialWorldPoints = representativeWorldPoints(body, localX, localZ, yaw);
  for (const point of SHIP_RESPONSE_POINTS) {
    pointKinematics[point.name].update(
      initialWorldPoints[point.name],
      callerDt,
    );
  }

  let previousPitchRate = body.pitchRate;
  let previousRollRate = body.rollRate;
  let previousVerticalAcceleration = body.accelerationY;
  let fullAirborneFrames = 0;
  let currentAirborneRun = 0;
  let longestAirborneRun = 0;
  let overtoppingFrames = 0;
  let overtoppingEventSamples = 0;
  let maxOvertoppingDepth = 0;
  let maxOvertoppingEntrySpeed = 0;
  let touchedAttitudeLimit = false;
  let touchedAngularRateLimit = false;
  let touchedVerticalSpeedLimit = false;

  const totalFrames = warmupFrames + measurementFrames;
  for (let frame = 0; frame < totalFrames; frame++) {
    let frameOvertoppingEventSamples = 0;
    let frameMaxOvertoppingDepth = 0;
    let frameMaxOvertoppingEntrySpeed = 0;
    const accumulateOvertopping = (): void => {
      frameOvertoppingEventSamples += body.overtopEvents.length;
      for (const event of body.overtopEvents) {
        frameMaxOvertoppingDepth = Math.max(frameMaxOvertoppingDepth, event.depth);
        frameMaxOvertoppingEntrySpeed = Math.max(
          frameMaxOvertoppingEntrySpeed,
          event.speed,
        );
      }
    };

    if (speedThroughWaterMps === 0) {
      // Preserve the permanent stationary baseline's exact update path.
      body.update(callerDt, waves, localX, localZ, yaw, PHYSICS_STEP);
      accumulateOvertopping();
    } else {
      // Keep position and wave time synchronised at every 240 Hz physics
      // sample. Advancing only once per 60 Hz caller frame would turn the tow
      // into a staircase and make encounter frequency frame-rate dependent.
      for (let substep = 0; substep < physicsSubstepsPerFrame; substep++) {
        localX += velocityThroughWater.x * PHYSICS_STEP;
        localZ += velocityThroughWater.z * PHYSICS_STEP;
        body.update(PHYSICS_STEP, waves, localX, localZ, yaw, PHYSICS_STEP);
        accumulateOvertopping();
      }
    }

    const pitchAccelerationRadians = (body.pitchRate - previousPitchRate) / callerDt;
    const rollAccelerationRadians = (body.rollRate - previousRollRate) / callerDt;
    const jerkY = (body.accelerationY - previousVerticalAcceleration) / callerDt;
    previousPitchRate = body.pitchRate;
    previousRollRate = body.rollRate;
    previousVerticalAcceleration = body.accelerationY;

    const worldPoints = representativeWorldPoints(body, localX, localZ, yaw);
    const pointSamples = {} as Record<ShipResponsePoint['name'], PointKinematicsSample>;
    for (const point of SHIP_RESPONSE_POINTS) {
      pointSamples[point.name] = pointKinematics[point.name].update(
        worldPoints[point.name],
        callerDt,
      );
    }

    if (frame < warmupFrames) continue;

    heave.add(body.comWorldY);
    verticalSpeed.add(body.velocityY);
    pitch.add(body.pitch * RAD_TO_DEG);
    roll.add(body.roll * RAD_TO_DEG);
    pitchRate.add(body.pitchRate * RAD_TO_DEG);
    rollRate.add(body.rollRate * RAD_TO_DEG);
    verticalAcceleration.add(body.accelerationY);
    pitchAcceleration.add(pitchAccelerationRadians * RAD_TO_DEG);
    rollAcceleration.add(rollAccelerationRadians * RAD_TO_DEG);
    verticalJerk.add(jerkY);

    const wetFraction = body.immersedCount / Math.max(body.stations.length, 1);
    const immersedVolume = body.contacts.reduce(
      (sum, contact) => sum + contact.immersedVolumeM3,
      0,
    );
    wetStationFraction.add(wetFraction);
    submergedVolumeRatio.add(immersedVolume / body.displacedVolume);

    for (const point of SHIP_RESPONSE_POINTS) {
      const sample = pointSamples[point.name];
      if (sample.accelerationMagnitude !== null) {
        pointAcceleration[point.name].add(sample.accelerationMagnitude);
      }
      if (sample.jerkMagnitude !== null) pointJerk[point.name].add(sample.jerkMagnitude);
    }

    if (body.immersedCount === 0) {
      fullAirborneFrames++;
      currentAirborneRun++;
      longestAirborneRun = Math.max(longestAirborneRun, currentAirborneRun);
    } else {
      currentAirborneRun = 0;
    }

    if (frameOvertoppingEventSamples > 0) overtoppingFrames++;
    overtoppingEventSamples += frameOvertoppingEventSamples;
    maxOvertoppingDepth = Math.max(maxOvertoppingDepth, frameMaxOvertoppingDepth);
    maxOvertoppingEntrySpeed = Math.max(
      maxOvertoppingEntrySpeed,
      frameMaxOvertoppingEntrySpeed,
    );

    touchedAttitudeLimit ||=
      Math.abs(body.pitch) >= HULL_ATTITUDE_LIMIT_RADIANS - 1e-9 ||
      Math.abs(body.roll) >= HULL_ATTITUDE_LIMIT_RADIANS - 1e-9;
    touchedAngularRateLimit ||=
      Math.abs(body.pitchRate) >= HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND - 1e-9 ||
      Math.abs(body.rollRate) >= HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND - 1e-9;
    touchedVerticalSpeedLimit ||=
      Math.abs(body.velocityY) >= HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND - 1e-9;
  }

  const heaveComY = heave.summary();
  const motion = {
    meanComWorldYMetres: heaveComY.mean,
    heaveDisplacementMetres: heave.centredSummary(),
    verticalSpeedMps: verticalSpeed.summary(),
    pitchDeg: pitch.summary(),
    rollDeg: roll.summary(),
    pitchRateDegPerSecond: pitchRate.summary(),
    rollRateDegPerSecond: rollRate.summary(),
    verticalAccelerationMps2: verticalAcceleration.summary(),
    pitchAccelerationDegPerSecond2: pitchAcceleration.summary(),
    rollAccelerationDegPerSecond2: rollAcceleration.summary(),
    verticalJerkMps3: verticalJerk.summary(),
  };

  const locations = {} as Record<ShipResponsePoint['name'], PointMotionSummary>;
  for (const point of SHIP_RESPONSE_POINTS) {
    const acceleration = pointAcceleration[point.name].summary();
    locations[point.name] = {
      accelerationMagnitudeMps2: acceleration,
      jerkMagnitudeMps3: pointJerk[point.name].summary(),
      peakAccelerationG: round(acceleration.peakAbsolute / GRAVITY),
    };
  }

  const attitudeLimitDeg = HULL_ATTITUDE_LIMIT_RADIANS * RAD_TO_DEG;
  const angularRateLimitDeg = HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND * RAD_TO_DEG;

  return {
    seaState: seaState.name,
    presetPurpose: seaState.purpose,
    presentationHeadingDeg: headingDeg,
    modelYawDeg: round(normaliseDegrees(180 - headingDeg)),
    speedThroughWaterMps: round(speedThroughWaterMps),
    sampleFrames: measurementFrames,
    finite: true,
    motion,
    locations,
    contact: {
      wetStationFraction: wetStationFraction.summary(),
      submergedVolumeRatio: submergedVolumeRatio.summary(),
      fullAirborneFrames,
      longestFullAirborneSeconds: round(longestAirborneRun * callerDt),
      overtoppingFrames,
      overtoppingFrameFraction: round(overtoppingFrames / measurementFrames),
      overtoppingEventSamples,
      maxOvertoppingDepthMetres: round(maxOvertoppingDepth),
      maxOvertoppingVerticalEntrySpeedMps: round(maxOvertoppingEntrySpeed),
    },
    limits: {
      attitudeLimitDeg: round(attitudeLimitDeg),
      angularRateLimitDegPerSecond: round(angularRateLimitDeg),
      verticalSpeedLimitMps: HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND,
      pitchMarginDeg: round(attitudeLimitDeg - motion.pitchDeg.peakAbsolute),
      rollMarginDeg: round(attitudeLimitDeg - motion.rollDeg.peakAbsolute),
      pitchRateMarginDegPerSecond: round(
        angularRateLimitDeg - motion.pitchRateDegPerSecond.peakAbsolute,
      ),
      rollRateMarginDegPerSecond: round(
        angularRateLimitDeg - motion.rollRateDegPerSecond.peakAbsolute,
      ),
      verticalSpeedMarginMps: round(
        HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND - motion.verticalSpeedMps.peakAbsolute,
      ),
      touchedAttitudeLimit,
      touchedAngularRateLimit,
      touchedVerticalSpeedLimit,
    },
    maxWaveInverseSolveResidualMetres: round(waves.maximumSolveResidual, 10),
  };
}

export function measureShipFreeDecay(initialAngleDeg = 5, durationSeconds = 30): FreeDecayEvidence {
  const flatForRoll = new WaveField(findExactSeaState('FLAT'));
  const rollBody = buildSchoonerBuoyancy();
  const rollDecay = measureRollDecay(
    rollBody,
    flatForRoll,
    initialAngleDeg * DEG,
    durationSeconds,
  );

  const flatForPitch = new WaveField(findExactSeaState('FLAT'));
  const pitchBody = buildSchoonerBuoyancy();
  const pitchDecay = measurePitchDecay(
    pitchBody,
    flatForPitch,
    initialAngleDeg * DEG,
    durationSeconds,
  );

  const hydrostatics = hydrostaticsAt(DESIGN_DRAUGHT);
  const { properties } = buildLoadedShip();
  const longitudinalMetacentricHeight =
    hydrostatics.kb + hydrostatics.bmL - properties.comY;
  const pitchStiffness =
    RHO_WATER * GRAVITY * hydrostatics.volume * longitudinalMetacentricHeight;
  const closedFormPeriod =
    2 * Math.PI * Math.sqrt(pitchBody.inertiaPitch / pitchStiffness);

  return {
    initialAngleDeg,
    durationSeconds,
    roll: {
      measuredPeriodSeconds: round(rollDecay.period),
      zeroCrossingCount: rollDecay.crossings.length,
    },
    pitch: {
      measuredPeriodSeconds: round(pitchDecay.period),
      effectiveDampingRatio: round(pitchDecay.dampingRatio),
      closedFormUndampedPeriodSeconds: round(closedFormPeriod),
      measuredToClosedFormRatio: round(pitchDecay.period / closedFormPeriod),
      zeroCrossingsSeconds: pitchDecay.crossings.map((value) => round(value)),
      peaks: pitchDecay.peaks.map((peak) => ({
        timeSeconds: round(peak.timeSeconds),
        pitchDeg: round(peak.pitchRadians * RAD_TO_DEG),
      })),
    },
  };
}

function extreme(
  cases: readonly ShipResponseCase[],
  select: (result: ShipResponseCase) => number,
  mode: 'max' | 'min' = 'max',
): MatrixExtreme {
  if (cases.length === 0) throw new Error('response matrix has no cases');
  let chosen = cases[0];
  let value = select(chosen);
  for (const result of cases.slice(1)) {
    const candidate = select(result);
    if ((mode === 'max' && candidate > value) || (mode === 'min' && candidate < value)) {
      chosen = result;
      value = candidate;
    }
  }
  return {
    seaState: chosen.seaState,
    presentationHeadingDeg: chosen.presentationHeadingDeg,
    value: round(value),
  };
}

/** Build a deterministic response matrix at one prescribed through-water speed. */
export function buildShipResponseMatrix(options: ShipResponseOptions = {}): ShipResponseMatrix {
  const seaStateNames = options.seaStateNames ?? SHIP_RESPONSE_BASELINE_SEAS;
  const headingsDeg = options.headingsDeg ?? responseHeadings();
  const speedThroughWaterMps = options.speedThroughWaterMps ?? 0;
  // Validate before starting a potentially long matrix run.
  prescribedThroughWaterVelocity(0, speedThroughWaterMps);
  if (
    options.referenceWaveHeadingDeg !== undefined &&
    !Number.isFinite(options.referenceWaveHeadingDeg)
  ) {
    throw new Error(`reference wave heading must be finite, got ${options.referenceWaveHeadingDeg}`);
  }
  const warmupSeconds =
    options.warmupSeconds ?? SHIP_RESPONSE_BASELINE_CONFIG.warmupSeconds;
  const measurementSeconds =
    options.measurementSeconds ?? SHIP_RESPONSE_BASELINE_CONFIG.measurementSeconds;
  const callerHz = options.callerHz ?? SHIP_RESPONSE_BASELINE_CONFIG.callerHz;
  const total = seaStateNames.length * headingsDeg.length;
  const cases: ShipResponseCase[] = [];

  for (const seaStateName of seaStateNames) {
    for (const presentationHeadingDeg of headingsDeg) {
      const result = runShipResponseCase({
        seaStateName,
        presentationHeadingDeg,
        speedThroughWaterMps,
        warmupSeconds,
        measurementSeconds,
        callerHz,
      });
      cases.push(result);
      options.onCaseComplete?.(cases.length, total, result);
    }
  }

  const body = buildSchoonerBuoyancy();
  const moving = speedThroughWaterMps > 0;
  return {
    formatVersion: SHIP_RESPONSE_FORMAT_VERSION,
    note: moving
      ? 'Committed prescribed-speed ship-response baseline. Regenerate intentionally after ' +
        'an encounter or motion change and review the Git diff; exact cells are evidence, ' +
        'while CI enforces broader physical invariants.'
      : 'Committed zero-speed ship-response baseline. Regenerate intentionally after ' +
        'a motion change and review the Git diff; exact cells are evidence, while CI ' +
        'enforces broader physical invariants.',
    limitations: [
      moving
        ? 'Horizontal travel is a prescribed bow-forward tow; surge, sway and yaw are not force-integrated.'
        : 'The hull is stationary in wave coordinates; surge, sway and yaw are not dynamic yet.',
      ...(moving
        ? ['Speed is through still mean water; current, leeway, propulsion and steering are absent.']
        : []),
      'Sea-state purpose is environmental metadata, not a schooner safety rating.',
      'Overtopping is the current longitudinal crown-entry detector, not a deck-water volume model.',
      'Point acceleration and jerk are rigid-body kinematics and exclude gravity, rig flex and impacts.',
    ],
    regenerateCommand: moving ? 'npm run ship:encounter' : 'npm run ship:response',
    configuration: {
      seaStates: [...seaStateNames],
      headingsDeg: [...headingsDeg],
      ...(options.referenceWaveHeadingDeg === undefined
        ? {}
        : { referenceWaveHeadingDeg: round(normaliseDegrees(options.referenceWaveHeadingDeg)) }),
      headingConvention:
        'Presentation heading is the true-style bearing the bow points toward, ' +
        'degrees clockwise from presentation north. Model yaw is also recorded; ' +
        'model yaw 0 degrees points the bow toward presentation heading 180 degrees.',
      warmupSeconds,
      measurementSeconds,
      callerHz,
      physicsHz: 1 / PHYSICS_STEP,
      speedThroughWaterMps: round(speedThroughWaterMps),
      waveInitialTimeSeconds: 0,
      representativePoints: SHIP_RESPONSE_POINTS,
    },
    vessel: {
      hullLengthMetres: HULL_LENGTH,
      maximumBeamMetres: MAX_BEAM,
      designDraughtMetres: DESIGN_DRAUGHT,
      displacementTonnes: round(body.mass / 1000),
      stationCount: body.stations.length,
    },
    freeDecay: measureShipFreeDecay(),
    summary: {
      caseCount: cases.length,
      maximumPeakHeave: extreme(
        cases,
        (result) => result.motion.heaveDisplacementMetres.peakAbsolute,
      ),
      maximumRmsHeave: extreme(
        cases,
        (result) => result.motion.heaveDisplacementMetres.rms,
      ),
      maximumPeakRoll: extreme(cases, (result) => result.motion.rollDeg.peakAbsolute),
      maximumPeakPitch: extreme(cases, (result) => result.motion.pitchDeg.peakAbsolute),
      maximumVerticalAcceleration: extreme(
        cases,
        (result) => result.motion.verticalAccelerationMps2.peakAbsolute,
      ),
      maximumLookoutAcceleration: extreme(
        cases,
        (result) => result.locations.lookout.accelerationMagnitudeMps2.peakAbsolute,
      ),
      smallestRollLimiterMargin: extreme(
        cases,
        (result) => result.limits.rollMarginDeg,
        'min',
      ),
      overtoppingCaseCount: cases.filter((result) => result.contact.overtoppingFrames > 0).length,
      limiterContactCaseCount: cases.filter(
        (result) =>
          result.limits.touchedAttitudeLimit ||
          result.limits.touchedAngularRateLimit ||
          result.limits.touchedVerticalSpeedLimit,
      ).length,
    },
    cases,
  };
}
