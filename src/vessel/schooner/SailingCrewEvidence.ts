import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import { PlanetaryWorld } from '../../world/PlanetaryWorld';
import { windAngleOffBowDeg, WorldWind } from '../../world/WorldWind';
import { PHYSICS_STEP } from '../BuoyantBody';
import {
  trueHeadingForModelYaw,
  type VesselHorizontalDynamicsBridge,
} from '../VesselMotion';
import { EVIDENCE_GEODESIC } from './SchoonerHorizontalDynamicsEvidence';
import { AUTHORED_TRIM_DEG, SailingControls } from './SailingControls';
import type { SailName } from './rig';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { SchoonerHorizontalDynamics } from './SchoonerHorizontalDynamics';
import { SchoonerSailForces } from './SchoonerSailForces';
import { FULL_SAIL } from './sailAero';
import { trimToDrawDeg } from './SailingPolarEvidence';
import { TRIM_STATIONS } from './crew/Trimmers';
import {
  CompassInstrument,
  signedAngleDifferenceDeg,
} from './crew/CompassInstrument';
import {
  SailingCrewSensors,
} from './crew/CrewObservations';
import type { HelmIntervention } from './crew/Helmsman';
import { DEFAULT_SAILING_CREW_SEED } from './crew/HumanOperator';
import { SailingCrew } from './crew/SailingCrew';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const PHYSICS_HZ = 240;
/**
 * Signed centring statistics start later than the RMS window: the first
 * minute belongs to the spoken-order pickup and to the helmsman taking the
 * vessel's measure, and a mean-centred hold is a settled property.
 */
const SIGNED_EVALUATION_STARTS_AT_SECONDS = 60;

/**
 * The fraction of the ideal-trim schedule's speed a crew working her by eye
 * must reach.
 *
 * Stated rather than derived, per the S5 handover's "a stated useful fraction
 * of the ideal S4 polar without reproducing it exactly". Measured with margin:
 * the cases run at 0.97–0.99 today, so this is a floor with room for the
 * operator profile to be retuned under it rather than a fit to the number.
 */
const USEFUL_POLAR_FRACTION = 0.94;

/**
 * The shortest gap allowed between one hand's adjustments.
 *
 * Not a rate limit imposed on the crew: it is the assertion that every
 * adjustment was followed by a real look at what it did. A station acting
 * faster than this would be a controller writing targets, not a man watching
 * his sail.
 */
const MINIMUM_TRIM_OBSERVATION_GAP_SECONDS = 1.5;

/**
 * How far from the ideal schedule the hands' own settings must sit.
 *
 * The gate that matters is not "slower than the oracle" — a static schedule
 * recomputed every substep is not actually optimal in a seaway, and the crew
 * can beat it on speed while plainly not reading it. What must be true is that
 * they did not arrive at its numbers. Degrees of sheet, averaged over the
 * stations that have one.
 */
const MINIMUM_ORACLE_DISTANCE_DEG = 2;

export const SAILING_CREW_EVIDENCE_FORMAT_VERSION = 2;

export interface CompassEvidenceSample {
  timeSeconds: number;
  truthHeadingDeg: number;
  indicatedHeadingDeg: number;
  cardRateDegPerSecond: number;
  seawayDisplacementDeg: number;
}

export interface CompassEvidenceCase {
  name: string;
  initialHeadingDeg: number;
  targetHeadingDeg: number;
  samples: CompassEvidenceSample[];
  maximumOvershootDeg: number;
  finalErrorDeg: number;
  settleTimeSeconds: number | null;
}

export interface CrewHelmTraceSample {
  timeSeconds: number;
  truthHeadingDeg: number;
  orderedCourseDeg: number | null;
  indicatedHeadingDeg: number;
  cardRateDegPerSecond: number;
  perceivedCompassDeg: number | null;
  perceivedCompassAgeSeconds: number;
  perceivedHeadSwing: string;
  perceivedWindCloth: string;
  perceivedTillerLoadN: number;
  focus: string;
  orderPhase: string;
  actionPhase: string;
  rudderRequestedDeg: number;
  rudderActualDeg: number;
  courseErrorDeg: number;
  interventionSequenceId: number | null;
}

export interface CrewHelmCase {
  name: string;
  seaStateName: 'FLAT' | 'CURRENT_MODERATE';
  callerHz: number;
  seed: number;
  durationSeconds: number;
  orderedCourseDeg: number;
  rmsCourseErrorDeg: number;
  maximumAbsCourseErrorDeg: number;
  /**
   * Mean signed heading error over the settled window (from
   * SIGNED_EVALUATION_STARTS_AT_SECONDS), positive to starboard of the order.
   * Unsigned RMS cannot see a one-sided hold; this can. Null when the run is
   * shorter than the settled window.
   */
  settledSignedMeanErrorDeg: number | null;
  /** RMS heading error over the same settled window. */
  settledRmsErrorDeg: number | null;
  /** Fraction of the settled window spent starboard of the order. */
  settledFractionStarboardOfOrder: number | null;
  interventionCount: number;
  interventionsPerMinute: number;
  maximumUnchangedTargetSeconds: number;
  firstOrderLatencySeconds: number;
  firstInterventionLatencySeconds: number | null;
  hasCorrectWatchEaseEpisode: boolean;
  interventions: readonly HelmIntervention[];
  trace: CrewHelmTraceSample[];
  final: {
    truthHeadingDeg: number;
    rudderRequestedDeg: number;
    rudderActualDeg: number;
    speedMps: number;
  };
}

export interface DirectTakeoverEvidence {
  takeoverStartedAtSeconds: number;
  takeoverReleasedAtSeconds: number;
  directTargetDeg: number;
  interventionsDuringTakeover: number;
  firstPostReleaseDecisionLatencySeconds: number | null;
  targetHeldDuringTakeover: boolean;
}

export interface TrimmerStationEvidence {
  station: SailName;
  /** When this station's own spoken-order pipeline let it start work. */
  readyAtSeconds: number;
  firstAdjustmentAtSeconds: number | null;
  adjustmentCount: number;
  /** Shortest interval between two adjustments at this station. */
  minimumAdjustmentGapSeconds: number | null;
  initialTrimDeg: number;
  finalTrimDeg: number;
  /** What the S4 schedule would have set here, at this run's settled wind. */
  idealTrimDeg: number;
  /** How far the hand's own answer sits from that schedule's. */
  trimDifferenceDeg: number;
  cannotDraw: boolean;
  decisions: string[];
}

