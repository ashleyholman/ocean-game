import type * as THREE from 'three';

import type { CameraSystem } from '../../camera/CameraSystem';
import type { SeaStateController } from '../../ocean/SeaStateController';
import type { SeaState } from '../../ocean/seaState';
import type { CrestSpray } from '../../scene/CrestSpray';
import type { FoamField } from '../../scene/FoamField';
import type { FoamLookup } from '../../scene/foamLookup';
import type { HullSprayEventDetector } from '../../scene/hullSprayEvents';
import type { Ocean } from '../../scene/Ocean';
import type { SkySystem } from '../../scene/SkySystem';
import type { StarField } from '../../scene/StarField';
import type { TimeOfDay } from '../../scene/TimeOfDay';
import type { WaveField } from '../../scene/Waves';
import type { WindSystem } from '../../scene/WindSystem';
import type {
  WakeBowPolicyResult,
  WakePatternPolicyResult,
  WakeTrailPolicyResult,
} from '../../scene/wakePolicy';
import type { Vessel } from '../../vessel/Vessel';
import type { RuntimeSailClothMode } from '../RuntimeOptions';
import type { WakeSources } from '../../vessel/WakeSources';
import type { PlanetaryWorld } from '../../world/PlanetaryWorld';
import type {
  WakeBowFeature,
  WakeTrailFeature,
} from '../WakePresentationController';

export type {
  WakeBowFeature,
  WakeTrailFeature,
} from '../WakePresentationController';

export interface OceanDetailContactSheet {
  title: string;
  condition: string;
  captures: Array<{ label: string; dataUrl: string }>;
}

export interface WakeDiagnosticMotionState {
  prescribed: boolean;
  targetSpeedMps: number;
  trueHeadingRad: number;
  leewayRad: number;
}

export type OceanDetailContactSheetSet = 'previous-round' | 'smaller-caches';
export type OceanDetailContactSheetView = 'current' | 'embodied-down';

/**
 * The exact subset of the compatibility facade one diagnostic tool may use.
 *
 * `SimHandle` remains the runtime-compatible superset. Ordinary tools should
 * name their own key union through this alias so adding a new facade member
 * does not silently expand their authority.
 */
export type SimCapability<K extends keyof SimHandle> = Pick<SimHandle, K>;

/**
 * Everything the diagnostic harness is allowed to touch. Exposing one explicit
 * surface keeps the harness from reaching into module internals, and keeps the
 * production path readable.
 */
