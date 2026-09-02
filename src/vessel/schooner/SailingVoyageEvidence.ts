import { findSeaState } from '../../ocean/presets';
import { WaveField } from '../../scene/Waves';
import { PlanetaryWorld } from '../../world/PlanetaryWorld';
import { WorldWind } from '../../world/WorldWind';
import { ecefToGeodetic, type GeodeticCoordinates } from '../../world/wgs84';
import {
  trueHeadingForModelYaw,
  type VesselHorizontalDynamicsBridge,
} from '../VesselMotion';
import { EVIDENCE_GEODESIC } from './SchoonerHorizontalDynamicsEvidence';
import { SailingControls } from './SailingControls';
import type { SailName } from './rig';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { SchoonerHorizontalDynamics } from './SchoonerHorizontalDynamics';
import { SchoonerSailForces } from './SchoonerSailForces';
import { FULL_SAIL, type SailSetState } from './sailAero';
import {
  CANVAS_PLANS,
  CANVAS_SAILS,
  canvasPlanAmount,
  canvasPlansAreMonotonic,
  nextCanvasPlanIndex,
} from './crew/CanvasPolicy';
import { SailingCrewSensors, NavigatorSensors } from './crew/CrewObservations';
import { DEFAULT_SAILING_CREW_SEED } from './crew/HumanOperator';
import { SailingCrew } from './crew/SailingCrew';
import type { VoyageEvent } from './crew/Navigator';

/**
 * S6 evidence: scripted voyages, sailed by the crew, exported as JSON.
 *
 * Everything here is a *voyage* — an order given to the navigator and then
 * nobody touching anything until she gets there or the clock runs out. The
 * cases exist to answer four questions with numbers:
 *
 *  1. can she beat to a mark dead to windward, and in how many boards;
 *  2. does she gybe rather than tack when the change is a downwind one;
 *  3. does the canvas policy actually take cloth off her as the wind rises,
 *     monotonically, and does that fix the heel S5 could not (FINDING S5-4);
 *  4. is the whole thing deterministic, and is it independent of the voyage
 *     clock (control on ordinary seconds; only displacement compresses).
 *
 * The fifth question — whether it *reads* right from the deck — is not
 * answerable here and is not claimed.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const PHYSICS_HZ = 240;

export const SAILING_VOYAGE_EVIDENCE_FORMAT_VERSION = 1;

export interface VoyageTraceSample {
  timeSeconds: number;
  latitudeDeg: number;
  longitudeDeg: number;
  trueHeadingDeg: number;
  orderedCourseDeg: number | null;
  distanceToGoM: number;
  speedMps: number;
  rollDeg: number;
  phase: string;
  canvasPlan: string;
  clothAreaM2: number;
  rudderDeg: number;
}

export interface VoyageCase {
  name: string;
  seaStateName: string;
  seed: number;
  callerHz: number;
  voyageSecondsPerRealSecond: number;
  windSpeedMps: number;
  windFromBearingDeg: number;
  gustiness: number;
  initialHeadingDeg: number;
  destinationBearingDeg: number;
  destinationDistanceM: number;
  arrivalRadiusM: number;
  durationSeconds: number;
  /** Physics seconds at which she came inside the arrival radius, or null. */
  arrivedAtSeconds: number | null;
  finalDistanceToGoM: number;
  distanceMadeGoodM: number;
  /** Chart distance actually sailed, the sum of the compressed steps. */
  groundTrackM: number;
  /** Straight-line distance over track sailed; 1 is a course laid and held. */
  trackEfficiency: number;
  tackCount: number;
  gybeCount: number;
  failedEvolutionCount: number;
  deferredTackCount: number;
  completedManeuverCount: number;
  /** Physics seconds from "ready about" to the cloth full on the new board. */
  maneuverDurationsSeconds: number[];
  /** Chart metres covered while an evolution was running. */
  maneuverGroundCostM: number[];
  canvasEvolutionCount: number;
  finalCanvasPlan: string;
  finalCanvas: Record<string, SailSetState>;
  maximumAbsRollDeg: number;
  /**
   * The worst roll over the last two fifths of the run.
   *
   * The plain maximum is the wrong statistic for a canvas question: she starts
   * every case under whatever she was carrying, and the crew take minutes to
   * get cloth off her, so the peak belongs to the rig she *had*. This is the
   * rig she ended up with.
   */
  maximumSettledRollDeg: number;
  meanSpeedMps: number;
  foreTopsailCannotDrawAtSeconds: number | null;
  foreTopsailStruckAtSeconds: number | null;
  foreTopsailAbackSecondsAfterStrike: number;
  /** Everything the navigator did, in his own words. */
  events: VoyageEvent[];
  trace: VoyageTraceSample[];
  /** Order/adjustment/evolution trace, hashed — the determinism handle. */
  controlSignature: string;
}

export interface CanvasSweepPoint {
  windSpeedMps: number;
  planIndex: number;
  planName: string;
  canvasAmount: number;
  canvas: Record<string, SailSetState>;
}

export interface CanvasSweepEvidence {
  points: CanvasSweepPoint[];
  monotonicByPolicy: boolean;
  monotonicBySweep: boolean;
}

