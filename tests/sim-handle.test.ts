import { describe, expect, it, vi } from 'vitest';

const temporalMock = vi.hoisted(() => ({
  constructions: [] as unknown[][],
  events: [] as string[],
  instances: [] as unknown[],
}));

vi.mock('../src/render/OceanTemporalResolve', () => ({
  OceanTemporalResolve: class MockOceanTemporalResolve {
    constructor(...args: unknown[]) {
      temporalMock.constructions.push(args);
      temporalMock.instances.push(this);
      temporalMock.events.push('temporal:construct');
    }

    invalidate(): void {
      temporalMock.events.push('temporal:invalidate');
    }

    setStability(stability: number): void {
      temporalMock.events.push(`temporal:stability:${String(stability)}`);
    }

    dispose(): void {
      temporalMock.events.push('temporal:dispose');
    }
  },
}));

import type { OceanTemporalResolve } from '../src/render/OceanTemporalResolve';
import type { RuntimeDiagnostics } from '../src/runtime/diagnostics/RuntimeDiagnosticsContract';
import type { SimHandle } from '../src/runtime/diagnostics/SimHandle';
import {
  createSimHandle,
  createSimHandleBinding,
  type SimHandlePresentationPort,
  type SimHandleResources,
  type SimHandleSimulationPort,
  type SimHandleWakePort,
} from '../src/runtime/diagnostics/createSimHandle';
import type { SeaState } from '../src/ocean/seaState';

const DIAGNOSTIC_METHODS = [
  'runOceanProfileProbe',
  'runDirectShadowBenchmark',
  'runPairedToggleBenchmark',
  'runWakeTrailCostBenchmark',
  'runWakeBowCostBenchmark',
  'runOceanResidualActiveBenchmark',
  'runOceanDetailBenchmark',
  'runOceanDetailRepresentationBenchmark',
  'runOceanDetailContactSheet',
  'runWhitewaterCostBenchmark',
  'runOceanViolenceEvidence',
  'runShapeLadder',
  'runFoamGainLadder',
  'runOceanCloudHazeContactSheet',
  'runWakeContactSheet',
  'runWakeWk2ContactSheet',
  'runOceanResidualDiff',
  'runOceanDetailCategoryProbe',
  'runOceanDetailCategoryMatrix',
  'runOceanResidualCategoryProbe',
  'runOceanResidualCategoryMatrix',
  'serviceFrameReadback',
  'captureIfRequested',
] as const;

interface Fixture {
  calls: string[];
  diagnostics: RuntimeDiagnostics;
  presentation: SimHandlePresentationPort;
  presentationState: {
    exposureBias: number;
    foamFrozen: boolean;
    foamAdvectionEnabled: boolean;
    foamStrength: number;
    foamLookupLegacy: boolean;
    saltScale: number;
    oceanTemporal: OceanTemporalResolve | undefined;
    oceanTemporalStability: number;
  };
  resources: SimHandleResources;
  sim: SimHandle;
  simulation: SimHandleSimulationPort;
  simulationState: { elapsedSeconds: number };
  wake: SimHandleWakePort;
  wakeState: {
    prescribed: boolean;
    targetSpeedMps: number;
    trueHeadingRad: number;
    diagnosticTowLeewayRad: number;
  };
}

function createDiagnostics(): RuntimeDiagnostics {
  return Object.fromEntries(
    DIAGNOSTIC_METHODS.map((method) => [method, vi.fn()]),
  ) as unknown as RuntimeDiagnostics;
}

function createSeaState(overrides: {
  frozen?: boolean;
  windSpeedMps?: number;
  windAdvection?: number;
} = {}): SeaState {
  return {
    frozen: overrides.frozen,
    generatingWind: {
      speedMps: overrides.windSpeedMps ?? 12,
      gustiness: 0.35,
    },
    whitewater: {
      generation: 0.7,
      persistenceSeconds: 18,
      windAdvection: overrides.windAdvection ?? 0.6,
    },
    roughness: { gustStreak: 0.45 },
  } as unknown as SeaState;
}

