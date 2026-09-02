import { findSeaState } from '../../ocean/presets';
import { whitecapCoverage } from '../../ocean/spectrum';
import { foamFieldAdvectionStep } from '../../scene/FoamField';
import {
  createWetHullBandProfile,
  updateWetHullBandProfile,
  type WetHullBandProfile,
} from '../../scene/HullWetBand';
import { WaveField } from '../../scene/Waves';
import {
  HullSprayEventDetector,
  type HullSprayEventInput,
} from '../../scene/hullSprayEvents';
import { RAFT_OVERTOP_SPRAY } from '../../scene/OvertopSpray';
import {
  createWakeBowPolicyResult,
  createWakeTrailPolicyResult,
  overtopEventStrength,
  overtopReferencesFromFreeboard,
  resolveWakeBowPolicy,
  resolveWakeTrailPolicy,
  SPRAY_ARM_DRIVE_CALM,
  SPRAY_ARM_DRIVE_ROUGH,
  SPRAY_ENTRY_POWER_REFERENCE_W,
  SPRAY_MINIMUM_INTERVAL_SECONDS,
  SPRAY_RELEASE_FRACTION,
  SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX,
  SPRAY_TEAR_MAX_SECONDS,
  SPRAY_WAY_ONSET_MPS,
  WAKE_POLICY_HULL_SPEED_MPS,
  type WakeBowPolicyResult,
  type WakeTrailPolicyResult,
} from '../../scene/wakePolicy';
import { PHYSICS_STEP } from '../BuoyantBody';
import type { LongitudinalContactRegion } from '../HullWaterContact';
import { WakeSources } from '../WakeSources';
import { solveEquilibrium } from './SailingPolarEvidence';
import {
  FULL_SAIL,
  WORKING_SAIL,
  type CanvasState,
} from './sailAero';
import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';

/** 6 since WK3: every case grew a `sprayEvents` block and an `overtopping.cue`. */
export const WAKE_CONTACT_EVIDENCE_FORMAT_VERSION = 6;

const CALLER_HZ = 60;
const WARMUP_SECONDS = 30;
const MEASUREMENT_SECONDS = 60;
const SOURCE_SAMPLE_HZ = 1;
const POLAR_WIND_ANGLE_OFF_BOW_DEG = 90;
const ENTRY_SPEED_BINS_MPS = [
  0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8,
] as const;

const REGIONS: readonly LongitudinalContactRegion[] = [
  'bow',
  'midships',
  'stern',
];

interface ReferenceState {
  seaStateName: string;
  canvasName: 'FULL_SAIL' | 'WORKING_SAIL';
  canvas: CanvasState;
}

const REFERENCE_STATES: readonly ReferenceState[] = [
  {
    seaStateName: 'GLASSY_LONG_SWELL',
    canvasName: 'FULL_SAIL',
    canvas: FULL_SAIL,
  },
  {
    seaStateName: 'CURRENT_MODERATE',
    canvasName: 'FULL_SAIL',
    canvas: FULL_SAIL,
  },
  {
    seaStateName: 'SOUTHERN_OCEAN_ROUGH',
    canvasName: 'WORKING_SAIL',
    canvas: WORKING_SAIL,
  },
];

export interface WakePolarReference {
  seaStateName: string;
  windSpeedMps: number;
  windAngleOffBowDeg: number;
  tack: 'starboard';
  canvas: 'FULL_SAIL' | 'WORKING_SAIL';
  speedMps: number;
  leewayDeg: number;
  balanceRudderDeg: number | null;
}

export interface WakeContactCaseConfig {
  name: string;
  seaStateName: string;
  speedMps: number;
  leewayDeg: number;
  polarReference?: WakePolarReference;
  /**
   * Where the wind lies relative to her bow. 90 is the beam reach every WK0–WK2
   * reference uses; WK3's overtop sizing case needs another heading, because
   * the detector turns out to be dominated by encounter geometry rather than by
   * sea severity (see the WK3 handover section).
   */
  windAngleOffBowDeg?: number;
}

interface EvidenceTiming {
  warmupSeconds: number;
  measurementSeconds: number;
  callerHz: number;
  sourceSampleHz: number;
}

interface EntrySpeedSummary {
  samples: number;
  meanMps: number | null;
  rmsMps: number | null;
  p50Mps: number | null;
  p90Mps: number | null;
  p95Mps: number | null;
  p99Mps: number | null;
  maxMps: number | null;
  histogram: Array<{ upperBoundMps: number | null; count: number }>;
}

interface CrossingAccumulator {
  activations: number;
  deactivations: number;
  activePointSamples: number;
}

interface OvertopAccumulator {
  eventSamples: number;
  framesWithEvents: number;
  maximumEventsInFrame: number;
  peakSpeedMps: number;
  peakDepthM: number;
  /** Samples whose freeboard-relative strength clears the cue's 0.30 gate. */
  drawnSamples: number;
  peakStrength: number;
  strengthSum: number;
}

/**
 * WK3's entry-tear measurement for one case.
 *
 * `tears` is the event count the round's rate gate is about. `dropletsShed` is
 * what the particle pool would actually have been asked for, which is the other
 * bound: an event rate that is in range while each event asks for a thousand
 * droplets is not bounded in any sense that matters.
 */
export interface WakeSprayEventSummary {
  tears: number;
  tearsPerSecond: number;
  /** The policy's own ceiling for this case. `tearsPerSecond` must not exceed it. */
  ceilingPerSecond: number;
  framesShedding: number;
  dropletsShed: number;
  dropletsPerSecond: number;
  /** Long-run droplet bound the policy guarantees. */
  dropletCeilingPerSecond: number;
  peakDrive: number;
  p95Drive: number;
  armThreshold: number;
  wayGate: number;
  seaMask: number;
  peakBowImmersionRateM3PerSec: number;
  peakEntryPowerW: number;
}

