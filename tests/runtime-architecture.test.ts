import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RenderPipeline } from '../src/runtime/RenderPipeline';
import { resolveRuntimeOptions } from '../src/runtime/RuntimeOptions';
import { RuntimeFrameClock } from '../src/runtime/RuntimeFrameClock';
import { RuntimeLifecycle } from '../src/runtime/RuntimeLifecycle';
import { resolveRuntimeQuality } from '../src/runtime/RuntimeQuality';
import {
  SIMULATION_FRAME_PHASES,
  SimulationFrameTransaction,
  type SimulationFramePhases,
  type SimulationFrameStep,
} from '../src/runtime/SimulationFrameTransaction';

describe('runtime startup policy', () => {
  it('keeps physical quality on desktop when the pre-layout viewport is zero', () => {
    const options = resolveRuntimeOptions(new URLSearchParams(), {
      viewportWidth: 0,
      viewportHeight: 0,
      screenWidth: 2560,
      screenHeight: 1440,
      isTouch: false,
    });
    expect(options.isSmallScreen).toBe(false);
  });

  it('ships the rejected night observer off and keeps explicit lab overrides', () => {
    const host = { viewportWidth: 1280, viewportHeight: 720, isTouch: false };
    const strength = (query: string): number =>
      resolveRuntimeOptions(new URLSearchParams(query), host).scotopicStrength;
    expect(strength('')).toBe(0);
    expect(strength('scotopic=0')).toBe(0);
    expect(strength('scotopic=0.4')).toBe(0.4);
    expect(strength('scotopic=1')).toBe(1);
    expect(() => strength('scotopic=2')).toThrow(/scotopic/);
  });

  it('couples the sea to the weather by default, and takes the lab switch', () => {
    // Decision D5. The default is the play behaviour and has to be, or the
    // game goes back to being a scene-setting panel; `independent` is the
    // laboratory, and an unknown value is a typo that must not silently
    // become one of them.
    const at = (query: string) =>
      resolveRuntimeOptions(new URLSearchParams(query), {
        viewportWidth: 1280,
        viewportHeight: 720,
        isTouch: false,
      }).seaFollowsWeather;
    expect(at('')).toBe(true);
    expect(at('seaCoupling=follow')).toBe(true);
    expect(at('seaCoupling=independent')).toBe(false);
    expect(at('seaCoupling=off')).toBe(false);
    expect(() => at('seaCoupling=yes')).toThrow(/seaCoupling/);
  });

  it('bounds startup-only shader policy and rejects ambiguous depth modes', () => {
    expect(
      resolveRuntimeOptions(new URLSearchParams('cloudMarch=512&depth=reversed'), {
        viewportWidth: 1280,
        viewportHeight: 720,
        isTouch: false,
      }),
    ).toMatchObject({ cloudMarchOverride: 512, depthMode: 'reversed' });
    expect(
      resolveRuntimeOptions(new URLSearchParams('cloudMarch=513'), {
        viewportWidth: 1280,
        viewportHeight: 720,
        isTouch: false,
      }).cloudMarchOverride,
    ).toBeUndefined();
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('depth=reverse'), {
        viewportWidth: 1280,
        viewportHeight: 720,
        isTouch: false,
      }),
    ).toThrow(/unknown \?depth=reverse/);
  });

  it('mounts terrain by default with an explicit off switch', () => {
    const host = { viewportWidth: 1280, viewportHeight: 720, isTouch: false };
    expect(resolveRuntimeOptions(new URLSearchParams(), host)).toMatchObject({
      terrainMode: 'synthetic',
      syntheticTerrainEnabled: true,
    });
    expect(
      resolveRuntimeOptions(new URLSearchParams('terrain=global'), host),
    ).toMatchObject({ terrainMode: 'global', syntheticTerrainEnabled: true });
    expect(
      resolveRuntimeOptions(new URLSearchParams('terrain=synthetic'), host),
    ).toMatchObject({
      terrainMode: 'synthetic',
      syntheticTerrainEnabled: true,
    });
    expect(
      resolveRuntimeOptions(new URLSearchParams('terrain=off'), host),
    ).toMatchObject({ terrainMode: 'off', syntheticTerrainEnabled: false });
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('terrain=1'), host),
    ).toThrow(/unknown \?terrain=1/);
  });

  it('parses the voyage clock startup policy strictly', () => {
    const host = { viewportWidth: 1280, viewportHeight: 720, isTouch: false };
    expect(resolveRuntimeOptions(new URLSearchParams(), host)).toMatchObject({
      voyageMode: 'fixed',
      voyageFixedRate: undefined,
      voyageOmegaMaxDegPerS: undefined,
    });
    expect(
      resolveRuntimeOptions(new URLSearchParams('voyage=30'), host),
    ).toMatchObject({ voyageMode: 'fixed', voyageFixedRate: 30 });
    expect(
      resolveRuntimeOptions(
        new URLSearchParams('voyage=governed&voyageOmega=0.1'),
        host,
      ),
    ).toMatchObject({ voyageMode: 'governed', voyageOmegaMaxDegPerS: 0.1 });
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('voyage=fast'), host),
    ).toThrow(/unknown \?voyage=fast/);
    expect(() =>
      resolveRuntimeOptions(new URLSearchParams('voyageOmega=-2'), host),
    ).toThrow(/unknown \?voyageOmega=-2/);
  });

  it('owns constructor-critical interior and shadow URL policy', () => {
    const host = {
      viewportWidth: 1280,
      viewportHeight: 720,
      isTouch: false,
    };
    expect(resolveRuntimeOptions(new URLSearchParams(), host)).toMatchObject({
      interiorCutoutMode: 'shader',
      interiorCabinViewEnabled: false,
      initialDirectShadowing: true,
    });
    expect(
      resolveRuntimeOptions(
        new URLSearchParams(
          'interiorCutout=stencil&interiorView=cabin&directOcclusion=0',
        ),
        host,
      ),
    ).toMatchObject({
      interiorCutoutMode: 'stencil',
      interiorCabinViewEnabled: true,
      initialDirectShadowing: false,
    });
    expect(
      resolveRuntimeOptions(
        new URLSearchParams(
          'interiorCutout=unknown&interiorView=deck&directOcclusion=false',
        ),
        host,
      ),
    ).toMatchObject({
      interiorCutoutMode: 'shader',
      interiorCabinViewEnabled: false,
      initialDirectShadowing: true,
    });
  });
});

