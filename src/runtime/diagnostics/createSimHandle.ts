import * as THREE from 'three';

import { OceanTemporalResolve } from '../../render/OceanTemporalResolve';
import { clampFoamLookup, resolveFoamLookup } from '../../scene/foamLookup';
import type { FoamLookup } from '../../scene/foamLookup';
import type { WorldLighting } from '../../scene/WorldLighting';
import type {
  VesselMotionDebugControls,
  VesselSpeedTarget,
} from '../../vessel/VesselMotion';
import type { WakePresentationController } from '../WakePresentationController';
import type { RuntimeDiagnostics } from './RuntimeDiagnosticsContract';
import type { SeaState } from '../../ocean/seaState';
import type { RuntimeSailClothMode } from '../RuntimeOptions';
import type { SimHandle } from './SimHandle';

/** Stable synchronous indirection for consumers constructed before SimHandle. */
export interface SimHandleBinding {
  readonly get: () => SimHandle;
  bind(handle: SimHandle): SimHandle;
}

/**
 * Create the one-shot live binding shared by lazy UI and diagnostics hosts.
 *
 * Browser module evaluation is run-to-completion: the binding is filled before
 * a panel, evidence host, or animation callback can run. Explicit failures keep
 * accidental early or repeated binding as visible as the old const/TDZ cycle.
 */
export function createSimHandleBinding(): SimHandleBinding {
  let handle: SimHandle | undefined;
  const get = (): SimHandle => {
    if (!handle) throw new Error('SimHandle has not been bound');
    return handle;
  };

  return {
    get,
    bind(nextHandle) {
      if (handle) throw new Error('SimHandle has already been bound');
      handle = nextHandle;
      return nextHandle;
    },
  };
}

/** Concrete resources intentionally exposed by the compatibility handle. */
export type SimHandleResources = Pick<
  SimHandle,
  | 'renderer'
  | 'scene'
  | 'canvas'
  | 'cameras'
  | 'vessel'
  | 'ocean'
  | 'waves'
  | 'wind'
  | 'world'
  | 'sky'
  | 'stars'
  | 'lighting'
  | 'foam'
  | 'crestSpray'
  | 'wakeSources'
  | 'seaStates'
> & {
  /**
   * The present wind. WX1 reported this facade as a divergence-in-waiting and
   * WX2 closed it: `foamOptions()` below used to hand the foam field
   * `sea.wind.speedMps` where production hands it `worldWind.meanSpeedMps`.
   * Those were the same float until weather existed and are not any more, so a
   * diagnostic capture would otherwise have simulated a different frame from
   * the one the game draws, silently, and only once the weather moved.
   */
  readonly worldWind: { readonly meanSpeedMps: number };
  /**
   * Called when a sea is deliberately *chosen* — a preset button, a lab
   * slider, a capture host setting its scene. Not called by the wind-sea
   * memory's own commands, which are the sea answering the wind rather than
   * anybody picking one. See `src/ocean/WindSeaMemory.ts`.
   */
  readonly onSeaStateChosen?: (state: SeaState) => void;
};

/** Authoritative deterministic stepping and clock operations. */
export interface SimHandleSimulationPort {
  stepSimulation(
    presentationDeltaSeconds: number,
    rawRealDeltaSeconds?: number,
  ): void;
  renderFrame(): void;
  readonly elapsedSeconds: number;
  /**
   * Rewind the presentation clock, and with it every latch derived from it.
   *
   * Implementors must rebase their own per-frame delta latches here. The
   * runtime turns this clock into deltas by subtracting a remembered value, so
   * a rewind that leaves those remembered values in the future silently hands
   * `dt = 0` to the voyage clock and the observer's rod adaptation until the
   * clock has climbed back past them.
   */
  setElapsedSeconds(elapsedSeconds: number): void;
  resetHorizontalMotion?(): void;
}

/**
 * Presentation state remains owned by the browser runtime. Accessors let the
 * compatibility facade manipulate those same live bindings without copying or
 * relocating them.
 */
export interface SimHandlePresentationPort {
  readonly worldLighting: WorldLighting;
  readonly encounterVelocity: { x: number; z: number };
  readonly sunShadow: { intensity: number };
  readonly foamLookup: FoamLookup;

