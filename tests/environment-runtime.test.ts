import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  EnvironmentRuntime,
  type EnvironmentRuntimeOptions,
} from '../src/runtime/EnvironmentRuntime';

function createFixture() {
  const calls: string[] = [];
  const cloudDeltas: number[] = [];
  const exposureDeltas: number[] = [];
  const radianceInputs: unknown[] = [];
  const publishedSh: ArrayLike<number>[] = [];
  const celestialToRender = { identity: 'celestial-to-render' };
  const optics = { ambientIrradianceGain: 2 };
  const environmentTexture = { identity: 'environment-texture' };

  const world = {
    state: { worldInstantUtcSeconds: 1_000 },
  };
  const astronomyFrame = {
    sunHorizontal: { azimuthRad: 0.1, elevationRad: 0.2 },
    moonHorizontal: { azimuthRad: 0.3, elevationRad: 0.4 },
    moonIlluminatedFraction: 0.25,
  };
  const worldRender = {
    velocityDirection: new THREE.Vector3(2, 0, 3),
    sunDirection: new THREE.Vector3(0.2, 0, -0.9),
    moonDirection: new THREE.Vector3(-0.4, 0.5, 0.7),
    celestialToRender,
    update: () => calls.push('world-render.update'),
  };
  const navigationTelemetry = {
    latitudeRad: 0,
    longitudeRad: 0,
    heightM: 0,
    speedOverGroundMps: 0,
    trueCourseRad: null,
    courseUnavailableReason: 'stationary' as const,
  };
  const wind = {
    direction: new THREE.Vector2(0.6, 0.8),
    strength: 9,
    setRenderDirection: (x: number, z: number) => {
      calls.push(`wind.set:${x},${z}`);
    },
  };
  const sky = {
    uniforms: {
      uCloudCover: { value: 0.45 },
      uCloudOpacity: { value: 0.7 },
    },
    cloudField: { identity: 'cloud-field' },
    advanceCloudPresentation: (deltaSeconds: number) => {
      cloudDeltas.push(deltaSeconds);
      calls.push(`sky.advance:${deltaSeconds}`);
    },
    update: (
      _lighting: unknown,
      elapsedSeconds: number,
      _cameraPosition: THREE.Vector3,
    ) => calls.push(`sky.update:${elapsedSeconds}`),
    setCelestialOrientation: (orientation: unknown) => {
      expect(orientation).toBe(celestialToRender);
      calls.push('sky.orientation');
    },
  };
  const stars = {
    update: (
      orientation: unknown,
      _cameraPosition: THREE.Vector3,
      limitingMagnitude: number,
    ) => {
      expect(orientation).toBe(celestialToRender);
      calls.push(`stars.update:${limitingMagnitude}`);
    },
  };
  const lighting = {
    ambientRadiance: new THREE.Vector3(1, 2, 3),
    hemisphericRadiance: new THREE.Vector3(4, 5, 6),
    sunDirection: new THREE.Vector3(0.2, 0, -0.9),
    moonDirection: new THREE.Vector3(-0.4, 0.5, 0.7),
    sunLightColor: new THREE.Color(0.8, 0.7, 0.6),
    moonLightColor: new THREE.Color(0.3, 0.4, 0.5),
    sunLightIntensity: 4,
    moonLightIntensity: 2,
    limitingMagnitude: 6,
    twilightArchDirection: new THREE.Vector3(1, 0, 0),
    twilightArchPenaltyMag: 0.75,
    sunCloudTransmittance: 0.5,
    exposure: 0.8,
    daylightLift: 1.5,
    setCloudState: () => calls.push('lighting.cloud-state'),
    refreshFromAstronomy: (deltaSeconds: number) => {
      exposureDeltas.push(deltaSeconds);
      calls.push(`lighting.refresh:${deltaSeconds}`);
    },
    cloudLayer: (_direction: THREE.Vector3, out: THREE.Vector4) => {
      calls.push('lighting.cloud-layer');
      return out.set(1, 2, 3, 4);
    },
  };
  const ocean = {
    optics,
    sunShadowSamplingEnabled: false,
    sunShadowingEnabled: false,
    lampShadowingEnabled: false,
    mesh: { castShadow: false },
    setSunShadowSampling(enabled: boolean) {
      this.sunShadowSamplingEnabled = enabled;
      this.sunShadowingEnabled = enabled;
      calls.push(`ocean.sun-sampling:${enabled}`);
    },
    setSunShadowCasting(enabled: boolean) {
      this.mesh.castShadow = enabled;
      calls.push(`ocean.sun-casting:${enabled}`);
    },
    setLampShadowing(enabled: boolean) {
      this.lampShadowingEnabled = enabled;
      calls.push(`ocean.lamp:${enabled}`);
    },
  };
  const waves = {
    meanSquareSlope: 0.2,
    unresolvedSlopeVariance: 0.1,
  };
  const sunLight = {
    position: new THREE.Vector3(),
    color: new THREE.Color(),
    intensity: 0,
    castShadow: false,
    shadow: { needsUpdate: false },
  };
  const moonLight = {
    position: new THREE.Vector3(),
    color: new THREE.Color(),
    intensity: 0,
  };
  const lamp = {
    shadowEnabled: false,
    shadowActive: false,
    setShadowEnabled(enabled: boolean) {
      this.shadowEnabled = enabled;
      this.shadowActive = enabled;
      calls.push(`lamp.shadow:${enabled}`);
    },
  };
  const worldLighting = {
    publishedGeneration: 1,
    shCoefficients: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    environment: environmentTexture,
    update: (
      _renderer: unknown,
      elapsedSeconds: number,
      inputs: unknown,
    ) => {
      calls.push(`world-lighting.update:${elapsedSeconds}`);
      radianceInputs.push(inputs);
    },
    refreshNow: (
      _renderer: unknown,
      elapsedSeconds: number,
      inputs: unknown,
    ) => {
      calls.push(`world-lighting.refresh:${elapsedSeconds}`);
      radianceInputs.push(inputs);
    },
  };
  let toneMappingExposure = 0;
  const renderer = {
    shadowMap: { needsUpdate: false },
    getPixelRatio: () => 1.75,
    get toneMappingExposure() {
      return toneMappingExposure;
    },
    set toneMappingExposure(value: number) {
      toneMappingExposure = value;
      calls.push('renderer.exposure');
    },
  };
  let sceneEnvironment: unknown;
  let sceneEnvironmentIntensity = 0;
  const scene = {
    get environment() {
      return sceneEnvironment;
    },
    set environment(value: unknown) {
      sceneEnvironment = value;
      calls.push('scene.environment');
    },
    get environmentIntensity() {
      return sceneEnvironmentIntensity;
    },
    set environmentIntensity(value: number) {
      sceneEnvironmentIntensity = value;
      calls.push('scene.intensity');
    },
  };
  const vesselLighting = {
    sunIntensity: -1,
    moonIntensity: -1,
    sceneExposure: -1,
  };
  const graphicsState = {
    sunMultiplier: 2,
    ambientMultiplier: 0.5,
    starLimitBias: 1.25,
  };
  let graphicsReads = 0;
  let cameraReads = 0;
  let elapsedSeconds = 12;

  const runtime = new EnvironmentRuntime({
    world,
    astronomy: {
      compute: () => calls.push('astronomy.compute'),
    },
    astronomyFrame,
    worldRender,
    navigationTelemetry,
    deriveNavigationTelemetry: (
      _state: unknown,
      out: typeof navigationTelemetry,
    ) => {
      calls.push('navigation.derive');
      out.latitudeRad = 0.4;
      return out;
    },
    wind,
    sky,
    stars,
    lighting,
    ocean,
    waves,
    renderer,
    scene,
    sunLight,
    moonLight,
    worldLighting,
    lamp,
    vesselLighting,
    cameraPosition: () => {
      cameraReads++;
      return CAMERA_POSITION;
    },
    // The star dome is parked against the far plane, so it is read per frame.
    cameraFarM: () => 25_000,
    presentationElapsedSeconds: () => elapsedSeconds,
    graphicsTrims: () => {
      graphicsReads++;
      return graphicsState;
    },
    worldExposureBias: () => 1.1,
    publishWorldSh: (coefficients: ArrayLike<number>) => {
      calls.push('publish-sh');
      publishedSh.push(coefficients);
    },
    initialDirectShadowing: true,
  } as unknown as EnvironmentRuntimeOptions);

  return {
    calls,
    cloudDeltas,
    exposureDeltas,
    radianceInputs,
    publishedSh,
    world,
    navigationTelemetry,
    wind,
    sky,
    lighting,
    ocean,
    waves,
    sunLight,
    moonLight,
    lamp,
    worldLighting,
    renderer,
    scene,
    vesselLighting,
    graphicsState,
    environmentTexture,
    get graphicsReads() {
      return graphicsReads;
    },
    get cameraReads() {
      return cameraReads;
    },
    setElapsedSeconds(value: number) {
      elapsedSeconds = value;
    },
    runtime,
  };
}

