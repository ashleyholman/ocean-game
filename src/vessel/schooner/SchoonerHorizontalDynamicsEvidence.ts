import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import type { VesselHorizontalDynamicsBridge } from '../VesselMotion';
import { PlanetaryWorld } from '../../world/PlanetaryWorld';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import {
  SchoonerHorizontalDynamics,
  horizontalKineticEnergyJ,
} from './SchoonerHorizontalDynamics';

export const SCHOONER_HORIZONTAL_DYNAMICS_EVIDENCE_FORMAT_VERSION = 1;

export interface HorizontalDecaySample {
  timeSeconds: number;
  velocityWorldMps: { x: number; z: number };
  speedMps: number;
  forwardSpeedMps: number;
  portSpeedMps: number;
  yawRad: number;
  yawRateRadPerSecond: number;
  kineticEnergyJ: number;
}

export interface HorizontalDecayCase {
  name: string;
  configuration: {
    durationSeconds: number;
    callerHz: number;
    physicsHz: number;
    voyageCompression: number;
    mode: VesselHorizontalDynamicsBridge['mode'];
    initialVelocityWorldMps: { x: number; z: number };
    initialYawRad: number;
    initialYawRateRadPerSecond: number;
    towVelocityWorldMps?: { x: number; z: number };
    towYawRad?: number;
  };
  samples: HorizontalDecaySample[];
  finalResistance: {
    forceBodyN: { x: number; z: number };
    yawMomentNm: number;
  };
  summary: {
    initialSpeedMps: number;
    finalSpeedMps: number;
    initialAbsolutePortSpeedMps: number;
    finalAbsolutePortSpeedMps: number;
    initialAbsoluteYawRateRadPerSecond: number;
    finalAbsoluteYawRateRadPerSecond: number;
    initialKineticEnergyJ: number;
    finalKineticEnergyJ: number;
    maximumPositiveEnergyStepJ: number;
    speedMonotonicNonIncreasing: boolean;
    encounterDisplacementM: number;
    globalDistanceTravelledM: number;
  };
}

export interface SchoonerHorizontalDynamicsEvidence {
  formatVersion: number;
  status: string;
  contract: {
    authority: string;
    integration: string;
    scope: string;
    validationMeaning: string;
  };
  rigidBody: {
    massKg: number;
    yawInertiaKgM2: number;
  };
  cases: {
    coastDown: HorizontalDecayCase;
    sideslipDecay: HorizontalDecayCase;
    yawDecay: HorizontalDecayCase;
    captiveTow: HorizontalDecayCase;
  };
  invariance: {
    callerRate: {
      durationSeconds: number;
      firstCallerHz: number;
      secondCallerHz: number;
      velocityErrorMps: number;
      yawErrorRad: number;
      yawRateErrorRadPerSecond: number;
      encounterDisplacementErrorM: number;
    };
    voyageCompression: {
      durationSeconds: number;
      firstCompression: number;
      secondCompression: number;
      localVelocityErrorMps: number;
      localYawErrorRad: number;
      encounterDisplacementErrorM: number;
      globalDistanceRatio: number;
      expectedGlobalDistanceRatio: number;
    };
  };
}

interface RunOptions {
  name: string;
  durationSeconds: number;
  callerHz: number;
  voyageCompression: number;
  velocityX: number;
  velocityZ: number;
  yawRad: number;
  yawRateRadPerSecond: number;
  mode?: VesselHorizontalDynamicsBridge['mode'];
  towVelocityX?: number;
  towVelocityZ?: number;
  towYawRad?: number;
}

interface RawRun {
  evidence: HorizontalDecayCase;
  finalVelocityX: number;
  finalVelocityZ: number;
  finalYawRad: number;
  finalYawRateRadPerSecond: number;
  encounterDisplacementX: number;
  encounterDisplacementZ: number;
}