describe('runtime clock policy', () => {
  it('preserves full wall time while bounding interactive presentation time', () => {
    const clock = new RuntimeFrameClock(1_000);
    const first = clock.sample(1_200);
    expect(first).toEqual({
      rawRealSeconds: 0.2,
      rawRealMilliseconds: 200,
      presentationSeconds: 0.05,
    });
    const second = clock.sample(1_216);
    expect(second).toBe(first);
    expect(second.presentationSeconds).toBeCloseTo(0.016);
    expect(second.rawRealSeconds).toBeCloseTo(0.016);
  });

  it('does not run time backwards after a non-monotonic host sample', () => {
    const clock = new RuntimeFrameClock(500);
    expect(clock.sample(450).rawRealSeconds).toBe(0);
  });
});

describe('runtime quality policy', () => {
  it('coordinates presentation budgets without changing the physical sea', () => {
    const desktop = resolveRuntimeQuality(false);
    const mobile = resolveRuntimeQuality(true);

    expect(desktop).toMatchObject({
      tier: 'desktop',
      maximumPixelRatio: 2,
      cloudCache: { atlasWidth: 6144, atlasHeight: 1280, slotCapacity: 120 },
    });
    expect(mobile).toMatchObject({
      tier: 'mobile',
      maximumPixelRatio: 1.75,
      cloudCache: { atlasWidth: 4096, atlasHeight: 768, slotCapacity: 64 },
    });
    expect(mobile.ocean.rings).toBeLessThan(desktop.ocean.rings);
    expect(mobile.foam.nearResolution).toBeLessThan(
      desktop.foam.nearResolution,
    );
    expect(mobile.crestSpray.capacity).toBeLessThan(
      desktop.crestSpray.capacity,
    );
    // The profile has no authority over CPU/GPU wave slots.
    expect('waveComponentSlots' in desktop).toBe(false);
  });

  it('applies a measurement override without mutating shared presets', () => {
    const baseline = resolveRuntimeQuality(false);
    const overridden = resolveRuntimeQuality(false, 96);
    expect(overridden.ocean.cloudMarch).toBe(96);
    expect(baseline.ocean.cloudMarch).not.toBe(96);
    expect(resolveRuntimeQuality(false).ocean.cloudMarch).toBe(
      baseline.ocean.cloudMarch,
    );
  });
});