export interface CrewTrimCase {
  name: string;
  seaStateName: string;
  callerHz: number;
  seed: number;
  durationSeconds: number;
  windSpeedMps: number;
  initialTrimDeg: Partial<Record<SailName, number>> | null;
  /** Mean speed over the settled window, with the crew working her. */
  meanSettledSpeedMps: number;
  /**
   * The same run with the S4 ideal trim schedule written every substep — the
   * oracle the trimmers are forbidden to consult, measured live so the
   * comparison is against this run's own conditions rather than a stored
   * polar row taken at a different wind and heading.
   */
  idealMeanSettledSpeedMps: number;
  /** The same run with nobody touching a sheet at all. */
  untrimmedMeanSettledSpeedMps: number;
  /** Crew speed as a fraction of the ideal. */
  polarFraction: number;
  untrimmedPolarFraction: number;
  maximumAbsRollDeg: number;
  overpoweredEases: number;
  totalAdjustments: number;
  stations: TrimmerStationEvidence[];
}

export interface SailingCrewEvidence {
  formatVersion: number;
  generatedBy: string;
  configuration: {
    physicsHz: number;
    seed: number;
    traceIntervalSeconds: number;
    courseEvaluationStartsAtSeconds: number;
  };
  compass: {
    step: CompassEvidenceCase;
    wrapClockwise: CompassEvidenceCase;
    wrapAnticlockwise: CompassEvidenceCase;
    steady: CompassEvidenceCase;
    seaway: CompassEvidenceCase;
    callerRateFinals: Array<{
      callerHz: number;
      indicatedHeadingDeg: number;
      cardRateDegPerSecond: number;
    }>;
  };
  helm: {
    calm: CrewHelmCase;
    currentModerate: CrewHelmCase;
    directTakeover: DirectTakeoverEvidence;
    callerRateFinals: Array<{
      callerHz: number;
      finalHeadingDeg: number;
      finalRudderRequestedDeg: number;
      interventionSignature: string;
    }>;
  };
  trim: {
    fromWorkingTrims: CrewTrimCase;
    fromBadlySetRig: CrewTrimCase;
    inStrongWind: CrewTrimCase;
  };
  gates: {
    compassFiniteResponse: boolean;
    compassSettlesInBand: boolean;
    compassWrapsBothWays: boolean;
    compassSteadyResidualDeg: number;
    compassSeawayBoundedDeg: number;
    compassCallerRateInvariant: boolean;
    calmRmsCourseErrorDeg: number;
    moderateRmsCourseErrorDeg: number;
    helmAccuracyInBand: boolean;
    /**
     * The settled hold is mean-centred on the order rather than parked to one
     * side of it — the property a persistent weather-helm limit cycle fails.
     */
    helmHoldsCourseCentred: boolean;
    nonzeroHumanLatency: boolean;
    interventionCadenceInBand: boolean;
    settledCourseDoesNotChatter: boolean;
    meaningfulUnchangedTargets: boolean;
    correctWatchEaseEpisodes: boolean;
    directTakeoverSilent: boolean;
    directReleaseReacquires: boolean;
    helmCallerRateInvariant: boolean;
    /** No station touched its sheet before it had heard and processed the order. */
    trimWaitsForItsOwnOrder: boolean;
    /** Every adjustment is followed by a real look before the next one. */
    trimEpisodesLeaveObservationGaps: boolean;
    /** Crew trim reaches a useful fraction of the ideal schedule. */
    trimmedPolarFraction: number;
    trimReachesUsefulFraction: boolean;
    /**
     * And does NOT reproduce it. A trimmer that matched the oracle would have
     * been reading it, whatever the call graph said.
     */
    trimDoesNotReproduceTheOracle: boolean;
    /** Hands recover a badly set rig without being told what is wrong. */
    trimRecoversBadlySetRig: boolean;
    /** Heel stays bounded in the strong-wind case. */
    strongWindHeelBoundedDeg: number;
    /** A sail that will not draw is reported, not silently fought forever. */
    cannotDrawIsReportedFromSustainedEvidence: boolean;
  };
}

interface CrewHelmRunOptions {
  name: string;
  seaStateName: 'FLAT' | 'CURRENT_MODERATE';
  callerHz: number;
  seed: number;
  durationSeconds: number;
  /**
   * Reflect the wind and every sheeted trim about the ordered course, putting
   * her on the mirrored tack. The vessel's steady weather helm then pushes the
   * bow the other way, so a controller equilibrium follows the tack while a
   * compass-handedness bias would not.
   */
  mirrored?: boolean;
  takeover?: {
    startSeconds: number;
    endSeconds: number;
    targetDeg: number;
  };
}

function runCompassCase(
  name: string,
  initialHeadingDeg: number,
  targetHeadingDeg: number,
  durationSeconds: number,
  rollRateAt: (timeSeconds: number) => number = () => 0,
): CompassEvidenceCase {
  const compass = new CompassInstrument();
  compass.reset(initialHeadingDeg);
  const samples: CompassEvidenceSample[] = [];
  let maximumOvershootDeg = 0;
  let settleTimeSeconds: number | null = null;
  const sampleEverySteps = 24;
  const steps = Math.round(durationSeconds * PHYSICS_HZ);
  for (let i = 0; i < steps; i++) {
    const time = (i + 1) / PHYSICS_HZ;
    const readout = compass.advance(PHYSICS_STEP, {
      trueHeadingDeg: targetHeadingDeg,
      rollRateRadPerSecond: rollRateAt(time),
    });
    const error = signedAngleDifferenceDeg(
      readout.indicatedHeadingDeg,
      targetHeadingDeg,
    );
    const intended = signedAngleDifferenceDeg(
      targetHeadingDeg,
      initialHeadingDeg,
    );
    if (Math.sign(error) === Math.sign(intended)) {
      maximumOvershootDeg = Math.max(maximumOvershootDeg, Math.abs(error));
    }
    if (
      settleTimeSeconds === null &&
      time >= 0.5 &&
      Math.abs(error) < 0.5 &&
      Math.abs(readout.cardRateDegPerSecond) < 0.3
    ) {
      settleTimeSeconds = time;
    }
    if ((i + 1) % sampleEverySteps === 0) {
      samples.push({
        timeSeconds: round(time, 4),
        truthHeadingDeg: round(targetHeadingDeg, 6),
        indicatedHeadingDeg: round(readout.indicatedHeadingDeg, 6),
        cardRateDegPerSecond: round(readout.cardRateDegPerSecond, 6),
        seawayDisplacementDeg: round(readout.seawayDisplacementDeg, 6),
      });
    }
  }
  const final = samples[samples.length - 1];
  return {
    name,
    initialHeadingDeg,
    targetHeadingDeg,
    samples,
    maximumOvershootDeg: round(maximumOvershootDeg, 6),
    finalErrorDeg: round(
      signedAngleDifferenceDeg(final.indicatedHeadingDeg, targetHeadingDeg),
      6,
    ),
    settleTimeSeconds:
      settleTimeSeconds === null ? null : round(settleTimeSeconds, 4),
  };
}