export interface HeelReliefCase {
  windSpeedMps: number;
  seaStateName: string;
  durationSeconds: number;
  /** Trimmers only, the S5 situation: every sheet eased and she still lies over. */
  easingOnlyMaximumRollDeg: number;
  easingOnlySettledRollDeg: number;
  easingOnlyFinalPlan: string;
  /** With the canvas policy allowed to take cloth off her. */
  shortenedMaximumRollDeg: number;
  shortenedSettledRollDeg: number;
  shortenedFinalPlan: string;
  shortenedFinalCanvas: Record<string, SailSetState>;
  reliefDeg: number;
}

export interface CompressionInvarianceRun {
  voyageSecondsPerRealSecond: number;
  durationSeconds: number;
  groundTrackM: number;
  encounterDistanceM: number;
  /** Order → cloth settled, physics seconds, for the scripted canvas change. */
  canvasEvolutionSeconds: number[];
  controlSignature: string;
}

export interface CompressionInvarianceEvidence {
  runs: CompressionInvarianceRun[];
  /** The control traces are byte-identical between the two clocks. */
  identicalControlTrace: boolean;
  /** Ground covered scales by exactly the compression ratio. */
  groundRatio: number;
  expectedGroundRatio: number;
  /** Water passed under her is untouched by the voyage clock. */
  encounterDistanceIdentical: boolean;
}

export interface SailingVoyageEvidence {
  formatVersion: number;
  generatedBy: string;
  configuration: {
    physicsHz: number;
    seed: number;
    beatAngleDeg: number;
    traceIntervalSeconds: number;
  };
  voyages: {
    upwind: VoyageCase;
    downwind: VoyageCase;
    /** The same upwind order, sailed with the voyage clock at 30×. */
    upwindCompressed: VoyageCase;
  };
  canvasSweep: CanvasSweepEvidence;
  heelRelief: HeelReliefCase;
  compression: CompressionInvarianceEvidence;
  determinism: {
    /** The upwind voyage, run twice from the same seed. */
    repeatedControlSignature: string;
    identical: boolean;
    callerRateSignatures: Array<{ callerHz: number; signature: string }>;
    callerRateInvariant: boolean;
  };
  gates: {
    /** She fetched the windward mark. */
    upwindVoyageArrives: boolean;
    upwindTackCount: number;
    upwindTackCountBounded: boolean;
    /** Track sailed against straight-line distance; a beat cannot be 1. */
    upwindTrackEfficiency: number;
    upwindTrackEfficiencyInBand: boolean;
    /** The downwind voyage put her stern through the wind, never her bow. */
    downwindGybesNotTacks: boolean;
    downwindGybeCount: number;
    /** The canvas table never sets a sail while shortening. */
    canvasPolicyMonotonic: boolean;
    /** Cloth carried falls strictly as the wind band rises. */
    canvasSweepMonotonic: boolean;
    /** Shortening sail does what easing sheets could not. */
    strongWindHeelReliefDeg: number;
    strongWindHeelRelieved: boolean;
    /** Same seed, same voyage, same trace. */
    voyageReplayDeterministic: boolean;
    voyageCallerRateInvariant: boolean;
    /** Control timing does not move when the voyage clock does. */
    controlTraceCompressionInvariant: boolean;
    displacementScalesWithCompression: boolean;
    /** The square topsail's `cannot draw` report is acted on (FINDING S5-3). */
    cannotDrawIsActedOn: boolean;
    cannotDrawResponseSeconds: number | null;
  };
}

// --- the harness --------------------------------------------------------------

interface VoyageRunOptions {
  name: string;
  seaStateName: string;
  callerHz: number;
  seed: number;
  maxDurationSeconds: number;
  windSpeedMps: number;
  /** Where the wind blows *toward*, the `WorldWind` convention. */
  windDirectionTowardDeg: number;
  gustiness: number;
  voyageSecondsPerRealSecond: number;
  destinationBearingDeg: number;
  destinationDistanceM: number;
  arrivalRadiusM: number;
  initialHeadingDeg: number;
  initialSpeedMps: number;
  initialCanvasIndex: number;
  initialTrimDeg?: Partial<Record<SailName, number>>;
  /**
   * No navigator and no helmsman: a fixed script of control commands instead.
   * Used by the compression case, where the point is that control timing does
   * not depend on where in the world she is.
   */
  script?: (view: ScriptView) => void;
  /** Give the trimmers their standing duty. Default true. */
  trimToDraw?: boolean;
  /** Give the navigator a destination. Default true. */
  navigate?: boolean;
  traceIntervalSeconds?: number;
}

export interface ScriptView {
  readonly timeSeconds: number;
  readonly controls: SailingControls;
  readonly crew: SailingCrew;
}

interface VoyageRunResult {
  case: VoyageCase;
  encounterDistanceM: number;
  canvasEvolutionSeconds: number[];
}

const GEODETIC: GeodeticCoordinates = {
  latitudeRad: 0,
  longitudeRad: 0,
  heightM: 0,
};
const INVERSE = { distanceM: 0, forwardAzimuth1Rad: 0 };
const DIRECT = {
  latitude2Rad: 0,
  longitude2Rad: 0,
  forwardAzimuth2Rad: 0,
};

/** The start position every voyage case is laid out from. */
const START_LATITUDE_DEG = -35;
const START_LONGITUDE_DEG = 138;