export interface WakeContactCaseEvidence {
  name: string;
  seaStateName: string;
  seed: number;
  windSpeedMps: number;
  prescribedMotion: {
    speedMps: number;
    leewayDeg: number;
    modelYawRad: number;
    encounterVelocityWorldMps: { x: number; z: number };
    polarReference: WakePolarReference | null;
  };
  waterlineCrossings: Record<
    LongitudinalContactRegion,
    {
      activations: number;
      deactivations: number;
      transitionsPerSecond: number;
      meanActivePointsPerFrame: number;
    }
  >;
  entrySpeeds: Record<LongitudinalContactRegion, EntrySpeedSummary>;
  overtopping: {
    eventSamples: number;
    eventSamplesPerSecond: number;
    framesWithEvents: number;
    frameFraction: number;
    maximumEventsInFrame: number;
    peakSpeedMps: number;
    peakDepthM: number;
    contactSamplesByRegion: Record<LongitudinalContactRegion, number>;
    /** WK3: what the cue makes of those events at this vessel's freeboard. */
    cue: {
      depthReferenceM: number;
      speedReferenceMps: number;
      peakStrength: number;
      meanStrength: number | null;
      /** Samples above the 0.30 gate. Zero means the cue draws nothing here. */
      drawnSamples: number;
    };
  };
  /** WK3: the bow-entry tears this case produced. */
  sprayEvents: WakeSprayEventSummary;
  sourceSeries: WakeSourceSample[];
  maximumWaveInverseSolveResidualM: number;
}

export interface WakeSourceSample {
  timeSeconds: number;
  sternWaterline: {
    active: boolean;
    stationIndex: number;
    widthM: number;
    port: [number, number, number];
    starboard: [number, number, number];
  };
  bowWaterline: {
    pointCount: number;
    centroid: [number, number, number] | null;
    port: WakeWaterlineSideExtent;
    starboard: WakeWaterlineSideExtent;
  };
  regions: Record<
    LongitudinalContactRegion,
    {
      wetStationCount: number;
      waterlinePointCount: number;
      meanEntrySpeedMps: number;
      peakEntrySpeedMps: number;
    }
  >;
  /** Exact WK1 policy and transport resolved from this sampled stern cut. */
  trailInjection: WakeTrailInjectionSample;
  /** Exact WK2 collar policy resolved from the active bow-side points. */
  bowInjection: WakeBowInjectionSample;
  /** Contact-derived hull-local profile consumed by the wet-shell shader. */
  wetHullBand: WakeWetHullBandSample;
  activeOvertopEventCount: number;
}

export interface WakeTrailInjectionSample {
  sourceEnabled: boolean;
  sourceCentreXZ: [number, number] | null;
  sourceRadiusM: number;
  fieldTransportMps: [number, number];
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
  turbulenceTauSeconds: number;
  bubbleHaze: number;
  whitecapSuppression: number;
  seaMask: number;
}

export interface WakeBowInjectionSample {
  sourceEnabled: boolean;
  /** Actual bow-side intersections driving the collar policy. */
  pointCount: number;
  /** Matched full-hull cuts uploaded as two continuous side polylines. */
  waterlineStationCount: number;
  collarDrive: number;
  sourceRadiusM: number;
  /** Collar smear, astern along the track. Was `windTearM` before WK-R5. */
  tearM: [number, number];
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
  moundNormalStrength: number;
  moundAcrossRadiusM: number;
  moundAlongRadiusM: number;
  seaMask: number;
}

export interface WakeWetHullBandSample {
  profileSampleCount: number;
  stationIndices: number[];
  resolvedLocalYRangeM: [number, number] | null;
  heightM: number;
  darkening: number;
  roughnessScale: number;
}

export interface WakeBowCollarCurvePoint {
  speedMps: number;
  collarDrive: number;
  activeFoamRatePerSecond: number;
  residualFoamRatePerSecond: number;
  turbulenceRatePerSecond: number;
}

interface WakeWaterlineSideExtent {
  aftStationIndex: number;
  forwardStationIndex: number;
  aft: [number, number, number] | null;
  forward: [number, number, number] | null;
}

export interface WakeContactEvidence {
  formatVersion: number;
  status: string;
  contract: {
    method: string;
    scope: string;
    interpretation: string;
  };
  regenerateCommand: string;
  configuration: {
    physicsHz: number;
    callerHz: number;
    warmupSeconds: number;
    measurementSeconds: number;
    sourceSampleHz: number;
    polarWindAngleOffBowDeg: number;
    entrySpeedBinsMps: readonly number[];
  };
  polarReferences: WakePolarReference[];
  /** WK2 onset/saturation curve in CURRENT_MODERATE with a live source. */
  bowCollarStrengthCurve: WakeBowCollarCurvePoint[];
  cases: WakeContactCaseEvidence[];
}

class EntrySpeedDistribution {
  private readonly values: number[] = [];
  private sum = 0;
  private sumSquares = 0;

  add(value: number): void {
    this.values.push(value);
    this.sum += value;
    this.sumSquares += value * value;
  }

  summary(): EntrySpeedSummary {
    const count = this.values.length;
    if (count === 0) {
      const histogram: EntrySpeedSummary['histogram'] = (
        ENTRY_SPEED_BINS_MPS as readonly number[]
      ).map((upperBoundMps) => ({ upperBoundMps, count: 0 }));
      histogram.push({ upperBoundMps: null, count: 0 });
      return {
        samples: 0,
        meanMps: null,
        rmsMps: null,
        p50Mps: null,
        p90Mps: null,
        p95Mps: null,
        p99Mps: null,
        maxMps: null,
        histogram,
      };
    }

    this.values.sort((a, b) => a - b);
    const quantile = (fraction: number): number =>
      this.values[Math.floor((count - 1) * fraction)];
    const histogram: EntrySpeedSummary['histogram'] = [];
    let cursor = 0;
    for (const upperBoundMps of ENTRY_SPEED_BINS_MPS) {
      const begin = cursor;
      while (
        cursor < count &&
        this.values[cursor] <= upperBoundMps
      ) {
        cursor++;
      }
      histogram.push({ upperBoundMps, count: cursor - begin });
    }
    histogram.push({ upperBoundMps: null, count: count - cursor });

    return {
      samples: count,
      meanMps: round(this.sum / count),
      rmsMps: round(Math.sqrt(this.sumSquares / count)),
      p50Mps: round(quantile(0.5)),
      p90Mps: round(quantile(0.9)),
      p95Mps: round(quantile(0.95)),
      p99Mps: round(quantile(0.99)),
      maxMps: round(this.values[count - 1]),
      histogram,
    };
  }
}

