import * as THREE from 'three';

import type {
  AstronomyFrame,
  AstronomyProvider,
} from '../astronomy/AstronomyProvider';
import type { Ocean } from '../scene/Ocean';
import type { Lamp } from '../scene/Lamp';
import { CLEAR_DEEP_OCEAN } from '../scene/oceanOptics';
import type { SkySystem } from '../scene/SkySystem';
import type { StarField } from '../scene/StarField';
import type { TimeOfDay } from '../scene/TimeOfDay';
import { reflectionLobeBlend } from '../scene/WorldRadianceSource';
import type { WorldRadianceInputs } from '../scene/WorldRadianceSource';
import { setPortalSkySampler } from '../scene/WorldPbrMaterial';
import type { WorldLighting } from '../scene/WorldLighting';
import type { WorldRenderAdapter } from '../scene/WorldRenderAdapter';
import { SH_FLOAT_COUNT } from '../scene/sphericalHarmonics';
import type { WaveField } from '../scene/Waves';
import type { WindSystem } from '../scene/WindSystem';
import type { VesselPresentationContext } from '../vessel/Vessel';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import type { NavigationTelemetry } from '../world/types';

export type EnvironmentSunShadowMode =
  | 'off'
  | 'solid-only'
  | 'water-receiver'
  | 'full';

export interface EnvironmentGraphicsTrims {
  sunMultiplier: number;
  ambientMultiplier: number;
  starLimitBias: number;
}

export interface EnvironmentShadowingState {
  sun: boolean;
  sunActive: boolean;
  lantern: boolean;
  lanternActive: boolean;
}

export interface EnvironmentRuntimeOptions {
  world: PlanetaryWorld;
  astronomy: AstronomyProvider;
  astronomyFrame: AstronomyFrame;
  worldRender: WorldRenderAdapter;
  navigationTelemetry: NavigationTelemetry;
  deriveNavigationTelemetry(
    state: PlanetaryWorld['state'],
    out: NavigationTelemetry,
  ): NavigationTelemetry;
  wind: WindSystem;
  sky: SkySystem;
  stars: StarField;
  lighting: TimeOfDay;
  ocean: Ocean;
  waves: WaveField;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  readonly sunLight: THREE.DirectionalLight;
  readonly moonLight: THREE.DirectionalLight;
  readonly worldLighting: WorldLighting;
  readonly lamp: Lamp;
  vesselLighting: Pick<
    VesselPresentationContext,
    'sunIntensity' | 'moonIntensity' | 'sceneExposure'
  >;
  cameraPosition(): THREE.Vector3;
  /**
   * The active camera's far plane in metres.
   *
   * The star dome is parked just inside it so terrain and the far sea can
   * occlude the catalogue, and the terrain harness raises it at runtime
   * (`&far=`, `&range=`), so it is read every frame rather than captured once.
   */
  cameraFarM(): number;
  presentationElapsedSeconds(): number;
  graphicsTrims(): EnvironmentGraphicsTrims | undefined;
  worldExposureBias(): number;
  /**
   * The eye's own dark adaptation, 1 outdoors. The vessel supplies it
   * (`Schooner.interiorEyeAdaptation`) because the vessel is what knows the
   * eye is enclosed. An exposure term and not a light: it scales the whole
   * frame, so every relationship the interior model computes — which wall is
   * brighter, how the beam falls — survives it untouched. Optional: harnesses
   * with no walkable vessel have no eye to adapt.
   */
  interiorEyeAdaptation?(): number;
  publishWorldSh(coefficients: ArrayLike<number>): void;
  initialDirectShadowing: boolean;
}

const WORLD_TIME_SNAP_SECONDS = 600;

/**
 * Coordinates canonical astronomy into visible, direct, and indirect light.
 *
 * The composition root still constructs every concrete renderer resource in
 * its established order. Late resource getters let the initial astronomy pass
 * run before the lights exist, exactly as before, while one coordinator owns
 * all subsequent publication and diagnostic controls.
 */