function runCase(options: RunOptions): RawRun {
  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(
    body.mass,
    body.inertiaYaw,
  );
  const velocity = { x: options.velocityX, z: options.velocityZ };
  let yawRad = options.yawRad;
  let yawRateRadPerSecond = options.yawRateRadPerSecond;
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 5) / 1000,
    latitudeRad: -35 * (Math.PI / 180),
    longitudeRad: 138 * (Math.PI / 180),
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: options.voyageCompression,
    // Evidence needs canonical frame transport, not GeographicLib's browser-
    // shaped package wrapper. This deterministic spherical direct solve keeps
    // the headless runner self-contained; production and unit tests retain the
    // WGS84 implementation.
    geodesic: EVIDENCE_GEODESIC,
  });
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  const samples: HorizontalDecaySample[] = [];
  let stepCount = 0;
  let encounterDisplacementX = 0;
  let encounterDisplacementZ = 0;
  let globalDistanceTravelledM = 0;
  let previousEnergy = horizontalKineticEnergyJ(
    body.mass,
    body.inertiaYaw,
    velocity.x,
    velocity.z,
    yawRateRadPerSecond,
  );
  let maximumPositiveEnergyStepJ = 0;
  let previousSpeed = Math.hypot(velocity.x, velocity.z);
  let speedMonotonicNonIncreasing = true;

  const appendSample = (
    timeSeconds: number,
    velocityX: number,
    velocityZ: number,
    sampleYawRad: number,
    sampleYawRate: number,
  ): void => {
    const cy = Math.cos(sampleYawRad);
    const sy = Math.sin(sampleYawRad);
    samples.push({
      timeSeconds: round(timeSeconds),
      velocityWorldMps: {
        x: round(velocityX),
        z: round(velocityZ),
      },
      speedMps: round(Math.hypot(velocityX, velocityZ)),
      forwardSpeedMps: round(velocityX * sy + velocityZ * cy),
      portSpeedMps: round(velocityX * cy - velocityZ * sy),
      yawRad: round(sampleYawRad),
      yawRateRadPerSecond: round(sampleYawRate),
      kineticEnergyJ: round(horizontalKineticEnergyJ(
        body.mass,
        body.inertiaYaw,
        velocityX,
        velocityZ,
        sampleYawRate,
      ), 4),
    });
  };
  appendSample(0, velocity.x, velocity.z, yawRad, yawRateRadPerSecond);

  const bridge: VesselHorizontalDynamicsBridge = {
    mode: options.mode ?? 'free',
    towVelocityWorldMps: {
      x: options.towVelocityX ?? 0,
      z: options.towVelocityZ ?? 0,
    },
    towYawRad: options.towYawRad ?? 0,
    commitStep(
      physicsDeltaSeconds,
      displacementX,
      displacementZ,
      endVelocityX,
      endVelocityZ,
      endYawRad,
      endYawRate,
    ) {
      stepCount++;
      encounterDisplacementX += displacementX;
      encounterDisplacementZ += displacementZ;
      globalDistanceTravelledM += world.advanceTangentMotionStep(
        physicsDeltaSeconds,
        displacementX,
        -displacementZ,
        endVelocityX,
        -endVelocityZ,
      ).distanceTravelledM;

      const energy = horizontalKineticEnergyJ(
        body.mass,
        body.inertiaYaw,
        endVelocityX,
        endVelocityZ,
        endYawRate,
      );
      maximumPositiveEnergyStepJ = Math.max(
        maximumPositiveEnergyStepJ,
        energy - previousEnergy,
      );
      previousEnergy = energy;
      const speed = Math.hypot(endVelocityX, endVelocityZ);
      if (speed > previousSpeed + 1e-12) speedMonotonicNonIncreasing = false;
      previousSpeed = speed;

      if (stepCount % 240 === 0) {
        appendSample(
          stepCount / 240,
          endVelocityX,
          endVelocityZ,
          endYawRad,
          endYawRate,
        );
      }
    },
  };

  const callerCount = Math.round(options.durationSeconds * options.callerHz);
  let advanced = dynamics.advance(
    0,
    body,
    waves,
    0,
    0,
    velocity,
    yawRad,
    yawRateRadPerSecond,
    bridge,
  );
  for (let i = 0; i < callerCount; i++) {
    advanced = dynamics.advance(
      1 / options.callerHz,
      body,
      waves,
      0,
      0,
      velocity,
      yawRad,
      yawRateRadPerSecond,
      bridge,
    );
    yawRad = advanced.yawRad;
    yawRateRadPerSecond = advanced.yawRateRadPerSecond;
  }
  if (samples.at(-1)?.timeSeconds !== round(options.durationSeconds)) {
    appendSample(
      options.durationSeconds,
      velocity.x,
      velocity.z,
      yawRad,
      yawRateRadPerSecond,
    );
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  return {
    evidence: {
      name: options.name,
      configuration: {
        durationSeconds: options.durationSeconds,
        callerHz: options.callerHz,
        physicsHz: 240,
        voyageCompression: options.voyageCompression,
        mode: bridge.mode,
        initialVelocityWorldMps: {
          x: options.velocityX,
          z: options.velocityZ,
        },
        initialYawRad: options.yawRad,
        initialYawRateRadPerSecond: options.yawRateRadPerSecond,
        ...(bridge.mode === 'captive-tow'
          ? {
              towVelocityWorldMps: {
                x: round(bridge.towVelocityWorldMps.x),
                z: round(bridge.towVelocityWorldMps.z),
              },
              towYawRad: round(bridge.towYawRad),
            }
          : {}),
      },
      samples,
      finalResistance: {
        forceBodyN: {
          x: round(advanced.resistance.forceBodyN.x),
          z: round(advanced.resistance.forceBodyN.z),
        },
        yawMomentNm: round(advanced.resistance.yawMomentNm),
      },
      summary: {
        initialSpeedMps: first.speedMps,
        finalSpeedMps: last.speedMps,
        initialAbsolutePortSpeedMps: round(
          Math.abs(first.portSpeedMps),
        ),
        finalAbsolutePortSpeedMps: round(
          Math.abs(last.portSpeedMps),
        ),
        initialAbsoluteYawRateRadPerSecond: round(
          Math.abs(first.yawRateRadPerSecond),
        ),
        finalAbsoluteYawRateRadPerSecond: round(
          Math.abs(last.yawRateRadPerSecond),
        ),
        initialKineticEnergyJ: first.kineticEnergyJ,
        finalKineticEnergyJ: last.kineticEnergyJ,
        maximumPositiveEnergyStepJ: round(maximumPositiveEnergyStepJ, 8),
        speedMonotonicNonIncreasing,
        encounterDisplacementM: round(
          Math.hypot(encounterDisplacementX, encounterDisplacementZ),
        ),
        globalDistanceTravelledM: round(globalDistanceTravelledM),
      },
    },
    finalVelocityX: velocity.x,
    finalVelocityZ: velocity.z,
    finalYawRad: yawRad,
    finalYawRateRadPerSecond: yawRateRadPerSecond,
    encounterDisplacementX,
    encounterDisplacementZ,
  };
}