function regionRecord<T>(factory: () => T): Record<LongitudinalContactRegion, T> {
  return {
    bow: factory(),
    midships: factory(),
    stern: factory(),
  };
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Nearest-rank quantile of an unsorted sample. Copies rather than sorting in place. */
function quantileOf(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function rotateBodyVectorToWorld(
  x: number,
  z: number,
  yaw: number,
): { x: number; z: number } {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    x: x * c + z * s,
    z: -x * s + z * c,
  };
}

function sourceSample(
  timeSeconds: number,
  sources: WakeSources,
  policy: WakeTrailPolicyResult,
  bowPolicy: WakeBowPolicyResult,
  wetHullProfile: WetHullBandProfile,
  speedThroughWaterMps: number,
  ambientWhitecaps: number,
  windSpeedMps: number,
  windAdvection: number,
  windDirection: Readonly<{ x: number; y: number }>,
  encounterVelocity: Readonly<{ x: number; z: number }>,
  transportScratch: { x: number; z: number },
): WakeSourceSample {
  const stern = sources.sternWaterline;
  const dx = stern.port.x - stern.starboard.x;
  const dy = stern.port.y - stern.starboard.y;
  const dz = stern.port.z - stern.starboard.z;
  const port: WakeWaterlineSideExtent = {
    aftStationIndex: -1,
    forwardStationIndex: -1,
    aft: null,
    forward: null,
  };
  const starboard: WakeWaterlineSideExtent = {
    aftStationIndex: -1,
    forwardStationIndex: -1,
    aft: null,
    forward: null,
  };
  let bowX = 0;
  let bowY = 0;
  let bowZ = 0;
  for (let i = 0; i < sources.bowWaterlinePointCount; i++) {
    const value = sources.bowWaterlinePoints[i];
    const extent = value.side === 'port' ? port : starboard;
    const position: [number, number, number] = [
      round(value.x),
      round(value.y),
      round(value.z),
    ];
    if (
      extent.aftStationIndex < 0 ||
      value.stationIndex < extent.aftStationIndex
    ) {
      extent.aftStationIndex = value.stationIndex;
      extent.aft = position;
    }
    if (value.stationIndex > extent.forwardStationIndex) {
      extent.forwardStationIndex = value.stationIndex;
      extent.forward = position;
    }
    bowX += value.x;
    bowY += value.y;
    bowZ += value.z;
  }
  const regions = regionRecord(() => ({
    wetStationCount: 0,
    waterlinePointCount: 0,
    meanEntrySpeedMps: 0,
    peakEntrySpeedMps: 0,
  }));
  for (const region of REGIONS) {
    const value = sources.regions[region];
    regions[region] = {
      wetStationCount: value.wetStationCount,
      waterlinePointCount: value.waterlinePointCount,
      meanEntrySpeedMps: round(value.meanEntrySpeedMps),
      peakEntrySpeedMps: round(value.peakEntrySpeedMps),
    };
  }
  const sternWidthXZ = stern.active
    ? Math.hypot(
        stern.port.x - stern.starboard.x,
        stern.port.z - stern.starboard.z,
      )
    : 0;
  resolveWakeTrailPolicy(
    {
      speedThroughWaterMps,
      ambientWhitecapCoverage: ambientWhitecaps,
      windSpeedMps,
      sternWidthM: sternWidthXZ,
      sternSourceAvailable: stern.active,
    },
    policy,
  );
  foamFieldAdvectionStep(
    1,
    windDirection,
    windSpeedMps,
    windAdvection,
    encounterVelocity,
    transportScratch,
  );
  const sourceEnabled = stern.active && policy.turbulenceRatePerSecond > 0;
  resolveWakeBowPolicy(
    {
      speedThroughWaterMps,
      ambientWhitecapCoverage: ambientWhitecaps,
      windSpeedMps,
      bowWaterlinePointCount: sources.bowWaterlinePointCount,
    },
    bowPolicy,
  );
  updateWetHullBandProfile(sources, wetHullProfile);
  let wetMinY = Number.POSITIVE_INFINITY;
  let wetMaxY = Number.NEGATIVE_INFINITY;
  const wetStationIndices: number[] = [];
  for (let i = 0; i < wetHullProfile.count; i++) {
    const sample = wetHullProfile.samples[i];
    wetStationIndices.push(sample.stationIndex);
    wetMinY = Math.min(
      wetMinY,
      sample.portWaterlineY,
      sample.starboardWaterlineY,
    );
    wetMaxY = Math.max(
      wetMaxY,
      sample.portWaterlineY,
      sample.starboardWaterlineY,
    );
  }
  const bowSourceEnabled =
    sources.waterlinePolylineStationCount > 0 &&
    bowPolicy.activeFoamRatePerSecond > 0;
  return {
    timeSeconds: round(timeSeconds),
    sternWaterline: {
      active: stern.active,
      stationIndex: stern.stationIndex,
      widthM: stern.active ? round(Math.hypot(dx, dy, dz)) : 0,
      port: [round(stern.port.x), round(stern.port.y), round(stern.port.z)],
      starboard: [
        round(stern.starboard.x),
        round(stern.starboard.y),
        round(stern.starboard.z),
      ],
    },
    bowWaterline: {
      pointCount: sources.bowWaterlinePointCount,
      centroid:
        sources.bowWaterlinePointCount > 0
          ? [
              round(bowX / sources.bowWaterlinePointCount),
              round(bowY / sources.bowWaterlinePointCount),
              round(bowZ / sources.bowWaterlinePointCount),
            ]
          : null,
      port,
      starboard,
    },
    regions,
    trailInjection: {
      sourceEnabled,
      sourceCentreXZ: stern.active
        ? [
            round((stern.port.x + stern.starboard.x) * 0.5),
            round((stern.port.z + stern.starboard.z) * 0.5),
          ]
        : null,
      sourceRadiusM: round(policy.sourceRadiusM),
      fieldTransportMps: [
        round(transportScratch.x),
        round(transportScratch.z),
      ],
      activeFoamRatePerSecond: round(policy.activeFoamRatePerSecond),
      residualFoamRatePerSecond: round(policy.residualFoamRatePerSecond),
      turbulenceRatePerSecond: round(policy.turbulenceRatePerSecond),
      turbulenceTauSeconds: round(policy.turbulenceTauSeconds),
      bubbleHaze: round(policy.bubbleHaze),
      whitecapSuppression: round(policy.whitecapSuppression),
      seaMask: round(policy.seaMask),
    },
    bowInjection: {
      sourceEnabled: bowSourceEnabled,
      pointCount: sources.bowWaterlinePointCount,
      waterlineStationCount: sources.waterlinePolylineStationCount,
      collarDrive: round(bowPolicy.collarDrive),
      sourceRadiusM: round(bowPolicy.sourceRadiusM),
      tearM: (() => {
        // Astern along the track, matching the renderer. Recorded as a vector
        // rather than a length precisely so that a future direction change
        // shows up in the evidence instead of hiding behind a magnitude.
        const speed = Math.hypot(encounterVelocity.x, encounterVelocity.z);
        if (speed <= 1e-3) return [0, 0] as [number, number];
        return [
          round((-encounterVelocity.x / speed) * bowPolicy.tearLengthM),
          round((-encounterVelocity.z / speed) * bowPolicy.tearLengthM),
        ] as [number, number];
      })(),
      activeFoamRatePerSecond: round(bowPolicy.activeFoamRatePerSecond),
      residualFoamRatePerSecond: round(
        bowPolicy.residualFoamRatePerSecond,
      ),
      turbulenceRatePerSecond: round(bowPolicy.turbulenceRatePerSecond),
      moundNormalStrength: round(bowPolicy.moundNormalStrength),
      moundAcrossRadiusM: round(bowPolicy.moundAcrossRadiusM),
      moundAlongRadiusM: round(bowPolicy.moundAlongRadiusM),
      seaMask: round(bowPolicy.seaMask),
    },
    wetHullBand: {
      profileSampleCount: wetHullProfile.count,
      stationIndices: wetStationIndices,
      resolvedLocalYRangeM:
        wetHullProfile.count > 0
          ? [round(wetMinY), round(wetMaxY)]
          : null,
      heightM: round(bowPolicy.wetBandHeightM),
      darkening: round(bowPolicy.wetBandDarkening),
      roughnessScale: round(bowPolicy.wetBandRoughnessScale),
    },
    activeOvertopEventCount: sources.activeOvertopEventCount,
  };
}

function buildBowCollarStrengthCurve(): WakeBowCollarCurvePoint[] {
  const sea = findSeaState('CURRENT_MODERATE');
  const ambientWhitecaps = whitecapCoverage(sea.generatingWind.speedMps);
  const policy = createWakeBowPolicyResult();
  return [0, 0.4, 0.8, 1.2, 2, 3, 4.7, 5.875].map((speedMps) => {
    resolveWakeBowPolicy(
      {
        speedThroughWaterMps: speedMps,
        ambientWhitecapCoverage: ambientWhitecaps,
        windSpeedMps: sea.generatingWind.speedMps,
        bowWaterlinePointCount: 20,
      },
      policy,
    );
    return {
      speedMps: round(speedMps),
      collarDrive: round(policy.collarDrive),
      activeFoamRatePerSecond: round(policy.activeFoamRatePerSecond),
      residualFoamRatePerSecond: round(policy.residualFoamRatePerSecond),
      turbulenceRatePerSecond: round(policy.turbulenceRatePerSecond),
    };
  });
}

function referenceForState(state: ReferenceState): WakePolarReference {
  const sea = findSeaState(state.seaStateName);
  const solution = solveEquilibrium(
    POLAR_WIND_ANGLE_OFF_BOW_DEG,
    'starboard',
    sea.generatingWind.speedMps,
    state.canvas,
  );
  return {
    seaStateName: sea.name,
    windSpeedMps: sea.generatingWind.speedMps,
    windAngleOffBowDeg: POLAR_WIND_ANGLE_OFF_BOW_DEG,
    tack: 'starboard',
    canvas: state.canvasName,
    speedMps: round(solution.speedMps),
    leewayDeg: round(solution.leewayDeg),
    balanceRudderDeg:
      solution.rudderDeg === null ? null : round(solution.rudderDeg),
  };
}

/** Solve only the three WK reference motions, without running contact cases. */
export function buildWakePolarReferences(
  onProgress: (message: string) => void = () => undefined,
): WakePolarReference[] {
  return REFERENCE_STATES.map((state) => {
    onProgress(`solving polar reference: ${state.seaStateName}`);
    return referenceForState(state);
  });
}

/**
 * Run one prescribed-speed contact measurement.
 *
 * The heading is a starboard-tack beam reach relative to the preset's own wind
 * heading. Leeway rotates the course away from the fixed hull heading exactly
 * as the S3 polar's captive probe does. No sail or rudder force participates in
 * this run: the polar supplies the already-solved kinematics and the contact
 * system is measured without letting changing propulsion obscure its inputs.
 */
export function runWakeContactCase(
  config: WakeContactCaseConfig,
  timing: Partial<EvidenceTiming> = {},
): WakeContactCaseEvidence {
  const resolvedTiming: EvidenceTiming = {
    warmupSeconds: timing.warmupSeconds ?? WARMUP_SECONDS,
    measurementSeconds: timing.measurementSeconds ?? MEASUREMENT_SECONDS,
    callerHz: timing.callerHz ?? CALLER_HZ,
    sourceSampleHz: timing.sourceSampleHz ?? SOURCE_SAMPLE_HZ,
  };
  if (
    !Number.isFinite(resolvedTiming.warmupSeconds) ||
    !Number.isFinite(resolvedTiming.measurementSeconds) ||
    !Number.isFinite(resolvedTiming.callerHz) ||
    !Number.isFinite(resolvedTiming.sourceSampleHz) ||
    resolvedTiming.warmupSeconds < 0 ||
    resolvedTiming.measurementSeconds <= 0 ||
    resolvedTiming.callerHz <= 0 ||
    resolvedTiming.sourceSampleHz <= 0 ||
    resolvedTiming.sourceSampleHz > resolvedTiming.callerHz
  ) {
    throw new RangeError('wake evidence timing must be finite and positive');
  }

  const sea = findSeaState(config.seaStateName);
  const waves = new WaveField(sea);
  const body = buildSchoonerBuoyancy();
  // In the polar's starboard-tack frame the wind travels toward model +X.
  // Rotate that frame onto this preset's wind heading without changing the
  // wave field or inventing a second directional convention.
  // WX2 renamed the field — this is the wind that GREW this sea, which is the
  // right one here because the frame being rotated is the wave field's. WK3
  // added the off-bow term so the running-sizing case can be posed at 135°.
  const windHeadingRad = (sea.generatingWind.directionDeg * Math.PI) / 180;
  const windAngleOffBowDeg =
    config.windAngleOffBowDeg ?? POLAR_WIND_ANGLE_OFF_BOW_DEG;
  const yaw =
    Math.PI / 2 -
    windHeadingRad +
    ((POLAR_WIND_ANGLE_OFF_BOW_DEG - windAngleOffBowDeg) * Math.PI) / 180;
  const leewayRad = (config.leewayDeg * Math.PI) / 180;
  const localVelocityX = config.speedMps * Math.sin(leewayRad);
  const localVelocityZ = config.speedMps * Math.cos(leewayRad);
  const encounterVelocity = rotateBodyVectorToWorld(
    localVelocityX,
    localVelocityZ,
    yaw,
  );
  body.snapToSurface(waves, 0, 0, yaw);
  const sources = new WakeSources(body.contacts, body.overtopEvents);
  const foamWindDirection = {
    x: Math.sin(windHeadingRad),
    y: -Math.cos(windHeadingRad),
  };
  const ambientWhitecaps = whitecapCoverage(sea.generatingWind.speedMps);
  const trailPolicy = createWakeTrailPolicyResult();
  const bowPolicy = createWakeBowPolicyResult();
  const wetHullProfile = createWetHullBandProfile();
  const trailTransport = { x: 0, z: 0 };

  const dt = 1 / resolvedTiming.callerHz;
  const warmupFrames = Math.round(
    resolvedTiming.warmupSeconds * resolvedTiming.callerHz,
  );
  for (let frame = 0; frame < warmupFrames; frame++) {
    body.update(
      dt,
      waves,
      0,
      0,
      yaw,
      PHYSICS_STEP,
      encounterVelocity.x,
      encounterVelocity.z,
    );
  }
  sources.update();

  const previousPort = body.contacts.map(
    (contact) => contact.portWaterline.active,
  );
  const previousStarboard = body.contacts.map(
    (contact) => contact.starboardWaterline.active,
  );
  const crossings = regionRecord<CrossingAccumulator>(() => ({
    activations: 0,
    deactivations: 0,
    activePointSamples: 0,
  }));
  const entrySpeeds = regionRecord(() => new EntrySpeedDistribution());
  const overtopContactSamples = regionRecord(() => 0);
  const overtop: OvertopAccumulator = {
    eventSamples: 0,
    framesWithEvents: 0,
    maximumEventsInFrame: 0,
    peakSpeedMps: 0,
    peakDepthM: 0,
    drawnSamples: 0,
    peakStrength: 0,
    strengthSum: 0,
  };
  // The cue's own scale, so the record says what would actually be *drawn* for
  // these events rather than only how many the physics detected.
  const overtopCue = overtopReferencesFromFreeboard(body.freeboard);

  const spray = new HullSprayEventDetector();
  const sprayInput: HullSprayEventInput = {
    dtSeconds: 1 / resolvedTiming.callerHz,
    speedThroughWaterMps: config.speedMps,
    ambientWhitecapCoverage: ambientWhitecaps,
    densityScale: 1,
    enabled: true,
  };
  const sprayDrives: number[] = [];
  let sprayFramesShedding = 0;
  let sprayDroplets = 0;
  let sprayPeakDrive = 0;
  let sprayPeakImmersionRate = 0;
  let sprayPeakEntryPowerW = 0;
  const series: WakeSourceSample[] = [];
  const measurementFrames = Math.round(
    resolvedTiming.measurementSeconds * resolvedTiming.callerHz,
  );
  const sampleEveryFrames = Math.max(
    1,
    Math.round(resolvedTiming.callerHz / resolvedTiming.sourceSampleHz),
  );

  for (let frame = 0; frame < measurementFrames; frame++) {
    body.update(
      dt,
      waves,
      0,
      0,
      yaw,
      PHYSICS_STEP,
      encounterVelocity.x,
      encounterVelocity.z,
    );
    sources.update();

    for (let i = 0; i < body.contacts.length; i++) {
      const contact = body.contacts[i];
      const region = contact.longitudinalRegion;
      const crossing = crossings[region];
      const port = contact.portWaterline.active;
      const starboard = contact.starboardWaterline.active;
      if (port !== previousPort[i]) {
        if (port) crossing.activations++;
        else crossing.deactivations++;
        previousPort[i] = port;
      }
      if (starboard !== previousStarboard[i]) {
        if (starboard) crossing.activations++;
        else crossing.deactivations++;
        previousStarboard[i] = starboard;
      }
      crossing.activePointSamples += Number(port) + Number(starboard);
      if (contact.isWet) {
        entrySpeeds[region].add(contact.normalEntrySpeedMps);
      }
      if (contact.overtopping) overtopContactSamples[region]++;
    }

    const eventCount = body.overtopEvents.length;
    overtop.eventSamples += eventCount;
    if (eventCount > 0) overtop.framesWithEvents++;
    overtop.maximumEventsInFrame = Math.max(
      overtop.maximumEventsInFrame,
      eventCount,
    );
    for (const event of body.overtopEvents) {
      overtop.peakSpeedMps = Math.max(overtop.peakSpeedMps, event.speed);
      overtop.peakDepthM = Math.max(overtop.peakDepthM, event.depth);
      const strength = overtopEventStrength(
        event.depth,
        event.speed,
        overtopCue.depthReferenceM,
        overtopCue.speedReferenceMps,
      );
      overtop.peakStrength = Math.max(overtop.peakStrength, strength);
      overtop.strengthSum += strength;
      if (strength > 0.3) overtop.drawnSamples++;
    }

    // WK3's tear detector, stepped on exactly the same completed contact frames
    // the renderer sees. Its inputs come from the same condensation the
    // production path uses, so a rate measured here is the rate that ships.
    if (spray.update(sources, sprayInput)) {
      sprayFramesShedding++;
      sprayDroplets += spray.burst.dropletCount;
    }
    sprayDrives.push(spray.policy.entryDrive);
    sprayPeakDrive = Math.max(sprayPeakDrive, spray.policy.entryDrive);
    sprayPeakImmersionRate = Math.max(
      sprayPeakImmersionRate,
      spray.bowImmersionRateM3PerSec,
    );
    sprayPeakEntryPowerW = Math.max(
      sprayPeakEntryPowerW,
      spray.policy.entryPowerW,
    );

    if (
      frame % sampleEveryFrames === 0 ||
      frame === measurementFrames - 1
    ) {
      series.push(
        sourceSample(
          (frame + 1) * dt,
          sources,
          trailPolicy,
          bowPolicy,
          wetHullProfile,
          config.speedMps,
          ambientWhitecaps,
          sea.generatingWind.speedMps,
          sea.whitewater.windAdvection,
          foamWindDirection,
          encounterVelocity,
          trailTransport,
        ),
      );
    }
  }

  const waterlineCrossings = regionRecord(() => ({
    activations: 0,
    deactivations: 0,
    transitionsPerSecond: 0,
    meanActivePointsPerFrame: 0,
  }));
  const entrySpeedSummary = regionRecord<EntrySpeedSummary>(() => ({
    samples: 0,
    meanMps: null,
    rmsMps: null,
    p50Mps: null,
    p90Mps: null,
    p95Mps: null,
    p99Mps: null,
    maxMps: null,
    histogram: [],
  }));
  for (const region of REGIONS) {
    const crossing = crossings[region];
    waterlineCrossings[region] = {
      activations: crossing.activations,
      deactivations: crossing.deactivations,
      transitionsPerSecond: round(
        (crossing.activations + crossing.deactivations) /
          resolvedTiming.measurementSeconds,
      ),
      meanActivePointsPerFrame: round(
        crossing.activePointSamples / measurementFrames,
      ),
    };
    entrySpeedSummary[region] = entrySpeeds[region].summary();
  }

  return {
    name: config.name,
    seaStateName: sea.name,
    seed: sea.seed,
    windSpeedMps: sea.generatingWind.speedMps,
    prescribedMotion: {
      speedMps: round(config.speedMps),
      leewayDeg: round(config.leewayDeg),
      modelYawRad: round(yaw),
      encounterVelocityWorldMps: {
        x: round(encounterVelocity.x),
        z: round(encounterVelocity.z),
      },
      polarReference: config.polarReference ?? null,
    },
    waterlineCrossings,
    entrySpeeds: entrySpeedSummary,
    overtopping: {
      eventSamples: overtop.eventSamples,
      eventSamplesPerSecond: round(
        overtop.eventSamples / resolvedTiming.measurementSeconds,
      ),
      framesWithEvents: overtop.framesWithEvents,
      frameFraction: round(overtop.framesWithEvents / measurementFrames),
      maximumEventsInFrame: overtop.maximumEventsInFrame,
      peakSpeedMps: round(overtop.peakSpeedMps),
      peakDepthM: round(overtop.peakDepthM),
      contactSamplesByRegion: overtopContactSamples,
      cue: {
        depthReferenceM: round(overtopCue.depthReferenceM),
        speedReferenceMps: round(overtopCue.speedReferenceMps),
        peakStrength: round(overtop.peakStrength),
        meanStrength:
          overtop.eventSamples > 0
            ? round(overtop.strengthSum / overtop.eventSamples)
            : null,
        drawnSamples: overtop.drawnSamples,
      },
    },
    sprayEvents: {
      tears: spray.eventCount,
      tearsPerSecond: round(
        spray.eventCount / resolvedTiming.measurementSeconds,
      ),
      ceilingPerSecond: round(spray.policy.eventCeilingPerSecond),
      framesShedding: sprayFramesShedding,
      dropletsShed: sprayDroplets,
      dropletsPerSecond: round(
        sprayDroplets / resolvedTiming.measurementSeconds,
      ),
      dropletCeilingPerSecond: round(SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX),
      peakDrive: round(sprayPeakDrive),
      p95Drive: round(quantileOf(sprayDrives, 0.95)),
      armThreshold: round(spray.policy.armThreshold),
      wayGate: round(spray.policy.wayGate),
      seaMask: round(spray.policy.seaMask),
      peakBowImmersionRateM3PerSec: round(sprayPeakImmersionRate),
      peakEntryPowerW: round(sprayPeakEntryPowerW),
    },
    sourceSeries: series,
    maximumWaveInverseSolveResidualM: round(
      waves.maximumSolveResidual,
      10,
    ),
  };
}

// ---------------------------------------------------------------------------
// WK3 — the spray-event extension, beside the contact baseline
// ---------------------------------------------------------------------------

export const WAKE_SPRAY_EVIDENCE_FORMAT_VERSION = 1;

/** Shorter than the contact baseline's: fifteen runs rather than four. */
const SPRAY_WARMUP_SECONDS = 20;
const SPRAY_MEASUREMENT_SECONDS = 60;
/**
 * Longer than the cases, because the sweep is counting rare events.
 *
 * At 40 s the interesting end of the sweep returned counts of 0 and 1 and the
 * sampled rate was not monotone — 2.0 m/s caught one crossing and 2.5 m/s
 * caught none. That is sampling noise in a stochastic process, not an
 * inversion in the rate, but a gate cannot tell the difference at n = 1.
 */
const SPRAY_SWEEP_MEASUREMENT_SECONDS = 90;

/**
 * The heading that actually buries her.
 *
 * WK0-F2 said no reference run overtopped; WK-R-F1 said the S4 merge made the
 * beam reach fire marginally. Neither is the sizing case the plan asked for.
 * Sweeping heading rather than severity found it: running at 135° off the bow
 * in the Southern preset, she drives into the back of the sea ahead and takes
 * water aboard on 8.4% of frames with a peak depth of 1.89 m — against 0.13% of
 * frames and 0.076 m on the beam reach in the *same* sea.
 */
const SPRAY_SIZING_WIND_ANGLE_OFF_BOW_DEG = 135;

const SPRAY_SPEED_SWEEP_MPS = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.7,
] as const;

