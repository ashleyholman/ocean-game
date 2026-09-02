import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import type { VesselHorizontalDynamicsBridge } from '../VesselMotion';
import type { SailName } from './rig';
import { PlanetaryWorld } from '../../world/PlanetaryWorld';
import { WorldWind } from '../../world/WorldWind';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { SailingControls } from './SailingControls';
import {
  SchoonerHorizontalDynamics,
  horizontalKineticEnergyJ,
} from './SchoonerHorizontalDynamics';
import { EVIDENCE_GEODESIC } from './SchoonerHorizontalDynamicsEvidence';
import { SchoonerSailForces } from './SchoonerSailForces';
import {
  BARE_POLES,
  FULL_SAIL,
  RIG_WINDAGE,
  SAIL_AERO_GEOMETRY,
  type CanvasState,
  type TackSide,
} from './sailAero';

export const SAILING_FORCE_EVIDENCE_FORMAT_VERSION = 1;

/**
 * S2a straight-line sail-force evidence.
 *
 * The polar is the S2b deliverable; this file is the round's controlled
 * precursor: captive-tow force sweeps with per-sail breakdowns (aggregate
 * numbers hide sign errors), free gust runs for the generalised energy gate,
 * and the invariance contracts extended to a ship with her sails drawing.
 * Everything is deterministic: gustiness is zero except where a case says
 * otherwise, and the gust process is a pure function of wind time.
 */

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const PHYSICS_HZ = 240;
/** ~1.34 kn·√LWL(ft) for the 14.3 m waterline — the stated hull-speed bound. */
export const SAILING_HULL_SPEED_MPS = 4.7;

export interface SailBreakdownEntry {
  name: string;
  state: string;
  areaM2: number;
  aoaDeg: number;
  luffing: boolean;
  blanketFactor: number;
  /**
   * The coefficient block, per sail (S6c). An aggregate drive number cannot
   * tell you whether a sail is paying for its lift, carrying it backwards,
   * or simply not making any — and on one close-hauled point all three
   * happen at once. `liftCoefficient` is NEGATIVE when the sail is aback.
   */
  aspectRatioEff: number;
  camberDrawn: number;
  liftCoefficient: number;
  dragCoefficient: number;
  inducedDragCoefficient: number;
  forceModelN: { x: number; y: number; z: number };
}

export interface CaptiveSweepEntry {
  /** Signed apparent... no: TRUE wind source angle off the bow; + = port side. */
  windAngleOffBowDeg: number;
  tack: TackSide;
  perSail: SailBreakdownEntry[];
  windageForceModelN: { x: number; y: number; z: number };
  totals: {
    driveForwardN: number;
    sideForceN: number;
    heelTorqueNm: number;
    yawMomentNm: number;
  };
  steadyHeelDeg: number;
  luffingCount: number;
}

export interface FreeRunSample {
  timeSeconds: number;
  speedMps: number;
  yawRad: number;
  kineticEnergyJ: number;
  externalWorkJ: number;
  rollDeg: number;
}

export interface SailingForceEvidence {
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
  sailPlan: {
    totalClothAreaM2: number;
    windage: { areaM2: number; coeYM: number };
    sails: Array<{
      name: string;
      family: string;
      camber: number;
      areaM2: number;
      coeM: { x: number; y: number; z: number };
      reefAreasM2: Partial<Record<'reef1' | 'reef2', number>>;
    }>;
  };
  captiveSweep: {
    windSpeedMps: number;
    towSpeedMps: number;
    settleSeconds: number;
    entries: CaptiveSweepEntry[];
    gates: {
      driveDeadAheadN: number;
      bestDriveAngleDeg: number;
      bestDriveN: number;
      tackMirrorRelativeError: number;
      heelAlwaysToLeewardWhileDrawing: boolean;
    };
  };
  freeRuns: {
    gustEnergy: {
      windSpeedMps: number;
      gustiness: number;
      durationSeconds: number;
      samples: FreeRunSample[];
      maxEnergyOverWorkJ: number;
      finalSpeedMps: number;
      hullSpeedBoundMps: number;
    };
    zeroWindBarePoles: {
      durationSeconds: number;
      finalSpeedMps: number;
      externalWorkJ: number;
    };
  };
  invariance: {
    callerRate: {
      durationSeconds: number;
      firstCallerHz: number;
      secondCallerHz: number;
      velocityErrorMps: number;
      yawErrorRad: number;
      externalWorkErrorJ: number;
    };
    voyageCompression: {
      durationSeconds: number;
      firstCompression: number;
      secondCompression: number;
      localVelocityErrorMps: number;
      localYawErrorRad: number;
      globalDistanceRatio: number;
      expectedGlobalDistanceRatio: number;
    };
  };
}