function compassCallerFinal(callerHz: number): {
  callerHz: number;
  indicatedHeadingDeg: number;
  cardRateDegPerSecond: number;
} {
  const compass = new CompassInstrument();
  compass.reset(350);
  let accumulator = 0;
  let fixedTime = 0;
  const callerFrames = 12 * callerHz;
  for (let frame = 0; frame < callerFrames; frame++) {
    accumulator += 1 / callerHz;
    while (accumulator + 1e-14 >= PHYSICS_STEP) {
      fixedTime += PHYSICS_STEP;
      compass.advance(PHYSICS_STEP, {
        trueHeadingDeg: fixedTime < 1.5 ? 350 : 14,
        rollRateRadPerSecond:
          0.12 * Math.sin((2 * Math.PI * fixedTime) / 4.7),
      });
      accumulator -= PHYSICS_STEP;
      if (accumulator < 1e-14) accumulator = 0;
    }
  }
  return {
    callerHz,
    indicatedHeadingDeg: round(compass.readout.indicatedHeadingDeg, 9),
    cardRateDegPerSecond: round(compass.readout.cardRateDegPerSecond, 9),
  };
}

function runCrewHelmCase(options: CrewHelmRunOptions): CrewHelmCase {
  const sea = findSeaState(options.seaStateName);
  const waves = new WaveField(sea);
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
  const mirrored = options.mirrored === true;
  const wind = new WorldWind(0x53354357);
  // The ordered course is 180, so the mirrored wind is the reflection of 90
  // about that axis: 270. Trims reflect by sign in the positive-to-port
  // convention (rig trim limits are symmetric).
  wind.setMean(
    6,
    mirrored ? 270 : 90,
    options.seaStateName === 'CURRENT_MODERATE' ? 0.25 : 0,
  );
  const sails = new SchoonerSailForces(wind);
  const controls = new SailingControls(
    mirrored ? mirroredAuthoredTrimDeg() : undefined,
  );
  sails.canvas = FULL_SAIL;
  sails.tack = mirrored ? 'port' : 'starboard';
  sails.attachControls(controls);
  dynamics.externalForces = sails;
  dynamics.helm = controls;

  const initialSpeedMps = 3.2;
  const velocity = { x: 0, z: initialSpeedMps };
  let yawRad = 0;
  let yawRateRadPerSecond = 0;
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 11) / 1000,
    latitudeRad: -35 * DEG_TO_RAD,
    longitudeRad: 138 * DEG_TO_RAD,
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: 30,
    geodesic: EVIDENCE_GEODESIC,
  });
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  const crew = new SailingCrew(controls, options.seed);
  const sensors = new SailingCrewSensors({
    seed: options.seed,
    headingDegForModelYaw: (modelYaw) =>
      trueHeadingForModelYaw(world.state, modelYaw) * RAD_TO_DEG,
    rudderTargetDeg: () => controls.rudderTargetDeg,
    sailAero: () => sails.lastResult,
    focus: () => crew.focus,
  });
  dynamics.substepTruthObserver = sensors;
  dynamics.substepCommander = {
    advanceSubstep: (stepSeconds) =>
      crew.advanceSubstep(stepSeconds, sensors.helmObservation),
    reset: () => crew.reset(),
  };
  dynamics.reset();

  const orderedCourseDeg = 180;
  const order = crew.orderCompassCourse(orderedCourseDeg);
  const trace: CrewHelmTraceSample[] = [];
  const sampleEverySteps = Math.round(0.5 * PHYSICS_HZ);
  let stepCount = 0;
  let latestRecordedIntervention = 0;
  let lastTarget = controls.rudderTargetDeg;
  let targetChangedAt = 0;
  let maximumUnchangedTargetSeconds = 0;
  let takeoverStarted = false;
  let takeoverReleased = false;

  const bridge: VesselHorizontalDynamicsBridge = {
    mode: 'free',
    towVelocityWorldMps: { x: 0, z: 0 },
    towYawRad: 0,
    commitStep(
      physicsDeltaSeconds,
      displacementX,
      displacementZ,
      endVelocityX,
      endVelocityZ,
      endYawRad,
      _endYawRate,
    ) {
      stepCount++;
      world.advanceTangentMotionStep(
        physicsDeltaSeconds,
        displacementX,
        -displacementZ,
        endVelocityX,
        -endVelocityZ,
      );
      const timeSeconds = stepCount / PHYSICS_HZ;
      const currentTarget = controls.rudderTargetDeg;
      if (currentTarget !== lastTarget) {
        maximumUnchangedTargetSeconds = Math.max(
          maximumUnchangedTargetSeconds,
          timeSeconds - targetChangedAt,
        );
        targetChangedAt = timeSeconds;
        lastTarget = currentTarget;
      }
      if (stepCount % sampleEverySteps === 0) {
        const sensorReadout = sensors.readout();
        const crewReadout = crew.readout().helmsman;
        const latest = crewReadout.latestIntervention;
        const interventionSequenceId =
          latest && latest.sequenceId > latestRecordedIntervention
            ? latest.sequenceId
            : null;
        if (interventionSequenceId !== null) {
          latestRecordedIntervention = interventionSequenceId;
        }
        const truthHeadingDeg =
          trueHeadingForModelYaw(world.state, endYawRad) * RAD_TO_DEG;
        trace.push({
          timeSeconds: round(timeSeconds, 4),
          truthHeadingDeg: round(truthHeadingDeg, 6),
          orderedCourseDeg: crewReadout.orderedCourseDeg,
          indicatedHeadingDeg: round(
            sensorReadout.compass.indicatedHeadingDeg,
            6,
          ),
          cardRateDegPerSecond: round(
            sensorReadout.compass.cardRateDegPerSecond,
            6,
          ),
          perceivedCompassDeg:
            sensorReadout.helmObservation.compass.readingDeg,
          perceivedCompassAgeSeconds: round(
            sensorReadout.helmObservation.compass.ageSeconds,
            4,
          ),
          perceivedHeadSwing:
            `${sensorReadout.helmObservation.shipHead.swing}:` +
            sensorReadout.helmObservation.shipHead.strength,
          perceivedWindCloth:
            sensorReadout.helmObservation.windAndSails.cloth,
          perceivedTillerLoadN:
            sensorReadout.helmObservation.tillerLoad.signedHandForceN,
          focus: crewReadout.focus,
          orderPhase: crewReadout.orderPhase,
          actionPhase: crewReadout.actionPhase,
          rudderRequestedDeg: round(controls.rudderTargetDeg, 4),
          rudderActualDeg: round(controls.rudderAngleDeg, 4),
          courseErrorDeg: round(
            signedAngleDifferenceDeg(orderedCourseDeg, truthHeadingDeg),
            6,
          ),
          interventionSequenceId,
        });
      }
    },
  };

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
  const callerFrames = Math.round(options.durationSeconds * options.callerHz);
  for (let frame = 0; frame < callerFrames; frame++) {
    const callerTime = frame / options.callerHz;
    if (
      options.takeover &&
      !takeoverStarted &&
      callerTime >= options.takeover.startSeconds
    ) {
      takeoverStarted = true;
      crew.setDirectHelmTakeover(true);
      controls.commandRudderDeg(options.takeover.targetDeg);
    }
    if (
      options.takeover &&
      !takeoverReleased &&
      callerTime >= options.takeover.endSeconds
    ) {
      takeoverReleased = true;
      crew.setDirectHelmTakeover(false);
    }
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
  maximumUnchangedTargetSeconds = Math.max(
    maximumUnchangedTargetSeconds,
    options.durationSeconds - targetChangedAt,
  );

  const evaluationTrace = trace.filter((sample) => sample.timeSeconds >= 20);
  const squaredErrors = evaluationTrace.map(
    (sample) => sample.courseErrorDeg * sample.courseErrorDeg,
  );
  const rmsCourseErrorDeg = Math.sqrt(
    squaredErrors.reduce((sum, value) => sum + value, 0) /
      Math.max(squaredErrors.length, 1),
  );
  const maximumAbsCourseErrorDeg = Math.max(
    ...evaluationTrace.map((sample) => Math.abs(sample.courseErrorDeg)),
    0,
  );
  // courseErrorDeg is order-minus-truth, so the starboard side is negative.
  const settledTrace = trace.filter(
    (sample) => sample.timeSeconds >= SIGNED_EVALUATION_STARTS_AT_SECONDS,
  );
  const settledSignedMeanErrorDeg =
    settledTrace.length === 0
      ? null
      : -settledTrace.reduce((sum, sample) => sum + sample.courseErrorDeg, 0) /
        settledTrace.length;
  const settledRmsErrorDeg =
    settledTrace.length === 0
      ? null
      : Math.sqrt(
          settledTrace.reduce(
            (sum, sample) => sum + sample.courseErrorDeg * sample.courseErrorDeg,
            0,
          ) / settledTrace.length,
        );
  const settledFractionStarboardOfOrder =
    settledTrace.length === 0
      ? null
      : settledTrace.filter((sample) => sample.courseErrorDeg < 0).length /
        settledTrace.length;
  const helmsman = crew.readout().helmsman;
  const orderResponse = helmsman.orderResponse!;
  const firstIntervention = helmsman.interventions[0] ?? null;
  const nonzero = helmsman.interventions.findIndex(
    (event) => Math.abs(event.requestedRudderDeg) >= 2,
  );
  const easedAfter =
    nonzero >= 0
      ? helmsman.interventions
          .slice(nonzero + 1)
          .some(
            (event) =>
              Math.abs(event.requestedRudderDeg) <
              Math.abs(helmsman.interventions[nonzero].requestedRudderDeg),
          )
      : false;
  const finalHeadingDeg =
    trueHeadingForModelYaw(world.state, yawRad) * RAD_TO_DEG;
  return {
    name: options.name,
    seaStateName: options.seaStateName,
    callerHz: options.callerHz,
    seed: options.seed,
    durationSeconds: options.durationSeconds,
    orderedCourseDeg,
    rmsCourseErrorDeg: round(rmsCourseErrorDeg, 6),
    maximumAbsCourseErrorDeg: round(maximumAbsCourseErrorDeg, 6),
    settledSignedMeanErrorDeg:
      settledSignedMeanErrorDeg === null
        ? null
        : round(settledSignedMeanErrorDeg, 6),
    settledRmsErrorDeg:
      settledRmsErrorDeg === null ? null : round(settledRmsErrorDeg, 6),
    settledFractionStarboardOfOrder:
      settledFractionStarboardOfOrder === null
        ? null
        : round(settledFractionStarboardOfOrder, 6),
    interventionCount: helmsman.interventionCount,
    interventionsPerMinute: round(
      (helmsman.interventionCount / options.durationSeconds) * 60,
      6,
    ),
    maximumUnchangedTargetSeconds: round(maximumUnchangedTargetSeconds, 6),
    firstOrderLatencySeconds: round(
      orderResponse.timing.motorStartedAtSeconds - order.issueTimeSeconds,
      6,
    ),
    firstInterventionLatencySeconds: firstIntervention
      ? round(firstIntervention.decidedAtSeconds - order.issueTimeSeconds, 6)
      : null,
    hasCorrectWatchEaseEpisode: nonzero >= 0 && easedAfter,
    interventions: helmsman.interventions.map((event) => ({ ...event })),
    trace,
    final: {
      truthHeadingDeg: round(finalHeadingDeg, 6),
      rudderRequestedDeg: round(controls.rudderTargetDeg, 6),
      rudderActualDeg: round(controls.rudderAngleDeg, 6),
      speedMps: round(Math.hypot(velocity.x, velocity.z), 6),
    },
  };
}

