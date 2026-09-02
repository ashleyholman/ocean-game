import { describe, expect, it } from 'vitest';

import {
  RuntimeUi,
  type RuntimeUiDevTools,
  type RuntimeUiFactories,
  type RuntimeUiOptions,
  type RuntimeUiPanelLoaders,
  type RuntimeUiRenderStats,
} from '../src/runtime/RuntimeUi';
import type { BrowserFrameDriverReading } from '../src/runtime/BrowserFrameDriver';
import type { DevPanelEntry } from '../src/ui/DevTools';
import type { RenderStatsReading } from '../src/ui/RenderStats';

function createFixture({
  labEnabled = false,
  debugUiEnabled = true,
  terrainPromise,
}: {
  labEnabled?: boolean;
  debugUiEnabled?: boolean;
  terrainPromise?: Promise<unknown>;
} = {}) {
  const calls: string[] = [];
  const readings: RenderStatsReading[] = [];
  const snapshots: RenderStatsReading[] = [];
  let entries: DevPanelEntry[] | undefined;
  let hudEntries: Array<{ id: string; label: string }> | undefined;
  let releaseToHelm: (() => void) | undefined;

  const devTools: RuntimeUiDevTools = {
    chromeShown: true,
    open: async (id) => {
      calls.push(`dev.open:${id}`);
    },
    update: (dtSeconds) => calls.push(`dev.update:${dtSeconds}`),
    dispose: () => calls.push('dev.dispose'),
  };
  const renderStats: RuntimeUiRenderStats = {
    setVisible: (visible) => calls.push(`stats.visible:${visible}`),
    update: (dtSeconds, reading) => {
      calls.push(`stats.update:${dtSeconds}`);
      readings.push(reading);
      snapshots.push({ ...reading });
    },
    dispose: () => calls.push('stats.dispose'),
  };
  const factories: RuntimeUiFactories = {
    createDevTools: (createdEntries) => {
      calls.push('factory.devtools');
      entries = createdEntries;
      return devTools;
    },
    createRenderStats: () => {
      calls.push('factory.stats');
      return renderStats;
    },
    createPlayerHud: (createdEntries) => {
      calls.push('factory.playerhud');
      hudEntries = createdEntries;
      return devTools;
    },
  };

  const worldPanel = {
    element: {},
    state: { exposureBias: 0.72 },
    dispose: () => undefined,
  };
  const graphicsState = {
    sunMultiplier: 1.2,
    ambientMultiplier: 0.8,
    starLimitBias: 0.3,
  };
  const graphicsPanel = {
    element: {},
    state: graphicsState,
    dispose: () => undefined,
  };
  const panel = (name: string) => ({
    element: {},
    dispose: () => calls.push(`panel.dispose:${name}`),
  });
  const loaders = {
    world: async () => {
      calls.push('import.world');
      return {
        createWorldPanel: () => {
          calls.push('create.world');
          return worldPanel;
        },
      };
    },
    sailing: async () => {
      calls.push('import.sailing');
      return {
        createSailingPanel: (
          _controls: unknown,
          _read: unknown,
          release: () => void,
        ) => {
          calls.push('create.sailing');
          releaseToHelm = release;
          return panel('sailing');
        },
      };
    },
    camera: async () => {
      calls.push('import.camera');
      return {
        createCameraPanel: () => {
          calls.push('create.camera');
          return panel('camera');
        },
      };
    },
    terrain: async () => {
      calls.push('import.terrain');
      return {
        createTerrainPanel: () => {
          calls.push('create.terrain');
          return panel('terrain');
        },
      };
    },
    deck: async () => {
      calls.push('import.deck');
      return {
        createDeckPanel: () => {
          calls.push('create.deck');
          return panel('deck');
        },
      };
    },
    inspection: async () => {
      calls.push('import.inspection');
      return {
        createInspectionPanel: () => {
          calls.push('create.inspection');
          return panel('inspection');
        },
      };
    },
    ocean: async () => {
      calls.push('import.ocean');
      return {
        createOceanLab: () => {
          calls.push('create.ocean');
          return panel('ocean');
        },
      };
    },
    graphics: async () => {
      calls.push('import.graphics');
      return {
        createGraphicsPanel: () => {
          calls.push('create.graphics');
          return graphicsPanel;
        },
      };
    },
    sound: async () => {
      calls.push('import.sound');
      return {
        createSoundPanel: () => {
          calls.push('create.sound');
          return panel('sound');
        },
      };
    },
  } as unknown as RuntimeUiPanelLoaders;

  const cloudReading = {
    visibleTiles: 11,
    guardTiles: 12,
    residentTiles: 13,
    slotCapacity: 14,
    unmappedGuardTiles: 15,
    unmappedVisibleTiles: 16,
    cacheBytes: 17,
    fullCacheBytes: 18,
    atlasWidth: 19,
    atlasHeight: 20,
    bakedTiles: 21,
    rebaseTiles: 22,
    onDemandTiles: 23,
    stagingTiles: 24,
    catchUpTiles: 25,
    steadyBudget: 26,
    swapped: true,
  };
  const profileSettings = {
    vertexWaveSlots: 27,
    residualWaveSlots: 28,
    residualPhaseEnabled: true,
    residualLoopMode: 'rolled' as const,
    detailOctaves: 29,
    detailRepresentation: 'cached-1024' as const,
    detailTextureStyle: 'value-noise' as const,
    foamEnabled: true,
    flatFragment: false,
  };
  const cpuReading = { frame: 2 };
  const gpuReading = { supported: true, frame: 3 };
  const oceanSource = {
    skyRadianceLutEnabled: true,
    profileSettings,
  };
  const motionControls = {
    actualSpeedMps: () => 3,
    targetSpeedMps: () => 3,
    isPrescribedSpeed: () => false,
    increaseSpeed: () => undefined,
    decreaseSpeed: () => undefined,
    stop: () => undefined,
    releaseTow: () => calls.push('motion.release'),
    trueHeadingRad: () => 0,
    setTrueHeadingRad: () => undefined,
  };
  const sailingControls = {
    commandRudderDeg: (degrees: number) =>
      calls.push(`sailing.rudder:${degrees}`),
  };
  const simHandle = { identity: 'sim' };
  const resolvedTerrain = { identity: 'terrain' };
  const options = {
    labEnabled,
    debugUiEnabled,
    world: {
      world: {},
      astronomy: {},
      waves: {},
      motionControls,
      telemetry: () => ({}),
      requestCloudCacheRebase: () => undefined,
    },
    sailing: {
      controls: sailingControls,
      read: () => ({}),
    },
    cameras: {},
    ambience: { mixer: {}, voiceLevels: {}, worldState: {} },
    terrain: {
      handlePromise: () => {
        calls.push('terrain.await');
        return (terrainPromise ?? Promise.resolve(resolvedTerrain)) as Promise<never>;
      },
    },
    deck: { walker: {}, shipGroup: {} },
    inspection: {
      armed: false,
      recordedRays: [],
      recordedRay: null,
      arm: () => undefined,
      cancel: () => undefined,
      clear: () => undefined,
      subscribe: () => () => undefined,
    },
    getSimHandle: () => {
      calls.push('sim.get');
      return simHandle;
    },
    stats: {
      renderer: { getPixelRatio: () => 1.5 },
      canvas: { width: 1440, height: 900 },
      nativePixelRatio: () => 2,
      cpuProfiler: { reading: cpuReading },
      gpuProfiler: { reading: gpuReading },
      quality: { cloudMarch: 192, cloudSunSteps: 7 },
      cloudDome: { reading: cloudReading },
      radianceLut: { width: 256, height: 128 },
      ocean: oceanSource,
      waves: { residualActiveCount: 9 },
    },
    factories,
    panelLoaders: loaders,
  } as unknown as RuntimeUiOptions;
  const runtimeUi = new RuntimeUi(options);

  return {
    runtimeUi,
    options,
    calls,
    readings,
    snapshots,
    devTools,
    cloudReading,
    profileSettings,
    cpuReading,
    gpuReading,
    oceanSource,
    graphicsState,
    resolvedTerrain,
    get entries() {
      return entries;
    },
    get hudEntries() {
      return hudEntries;
    },
    get releaseToHelm() {
      return releaseToHelm;
    },
  };
}

