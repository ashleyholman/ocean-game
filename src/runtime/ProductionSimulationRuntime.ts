import * as THREE from 'three';

import type { Ambience } from '../audio/Ambience';
import type { CameraSystem } from '../camera/CameraSystem';
import type { SeaState } from '../ocean/seaState';
import { whitecapCoverage } from '../ocean/spectrum';
import type { CpuProfiler } from '../render/CpuProfiler';
import type { GpuProfiler } from '../render/GpuProfiler';
import type { FoamField } from '../scene/FoamField';
import { SPRAY_SUN_GAIN, type CrestSpray } from '../scene/CrestSpray';
import { SALT_DENSITY_FULL, type Ocean } from '../scene/Ocean';
import type { TimeOfDay } from '../scene/TimeOfDay';
import type { WaveField } from '../scene/Waves';
import type { WindSystem } from '../scene/WindSystem';
import type { SeaStateController } from '../ocean/SeaStateController';
import type { WindSeaCoupling } from '../ocean/WindSeaMemory';
import type { PresentationClock } from '../world/clock';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import type { WorldWind } from '../world/WorldWind';
import type { EnvironmentRuntime } from './EnvironmentRuntime';
import {
  SimulationFrameTransaction,
  type SimulationFrameStep,
} from './SimulationFrameTransaction';
import type { WeatherSystem } from '../weather/WeatherSystem';
import type { WeatherPresentation } from '../weather/WeatherPresentation';
import { CatsPawField } from '../weather/CatsPawField';
import type { VesselRuntime } from './VesselRuntime';
import type { WakePresentationController } from './WakePresentationController';

/** Canonical clocks, weather, and the physical sea advanced by each frame. */
export interface ProductionSimulationWorldPorts {
  presentationClock: PresentationClock;
  wind: WindSystem;
  world: PlanetaryWorld;
  worldWind: WorldWind;
  seaStates: SeaStateController;
  waves: WaveField;
  /**
   * The present weather. Optional so that diagnostic and evidence hosts, which
   * build their own runtimes, keep the exact behaviour they had before WX1:
   * absent means the sea state's generating wind goes straight through, which
   * is the neutral state.
   */
  weather?: WeatherSystem;
  /**
   * The sea's memory of that weather (WX2). Optional for the same reason, and
   * additionally inert whenever its `coupled` switch is off — decision D5,
   * coupled in play, `Independent` in the lab.
   */
  windSea?: WindSeaCoupling;
}

/** Coordinators that publish vessel, wake, environment, camera, and audio state. */
export interface ProductionSimulationPresentationPorts {
  vessel: VesselRuntime;
  wake: WakePresentationController;
  environment: EnvironmentRuntime;
  cameras: CameraSystem;
  ambience: Ambience;
  /** Optional read-only rain, storm and in-world wind presentation. */
  weather?: WeatherPresentation;
  /**
   * Capture/diagnostic-only precedence for an explicit synthetic-terrain haze.
   *
   * Weather still derives the ordinary frame first. A host which deliberately
   * names `?haze=` can then reassert that terrain-only review condition without
   * changing weather visibility in sessions which did not ask for it.
   */
  applyExplicitTerrainHazeOverride?: () => void;
}

/** Renderer resources consumed by the water and airborne-effect phases. */
export interface ProductionSimulationSurfaceTuning {
  foamFrozen: boolean;
  foamStrength: number;
  saltScale: number;
}

export interface ProductionSimulationSurfacePorts {
  renderer: THREE.WebGLRenderer;
  foam: FoamField;
  crestSpray: CrestSpray;
  ocean: Ocean;
  lighting: TimeOfDay;
  /** Stable live record shared with privileged diagnostic controls. */
  tuning: ProductionSimulationSurfaceTuning;
}

/** Existing named CPU/GPU spans; the coordinator does not reinterpret them. */
export interface ProductionSimulationProfilerPorts {
  cpu: CpuProfiler;
  gpu: GpuProfiler;
}