export interface WakeSpraySweepPoint {
  speedMps: number;
  wayGate: number;
  tears: number;
  tearsPerSecond: number;
  dropletsPerSecond: number;
  p95Drive: number;
  peakDrive: number;
}

export interface WakeSprayCaseEvidence {
  name: string;
  seaStateName: string;
  windAngleOffBowDeg: number;
  speedMps: number;
  leewayDeg: number;
  sprayEvents: WakeSprayEventSummary;
  overtopping: WakeContactCaseEvidence['overtopping'];
}

export interface WakeSprayEvidence {
  formatVersion: number;
  status: string;
  contract: { method: string; scope: string; interpretation: string };
  regenerateCommand: string;
  configuration: {
    physicsHz: number;
    callerHz: number;
    warmupSeconds: number;
    measurementSeconds: number;
    sweepMeasurementSeconds: number;
  };
  policy: {
    entryPowerReferenceW: number;
    wayOnsetMps: number;
    waySaturationMps: number;
    armDriveCalm: number;
    armDriveRough: number;
    releaseFraction: number;
    minimumIntervalSeconds: number;
    tearMaxSeconds: number;
    eventCeilingPerSecond: number;
    sustainedDropletCeilingPerSecond: number;
  };
  overtopCue: {
    schoonerFreeboardM: number;
    depthReferenceM: number;
    speedReferenceMps: number;
    /** The pre-WK3 raft curve, re-expressed, for the comparison below. */
    raftDepthReferenceM: number;
    raftSpeedReferenceMps: number;
    /**
     * What each curve makes of the same events. The raft curve clamping to 1
     * on her marginal crossing is the whole reason the references moved.
     */
    comparison: Array<{
      label: string;
      depthM: number;
      speedMps: number;
      raftCurveStrength: number;
      freeboardCurveStrength: number;
      drawnByRaftCurve: boolean;
      drawnByFreeboardCurve: boolean;
    }>;
  };
  cases: WakeSprayCaseEvidence[];
  moderateSpeedSweep: WakeSpraySweepPoint[];
}

