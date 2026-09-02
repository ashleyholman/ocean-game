import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import { PHYSICS_STEP } from '../BuoyantBody';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import {
  SCHOONER_RESISTANCE_COEFFICIENTS,
  SCHOONER_RESISTANCE_GEOMETRY,
  SCHOONER_RESISTANCE_REFERENCE_LENGTH_M,
  createSchoonerResistanceResult,
  evaluateSchoonerResistance,
} from './SchoonerResistance';

export const SCHOONER_RESISTANCE_EVIDENCE_FORMAT_VERSION = 1;
export const SCHOONER_RESISTANCE_TOW_SPEEDS_MPS = Object.freeze([
  0, 0.5, 1, 2, 3, 4, 5, 6,
]);
export const SCHOONER_RESISTANCE_DRIFT_ANGLES_DEG = Object.freeze([
  -15, -10, -5, 0, 5, 10, 15,
]);
export const SCHOONER_RESISTANCE_NORMALIZED_YAW_RATES = Object.freeze([
  -0.5, -0.25, -0.1, 0, 0.1, 0.25, 0.5,
]);
export const SCHOONER_RESISTANCE_CAPTIVE_SPEED_MPS = 4;

export interface ResistanceEvidenceCase {
  forwardSpeedMps: number;
  portSpeedMps: number;
  yawRateRadPerSecond: number;
  normalizedYawRate: number;
  forceBodyN: { x: number; y: number; z: number };
  yawMomentNm: number;
  mechanicalPowerW: number;
  reynoldsNumber: number;
  froudeNumber: number;
  frictionCoefficient: number;
  residuaryCoefficient: number;
  effectiveWettedSurfaceAreaM2: number;
  components: {
    frictionForceN: number;
    formForceN: number;
    residuaryForceN: number;
    hullLateralForceN: number;
    backboneLateralForceN: number;
    rudderLateralForceN: number;
    hullYawMomentNm: number;
    backboneYawMomentNm: number;
    rudderYawMomentNm: number;
  };
}

export interface SchoonerResistanceEvidence {
  formatVersion: number;
  status: string;
  contract: {
    coordinates: string;
    scope: string;
    frictionSource: string;
    validationMeaning: string;
  };
  geometry: {
    stationCount: number;
    waterlineLengthM: number;
    yawReferenceZ: number;
    wettedSurfaceAreaM2: number;
    hullLateralAreaM2: number;
    backboneLateralAreaM2: number;
    rudderLateralAreaM2: number;
  };
  coefficients: typeof SCHOONER_RESISTANCE_COEFFICIENTS;
  straightTow: ResistanceEvidenceCase[];
  drift: Array<ResistanceEvidenceCase & { driftAngleDeg: number }>;
  yaw: ResistanceEvidenceCase[];
  summary: {
    straightTowDragMonotonic: boolean;
    maximumPositiveMechanicalPowerW: number;
    maximumDriftMirrorRelativeError: number;
    maximumYawMirrorRelativeError: number;
    dragAtFourMpsN: number;
    effectivePowerAtFourMpsW: number;
  };
}

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function relativeMirrorError(a: number, b: number): number {
  return Math.abs(a + b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
}

/** One prescribed captive condition in level, still water. */
export function runSchoonerResistanceCase(options: {
  forwardSpeedMps: number;
  portSpeedMps?: number;
  yawRateRadPerSecond?: number;
}): ResistanceEvidenceCase {
  const forwardSpeedMps = options.forwardSpeedMps;
  const portSpeedMps = options.portSpeedMps ?? 0;
  const yawRateRadPerSecond = options.yawRateRadPerSecond ?? 0;
  for (const [name, value] of [
    ['forward speed', forwardSpeedMps],
    ['port speed', portSpeedMps],
    ['yaw rate', yawRateRadPerSecond],
  ] as const) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
  }

  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  body.snapToSurface(waves, 0, 0, 0);
  body.update(
    0,
    waves,
    0,
    0,
    0,
    PHYSICS_STEP,
    portSpeedMps,
    forwardSpeedMps,
  );
  const evaluated = evaluateSchoonerResistance(
    {
      contacts: body.contacts,
      modelYawRad: 0,
      yawRateRadPerSecond,
    },
    createSchoonerResistanceResult(),
  );
  const normalizedYawRate =
    Math.abs(forwardSpeedMps) > 1e-12
      ? (yawRateRadPerSecond * SCHOONER_RESISTANCE_REFERENCE_LENGTH_M) /
        Math.abs(forwardSpeedMps)
      : 0;
  const mechanicalPowerW =
    evaluated.forceBodyN.z * forwardSpeedMps +
    evaluated.forceBodyN.x * portSpeedMps +
    evaluated.yawMomentNm * yawRateRadPerSecond;

  return {
    forwardSpeedMps: round(forwardSpeedMps),
    portSpeedMps: round(portSpeedMps),
    yawRateRadPerSecond: round(yawRateRadPerSecond),
    normalizedYawRate: round(normalizedYawRate),
    forceBodyN: {
      x: round(evaluated.forceBodyN.x),
      y: round(evaluated.forceBodyN.y),
      z: round(evaluated.forceBodyN.z),
    },
    yawMomentNm: round(evaluated.yawMomentNm),
    mechanicalPowerW: round(mechanicalPowerW),
    reynoldsNumber: round(evaluated.reynoldsNumber, 2),
    froudeNumber: round(evaluated.froudeNumber),
    frictionCoefficient: round(evaluated.frictionCoefficient, 10),
    residuaryCoefficient: round(evaluated.residuaryCoefficient, 10),
    effectiveWettedSurfaceAreaM2: round(evaluated.effectiveWettedSurfaceAreaM2),
    components: {
      frictionForceN: round(evaluated.frictionForceN),
      formForceN: round(evaluated.formForceN),
      residuaryForceN: round(evaluated.residuaryForceN),
      hullLateralForceN: round(evaluated.hullLateralForceN),
      backboneLateralForceN: round(evaluated.backboneLateralForceN),
      rudderLateralForceN: round(evaluated.rudderLateralForceN),
      hullYawMomentNm: round(evaluated.hullYawMomentNm),
      backboneYawMomentNm: round(evaluated.backboneYawMomentNm),
      rudderYawMomentNm: round(evaluated.rudderYawMomentNm),
    },
  };
}