export function buildSchoonerHorizontalDynamicsEvidence(): SchoonerHorizontalDynamicsEvidence {
  const coastDown = runCase({
    name: 'straight coast-down from 4 m/s',
    durationSeconds: 30,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 4,
    yawRad: 0,
    yawRateRadPerSecond: 0,
  });
  const sideslipDecay = runCase({
    name: 'port sideslip release at 4 m/s forward',
    durationSeconds: 20,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 1,
    velocityZ: 4,
    yawRad: 0,
    yawRateRadPerSecond: 0,
  });
  const yawDecay = runCase({
    name: 'positive yaw-rate release at 4 m/s forward',
    durationSeconds: 20,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 4,
    yawRad: 0,
    yawRateRadPerSecond: 0.16,
  });
  const towYaw = 0.4;
  const towVelocityX = Math.sin(towYaw) * 4;
  const towVelocityZ = Math.cos(towYaw) * 4;
  const captiveTow = runCase({
    name: '4 m/s captive tow',
    durationSeconds: 8,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: towVelocityX,
    velocityZ: towVelocityZ,
    yawRad: towYaw,
    yawRateRadPerSecond: 0,
    mode: 'captive-tow',
    towVelocityX,
    towVelocityZ,
    towYawRad: towYaw,
  });

  const callerConfig = {
    name: 'caller-rate comparison',
    durationSeconds: 12,
    voyageCompression: 30,
    velocityX: 0.7,
    velocityZ: 4,
    yawRad: 0,
    yawRateRadPerSecond: 0.11,
  } as const;
  const caller60 = runCase({ ...callerConfig, callerHz: 60 });
  const caller120 = runCase({ ...callerConfig, callerHz: 120 });

  const compressionConfig = {
    name: 'voyage-compression comparison',
    durationSeconds: 10,
    callerHz: 60,
    velocityX: 0.5,
    velocityZ: 3,
    yawRad: 0,
    yawRateRadPerSecond: 0,
  } as const;
  const compression1 = runCase({
    ...compressionConfig,
    voyageCompression: 1,
  });
  const compression30 = runCase({
    ...compressionConfig,
    voyageCompression: 30,
  });

  const encounterDistance = (run: RawRun) => Math.hypot(
    run.encounterDisplacementX,
    run.encounterDisplacementZ,
  );
  const angularError = (a: number, b: number) => {
    let difference = (a - b + Math.PI) % (2 * Math.PI);
    if (difference < 0) difference += 2 * Math.PI;
    return Math.abs(difference - Math.PI);
  };
  const body = buildSchoonerBuoyancy();

  return {
    formatVersion: SCHOONER_HORIZONTAL_DYNAMICS_EVIDENCE_FORMAT_VERSION,
    status:
      'Passive surge, sway and yaw are force-integrated; sail drive, ' +
      'commanded rudder force and current remain absent.',
    contract: {
      authority:
        'Canonical ECEF position/velocity remain authoritative; horizontal ' +
        'velocity is only a transient transported-frame view.',
      integration:
        'Resistance, yaw and matching water/global midpoint displacement are advanced at 240 Hz.',
      scope:
        'Canonical loading in flat still water, plus captive-tow and ' +
        'clock/domain invariance checks.',
      validationMeaning:
        'Decay, passivity, fixed-step caller invariance and voyage separation ' +
        'are validated; resistance coefficients remain provisional.',
    },
    rigidBody: {
      massKg: round(body.mass),
      yawInertiaKgM2: round(body.inertiaYaw),
    },
    cases: {
      coastDown: coastDown.evidence,
      sideslipDecay: sideslipDecay.evidence,
      yawDecay: yawDecay.evidence,
      captiveTow: captiveTow.evidence,
    },
    invariance: {
      callerRate: {
        durationSeconds: callerConfig.durationSeconds,
        firstCallerHz: 60,
        secondCallerHz: 120,
        velocityErrorMps: round(Math.hypot(
          caller60.finalVelocityX - caller120.finalVelocityX,
          caller60.finalVelocityZ - caller120.finalVelocityZ,
        ), 12),
        yawErrorRad: round(angularError(
          caller60.finalYawRad,
          caller120.finalYawRad,
        ), 12),
        yawRateErrorRadPerSecond: round(Math.abs(
          caller60.finalYawRateRadPerSecond -
            caller120.finalYawRateRadPerSecond,
        ), 12),
        encounterDisplacementErrorM: round(Math.abs(
          encounterDistance(caller60) - encounterDistance(caller120),
        ), 12),
      },
      voyageCompression: {
        durationSeconds: compressionConfig.durationSeconds,
        firstCompression: 1,
        secondCompression: 30,
        localVelocityErrorMps: round(Math.hypot(
          compression1.finalVelocityX - compression30.finalVelocityX,
          compression1.finalVelocityZ - compression30.finalVelocityZ,
        ), 12),
        localYawErrorRad: round(angularError(
          compression1.finalYawRad,
          compression30.finalYawRad,
        ), 12),
        encounterDisplacementErrorM: round(Math.abs(
          encounterDistance(compression1) - encounterDistance(compression30),
        ), 12),
        globalDistanceRatio: round(
          compression30.evidence.summary.globalDistanceTravelledM /
            compression1.evidence.summary.globalDistanceTravelledM,
          10,
        ),
        expectedGlobalDistanceRatio: 30,
      },
    },
  };
}

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const EVIDENCE_EARTH_RADIUS_M = 6_371_008.8;
/**
 * Deterministic spherical direct/inverse solve for headless evidence runners,
 * shared by the sailing evidence. Production and unit tests retain WGS84.
 */