/** Build the WK3 event-rate record. Deterministic; same seed, same numbers. */
export function buildWakeSprayEvidence(options: {
  onProgress?: (message: string) => void;
} = {}): WakeSprayEvidence {
  const onProgress = options.onProgress ?? (() => undefined);
  const references = buildWakePolarReferences(onProgress);
  const timing = {
    warmupSeconds: SPRAY_WARMUP_SECONDS,
    measurementSeconds: SPRAY_MEASUREMENT_SECONDS,
  };

  const configs: WakeContactCaseConfig[] = [
    {
      name: 'CURRENT_MODERATE_ANCHOR',
      seaStateName: 'CURRENT_MODERATE',
      speedMps: 0,
      leewayDeg: 0,
    },
    ...references.map((reference) => ({
      name: `${reference.seaStateName}_POLAR_REACH`,
      seaStateName: reference.seaStateName,
      speedMps: reference.speedMps,
      leewayDeg: reference.leewayDeg,
      polarReference: reference,
    })),
  ];

  const southern = references.find(
    (reference) => reference.seaStateName === 'SOUTHERN_OCEAN_ROUGH',
  );
  if (!southern) throw new Error('spray evidence needs SOUTHERN_OCEAN_ROUGH');
  configs.push({
    name: 'SOUTHERN_OCEAN_ROUGH_RUNNING_SIZING',
    seaStateName: 'SOUTHERN_OCEAN_ROUGH',
    // Her polar speed off the wind is close enough to the reach's for the
    // heading to be the only thing that differs, which is the point of the
    // case: it isolates encounter geometry from severity and from speed.
    speedMps: southern.speedMps,
    leewayDeg: southern.leewayDeg,
    windAngleOffBowDeg: SPRAY_SIZING_WIND_ANGLE_OFF_BOW_DEG,
  });

  const cases: WakeSprayCaseEvidence[] = [];
  for (const config of configs) {
    onProgress(`measuring spray events: ${config.name}`);
    const measured = runWakeContactCase(config, timing);
    cases.push({
      name: config.name,
      seaStateName: measured.seaStateName,
      windAngleOffBowDeg:
        config.windAngleOffBowDeg ?? POLAR_WIND_ANGLE_OFF_BOW_DEG,
      speedMps: measured.prescribedMotion.speedMps,
      leewayDeg: measured.prescribedMotion.leewayDeg,
      sprayEvents: measured.sprayEvents,
      overtopping: measured.overtopping,
    });
  }

  const moderateSpeedSweep: WakeSpraySweepPoint[] = [];
  for (const speedMps of SPRAY_SPEED_SWEEP_MPS) {
    onProgress(`sweeping spray rate: ${speedMps.toFixed(2)} m/s`);
    const measured = runWakeContactCase(
      {
        name: `CURRENT_MODERATE_SWEEP_${speedMps}`,
        seaStateName: 'CURRENT_MODERATE',
        speedMps,
        leewayDeg: 0,
      },
      {
        warmupSeconds: SPRAY_WARMUP_SECONDS,
        measurementSeconds: SPRAY_SWEEP_MEASUREMENT_SECONDS,
      },
    );
    moderateSpeedSweep.push({
      speedMps: round(speedMps),
      wayGate: measured.sprayEvents.wayGate,
      tears: measured.sprayEvents.tears,
      tearsPerSecond: measured.sprayEvents.tearsPerSecond,
      dropletsPerSecond: measured.sprayEvents.dropletsPerSecond,
      p95Drive: measured.sprayEvents.p95Drive,
      peakDrive: measured.sprayEvents.peakDrive,
    });
  }

  const freeboardM = buildSchoonerBuoyancy().freeboard;
  const cue = overtopReferencesFromFreeboard(freeboardM);
  const raft = RAFT_OVERTOP_SPRAY;
  const comparison = [
    { label: 'beam-reach reference peak', depthM: 0.0764, speedMps: 0.859 },
    { label: 'WK-R-F1 recorded peak', depthM: 0.151, speedMps: 1.329 },
    { label: 'running sizing case p50', depthM: 0.398, speedMps: 1.0 },
    { label: 'running sizing case p95', depthM: 1.4317, speedMps: 4.0 },
    { label: 'running sizing case peak', depthM: 1.8927, speedMps: 8.096 },
  ].map((entry) => {
    const raftCurveStrength = overtopEventStrength(
      entry.depthM,
      entry.speedMps,
      raft.depthReferenceM,
      raft.speedReferenceMps,
    );
    const freeboardCurveStrength = overtopEventStrength(
      entry.depthM,
      entry.speedMps,
      cue.depthReferenceM,
      cue.speedReferenceMps,
    );
    return {
      ...entry,
      depthM: round(entry.depthM),
      speedMps: round(entry.speedMps),
      raftCurveStrength: round(raftCurveStrength),
      freeboardCurveStrength: round(freeboardCurveStrength),
      drawnByRaftCurve: raftCurveStrength > 0.3,
      drawnByFreeboardCurve: freeboardCurveStrength > 0.3,
    };
  });

  return {
    formatVersion: WAKE_SPRAY_EVIDENCE_FORMAT_VERSION,
    status:
      'WK3 bow-entry tear rates and overtop cue sizing. An intentional extension beside contact-baseline.json, not a change to it.',
    contract: {
      method:
        'The production HullSprayEventDetector stepped on the same completed 60 Hz contact frames the renderer reads, under the same prescribed S3 polar kinematics the contact baseline uses. Fixed 240 Hz physics, seeded WaveField.',
      scope:
        'The three polar references plus CURRENT_MODERATE at anchor, plus a dedicated running sizing case at 135 degrees off the bow in SOUTHERN_OCEAN_ROUGH, plus a ten-point speed sweep in CURRENT_MODERATE.',
      interpretation:
        'tearsPerSecond is the event rate the round gates: zero at anchor and on glass, non-decreasing across the speed sweep, and never above ceilingPerSecond. The overtop block records what the CUE makes of the physics-detected events; drawnSamples of zero means the detector fired and the cue correctly declined to draw anything.',
    },
    regenerateCommand: 'npm run ship:wake',
    configuration: {
      physicsHz: 1 / PHYSICS_STEP,
      callerHz: CALLER_HZ,
      warmupSeconds: SPRAY_WARMUP_SECONDS,
      measurementSeconds: SPRAY_MEASUREMENT_SECONDS,
      sweepMeasurementSeconds: SPRAY_SWEEP_MEASUREMENT_SECONDS,
    },
    policy: {
      entryPowerReferenceW: SPRAY_ENTRY_POWER_REFERENCE_W,
      wayOnsetMps: SPRAY_WAY_ONSET_MPS,
      waySaturationMps: WAKE_POLICY_HULL_SPEED_MPS,
      armDriveCalm: SPRAY_ARM_DRIVE_CALM,
      armDriveRough: SPRAY_ARM_DRIVE_ROUGH,
      releaseFraction: SPRAY_RELEASE_FRACTION,
      minimumIntervalSeconds: SPRAY_MINIMUM_INTERVAL_SECONDS,
      tearMaxSeconds: SPRAY_TEAR_MAX_SECONDS,
      eventCeilingPerSecond: round(1 / SPRAY_MINIMUM_INTERVAL_SECONDS),
      sustainedDropletCeilingPerSecond: round(
        SPRAY_SUSTAINED_DROPLETS_PER_SECOND_MAX,
      ),
    },
    overtopCue: {
      schoonerFreeboardM: round(freeboardM),
      depthReferenceM: round(cue.depthReferenceM),
      speedReferenceMps: round(cue.speedReferenceMps),
      raftDepthReferenceM: round(raft.depthReferenceM),
      raftSpeedReferenceMps: round(raft.speedReferenceMps),
      comparison,
    },
    cases,
    moderateSpeedSweep,
  };
}