function mirroredAuthoredTrimDeg(): Partial<Record<SailName, number>> {
  const trims: Partial<Record<SailName, number>> = {};
  for (const sail of Object.keys(AUTHORED_TRIM_DEG) as SailName[]) {
    trims[sail] = -AUTHORED_TRIM_DEG[sail];
  }
  return trims;
}

export interface HeadingHoldBiasRunSummary {
  seed: number;
  mirrored: boolean;
  /** Positive means the bow sat starboard of the order over the settled window. */
  settledSignedMeanErrorDeg: number;
  settledRmsErrorDeg: number;
  settledFractionStarboardOfOrder: number;
  interventionsPerMinute: number;
  easeCount: number;
  easesWhileStarboardOfOrder: number;
  easesWhilePortOfOrder: number;
}

export interface HeadingHoldBiasEvidence {
  configuration: {
    physicsHz: number;
    callerHz: number;
    durationSeconds: number;
    settledStartSeconds: number;
    orderedCourseDeg: number;
    seeds: number[];
  };
  runs: HeadingHoldBiasRunSummary[];
  mirroredRuns: HeadingHoldBiasRunSummary[];
  ensemble: {
    meanSignedErrorDeg: number;
    mirroredMeanSignedErrorDeg: number;
    /** Per-seed midpoint of the default and mirrored settled means. */
    pairMidpointsDeg: number[];
    meanPairMidpointDeg: number;
    maxAbsRunMeanDeg: number;
    easeCount: number;
    easesWhileStarboardOfOrder: number;
    easesWhilePortOfOrder: number;
  };
}

