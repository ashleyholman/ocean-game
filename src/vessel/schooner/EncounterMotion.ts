import type { SeaState, SlotBudget } from '../../ocean/seaState';
import {
  defaultRoughness,
  defaultWhitewater,
  noSwell,
  resolveSeaState,
} from '../../ocean/seaState';
import { WaveField } from '../../scene/Waves';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const GRAVITY = 9.81;

export const ENCOUNTER_EVIDENCE_FORMAT_VERSION = 1;

export interface HorizontalVector {
  x: number;
  z: number;
}

/**
 * Convert a true-style presentation heading to a unit vector in the local
 * render/wave frame. North is local -z, east is +x.
 */
export function presentationHeadingDirection(headingDeg: number): HorizontalVector {
  if (!Number.isFinite(headingDeg)) throw new Error(`heading must be finite, got ${headingDeg}`);
  const heading = headingDeg * DEG;
  return { x: Math.sin(heading), z: -Math.cos(heading) };
}

/**
 * Bow-forward velocity through the mean water used by the response harness.
 * It is prescribed tow-tank motion, not a second navigation or position state.
 */
export function prescribedThroughWaterVelocity(
  presentationHeadingDeg: number,
  speedThroughWaterMps: number,
): HorizontalVector {
  if (!Number.isFinite(speedThroughWaterMps) || speedThroughWaterMps < 0) {
    throw new Error(
      `speed through water must be finite and non-negative, got ${speedThroughWaterMps}`,
    );
  }
  const direction = presentationHeadingDirection(presentationHeadingDeg);
  return {
    x: direction.x * speedThroughWaterMps,
    z: direction.z * speedThroughWaterMps,
  };
}

/** Deep-water angular encounter frequency, |omega - k (waveDirection dot velocity)|. */
export function deepWaterEncounterAngularFrequency(
  waveNumberPerMetre: number,
  waveDirection: HorizontalVector,
  velocityThroughWaterMps: HorizontalVector,
): number {
  if (!Number.isFinite(waveNumberPerMetre) || waveNumberPerMetre <= 0) {
    throw new Error(`wave number must be finite and positive, got ${waveNumberPerMetre}`);
  }
  const intrinsicAngularFrequency = Math.sqrt(GRAVITY * waveNumberPerMetre);
  const projectedSpeed =
    waveDirection.x * velocityThroughWaterMps.x +
    waveDirection.z * velocityThroughWaterMps.z;
  return Math.abs(intrinsicAngularFrequency - waveNumberPerMetre * projectedSpeed);
}

export type EncounterAspect = 'head' | 'following' | 'beam' | 'quartering-head';

export interface SingleWaveEncounterCase {
  aspect: EncounterAspect;
  vesselHeadingDeg: number;
  relativeHeadingDeg: number;
  projectedSpeedAlongWaveMps: number;
  expectedAngularFrequencyRadPerSecond: number;
  measuredAngularFrequencyRadPerSecond: number;
  expectedPeriodSeconds: number;
  measuredPeriodSeconds: number;
  relativeFrequencyError: number;
  measuredUpwardCrossings: number;
}

export interface SingleWaveEncounterEvidence {
  formatVersion: typeof ENCOUNTER_EVIDENCE_FORMAT_VERSION;
  note: string;
  limitations: readonly string[];
  regenerateCommand: string;
  configuration: {
    requestedWaveTravelHeadingDeg: number;
    resolvedWaveTravelHeadingDeg: number;
    requestedWavePeriodSeconds: number;
    resolvedWavelengthMetres: number;
    resolvedIntrinsicPeriodSeconds: number;
    resolvedPhaseSpeedMps: number;
    speedThroughWaterMps: number;
    sampleHz: number;
    measurementSeconds: number;
  };
  cases: SingleWaveEncounterCase[];
}

interface EncounterCaseDefinition {
  aspect: EncounterAspect;
  relativeHeadingDeg: number;
}

const ENCOUNTER_CASES: readonly EncounterCaseDefinition[] = [
  { aspect: 'head', relativeHeadingDeg: 180 },
  { aspect: 'quartering-head', relativeHeadingDeg: 135 },
  { aspect: 'beam', relativeHeadingDeg: 90 },
  { aspect: 'following', relativeHeadingDeg: 0 },
];