export function buildWakeContactEvidence(options: {
  onProgress?: (message: string) => void;
} = {}): WakeContactEvidence {
  const references = buildWakePolarReferences(
    options.onProgress ?? (() => undefined),
  );

  const moderate = references.find(
    (reference) => reference.seaStateName === 'CURRENT_MODERATE',
  );
  if (!moderate) throw new Error('wake evidence needs CURRENT_MODERATE');

  const cases: WakeContactCaseEvidence[] = [];
  const caseConfigs: WakeContactCaseConfig[] = [
    {
      name: 'CURRENT_MODERATE_ANCHOR',
      seaStateName: 'CURRENT_MODERATE',
      speedMps: 0,
      leewayDeg: 0,
    },
    ...references.map((reference) => ({
      name: `${reference.seaStateName}_POLAR_REACH`,
      seaStateName: reference.seaStateName,
      speedMps: reference.speedMps,
      leewayDeg: reference.leewayDeg,
      polarReference: reference,
    })),
  ];
  for (const config of caseConfigs) {
    options.onProgress?.(`measuring contacts: ${config.name}`);
    cases.push(runWakeContactCase(config));
  }

  return {
    formatVersion: WAKE_CONTACT_EVIDENCE_FORMAT_VERSION,
    status:
      'WK3 deterministic contact/source baseline: stern trail, continuous bow-to-stern waterline polylines, resolved wet-hull policy, and per-case bow-entry tear rates with the overtop cue resolved at this vessel freeboard. Event-rate tables and the overtop sizing case live beside this in spray-events.json. GPU performance evidence remains separate.',
    contract: {
      method:
        'Seeded WaveField and schooner contact model, fixed 240 Hz physics under a prescribed S3 polar beam-reach speed and leeway; 60 Hz evidence reads only completed contact frames.',
      scope:
        'CURRENT_MODERATE at anchor plus GLASSY_LONG_SWELL, CURRENT_MODERATE and SOUTHERN_OCEAN_ROUGH at their freshly solved 90-degree polar speeds. Full sail below the gale; working sail in the gale.',
      interpretation:
        'Entry speeds are wet-contact kinematics, not emission commands. Waves produce non-zero entry at anchor while WK1 trailInjection and WK2 bowInjection remain exactly zero because their drive is speed through water. The bow policy drives two 13-station hull-side polylines resampled from complete resolved cuts, so amidships waterline shear stays continuous without more GPU positions. Wet-hull knots remain live because a stationary hull is still wet.',
    },
    regenerateCommand: 'npm run ship:wake',
    configuration: {
      physicsHz: 1 / PHYSICS_STEP,
      callerHz: CALLER_HZ,
      warmupSeconds: WARMUP_SECONDS,
      measurementSeconds: MEASUREMENT_SECONDS,
      sourceSampleHz: SOURCE_SAMPLE_HZ,
      polarWindAngleOffBowDeg: POLAR_WIND_ANGLE_OFF_BOW_DEG,
      entrySpeedBinsMps: ENTRY_SPEED_BINS_MPS,
    },
    polarReferences: references,
    bowCollarStrengthCurve: buildBowCollarStrengthCurve(),
    cases,
  };
}