export interface ProductionSimulationRuntimeOptions {
  world: ProductionSimulationWorldPorts;
  presentation: ProductionSimulationPresentationPorts;
  surface: ProductionSimulationSurfacePorts;
  profilers: ProductionSimulationProfilerPorts;
}

/**
 * Owns the one authoritative production simulation-to-presentation transaction.
 *
 * Browser-presented frames and deterministic evidence both enter through
 * `step`. The seven phase callbacks, profiler spans, and scratch values stay
 * private so no caller can assemble a subtly different frame order.
 */
export class ProductionSimulationRuntime {
  private readonly frameTransaction: SimulationFrameTransaction;
  /** WX3 presentation state; no WaveField or vessel-physics reference. */
  private readonly catsPawField = new CatsPawField();
  private readonly scratchDirection = new THREE.Vector3();
  private frameSeaState!: SeaState;
  private framePresentationElapsedSeconds = 0;
  private frameAmbientWhitecapCoverage = 0;

  constructor(private readonly options: ProductionSimulationRuntimeOptions) {
    this.frameTransaction = new SimulationFrameTransaction({
      advanceWorld: this.advanceWorldPhase,
      integrateVessel: this.integrateVesselPhase,
      deriveEnvironment: this.deriveEnvironmentPhase,
      presentVesselAndCamera: this.presentVesselAndCameraPhase,
      updateSurfaceEffects: this.updateSurfaceEffectsPhase,
      prepareOcean: this.prepareOceanPhase,
      prepareScene: this.prepareScenePhase,
    });
  }

  /**
   * Advance the same authoritative transaction for browser and evidence hosts.
   * Direct diagnostic stepping treats its delta as both clock meanings unless a
   * distinct raw-real delta is supplied.
   */
  readonly step = (
    presentationDeltaSeconds: number,
    rawRealDeltaSeconds = presentationDeltaSeconds,
  ): void => {
    this.frameTransaction.step(
      presentationDeltaSeconds,
      rawRealDeltaSeconds,
    );
  };

  private readonly advanceWorldPhase = (
    step: SimulationFrameStep,
  ): void => {
    const {
      presentationClock,
      seaStates,
      waves,
      weather,
      wind,
      windSea,
      world,
    } = this.options.world;
    const { ocean } = this.options.surface;
    const { vessel } = this.options.presentation;
    const { cpu } = this.options.profilers;
    const presentationDeltaSeconds = step.presentationDeltaSeconds;
    const rawRealDeltaSeconds = step.rawRealDeltaSeconds;

    cpu.beginPass('worldAndLighting');
    presentationClock.advanceRealSeconds(presentationDeltaSeconds);

    wind.updatePresentation(presentationDeltaSeconds);
    world.advanceClockRealSeconds(rawRealDeltaSeconds);
    vessel.advanceWorldMotion(presentationDeltaSeconds);

    // THE SEAM, and the order it has to be in.
    //
    // Until WX1 the world wind was read straight off `frameSeaState.wind`, so
    // `WorldWind.meanSpeedMps` was identically the sea's own wind and there was
    // no way to say the wind had freshened before the sea answered it. WX1 put
    // weather between them but still fed weather the sea's wind as its
    // prevailing, every frame — the sea remained the ultimate source. WX2 cut
    // that read, and the direction of causation is now one-way and visible in
    // the order of these statements: the weather says what the wind is, the
    // memory says what sea that wind has built by now, and only then is the sea
    // resolved and the world wind published from the weather.
    if (weather) weather.advance();
    if (weather && windSea) {
      windSea.update(
        presentationDeltaSeconds,
        weather.elapsedSeconds,
        weather.wind,
      );
    }

    // Resolve the sea before anything samples it. Transitions preserve slot
    // phases by continuously reapplying the resolved state.
    const seaStateAdvanced = seaStates.advance(presentationDeltaSeconds);
    // One retained state object is the frame's sea instant. In particular, the
    // transition branch and every later phase must not obtain subtly different
    // values from the controller's live getter.
    this.frameSeaState = seaStates.state;
    if (seaStateAdvanced) {
      waves.applySeaState(this.frameSeaState, true);
      ocean.refresh();
    }
    vessel.updateFrameNavigationAndWind(
      presentationDeltaSeconds,
      weather ? weather.wind : this.frameSeaState.generatingWind,
    );

    // HEAD captured this after the frame heading, world wind, and apparent wind
    // were derived, then shared that exact scalar with every remaining phase.
    this.framePresentationElapsedSeconds = presentationClock.elapsedSeconds;
    if (weather) {
      const weatherState = weather.state;
      this.catsPawField.update(
        this.framePresentationElapsedSeconds,
        world.state,
        wind.direction,
        {
          gustExcessMps: weatherState.gustExcessMps,
          patchSizeM: weatherState.gustPatchMetres,
          periodSeconds: weatherState.gustPeriodSeconds,
        },
      );
    }
    cpu.endPass('worldAndLighting');
  };

