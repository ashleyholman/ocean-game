import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { whitecapCoverage } from '../src/ocean/spectrum';
import { SPRAY_SUN_GAIN } from '../src/scene/CrestSpray';
import { createHullSprayBurst } from '../src/scene/hullSprayEvents';
import { SALT_DENSITY_FULL } from '../src/scene/Ocean';
import {
  ProductionSimulationRuntime,
  type ProductionSimulationRuntimeOptions,
} from '../src/runtime/ProductionSimulationRuntime';

interface FixtureOptions {
  seaStateAdvanced?: boolean;
  detailEnabled?: boolean;
  mutatingFrameSnapshots?: boolean;
  weatherEnabled?: boolean;
  weatherSource?: 'live' | 'neutral';
  explicitTerrainHazeM?: number;
}

function createFixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const foamOptions: Array<Record<string, unknown>> = [];
  const oceanDetailOptions: Array<Record<string, unknown>> = [];
  const oceanFoamOptions: Array<Record<string, unknown>> = [];
  const oceanUpdates: unknown[][] = [];
  const sprayUpdates: unknown[][] = [];
  const sprayLights: unknown[][] = [];
  const wakePreparations: Array<[number, number]> = [];
  const vesselIntegrations: Array<[number, number]> = [];
  const vesselPresentations: Array<[number, number]> = [];
  const environmentScenes: number[] = [];
  const clockAdvances: number[] = [];
  const worldClockAdvances: number[] = [];
  const scratchDirections: THREE.Vector3[] = [];
  const saltLoadings: number[] = [];
  const cloudOcclusions: Array<[number, number, number]> = [];
  const terrainHazeApplications: number[] = [];
  const appliedSeaStates: unknown[] = [];
  const navigationSeaWinds: unknown[] = [];
  let seaStateReadCount = 0;
  let presentationElapsedReadCount = 0;
  let weatherAdvanceCount = 0;

  const sea = {
    generatingWind: {
      speedMps: 10,
      directionDeg: 220,
      gustiness: 0.4,
    },
    whitewater: {
      generation: 1.2,
      persistenceSeconds: 18,
      windAdvection: 0.35,
      sprayIntensity: 0.7,
      breakup: 0.22,
    },
    roughness: {
      gustStreak: 0.6,
      detailScale: 1.4,
      detailStrength: 0.5,
      fineRoughness: 0.4,
    },
  };
  const laterSea = {
    generatingWind: {
      speedMps: 14,
      directionDeg: 130,
      gustiness: 0.8,
    },
    whitewater: {
      generation: 1.6,
      persistenceSeconds: 23,
      windAdvection: 0.7,
      sprayIntensity: 0.9,
      breakup: 0.5,
    },
    roughness: {
      gustStreak: 0.9,
      detailScale: 2,
      detailStrength: 0.7,
      fineRoughness: 0.3,
    },
  };
  const windDirection = new THREE.Vector2(0.6, 0.8);
  const sail = { raised: true };
  const renderer = { id: 'renderer' };
  const tuning = {
    foamFrozen: false,
    foamStrength: 1,
    saltScale: 0.25,
  };
  const hullWake = { id: 'hull-wake' };
  const waterlineWake = { id: 'waterline-wake' };
  const encounterVelocity = { x: 2, z: -3 };
  const waves = {
    originWorldX: 30,
    originWorldZ: -40,
    detailAmplitude: 0.8,
    layerMask: { detail: options.detailEnabled ?? true },
    applySeaState(state: unknown, preservePhase: boolean) {
      appliedSeaStates.push(state);
      calls.push(`waves:apply:${preservePhase}`);
    },
  };
  const foam = {
    nearTexture: { id: 'near-texture' },
    farTexture: { id: 'far-texture' },
    hullTexture: { id: 'hull-texture' },
    nearOrigin: { id: 'near-origin' },
    farOrigin: { id: 'far-origin' },
    hullOrigin: { id: 'hull-origin' },
    update(
      receivedRenderer: unknown,
      receivedWaves: unknown,
      deltaSeconds: number,
      receivedOptions: Record<string, unknown>,
    ) {
      expect(receivedRenderer).toBe(renderer);
      expect(receivedWaves).toBe(waves);
      expect(deltaSeconds).toBe(0.05);
      foamOptions.push(receivedOptions);
      calls.push('foam:update');
    },
  };
  const crestSpray = {
    activity: 0.4,
    update(...args: unknown[]) {
      sprayUpdates.push(args);
      calls.push('spray:update');
    },
    setLight(...args: unknown[]) {
      sprayLights.push(args);
      calls.push('spray:light');
    },
  };
  const ocean = {
    refresh() {
      calls.push('ocean:refresh');
    },
    attachFoam(...args: unknown[]) {
      expect(args).toEqual([
        foam.nearTexture,
        foam.farTexture,
        foam.hullTexture,
        foam.nearOrigin,
        foam.farOrigin,
        foam.hullOrigin,
      ]);
      calls.push('ocean:attach-foam');
    },
    update(...args: unknown[]) {
      oceanUpdates.push(args);
      oceanDetailOptions.push(args[9] as Record<string, unknown>);
      oceanFoamOptions.push(args[10] as Record<string, unknown>);
      calls.push('ocean:update');
    },
    setSaltLoading(value: number) {
      saltLoadings.push(value);
      calls.push('ocean:salt');
    },
    setCloudOcclusion(sun: number, moon: number, sunPools = 0) {
      cloudOcclusions.push([sun, moon, sunPools]);
      calls.push('ocean:cloud');
    },
  };
  const lighting = {
    sunDirection: new THREE.Vector3(1, 0, 0),
    ambientRadiance: new THREE.Vector3(0.1, 0.2, 0.3),
    hemisphericRadiance: new THREE.Vector3(0.12, 0.18, 0.24),
    sunLightColor: new THREE.Color(0.9, 0.8, 0.7),
    sunLightIntensity: 12,
    skySh: new Float32Array([1, 2, 3]),
    sunCloudTransmittance: 0.72,
    moonCloudTransmittance: 0.41,
  };
  const camera = {
    position: new THREE.Vector3(550, 20, 0),
    getWorldDirection(out: THREE.Vector3) {
      scratchDirections.push(out);
      out.set(-1, 0, 0);
      calls.push('camera:direction');
      return out;
    },
  };
  let presentationElapsedSeconds = 12.5;
  const presentationClock = {
    get elapsedSeconds() {
      presentationElapsedReadCount++;
      if (options.mutatingFrameSnapshots) {
        calls.push('clock:read-elapsed');
      }
      const elapsedSeconds = presentationElapsedSeconds;
      if (options.mutatingFrameSnapshots) {
        presentationElapsedSeconds += 100;
      }
      return elapsedSeconds;
    },
    advanceRealSeconds(deltaSeconds: number) {
      clockAdvances.push(deltaSeconds);
      presentationElapsedSeconds += deltaSeconds;
      calls.push('clock:advance');
    },
  };
  const vessel = {
    encounterVelocity,
    observerDisplacementX: 7,
    observerDisplacementZ: -9,
    cameraAnchor: { x: 0, z: 0 },
    advanceWorldMotion(deltaSeconds: number) {
      expect(deltaSeconds).toBe(0.05);
      calls.push('vessel:advance-world');
    },
    updateFrameNavigationAndWind(deltaSeconds: number, windState: unknown) {
      expect(deltaSeconds).toBe(0.05);
      navigationSeaWinds.push(windState);
      calls.push('vessel:navigation-wind');
    },
    integrate(deltaSeconds: number, elapsedSeconds: number) {
      vesselIntegrations.push([deltaSeconds, elapsedSeconds]);
      calls.push('vessel:integrate');
    },
    present(deltaSeconds: number, elapsedSeconds: number) {
      vesselPresentations.push([deltaSeconds, elapsedSeconds]);
      calls.push('vessel:present');
    },
    prepareOceanMasks() {
      calls.push('vessel:ocean-masks');
    },
    updateTrimPickTargets() {
      calls.push('vessel:pick-targets');
    },
    refreshRigLoft() {
      calls.push('vessel:rig-loft');
    },
  };
  const wake = {
    foamHullWakeSource: hullWake,
    foamWaterlineWakeSource: waterlineWake,
    // WK3. Inactive here, which is the state of nearly every real frame: the
    // surface phase must not touch the particle pool when no bow tear is open,
    // and the exact call-order assertion below is what enforces it.
    hullSprayBurst: createHullSprayBurst(),
    prepareWater(coverage: number, deltaSeconds: number) {
      wakePreparations.push([coverage, deltaSeconds]);
      calls.push('wake:prepare-water');
    },
  };
  const environment = {
    deriveEnvironment(deltaSeconds: number) {
      expect(deltaSeconds).toBe(0.05);
      calls.push('environment:derive');
    },
    prepareScene(elapsedSeconds: number) {
      environmentScenes.push(elapsedSeconds);
      calls.push('environment:prepare-scene');
    },
  };
  // Audio is handed the frame's own sea instant and the coverage the ocean
  // phase already computed for the foam — not the controller's live getter,
  // and not a second Monahan evaluation. Pinning identity (`toBe`) rather than
  // equality is the point: it is what stops a later refactor quietly giving
  // the sound a different sea from the one the water was drawn from.
  const ambienceSeas: unknown[] = [];
  const ambienceCoverages: number[] = [];
  const ambience = {
    update(receivedSea: unknown, receivedCoverage: number) {
      ambienceSeas.push(receivedSea);
      ambienceCoverages.push(receivedCoverage);
      calls.push('ambience:update');
    },
  };
  const cpu = {
    beginPass(name: string) {
      calls.push(`cpu:begin:${name}`);
    },
    endPass(name: string) {
      calls.push(`cpu:end:${name}`);
    },
  };
  const gpu = {
    beginPass(name: string) {
      calls.push(`gpu:begin:${name}`);
    },
    endPass(name: string) {
      calls.push(`gpu:end:${name}`);
    },
  };
  const seaStates = {
    get state() {
      seaStateReadCount++;
      if (options.mutatingFrameSnapshots) {
        calls.push('sea:read-state');
      }
      return options.mutatingFrameSnapshots && seaStateReadCount > 1
        ? laterSea
        : sea;
    },
    advance(deltaSeconds: number) {
      expect(deltaSeconds).toBe(0.05);
      calls.push('sea:advance');
      return options.seaStateAdvanced ?? true;
    },
  };
  const weather = options.weatherEnabled
    ? {
        source: options.weatherSource ?? 'live',
        advance() {
          weatherAdvanceCount++;
        },
        get elapsedSeconds() {
          return 27;
        },
        wind: {
          speedMps: 11,
          directionDeg: 220,
          gustiness: 0.4,
        },
        state: {
          gustExcessMps: 3.4,
          gustPatchMetres: 84,
          gustPeriodSeconds: 24,
        },
      }
    : undefined;

  const runtime = new ProductionSimulationRuntime({
    world: {
      presentationClock,
      wind: {
        direction: windDirection,
        strength: 6,
        sail,
        updatePresentation(deltaSeconds: number) {
          expect(deltaSeconds).toBe(0.05);
          calls.push('wind:update-presentation');
        },
      },
      world: {
        state: {
          worldInstantUtcSeconds: 0,
          worldSecondsPerRealSecond: 30,
          paused: false,
          positionEcefM: { x: 6_378_137, y: 0, z: 0 },
          velocityEcefMps: { x: 0, y: 0, z: 0 },
          surfaceFrameEcef: {
            right: { x: 0, y: 1, z: 0 },
            forward: { x: 0, y: 0, z: 1 },
            up: { x: 1, y: 0, z: 0 },
          },
        },
        advanceClockRealSeconds(deltaSeconds: number) {
          worldClockAdvances.push(deltaSeconds);
          calls.push('world:advance-clock');
        },
      },
      worldWind: { meanSpeedMps: 11 },
      seaStates,
      waves,
      ...(weather ? { weather } : {}),
    },
    presentation: {
      vessel,
      wake,
      environment,
      cameras: { camera },
      ambience,
      ...(weather
        ? {
            weather: {
              applyEnvironment() {
                terrainHazeApplications.push(9_000);
                calls.push('weather:environment');
              },
              update() {
                calls.push('weather:update');
              },
            },
          }
        : {}),
      ...(options.explicitTerrainHazeM === undefined
        ? {}
        : {
            applyExplicitTerrainHazeOverride() {
              terrainHazeApplications.push(options.explicitTerrainHazeM!);
              calls.push('terrain:explicit-haze');
            },
          }),
    },
    surface: {
      renderer,
      foam,
      crestSpray,
      ocean,
      lighting,
      tuning,
    },
    profilers: { cpu, gpu },
  } as unknown as ProductionSimulationRuntimeOptions);

  return {
    runtime,
    calls,
    foamOptions,
    oceanDetailOptions,
    oceanFoamOptions,
    oceanUpdates,
    sprayUpdates,
    sprayLights,
    wakePreparations,
    vesselIntegrations,
    vesselPresentations,
    environmentScenes,
    clockAdvances,
    worldClockAdvances,
    scratchDirections,
    saltLoadings,
    cloudOcclusions,
    terrainHazeApplications,
    appliedSeaStates,
    navigationSeaWinds,
    get weatherAdvanceCount() {
      return weatherAdvanceCount;
    },
    tuning,
    ambienceSeas,
    ambienceCoverages,
    snapshotReadCounts: {
      get seaState() {
        return seaStateReadCount;
      },
      get presentationElapsed() {
        return presentationElapsedReadCount;
      },
    },
    identities: {
      sea,
      laterSea,
      renderer,
      waves,
      windDirection,
      encounterVelocity,
      hullWake,
      waterlineWake,
      lighting,
      sail,
    },
  };
}