function runVoyageCase(options: VoyageRunOptions): VoyageRunResult {
  const sea = findSeaState(options.seaStateName);
  const waves = new WaveField(sea);
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(body.mass, body.inertiaYaw);
  const wind = new WorldWind(0x53365641); // 'S6VA'
  wind.setMean(
    options.windSpeedMps,
    options.windDirectionTowardDeg,
    options.gustiness,
  );
  const sails = new SchoonerSailForces(wind);
  const controls = new SailingControls(options.initialTrimDeg);
  sails.canvas = FULL_SAIL;
  sails.tack = 'starboard';
  sails.attachControls(controls);
  dynamics.externalForces = sails;
  dynamics.helm = controls;

  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 16) / 1000,
    latitudeRad: START_LATITUDE_DEG * DEG_TO_RAD,
    longitudeRad: START_LONGITUDE_DEG * DEG_TO_RAD,
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: options.voyageSecondsPerRealSecond,
    geodesic: EVIDENCE_GEODESIC,
  });

  // Model yaw for the heading she is to start on. Solved rather than asserted:
  // the model-yaw-to-true-heading map is a convention with a sign, and this
  // codebase has burned a round on each of two of those.
  const headingAtZeroYaw = trueHeadingForModelYaw(world.state, 0) * RAD_TO_DEG;
  const headingAtSmallYaw =
    trueHeadingForModelYaw(world.state, 0.05) * RAD_TO_DEG;
  const yawSense = Math.sign(
    wrap180(headingAtSmallYaw - headingAtZeroYaw) / 0.05,
  );
  let yawRad =
    yawSense * wrap180(options.initialHeadingDeg - headingAtZeroYaw) * DEG_TO_RAD;
  const velocity = {
    x: Math.sin(yawRad) * options.initialSpeedMps,
    z: Math.cos(yawRad) * options.initialSpeedMps,
  };
  let yawRateRadPerSecond = 0;
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  // The mark, laid off from the start position on the same figure of the earth
  // the navigator will measure it on.
  EVIDENCE_GEODESIC.direct(
    START_LATITUDE_DEG * DEG_TO_RAD,
    START_LONGITUDE_DEG * DEG_TO_RAD,
    options.destinationBearingDeg * DEG_TO_RAD,
    options.destinationDistanceM,
    DIRECT,
  );
  const destinationLatitudeDeg = DIRECT.latitude2Rad * RAD_TO_DEG;
  const destinationLongitudeDeg = DIRECT.longitude2Rad * RAD_TO_DEG;

  const crew = new SailingCrew(controls, options.seed);
  const sensors = new SailingCrewSensors({
    seed: options.seed,
    headingDegForModelYaw: (modelYaw) =>
      trueHeadingForModelYaw(world.state, modelYaw) * RAD_TO_DEG,
    rudderTargetDeg: () => controls.rudderTargetDeg,
    sailAero: () => sails.lastResult,
    focus: () => crew.focus,
  });
  const position = () => {
    ecefToGeodetic(world.state.positionEcefM, GEODETIC);
    return GEODETIC;
  };
  // The wind's true bearing, taken through the same frame the heading is: a
  // render-frame direction r is the true heading of model yaw (180 − r).
  const trueBearingOfRenderHeading = (renderHeadingDeg: number) =>
    wrap360(
      trueHeadingForModelYaw(world.state, (180 - renderHeadingDeg) * DEG_TO_RAD) *
        RAD_TO_DEG,
    );
  const navigatorSensors = new NavigatorSensors({
    seed: options.seed,
    positionRad: position,
    trueWindSpeedMps: () => wind.instantaneousSpeedMps,
    trueWindFromBearingDeg: () =>
      trueBearingOfRenderHeading(wind.instantaneousDirectionTowardDeg + 180),
    speedThroughWaterMps: () => Math.hypot(velocity.x, velocity.z),
    compassHeadingDeg: () => sensors.compass.readout.indicatedHeadingDeg,
  });

  const scripted = options.script !== undefined;
  dynamics.substepTruthObserver = sensors;
  dynamics.substepCommander = {
    advanceSubstep: (stepSeconds) => {
      navigatorSensors.advance(stepSeconds);
      crew.advanceSubstep(
        stepSeconds,
        sensors.helmObservation,
        (sail) => sensors.sailObservation(sail),
        navigatorSensors.observation,
      );
    },
    reset: () => crew.reset(),
  };
  dynamics.reset();

  if (options.trimToDraw !== false) crew.orderTrimToDraw();
  if (!scripted && options.navigate !== false) {
    crew.orderSailTo(
      EVIDENCE_GEODESIC,
      destinationLatitudeDeg,
      destinationLongitudeDeg,
      {
        arrivalRadiusM: options.arrivalRadiusM,
        initialCanvasIndex: options.initialCanvasIndex,
      },
    );
  }

  const traceIntervalSeconds = options.traceIntervalSeconds ?? 10;
  const trace: VoyageTraceSample[] = [];
  const sampleEverySteps = Math.round(traceIntervalSeconds * PHYSICS_HZ);
  let stepCount = 0;
  let groundTrackM = 0;
  let encounterDistanceM = 0;
  let maximumAbsRollDeg = 0;
  // Worst roll per five-second bucket, so the settled window can be taken
  // against the run's *actual* length. A window fixed from the duration cap
  // would be empty for every case that ends early by fetching its mark, and
  // would then report a settled roll of zero — a number that looks measured
  // and is not.
  const rollBucketMaxDeg: number[] = [];
  const ROLL_BUCKET_SECONDS = 5;
  let speedSum = 0;
  let speedSamples = 0;
  let arrivedAtSeconds: number | null = null;
  let finalDistanceToGoM = Infinity;
  let initialDistanceToGoM = options.destinationDistanceM;
  let foreTopsailCannotDrawAtSeconds: number | null = null;
  let foreTopsailStruckAtSeconds: number | null = null;
  let foreTopsailAbackSecondsAfterStrike = 0;
  const maneuverGroundAtStart = new Map<number, number>();
  const maneuverGroundCostM: number[] = [];
  const maneuverDurationsSeconds: number[] = [];
  let seenManeuvers = 0;

  const distanceToGo = (): number => {
    const fix = position();
    EVIDENCE_GEODESIC.inverse(
      fix.latitudeRad,
      fix.longitudeRad,
      destinationLatitudeDeg * DEG_TO_RAD,
      destinationLongitudeDeg * DEG_TO_RAD,
      INVERSE,
    );
    return INVERSE.distanceM;
  };

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
    ) {
      stepCount++;
      const advanced = world.advanceTangentMotionStep(
        physicsDeltaSeconds,
        displacementX,
        -displacementZ,
        endVelocityX,
        -endVelocityZ,
      );
      groundTrackM += advanced.distanceTravelledM;
      encounterDistanceM += advanced.encounterDistanceM;
      const timeSeconds = stepCount / PHYSICS_HZ;
      const rollDeg = body.roll * RAD_TO_DEG;
      maximumAbsRollDeg = Math.max(maximumAbsRollDeg, Math.abs(rollDeg));
      const bucket = Math.floor(timeSeconds / ROLL_BUCKET_SECONDS);
      rollBucketMaxDeg[bucket] = Math.max(
        rollBucketMaxDeg[bucket] ?? 0,
        Math.abs(rollDeg),
      );
      speedSum += Math.hypot(endVelocityX, endVelocityZ);
      speedSamples++;

      const readout = crew.readout();
      const topsail = readout.trimmers.stations.find(
        (station) => station.station === 'foreTopsail',
      );
      if (
        topsail?.cannotDraw &&
        foreTopsailCannotDrawAtSeconds === null
      ) {
        foreTopsailCannotDrawAtSeconds = timeSeconds;
      }
      if (
        foreTopsailStruckAtSeconds === null &&
        controls.targetSetState('foreTopsail') === 'furled'
      ) {
        foreTopsailStruckAtSeconds = timeSeconds;
      }
      if (foreTopsailStruckAtSeconds !== null) {
        const force = sails.lastResult.perSail.find(
          (entry) => entry.name === 'foreTopsail',
        );
        // Aback: cloth still up and meeting the wind on its front face.
        if (force && force.active && force.aoaDeg < 0) {
          foreTopsailAbackSecondsAfterStrike += physicsDeltaSeconds;
        }
      }

      const maneuvers = readout.helmsman.maneuvers;
      for (let i = seenManeuvers; i < maneuvers.length; i++) {
        maneuverGroundAtStart.set(i, groundTrackM);
      }
      seenManeuvers = maneuvers.length;
      for (let i = 0; i < maneuvers.length; i++) {
        const maneuver = maneuvers[i];
        if (
          maneuver.finishedAtSeconds !== null &&
          maneuverGroundAtStart.has(i)
        ) {
          const startGround = maneuverGroundAtStart.get(i)!;
          maneuverGroundAtStart.delete(i);
          maneuverGroundCostM.push(round(groundTrackM - startGround, 3));
          maneuverDurationsSeconds.push(
            round(maneuver.finishedAtSeconds - maneuver.startedAtSeconds, 4),
          );
        }
      }

      // Arrival is watched every substep, not on the trace's sampling beat:
      // the run stops the moment she fetches the mark, and a flag only written
      // on sample boundaries missed it every time.
      if (arrivedAtSeconds === null && readout.navigator?.phase === 'arrived') {
        arrivedAtSeconds = timeSeconds;
      }
      if (stepCount % sampleEverySteps === 0 || stepCount === 1) {
        const fix = position();
        const remaining = distanceToGo();
        finalDistanceToGoM = remaining;
        if (stepCount === 1) initialDistanceToGoM = remaining;
        trace.push({
          timeSeconds: round(timeSeconds, 3),
          latitudeDeg: round(fix.latitudeRad * RAD_TO_DEG, 7),
          longitudeDeg: round(fix.longitudeRad * RAD_TO_DEG, 7),
          trueHeadingDeg: round(
            trueHeadingForModelYaw(world.state, endYawRad) * RAD_TO_DEG,
            3,
          ),
          orderedCourseDeg: readout.helmsman.orderedCourseDeg,
          distanceToGoM: round(remaining, 2),
          speedMps: round(Math.hypot(endVelocityX, endVelocityZ), 4),
          rollDeg: round(rollDeg, 3),
          phase: readout.navigator?.phase ?? 'scripted',
          canvasPlan: readout.canvas.planName ?? 'as found',
          clothAreaM2: round(sails.lastResult.activeClothAreaM2, 2),
          rudderDeg: round(controls.rudderAngleDeg, 2),
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
  const callerFrames = Math.round(
    options.maxDurationSeconds * options.callerHz,
  );
  let durationSeconds = options.maxDurationSeconds;
  for (let frame = 0; frame < callerFrames; frame++) {
    if (options.script) {
      options.script({
        timeSeconds: frame / options.callerHz,
        controls,
        crew,
      });
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
    if (crew.readout().navigator?.phase === 'arrived') {
      durationSeconds = (frame + 1) / options.callerHz;
      break;
    }
  }

  const readout = crew.readout();
  const navigator = readout.navigator;
  const canvasReadout = readout.canvas;
  const canvasEvolutionSeconds: number[] = [];
  for (const station of canvasReadout.stations) {
    for (const evolution of station.evolutions) {
      if (evolution.settledAtSeconds !== null) {
        canvasEvolutionSeconds.push(
          round(evolution.settledAtSeconds - evolution.startedAtSeconds, 6),
        );
      }
    }
  }
  const finalCanvas: Record<string, SailSetState> = {};
  for (const sail of CANVAS_SAILS) {
    finalCanvas[sail] = controls.targetSetState(sail);
  }
  finalDistanceToGoM = distanceToGo();
  const settledFromBucket = Math.floor(
    (durationSeconds * 0.6) / ROLL_BUCKET_SECONDS,
  );
  let maximumSettledRollDeg = 0;
  for (let bucket = settledFromBucket; bucket < rollBucketMaxDeg.length; bucket++) {
    maximumSettledRollDeg = Math.max(
      maximumSettledRollDeg,
      rollBucketMaxDeg[bucket] ?? 0,
    );
  }

  return {
    encounterDistanceM: round(encounterDistanceM, 6),
    canvasEvolutionSeconds,
    case: {
      name: options.name,
      seaStateName: options.seaStateName,
      seed: options.seed,
      callerHz: options.callerHz,
      voyageSecondsPerRealSecond: options.voyageSecondsPerRealSecond,
      windSpeedMps: options.windSpeedMps,
      windFromBearingDeg: wrap360(options.windDirectionTowardDeg + 180),
      gustiness: options.gustiness,
      initialHeadingDeg: options.initialHeadingDeg,
      destinationBearingDeg: options.destinationBearingDeg,
      destinationDistanceM: options.destinationDistanceM,
      arrivalRadiusM: options.arrivalRadiusM,
      durationSeconds: round(durationSeconds, 3),
      arrivedAtSeconds:
        arrivedAtSeconds === null ? null : round(arrivedAtSeconds, 3),
      finalDistanceToGoM: round(finalDistanceToGoM, 2),
      distanceMadeGoodM: round(initialDistanceToGoM - finalDistanceToGoM, 2),
      groundTrackM: round(groundTrackM, 6),
      trackEfficiency: round(
        groundTrackM > 0
          ? (initialDistanceToGoM - finalDistanceToGoM) / groundTrackM
          : 0,
        5,
      ),
      tackCount: navigator?.tackCount ?? 0,
      gybeCount: navigator?.gybeCount ?? 0,
      failedEvolutionCount: navigator?.failedEvolutionCount ?? 0,
      deferredTackCount: navigator?.deferredTackCount ?? 0,
      completedManeuverCount: readout.helmsman.maneuvers.filter(
        (maneuver) => maneuver.phase === 'complete',
      ).length,
      maneuverDurationsSeconds,
      maneuverGroundCostM,
      canvasEvolutionCount: canvasReadout.evolutionCount,
      finalCanvasPlan: navigator?.canvasPlanName ?? (canvasReadout.planName ?? 'as found'),
      finalCanvas,
      maximumAbsRollDeg: round(maximumAbsRollDeg, 3),
      maximumSettledRollDeg: round(maximumSettledRollDeg, 3),
      meanSpeedMps: round(speedSamples > 0 ? speedSum / speedSamples : 0, 4),
      foreTopsailCannotDrawAtSeconds:
        foreTopsailCannotDrawAtSeconds === null
          ? null
          : round(foreTopsailCannotDrawAtSeconds, 3),
      foreTopsailStruckAtSeconds:
        foreTopsailStruckAtSeconds === null
          ? null
          : round(foreTopsailStruckAtSeconds, 3),
      foreTopsailAbackSecondsAfterStrike: round(
        foreTopsailAbackSecondsAfterStrike,
        3,
      ),
      events: (navigator?.events ?? []).map((event) => ({
        ...event,
        timeSeconds: round(event.timeSeconds, 3),
        distanceToGoM:
          event.distanceToGoM === null ? null : round(event.distanceToGoM, 1),
        courseDeg: event.courseDeg === null ? null : round(event.courseDeg, 2),
      })),
      trace,
      controlSignature: controlSignature(crew),
    },
  };
}

/**
 * Everything the crew commanded, in order, as one string.
 *
 * Deliberately built from *commands*, not from vessel state: two runs that
 * agree here made the same decisions at the same instants, which is what
 * determinism means for a control layer.
 */
function controlSignature(crew: SailingCrew): string {
  const readout = crew.readout();
  const parts: string[] = [];
  for (const intervention of readout.helmsman.interventions) {
    parts.push(
      `H${round(intervention.executeAtSeconds, 6)}:` +
        `${intervention.requestedRudderDeg}:${intervention.reason}`,
    );
  }
  for (const maneuver of readout.helmsman.maneuvers) {
    parts.push(
      `M${round(maneuver.startedAtSeconds, 6)}:${maneuver.kind}:` +
        `${maneuver.entrySide}:${maneuver.phase}:` +
        `${maneuver.finishedAtSeconds === null ? 'open' : round(maneuver.finishedAtSeconds, 6)}`,
    );
  }
  for (const station of readout.trimmers.stations) {
    for (const adjustment of station.adjustments) {
      parts.push(
        `T${round(adjustment.executeAtSeconds, 6)}:${station.station}:` +
          `${adjustment.decision}:${round(adjustment.requestedTrimDeg, 6)}`,
      );
    }
  }
  for (const station of readout.canvas.stations) {
    for (const evolution of station.evolutions) {
      parts.push(
        `C${round(evolution.startedAtSeconds, 6)}:${station.sail}:` +
          `${evolution.from}>${evolution.to}`,
      );
    }
  }
  parts.sort();
  return parts.join('|');
}

// --- the canvas sweep and the heel it buys ------------------------------------

export function buildCanvasSweepEvidence(): CanvasSweepEvidence {
  const points: CanvasSweepPoint[] = [];
  let index = 0;
  for (let windSpeedMps = 2; windSpeedMps <= 20; windSpeedMps += 1) {
    // Walked upward through the bands exactly as a rising day would walk it,
    // so the sweep tests the policy's own hysteresis rather than a lookup.
    index = nextCanvasPlanIndex(index, windSpeedMps);
    const plan = CANVAS_PLANS[index];
    const canvas: Record<string, SailSetState> = {};
    for (const sail of CANVAS_SAILS) canvas[sail] = plan.canvas[sail];
    points.push({
      windSpeedMps,
      planIndex: index,
      planName: plan.name,
      canvasAmount: canvasPlanAmount(plan.canvas),
      canvas,
    });
  }
  let monotonicBySweep = true;
  for (let i = 1; i < points.length; i++) {
    if (points[i].canvasAmount > points[i - 1].canvasAmount) {
      monotonicBySweep = false;
    }
    if (points[i].planIndex < points[i - 1].planIndex) monotonicBySweep = false;
  }
  return {
    points,
    monotonicByPolicy: canvasPlansAreMonotonic(),
    monotonicBySweep,
  };
}

/**
 * S5's FINDING S5-4, put to the question.
 *
 * The same sixteen metres a second, the same sea, the same hands on the same
 * sheets — the only difference is whether anyone is allowed to take cloth off
 * her. S5 measured 30.7° of roll with the sheets at their stops and called it
 * out of the trimmers' authority. This measures what the authority is worth.
 */
function buildHeelRelief(seed: number): HeelReliefCase {
  const windSpeedMps = 16;
  const durationSeconds = 300;
  const common = {
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed,
    maxDurationSeconds: durationSeconds,
    windSpeedMps,
    windDirectionTowardDeg: 90,
    gustiness: 0,
    voyageSecondsPerRealSecond: 1,
    destinationBearingDeg: 180,
    destinationDistanceM: 200_000,
    arrivalRadiusM: 250,
    initialHeadingDeg: 180,
    initialSpeedMps: 3.2,
    initialCanvasIndex: 0,
    traceIntervalSeconds: 30,
  };
  const easingOnly = runVoyageCase({
    ...common,
    name: 'strong wind, sheets only',
    navigate: false,
  });
  const shortened = runVoyageCase({
    ...common,
    name: 'strong wind, canvas policy',
  });
  return {
    windSpeedMps,
    seaStateName: common.seaStateName,
    durationSeconds,
    easingOnlyMaximumRollDeg: easingOnly.case.maximumAbsRollDeg,
    easingOnlySettledRollDeg: easingOnly.case.maximumSettledRollDeg,
    easingOnlyFinalPlan: easingOnly.case.finalCanvasPlan,
    shortenedMaximumRollDeg: shortened.case.maximumAbsRollDeg,
    shortenedSettledRollDeg: shortened.case.maximumSettledRollDeg,
    shortenedFinalPlan: shortened.case.finalCanvasPlan,
    shortenedFinalCanvas: shortened.case.finalCanvas,
    // Settled against settled: both runs begin under all plain sail, and the
    // first two minutes of the shortened run are the crew getting cloth off
    // her. Comparing peak against peak would compare the rig they shared.
    reliefDeg: round(
      easingOnly.case.maximumSettledRollDeg -
        shortened.case.maximumSettledRollDeg,
      3,
    ),
  };
}

// --- the voyage clock ---------------------------------------------------------

/**
 * The compression invariant, asserted where it can be asserted exactly.
 *
 * The script is fixed — a rudder command and a shorten-sail order at named
 * instants — and the trimmers work their sheets from what the cloth is doing.
 * None of that reads the vessel's position, so the two runs are *identical*
 * control traces, and the only thing the voyage clock changes is how much
 * chart the same water covers.
 *
 * The helmsman is deliberately not in this case: his compass reading is a
 * function of where on the earth she is, so at 30× he is genuinely somewhere
 * else and steers differently. That is the invariant working, not failing —
 * displacement compresses, and nothing else does.
 */
export function buildCompressionInvarianceEvidence(
  seed: number,
): CompressionInvarianceEvidence {
  const durationSeconds = 200;
  const run = (voyageSecondsPerRealSecond: number): CompressionInvarianceRun => {
    let orderedCanvas = false;
    let putHelmOver = false;
    const result = runVoyageCase({
      name: `compression ${voyageSecondsPerRealSecond}x`,
      seaStateName: 'CURRENT_MODERATE',
      callerHz: 60,
      seed,
      maxDurationSeconds: durationSeconds,
      windSpeedMps: 8,
      windDirectionTowardDeg: 90,
      gustiness: 0,
      voyageSecondsPerRealSecond,
      destinationBearingDeg: 180,
      destinationDistanceM: 500_000,
      arrivalRadiusM: 250,
      initialHeadingDeg: 180,
      initialSpeedMps: 3.2,
      initialCanvasIndex: 0,
      traceIntervalSeconds: 50,
      script: (view) => {
        if (!putHelmOver && view.timeSeconds >= 30) {
          putHelmOver = true;
          view.controls.commandRudderDeg(-6);
        }
        if (!orderedCanvas && view.timeSeconds >= 60) {
          orderedCanvas = true;
          view.crew.orderCanvas(
            CANVAS_PLANS[3].name,
            CANVAS_PLANS[3].canvas,
          );
        }
      },
    });
    return {
      voyageSecondsPerRealSecond,
      durationSeconds,
      groundTrackM: result.case.groundTrackM,
      encounterDistanceM: result.encounterDistanceM,
      canvasEvolutionSeconds: result.canvasEvolutionSeconds,
      controlSignature: result.case.controlSignature,
    };
  };
  const runs = [run(1), run(30)];
  return {
    runs,
    identicalControlTrace:
      runs[0].controlSignature === runs[1].controlSignature &&
      JSON.stringify(runs[0].canvasEvolutionSeconds) ===
        JSON.stringify(runs[1].canvasEvolutionSeconds),
    groundRatio: round(runs[1].groundTrackM / Math.max(runs[0].groundTrackM, 1e-9), 9),
    expectedGroundRatio: 30,
    encounterDistanceIdentical:
      runs[0].encounterDistanceM === runs[1].encounterDistanceM,
  };
}

// --- assembly ------------------------------------------------------------------

export function buildSailingVoyageEvidence(): SailingVoyageEvidence {
  const seed = DEFAULT_SAILING_CREW_SEED;

  // Wind blows toward 090, so it is a wind FROM 270. The mark lies dead into
  // it: nothing about this voyage can be sailed on one board.
  const upwind = runVoyageCase({
    name: 'beat to a mark dead to windward in wind chop',
    seaStateName: 'WIND_CHOP',
    callerHz: 60,
    seed,
    maxDurationSeconds: 1500,
    windSpeedMps: 9,
    windDirectionTowardDeg: 90,
    gustiness: 0.45,
    voyageSecondsPerRealSecond: 5,
    destinationBearingDeg: 270,
    destinationDistanceM: 4000,
    arrivalRadiusM: 300,
    initialHeadingDeg: 215,
    initialSpeedMps: 3.2,
    initialCanvasIndex: 0,
  }).case;

  const upwindCompressed = runVoyageCase({
    name: 'the same beat with the voyage clock at thirty',
    seaStateName: 'WIND_CHOP',
    callerHz: 60,
    seed,
    maxDurationSeconds: 1500,
    windSpeedMps: 9,
    windDirectionTowardDeg: 90,
    gustiness: 0.45,
    voyageSecondsPerRealSecond: 30,
    destinationBearingDeg: 270,
    destinationDistanceM: 24_000,
    // A tack takes the crew fifty seconds whatever the voyage clock says, and
    // at thirty times it costs her better than a mile of chart while she is
    // doing it. "Close enough" cannot be tighter than what an evolution
    // costs, and this is that number rounded up.
    arrivalRadiusM: 2500,
    initialHeadingDeg: 215,
    initialSpeedMps: 3.2,
    initialCanvasIndex: 0,
  }).case;

  // A downwind passage that changes sides: she starts broad on the starboard
  // gybe and the mark lies broad on the other one, so the only way there is
  // to bring the stern through the wind.
  const downwind = runVoyageCase({
    name: 'a downwind passage that crosses the wind astern',
    seaStateName: 'CURRENT_MODERATE',
    callerHz: 60,
    seed,
    maxDurationSeconds: 900,
    windSpeedMps: 8,
    windDirectionTowardDeg: 90,
    gustiness: 0.1,
    voyageSecondsPerRealSecond: 5,
    destinationBearingDeg: 40,
    destinationDistanceM: 4000,
    arrivalRadiusM: 300,
    initialHeadingDeg: 140,
    initialSpeedMps: 3.2,
    initialCanvasIndex: 0,
  }).case;

  // The replay and caller-rate cases are the opening five minutes of the same
  // beat rather than the whole of it: a trace that agrees for three hundred
  // seconds through a canvas change, a strike and a tack has agreed about
  // everything the layer does, and the full voyage is the expensive part.
  const replayCase = (callerHz: number) =>
    runVoyageCase({
      name: `the beat's first five minutes at ${callerHz} Hz`,
      seaStateName: 'WIND_CHOP',
      callerHz,
      seed,
      maxDurationSeconds: 300,
      windSpeedMps: 9,
      windDirectionTowardDeg: 90,
      gustiness: 0.45,
      voyageSecondsPerRealSecond: 5,
      destinationBearingDeg: 270,
      destinationDistanceM: 4000,
      arrivalRadiusM: 300,
      initialHeadingDeg: 215,
      initialSpeedMps: 3.2,
      initialCanvasIndex: 0,
      traceIntervalSeconds: 60,
    }).case.controlSignature;

  const callerRateSignatures = [30, 60, 120].map((callerHz) => ({
    callerHz,
    signature: replayCase(callerHz),
  }));
  const repeatedSignature = replayCase(60);
  const referenceSignature = callerRateSignatures[1].signature;

  const canvasSweep = buildCanvasSweepEvidence();
  const heelRelief = buildHeelRelief(seed);
  const compression = buildCompressionInvarianceEvidence(seed);

  const cannotDrawResponseSeconds =
    upwind.foreTopsailCannotDrawAtSeconds !== null &&
    upwind.foreTopsailStruckAtSeconds !== null
      ? round(
          upwind.foreTopsailStruckAtSeconds -
            upwind.foreTopsailCannotDrawAtSeconds,
          3,
        )
      : null;

  return {
    formatVersion: SAILING_VOYAGE_EVIDENCE_FORMAT_VERSION,
    generatedBy: 'src/vessel/schooner/SailingVoyageEvidence.ts',
    configuration: {
      physicsHz: PHYSICS_HZ,
      seed,
      beatAngleDeg: 55,
      traceIntervalSeconds: 10,
    },
    voyages: { upwind, downwind, upwindCompressed },
    canvasSweep,
    heelRelief,
    compression,
    determinism: {
      repeatedControlSignature: repeatedSignature,
      identical: repeatedSignature === referenceSignature,
      callerRateSignatures,
      callerRateInvariant: callerRateSignatures.every(
        (entry) => entry.signature === callerRateSignatures[0].signature,
      ),
    },
    gates: {
      upwindVoyageArrives: upwind.arrivedAtSeconds !== null,
      upwindTackCount: upwind.tackCount,
      upwindTackCountBounded: upwind.tackCount >= 1 && upwind.tackCount <= 14,
      upwindTrackEfficiency: upwind.trackEfficiency,
      upwindTrackEfficiencyInBand:
        upwind.trackEfficiency > 0.3 && upwind.trackEfficiency < 0.85,
      downwindGybesNotTacks:
        downwind.gybeCount >= 1 && downwind.tackCount === 0,
      downwindGybeCount: downwind.gybeCount,
      canvasPolicyMonotonic: canvasSweep.monotonicByPolicy,
      canvasSweepMonotonic: canvasSweep.monotonicBySweep,
      strongWindHeelReliefDeg: heelRelief.reliefDeg,
      strongWindHeelRelieved: heelRelief.reliefDeg >= 4,
      voyageReplayDeterministic: repeatedSignature === referenceSignature,
      voyageCallerRateInvariant: callerRateSignatures.every(
        (entry) => entry.signature === callerRateSignatures[0].signature,
      ),
      controlTraceCompressionInvariant: compression.identicalControlTrace,
      displacementScalesWithCompression:
        Math.abs(compression.groundRatio - 30) < 1e-6 &&
        compression.encounterDistanceIdentical,
      cannotDrawIsActedOn:
        upwind.foreTopsailCannotDrawAtSeconds !== null &&
        upwind.foreTopsailStruckAtSeconds !== null &&
        upwind.foreTopsailStruckAtSeconds >=
          upwind.foreTopsailCannotDrawAtSeconds,
      cannotDrawResponseSeconds,
    },
  };
}

/** Throw on any failed gate. The exporter calls this before it writes. */
export function validateSailingVoyageEvidence(
  evidence: SailingVoyageEvidence,
): void {
  const { gates } = evidence;
  const failures: string[] = [];
  if (!gates.canvasPolicyMonotonic) {
    failures.push('the canvas plan table is not monotonic');
  }
  if (!gates.canvasSweepMonotonic) {
    failures.push('a rising wind did not shorten sail monotonically');
  }
  if (!gates.upwindVoyageArrives) {
    failures.push(
      `the upwind voyage did not fetch the mark: ` +
        `${evidence.voyages.upwind.finalDistanceToGoM} m short`,
    );
  }
  if (!gates.upwindTackCountBounded) {
    failures.push(`upwind tack count ${gates.upwindTackCount} out of bounds`);
  }
  if (!gates.upwindTrackEfficiencyInBand) {
    failures.push(
      `upwind track efficiency ${gates.upwindTrackEfficiency} out of band`,
    );
  }
  if (!gates.downwindGybesNotTacks) {
    failures.push(
      `the downwind passage used ${evidence.voyages.downwind.tackCount} tacks ` +
        `and ${gates.downwindGybeCount} gybes`,
    );
  }
  if (!gates.strongWindHeelRelieved) {
    failures.push(
      `shortening sail bought only ${gates.strongWindHeelReliefDeg}° of heel`,
    );
  }
  if (!gates.voyageReplayDeterministic) {
    failures.push('the same voyage from the same seed produced a different trace');
  }
  if (!gates.voyageCallerRateInvariant) {
    failures.push('caller rate changed the control trace');
  }
  if (!gates.controlTraceCompressionInvariant) {
    failures.push('the voyage clock moved the control trace');
  }
  if (!gates.displacementScalesWithCompression) {
    failures.push(
      `displacement scaled by ${evidence.compression.groundRatio}, not 30`,
    );
  }
  if (!gates.cannotDrawIsActedOn) {
    failures.push('a sail reported it could not draw and nothing acted on it');
  }
  if (failures.length > 0) {
    throw new Error(`S6 voyage gates failed:\n  - ${failures.join('\n  - ')}`);
  }
}

function wrap180(deg: number): number {
  let wrapped = ((deg % 360) + 540) % 360;
  wrapped -= 180;
  return wrapped;
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function round(value: number, digits = 6): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}