export interface SailRunOptions {
  durationSeconds: number;
  callerHz: number;
  voyageCompression: number;
  velocityX: number;
  velocityZ: number;
  yawRad: number;
  /** Wind the case blows: compass heading the wind blows toward. */
  windSpeedMps: number;
  windDirectionTowardDeg: number;
  gustiness: number;
  canvas: CanvasState;
  tack: TackSide;
  /** S4: per-sail trim overrides, degrees, on the frozen fixture path —
   * the polar's trim-to-draw schedule rides through here. */
  fixedTrimsDeg?: Partial<Record<SailName, number>>;
  mode?: VesselHorizontalDynamicsBridge['mode'];
  towVelocityX?: number;
  towVelocityZ?: number;
  towYawRad?: number;
  sampleEverySeconds?: number;
  /**
   * Attach a helm (S3) and command it before every caller frame with this
   * pure function of frame time. Commands are rate-limited on the fixed
   * substep grid; a schedule that only changes value on whole seconds is
   * exactly caller-rate invariant across the evidence caller rates.
   */
  rudderCommandDeg?: (timeSeconds: number) => number;
  /**
   * Constant force along the ship's current heading, newtons — the turn-
   * circle evidence's stand-in for sustained propulsion. The scene has no
   * propeller; this exists so steady circles can be measured without wind
   * breaking the port/starboard mirror. Honest synthetic thrust, evidence
   * only, and its work is charged to the external-work budget like any
   * other external force.
   */
  thrustN?: number;
  /**
   * Full maneuver scripting: called before every caller frame with the live
   * state. The tack and gybe evidence steers, watches the wind cross the
   * bow, and works the sheets (the v1 tack flip) through this hook.
   */
  script?: (view: SailRunScriptView) => void;
  /** Collect the local trajectory at the sample cadence. */
  recordTrajectory?: boolean;
}

/** What a maneuver script may observe and command, one caller frame at a time. */
export interface SailRunScriptView {
  timeSeconds: number;
  yawRad: number;
  yawRateRadPerSecond: number;
  velocityX: number;
  velocityZ: number;
  helm: SailingControls;
  sails: SchoonerSailForces;
}

export interface TrajectorySample {
  timeSeconds: number;
  xM: number;
  zM: number;
  yawRad: number;
  speedMps: number;
}

export interface SailRunResult {
  finalVelocityX: number;
  finalVelocityZ: number;
  finalYawRad: number;
  finalYawRateRadPerSecond: number;
  finalRollRad: number;
  /** Final passive resistance, body axes (+x port, +z forward). */
  finalResistanceBodyXN: number;
  finalResistanceBodyZN: number;
  /** Final total water yaw moment, rudder deflection included. */
  finalResistanceYawMomentNm: number;
  finalRudderAngleRad: number;
  finalRudderDeflectionYawMomentNm: number;
  externalWorkJ: number;
  globalDistanceTravelledM: number;
  samples: FreeRunSample[];
  /** Greatest excess of kinetic-energy gain over external work, joules. */
  maxEnergyOverWorkJ: number;
  sails: SchoonerSailForces;
  dynamics: SchoonerHorizontalDynamics;
  body: ReturnType<typeof buildSchoonerBuoyancy>;
  /** Present when the case scripted a rudder command. */
  helm?: SailingControls;
  /** Present when the case asked for it. */
  trajectory?: TrajectorySample[];
}