  private readonly integrateVesselPhase = (
    step: SimulationFrameStep,
  ): void => {
    const presentationDeltaSeconds = step.presentationDeltaSeconds;
    const presentationElapsedSeconds =
      this.framePresentationElapsedSeconds;
    const { vessel } = this.options.presentation;
    const { cpu } = this.options.profilers;

    // The vessel is the render origin, so it samples the field at the exact
    // coordinates it is drawn at. Horizontal fixed steps happen before
    // lighting so the world adapter sees the completed canonical voyage state.
    cpu.beginPass('vesselAndCamera');
    vessel.integrate(
      presentationDeltaSeconds,
      presentationElapsedSeconds,
    );
    cpu.endPass('vesselAndCamera');
  };

  private readonly deriveEnvironmentPhase = (
    step: SimulationFrameStep,
  ): void => {
    const { cpu } = this.options.profilers;
    cpu.beginPass('worldAndLighting');
    const weatherState = this.options.world.weather?.state;
    if (weatherState) {
      this.options.presentation.weather?.applyEnvironment(weatherState);
    }
    this.options.presentation.environment.deriveEnvironment(
      step.presentationDeltaSeconds,
    );
    this.options.presentation.applyExplicitTerrainHazeOverride?.();
    cpu.endPass('worldAndLighting');
  };

  private readonly presentVesselAndCameraPhase = (
    step: SimulationFrameStep,
  ): void => {
    const presentationDeltaSeconds = step.presentationDeltaSeconds;
    const { vessel } = this.options.presentation;
    const { cpu } = this.options.profilers;
    cpu.beginPass('vesselAndCamera');
    vessel.present(
      presentationDeltaSeconds,
      this.framePresentationElapsedSeconds,
    );
    cpu.endPass('vesselAndCamera');
  };