export class EnvironmentRuntime {
  private lastWorldUtcSeconds = Number.NaN;
  private exposureBiasValue = 1;
  private sunShadowRequested: boolean;
  private sunShadowMode: EnvironmentSunShadowMode;
  private publishedWorldGeneration = -1;
  private publishedWorldProbeGain = 1;

  /** Stable scratch and publication records; neither frame path allocates. */
  private readonly worldWaterAmbient = new THREE.Vector3();
  private readonly scaledWorldSh = new Float32Array(SH_FLOAT_COUNT);
  private readonly worldRadianceInputs: WorldRadianceInputs;

  constructor(private readonly options: EnvironmentRuntimeOptions) {
    this.sunShadowRequested = options.initialDirectShadowing;
    this.sunShadowMode = options.initialDirectShadowing
      ? 'water-receiver'
      : 'off';
    this.worldRadianceInputs = {
      cloudLayer: (direction, out) =>
        options.lighting.cloudLayer(direction, out),
      waterAmbient: this.worldWaterAmbient,
      hemisphericRadiance: options.lighting.hemisphericRadiance,
      reflectBlend: 0,
      sunVisible: 0,
      optics: options.ocean.optics,
    };
    // The portal channels' sky path: integrate the world source map
    // directly instead of reconstructing through the SH (§17.6 — measured
    // equivalent on the real sky, exact against spiky ones). The probe gain
    // must ride along — the published SH carries it, and an A/B whose two
    // sides disagree about the ambient trim is not an A/B.
    setPortalSkySampler((direction, out) => {
      if (!options.worldLighting.sourceIrradiance(direction, out)) return false;
      if (this.publishedWorldProbeGain !== 1) {
        out.multiplyScalar(this.publishedWorldProbeGain);
      }
      return true;
    });
  }

  get exposureBias(): number {
    return this.exposureBiasValue;
  }

  set exposureBias(value: number) {
    this.exposureBiasValue = value;
  }

  /** Initial startup derive: no weather advance and no vessel-context write. */
  deriveInitialLighting(): void {
    this.derivePresentationLighting(0);
  }

  /** Post-motion environment phase, including the vessel's light snapshot. */
  deriveEnvironment(presentationDeltaSeconds: number): void {
    this.derivePresentationLighting(
      presentationDeltaSeconds,
      presentationDeltaSeconds,
    );
    this.options.vesselLighting.sunIntensity =
      this.options.lighting.sunLightIntensity;
    this.options.vesselLighting.moonIntensity =
      this.options.lighting.moonLightIntensity;
    // The same composition `prepareScene` writes to the renderer, minus the
    // camera-adaptation gain — see the field's note in Vessel.ts.
    this.options.vesselLighting.sceneExposure =
      this.options.lighting.exposure *
      this.options.lighting.daylightLift *
      this.options.worldExposureBias() *
      this.exposureBiasValue;
  }

  /** Diagnostic time jump: snap exposure without advancing cloud weather. */
  readonly refreshLighting = (): void => {
    this.derivePresentationLighting(1e6);
  };