/**
 * The heading-hold centring ensemble: flat water, zero gustiness, the full
 * opening sail plan, several independent crew seeds, both tacks.
 *
 * An imperfect human may wander and overshoot, but if the closed loop is
 * mean-correct, independent settled rollouts average onto the ordered course
 * and the mirrored tack averages onto it from the other side. A helmsman who
 * repeatedly removes corrective helm early and carries no holding helm against
 * the sail plan's weather helm fails here with every run mean on one side.
 */
export function buildHeadingHoldBiasEvidence(options?: {
  seeds?: readonly number[];
  durationSeconds?: number;
}): HeadingHoldBiasEvidence {
  const seeds = [...(options?.seeds ?? HEADING_HOLD_BIAS_SEEDS)];
  const durationSeconds = options?.durationSeconds ?? 180;
  const settledStartSeconds = SIGNED_EVALUATION_STARTS_AT_SECONDS;
  const run = (seed: number, mirrored: boolean) =>
    summarizeBiasRun(
      runCrewHelmCase({
        name: `bias ${mirrored ? 'mirrored' : 'default'} seed ${seed}`,
        seaStateName: 'FLAT',
        callerHz: 60,
        seed,
        durationSeconds,
        mirrored,
      }),
      mirrored,
    );
  const runs = seeds.map((seed) => run(seed, false));
  const mirroredRuns = seeds.map((seed) => run(seed, true));
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const pairMidpointsDeg = seeds.map((_, index) =>
    round(
      (runs[index].settledSignedMeanErrorDeg +
        mirroredRuns[index].settledSignedMeanErrorDeg) /
        2,
      6,
    ),
  );
  const all = [...runs, ...mirroredRuns];
  return {
    configuration: {
      physicsHz: PHYSICS_HZ,
      callerHz: 60,
      durationSeconds,
      settledStartSeconds,
      orderedCourseDeg: 180,
      seeds,
    },
    runs,
    mirroredRuns,
    ensemble: {
      meanSignedErrorDeg: round(
        mean(runs.map((entry) => entry.settledSignedMeanErrorDeg)),
        6,
      ),
      mirroredMeanSignedErrorDeg: round(
        mean(mirroredRuns.map((entry) => entry.settledSignedMeanErrorDeg)),
        6,
      ),
      pairMidpointsDeg,
      meanPairMidpointDeg: round(mean(pairMidpointsDeg), 6),
      maxAbsRunMeanDeg: round(
        Math.max(
          ...all.map((entry) => Math.abs(entry.settledSignedMeanErrorDeg)),
        ),
        6,
      ),
      easeCount: all.reduce((sum, entry) => sum + entry.easeCount, 0),
      easesWhileStarboardOfOrder: all.reduce(
        (sum, entry) => sum + entry.easesWhileStarboardOfOrder,
        0,
      ),
      easesWhilePortOfOrder: all.reduce(
        (sum, entry) => sum + entry.easesWhilePortOfOrder,
        0,
      ),
    },
  };
}

/** The production default seed first, then a spread over the 32-bit space. */
export const HEADING_HOLD_BIAS_SEEDS: readonly number[] = Object.freeze([
  1129465175, 3783900944, 2143369417, 502837890, 3157273659, 1516742132,
]);

function summarizeBiasRun(
  run: CrewHelmCase,
  mirrored: boolean,
): HeadingHoldBiasRunSummary {
  if (
    run.settledSignedMeanErrorDeg === null ||
    run.settledRmsErrorDeg === null ||
    run.settledFractionStarboardOfOrder === null
  ) {
    throw new RangeError(
      `bias run "${run.name}" is shorter than the settled window`,
    );
  }
  // An ease returns the helm toward rest from a working correction. The side
  // recorded is where the helmsman perceived the bow relative to the order at
  // the moment he decided to ease; perceivedCourseErrorDeg is order-minus-
  // perceived, so starboard is the negative side.
  const eases = run.interventions.filter(
    (event) =>
      event.executeAtSeconds >= SIGNED_EVALUATION_STARTS_AT_SECONDS &&
      Math.abs(event.requestedRudderDeg) <
        Math.abs(event.previousRequestedRudderDeg) &&
      Math.abs(event.requestedRudderDeg) <= 3,
  );
  return {
    seed: run.seed,
    mirrored,
    settledSignedMeanErrorDeg: run.settledSignedMeanErrorDeg,
    settledRmsErrorDeg: run.settledRmsErrorDeg,
    settledFractionStarboardOfOrder: run.settledFractionStarboardOfOrder,
    interventionsPerMinute: run.interventionsPerMinute,
    easeCount: eases.length,
    easesWhileStarboardOfOrder: eases.filter(
      (event) => event.perceivedCourseErrorDeg < 0,
    ).length,
    easesWhilePortOfOrder: eases.filter(
      (event) => event.perceivedCourseErrorDeg > 0,
    ).length,
  };
}

function directTakeoverEvidence(run: CrewHelmCase): DirectTakeoverEvidence {
  const takeoverStartedAtSeconds = 20;
  const takeoverReleasedAtSeconds = 25;
  const directTargetDeg = 12;
  const during = run.interventions.filter(
    (event) =>
      event.decidedAtSeconds >= takeoverStartedAtSeconds &&
      event.decidedAtSeconds < takeoverReleasedAtSeconds,
  );
  const after = run.interventions.find(
    (event) => event.decidedAtSeconds >= takeoverReleasedAtSeconds,
  );
  const takeoverSamples = run.trace.filter(
    (sample) =>
      sample.timeSeconds >= takeoverStartedAtSeconds + 1.8 &&
      sample.timeSeconds < takeoverReleasedAtSeconds,
  );
  return {
    takeoverStartedAtSeconds,
    takeoverReleasedAtSeconds,
    directTargetDeg,
    interventionsDuringTakeover: during.length,
    firstPostReleaseDecisionLatencySeconds: after
      ? round(after.decidedAtSeconds - takeoverReleasedAtSeconds, 6)
      : null,
    targetHeldDuringTakeover:
      takeoverSamples.length > 0 &&
      takeoverSamples.every(
        (sample) => sample.rudderRequestedDeg === directTargetDeg,
      ),
  };
}

function interventionSignature(run: CrewHelmCase): string {
  return run.interventions
    .map(
      (event) =>
        `${round(event.decidedAtSeconds, 6)}:` +
        `${round(event.executeAtSeconds, 6)}:` +
        `${event.requestedRudderDeg}:${event.reason}`,
    )
    .join('|');
}