  private readonly updateSurfaceEffectsPhase = (
    step: SimulationFrameStep,
  ): void => {
    const { waves, wind, worldWind } = this.options.world;
    const { cameras, vessel, wake } = this.options.presentation;
    const { crestSpray, foam, lighting, ocean, renderer, tuning } =
      this.options.surface;
    const { cpu, gpu } = this.options.profilers;
    const presentationDeltaSeconds = step.presentationDeltaSeconds;
    const presentationElapsedSeconds =
      this.framePresentationElapsedSeconds;
    const sea = this.frameSeaState;
    const observerDisplacementX = vessel.observerDisplacementX;
    const observerDisplacementZ = vessel.observerDisplacementZ;

    // Whitewater is stepped before the ocean is drawn, so a frame never shows
    // foam from the previous instant sitting on this instant's crests.
    //
    // WHICH WIND EACH FOAM TERM READS, AND WHY IT IS NOT COUNTED TWICE
    // ----------------------------------------------------------------
    // Two winds exist since WX2 and they disagree whenever the weather is
    // moving, so every term below has to say which it wants. The rule is
    // `WEATHER_CONCEPT.md` §4 L2's, and it is one line: **a statistic about
    // the sea reads the sea's wind; a response to the air reads the wind now.**
    //
    //   ambient whitecap coverage   sea.generatingWind.speedMps   the developed
    //                                                             statistic
    //   foam generation / advection worldWind.meanSpeedMps        the air now
    //   crest spray                 worldWind.meanSpeedMps        the air now
    //
    // Neither line multiplies a wind by a wind. The coverage below is Monahan
    // evaluated once, on `U* = max(wind now, developed wind)`, which is the
    // single wind `WindSeaMemory` writes into the sea's record; the foam field
    // then takes that coverage as a *coefficient* and the present wind as its
    // drive. At a steady wind the two winds are the same number and everything
    // here is exactly what shipped before. During a build they diverge, which
    // is the round working: the air is already tearing at the water before the
    // water has grown.
    this.frameAmbientWhitecapCoverage = whitecapCoverage(
      sea.generatingWind.speedMps,
    );
    wake.prepareWater(
      this.frameAmbientWhitecapCoverage,
      presentationDeltaSeconds,
    );
    cpu.beginPass('foamAndSpray');
    gpu.beginPass('foamSimulation');
    foam.update(renderer, waves, presentationDeltaSeconds, {
      windDir: wind.direction,
      windSpeed: worldWind.meanSpeedMps,
      generation: sea.whitewater.generation,
      persistenceSeconds: sea.whitewater.persistenceSeconds,
      gustiness: sea.generatingWind.gustiness,
      ...(this.options.world.weather
        ? { catsPaw: this.catsPawField.frame }
        : {}),
      streak: sea.roughness.gustStreak,
      windAdvection: sea.whitewater.windAdvection,
      observerVelocity: vessel.encounterVelocity,
      noiseTime: presentationElapsedSeconds % 1800,
      frozen: tuning.foamFrozen,
      hullWake: wake.foamHullWakeSource,
      waterlineWake: wake.foamWaterlineWakeSource,
    });
    gpu.endPass('foamSimulation');

    // Spray runs before the ocean draw because airborne salt loading is driven
    // by this frame's spray activity, never the previous frame's.
    crestSpray.update(
      presentationDeltaSeconds,
      waves,
      wind.direction.x,
      wind.direction.y,
      worldWind.meanSpeedMps,
      sea.whitewater.sprayIntensity,
      sea.generatingWind.gustiness,
      presentationElapsedSeconds,
      observerDisplacementX,
      observerDisplacementZ,
    );

    // WK3's hull spray joins the same pool, after `update` so it is born on the
    // same side of the integrator as the sea's own droplets. It is a no-op on
    // every frame with no bow tear open, which is nearly all of them.
    if (wake.hullSprayBurst.active) {
      crestSpray.emitBurst(
        wake.hullSprayBurst,
        presentationDeltaSeconds,
        worldWind.meanSpeedMps,
        presentationElapsedSeconds,
      );
    }

    const sunAlong = Math.max(
      -cameras.camera
        .getWorldDirection(this.scratchDirection)
        .dot(lighting.sunDirection),
      0,
    );
    crestSpray.setLight(
      lighting.ambientRadiance,
      lighting.sunLightColor,
      lighting.sunLightIntensity * SPRAY_SUN_GAIN,
      0.25 + 2.4 * Math.pow(sunAlong, 3),
    );
    ocean.setSaltLoading(
      SALT_DENSITY_FULL * tuning.saltScale * crestSpray.activity,
    );
    cpu.endPass('foamAndSpray');
  };