describe('ProductionSimulationRuntime', () => {
  it('executes the seven real phase bodies and profiler spans in exact order', () => {
    const fixture = createFixture();

    fixture.runtime.step(0.05, 3.25);

    expect(fixture.calls).toEqual([
      'cpu:begin:worldAndLighting',
      'clock:advance',
      'wind:update-presentation',
      'world:advance-clock',
      'vessel:advance-world',
      'sea:advance',
      'waves:apply:true',
      'ocean:refresh',
      'vessel:navigation-wind',
      'cpu:end:worldAndLighting',
      'cpu:begin:vesselAndCamera',
      'vessel:integrate',
      'cpu:end:vesselAndCamera',
      'cpu:begin:worldAndLighting',
      'environment:derive',
      'cpu:end:worldAndLighting',
      'cpu:begin:vesselAndCamera',
      'vessel:present',
      'cpu:end:vesselAndCamera',
      'wake:prepare-water',
      'cpu:begin:foamAndSpray',
      'gpu:begin:foamSimulation',
      'foam:update',
      'gpu:end:foamSimulation',
      'spray:update',
      'camera:direction',
      'spray:light',
      'ocean:salt',
      'cpu:end:foamAndSpray',
      'cpu:begin:oceanPreparation',
      'ocean:attach-foam',
      'ocean:update',
      'vessel:ocean-masks',
      'ocean:cloud',
      'cpu:end:oceanPreparation',
      'cpu:begin:skyAndScene',
      'environment:prepare-scene',
      'vessel:pick-targets',
      'ambience:update',
      'vessel:rig-loft',
      'cpu:end:skyAndScene',
    ]);
    expect(fixture.clockAdvances).toEqual([0.05]);
    expect(fixture.worldClockAdvances).toEqual([3.25]);
    expect(fixture.vesselIntegrations).toEqual([[0.05, 12.55]]);
    expect(fixture.vesselPresentations).toEqual([[0.05, 12.55]]);
    expect(fixture.environmentScenes).toEqual([12.55]);
  });

  it('preserves live identities and the foam, spray, salt, and ocean formulas', () => {
    const fixture = createFixture();
    fixture.runtime.step(0.05, 3.25);

    const coverage = whitecapCoverage(10);
    expect(fixture.wakePreparations[0]).toEqual([coverage, 0.05]);
    expect(fixture.foamOptions[0]).toMatchObject({
      windSpeed: 11,
      generation: 1.2,
      persistenceSeconds: 18,
      gustiness: 0.4,
      streak: 0.6,
      windAdvection: 0.35,
      noiseTime: 12.55,
      frozen: false,
    });
    expect(fixture.foamOptions[0].windDir).toBe(
      fixture.identities.windDirection,
    );
    expect(fixture.foamOptions[0].observerVelocity).toBe(
      fixture.identities.encounterVelocity,
    );
    expect(fixture.foamOptions[0].hullWake).toBe(
      fixture.identities.hullWake,
    );
    expect(fixture.foamOptions[0].waterlineWake).toBe(
      fixture.identities.waterlineWake,
    );

    expect(fixture.sprayUpdates[0]).toEqual([
      0.05,
      fixture.identities.waves,
      0.6,
      0.8,
      11,
      0.7,
      0.4,
      12.55,
      7,
      -9,
    ]);
    expect(fixture.sprayLights[0]).toEqual([
      fixture.identities.lighting.ambientRadiance,
      fixture.identities.lighting.sunLightColor,
      12 * SPRAY_SUN_GAIN,
      2.65,
    ]);
    expect(fixture.saltLoadings[0]).toBeCloseTo(
      SALT_DENSITY_FULL * 0.25 * 0.4,
    );

    const ocean = fixture.oceanUpdates[0];
    expect(ocean.slice(0, 9)).toEqual([
      275,
      0,
      30,
      -40,
      12.55,
      fixture.identities.windDirection,
      6,
      fixture.identities.lighting.ambientRadiance,
      fixture.identities.lighting.skySh,
    ]);
    expect(fixture.oceanDetailOptions[0]).toEqual({
      scale: 1.4,
      strength: 0.8 * 0.5 * 0.4,
      streak: 0.6,
    });
    expect(fixture.oceanFoamOptions[0]).toEqual({
      strength: 1,
      breakup: 0.22,
      coverage: coverage * 1.2 * 0.26,
    });
  });

  it("publishes one WeatherState cat's-paw frame to foam and ocean", () => {
    const fixture = createFixture({ weatherEnabled: true });
    fixture.runtime.step(0.05, 3.25);

    const foamFrame = fixture.foamOptions[0].catsPaw;
    const oceanFrame = fixture.oceanDetailOptions[0].catsPaw;
    expect(fixture.weatherAdvanceCount).toBe(1);
    expect(foamFrame).toBe(oceanFrame);
    expect(foamFrame).toMatchObject({
      gustExcessMps: 3.4,
      patchSizeM: 84,
      periodSeconds: 24,
    });
  });

  it('enables sun pools only for non-neutral weather', () => {
    const absent = createFixture();
    absent.runtime.step(0.05, 3.25);
    expect(absent.cloudOcclusions).toEqual([[0.72, 0.41, 0]]);

    const neutral = createFixture({
      weatherEnabled: true,
      weatherSource: 'neutral',
    });
    neutral.runtime.step(0.05, 3.25);
    expect(neutral.cloudOcclusions).toEqual([[0.72, 0.41, 0]]);

    const live = createFixture({ weatherEnabled: true, weatherSource: 'live' });
    live.runtime.step(0.05, 3.25);
    expect(live.cloudOcclusions).toEqual([[0.72, 0.41, 1]]);
  });

  it('preserves ordinary weather visibility and reapplies only an explicit terrain capture haze', () => {
    const ordinary = createFixture({ weatherEnabled: true });
    ordinary.runtime.step(0.05, 3.25);
    ordinary.runtime.step(0.05, 3.25);
    expect(ordinary.terrainHazeApplications).toEqual([9_000, 9_000]);
    expect(ordinary.calls).not.toContain('terrain:explicit-haze');

    const explicit = createFixture({
      weatherEnabled: true,
      explicitTerrainHazeM: 120_000,
    });
    explicit.runtime.step(0.05, 3.25);
    explicit.runtime.step(0.05, 3.25);
    expect(explicit.terrainHazeApplications).toEqual([
      9_000,
      120_000,
      9_000,
      120_000,
    ]);
    expect(
      explicit.calls.indexOf('terrain:explicit-haze'),
    ).toBeGreaterThan(explicit.calls.indexOf('environment:derive'));
  });

  it('preserves default raw time, sea-refresh branching, live trims, and scratch reuse', () => {
    const fixture = createFixture({
      seaStateAdvanced: false,
      detailEnabled: false,
    });
    fixture.tuning.foamFrozen = true;
    fixture.tuning.foamStrength = 0.4;
    fixture.tuning.saltScale = 0.5;

    fixture.runtime.step(0.05);
    fixture.runtime.step(0.05);

    expect(fixture.worldClockAdvances).toEqual([0.05, 0.05]);
    expect(fixture.calls).not.toContain('waves:apply:true');
    expect(fixture.calls).not.toContain('ocean:refresh');
    expect(fixture.foamOptions.map((entry) => entry.frozen)).toEqual([
      true,
      true,
    ]);
    expect(fixture.oceanDetailOptions.map((entry) => entry.strength)).toEqual([
      0,
      0,
    ]);
    expect(fixture.oceanFoamOptions.map((entry) => entry.strength)).toEqual([
      0.4,
      0.4,
    ]);
    expect(fixture.saltLoadings).toEqual([
      SALT_DENSITY_FULL * 0.5 * 0.4,
      SALT_DENSITY_FULL * 0.5 * 0.4,
    ]);

    expect(fixture.scratchDirections[1]).toBe(
      fixture.scratchDirections[0],
    );
    // Preserve the established per-frame allocation shape while retaining live
    // resource identities within each options record.
    expect(fixture.foamOptions[1]).not.toBe(fixture.foamOptions[0]);
    expect(fixture.oceanDetailOptions[1]).not.toBe(
      fixture.oceanDetailOptions[0],
    );
    expect(fixture.oceanFoamOptions[1]).not.toBe(
      fixture.oceanFoamOptions[0],
    );
  });

  it('retains one authoritative sea object and elapsed instant for each frame', () => {
    const fixture = createFixture({ mutatingFrameSnapshots: true });

    fixture.runtime.step(0.05, 3.25);
    expect(fixture.calls.slice(0, 12)).toEqual([
      'cpu:begin:worldAndLighting',
      'clock:advance',
      'wind:update-presentation',
      'world:advance-clock',
      'vessel:advance-world',
      'sea:advance',
      'sea:read-state',
      'waves:apply:true',
      'ocean:refresh',
      'vessel:navigation-wind',
      'clock:read-elapsed',
      'cpu:end:worldAndLighting',
    ]);
    fixture.runtime.step(0.05, 3.25);

    expect(fixture.snapshotReadCounts.seaState).toBe(2);
    expect(fixture.snapshotReadCounts.presentationElapsed).toBe(2);
    expect(fixture.appliedSeaStates[0]).toBe(fixture.identities.sea);
    expect(fixture.appliedSeaStates[1]).toBe(fixture.identities.laterSea);
    expect(fixture.navigationSeaWinds[0]).toBe(
      fixture.identities.sea.generatingWind,
    );
    expect(fixture.navigationSeaWinds[1]).toBe(
      fixture.identities.laterSea.generatingWind,
    );

    const frameElapsedSeconds = [12.55, 112.6];
    for (let frameIndex = 0; frameIndex < 2; frameIndex++) {
      const elapsedSeconds = frameElapsedSeconds[frameIndex];
      expect(fixture.vesselIntegrations[frameIndex][1]).toBeCloseTo(
        elapsedSeconds,
      );
      expect(fixture.vesselPresentations[frameIndex][1]).toBeCloseTo(
        elapsedSeconds,
      );
      expect(fixture.foamOptions[frameIndex].noiseTime).toBeCloseTo(
        elapsedSeconds,
      );
      expect(fixture.sprayUpdates[frameIndex][7]).toBeCloseTo(
        elapsedSeconds,
      );
      expect(fixture.oceanUpdates[frameIndex][4]).toBeCloseTo(
        elapsedSeconds,
      );
      expect(fixture.environmentScenes[frameIndex]).toBeCloseTo(
        elapsedSeconds,
      );
    }

    expect(fixture.wakePreparations[0][0]).toBeCloseTo(
      whitecapCoverage(10),
    );
    expect(fixture.wakePreparations[1][0]).toBeCloseTo(
      whitecapCoverage(14),
    );
    expect(fixture.foamOptions.map((entry) => entry.generation)).toEqual([
      1.2,
      1.6,
    ]);
    expect(fixture.oceanDetailOptions.map((entry) => entry.scale)).toEqual([
      1.4,
      2,
    ]);
    expect(fixture.oceanFoamOptions.map((entry) => entry.breakup)).toEqual([
      0.22,
      0.5,
    ]);
  });

  it('gives audio the same sea instant and coverage the water was built from', () => {
    const fixture = createFixture({ mutatingFrameSnapshots: true });

    fixture.runtime.step(0.05, 3.25);
    fixture.runtime.step(0.05, 3.25);

    // Identity, not equality: the frame resolves one sea object and every
    // later phase must read that exact one. Audio reading the controller's
    // live getter instead would pass an equality check and still be the bug.
    expect(fixture.ambienceSeas).toEqual([
      fixture.identities.sea,
      fixture.identities.laterSea,
    ]);
    expect(fixture.ambienceSeas[0]).toBe(fixture.identities.sea);
    expect(fixture.ambienceSeas[1]).toBe(fixture.identities.laterSea);

    // And the coverage is the ocean phase's own number, so the hiss you hear
    // and the foam you see are scaled by one evaluation of Monahan.
    expect(fixture.ambienceCoverages).toEqual([
      fixture.wakePreparations[0][0],
      fixture.wakePreparations[1][0],
    ]);
    expect(fixture.ambienceCoverages[0]).toBeCloseTo(whitecapCoverage(10));
  });
});