function settledRestartIntervals(run: CrewHelmCase): number[] {
  // Rest is the carried balance helm, not necessarily amidships: a settled
  // stretch is an ease followed by the next course-drift correction.
  const intervals: number[] = [];
  for (let index = 1; index < run.interventions.length; index++) {
    const previous = run.interventions[index - 1];
    const current = run.interventions[index];
    if (
      (previous.reason === 'ease-as-she-answers' ||
        previous.reason === 'counter-swing') &&
      Math.abs(previous.requestedRudderDeg) <=
        Math.abs(previous.previousRequestedRudderDeg) &&
      current.reason === 'course-drift'
    ) {
      intervals.push(current.consideredAtSeconds - previous.executeAtSeconds);
    }
  }
  return intervals;
}

interface TrimRunOptions {
  name: string;
  seaStateName: string;
  callerHz: number;
  seed: number;
  durationSeconds: number;
  windSpeedMps: number;
  initialTrimDeg?: Partial<Record<SailName, number>>;
  /** 'crew' works her by eye; 'ideal' writes the S4 schedule; 'none' is frozen. */
  trimmedBy: 'crew' | 'ideal' | 'none';
}

interface TrimRunResult {
  meanSettledSpeedMps: number;
  maximumAbsRollDeg: number;
  overpoweredEases: number;
  totalAdjustments: number;
  stations: TrimmerStationEvidence[];
}

/**
 * One free-sailing run with a standing course order, differing only in who
 * touches the sheets.
 *
 * The three modes share every other input — same seed, same sea, same wind,
 * same helmsman — so the difference between their settled speeds is the
 * trimming and nothing else.
 */
function runCrewTrimCase(options: TrimRunOptions): TrimRunResult {
  const sea = findSeaState(options.seaStateName);
  const waves = new WaveField(sea);
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
  const wind = new WorldWind(0x53354357);
  wind.setMean(options.windSpeedMps, 90, 0);
  const sails = new SchoonerSailForces(wind);
  const controls = new SailingControls(options.initialTrimDeg);
  sails.canvas = FULL_SAIL;
  sails.tack = 'starboard';
  sails.attachControls(controls);
  dynamics.externalForces = sails;
  dynamics.helm = controls;

  const velocity = { x: 0, z: 3.2 };
  let yawRad = 0;
  let yawRateRadPerSecond = 0;
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 11) / 1000,
    latitudeRad: -35 * DEG_TO_RAD,
    longitudeRad: 138 * DEG_TO_RAD,
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: 30,
    geodesic: EVIDENCE_GEODESIC,
  });
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  const crew = new SailingCrew(controls, options.seed);
  const sensors = new SailingCrewSensors({
    seed: options.seed,
    headingDegForModelYaw: (modelYaw) =>
      trueHeadingForModelYaw(world.state, modelYaw) * RAD_TO_DEG,
    rudderTargetDeg: () => controls.rudderTargetDeg,
    sailAero: () => sails.lastResult,
    focus: () => crew.focus,
  });
  dynamics.substepTruthObserver = sensors;
  dynamics.substepCommander = {
    advanceSubstep: (stepSeconds) => {
      if (options.trimmedBy === 'ideal') {
        const aero = sails.lastResult;
        const sourceAbsDeg = Math.abs(
          windAngleOffBowDeg(
            aero.hullApparentModelXMps,
            aero.hullApparentModelZMps,
          ),
        );
        for (const [sail, deg] of Object.entries(
          trimToDrawDeg(sourceAbsDeg),
        ) as [SailName, number][]) {
          controls.commandTrimDeg(sail, deg);
        }
      }
      crew.advanceSubstep(stepSeconds, sensors.helmObservation, (sail) =>
        sensors.sailObservation(sail),
      );
    },
    reset: () => crew.reset(),
  };
  dynamics.reset();
  const initialTrims = new Map<SailName, number>(
    TRIM_STATIONS.map((sail) => [sail, controls.trimDeg(sail)]),
  );
  crew.orderCompassCourse(180);
  if (options.trimmedBy === 'crew') crew.orderTrimToDraw();

  let stepCount = 0;
  let speedSum = 0;
  let speedSamples = 0;
  let maximumAbsRollDeg = 0;
  const settledFromSeconds = options.durationSeconds * 0.6;
  const bridge: VesselHorizontalDynamicsBridge = {
    mode: 'free',
    towVelocityWorldMps: { x: 0, z: 0 },
    towYawRad: 0,
    commitStep(
      physicsDeltaSeconds,
      displacementX,
      displacementZ,
      endVelocityX,
      endVelocityZ,
    ) {
      stepCount++;
      world.advanceTangentMotionStep(
        physicsDeltaSeconds,
        displacementX,
        -displacementZ,
        endVelocityX,
        -endVelocityZ,
      );
      maximumAbsRollDeg = Math.max(
        maximumAbsRollDeg,
        Math.abs(body.roll * RAD_TO_DEG),
      );
      if (stepCount / PHYSICS_HZ >= settledFromSeconds) {
        speedSum += Math.hypot(endVelocityX, endVelocityZ);
        speedSamples++;
      }
    },
  };

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
  const callerFrames = Math.round(options.durationSeconds * options.callerHz);
  for (let frame = 0; frame < callerFrames; frame++) {
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

  // What the oracle would have said about the conditions this run ended in.
  // Recorded so the evidence can show the hands did NOT arrive at it — the
  // point is a crew who work her by eye, not one quietly reading the answer.
  const settledSourceAbsDeg = Math.abs(
    windAngleOffBowDeg(
      sails.lastResult.hullApparentModelXMps,
      sails.lastResult.hullApparentModelZMps,
    ),
  );
  const idealSchedule = trimToDrawDeg(settledSourceAbsDeg);
  const trimmers = crew.readout().trimmers;
  let overpoweredEases = 0;
  const stations: TrimmerStationEvidence[] = trimmers.stations.map((station) => {
    let minimumGap: number | null = null;
    for (let i = 1; i < station.adjustments.length; i++) {
      const gap =
        station.adjustments[i].consideredAtSeconds -
        station.adjustments[i - 1].executeAtSeconds;
      minimumGap = minimumGap === null ? gap : Math.min(minimumGap, gap);
    }
    for (const adjustment of station.adjustments) {
      if (adjustment.decision === 'overpowered-ease') overpoweredEases++;
    }
    return {
      station: station.station,
      readyAtSeconds: round(
        station.orderResponse?.timing.motorStartedAtSeconds ?? 0,
        6,
      ),
      firstAdjustmentAtSeconds:
        station.adjustments.length > 0
          ? round(station.adjustments[0].consideredAtSeconds, 6)
          : null,
      adjustmentCount: station.adjustmentCount,
      minimumAdjustmentGapSeconds:
        minimumGap === null ? null : round(minimumGap, 6),
      initialTrimDeg: round(initialTrims.get(station.station) ?? 0, 6),
      finalTrimDeg: round(controls.trimDeg(station.station), 6),
      idealTrimDeg: round(idealSchedule[station.station] ?? 0, 6),
      trimDifferenceDeg: round(
        Math.abs(
          controls.trimDeg(station.station) -
            (idealSchedule[station.station] ?? 0),
        ),
        6,
      ),
      cannotDraw: station.cannotDraw,
      decisions: station.adjustments.map((adjustment) => adjustment.decision),
    };
  });

  return {
    meanSettledSpeedMps: round(
      speedSamples > 0 ? speedSum / speedSamples : 0,
      6,
    ),
    maximumAbsRollDeg: round(maximumAbsRollDeg, 6),
    overpoweredEases,
    totalAdjustments: trimmers.adjustmentCount,
    stations,
  };
}