  /**
   * Publish the visible sky, direct lights, world probe, and exposure.
   * Called inside main's existing `skyAndScene` profiler span.
   */
  prepareScene(presentationElapsedSeconds: number): void {
    const {
      lighting,
      moonLight,
      renderer,
      sky,
      stars,
      sunLight,
      worldLighting,
      worldRender,
    } = this.options;
    sky.update(
      lighting,
      presentationElapsedSeconds,
      this.options.cameraPosition(),
    );
    // One orientation, published to both consumers from the same source.
    sky.setCelestialOrientation(worldRender.celestialToRender);
    stars.update(
      worldRender.celestialToRender,
      this.options.cameraPosition(),
      lighting.limitingMagnitude +
        (this.options.graphicsTrims()?.starLimitBias ?? 0),
      renderer.getPixelRatio(),
      lighting.twilightArchDirection,
      lighting.twilightArchPenaltyMag,
      this.options.cameraFarM(),
    );

    // Read again after stars: these are live panel trims, not startup policy.
    const graphicsState = this.options.graphicsTrims();
    sunLight.position.copy(lighting.sunDirection).multiplyScalar(600);
    sunLight.color.copy(lighting.sunLightColor);
    sunLight.intensity =
      lighting.sunLightIntensity * (graphicsState?.sunMultiplier ?? 1);
    this.syncSunShadowState();

    moonLight.position.copy(lighting.moonDirection).multiplyScalar(600);
    moonLight.color.copy(lighting.moonLightColor);
    moonLight.intensity = lighting.moonLightIntensity;

    // Must remain after sky.update so the source consumes this frame's sky.
    worldLighting.update(
      renderer,
      presentationElapsedSeconds,
      this.resolveWorldRadianceInputs(),
    );
    this.publishWorldLighting(graphicsState?.ambientMultiplier ?? 1);

    renderer.toneMappingExposure =
      lighting.exposure *
      lighting.daylightLift *
      this.options.worldExposureBias() *
      this.exposureBiasValue *
      (this.options.interiorEyeAdaptation?.() ?? 1);
  }

  /** Shipping initial shadow state, applied after the Sun light is constructed. */
  initializeDirectShadows(): void {
    const { lamp, ocean } = this.options;
    lamp.setShadowEnabled(this.options.initialDirectShadowing);
    ocean.setLampShadowing(this.options.initialDirectShadowing);
    this.syncSunShadowState();
  }

  /** Do not render/sample a directional map after its light has left the sea. */
  readonly syncSunShadowState = (): void => {
    const { lighting, ocean, sunLight } = this.options;
    const lightActive =
      this.sunShadowRequested &&
      lighting.sunDirection.y > -0.035 &&
      lighting.sunLightIntensity > 1e-5;
    const sampleWater =
      lightActive &&
      (this.sunShadowMode === 'water-receiver' ||
        this.sunShadowMode === 'full');
    const castWater = lightActive && this.sunShadowMode === 'full';
    if (
      sunLight.castShadow === lightActive &&
      ocean.sunShadowSamplingEnabled === sampleWater &&
      ocean.mesh.castShadow === castWater
    ) {
      return;
    }
    sunLight.castShadow = lightActive;
    ocean.setSunShadowSampling(sampleWater);
    ocean.setSunShadowCasting(castWater);
    sunLight.shadow.needsUpdate = lightActive;
  };

  readonly setSunShadowing = (enabled: boolean): void => {
    this.sunShadowRequested = enabled;
    // The panel returns to production water-receiver mode, never full casting.
    this.sunShadowMode = enabled ? 'water-receiver' : 'off';
    this.syncSunShadowState();
  };

  readonly setLanternShadowing = (enabled: boolean): void => {
    this.options.lamp.setShadowEnabled(enabled);
    this.options.ocean.setLampShadowing(enabled);
    this.options.renderer.shadowMap.needsUpdate = enabled;
  };

  readonly shadowingState = (): EnvironmentShadowingState => ({
    sun: this.sunShadowRequested,
    sunActive:
      this.options.sunLight.castShadow &&
      this.options.ocean.sunShadowingEnabled,
    lantern:
      this.options.lamp.shadowEnabled &&
      this.options.ocean.lampShadowingEnabled,
    lanternActive: this.options.lamp.shadowActive,
  });

  readonly setBenchmarkSunShadowMode = (
    mode: EnvironmentSunShadowMode,
  ): void => {
    this.sunShadowRequested = true;
    this.sunShadowMode = mode;
    this.syncSunShadowState();
  };