/** Shared by the polar evidence (S2b), which sweeps this harness. */
export function runSailCase(options: SailRunOptions): SailRunResult {
  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
  const worldWind = new WorldWind();
  worldWind.setMean(
    options.windSpeedMps,
    options.windDirectionTowardDeg,
    options.gustiness,
  );
  const sails = new SchoonerSailForces(worldWind);
  sails.canvas = options.canvas;
  sails.tack = options.tack;
  if (options.fixedTrimsDeg) sails.fixedTrimsDeg = options.fixedTrimsDeg;
  sails.frameHeadingDeg = 0;
  const thrustN = options.thrustN ?? 0;
  if (!Number.isFinite(thrustN)) {
    throw new RangeError(`thrust must be finite, got ${thrustN}`);
  }
  dynamics.externalForces =
    thrustN === 0
      ? sails
      : {
          evaluateSubstep(stepSeconds, body2, yawRad2, yawRate2, vx, vz, out) {
            sails.evaluateSubstep(
              stepSeconds,
              body2,
              yawRad2,
              yawRate2,
              vx,
              vz,
              out,
            );
            // Body +z rotated to world axes — the dynamics' own transform.
            out.forceWorldXN += thrustN * Math.sin(yawRad2);
            out.forceWorldZN += thrustN * Math.cos(yawRad2);
          },
          reset() {
            sails.reset();
          },
        };
  const helm =
    options.rudderCommandDeg || options.script ? new SailingControls() : undefined;
  if (helm) dynamics.helm = helm;
  dynamics.reset();

  const velocity = { x: options.velocityX, z: options.velocityZ };
  let yawRad = options.yawRad;
  let yawRateRadPerSecond = 0;
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 6) / 1000,
    latitudeRad: -35 * DEG_TO_RAD,
    longitudeRad: 138 * DEG_TO_RAD,
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: options.voyageCompression,
    geodesic: EVIDENCE_GEODESIC,
  });
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  const initialEnergy = horizontalKineticEnergyJ(
    body.mass,
    body.inertiaYaw,
    velocity.x,
    velocity.z,
    yawRateRadPerSecond,
  );
  let stepCount = 0;
  let globalDistanceTravelledM = 0;
  let maxEnergyOverWorkJ = -Infinity;
  let positionX = 0;
  let positionZ = 0;
  const samples: FreeRunSample[] = [];
  const trajectory: TrajectorySample[] | undefined = options.recordTrajectory
    ? []
    : undefined;
  const sampleEverySteps = Math.max(
    1,
    Math.round((options.sampleEverySeconds ?? 1) * PHYSICS_HZ),
  );

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
      positionX += displacementX;
      positionZ += displacementZ;
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
      // The generalised passivity gate (design §6.5): kinetic energy may
      // exceed its start by at most the work the wind has done. Water only
      // dissipates in flat calm, so the excess must never grow positive.
      maxEnergyOverWorkJ = Math.max(
        maxEnergyOverWorkJ,
        energy - initialEnergy - dynamics.externalWorkSoFarJ,
      );
      if (stepCount % sampleEverySteps === 0) {
        samples.push({
          timeSeconds: round(stepCount / PHYSICS_HZ),
          speedMps: round(Math.hypot(endVelocityX, endVelocityZ)),
          yawRad: round(endYawRad),
          kineticEnergyJ: round(energy, 4),
          externalWorkJ: round(dynamics.externalWorkSoFarJ, 4),
          rollDeg: round(body.roll * RAD_TO_DEG, 5),
        });
        trajectory?.push({
          timeSeconds: round(stepCount / PHYSICS_HZ),
          xM: round(positionX, 4),
          zM: round(positionZ, 4),
          yawRad: round(endYawRad, 8),
          speedMps: round(Math.hypot(endVelocityX, endVelocityZ), 6),
        });
      }
    },
  };

  const callerCount = Math.round(options.durationSeconds * options.callerHz);
  const scriptView: SailRunScriptView | undefined =
    helm && options.script
      ? {
          timeSeconds: 0,
          yawRad,
          yawRateRadPerSecond,
          velocityX: velocity.x,
          velocityZ: velocity.z,
          helm,
          sails,
        }
      : undefined;
  const commandFrame = (timeSeconds: number): void => {
    if (helm && options.rudderCommandDeg) {
      helm.commandRudderDeg(options.rudderCommandDeg(timeSeconds));
    }
    if (scriptView && options.script) {
      scriptView.timeSeconds = timeSeconds;
      scriptView.yawRad = yawRad;
      scriptView.yawRateRadPerSecond = yawRateRadPerSecond;
      scriptView.velocityX = velocity.x;
      scriptView.velocityZ = velocity.z;
      options.script(scriptView);
    }
  };
  commandFrame(0);
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
    commandFrame(i / options.callerHz);
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

  return {
    finalVelocityX: velocity.x,
    finalVelocityZ: velocity.z,
    finalYawRad: yawRad,
    finalYawRateRadPerSecond: yawRateRadPerSecond,
    finalRollRad: body.roll,
    finalResistanceBodyXN: advanced.resistance.forceBodyN.x,
    finalResistanceBodyZN: advanced.resistance.forceBodyN.z,
    finalResistanceYawMomentNm: advanced.resistance.yawMomentNm,
    finalRudderAngleRad: advanced.resistance.rudderAngleRad,
    finalRudderDeflectionYawMomentNm:
      advanced.resistance.rudderDeflectionYawMomentNm,
    externalWorkJ: advanced.externalWorkJ,
    globalDistanceTravelledM,
    samples,
    maxEnergyOverWorkJ,
    sails,
    dynamics,
    body,
    helm,
    trajectory,
  };
}