describe('runtime lifecycle', () => {
  it('detaches EventTarget listeners before resources and disposes once', () => {
    const lifecycle = new RuntimeLifecycle();
    const events = new EventTarget();
    const calls: string[] = [];
    const listener = (): void => {
      calls.push('event');
    };

    lifecycle.listen(events, 'frame', listener);
    lifecycle.add(() => {
      calls.push('resource');
      // A resource teardown can synchronously provoke an event. The
      // listener must already be gone even though it was registered first.
      events.dispatchEvent(new Event('frame'));
    });
    events.dispatchEvent(new Event('frame'));
    lifecycle.dispose();
    lifecycle.dispose();
    events.dispatchEvent(new Event('frame'));

    expect(calls).toEqual(['event', 'resource']);
  });

  it('immediately cleans up registrations made after shutdown', () => {
    const lifecycle = new RuntimeLifecycle();
    const cleanup = vi.fn();
    lifecycle.dispose();
    lifecycle.add(cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('simulation frame transaction', () => {
  it('publishes every phase in the declared order through one stable step record', () => {
    const expectedOrder = [
      'advanceWorld',
      'integrateVessel',
      'deriveEnvironment',
      'presentVesselAndCamera',
      'updateSurfaceEffects',
      'prepareOcean',
      'prepareScene',
    ];
    const calls: string[] = [];
    const records: SimulationFrameStep[] = [];
    const phases = Object.fromEntries(
      SIMULATION_FRAME_PHASES.map((phase) => [
        phase,
        (step: SimulationFrameStep) => {
          calls.push(phase);
          records.push(step);
        },
      ]),
    ) as unknown as SimulationFramePhases;
    const transaction = new SimulationFrameTransaction(phases);

    transaction.step(1 / 60, 0.25);

    expect(SIMULATION_FRAME_PHASES).toEqual(expectedOrder);
    expect(calls).toEqual(expectedOrder);
    expect(new Set(records).size).toBe(1);
    expect(records[0]).toEqual({
      presentationDeltaSeconds: 1 / 60,
      rawRealDeltaSeconds: 0.25,
    });
  });

  it('uses the presentation delta as the deterministic stepping default', () => {
    let observed: SimulationFrameStep | undefined;
    const noOp = (): void => undefined;
    const transaction = new SimulationFrameTransaction({
      advanceWorld: (step) => {
        observed = { ...step };
      },
      integrateVessel: noOp,
      deriveEnvironment: noOp,
      presentVesselAndCamera: noOp,
      updateSurfaceEffects: noOp,
      prepareOcean: noOp,
      prepareScene: noOp,
    });
    transaction.step(0.125);
    expect(observed).toEqual({
      presentationDeltaSeconds: 0.125,
      rawRealDeltaSeconds: 0.125,
    });
  });

  it('keeps environment work inside the production phase owner', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const environment = readFileSync(
      'src/runtime/EnvironmentRuntime.ts',
      'utf8',
    );
    const production = readFileSync(
      'src/runtime/ProductionSimulationRuntime.ts',
      'utf8',
    );
    const deriveStart = production.indexOf(
      'private readonly deriveEnvironmentPhase =',
    );
    const deriveEnd = production.indexOf(
      'private readonly presentVesselAndCameraPhase =',
      deriveStart,
    );
    const derivePhase = production.slice(deriveStart, deriveEnd);
    const sceneStart = production.indexOf(
      'private readonly prepareScenePhase =',
    );
    const sceneEnd = production.indexOf(
      '/** Hermite smoothstep',
      sceneStart,
    );
    const scenePhase = production.slice(sceneStart, sceneEnd);

    expect(main).not.toContain('function derivePresentationLighting(');
    expect(main).not.toContain('function worldRadianceInputs(');
    expect(main).not.toContain('deriveEnvironmentPhase');
    expect(main).not.toContain('prepareScenePhase');
    expect(derivePhase).toMatch(
      /beginPass\('worldAndLighting'\)[\s\S]*environment\.deriveEnvironment[\s\S]*step\.presentationDeltaSeconds[\s\S]*endPass\('worldAndLighting'\)/,
    );
    expect(scenePhase).toMatch(
      /beginPass\('skyAndScene'\)[\s\S]*environment\.prepareScene\(presentationElapsedSeconds\)[\s\S]*vessel\.updateTrimPickTargets\(\)[\s\S]*ambience\.update[\s\S]*vessel\.refreshRigLoft\(\)[\s\S]*endPass\('skyAndScene'\)/,
    );
    expect(environment.indexOf('sky.update(')).toBeLessThan(
      environment.indexOf('worldLighting.update('),
    );
    expect(environment).not.toContain("from '../main'");
    expect(environment).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(production).not.toContain("from '../main'");
    expect(production).not.toMatch(/^import .*['"].*\/debug\//m);
    expect(production).not.toContain('BrowserFrameDriver');
    expect(production).not.toContain('/diagnostics/');
  });

  it('owns all seven phase bodies and shares one public step callback', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const vesselRuntime = readFileSync(
      'src/runtime/VesselRuntime.ts',
      'utf8',
    );
    const production = readFileSync(
      'src/runtime/ProductionSimulationRuntime.ts',
      'utf8',
    );
    const worldStart = production.indexOf(
      'private readonly advanceWorldPhase =',
    );
    const worldEnd = production.indexOf(
      'private readonly integrateVesselPhase =',
      worldStart,
    );
    const worldPhase = production.slice(worldStart, worldEnd);
    const integrateStart = worldEnd;
    const integrateEnd = production.indexOf(
      'private readonly deriveEnvironmentPhase =',
      integrateStart,
    );
    const integratePhase = production.slice(integrateStart, integrateEnd);
    const presentStart = production.indexOf(
      'private readonly presentVesselAndCameraPhase =',
      integrateEnd,
    );
    const presentEnd = production.indexOf(
      'private readonly updateSurfaceEffectsPhase =',
      presentStart,
    );
    const presentPhase = production.slice(presentStart, presentEnd);
    const oceanStart = production.indexOf(
      'private readonly prepareOceanPhase =',
    );
    const oceanEnd = production.indexOf(
      'private readonly prepareScenePhase =',
      oceanStart,
    );
    const oceanPhase = production.slice(oceanStart, oceanEnd);

    expect(main).not.toContain('function prepareProductionHorizontalMotion(');
    expect(main).not.toContain('function frameHeadingOffsetDeg(');
    expect(main).not.toContain('function computeApparentWindRender(');
    expect(main).not.toContain('function stepDeckWalker(');
    expect(main).not.toContain('function buildWindTelemetry(');
    expect(main).not.toContain('function buildSailingPanelState(');
    expect(main).not.toContain('advanceWorldPhase');
    expect(main).not.toContain('integrateVesselPhase');
    expect(main).not.toContain('updateSurfaceEffectsPhase');
    expect(main).not.toContain('prepareOceanPhase');
    expect(main).toContain(
      'const productionSimulation: ProductionSimulationRuntime =',
    );
    expect(
      main.match(/stepSimulation: productionSimulation\.step/g)?.length,
    ).toBe(2);
    expect(production).toContain('new SimulationFrameTransaction({');
    expect(production).toContain('readonly step = (');
    expect(production).not.toContain('terrainRenderHook');
    // The terrain hook and the voyage clock still lead, in that order. The
    // observer's dark adaptation joined them when the scotopic present pass
    // landed: it has to be advanced before EITHER render path runs, because the
    // temporal resolve asks the pass whether it owns the display transform.
    // Simulation is still absent from this body, which is what the pin is for.
    const prepareFrameBody = main.slice(
      main.indexOf('prepareFrame: () => {'),
      main.indexOf('shouldUseTemporalResolve:'),
    );
    expect(prepareFrameBody).toMatch(
      /terrainRenderHook\?\.\(\);\s*voyageClockHook\(\);[\s\S]*scenePresent\.update\(/,
    );
    expect(prepareFrameBody).not.toContain('productionSimulation');
    expect(worldPhase).toMatch(
      /beginPass\('worldAndLighting'\)[\s\S]*vessel\.advanceWorldMotion\(presentationDeltaSeconds\)[\s\S]*seaStates\.advance[\s\S]*vessel\.updateFrameNavigationAndWind[\s\S]*endPass\('worldAndLighting'\)/,
    );
    // WX2's causation, pinned because it is one-way and the whole round is
    // about which end of it is upstream: the weather says what the wind is, the
    // wind-sea memory says what sea that wind has built by now, and only then is
    // the sea resolved and the world wind published. Reordering any pair puts a
    // frame of lag into the chain or, worse, re-opens the feedback loop WX2 cut
    // when it stopped feeding the sea's own wind back into weather every frame.
    expect(worldPhase).toMatch(
      /weather\.advance\(\)[\s\S]*windSea\.update\([\s\S]*seaStates\.advance[\s\S]*vessel\.updateFrameNavigationAndWind/,
    );
    expect(worldPhase).not.toContain('setBaseWind');
    expect(integratePhase).toMatch(
      /beginPass\('vesselAndCamera'\)[\s\S]*vessel\.integrate[\s\S]*endPass\('vesselAndCamera'\)/,
    );
    expect(presentPhase).toMatch(
      /beginPass\('vesselAndCamera'\)[\s\S]*vessel\.present[\s\S]*endPass\('vesselAndCamera'\)/,
    );
    expect(oceanPhase).toMatch(
      /ocean\.update[\s\S]*vessel\.prepareOceanMasks\(\)[\s\S]*ocean\.setCloudOcclusion/,
    );
    expect(main).toContain(
      'navigationTelemetry: vesselRuntime.navigationTelemetry',
    );
    expect(main).toContain(
      'vesselLighting: vesselRuntime.presentationContext',
    );
    expect(vesselRuntime).not.toContain("from '../main'");
    expect(vesselRuntime).not.toMatch(/^import .*['"].*\/debug\//m);
  });

  it('shares weather visibility with terrain and owns async terrain teardown', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toMatch(
      /setVisibilityM:\s*\(visibilityM\)\s*=>\s*\{[\s\S]*?ocean\.setHazeDistanceM\(visibilityM\);[\s\S]*?terrainHazeHook\?\.\(visibilityM\);/,
    );
    expect(main).toContain(
      'handle.system.setHazeDistance(weather.state.visibilityM)',
    );
    expect(main).toContain('if (terrainMountDisposed) return;');
    expect(main).toContain('if (terrainMountDisposed) return undefined;');
    expect(main).toContain(
      'terrainNearestLandM = () => handle.getNearestLandM();',
    );
    expect(main).toMatch(
      /terrainRenderHook\?\.\(\);\s*voyageClockHook\(\);/,
    );
    expect(main).toContain(
      'anchor.waterlineY + activeVessel.body.freeboard',
    );
    expect(main).toContain('vesselHalfBeamM: () => activeVessel.halfBeamM');
    expect(main).toContain('terrainDisposeHook?.();');
  });

  it('resolves only explicit-global opening coordinates before world construction', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const runtimeUi = readFileSync('src/runtime/RuntimeUi.ts', 'utf8');
    const playerWorld = readFileSync('src/hud/panels/WorldPanel.ts', 'utf8');
    const developerWorld = readFileSync('src/ui/DebugPanel.ts', 'utf8');
    expect(main).toMatch(
      /runtimeOptions\.terrainMode === 'global'[\s\S]*await import\('\.\/terrain\/globalTerrainOpeningRuntime'\)/,
    );
    expect(main).toMatch(
      /const globalOpeningResolution[\s\S]*const world = new PlanetaryWorld/,
    );
    expect(main).toContain('latitudeRad: openingLatitudeRad');
    expect(main).toContain('longitudeRad: openingLongitudeRad');
    expect(main).toContain(
      'globalOpeningResolution?.resolved.latitudeRad ?? INITIAL_LATITUDE_RAD',
    );
    expect(main).not.toMatch(
      /^import .*['"]\.\/terrain\/GlobalTerrainSource['"];?$/m,
    );
    expect(main).toContain('openingResolution: globalOpeningResolution');
    expect(runtimeUi).toContain(
      'openingResolution: options.world.openingResolution',
    );
    expect(playerWorld).toContain(
      'formatWaterAwareOpeningDiagnostic(sources.openingResolution)',
    );
    expect(developerWorld).toContain(
      'formatWaterAwareOpeningDiagnostic(this.openingResolution)',
    );
    expect(playerWorld).toMatch(
      /if \(sources\.openingResolution\)[\s\S]*resolveGlobalTerrainTeleport/,
    );
    expect(developerWorld).toMatch(
      /if \(this\.openingResolution\)[\s\S]*resolveGlobalTerrainTeleport/,
    );
    expect(playerWorld).toContain('if (!decision.target)');
    expect(developerWorld).toContain('if (!decision.target)');
    expect(playerWorld).toMatch(
      /onClick: \(\) => \{\s*globe\.setSelectionNotice\(null\);/,
    );
  });
});

describe('runtime UI ownership', () => {
  it('keeps panel loading, frame publication, and URL dispatch out of main', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    const runtimeUi = readFileSync('src/runtime/RuntimeUi.ts', 'utf8');

    expect(main).toContain(
      'const runtimeUi: RuntimeUi = new RuntimeUi({',
    );
    expect(main).not.toContain('new DevTools(');
    expect(main).not.toContain('new RenderStats(');
    expect(main).not.toContain("import('./ui/DebugPanel')");
    expect(main).not.toContain("import('./debug/GraphicsPanel')");
    expect(main).not.toContain('params.get(');
    expect(main).toContain('graphicsTrims: () => runtimeUi.graphicsTrims,');
    expect(main).toContain(
      'worldExposureBias: () => runtimeUi.worldExposureBias,',
    );
    // `afterFrame` is a closure now rather than a bare reference, because the
    // reach prompt has to be refreshed on the same beat as the panels — it
    // tracks what the player is looking at, so a slower cadence would name an
    // object they have already walked away from. What this guard protects is
    // unchanged and is the thing that matters: the frame's UI work is
    // *delegated*, and `main` does not grow a panel of its own.
    expect(main).toMatch(/afterFrame: \(reading\) => \{[\s\S]{0,400}?runtimeUi\.update\(reading\);/);
    expect(main).not.toContain('new ActionBar(document.body, isTouch).update');
    expect(main).toContain('runtimeUi.openDeepLink(debugMode);');
    expect(main).toMatch(
      /hint\.hide\(\);[\s\S]*input\.dispose\(\);[\s\S]*runtimeUi\.dispose\(\);[\s\S]*gpuProfiler\.dispose\(\);/,
    );
    expect(main.indexOf('renderer.setAnimationLoop(browserFrameDriver.frame)'))
      .toBeLessThan(main.indexOf('runtimeUi.openDeepLink(debugMode);'));

    expect(runtimeUi).toContain('new DevTools(entries)');
    expect(runtimeUi).toContain('new RenderStats()');
    expect(runtimeUi.indexOf('factories.createDevTools(')).toBeLessThan(
      runtimeUi.indexOf('factories.createRenderStats()'),
    );
    expect(runtimeUi).toContain("world: () => import('../ui/DebugPanel')");
    expect(runtimeUi).toContain(
      "graphics: () => import('../debug/GraphicsPanel')",
    );
    expect(runtimeUi).not.toContain("from '../main'");
  });
});

describe('render pipeline', () => {
  function operations(temporal: boolean) {
    const calls: string[] = [];
    return {
      calls,
      operations: {
        beginSubmission: vi.fn(() => calls.push('begin')),
        prepareFrame: vi.fn(() => calls.push('prepare')),
        shouldUseTemporalResolve: vi.fn(() => temporal),
        renderTemporal: vi.fn(() => calls.push('temporal')),
        prepareDirectRender: vi.fn(() => calls.push('direct-state')),
        renderDirect: vi.fn(() => calls.push('direct')),
        endSubmission: vi.fn(() => calls.push('end')),
      },
    };
  }

  it('renders the temporal path without touching direct-render state', () => {
    const fixture = operations(true);
    new RenderPipeline(fixture.operations).render();
    expect(fixture.calls).toEqual(['begin', 'prepare', 'temporal', 'end']);
    expect(fixture.operations.prepareDirectRender).not.toHaveBeenCalled();
  });

  it('restores direct state before a non-temporal render', () => {
    const fixture = operations(false);
    new RenderPipeline(fixture.operations).render();
    expect(fixture.calls).toEqual([
      'begin',
      'prepare',
      'direct-state',
      'direct',
      'end',
    ]);
  });

  it('closes submission profiling when a render operation throws', () => {
    const fixture = operations(false);
    fixture.operations.renderDirect.mockImplementation(() => {
      throw new Error('context lost');
    });
    expect(() => new RenderPipeline(fixture.operations).render()).toThrow(
      'context lost',
    );
    expect(fixture.operations.endSubmission).toHaveBeenCalledOnce();
  });

  it('preserves preparation failure semantics ahead of the render guard', () => {
    const fixture = operations(false);
    fixture.operations.prepareFrame.mockImplementation(() => {
      throw new Error('terrain update failed');
    });
    expect(() => new RenderPipeline(fixture.operations).render()).toThrow(
      'terrain update failed',
    );
    expect(fixture.operations.endSubmission).not.toHaveBeenCalled();
  });
});