  refreshLighting(): void;
  refreshWorldLighting(): void;
  /**
   * Rewind every per-frame integrator that only the composition root can reach.
   *
   * One call rather than four, because these are spread across owners a
   * diagnostic caller has no business knowing about individually, and they are
   * all the same kind of thing — state the frame loop advances by hand, which
   * therefore remembers a scene the rest of the world has forgotten:
   *
   * - the sky's auto-exposure and its two amortized round robins (`TimeOfDay`);
   * - the rod dominance of the scotopic present (`ScenePresentPass`);
   * - the schooner's metered interior gain;
   * - the gust clock the wind's whole gust series is a function of
   *   (`WorldWind`).
   *
   * The first three are low passes over the session with no way back. The
   * fourth is an ordinary accumulating clock. All four have to be rewound
   * together, or a restart exposes the picture for the scene before it and
   * sails it in the previous scene's gust.
   */
  resetIntegrators(): void;
  setSunShadowing(enabled: boolean): void;
  setLanternShadowing(enabled: boolean): void;
  shadowingState(): ReturnType<SimHandle['shadowingState']>;

  exposureBias: number;
  foamFrozen: boolean;
  foamAdvectionEnabled: boolean;
  foamStrength: number;
  foamLookupLegacy: boolean;
  saltScale: number;
  oceanTemporal: OceanTemporalResolve | undefined;
  oceanTemporalStability: number;
}

/** Wake presentation plus the exceptional captive-tow diagnostic controls. */
export interface SimHandleWakePort {
  readonly presentation: WakePresentationController;
  readonly speedTarget: Pick<
    VesselSpeedTarget,
    'isPrescribed' | 'targetSpeedMps'
  >;
  readonly motionControls: Pick<
    VesselMotionDebugControls,
    'trueHeadingRad' | 'setTrueHeadingRad' | 'releaseTow'
  >;
  prescribeVesselSpeedMps(speedMps: number): void;
  diagnosticTowLeewayRad: number;
  /** M6's sail presentation, read back from the rig that was lofted. */
  readonly sailClothMode: () => RuntimeSailClothMode;
  /** Capture staging: a signed true wind angle off the bow, degrees. */
  poseOnTrueWindAngleDeg(angleDeg: number): number;
}

/**
 * Assemble the broad legacy diagnostic facade from cohesive runtime ports.
 *
 * This function owns no live runtime state. Property order and direct resource
 * identities intentionally match the former object literal in the entry module.
 */