/**
 * One captive-sweep case: tow her at fixed heading and speed with the true
 * wind's source `angle` degrees off the bow (positive = over the port side),
 * let heel settle, and read every sail's force. Heading is south (yaw 0,
 * frame heading 0), so a source angle `a` is a wind blowing toward `−a` on
 * the compass.
 */
function runSweepEntry(
  windAngleOffBowDeg: number,
  tack: TackSide,
  windSpeedMps: number,
  towSpeedMps: number,
  settleSeconds: number,
): CaptiveSweepEntry {
  const run = runSailCase({
    durationSeconds: settleSeconds,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: towSpeedMps,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg: -windAngleOffBowDeg,
    gustiness: 0,
    canvas: FULL_SAIL,
    tack,
    mode: 'captive-tow',
    towVelocityX: 0,
    towVelocityZ: towSpeedMps,
    towYawRad: 0,
    sampleEverySeconds: settleSeconds,
  });
  const result = run.sails.lastResult;
  let driveForwardN = result.windage.forceModelZN;
  let sideForceN = result.windage.forceModelXN;
  for (const sail of result.perSail) {
    driveForwardN += sail.forceModelZN;
    sideForceN += sail.forceModelXN;
  }
  return {
    windAngleOffBowDeg,
    tack,
    perSail: result.perSail.map((sail) => ({
      name: sail.name,
      state: sail.state,
      areaM2: round(sail.areaM2, 4),
      aoaDeg: round(sail.aoaDeg, 3),
      luffing: sail.luffing,
      blanketFactor: round(sail.blanketFactor, 4),
      aspectRatioEff: round(sail.aspectRatioEff, 4),
      camberDrawn: round(sail.camberDrawn, 5),
      liftCoefficient: round(sail.liftCoefficient, 4),
      dragCoefficient: round(sail.dragCoefficient, 4),
      inducedDragCoefficient: round(sail.inducedDragCoefficient, 4),
      forceModelN: {
        x: round(sail.forceModelXN, 3),
        y: round(sail.forceModelYN, 3),
        z: round(sail.forceModelZN, 3),
      },
    })),
    windageForceModelN: {
      x: round(result.windage.forceModelXN, 3),
      y: round(result.windage.forceModelYN, 3),
      z: round(result.windage.forceModelZN, 3),
    },
    totals: {
      driveForwardN: round(driveForwardN, 3),
      sideForceN: round(sideForceN, 3),
      heelTorqueNm: round(result.rollTorqueNm, 3),
      yawMomentNm: round(result.yawMomentNm, 3),
    },
    steadyHeelDeg: round(run.finalRollRad * RAD_TO_DEG, 4),
    luffingCount: result.luffingCount,
  };
}

