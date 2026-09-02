import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import {
  HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND,
  HULL_ATTITUDE_LIMIT_RADIANS,
  HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND,
  PHYSICS_STEP,
} from '../BuoyantBody';
import type { VesselHorizontalDynamicsBridge } from '../VesselMotion';
import { prescribedThroughWaterVelocity } from './EncounterMotion';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { SchoonerHorizontalDynamics } from './SchoonerHorizontalDynamics';
import {
  SHIP_RESPONSE_ENCOUNTER_CONFIG,
  presentationHeadingToModelYawRadians,
  type ScalarSummary,
} from './SchoonerResponse';

const RAD_TO_DEG = 180 / Math.PI;

export const SCHOONER_HORIZONTAL_RESPONSE_FORMAT_VERSION = 1;
export const SCHOONER_HORIZONTAL_RESPONSE_CONFIG = Object.freeze({
  seaStateName: SHIP_RESPONSE_ENCOUNTER_CONFIG.seaStateNames[0],
  headingsDeg: SHIP_RESPONSE_ENCOUNTER_CONFIG.headingsDeg,
  initialSpeedMps: SHIP_RESPONSE_ENCOUNTER_CONFIG.speedThroughWaterMps,
  warmupSeconds: SHIP_RESPONSE_ENCOUNTER_CONFIG.warmupSeconds,
  measurementSeconds: SHIP_RESPONSE_ENCOUNTER_CONFIG.measurementSeconds,
  callerHz: SHIP_RESPONSE_ENCOUNTER_CONFIG.callerHz,
} as const);

class RunningStats {
  private count = 0;
  private sum = 0;
  private sumSquares = 0;
  private minimum = Infinity;
  private maximum = -Infinity;

