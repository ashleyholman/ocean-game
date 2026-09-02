/**
 * Types for the benchmark suite definitions, so a test can hold
 * `scenarioFaults` to its contract without the module being rewritten in
 * TypeScript. The runner itself is plain ESM and stays that way: it is
 * launched by `node` directly, with no build step between edit and run.
 */

export interface ScenarioOrbitCamera {
  kind: 'orbit';
  label?: string;
  distanceM: number;
  altitudeM: number;
}

export interface ScenarioStandCamera {
  kind: 'stand';
  label?: string;
  /** A `src/vessel/schooner/stations.ts` name. */
  stand: string;
  /** Yaw 0 = toward the bow, 180 = the stern; positive pitch up. */
  lookYawDeg: number;
  lookPitchDeg: number;
}

export interface BenchmarkScenario {
  id: string;
  label?: string;
  time?: string;
  timeOffsetHours?: number;
  seaState?: string;
  seaLabel?: string;
  camera: ScenarioOrbitCamera | ScenarioStandCamera;
  /** Forced lantern mode, or null to leave the session's own policy alone. */
  lamps?: 'auto' | 'on' | 'off' | null;
  /** Lantern occlusion-shadow arm, or null to leave it alone. */
  lampsShadow?: boolean | null;
  attribution?: boolean;
  historicalReferenceMs?: number;
}

/** What the page reports back after a scenario has been applied. */
export interface AppliedScenario {
  cameraMode?: string;
  eye?: { x: number; y: number; z: number };
  standResolved?: { x: number; z: number };
  standRefused?: boolean;
  lookYawDeg?: number;
  lookPitchDeg?: number;
  lamps?: string;
  lampsShadow?: boolean;
}

export interface ScenarioToleranceOptions {
  positionToleranceM?: number;
  angleToleranceDeg?: number;
}

export const BASE_WORLD_UTC_SECONDS: number;
export const RENDER_SURFACE: Readonly<{
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  backingWidth: number;
  backingHeight: number;
}>;
export const HISTORICAL_REFERENCES: Readonly<Record<string, number>>;
export const SUITES: Readonly<Record<string, readonly BenchmarkScenario[]>>;
export const DEFAULT_MEASUREMENT: Readonly<Record<string, unknown>>;

export function buildSuiteConfig(
  name: string,
  overrides?: Record<string, unknown>,
): Record<string, unknown>;

/** Every way the applied frame differs from what the scenario asked for. */
export function scenarioFaults(
  scenario: BenchmarkScenario,
  actual: AppliedScenario,
  options?: ScenarioToleranceOptions,
): string[];

/** Throw unless the frame about to be measured is the one the suite asked for. */
export function assertScenarioApplied(
  scenario: BenchmarkScenario,
  actual: AppliedScenario,
  options?: ScenarioToleranceOptions,
): void;