export function buildSailingForceEvidence(): SailingForceEvidence {
  const body = buildSchoonerBuoyancy();

  // --- captive force sweep --------------------------------------------------
  const windSpeedMps = 8;
  const towSpeedMps = 2;
  const settleSeconds = 20;
  const entries: CaptiveSweepEntry[] = [];
  for (let angle = -180; angle < 180; angle += 15) {
    entries.push(
      runSweepEntry(angle, 'starboard', windSpeedMps, towSpeedMps, settleSeconds),
    );
  }
  // The mirrored tack at the mirrored angle must mirror exactly: same drive,
  // negated side force and torques. One pair pins the whole reflection.
  const starboardBeam = entries.find((entry) => entry.windAngleOffBowDeg === -90)!;
  const portBeam = runSweepEntry(90, 'port', windSpeedMps, towSpeedMps, settleSeconds);
  const mirrorScale = Math.max(
    Math.abs(starboardBeam.totals.driveForwardN),
    Math.abs(starboardBeam.totals.sideForceN),
    1,
  );
  const tackMirrorRelativeError =
    Math.max(
      Math.abs(starboardBeam.totals.driveForwardN - portBeam.totals.driveForwardN),
      Math.abs(starboardBeam.totals.sideForceN + portBeam.totals.sideForceN),
      Math.abs(starboardBeam.totals.heelTorqueNm + portBeam.totals.heelTorqueNm) /
        1000,
    ) / mirrorScale;

  let bestDriveN = -Infinity;
  let bestDriveAngleDeg = 0;
  let heelAlwaysToLeewardWhileDrawing = true;
  for (const entry of entries) {
    if (entry.totals.driveForwardN > bestDriveN) {
      bestDriveN = entry.totals.driveForwardN;
      bestDriveAngleDeg = entry.windAngleOffBowDeg;
    }
    // Wind over the starboard side (negative angle) must never heel her to
    // starboard while sails draw: heel goes to leeward. The drawn tack's
    // drawing sector is the starboard-wind side; luffing head-to-wind and
    // dead-run entries exert too little roll to test.
    const drawingCount = entry.perSail.filter(
      (sail) => sail.state !== 'furled' && !sail.luffing,
    ).length;
    if (drawingCount >= 4 && entry.windAngleOffBowDeg < -30) {
      if (entry.totals.heelTorqueNm > 0) heelAlwaysToLeewardWhileDrawing = false;
    }
  }
  const deadAhead = entries.find((entry) => entry.windAngleOffBowDeg === 0)!;

  // --- free runs ------------------------------------------------------------
  const gustRun = runSailCase({
    durationSeconds: 90,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 0,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg: 90,
    gustiness: 1,
    canvas: FULL_SAIL,
    tack: 'starboard',
  });

  const zeroWind = runSailCase({
    durationSeconds: 20,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 0,
    yawRad: 0,
    windSpeedMps: 0,
    windDirectionTowardDeg: 0,
    gustiness: 0,
    canvas: BARE_POLES,
    tack: 'starboard',
  });

  // --- invariance with sails drawing ---------------------------------------
  const invarianceConfig = {
    durationSeconds: 24,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 0,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg: 90,
    gustiness: 1,
    canvas: FULL_SAIL,
    tack: 'starboard' as TackSide,
  };
  const caller48 = runSailCase({ ...invarianceConfig, callerHz: 48 });
  const caller240 = runSailCase({ ...invarianceConfig, callerHz: 240 });
  const compression1 = runSailCase({
    ...invarianceConfig,
    callerHz: 60,
    voyageCompression: 1,
  });
  const compression30 = runSailCase({
    ...invarianceConfig,
    callerHz: 60,
    voyageCompression: 30,
  });

  const angularError = (a: number, b: number): number => {
    let difference = (a - b + Math.PI) % (2 * Math.PI);
    if (difference < 0) difference += 2 * Math.PI;
    return Math.abs(difference - Math.PI);
  };

  return {
    formatVersion: SAILING_FORCE_EVIDENCE_FORMAT_VERSION,
    status:
      'S2a: sail forces at frozen trim drive the free hull through the ' +
      'external-force seam; rudder command, live trim and the full polar ' +
      'remain absent.',
    contract: {
      authority:
        'Sail geometry is derived from rig.ts corner nodes; the leeward ' +
        'normal is the drawn belly direction. No second geometry.',
      integration:
        'Per-sail quasi-steady aero at 240 Hz beside resistance; the wrench ' +
        'splits once into horizontal force + yaw moment and the BuoyantBody ' +
        'external wrench.',
      scope:
        'Captive straight-line force sweeps with per-sail breakdowns, free ' +
        'gust runs, and clock/domain invariance in flat water. The polar and ' +
        'added mass are S2b.',
      validationMeaning:
        'Signs, luffing, tack mirror symmetry, the generalised energy gate ' +
        'and invariance are validated; aero coefficients remain provisional.',
    },
    rigidBody: {
      massKg: round(body.mass),
      yawInertiaKgM2: round(body.inertiaYaw),
    },
    sailPlan: {
      totalClothAreaM2: round(
        SAIL_AERO_GEOMETRY.reduce(
          (total, sail) => total + sail.variants.starboard.set!.areaM2,
          0,
        ),
        3,
      ),
      windage: {
        areaM2: round(RIG_WINDAGE.areaM2, 3),
        coeYM: round(RIG_WINDAGE.coe.y, 3),
      },
      sails: SAIL_AERO_GEOMETRY.map((sail) => {
        const set = sail.variants.starboard.set!;
        const reefAreasM2: Partial<Record<'reef1' | 'reef2', number>> = {};
        for (const reef of ['reef1', 'reef2'] as const) {
          const variant = sail.variants.starboard[reef];
          if (variant) reefAreasM2[reef] = round(variant.areaM2, 3);
        }
        return {
          name: sail.name,
          family: sail.family,
          camber: sail.camber,
          areaM2: round(set.areaM2, 3),
          coeM: {
            x: round(set.coe.x, 4),
            y: round(set.coe.y, 4),
            z: round(set.coe.z, 4),
          },
          reefAreasM2,
        };
      }),
    },
    captiveSweep: {
      windSpeedMps,
      towSpeedMps,
      settleSeconds,
      entries,
      gates: {
        driveDeadAheadN: deadAhead.totals.driveForwardN,
        bestDriveAngleDeg,
        bestDriveN: round(bestDriveN, 3),
        tackMirrorRelativeError: round(tackMirrorRelativeError, 12),
        heelAlwaysToLeewardWhileDrawing,
      },
    },
    freeRuns: {
      gustEnergy: {
        windSpeedMps,
        gustiness: 1,
        durationSeconds: 90,
        samples: gustRun.samples,
        maxEnergyOverWorkJ: round(gustRun.maxEnergyOverWorkJ, 6),
        finalSpeedMps: round(
          Math.hypot(gustRun.finalVelocityX, gustRun.finalVelocityZ),
        ),
        hullSpeedBoundMps: round(SAILING_HULL_SPEED_MPS * 1.25, 3),
      },
      zeroWindBarePoles: {
        durationSeconds: 20,
        finalSpeedMps: round(
          Math.hypot(zeroWind.finalVelocityX, zeroWind.finalVelocityZ),
        ),
        externalWorkJ: round(zeroWind.externalWorkJ, 10),
      },
    },
    invariance: {
      callerRate: {
        durationSeconds: invarianceConfig.durationSeconds,
        firstCallerHz: 48,
        secondCallerHz: 240,
        velocityErrorMps: round(
          Math.hypot(
            caller48.finalVelocityX - caller240.finalVelocityX,
            caller48.finalVelocityZ - caller240.finalVelocityZ,
          ),
          12,
        ),
        yawErrorRad: round(
          angularError(caller48.finalYawRad, caller240.finalYawRad),
          12,
        ),
        externalWorkErrorJ: round(
          Math.abs(caller48.externalWorkJ - caller240.externalWorkJ),
          9,
        ),
      },
      voyageCompression: {
        durationSeconds: invarianceConfig.durationSeconds,
        firstCompression: 1,
        secondCompression: 30,
        localVelocityErrorMps: round(
          Math.hypot(
            compression1.finalVelocityX - compression30.finalVelocityX,
            compression1.finalVelocityZ - compression30.finalVelocityZ,
          ),
          12,
        ),
        localYawErrorRad: round(
          angularError(compression1.finalYawRad, compression30.finalYawRad),
          12,
        ),
        globalDistanceRatio: round(
          compression30.globalDistanceTravelledM /
            compression1.globalDistanceTravelledM,
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