export interface SimHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  cameras: CameraSystem;
  vessel: Vessel;
  ocean: Ocean;
  waves: WaveField;
  wind: WindSystem;
  world: PlanetaryWorld;
  sky: SkySystem;
  stars: StarField;
  lighting: TimeOfDay;
  foam: FoamField;
  crestSpray: CrestSpray;
  /** WK0 contact condensation; values are overwritten after every physics frame. */
  wakeSources: WakeSources;
  seaStates: SeaStateController;
  /** Scale the airborne salt loading. Lab only; production runs at 1. */
  setSaltScale(scale: number): void;
  stepSimulation(dt: number): void;
  renderFrame(): void;
  /** Presentation seconds since the harness last reset. */
  elapsed(): number;
  /** Presentation origin of the wave field, including production encounter travel. */
  originX(): number;
  originZ(): number;
  setPresentationOrigin(x: number, z: number): void;
  /** Re-derive lighting after the harness moves the canonical instant. */
  refreshLighting(): void;
  /**
   * Rebuild and publish the world probe synchronously, before a captured frame.
   *
   * Separate from `refreshLighting` on purpose. That one is called 720 times
   * while the contact sheet searches the day for a solar elevation, and only
   * ever needs the astronomy; forcing a source render, a PMREM and a blocking
   * readback on each of those would turn a sheet into a coffee break. This is
   * called once, after the instant is settled and before the shot is taken.
   */
  refreshWorldLighting(): void;
  /** The world radiance source's render target, for the lab audit. */
  worldLightingSourceTarget(): THREE.WebGLRenderTarget;
  /** Live SH coefficients, for the lab audit. */
  worldLightingCoefficients(): Float32Array;
  /** Probe irradiance at three normals, plus sun and exposure, for evidence. */
  worldLightingDiagnostics(): {
    generation: number;
    up: number;
    side: number;
    down: number;
    sun: number;
    exposure: number;
  };
  setExposureBias(value: number): void;
  /**
   * Adopt a sea state. `transitionSeconds <= 0` snaps, which is what every
   * deterministic capture wants; anything larger morphs continuously.
   */
  setSeaState(state: SeaState, transitionSeconds?: number): void;
  /** Hold the foam history still without stopping it being drawn. */
  setFoamFrozen(frozen: boolean): void;
  /** Diagnostic: stop the foam field carrying its contents downwind. */
  setFoamAdvectionEnabled(enabled: boolean): void;
  readonly foamAdvectionEnabled: () => boolean;
  /**
   * Move only the detail-noise origin, leaving the wave field untouched. The
   * detail stack is exactly periodic; the wave field is not, so this is the
   * only way to test wrap continuity without the waves changing underneath it.
   */
  setDetailOriginOverride(x: number | null, z?: number): void;
  setFoamStrength(value: number): void;
  /** Master kill-switch for all hull-sourced water effects from WK1 onward. */
  setWakeEffectsEnabled(enabled: boolean): void;
  readonly wakeEffectsEnabled: () => boolean;
  /** Independent WK1 A/B levers; the master gates all four at consumption. */
  setWakeTrailFeatureEnabled(feature: WakeTrailFeature, enabled: boolean): void;
  readonly wakeTrailFeatureEnabled: (feature: WakeTrailFeature) => boolean;
  /** Stable live policy result for diagnostics; consumers must not mutate it. */
  readonly wakeTrailPolicy: Readonly<WakeTrailPolicyResult>;
  /** Independent WK2 A/B levers, all still gated by the wake master. */
  setWakeBowFeatureEnabled(feature: WakeBowFeature, enabled: boolean): void;
  readonly wakeBowFeatureEnabled: (feature: WakeBowFeature) => boolean;
  /** Stable live WK2 policy result for evidence and the Ocean Lab. */
  readonly wakeBowPolicy: Readonly<WakeBowPolicyResult>;
  /** Stable live WK-R4 wave-pattern policy result for the Ocean Lab. */
  readonly wakePatternPolicy: Readonly<WakePatternPolicyResult>;
  /**
   * WK3's live entry-tear detector.
   *
   * Exposed whole rather than flattened into a policy line, because the
   * question an episodic effect always raises is "why did nothing happen just
   * then" — and answering it needs the drive, its threshold and whether a tear
   * is open, read at the same instant.
   */
  readonly hullSprayEvents: HullSprayEventDetector;
  /** Lab-only density multiplier for real bow-entry events; production is 1. */
  setHullSprayDensityScale(scale: number): void;
  readonly hullSprayDensity: () => number;
  /** Current speed through water; current is absent, so this is encounter speed. */
  readonly wakeSpeedThroughWaterMps: () => number;
  /**
   * Foam-field reconstruction A/B. Legacy is the 0.9-texel sample jitter that
   * WK-R's sharper field turned into blotching; off is the quintic warp that
   * removes the grid artifact without displacing the sample.
   */
  setFoamLookupLegacy(legacy: boolean): void;
  readonly foamLookupLegacy: () => boolean;
  /** Hand-set lab override of the two lookup levers; clamped on the way in. */
  setFoamLookupValues(jitterTexels: number, smoothing: number): void;
  readonly foamLookup: Readonly<FoamLookup>;
  /** Captive, presentation-evidence motion; never used by free production sailing. */
  readonly wakeDiagnosticMotionState: () => WakeDiagnosticMotionState;
  setWakeDiagnosticTow(
    speedMps: number,
    trueHeadingRad: number,
    leewayRad: number,
  ): void;
  restoreWakeDiagnosticMotion(state: Readonly<WakeDiagnosticMotionState>): void;
  /**
   * M6's sail presentation, read back from the rig that was actually lofted.
   *
   * `?cloth=` is parsed into `RuntimeOptions` and handed to `VesselRuntime`,
   * which kept it in a private field — so the A/B registry, whose one entry
   * requirement is a real read-back, could not carry it, and REVIEW_QUEUE 2.6
   * could not be given a sheet. `VesselRuntime.sailClothMode` says why the value
   * is derived from the loft state rather than echoed from the option.
   */
  readonly sailClothMode: () => RuntimeSailClothMode;
  /**
   * Capture only: put her on a signed true wind angle off the bow, degrees.
   *
   * Returns the angle that took. See `VesselRuntime.poseOnTrueWindAngleDeg`.
   */
  poseOnTrueWindAngleDeg(angleDeg: number): number;
  /** Deterministic WK1 reference-state/component A/B sheet. */
  runWakeContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /** Deterministic WK2 reference-state/component A/B sheet. */
  runWakeWk2ContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /**
   * Diagnostic kill-switch for the cloud layer — removes it from the dome,
   * the water's reflection and the haze in one move.
   */
  setCloudsEnabled(enabled: boolean): void;
  /** Switch ocean gas-sky reads between the cached and analytic shaders. */
  setSkyRadianceLutEnabled(enabled: boolean): void;
  /** Live ocean-detail temporal A/B; changing it discards accumulated history. */
  setOceanTemporalEnabled(enabled: boolean): void;
  readonly oceanTemporalEnabled: () => boolean;
  /** Friendly 0..100 control over the nonlinear temporal history weight. */
  setOceanTemporalStability(stability: number): void;
  readonly oceanTemporalStability: () => number;
  /** Toggle the hull's analytic bite out of the sky hemisphere. */
  setVesselSkyOcclusion(enabled: boolean): void;
  readonly vesselSkyOcclusionEnabled: () => boolean;
  /** Toggle real directional hull + displaced-wave shadowing. */
  /** How much of the direct beam a shadow removes, 0-1. */
  sunShadowStrength(): number;
  setSunShadowStrength(strength: number): void;
  setSunShadowing(enabled: boolean): void;
  /** Toggle the active vessel's real point-light hull shadowing. */
  setLanternShadowing(enabled: boolean): void;
  readonly shadowingState: () => {
    sun: boolean;
    sunActive: boolean;
    lantern: boolean;
    lanternActive: boolean;
  };
  /** Bracket the full-frame cost of geometry sun and active-lantern shadows. */
  runDirectShadowBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /**
   * Freeze the view and run the compile-time ocean component sweep. Progress
   * and the final copyable report are delivered to the graphics panel.
   */
  runOceanProfileProbe(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Bracket full legacy and active-window oceans with raw GPU timers. */
  runOceanResidualActiveBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Bracket the complete active-window ocean with five vs zero detail octaves. */
  runOceanDetailBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Bracket analytic and the selected replacement representation with GPU timers. */
  runOceanDetailRepresentationBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Capture identical frozen frames for user visual judgment. */
  runOceanDetailContactSheet(
    set: OceanDetailContactSheetSet,
    view: OceanDetailContactSheetView,
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /** Capture legacy cloud-in-haze A beside the stable gas-only-haze B. */
  runOceanCloudHazeContactSheet(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /**
   * Photograph and measure five seas across four views. `name` is the artefact
   * stem, so a change can be bracketed by running it twice.
   */
  runOceanViolenceEvidence(
    name: string,
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /** Photograph the foam coverage gain ladder for a visual decision. */
  runFoamGainLadder(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /** Photograph five levers of the ocean's shape, five rungs each. */
  runShapeLadder(
    onProgress: (report: string) => void,
  ): Promise<OceanDetailContactSheet>;
  /** Bracket the cost of the whitewater layer actually being drawn. */
  runWhitewaterCostBenchmark(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Measure live detail octaves in the current frozen view. */
  runOceanDetailCategoryProbe(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Measure live detail octaves across representative sea/camera conditions. */
  runOceanDetailCategoryMatrix(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Measure per-fragment residual categories in the current frozen view. */
  runOceanResidualCategoryProbe(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /** Required close/medium/maximum category matrix across representative seas. */
  runOceanResidualCategoryMatrix(
    onProgress: (report: string) => void,
  ): Promise<string>;
  /**
   * Frozen-frame pixel diff of the structural residual-loop variants against
   * the shipping loop, bracketed by a shipping-vs-shipping control row.
   */
  runOceanResidualDiff(
    onProgress: (report: string) => void,
  ): Promise<string>;
  clearFoam(): void;
  /** Run the foam field to its steady state for the current sea. */
  warmFoam(): void;
  /**
   * Restart from a known state: t = 0, chosen sea state, chosen wave origin.
   *
   * THE PROPERTY THIS CARRIES, AND WHAT IT COST TO GET
   * --------------------------------------------------
   * Two calls with the same arguments must leave the simulation in the same
   * state, whatever ran in between. That is the whole basis of "the same
   * request produces the same frame", and it was not true: staging one scene
   * twice on a page differed over 54-94% of its pixels, mean 2.6-4.3 of 255,
   * against 0.04 for two fresh pages each staging once.
   *
   * Every cause had the same shape — an owner holding state this function
   * could not reach — in two recurring kinds:
   *
   * - **Low passes with no way home.** The sky's auto-exposure, the scotopic
   *   rod dominance, the metered interior gain. Each has a multi-second
   *   constant and a first-frame latch, so it climbs across a session and
   *   never comes back down. Cleared through `resetAdaptation`.
   * - **Amortized work with a cursor.** The cloud tile scheduler's round
   *   robin, the sky probe's 256 directions, the solar disc's 16 samples. A
   *   cursor is state even when every value it fills is a pure function of the
   *   scene, because *which* of them are current depends on where the cursor
   *   was. Cleared through `resetCaches` and `resetAdaptation`.
   *
   * A third cause looked like honest floating-point divergence and was not:
   * the canonical voyage keeps sailing while the clock is paused (the geodesic
   * advance is independent of it) and nothing restored its velocity, so the
   * second staging began under way. See `PlanetaryWorld.restoreOpeningVoyage`.
   *
   * The guard is `tests/restage-determinism.test.ts`, which runs, restarts,
   * runs again and compares state rather than pixels so it works in node. Add
   * an integrator or an amortized cursor to anything this function touches and
   * you owe it a reset here and a field in that test's state vector.
   */
  resetSimulation(
    state: SeaState,
    originX: number,
    originZ: number,
  ): void;
}