/** The three-way comparison, assembled. */
function buildTrimCase(
  options: Omit<TrimRunOptions, 'trimmedBy'>,
): CrewTrimCase {
  const crewRun = runCrewTrimCase({ ...options, trimmedBy: 'crew' });
  const idealRun = runCrewTrimCase({ ...options, trimmedBy: 'ideal' });
  const untrimmedRun = runCrewTrimCase({ ...options, trimmedBy: 'none' });
  const ideal = idealRun.meanSettledSpeedMps;
  return {
    name: options.name,
    seaStateName: options.seaStateName,
    callerHz: options.callerHz,
    seed: options.seed,
    durationSeconds: options.durationSeconds,
    windSpeedMps: options.windSpeedMps,
    initialTrimDeg: options.initialTrimDeg ?? null,
    meanSettledSpeedMps: crewRun.meanSettledSpeedMps,
    idealMeanSettledSpeedMps: ideal,
    untrimmedMeanSettledSpeedMps: untrimmedRun.meanSettledSpeedMps,
    polarFraction: round(
      ideal > 0 ? crewRun.meanSettledSpeedMps / ideal : 0,
      6,
    ),
    untrimmedPolarFraction: round(
      ideal > 0 ? untrimmedRun.meanSettledSpeedMps / ideal : 0,
      6,
    ),
    maximumAbsRollDeg: crewRun.maximumAbsRollDeg,
    overpoweredEases: crewRun.overpoweredEases,
    totalAdjustments: crewRun.totalAdjustments,
    stations: crewRun.stations,
  };
}