function entry(fixture: ReturnType<typeof createFixture>, id: string) {
  const found = fixture.entries?.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing ${id} entry`);
  return found;
}

const FRAME: BrowserFrameDriverReading = {
  rawRealDeltaMilliseconds: 16,
  rawRealDeltaSeconds: 0.016,
  presentationDeltaSeconds: 0.016,
  adaptiveFrameAverageMilliseconds: 17,
  profilingReady: true,
  pixelRatioCap: 1.5,
  cadence: {
    fps: 60,
    frameMs: 1000 / 60,
    sampleCount: 60,
    sampledElapsedMs: 1000,
  },
};

describe('runtime UI', () => {
  it('constructs the shell before stats and short-circuits both in lab mode', () => {
    const fixture = createFixture();
    expect(fixture.calls).toEqual(['factory.devtools', 'factory.stats']);
    expect(fixture.entries?.map(({ id }) => id)).toEqual([
      'world',
      'sailing',
      'camera',
      'terrain',
      'deck',
      'inspection',
      'ocean',
      'graphics',
      'sound',
      'buoyancy',
    ]);
    expect(fixture.calls.some((call) => call.startsWith('import.'))).toBe(
      false,
    );
    expect(fixture.runtimeUi.graphicsTrims).toBeUndefined();
    expect(fixture.runtimeUi.worldExposureBias).toBe(1);

    const lab = createFixture({ labEnabled: true });
    expect(lab.calls).toEqual([]);
    expect(lab.entries).toBeUndefined();
    lab.runtimeUi.update(FRAME);
    lab.runtimeUi.openDeepLink('ocean');
    lab.runtimeUi.dispose();
    expect(lab.calls).toEqual([]);
  });

  it('builds the player HUD instead of the developer shell with ?player', () => {
    const fixture = createFixture({ debugUiEnabled: false });

    // No developer shell, and — the point of the page's own performance
    // page — no persistent developer stats chip either.
    expect(fixture.calls).toEqual(['factory.playerhud']);
    expect(fixture.entries).toBeUndefined();
    expect(fixture.hudEntries?.map(({ id }) => id)).toEqual([
      'world',
      'sailing',
      'ocean',
      'settings',
      'performance',
    ]);
    expect(fixture.calls.some((call) => call.startsWith('import.'))).toBe(false);
  });

  it('keeps the frame path alive with no stats chip to drive', () => {
    const fixture = createFixture({ debugUiEnabled: false });
    fixture.calls.length = 0;

    fixture.runtimeUi.update(FRAME);
    // The shell still gets its update; nothing tries to drive a chip that was
    // never created, and the reading is still refreshed for the perf page.
    expect(fixture.calls).toEqual(['dev.update:0.016']);
    expect(fixture.readings).toHaveLength(0);

    fixture.runtimeUi.dispose();
    expect(fixture.calls).toContain('dev.dispose');
  });

  it('offers no helm page on a vessel with no rig', () => {
    const fixture = createFixture({ debugUiEnabled: false });
    (fixture.options as { sailing?: unknown }).sailing = undefined;
    // Rebuilt from the same options: the raft has no crew to speak to, so the
    // page that speaks to one is absent rather than empty.
    new RuntimeUi(fixture.options);
    expect(fixture.hudEntries?.map(({ id }) => id)).toEqual([
      'world',
      'ocean',
      'settings',
      'performance',
    ]);
  });

  it('loads panels lazily and reads SimHandle only after its module resolves', async () => {
    const fixture = createFixture();
    fixture.calls.length = 0;

    await entry(fixture, 'world').load();
    expect(fixture.calls).toEqual(['import.world', 'create.world']);
    expect(fixture.runtimeUi.worldExposureBias).toBe(0.72);

    fixture.calls.length = 0;
    await entry(fixture, 'inspection').load();
    expect(fixture.calls).toEqual([
      'import.inspection',
      'create.inspection',
    ]);

    fixture.calls.length = 0;
    await entry(fixture, 'ocean').load();
    expect(fixture.calls).toEqual([
      'import.ocean',
      'sim.get',
      'create.ocean',
    ]);

    fixture.calls.length = 0;
    await entry(fixture, 'graphics').load();
    expect(fixture.calls).toEqual([
      'import.graphics',
      'sim.get',
      'create.graphics',
    ]);
    expect(fixture.runtimeUi.graphicsTrims).toBe(fixture.graphicsState);

    fixture.calls.length = 0;
    await entry(fixture, 'sailing').load();
    fixture.releaseToHelm?.();
    expect(fixture.calls).toEqual([
      'import.sailing',
      'create.sailing',
      'sailing.rudder:0',
      'motion.release',
    ]);
  });

  it('awaits the terrain mount before importing its panel', async () => {
    let resolveTerrain!: (value: unknown) => void;
    const terrainPromise = new Promise<unknown>((resolve) => {
      resolveTerrain = resolve;
    });
    const fixture = createFixture({ terrainPromise });
    fixture.calls.length = 0;

    const loading = entry(fixture, 'terrain').load();
    await Promise.resolve();
    expect(fixture.calls).toEqual(['terrain.await']);

    resolveTerrain(fixture.resolvedTerrain);
    await loading;
    expect(fixture.calls).toEqual([
      'terrain.await',
      'import.terrain',
      'create.terrain',
    ]);
  });

  it('does not import the terrain panel when the mount failed', async () => {
    const fixture = createFixture({
      terrainPromise: Promise.resolve(undefined),
    });
    fixture.calls.length = 0;

    await expect(entry(fixture, 'terrain').load()).rejects.toThrow(
      'Synthetic terrain failed to mount',
    );
    expect(fixture.calls).toEqual(['terrain.await']);
  });

  it('publishes one stable complete stats record before updating the active panel', () => {
    const fixture = createFixture();
    fixture.calls.length = 0;
    (fixture.devTools as { chromeShown: boolean }).chromeShown = false;

    const update = fixture.runtimeUi.update;
    update(FRAME);

    expect(fixture.calls).toEqual([
      'stats.visible:false',
      'stats.update:0.016',
      'dev.update:0.016',
    ]);
    expect(fixture.snapshots[0]).toMatchObject({
      profilingReady: true,
      fps: 60,
      frameMs: 1000 / 60,
      renderScale: 1.5,
      nativeScale: 2,
      bufferWidth: 1440,
      bufferHeight: 900,
      cpu: fixture.cpuReading,
      gpu: fixture.gpuReading,
      cloudViewSteps: 192,
      cloudSunSteps: 7,
      cloudAdvectionMappings: 2,
      cloudPageTableFetches: 2,
      cloudCacheFetches: 3,
      cloudVisibleTiles: 11,
      cloudSwapped: true,
      oceanAtmosphereEvaluations: 0,
      skyRadianceLutWidth: 256,
      skyRadianceLutHeight: 128,
      skyRadianceLutEnabled: true,
      oceanVertexSlots: 27,
      oceanResidualSlots: 28,
      oceanResidualActiveSlots: 9,
      oceanResidualLoopMode: 'rolled',
      oceanDetailRepresentation: 'cached-1024',
      oceanDetailTextureStyle: 'value-noise',
      oceanFoamEnabled: true,
    });

    fixture.cloudReading.visibleTiles = 31;
    fixture.oceanSource.skyRadianceLutEnabled = false;
    fixture.runtimeUi.update({
      ...FRAME,
      presentationDeltaSeconds: 0.02,
      cadence: {
        fps: 50,
        frameMs: 20,
        sampleCount: 50,
        sampledElapsedMs: 1000,
      },
    });
    expect(fixture.readings[1]).toBe(fixture.readings[0]);
    expect(fixture.snapshots[1]).toMatchObject({
      fps: 50,
      frameMs: 20,
      cloudVisibleTiles: 31,
      oceanAtmosphereEvaluations: 2,
      skyRadianceLutEnabled: false,
    });
  });

  it('opens established deep links and disposes shell before stats', () => {
    const fixture = createFixture();
    fixture.calls.length = 0;
    for (const mode of ['1', 'ocean', 'camera', 'inspect', 'graphics', 'terrain']) {
      fixture.runtimeUi.openDeepLink(mode);
    }
    fixture.runtimeUi.openDeepLink('unknown');
    fixture.runtimeUi.dispose();

    expect(fixture.calls).toEqual([
      'dev.open:world',
      'dev.open:ocean',
      'dev.open:camera',
      'dev.open:inspection',
      'dev.open:graphics',
      'dev.open:terrain',
      'dev.dispose',
      'stats.dispose',
    ]);
  });
});