  /** Synchronous capture path: rebuild and publish one matching SH/PMREM pair. */
  readonly refreshWorldLighting = (): void => {
    const { renderer, scene, worldLighting } = this.options;
    worldLighting.refreshNow(
      renderer,
      this.options.presentationElapsedSeconds(),
      this.resolveWorldRadianceInputs(),
    );
    this.publishedWorldGeneration = worldLighting.publishedGeneration;
    this.options.publishWorldSh(worldLighting.shCoefficients);
    scene.environment = worldLighting.environment;
    scene.environmentIntensity = 1;
    this.publishedWorldProbeGain = 1;
  };

  private derivePresentationLighting(
    exposureDeltaSeconds: number,
    weatherDeltaSeconds = 0,
  ): void {
    const {
      astronomy,
      astronomyFrame,
      lighting,
      navigationTelemetry,
      sky,
      wind,
      world,
      worldRender,
    } = this.options;
    const worldSeconds = world.state.worldInstantUtcSeconds;
    const jumped =
      Number.isFinite(this.lastWorldUtcSeconds) &&
      Math.abs(worldSeconds - this.lastWorldUtcSeconds) >
        WORLD_TIME_SNAP_SECONDS;
    this.lastWorldUtcSeconds = worldSeconds;

    astronomy.compute(world.state, astronomyFrame);
    worldRender.update(world.state, astronomyFrame);
    this.options.deriveNavigationTelemetry(
      world.state,
      navigationTelemetry,
    );
    wind.setRenderDirection(
      worldRender.velocityDirection.x,
      worldRender.velocityDirection.z,
    );
    sky.advanceCloudPresentation(
      weatherDeltaSeconds,
      wind.direction,
      wind.strength,
      navigationTelemetry.latitudeRad,
    );
    lighting.setCloudState(
      sky.uniforms.uCloudCover.value as number,
      sky.uniforms.uCloudOpacity.value as number,
      sky.cloudField,
    );
    lighting.refreshFromAstronomy(
      jumped ? 1e6 : exposureDeltaSeconds,
      worldRender.sunDirection,
      astronomyFrame.sunHorizontal.azimuthRad,
      astronomyFrame.sunHorizontal.elevationRad,
      worldRender.moonDirection,
      astronomyFrame.moonHorizontal.azimuthRad,
      astronomyFrame.moonHorizontal.elevationRad,
      astronomyFrame.moonIlluminatedFraction,
    );
  }

  private resolveWorldRadianceInputs(): WorldRadianceInputs {
    const { lighting, ocean, waves } = this.options;
    this.worldWaterAmbient
      .copy(lighting.ambientRadiance)
      .multiplyScalar(ocean.optics.ambientIrradianceGain);
    this.worldRadianceInputs.reflectBlend = reflectionLobeBlend(
      waves.meanSquareSlope,
      waves.unresolvedSlopeVariance,
      CLEAR_DEEP_OCEAN,
    );
    this.worldRadianceInputs.sunVisible =
      smoothstep01(lighting.sunDirection.y, -0.012, 0.008) *
      lighting.sunCloudTransmittance;
    // The profile is stable today; assigning keeps that live contract explicit.
    this.worldRadianceInputs.optics = ocean.optics;
    return this.worldRadianceInputs;
  }

  private publishWorldLighting(worldProbeGain: number): void {
    const { scene, worldLighting } = this.options;
    if (
      worldLighting.publishedGeneration ===
        this.publishedWorldGeneration &&
      worldProbeGain === this.publishedWorldProbeGain
    ) {
      return;
    }
    this.publishedWorldGeneration = worldLighting.publishedGeneration;
    this.publishedWorldProbeGain = worldProbeGain;
    if (worldProbeGain === 1) {
      this.options.publishWorldSh(worldLighting.shCoefficients);
    } else {
      for (let i = 0; i < worldLighting.shCoefficients.length; i++) {
        this.scaledWorldSh[i] =
          worldLighting.shCoefficients[i] * worldProbeGain;
      }
      this.options.publishWorldSh(this.scaledWorldSh);
    }
    scene.environmentIntensity = worldProbeGain;
    scene.environment = worldLighting.environment;
  }
}

function smoothstep01(value: number, edge0: number, edge1: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}