export const EVIDENCE_GEODESIC = {
  /**
   * The inverse problem — two chart positions in, course and distance out.
   *
   * It is here rather than in a navigation helper because the navigator's
   * course to a waypoint and the vessel's own propagation have to be measured
   * on the same figure of the earth. Spherical here, ellipsoidal in
   * production, one solver in each.
   */
  inverse(
    latitude1Rad: number,
    longitude1Rad: number,
    latitude2Rad: number,
    longitude2Rad: number,
    out: { distanceM: number; forwardAzimuth1Rad: number },
  ) {
    const deltaLongitude = longitude2Rad - longitude1Rad;
    const sinLatitude1 = Math.sin(latitude1Rad);
    const cosLatitude1 = Math.cos(latitude1Rad);
    const sinLatitude2 = Math.sin(latitude2Rad);
    const cosLatitude2 = Math.cos(latitude2Rad);
    const cosDeltaLongitude = Math.cos(deltaLongitude);
    const sinDeltaLongitude = Math.sin(deltaLongitude);
    const east = cosLatitude2 * sinDeltaLongitude;
    const north =
      cosLatitude1 * sinLatitude2 -
      sinLatitude1 * cosLatitude2 * cosDeltaLongitude;
    const cosSeparation =
      sinLatitude1 * sinLatitude2 +
      cosLatitude1 * cosLatitude2 * cosDeltaLongitude;
    out.distanceM =
      Math.atan2(Math.hypot(east, north), cosSeparation) *
      EVIDENCE_EARTH_RADIUS_M;
    out.forwardAzimuth1Rad = Math.atan2(east, north);
    return out;
  },

  direct(
    latitude1Rad: number,
    longitude1Rad: number,
    forwardAzimuth1Rad: number,
    distanceM: number,
    out: {
      latitude2Rad: number;
      longitude2Rad: number;
      forwardAzimuth2Rad: number;
    },
  ) {
    const delta = distanceM / EVIDENCE_EARTH_RADIUS_M;
    const sinLatitude1 = Math.sin(latitude1Rad);
    const cosLatitude1 = Math.cos(latitude1Rad);
    const sinDelta = Math.sin(delta);
    const cosDelta = Math.cos(delta);
    const sinAzimuth = Math.sin(forwardAzimuth1Rad);
    const cosAzimuth = Math.cos(forwardAzimuth1Rad);
    const latitude2Rad = Math.asin(
      sinLatitude1 * cosDelta +
        cosLatitude1 * sinDelta * cosAzimuth,
    );
    const longitude2Rad = longitude1Rad + Math.atan2(
      sinAzimuth * sinDelta * cosLatitude1,
      cosDelta - sinLatitude1 * Math.sin(latitude2Rad),
    );
    const longitudeDelta = longitude2Rad - longitude1Rad;
    out.latitude2Rad = latitude2Rad;
    out.longitude2Rad = longitude2Rad;
    out.forwardAzimuth2Rad = Math.atan2(
      Math.sin(longitudeDelta) * cosLatitude1,
      -sinLatitude1 * Math.cos(latitude2Rad) +
        cosLatitude1 * Math.sin(latitude2Rad) * Math.cos(longitudeDelta),
    );
    return out;
  },
};