export function buildSchoonerResistanceEvidence(): SchoonerResistanceEvidence {
  const straightTow = SCHOONER_RESISTANCE_TOW_SPEEDS_MPS.map((speed) =>
    runSchoonerResistanceCase({ forwardSpeedMps: speed }),
  );
  const drift = SCHOONER_RESISTANCE_DRIFT_ANGLES_DEG.map((driftAngleDeg) => {
    const angle = (driftAngleDeg * Math.PI) / 180;
    return {
      driftAngleDeg,
      ...runSchoonerResistanceCase({
        forwardSpeedMps: SCHOONER_RESISTANCE_CAPTIVE_SPEED_MPS * Math.cos(angle),
        portSpeedMps: SCHOONER_RESISTANCE_CAPTIVE_SPEED_MPS * Math.sin(angle),
      }),
    };
  });
  const yaw = SCHOONER_RESISTANCE_NORMALIZED_YAW_RATES.map((normalizedYawRate) =>
    runSchoonerResistanceCase({
      forwardSpeedMps: SCHOONER_RESISTANCE_CAPTIVE_SPEED_MPS,
      yawRateRadPerSecond:
        (normalizedYawRate * SCHOONER_RESISTANCE_CAPTIVE_SPEED_MPS) /
        SCHOONER_RESISTANCE_REFERENCE_LENGTH_M,
    }),
  );

  let maximumDriftMirrorRelativeError = 0;
  for (let i = 0; i < Math.floor(drift.length / 2); i++) {
    const negative = drift[i];
    const positive = drift[drift.length - 1 - i];
    maximumDriftMirrorRelativeError = Math.max(
      maximumDriftMirrorRelativeError,
      relativeMirrorError(negative.forceBodyN.x, positive.forceBodyN.x),
      relativeMirrorError(negative.yawMomentNm, positive.yawMomentNm),
    );
  }
  let maximumYawMirrorRelativeError = 0;
  for (let i = 0; i < Math.floor(yaw.length / 2); i++) {
    const negative = yaw[i];
    const positive = yaw[yaw.length - 1 - i];
    maximumYawMirrorRelativeError = Math.max(
      maximumYawMirrorRelativeError,
      relativeMirrorError(negative.forceBodyN.x, positive.forceBodyN.x),
      relativeMirrorError(negative.yawMomentNm, positive.yawMomentNm),
    );
  }
  const fourMps = straightTow.find((result) => result.forwardSpeedMps === 4);
  if (!fourMps) throw new Error('straight-tow evidence omitted the 4 m/s reference case');

  return {
    formatVersion: SCHOONER_RESISTANCE_EVIDENCE_FORMAT_VERSION,
    status:
      'Captive force-surface evidence only; passive integration is validated ' +
      'in the separate horizontal-dynamics record, while propulsion and ' +
      'steering remain absent.',
    contract: {
      coordinates:
        'Body +x port, +z forward; positive yaw turns the bow toward port.',
      scope:
        'Level still-water tow, drift and steady-yaw force evidence at canonical loading.',
      frictionSource:
        'ITTC 7.5-02-02-01 rev. 05 ITTC-1957 model-ship correlation line.',
      validationMeaning:
        'Symmetry, passivity, continuity and decomposition are validated; unmeasured coefficients remain provisional.',
    },
    geometry: {
      stationCount: SCHOONER_RESISTANCE_GEOMETRY.stations.length,
      waterlineLengthM: round(SCHOONER_RESISTANCE_GEOMETRY.waterlineLengthM),
      yawReferenceZ: round(SCHOONER_RESISTANCE_GEOMETRY.yawReferenceZ),
      wettedSurfaceAreaM2: round(SCHOONER_RESISTANCE_GEOMETRY.wettedSurfaceAreaM2),
      hullLateralAreaM2: round(SCHOONER_RESISTANCE_GEOMETRY.hullLateralAreaM2),
      backboneLateralAreaM2: round(
        SCHOONER_RESISTANCE_GEOMETRY.backboneLateralAreaM2,
      ),
      rudderLateralAreaM2: round(SCHOONER_RESISTANCE_GEOMETRY.rudderLateralAreaM2),
    },
    coefficients: SCHOONER_RESISTANCE_COEFFICIENTS,
    straightTow,
    drift,
    yaw,
    summary: {
      straightTowDragMonotonic: straightTow.every(
        (result, index) =>
          index === 0 ||
          -result.forceBodyN.z > -straightTow[index - 1].forceBodyN.z,
      ),
      maximumPositiveMechanicalPowerW: round(
        Math.max(0, ...[...straightTow, ...drift, ...yaw].map((result) => result.mechanicalPowerW)),
      ),
      maximumDriftMirrorRelativeError: round(maximumDriftMirrorRelativeError, 12),
      maximumYawMirrorRelativeError: round(maximumYawMirrorRelativeError, 12),
      dragAtFourMpsN: round(-fourMps.forceBodyN.z),
      effectivePowerAtFourMpsW: round(-fourMps.mechanicalPowerW),
    },
  };
}