function createFixture(options: {
  oceanTemporal?: OceanTemporalResolve;
  resetHorizontalMotion?: boolean;
} = {}): Fixture {
  const calls: string[] = [];
  const simulationState = { elapsedSeconds: 37 };
  const presentationState = {
    exposureBias: 1,
    foamFrozen: false,
    foamAdvectionEnabled: true,
    foamStrength: 1,
    foamLookupLegacy: false,
    saltScale: 0.25,
    oceanTemporal: options.oceanTemporal,
    oceanTemporalStability: 50,
  };
  const wakeState = {
    prescribed: false,
    targetSpeedMps: 4,
    trueHeadingRad: 0.2,
    diagnosticTowLeewayRad: 0.05,
  };
  let currentSeaState = createSeaState();

  const renderer = { name: 'renderer' };
  const canvas = { name: 'canvas' };
  const scene = { name: 'scene' };
  const cameraSystem = {
    reset: () => calls.push('cameras:reset'),
  };
  const ocean = {
    refresh: () => calls.push('ocean:refresh'),
    setDetailOriginOverride: (value: unknown) =>
      calls.push(`ocean:detail:${value === null ? 'null' : 'vector'}`),
    setFoamLookup: () => calls.push('ocean:foamLookup'),
    setSkyRadianceLutEnabled: (enabled: boolean) =>
      calls.push(`ocean:radiance:${enabled}`),
    setTemporalDetailJitter: (x: number, y: number) => {
      temporalMock.events.push(`ocean:jitter:${x}:${y}`);
    },
    setVesselSkyOcclusion: (enabled: boolean) =>
      calls.push(`ocean:occlusion:${enabled}`),
    vesselSkyOcclusionEnabled: true,
  };
  let wavesFrozen = false;
  const waves = {
    originWorldX: 2,
    originWorldZ: -3,
    setOrigin: (x: number, z: number) => calls.push(`waves:origin:${x}:${z}`),
    setTime: (time: number) => calls.push(`waves:time:${time}`),
    applySeaState: (state: SeaState) => {
      calls.push(`waves:apply:${state === currentSeaState}`);
    },
    get frozen() {
      return wavesFrozen;
    },
    set frozen(frozen: boolean) {
      wavesFrozen = frozen;
      calls.push(`waves:frozen:${frozen}`);
    },
  };
  const windDirection = { x: 0.25, z: -0.75 };
  const wind = { direction: windDirection };
  const body = { reset: () => calls.push('body:reset') };
  const vessel = {
    body,
    resetEffects: () => calls.push('vessel:effects'),
  };
  const foam = {
    clear: (receivedRenderer: unknown) => {
      expect(receivedRenderer).toBe(renderer);
      calls.push('foam:clear');
    },
    warmUp: (
      receivedRenderer: unknown,
      receivedWaves: unknown,
      foamOptions: Record<string, unknown>,
    ) => {
      expect(receivedRenderer).toBe(renderer);
      expect(receivedWaves).toBe(waves);
      calls.push('foam:warm');
      calls.push(`foam:options:${JSON.stringify({
        windSpeed: foamOptions.windSpeed,
        windAdvection: foamOptions.windAdvection,
        noiseTime: foamOptions.noiseTime,
        frozen: foamOptions.frozen,
      })}`);
      expect(foamOptions.windDir).toBe(windDirection);
      expect(foamOptions.observerVelocity).toBe(encounterVelocity);
      expect(foamOptions.hullWake).toBe(foamHullWakeSource);
      expect(foamOptions.waterlineWake).toBe(foamWaterlineWakeSource);
    },
  };
  const crestSpray = { clear: () => calls.push('spray:clear') };
  const seaStates = {
    get state() {
      return currentSeaState;
    },
    set(state: SeaState, transitionSeconds: number) {
      currentSeaState = state;
      calls.push(`sea:set:${transitionSeconds}`);
    },
  };
  const skyMesh = { name: 'sky-mesh' };
  const starMesh = { name: 'star-mesh' };
  const sky = {
    mesh: skyMesh,
    setCloudsEnabled: (enabled: boolean) =>
      calls.push(`sky:clouds:${enabled}`),
    setRadianceLutEnabled: (enabled: boolean) =>
      calls.push(`sky:radiance:${enabled}`),
    reset: () => calls.push('sky:reset'),
  };
  const stars = { mesh: starMesh };
  const lighting = { sunLightIntensity: 7, exposure: 0.4 };
  const wakeSources = { name: 'wake-sources' };
  // Deliberately NOT the sea state's own wind. WX1 reported this facade as a
  // divergence-in-waiting — the handle handed foam `sea.wind.speedMps` where
  // production hands it `worldWind.meanSpeedMps` — and the two numbers being
  // different here is what makes the assertion below prove WX2 closed it.
  const worldWind = { meanSpeedMps: 5.5 };
  const chosenSeaStates: SeaState[] = [];
  const resources = {
    renderer,
    scene,
    canvas,
    cameras: cameraSystem,
    vessel,
    ocean,
    waves,
    wind,
    world: { name: 'world' },
    sky,
    stars,
    lighting,
    foam,
    crestSpray,
    wakeSources,
    seaStates,
    worldWind,
    onSeaStateChosen: (state: SeaState) => {
      chosenSeaStates.push(state);
      calls.push('sea:chosen');
    },
  } as unknown as SimHandleResources;

  const simulation: SimHandleSimulationPort = {
    stepSimulation(presentationDeltaSeconds, rawRealDeltaSeconds) {
      calls.push(
        `step:${presentationDeltaSeconds}:${String(rawRealDeltaSeconds)}`,
      );
    },
    renderFrame: vi.fn(),
    get elapsedSeconds() {
      return simulationState.elapsedSeconds;
    },
    setElapsedSeconds(elapsedSeconds) {
      simulationState.elapsedSeconds = elapsedSeconds;
      calls.push(`clock:${elapsedSeconds}`);
    },
    resetHorizontalMotion: options.resetHorizontalMotion === false
      ? undefined
      : () => calls.push('horizontal:reset'),
  };

  const foamLookup = { jitterTexels: 0, smoothing: 0 };
  const encounterVelocity = { x: 1.5, z: -2.5 };
  const sunShadow = { intensity: 1 };
  const worldLighting = {
    source: { target: { name: 'world-target' } },
    shCoefficients: new Float32Array([1, 2, 3]),
    publishedGeneration: 9,
    skyIrradiance: ({ x, y, z }: { x: number; y: number; z: number }) =>
      [x + 1, y + 2, z + 3] as [number, number, number],
  };
  const presentation = {
    worldLighting,
    encounterVelocity,
    sunShadow,
    foamLookup,
    refreshLighting: vi.fn(),
    refreshWorldLighting: vi.fn(),
    resetIntegrators: () => calls.push('integrators:reset'),
    setSunShadowing: vi.fn(),
    setLanternShadowing: vi.fn(),
    shadowingState: vi.fn(() => ({
      sun: true,
      sunActive: true,
      lantern: false,
      lanternActive: false,
    })),
    get exposureBias() {
      return presentationState.exposureBias;
    },
    set exposureBias(value: number) {
      presentationState.exposureBias = value;
    },
    get foamFrozen() {
      return presentationState.foamFrozen;
    },
    set foamFrozen(value: boolean) {
      presentationState.foamFrozen = value;
    },
    get foamAdvectionEnabled() {
      return presentationState.foamAdvectionEnabled;
    },
    set foamAdvectionEnabled(value: boolean) {
      presentationState.foamAdvectionEnabled = value;
    },
    get foamStrength() {
      return presentationState.foamStrength;
    },
    set foamStrength(value: number) {
      presentationState.foamStrength = value;
    },
    get foamLookupLegacy() {
      return presentationState.foamLookupLegacy;
    },
    set foamLookupLegacy(value: boolean) {
      presentationState.foamLookupLegacy = value;
    },
    get saltScale() {
      return presentationState.saltScale;
    },
    set saltScale(value: number) {
      presentationState.saltScale = value;
    },
    get oceanTemporal() {
      return presentationState.oceanTemporal;
    },
    set oceanTemporal(value: OceanTemporalResolve | undefined) {
      presentationState.oceanTemporal = value;
      temporalMock.events.push(
        `temporal:binding:${value === undefined ? 'undefined' : 'set'}`,
      );
    },
    get oceanTemporalStability() {
      return presentationState.oceanTemporalStability;
    },
    set oceanTemporalStability(value: number) {
      presentationState.oceanTemporalStability = value;
    },
  } as unknown as SimHandlePresentationPort;

  const foamHullWakeSource = { name: 'hull-wake' };
  const foamWaterlineWakeSource = { name: 'waterline-wake' };
  const wakeTrailPolicy = { name: 'trail-policy' };
  const wakeBowPolicy = { name: 'bow-policy' };
  const wakePatternPolicy = { name: 'pattern-policy' };
  const hullSprayEvents = { name: 'hull-spray-events' };
  const wakePresentation = {
    foamHullWakeSource,
    foamWaterlineWakeSource,
    wakeTrailPolicy,
    wakeBowPolicy,
    wakePatternPolicy,
    hullSprayEvents,
    setHullSprayDensityScale: vi.fn(),
    hullSprayDensity: vi.fn(() => 1),
    resetHullSprayEvents: () => calls.push('wake:spray-reset'),
    setWakeEffectsEnabled: vi.fn(),
    wakeEffectsEnabled: vi.fn(() => true),
    setWakeTrailFeatureEnabled: vi.fn(),
    wakeTrailFeatureEnabled: vi.fn(() => true),
    setWakeBowFeatureEnabled: vi.fn(),
    wakeBowFeatureEnabled: vi.fn(() => false),
    wakeSpeedThroughWaterMps: vi.fn(() => 6.5),
  };
  const wake = {
    presentation: wakePresentation,
    speedTarget: {
      get isPrescribed() {
        return wakeState.prescribed;
      },
      get targetSpeedMps() {
        return wakeState.targetSpeedMps;
      },
    },
    motionControls: {
      trueHeadingRad: () => wakeState.trueHeadingRad,
      setTrueHeadingRad(trueHeadingRad: number) {
        wakeState.trueHeadingRad = trueHeadingRad;
        calls.push(`tow:heading:${trueHeadingRad}`);
      },
      releaseTow() {
        wakeState.prescribed = false;
        calls.push('tow:release');
      },
    },
    prescribeVesselSpeedMps(speedMps: number) {
      wakeState.prescribed = true;
      wakeState.targetSpeedMps = speedMps;
      calls.push(`tow:speed:${speedMps}`);
    },
    get diagnosticTowLeewayRad() {
      return wakeState.diagnosticTowLeewayRad;
    },
    set diagnosticTowLeewayRad(leewayRad: number) {
      wakeState.diagnosticTowLeewayRad = leewayRad;
      calls.push(`tow:leeway:${leewayRad}`);
    },
    sailClothMode: () => 'alive',
    poseOnTrueWindAngleDeg(angleDeg: number) {
      calls.push(`pose:${angleDeg}`);
      return angleDeg;
    },
  } as unknown as SimHandleWakePort;

  const diagnostics = createDiagnostics();
  const sim = createSimHandle(
    resources,
    simulation,
    presentation,
    wake,
    diagnostics,
  );

  return {
    calls,
    diagnostics,
    presentation,
    presentationState,
    resources,
    sim,
    simulation,
    simulationState,
    wake,
    wakeState,
  };
}