const SINGLE_WAVE_BUDGET: SlotBudget = { wind: 0, primary: 1, secondary: 0 };

function singleWaveSeaState(periodSeconds: number, travelHeadingDeg: number): SeaState {
  return {
    name: 'SHIP_ENCOUNTER_SINGLE_WAVE',
    label: 'Ship encounter-frequency diagnostic',
    seed: 1701,
    generatingWind: { speedMps: 0, directionDeg: travelHeadingDeg, gustiness: 0, maturity: 0 },
    primary: {
      enabled: true,
      significantHeight: 1,
      peakPeriod: periodSeconds,
      directionDeg: travelHeadingDeg,
      spreadDeg: 1,
      // Zero Q makes this a pure sinusoid. The diagnostic is about encounter
      // timing, not crest shape or the inverse Gerstner displacement.
      steepness: 0,
      groupiness: 1,
    },
    secondary: noSwell(),
    windSeaSteepness: 0,
    roughness: { ...defaultRoughness(), fineRoughness: 0, detailStrength: 0 },
    whitewater: { ...defaultWhitewater(), generation: 0, sprayIntensity: 0 },
    purpose: 'DIAGNOSTIC',
    notes: 'Exactly one sinusoidal deep-water component for encounter-frequency validation.',
  };
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function normaliseDegrees(value: number): number {
  const normalised = ((value % 360) + 360) % 360;
  return Math.abs(normalised - 360) < 1e-9 ? 0 : normalised;
}

function measureUpwardCrossingPeriod(
  waves: WaveField,
  velocity: HorizontalVector,
  sampleHz: number,
  measurementSeconds: number,
): { periodSeconds: number; crossings: number } {
  const dt = 1 / sampleHz;
  const samples = Math.round(measurementSeconds * sampleHz);
  let x = 0;
  let z = 0;
  let previousTime = 0;
  let previousHeight = waves.sampleHeight(x, z);
  const crossings: number[] = [];

  for (let sample = 1; sample <= samples; sample++) {
    waves.advance(dt);
    x += velocity.x * dt;
    z += velocity.z * dt;
    const time = sample * dt;
    const height = waves.sampleHeight(x, z);
    if (previousHeight < 0 && height >= 0) {
      const fraction = -previousHeight / (height - previousHeight);
      crossings.push(previousTime + fraction * dt);
    }
    previousHeight = height;
    previousTime = time;
  }

  if (crossings.length < 3) {
    throw new Error(`single-wave encounter produced only ${crossings.length} upward crossings`);
  }
  return {
    periodSeconds: (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1),
    crossings: crossings.length,
  };
}

/**
 * Measure the existing WaveField along four prescribed tracks and compare it
 * with the deep-water encounter relation. This exercises the real CPU sampler,
 * including its time and local-coordinate conventions.
 */
export function buildSingleWaveEncounterEvidence(options: {
  waveTravelHeadingDeg?: number;
  wavePeriodSeconds?: number;
  speedThroughWaterMps?: number;
  sampleHz?: number;
  measurementSeconds?: number;
} = {}): SingleWaveEncounterEvidence {
  const waveTravelHeadingDeg = options.waveTravelHeadingDeg ?? 0;
  const wavePeriodSeconds = options.wavePeriodSeconds ?? 8;
  const speedThroughWaterMps = options.speedThroughWaterMps ?? 4;
  const sampleHz = options.sampleHz ?? 240;
  const measurementSeconds = options.measurementSeconds ?? 80;

  if (!Number.isFinite(wavePeriodSeconds) || wavePeriodSeconds <= 0) {
    throw new Error(`wave period must be finite and positive, got ${wavePeriodSeconds}`);
  }
  if (!Number.isFinite(sampleHz) || sampleHz <= 0) {
    throw new Error(`sample frequency must be finite and positive, got ${sampleHz}`);
  }
  if (!Number.isFinite(measurementSeconds) || measurementSeconds <= 0) {
    throw new Error(
      `measurement duration must be finite and positive, got ${measurementSeconds}`,
    );
  }

  // Validate speed once even if a caller supplies an empty/changed case table.
  prescribedThroughWaterVelocity(0, speedThroughWaterMps);
  const seaState = singleWaveSeaState(wavePeriodSeconds, waveTravelHeadingDeg);
  const spectrum = resolveSeaState(seaState, SINGLE_WAVE_BUDGET);
  if (spectrum.components.length !== 1 || spectrum.components[0].amplitude <= 0) {
    throw new Error('encounter diagnostic did not resolve to exactly one live wave');
  }

  const component = spectrum.components[0];
  const waveNumber = TWO_PI / component.wavelength;
  const intrinsicAngularFrequency = Math.sqrt(GRAVITY * waveNumber);
  const intrinsicPeriod = TWO_PI / intrinsicAngularFrequency;
  const waveDirection = { x: component.dirX, z: component.dirZ };
  // The spectral carrier deliberately receives a tiny deterministic direction
  // jitter so it cannot exactly duplicate another system. Define diagnostic
  // aspects from the direction that was actually resolved, not the request.
  const resolvedWaveTravelHeadingDeg = normaliseDegrees(
    Math.atan2(component.dirX, -component.dirZ) / DEG,
  );
  const cases: SingleWaveEncounterCase[] = [];

  for (const definition of ENCOUNTER_CASES) {
    const vesselHeadingDeg = normaliseDegrees(
      resolvedWaveTravelHeadingDeg + definition.relativeHeadingDeg,
    );
    const velocity = prescribedThroughWaterVelocity(
      vesselHeadingDeg,
      speedThroughWaterMps,
    );
    const projectedSpeed = waveDirection.x * velocity.x + waveDirection.z * velocity.z;
    const expectedAngularFrequency = deepWaterEncounterAngularFrequency(
      waveNumber,
      waveDirection,
      velocity,
    );
    const measurement = measureUpwardCrossingPeriod(
      new WaveField(seaState, SINGLE_WAVE_BUDGET),
      velocity,
      sampleHz,
      measurementSeconds,
    );
    const measuredAngularFrequency = TWO_PI / measurement.periodSeconds;

    cases.push({
      aspect: definition.aspect,
      vesselHeadingDeg: round(vesselHeadingDeg, 6),
      relativeHeadingDeg: definition.relativeHeadingDeg,
      projectedSpeedAlongWaveMps: round(projectedSpeed),
      expectedAngularFrequencyRadPerSecond: round(expectedAngularFrequency),
      measuredAngularFrequencyRadPerSecond: round(measuredAngularFrequency),
      expectedPeriodSeconds: round(TWO_PI / expectedAngularFrequency),
      measuredPeriodSeconds: round(measurement.periodSeconds),
      relativeFrequencyError: round(
        Math.abs(measuredAngularFrequency - expectedAngularFrequency) /
          expectedAngularFrequency,
        10,
      ),
      measuredUpwardCrossings: measurement.crossings,
    });
  }

  return {
    formatVersion: ENCOUNTER_EVIDENCE_FORMAT_VERSION,
    note:
      'Deterministic single-wave encounter-frequency evidence. The same CPU WaveField ' +
      'sampled by buoyancy is evaluated along prescribed bow-forward tracks.',
    limitations: [
      'This validates relative wave timing, not force-integrated surge, sway, yaw or propulsion.',
      'The diagnostic wave is a pure sinusoid; production seas still use up to 48 components.',
      'Speed is through still mean water: current, leeway and wind are intentionally absent.',
    ],
    regenerateCommand: 'npm run ship:encounter',
    configuration: {
      requestedWaveTravelHeadingDeg: round(waveTravelHeadingDeg, 6),
      resolvedWaveTravelHeadingDeg: round(resolvedWaveTravelHeadingDeg, 6),
      requestedWavePeriodSeconds: round(wavePeriodSeconds),
      resolvedWavelengthMetres: round(component.wavelength),
      resolvedIntrinsicPeriodSeconds: round(intrinsicPeriod),
      resolvedPhaseSpeedMps: round(intrinsicAngularFrequency / waveNumber),
      speedThroughWaterMps: round(speedThroughWaterMps),
      sampleHz,
      measurementSeconds,
    },
    cases,
  };
}