const CAMERA_POSITION = new THREE.Vector3(10, 20, 30);

describe('EnvironmentRuntime', () => {
  it('derives astronomy in order, keeps the snap threshold strict, and leaves diagnostic refresh weather-frozen', () => {
    const fixture = createFixture();

    fixture.runtime.deriveInitialLighting();
    expect(fixture.calls).toEqual([
      'astronomy.compute',
      'world-render.update',
      'navigation.derive',
      'wind.set:2,3',
      'sky.advance:0',
      'lighting.cloud-state',
      'lighting.refresh:0',
    ]);
    expect(fixture.vesselLighting).toEqual({
      sunIntensity: -1,
      moonIntensity: -1,
      sceneExposure: -1,
    });
    expect(fixture.navigationTelemetry.latitudeRad).toBe(0.4);

    fixture.calls.length = 0;
    fixture.world.state.worldInstantUtcSeconds += 600;
    fixture.runtime.deriveEnvironment(0.25);
    expect(fixture.exposureDeltas.at(-1)).toBe(0.25);
    expect(fixture.cloudDeltas.at(-1)).toBe(0.25);
    expect(fixture.vesselLighting).toEqual({
      sunIntensity: 4,
      moonIntensity: 2,
      // The authored composition, minus any camera-adaptation gain:
      // exposure 0.8 x daylightLift 1.5 x worldExposureBias 1.1 x bias 1.
      sceneExposure: 0.8 * 1.5 * 1.1,
    });

    fixture.world.state.worldInstantUtcSeconds += 600.001;
    fixture.runtime.deriveEnvironment(0.125);
    expect(fixture.exposureDeltas.at(-1)).toBe(1e6);
    expect(fixture.cloudDeltas.at(-1)).toBe(0.125);

    fixture.runtime.refreshLighting();
    expect(fixture.exposureDeltas.at(-1)).toBe(1e6);
    expect(fixture.cloudDeltas.at(-1)).toBe(0);
    expect(fixture.runtime.refreshLighting).toBe(
      fixture.runtime.refreshLighting,
    );
  });

  it('prepares visible lighting in order with stable radiance inputs and scratch', () => {
    const fixture = createFixture();
    fixture.runtime.exposureBias = 1.25;
    fixture.calls.length = 0;

    fixture.runtime.prepareScene(12);

    expect(fixture.calls).toEqual([
      'sky.update:12',
      'sky.orientation',
      'stars.update:7.25',
      'ocean.sun-sampling:true',
      'ocean.sun-casting:false',
      'world-lighting.update:12',
      'publish-sh',
      'scene.intensity',
      'scene.environment',
      'renderer.exposure',
    ]);
    expect(fixture.cameraReads).toBe(2);
    expect(fixture.graphicsReads).toBe(2);
    expect(fixture.sunLight.position).toEqual(
      fixture.lighting.sunDirection.clone().multiplyScalar(600),
    );
    expect(fixture.sunLight.color).toEqual(fixture.lighting.sunLightColor);
    expect(fixture.sunLight.intensity).toBe(8);
    expect(fixture.moonLight.position).toEqual(
      fixture.lighting.moonDirection.clone().multiplyScalar(600),
    );
    expect(fixture.moonLight.color).toEqual(fixture.lighting.moonLightColor);
    expect(fixture.moonLight.intensity).toBe(2);
    expect(fixture.renderer.toneMappingExposure).toBeCloseTo(1.65);
    expect(fixture.scene.environmentIntensity).toBe(0.5);
    expect(fixture.scene.environment).toBe(fixture.environmentTexture);

    const firstInputs = fixture.radianceInputs[0] as {
      waterAmbient: THREE.Vector3;
      hemisphericRadiance: THREE.Vector3;
      reflectBlend: number;
      sunVisible: number;
      optics: unknown;
      cloudLayer(direction: THREE.Vector3, out: THREE.Vector4): THREE.Vector4;
    };
    expect(firstInputs.waterAmbient).toEqual(new THREE.Vector3(2, 4, 6));
    expect(firstInputs.hemisphericRadiance).toBe(
      fixture.lighting.hemisphericRadiance,
    );
    expect(firstInputs.reflectBlend).toBeGreaterThan(0);
    expect(firstInputs.sunVisible).toBeCloseTo(0.324);
    expect(firstInputs.optics).toBe(fixture.ocean.optics);
    expect(
      firstInputs.cloudLayer(new THREE.Vector3(), new THREE.Vector4()),
    ).toEqual(new THREE.Vector4(1, 2, 3, 4));

    const firstScaledSh = fixture.publishedSh[0];
    expect(Array.from(firstScaledSh).slice(0, 9)).toEqual([
      0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5,
    ]);
    expect(Array.from(firstScaledSh).slice(9)).toEqual(
      new Array(firstScaledSh.length - 9).fill(0),
    );
    fixture.calls.length = 0;
    fixture.worldLighting.publishedGeneration = 2;
    fixture.runtime.prepareScene(13);
    expect(fixture.radianceInputs[1]).toBe(firstInputs);
    expect(
      (fixture.radianceInputs[1] as { waterAmbient: THREE.Vector3 })
        .waterAmbient,
    ).toBe(firstInputs.waterAmbient);
    expect(fixture.publishedSh[1]).toBe(firstScaledSh);

    fixture.graphicsState.ambientMultiplier = 1;
    fixture.runtime.prepareScene(14);
    expect(fixture.publishedSh.at(-1)).toBe(
      fixture.worldLighting.shCoefficients,
    );
  });

  it('preserves shipping shadow policy, stable diagnostic ports, and forced refresh publication order', () => {
    const fixture = createFixture();
    const setSunShadowing = fixture.runtime.setSunShadowing;
    const setLanternShadowing = fixture.runtime.setLanternShadowing;
    const shadowingState = fixture.runtime.shadowingState;

    fixture.runtime.initializeDirectShadows();
    expect(fixture.calls).toEqual([
      'lamp.shadow:true',
      'ocean.lamp:true',
      'ocean.sun-sampling:true',
      'ocean.sun-casting:false',
    ]);
    expect(fixture.sunLight.shadow.needsUpdate).toBe(true);
    expect(fixture.runtime.shadowingState()).toEqual({
      sun: true,
      sunActive: true,
      lantern: true,
      lanternActive: true,
    });

    fixture.calls.length = 0;
    fixture.runtime.setBenchmarkSunShadowMode('full');
    expect(fixture.calls).toEqual([
      'ocean.sun-sampling:true',
      'ocean.sun-casting:true',
    ]);
    fixture.calls.length = 0;
    fixture.runtime.setBenchmarkSunShadowMode('off');
    expect(fixture.calls).toEqual([
      'ocean.sun-sampling:false',
      'ocean.sun-casting:false',
    ]);
    expect(fixture.runtime.shadowingState().sun).toBe(true);

    fixture.calls.length = 0;
    fixture.runtime.setSunShadowing(false);
    expect(fixture.calls).toEqual([
      'ocean.sun-sampling:false',
      'ocean.sun-casting:false',
    ]);
    fixture.calls.length = 0;
    fixture.runtime.setLanternShadowing(false);
    expect(fixture.calls).toEqual([
      'lamp.shadow:false',
      'ocean.lamp:false',
    ]);
    expect(fixture.renderer.shadowMap.needsUpdate).toBe(false);
    expect(fixture.runtime.setSunShadowing).toBe(setSunShadowing);
    expect(fixture.runtime.setLanternShadowing).toBe(setLanternShadowing);
    expect(fixture.runtime.shadowingState).toBe(shadowingState);

    fixture.calls.length = 0;
    fixture.setElapsedSeconds(42);
    fixture.runtime.refreshWorldLighting();
    expect(fixture.calls).toEqual([
      'world-lighting.refresh:42',
      'publish-sh',
      'scene.environment',
      'scene.intensity',
    ]);
    expect(fixture.publishedSh.at(-1)).toBe(
      fixture.worldLighting.shCoefficients,
    );
    expect(fixture.scene.environmentIntensity).toBe(1);
  });
});