export function createSimHandle(
  resources: SimHandleResources,
  simulation: SimHandleSimulationPort,
  presentation: SimHandlePresentationPort,
  wake: SimHandleWakePort,
  runtimeDiagnostics: RuntimeDiagnostics,
): SimHandle {
  function foamOptions(): Parameters<SimHandleResources['foam']['update']>[3] {
    const sea = resources.seaStates.state;
    return {
      windDir: resources.wind.direction,
      windSpeed: resources.worldWind.meanSpeedMps,
      generation: sea.whitewater.generation,
      persistenceSeconds: sea.whitewater.persistenceSeconds,
      gustiness: sea.generatingWind.gustiness,
      streak: sea.roughness.gustStreak,
      windAdvection: presentation.foamAdvectionEnabled
        ? sea.whitewater.windAdvection
        : 0,
      observerVelocity: presentation.encounterVelocity,
      noiseTime: simulation.elapsedSeconds % 1800,
      frozen: false,
      hullWake: wake.presentation.foamHullWakeSource,
      waterlineWake: wake.presentation.foamWaterlineWakeSource,
    };
  }

  return {
    renderer: resources.renderer,
    scene: resources.scene,
    canvas: resources.canvas,
    cameras: resources.cameras,
    vessel: resources.vessel,
    ocean: resources.ocean,
    waves: resources.waves,
    wind: resources.wind,
    world: resources.world,
    sky: resources.sky,
    stars: resources.stars,
    lighting: resources.lighting,
    foam: resources.foam,
    crestSpray: resources.crestSpray,
    wakeSources: resources.wakeSources,
    seaStates: resources.seaStates,
    stepSimulation: (dt) => simulation.stepSimulation(dt),
    renderFrame: simulation.renderFrame,
    elapsed: () => simulation.elapsedSeconds,
    originX: () => resources.waves.originWorldX,
    originZ: () => resources.waves.originWorldZ,
    setPresentationOrigin(x, z) {
      resources.waves.setOrigin(x, z);
      presentation.oceanTemporal?.invalidate();
    },
    refreshLighting: presentation.refreshLighting,
    refreshWorldLighting: presentation.refreshWorldLighting,
    worldLightingSourceTarget: () => presentation.worldLighting.source.target,
    worldLightingCoefficients: () => presentation.worldLighting.shCoefficients,
    worldLightingDiagnostics: () => {
      const up = presentation.worldLighting.skyIrradiance(
        new THREE.Vector3(0, 1, 0),
      );
      const side = presentation.worldLighting.skyIrradiance(
        new THREE.Vector3(1, 0, 0),
      );
      const down = presentation.worldLighting.skyIrradiance(
        new THREE.Vector3(0, -1, 0),
      );
      const lum = (e: [number, number, number]): number =>
        0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2];
      return {
        generation: presentation.worldLighting.publishedGeneration,
        up: lum(up),
        side: lum(side),
        down: lum(down),
        sun: resources.lighting.sunLightIntensity,
        exposure: resources.lighting.exposure,
      };
    },
    setExposureBias: (value) => {
      presentation.exposureBias = value;
    },
    setSeaState(state, transitionSeconds = 0) {
      // A chosen sea, not the sea answering the wind — so the wind-sea memory
      // forgets what grew the last one and weather re-declares the present
      // wind as this state's. Without that, selecting FLAT under a live glass
      // would be dragged back toward whatever the weather is blowing within
      // seconds, and the ocean laboratory's presets would stop meaning
      // anything.
      resources.onSeaStateChosen?.(state);
      resources.seaStates.set(state, transitionSeconds);
      if (transitionSeconds <= 0) {
        resources.waves.applySeaState(resources.seaStates.state);
        resources.waves.frozen = resources.seaStates.state.frozen === true;
        resources.ocean.refresh();
        presentation.oceanTemporal?.invalidate();
      }
    },
    setFoamFrozen(frozen) {
      presentation.foamFrozen = frozen;
    },
    setFoamAdvectionEnabled(enabled) {
      presentation.foamAdvectionEnabled = enabled;
    },
    foamAdvectionEnabled: () => presentation.foamAdvectionEnabled,
    setDetailOriginOverride(x, z = 0) {
      resources.ocean.setDetailOriginOverride(
        x === null ? null : new THREE.Vector2(x, z),
      );
      presentation.oceanTemporal?.invalidate();
    },
    setFoamStrength(value) {
      presentation.foamStrength = value;
    },
    setWakeEffectsEnabled(enabled) {
      wake.presentation.setWakeEffectsEnabled(enabled);
    },
    wakeEffectsEnabled: () => wake.presentation.wakeEffectsEnabled(),
    setWakeTrailFeatureEnabled(feature, enabled) {
      wake.presentation.setWakeTrailFeatureEnabled(feature, enabled);
    },
    wakeTrailFeatureEnabled(feature) {
      return wake.presentation.wakeTrailFeatureEnabled(feature);
    },
    wakeTrailPolicy: wake.presentation.wakeTrailPolicy,
    setWakeBowFeatureEnabled(feature, enabled) {
      wake.presentation.setWakeBowFeatureEnabled(feature, enabled);
    },
    wakeBowFeatureEnabled(feature) {
      return wake.presentation.wakeBowFeatureEnabled(feature);
    },
    wakeBowPolicy: wake.presentation.wakeBowPolicy,
    wakePatternPolicy: wake.presentation.wakePatternPolicy,
    hullSprayEvents: wake.presentation.hullSprayEvents,
    setHullSprayDensityScale: (scale) =>
      wake.presentation.setHullSprayDensityScale(scale),
    hullSprayDensity: () => wake.presentation.hullSprayDensity(),
    wakeSpeedThroughWaterMps: () =>
      wake.presentation.wakeSpeedThroughWaterMps(),
    setFoamLookupLegacy(legacy) {
      presentation.foamLookupLegacy = legacy;
      resources.ocean.setFoamLookup(
        resolveFoamLookup(legacy, presentation.foamLookup),
      );
    },
    foamLookupLegacy: () => presentation.foamLookupLegacy,
    setFoamLookupValues(jitterTexels, smoothing) {
      // A hand-set value leaves the named A/B arms behind, so the switch stops
      // claiming to describe what is on screen.
      presentation.foamLookupLegacy = false;
      clampFoamLookup(
        { jitterTexels, smoothing },
        presentation.foamLookup,
      );
      resources.ocean.setFoamLookup(presentation.foamLookup);
    },
    foamLookup: presentation.foamLookup,
    wakeDiagnosticMotionState: () => ({
      prescribed: wake.speedTarget.isPrescribed,
      targetSpeedMps: wake.speedTarget.targetSpeedMps,
      trueHeadingRad: wake.motionControls.trueHeadingRad(),
      leewayRad: wake.diagnosticTowLeewayRad,
    }),
    setWakeDiagnosticTow(speedMps, trueHeadingRad, leewayRad) {
      if (!Number.isFinite(trueHeadingRad) || !Number.isFinite(leewayRad)) {
        throw new RangeError('wake diagnostic heading and leeway must be finite');
      }
      wake.prescribeVesselSpeedMps(speedMps);
      wake.diagnosticTowLeewayRad = leewayRad;
      wake.motionControls.setTrueHeadingRad(trueHeadingRad);
    },
    sailClothMode: wake.sailClothMode,
    poseOnTrueWindAngleDeg(angleDeg) {
      return wake.poseOnTrueWindAngleDeg(angleDeg);
    },
    restoreWakeDiagnosticMotion(state) {
      wake.diagnosticTowLeewayRad = state.leewayRad;
      if (state.prescribed) {
        wake.prescribeVesselSpeedMps(state.targetSpeedMps);
        wake.motionControls.setTrueHeadingRad(state.trueHeadingRad);
      } else {
        wake.motionControls.setTrueHeadingRad(state.trueHeadingRad);
        wake.motionControls.releaseTow();
      }
    },
    runWakeContactSheet: runtimeDiagnostics.runWakeContactSheet,
    runWakeWk2ContactSheet: runtimeDiagnostics.runWakeWk2ContactSheet,
    setCloudsEnabled(enabled) {
      resources.sky.setCloudsEnabled(enabled);
    },
    setSkyRadianceLutEnabled(enabled) {
      resources.sky.setRadianceLutEnabled(enabled);
      resources.ocean.setSkyRadianceLutEnabled(enabled);
    },
    setOceanTemporalEnabled(enabled) {
      if (enabled) {
        if (!presentation.oceanTemporal) {
          presentation.oceanTemporal = new OceanTemporalResolve(
            resources.renderer,
            resources.ocean,
            true,
            resources.sky.mesh,
            [resources.stars.mesh],
          );
          presentation.oceanTemporal.setStability(
            presentation.oceanTemporalStability,
          );
        }
        return;
      }
      presentation.oceanTemporal?.dispose();
      presentation.oceanTemporal = undefined;
      resources.ocean.setTemporalDetailJitter(0, 0);
    },
    oceanTemporalEnabled: () => presentation.oceanTemporal !== undefined,
    setOceanTemporalStability(stability) {
      presentation.oceanTemporalStability = Math.max(
        0,
        Math.min(100, stability),
      );
      presentation.oceanTemporal?.setStability(
        presentation.oceanTemporalStability,
      );
    },
    oceanTemporalStability: () => presentation.oceanTemporalStability,
    setVesselSkyOcclusion(enabled) {
      resources.ocean.setVesselSkyOcclusion(enabled);
    },
    vesselSkyOcclusionEnabled: () => resources.ocean.vesselSkyOcclusionEnabled,
    sunShadowStrength: () => presentation.sunShadow.intensity,
    setSunShadowStrength(strength) {
      presentation.sunShadow.intensity = Math.min(Math.max(strength, 0), 1);
    },
    setSunShadowing: presentation.setSunShadowing,
    setLanternShadowing: presentation.setLanternShadowing,
    shadowingState: presentation.shadowingState,
    runDirectShadowBenchmark: runtimeDiagnostics.runDirectShadowBenchmark,
    runOceanProfileProbe: runtimeDiagnostics.runOceanProfileProbe,
    runOceanDetailBenchmark: runtimeDiagnostics.runOceanDetailBenchmark,
    runOceanDetailRepresentationBenchmark:
      runtimeDiagnostics.runOceanDetailRepresentationBenchmark,
    runOceanDetailContactSheet: runtimeDiagnostics.runOceanDetailContactSheet,
    runOceanCloudHazeContactSheet:
      runtimeDiagnostics.runOceanCloudHazeContactSheet,
    runOceanViolenceEvidence: runtimeDiagnostics.runOceanViolenceEvidence,
    runFoamGainLadder: runtimeDiagnostics.runFoamGainLadder,
    runShapeLadder: runtimeDiagnostics.runShapeLadder,
    runWhitewaterCostBenchmark: runtimeDiagnostics.runWhitewaterCostBenchmark,
    runOceanDetailCategoryMatrix:
      runtimeDiagnostics.runOceanDetailCategoryMatrix,
    runOceanDetailCategoryProbe:
      runtimeDiagnostics.runOceanDetailCategoryProbe,
    runOceanResidualActiveBenchmark:
      runtimeDiagnostics.runOceanResidualActiveBenchmark,
    runOceanResidualCategoryMatrix:
      runtimeDiagnostics.runOceanResidualCategoryMatrix,
    runOceanResidualCategoryProbe:
      runtimeDiagnostics.runOceanResidualCategoryProbe,
    runOceanResidualDiff: runtimeDiagnostics.runOceanResidualDiff,
    setSaltScale(scale) {
      presentation.saltScale = Math.max(scale, 0);
    },
    clearFoam() {
      resources.foam.clear(resources.renderer);
      resources.crestSpray.clear();
    },
    warmFoam() {
      resources.foam.warmUp(
        resources.renderer,
        resources.waves,
        foamOptions(),
      );
    },
    resetSimulation(state, originX, originZ) {
      // CLOCKS FIRST, THEN EVERYTHING THAT READS THEM.
      //
      // The order of this function is a dependency order, and it has already
      // been wrong once in a way nothing caught. These two calls used to sit
      // below the vessel's reset, and `SchoonerSailForces.reset` rebases its
      // wind time on `WorldWind.elapsedSeconds` — so the sail forces were
      // pinned to the OLD gust clock a few lines before that clock was zeroed,
      // and the ship met a different wind on her first substep. Measured on a
      // live page: 1.1e-5 rad of heading after forty settling frames, which
      // survived every other fix in this round until the order was corrected.
      //
      // Nothing below may re-derive from a clock that has not been rewound yet.
      simulation.setElapsedSeconds(0);
      // `sky.reset` is the cloud drift phase and the tile cache; the cache is
      // the largest single term in re-stage non-determinism, and the drift
      // phase was the largest one left after it. `resetIntegrators` is the
      // eye's three meters and the wind's gust clock. All of them are state a
      // frame loop advances by hand, which is exactly the kind a restart
      // forgets. See CloudDome.reset, SkySystem.reset, TimeOfDay.resetAdaptation.
      resources.sky.reset();
      presentation.resetIntegrators();
      // Start with the field already anchored at the requested offset, so a run
      // far from the origin is a genuine test of the wave anchor. A restart is
      // a chosen sea in the fullest sense, so the wind-sea memory is reset with
      // everything else — a harness that restarted twice would otherwise carry
      // the previous scene's developed wind into the new one, which is the same
      // species of leak `WorldWind.reset` was added for.
      resources.onSeaStateChosen?.(state);
      resources.seaStates.set(state, 0);
      resources.waves.applySeaState(state);
      resources.waves.frozen = state.frozen === true;
      resources.waves.setOrigin(originX, originZ);
      resources.waves.setTime(0);
      resources.ocean.refresh();
      presentation.oceanTemporal?.invalidate();
      resources.vessel.body.reset();
      simulation.resetHorizontalMotion?.();
      resources.vessel.resetEffects();
      // A tear in progress is history, and a reset ship has none. Without this
      // the detector differences the new sea's bow volume against the old
      // sea's and fires an entry on the frame the state changes.
      wake.presentation.resetHullSprayEvents();
      resources.crestSpray.clear();
      resources.foam.clear(resources.renderer);
      resources.cameras.reset();
      // One zero-length step settles the active vessel and populates
      // every derived value before anything is measured or drawn. It is also
      // where the rewound clocks above are made good: the meters snap to this
      // instant and the cloud cache begins its first generation.
      simulation.stepSimulation(0);
      // Foam has a memory measured in tens of seconds, so a field starting from
      // zero is visibly wrong for as long as its own longest time constant. Every
      // reset pays that cost immediately rather than showing a clean sea that
      // slowly grows foam.
      resources.foam.warmUp(
        resources.renderer,
        resources.waves,
        foamOptions(),
      );
    },
  };
}