  private readonly prepareOceanPhase = (): void => {
    const { waves, wind } = this.options.world;
    const { cameras, vessel } = this.options.presentation;
    const { foam, lighting, ocean, tuning } = this.options.surface;
    const { cpu } = this.options.profilers;
    const presentationElapsedSeconds =
      this.framePresentationElapsedSeconds;
    const sea = this.frameSeaState;
    const anchor = vessel.cameraAnchor;

    // The sea disc is centred on the observer, not always on the vessel. Its
    // rings grow exponentially outwards, so at the far end of the camera range
    // a vessel-centred disc puts the coarsest, most faded water directly under
    // the lens. Moving the centre also moves the vessel out of the fine rings,
    // so the blend deliberately stays zero through 200 m and reaches one only
    // at 900 m. Measured against the subject, the established compromise is:
    //
    //     scale 0.60   8 m offset    0.00 m   0.0 px   subject 17.3 px
    //     scale 0.75  18 m offset    0.00 m   0.0 px   subject  6.7 px
    //     scale 0.88 662 m offset    0.38 m   0.8 px   subject  3.0 px
    //     scale 1.00 1374 m offset   1.03 m   1.1 px   subject  1.6 px
    //
    // Earlier (80, 400) bounds made the medium subject visibly float. Below
    // 200 m the close/default/medium compositions and embodied mode therefore
    // remain bit-for-bit vessel-centred.
    cpu.beginPass('oceanPreparation');
    // Foam targets are double-buffered, so the ocean rebinds them after this
    // frame's simulation and before it publishes any ocean uniforms.
    ocean.attachFoam(
      foam.nearTexture,
      foam.farTexture,
      foam.hullTexture,
      foam.nearOrigin,
      foam.farOrigin,
      foam.hullOrigin,
    );
    const cameraGroundX = cameras.camera.position.x;
    const cameraGroundZ = cameras.camera.position.z;
    const observerBlend = smoothstep01(
      Math.hypot(cameraGroundX - anchor.x, cameraGroundZ - anchor.z),
      200,
      900,
    );
    ocean.update(
      anchor.x + (cameraGroundX - anchor.x) * observerBlend,
      anchor.z + (cameraGroundZ - anchor.z) * observerBlend,
      waves.originWorldX,
      waves.originWorldZ,
      presentationElapsedSeconds,
      wind.direction,
      wind.strength,
      lighting.ambientRadiance,
      lighting.skySh,
      {
        scale: sea.roughness.detailScale,
        // The base amplitude follows the unresolved slope band; the preset
        // fields are dimensionless trims. Detail owns no wave slot, so its lab
        // layer mute is gated here rather than through the component table.
        strength: waves.layerMask.detail
          ? waves.detailAmplitude *
            sea.roughness.detailStrength *
            sea.roughness.fineRoughness
          : 0,
        streak: sea.roughness.gustStreak,
        ...(this.options.world.weather
          ? { catsPaw: this.catsPawField.frame }
          : {}),
      },
      {
        strength: tuning.foamStrength,
        breakup: sea.whitewater.breakup,
        // Statistical far-field coverage uses the same Monahan relation as the
        // breaking threshold, expressed in the foam field's density units.
        coverage:
          this.frameAmbientWhitecapCoverage *
          Math.min(sea.whitewater.generation, 1.5) *
          0.26,
      },
    );
    vessel.prepareOceanMasks();
    ocean.setCloudOcclusion(
      lighting.sunCloudTransmittance,
      lighting.moonCloudTransmittance,
      this.options.world.weather?.source === 'neutral' ||
        !this.options.world.weather
        ? 0
        : 1,
    );
    cpu.endPass('oceanPreparation');
  };

  private readonly prepareScenePhase = (): void => {
    const presentationElapsedSeconds =
      this.framePresentationElapsedSeconds;
    const {
      ambience,
      environment,
      vessel,
      weather: weatherPresentation,
    } = this.options.presentation;
    const { cpu } = this.options.profilers;
    cpu.beginPass('skyAndScene');
    environment.prepareScene(presentationElapsedSeconds);
    vessel.updateTrimPickTargets();
    const weatherState = this.options.world.weather?.state;
    if (weatherPresentation && weatherState) {
      weatherPresentation.update(presentationElapsedSeconds, weatherState);
    }
    // This frame's sea instant and the coverage its foam was built from —
    // never the controller's live getter, and never a second Monahan
    // evaluation. Audio reads what the ocean phase already decided.
    ambience.update(this.frameSeaState, this.frameAmbientWhitecapCoverage);
    vessel.refreshRigLoft();
    cpu.endPass('skyAndScene');
  };
}

/** Hermite smoothstep, clamped. */
function smoothstep01(value: number, edge0: number, edge1: number): number {
  const t = Math.min(
    Math.max((value - edge0) / (edge1 - edge0), 0),
    1,
  );
  return t * t * (3 - 2 * t);
}