export function buildSailingCrewEvidence(): SailingCrewEvidence {
  const step = runCompassCase('30-degree heading step', 20, 50, 18);
  const wrapClockwise = runCompassCase('north wrap 350 to 10', 350, 10, 14);
  const wrapAnticlockwise = runCompassCase('north wrap 10 to 350', 10, 350, 14);
  const steady = runCompassCase('steady hull', 217, 217, 20);
  const seaway = runCompassCase(
    'steady heading in repeated seaway',
    180,
    180,
    30,
    (time) =>
      0.16 * Math.sin((2 * Math.PI * time) / 5.5) +
      0.05 * Math.sin((2 * Math.PI * time) / 2.3),
  );
  const compassCallerRateFinals = [30, 60, 120].map(compassCallerFinal);

  // 180 s so the signed settled window is 120 s: long enough for the
  // helmsman to have taken the vessel's measure and for a one-sided park to
  // be a controller property rather than a snapshot of the learning phase.
  const calm = runCrewHelmCase({
    name: 'calm compass-course hold',
    seaStateName: 'FLAT',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED,
    durationSeconds: 180,
  });
  const currentModerate = runCrewHelmCase({
    name: 'CURRENT_MODERATE compass-course hold',
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED,
    durationSeconds: 180,
  });
  const takeoverRun = runCrewHelmCase({
    name: 'direct takeover and release',
    seaStateName: 'FLAT',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED ^ 0x54414b45,
    durationSeconds: 50,
    takeover: { startSeconds: 20, endSeconds: 25, targetDeg: 12 },
  });
  const directTakeover = directTakeoverEvidence(takeoverRun);
  const callerRuns = [30, 60, 120].map((callerHz) =>
    runCrewHelmCase({
      name: `caller ${callerHz} Hz`,
      seaStateName: 'FLAT',
      callerHz,
      seed: DEFAULT_SAILING_CREW_SEED,
      durationSeconds: 60,
    }),
  );
  const helmCallerRateFinals = callerRuns.map((run) => ({
    callerHz: run.callerHz,
    finalHeadingDeg: run.final.truthHeadingDeg,
    finalRudderRequestedDeg: run.final.rudderRequestedDeg,
    interventionSignature: interventionSignature(run),
  }));

  const seawayErrors = seaway.samples.map((sample) =>
    Math.abs(
      signedAngleDifferenceDeg(
        sample.indicatedHeadingDeg,
        sample.truthHeadingDeg,
      ),
    ),
  );
  const compassReference = JSON.stringify(compassCallerRateFinals[0]);
  const compassCallerRateInvariant = compassCallerRateFinals.every(
    (entry) =>
      JSON.stringify({ ...entry, callerHz: compassCallerRateFinals[0].callerHz }) ===
      compassReference,
  );
  const helmReference = helmCallerRateFinals[0];
  const helmCallerRateInvariant = helmCallerRateFinals.every(
    (entry) =>
      entry.finalHeadingDeg === helmReference.finalHeadingDeg &&
      entry.finalRudderRequestedDeg === helmReference.finalRudderRequestedDeg &&
      entry.interventionSignature === helmReference.interventionSignature,
  );
  const settledRestarts = [calm, currentModerate].flatMap(
    settledRestartIntervals,
  );

  // The trimmer cases. "Badly set" is the whole rig eased far out — a rig
  // nobody has touched since the last run downwind — and the hands are told
  // nothing except "trim to draw".
  const fromWorkingTrims = buildTrimCase({
    name: 'standing trim duty from the working trims',
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED,
    durationSeconds: 180,
    windSpeedMps: 6,
  });
  const fromBadlySetRig = buildTrimCase({
    name: 'standing trim duty from a badly set rig',
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED,
    durationSeconds: 180,
    windSpeedMps: 6,
    initialTrimDeg: {
      mainsail: 60,
      foresail: 60,
      foreStaysail: 45,
      jib: 45,
      flyingJib: 45,
    },
  });
  const inStrongWind = buildTrimCase({
    name: 'standing trim duty in strong wind',
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed: DEFAULT_SAILING_CREW_SEED,
    durationSeconds: 180,
    windSpeedMps: 16,
  });
  const trimCases = [fromWorkingTrims, fromBadlySetRig, inStrongWind];
  const trimWaitsForItsOwnOrder = trimCases.every((trimCase) =>
    trimCase.stations.every(
      (station) =>
        station.firstAdjustmentAtSeconds === null ||
        station.firstAdjustmentAtSeconds >= station.readyAtSeconds,
    ),
  );
  const trimEpisodesLeaveObservationGaps = trimCases.every((trimCase) =>
    trimCase.stations.every(
      (station) =>
        station.minimumAdjustmentGapSeconds === null ||
        station.minimumAdjustmentGapSeconds >= MINIMUM_TRIM_OBSERVATION_GAP_SECONDS,
    ),
  );
  const cannotDrawIsReportedFromSustainedEvidence = trimCases.every(
    (trimCase) =>
      trimCase.stations
        .filter((station) => station.cannotDraw)
        .every((station) => station.station === 'foreTopsail'),
  );

  return {
    formatVersion: SAILING_CREW_EVIDENCE_FORMAT_VERSION,
    generatedBy: 'src/vessel/schooner/SailingCrewEvidence.ts',
    configuration: {
      physicsHz: PHYSICS_HZ,
      seed: DEFAULT_SAILING_CREW_SEED,
      traceIntervalSeconds: 0.5,
      courseEvaluationStartsAtSeconds: 20,
    },
    compass: {
      step,
      wrapClockwise,
      wrapAnticlockwise,
      steady,
      seaway,
      callerRateFinals: compassCallerRateFinals,
    },
    helm: {
      calm,
      currentModerate,
      directTakeover,
      callerRateFinals: helmCallerRateFinals,
    },
    trim: { fromWorkingTrims, fromBadlySetRig, inStrongWind },
    gates: {
      compassFiniteResponse:
        step.samples[4].indicatedHeadingDeg > step.initialHeadingDeg &&
        step.samples[4].indicatedHeadingDeg < step.targetHeadingDeg,
      compassSettlesInBand:
        step.settleTimeSeconds !== null &&
        step.settleTimeSeconds >= 2 &&
        step.settleTimeSeconds <= 10 &&
        step.maximumOvershootDeg <= 3 &&
        Math.abs(step.finalErrorDeg) <= 0.05,
      compassWrapsBothWays:
        wrapClockwise.samples[1].cardRateDegPerSecond > 0 &&
        wrapAnticlockwise.samples[1].cardRateDegPerSecond < 0 &&
        Math.abs(wrapClockwise.finalErrorDeg) <= 0.05 &&
        Math.abs(wrapAnticlockwise.finalErrorDeg) <= 0.05,
      compassSteadyResidualDeg: Math.abs(steady.finalErrorDeg),
      compassSeawayBoundedDeg: round(Math.max(...seawayErrors), 6),
      compassCallerRateInvariant,
      calmRmsCourseErrorDeg: calm.rmsCourseErrorDeg,
      moderateRmsCourseErrorDeg: currentModerate.rmsCourseErrorDeg,
      helmAccuracyInBand:
        calm.rmsCourseErrorDeg <= 2 &&
        currentModerate.rmsCourseErrorDeg <= 5,
      helmHoldsCourseCentred:
        calm.settledSignedMeanErrorDeg !== null &&
        Math.abs(calm.settledSignedMeanErrorDeg) <= 0.6 &&
        currentModerate.settledSignedMeanErrorDeg !== null &&
        Math.abs(currentModerate.settledSignedMeanErrorDeg) <= 0.9,
      nonzeroHumanLatency:
        calm.firstOrderLatencySeconds > 0 &&
        calm.firstInterventionLatencySeconds !== null &&
        calm.firstInterventionLatencySeconds > calm.firstOrderLatencySeconds,
      interventionCadenceInBand:
        calm.interventionsPerMinute >= 1 &&
        calm.interventionsPerMinute <= 20 &&
        currentModerate.interventionsPerMinute >= 1 &&
        currentModerate.interventionsPerMinute <= 24,
      settledCourseDoesNotChatter:
        settledRestarts.length > 0 &&
        settledRestarts.every((seconds) => seconds >= 2.99),
      meaningfulUnchangedTargets:
        calm.maximumUnchangedTargetSeconds >= 2 &&
        currentModerate.maximumUnchangedTargetSeconds >= 1.5,
      correctWatchEaseEpisodes:
        calm.hasCorrectWatchEaseEpisode &&
        currentModerate.hasCorrectWatchEaseEpisode,
      directTakeoverSilent:
        directTakeover.interventionsDuringTakeover === 0 &&
        directTakeover.targetHeldDuringTakeover,
      directReleaseReacquires:
        directTakeover.firstPostReleaseDecisionLatencySeconds !== null &&
        directTakeover.firstPostReleaseDecisionLatencySeconds >= 0.5,
      helmCallerRateInvariant,
      trimWaitsForItsOwnOrder,
      trimEpisodesLeaveObservationGaps,
      trimmedPolarFraction: fromWorkingTrims.polarFraction,
      trimReachesUsefulFraction: trimCases.every(
        (trimCase) => trimCase.polarFraction >= USEFUL_POLAR_FRACTION,
      ),
      trimDoesNotReproduceTheOracle: trimCases.every(
        (trimCase) => meanTrimDifferenceDeg(trimCase) >= MINIMUM_ORACLE_DISTANCE_DEG,
      ),
      trimRecoversBadlySetRig:
        fromBadlySetRig.polarFraction >
        fromBadlySetRig.untrimmedPolarFraction + 0.05,
      strongWindHeelBoundedDeg: inStrongWind.maximumAbsRollDeg,
      cannotDrawIsReportedFromSustainedEvidence,
    },
  };
}

export function validateSailingCrewEvidence(
  evidence: Readonly<SailingCrewEvidence>,
): void {
  const failures = Object.entries(evidence.gates).filter(([, value]) =>
    typeof value === 'boolean' ? !value : false,
  );
  if (failures.length > 0) {
    throw new Error(
      `S5 evidence gates failed: ${failures.map(([name]) => name).join(', ')}`,
    );
  }
  if (evidence.gates.compassSteadyResidualDeg > 0.02) {
    throw new Error(
      `settled compass residual ${evidence.gates.compassSteadyResidualDeg}°`,
    );
  }
  if (evidence.gates.compassSeawayBoundedDeg > 3) {
    throw new Error(
      `seaway compass displacement ${evidence.gates.compassSeawayBoundedDeg}°`,
    );
  }
}

/** Mean distance from the ideal schedule across the sheeted stations. */
function meanTrimDifferenceDeg(trimCase: CrewTrimCase): number {
  const sheets = trimCase.stations.filter(
    (station) => station.station !== 'foreTopsail',
  );
  if (sheets.length === 0) return 0;
  return (
    sheets.reduce((sum, station) => sum + station.trimDifferenceDeg, 0) /
    sheets.length
  );
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