describe('SimHandle binding', () => {
  it('binds one live handle synchronously and rejects invalid lifecycle use', () => {
    const binding = createSimHandleBinding();
    const handle = { renderer: {} } as unknown as SimHandle;

    expect(() => binding.get()).toThrow('SimHandle has not been bound');
    expect(binding.bind(handle)).toBe(handle);
    expect(binding.get()).toBe(handle);
    expect(() => binding.bind(handle)).toThrow('SimHandle has already been bound');
  });
});

describe('SimHandle factory', () => {
  it('preserves resource, policy, command identity and public property order', () => {
    const fixture = createFixture();

    expect(fixture.sim.renderer).toBe(fixture.resources.renderer);
    expect(fixture.sim.wakeSources).toBe(fixture.resources.wakeSources);
    expect(fixture.sim.foamLookup).toBe(fixture.presentation.foamLookup);
    expect(fixture.sim.renderFrame).toBe(fixture.simulation.renderFrame);
    expect(fixture.sim.refreshLighting).toBe(
      fixture.presentation.refreshLighting,
    );
    expect(fixture.sim.setSunShadowing).toBe(
      fixture.presentation.setSunShadowing,
    );
    expect(fixture.sim.runOceanProfileProbe).toBe(
      fixture.diagnostics.runOceanProfileProbe,
    );
    expect(Object.keys(fixture.sim)).toEqual([
      'renderer',
      'scene',
      'canvas',
      'cameras',
      'vessel',
      'ocean',
      'waves',
      'wind',
      'world',
      'sky',
      'stars',
      'lighting',
      'foam',
      'crestSpray',
      'wakeSources',
      'seaStates',
      'stepSimulation',
      'renderFrame',
      'elapsed',
      'originX',
      'originZ',
      'setPresentationOrigin',
      'refreshLighting',
      'refreshWorldLighting',
      'worldLightingSourceTarget',
      'worldLightingCoefficients',
      'worldLightingDiagnostics',
      'setExposureBias',
      'setSeaState',
      'setFoamFrozen',
      'setFoamAdvectionEnabled',
      'foamAdvectionEnabled',
      'setDetailOriginOverride',
      'setFoamStrength',
      'setWakeEffectsEnabled',
      'wakeEffectsEnabled',
      'setWakeTrailFeatureEnabled',
      'wakeTrailFeatureEnabled',
      'wakeTrailPolicy',
      'setWakeBowFeatureEnabled',
      'wakeBowFeatureEnabled',
      'wakeBowPolicy',
      'wakePatternPolicy',
      'hullSprayEvents',
      'setHullSprayDensityScale',
      'hullSprayDensity',
      'wakeSpeedThroughWaterMps',
      'setFoamLookupLegacy',
      'foamLookupLegacy',
      'setFoamLookupValues',
      'foamLookup',
      'wakeDiagnosticMotionState',
      'setWakeDiagnosticTow',
      'sailClothMode',
      'poseOnTrueWindAngleDeg',
      'restoreWakeDiagnosticMotion',
      'runWakeContactSheet',
      'runWakeWk2ContactSheet',
      'setCloudsEnabled',
      'setSkyRadianceLutEnabled',
      'setOceanTemporalEnabled',
      'oceanTemporalEnabled',
      'setOceanTemporalStability',
      'oceanTemporalStability',
      'setVesselSkyOcclusion',
      'vesselSkyOcclusionEnabled',
      'sunShadowStrength',
      'setSunShadowStrength',
      'setSunShadowing',
      'setLanternShadowing',
      'shadowingState',
      'runDirectShadowBenchmark',
      'runOceanProfileProbe',
      'runOceanDetailBenchmark',
      'runOceanDetailRepresentationBenchmark',
      'runOceanDetailContactSheet',
      'runOceanCloudHazeContactSheet',
      'runOceanViolenceEvidence',
      'runFoamGainLadder',
      'runShapeLadder',
      'runWhitewaterCostBenchmark',
      'runOceanDetailCategoryMatrix',
      'runOceanDetailCategoryProbe',
      'runOceanResidualActiveBenchmark',
      'runOceanResidualCategoryMatrix',
      'runOceanResidualCategoryProbe',
      'runOceanResidualDiff',
      'setSaltScale',
      'clearFoam',
      'warmFoam',
      'resetSimulation',
    ]);
  });

  it('keeps mutable presentation state live and invalidates after mutations', () => {
    const temporal = {
      invalidate: () => fixture.calls.push('temporal:invalidate'),
    } as unknown as OceanTemporalResolve;
    const fixture = createFixture({ oceanTemporal: temporal });

    fixture.sim.setPresentationOrigin(8, -9);
    expect(fixture.calls).toEqual([
      'waves:origin:8:-9',
      'temporal:invalidate',
    ]);

    fixture.calls.length = 0;
    fixture.sim.setDetailOriginOverride(4, 5);
    expect(fixture.calls).toEqual([
      'ocean:detail:vector',
      'temporal:invalidate',
    ]);

    fixture.sim.setFoamFrozen(true);
    fixture.sim.setFoamAdvectionEnabled(false);
    fixture.sim.setFoamStrength(0.4);
    fixture.sim.setExposureBias(1.2);
    fixture.sim.setSaltScale(-5);
    expect(fixture.presentationState).toMatchObject({
      exposureBias: 1.2,
      foamFrozen: true,
      foamAdvectionEnabled: false,
      foamStrength: 0.4,
      saltScale: 0,
    });
    expect(fixture.sim.foamAdvectionEnabled()).toBe(false);

    fixture.sim.setSunShadowStrength(-1);
    expect(fixture.sim.sunShadowStrength()).toBe(0);
    fixture.sim.setSunShadowStrength(2);
    expect(fixture.sim.sunShadowStrength()).toBe(1);
    fixture.sim.setSunShadowStrength(Number.NaN);
    expect(Number.isNaN(fixture.sim.sunShadowStrength())).toBe(true);
    fixture.sim.setSunShadowing(false);
    fixture.sim.setLanternShadowing(true);
    expect(fixture.presentation.setSunShadowing).toHaveBeenCalledWith(false);
    expect(fixture.presentation.setLanternShadowing).toHaveBeenCalledWith(true);
    expect(fixture.sim.shadowingState()).toEqual({
      sun: true,
      sunActive: true,
      lantern: false,
      lanternActive: false,
    });
  });

  it('preserves temporal enable, disable and stability mutation order', () => {
    temporalMock.constructions.length = 0;
    temporalMock.instances.length = 0;
    temporalMock.events.length = 0;
    const fixture = createFixture();

    fixture.sim.setOceanTemporalEnabled(true);
    expect(temporalMock.constructions).toEqual([
      [
        fixture.resources.renderer,
        fixture.resources.ocean,
        true,
        fixture.resources.sky.mesh,
        [fixture.resources.stars.mesh],
      ],
    ]);
    expect(fixture.presentationState.oceanTemporal).toBe(
      temporalMock.instances[0],
    );
    expect(temporalMock.events).toEqual([
      'temporal:construct',
      'temporal:binding:set',
      'temporal:stability:50',
    ]);

    fixture.sim.setOceanTemporalEnabled(true);
    expect(temporalMock.constructions).toHaveLength(1);

    temporalMock.events.length = 0;
    fixture.sim.setOceanTemporalStability(-20);
    fixture.sim.setOceanTemporalStability(120);
    fixture.sim.setOceanTemporalStability(Number.NaN);
    expect(temporalMock.events).toEqual([
      'temporal:stability:0',
      'temporal:stability:100',
      'temporal:stability:NaN',
    ]);
    expect(Number.isNaN(fixture.presentationState.oceanTemporalStability)).toBe(
      true,
    );

    temporalMock.events.length = 0;
    fixture.sim.setOceanTemporalEnabled(false);
    expect(temporalMock.events).toEqual([
      'temporal:dispose',
      'temporal:binding:undefined',
      'ocean:jitter:0:0',
    ]);
    expect(fixture.presentationState.oceanTemporal).toBeUndefined();

    temporalMock.events.length = 0;
    fixture.sim.setOceanTemporalEnabled(false);
    expect(temporalMock.events).toEqual([
      'temporal:binding:undefined',
      'ocean:jitter:0:0',
    ]);
  });

  it('preserves snapped sea-state and complete reset/warm-up order', () => {
    const fixture = createFixture();
    const temporal = {
      invalidate: () => fixture.calls.push('temporal:invalidate'),
    } as unknown as OceanTemporalResolve;
    fixture.presentation.oceanTemporal = temporal;
    fixture.calls.length = 0;
    const state = createSeaState({
      frozen: true,
      windSpeedMps: 16,
      windAdvection: 0.8,
    });

    fixture.sim.setSeaState(state, 2);
    // The choice hook fires first and unconditionally: a sea somebody picked
    // has to re-base the wind-sea memory before the controller starts moving
    // toward it. (WX2, `src/ocean/WindSeaMemory.ts`.)
    expect(fixture.calls).toEqual(['sea:chosen', 'sea:set:2']);

    fixture.calls.length = 0;
    fixture.sim.setSeaState(state);
    expect(fixture.calls).toEqual([
      'sea:chosen',
      'sea:set:0',
      'waves:apply:true',
      'waves:frozen:true',
      'ocean:refresh',
      'temporal:invalidate',
    ]);

    fixture.calls.length = 0;
    fixture.presentation.foamAdvectionEnabled = false;
    fixture.sim.resetSimulation(state, 7, -8);
    expect(fixture.calls).toEqual([
      'clock:0',
      // Clocks first. `SchoonerSailForces.reset` rebases on the wind clock,
      // so a vessel reset issued before these two pins the sails to the
      // previous scene's gust — which is what happened, and what the live
      // probe caught after every other cause was fixed.
      'sky:reset',
      'integrators:reset',
      'sea:chosen',
      'sea:set:0',
      'waves:apply:true',
      'waves:frozen:true',
      'waves:origin:7:-8',
      'waves:time:0',
      'ocean:refresh',
      'temporal:invalidate',
      'body:reset',
      'horizontal:reset',
      'vessel:effects',
      // WK3's detector holds the only per-frame history in the wake controller,
      // so it must be forgotten with the rest of the ship's state — before the
      // first step of the new sea, or it differences the new bow volume against
      // the old one and fires an entry on the change itself.
      'wake:spray-reset',
      'spray:clear',
      'foam:clear',
      'cameras:reset',
      'step:0:undefined',
      'foam:warm',
      'foam:options:{"windSpeed":5.5,"windAdvection":0,"noiseTime":0,"frozen":false}',
    ]);
  });

  it('validates and restores diagnostic tow state in the original order', () => {
    const fixture = createFixture();

    expect(() => fixture.sim.setWakeDiagnosticTow(4, Number.NaN, 0)).toThrow(
      RangeError,
    );
    expect(fixture.calls).toEqual([]);

    fixture.sim.setWakeDiagnosticTow(7, 1.1, -0.2);
    expect(fixture.calls).toEqual([
      'tow:speed:7',
      'tow:leeway:-0.2',
      'tow:heading:1.1',
    ]);
    expect(fixture.sim.wakeDiagnosticMotionState()).toEqual({
      prescribed: true,
      targetSpeedMps: 7,
      trueHeadingRad: 1.1,
      leewayRad: -0.2,
    });

    fixture.calls.length = 0;
    fixture.sim.restoreWakeDiagnosticMotion({
      prescribed: true,
      targetSpeedMps: 3,
      trueHeadingRad: 0.4,
      leewayRad: 0.1,
    });
    expect(fixture.calls).toEqual([
      'tow:leeway:0.1',
      'tow:speed:3',
      'tow:heading:0.4',
    ]);

    fixture.calls.length = 0;
    fixture.sim.restoreWakeDiagnosticMotion({
      prescribed: false,
      targetSpeedMps: 9,
      trueHeadingRad: -0.5,
      leewayRad: -0.15,
    });
    expect(fixture.calls).toEqual([
      'tow:leeway:-0.15',
      'tow:heading:-0.5',
      'tow:release',
    ]);
  });
});