  add(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite horizontal-response metric: ${value}`);
    }
    this.count++;
    this.sum += value;
    this.sumSquares += value * value;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
  }

  summary(centre = false): ScalarSummary {
    if (this.count === 0) {
      return {
        min: 0,
        max: 0,
        mean: 0,
        rms: 0,
        standardDeviation: 0,
        peakAbsolute: 0,
      };
    }
    const mean = this.sum / this.count;
    const meanSquare = this.sumSquares / this.count;
    const standardDeviation = Math.sqrt(
      Math.max(meanSquare - mean * mean, 0),
    );
    const minimum = centre ? this.minimum - mean : this.minimum;
    const maximum = centre ? this.maximum - mean : this.maximum;
    return {
      min: round(minimum),
      max: round(maximum),
      mean: centre ? 0 : round(mean),
      rms: round(centre ? standardDeviation : Math.sqrt(meanSquare)),
      standardDeviation: round(standardDeviation),
      peakAbsolute: round(Math.max(Math.abs(minimum), Math.abs(maximum))),
    };
  }
}

export interface FreeHorizontalResponseCase {
  seaState: string;
  presentationHeadingDeg: number;
  initialSpeedMps: number;
  horizontal: {
    speedMps: ScalarSummary;
    forwardSpeedMps: ScalarSummary;
    portSpeedMps: ScalarSummary;
    yawChangeDeg: ScalarSummary;
    yawRateDegPerSecond: ScalarSummary;
    endSpeedMps: number;
    endForwardSpeedMps: number;
    endPortSpeedMps: number;
    endYawChangeDeg: number;
    endYawRateDegPerSecond: number;
    measuredDisplacementM: { x: number; z: number; magnitude: number };
  };
  motion: {
    heaveDisplacementMetres: ScalarSummary;
    pitchDeg: ScalarSummary;
    rollDeg: ScalarSummary;
    verticalAccelerationMps2: ScalarSummary;
  };
  contact: {
    overtoppingFrames: number;
    touchedSafetyLimiter: boolean;
  };
  maxWaveInverseSolveResidualMetres: number;
}

export interface SchoonerHorizontalResponseEvidence {
  formatVersion: number;
  note: string;
  limitations: string[];
  regenerateCommand: string;
  configuration: typeof SCHOONER_HORIZONTAL_RESPONSE_CONFIG & {
    physicsHz: number;
    mode: 'free-release';
  };
  cases: FreeHorizontalResponseCase[];
}

function round(value: number, digits = 6): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function wrapAngle(value: number): number {
  let wrapped = (value + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

export function runFreeHorizontalResponseCase(
  presentationHeadingDeg: number,
  timing: {
    warmupSeconds?: number;
    measurementSeconds?: number;
    callerHz?: number;
  } = {},
): FreeHorizontalResponseCase {
  const config = SCHOONER_HORIZONTAL_RESPONSE_CONFIG;
  const warmupSeconds = timing.warmupSeconds ?? config.warmupSeconds;
  const measurementSeconds =
    timing.measurementSeconds ?? config.measurementSeconds;
  const callerHz = timing.callerHz ?? config.callerHz;
  if (
    !Number.isFinite(warmupSeconds) ||
    warmupSeconds < 0 ||
    !Number.isFinite(measurementSeconds) ||
    measurementSeconds <= 0 ||
    !Number.isFinite(callerHz) ||
    callerHz <= 0
  ) {
    throw new RangeError(
      'response timing must be finite with a positive measurement and caller rate',
    );
  }
  const seaState = findSeaState(config.seaStateName);
  const waves = new WaveField(seaState);
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(
    body.mass,
    body.inertiaYaw,
  );
  const initialYaw = presentationHeadingToModelYawRadians(
    presentationHeadingDeg,
  );
  let yaw = initialYaw;
  let yawRate = 0;
  const velocity = prescribedThroughWaterVelocity(
    presentationHeadingDeg,
    config.initialSpeedMps,
  );
  body.snapToSurface(waves, 0, 0, yaw);

  const bridge: VesselHorizontalDynamicsBridge = {
    mode: 'free',
    towVelocityWorldMps: { x: 0, z: 0 },
    towYawRad: 0,
    commitStep() {},
  };
  const speed = new RunningStats();
  const forwardSpeed = new RunningStats();
  const portSpeed = new RunningStats();
  const yawChange = new RunningStats();
  const yawRateStats = new RunningStats();
  const heave = new RunningStats();
  const pitch = new RunningStats();
  const roll = new RunningStats();
  const verticalAcceleration = new RunningStats();
  let displacementX = 0;
  let displacementZ = 0;
  let overtoppingFrames = 0;
  let touchedSafetyLimiter = false;
  const callerDt = 1 / callerHz;
  const warmupFrames = Math.round(warmupSeconds * callerHz);
  const totalFrames = Math.round(
    (warmupSeconds + measurementSeconds) * callerHz,
  );

  for (let frame = 0; frame < totalFrames; frame++) {
    const result = dynamics.advance(
      callerDt,
      body,
      waves,
      0,
      0,
      velocity,
      yaw,
      yawRate,
      bridge,
    );
    yaw = result.yawRad;
    yawRate = result.yawRateRadPerSecond;
    if (frame < warmupFrames) continue;

    displacementX += result.encounterDisplacementX;
    displacementZ += result.encounterDisplacementZ;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const u = velocity.x * sy + velocity.z * cy;
    const v = velocity.x * cy - velocity.z * sy;
    speed.add(Math.hypot(velocity.x, velocity.z));
    forwardSpeed.add(u);
    portSpeed.add(v);
    yawChange.add(wrapAngle(yaw - initialYaw) * RAD_TO_DEG);
    yawRateStats.add(yawRate * RAD_TO_DEG);
    heave.add(body.comWorldY);
    pitch.add(body.pitch * RAD_TO_DEG);
    roll.add(body.roll * RAD_TO_DEG);
    verticalAcceleration.add(body.accelerationY);
    if (body.overtopEvents.length > 0) overtoppingFrames++;
    touchedSafetyLimiter ||=
      Math.abs(body.pitch) >= HULL_ATTITUDE_LIMIT_RADIANS - 1e-9 ||
      Math.abs(body.roll) >= HULL_ATTITUDE_LIMIT_RADIANS - 1e-9 ||
      Math.abs(body.pitchRate) >=
        HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND - 1e-9 ||
      Math.abs(body.rollRate) >=
        HULL_ANGULAR_RATE_LIMIT_RADIANS_PER_SECOND - 1e-9 ||
      Math.abs(body.velocityY) >=
        HULL_VERTICAL_SPEED_LIMIT_METRES_PER_SECOND - 1e-9;
  }

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const endForward = velocity.x * sy + velocity.z * cy;
  const endPort = velocity.x * cy - velocity.z * sy;
  return {
    seaState: seaState.name,
    presentationHeadingDeg,
    initialSpeedMps: config.initialSpeedMps,
    horizontal: {
      speedMps: speed.summary(),
      forwardSpeedMps: forwardSpeed.summary(),
      portSpeedMps: portSpeed.summary(),
      yawChangeDeg: yawChange.summary(),
      yawRateDegPerSecond: yawRateStats.summary(),
      endSpeedMps: round(Math.hypot(velocity.x, velocity.z)),
      endForwardSpeedMps: round(endForward),
      endPortSpeedMps: round(endPort),
      endYawChangeDeg: round(wrapAngle(yaw - initialYaw) * RAD_TO_DEG),
      endYawRateDegPerSecond: round(yawRate * RAD_TO_DEG),
      measuredDisplacementM: {
        x: round(displacementX),
        z: round(displacementZ),
        magnitude: round(Math.hypot(displacementX, displacementZ)),
      },
    },
    motion: {
      heaveDisplacementMetres: heave.summary(true),
      pitchDeg: pitch.summary(),
      rollDeg: roll.summary(),
      verticalAccelerationMps2: verticalAcceleration.summary(),
    },
    contact: { overtoppingFrames, touchedSafetyLimiter },
    maxWaveInverseSolveResidualMetres: round(
      waves.maximumSolveResidual,
      10,
    ),
  };
}

export function buildSchoonerHorizontalResponseEvidence(options: {
  onCaseComplete?: (
    completed: number,
    total: number,
    result: FreeHorizontalResponseCase,
  ) => void;
} = {}): SchoonerHorizontalResponseEvidence {
  const cases: FreeHorizontalResponseCase[] = [];
  const config = SCHOONER_HORIZONTAL_RESPONSE_CONFIG;
  for (const heading of config.headingsDeg) {
    const result = runFreeHorizontalResponseCase(heading);
    cases.push(result);
    options.onCaseComplete?.(cases.length, config.headingsDeg.length, result);
  }
  return {
    formatVersion: SCHOONER_HORIZONTAL_RESPONSE_FORMAT_VERSION,
    note:
      'The production free-motion mode released from the historical 4 m/s ' +
      'captive initial condition, compared over the same CURRENT_MODERATE headings and windows.',
    limitations: [
      'This is an unpowered release: speed is expected to decay because sail drive is not implemented.',
      'Passive yaw is free; no helmsman or commanded rudder force holds the initial heading.',
      'Resistance coefficients remain provisional and current is absent.',
      'The separately tracked captive baseline remains the unchanged control.',
    ],
    regenerateCommand: 'npm run ship:dynamics:response',
    configuration: {
      ...config,
      physicsHz: 1 / PHYSICS_STEP,
      mode: 'free-release',
    },
    cases,
  };
}
