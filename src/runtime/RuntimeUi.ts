import type * as THREE from 'three';

import type { AstronomyProvider } from '../astronomy/AstronomyProvider';
import type { Ambience } from '../audio/Ambience';
import type { CameraSystem } from '../camera/CameraSystem';
import type { DeckWalker } from '../player/DeckWalker';
import type { CpuProfilerReading } from '../render/CpuProfiler';
import type { GpuProfilerReading } from '../render/GpuProfiler';
import type { CloudDomeReading } from '../scene/CloudDome';
import type {
  OceanProfileSettings,
  OceanQuality,
} from '../scene/Ocean';
import type { WaveField } from '../scene/Waves';
import type { SailingControls } from '../vessel/schooner/SailingControls';
import type { SailingCrew } from '../vessel/schooner/crew/SailingCrew';
import type { VesselMotionDebugControls } from '../vessel/VesselMotion';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import { DevTools, type DevPanelEntry } from '../ui/DevTools';
import {
  PlayerHud,
  type HudPanelEntry,
  type HudViewSwitcher,
} from '../hud/PlayerHud';
import {
  createPlayerHudEntries,
  type PlayerHudSources,
} from '../hud/playerPanels';
import type {
  DebugPanel,
  WorldPanelTelemetry,
} from '../ui/DebugPanel';
import { RenderStats, type RenderStatsReading } from '../ui/RenderStats';
import type { GraphicsPanel, GraphicsState } from '../debug/GraphicsPanel';
import type { SailingPanelState } from '../debug/SailingPanel';
import type { SyntheticTerrainHandle } from '../terrain/syntheticTerrainHarness';
import type { WaterAwareOpeningSuccess } from '../terrain/WaterAwareOpeningResolver';
import type { SimHandle } from './diagnostics/SimHandle';
import type { InspectionRayRecorder } from './diagnostics/InspectionRayRecorder';
import type { BrowserFrameDriverReading } from './BrowserFrameDriver';

export type RuntimeUiWorldTelemetry = WorldPanelTelemetry;

export interface RuntimeUiWorldOptions {
  world: PlanetaryWorld;
  astronomy: AstronomyProvider;
  waves: WaveField;
  motionControls: VesselMotionDebugControls;
  /** Immutable explicit-global bootstrap decision, absent in synthetic/off. */
  openingResolution?: Readonly<WaterAwareOpeningSuccess>;
  telemetry(): RuntimeUiWorldTelemetry;
  requestCloudCacheRebase(): void;
}

export interface RuntimeUiSailingOptions {
  controls: SailingControls;
  crew?: SailingCrew;
  read(): SailingPanelState;
}

export interface RuntimeUiTerrainOptions {
  /** Read at panel-open time; the mount starts later in the composition root. */
  handlePromise():
    | Promise<SyntheticTerrainHandle | undefined>
    | undefined;
}

export interface RuntimeUiDeckOptions {
  walker: DeckWalker;
  shipGroup: THREE.Group;
}

export interface RuntimeUiStatsSources {
  renderer: { getPixelRatio(): number };
  canvas: { readonly width: number; readonly height: number };
  nativePixelRatio(): number;
  cpuProfiler: { readonly reading: CpuProfilerReading };
  gpuProfiler: { readonly reading: GpuProfilerReading };
  quality: Pick<OceanQuality, 'cloudMarch' | 'cloudSunSteps'>;
  cloudDome: { readonly reading: CloudDomeReading };
  radianceLut: { readonly width: number; readonly height: number };
  ocean: {
    readonly skyRadianceLutEnabled: boolean;
    readonly profileSettings: Readonly<OceanProfileSettings>;
  };
  waves: { readonly residualActiveCount: number };
}

/**
 * The interface shell, whichever one this session got.
 *
 * The developer tools and the player HUD are two different interfaces over one
 * simulation, and the frame path does not care which is up: both own a
 * bottom-left launcher, both answer `\` by putting every scrap of chrome away,
 * and both take one update per rendered frame.
 */
export interface RuntimeUiDevTools {
  readonly chromeShown: boolean;
  open(id: string): Promise<void>;
  update(dtSeconds: number): void;
  dispose(): void;
}

export type RuntimeUiShell = RuntimeUiDevTools;

export interface RuntimeUiRenderStats {
  setVisible(visible: boolean): void;
  update(dtSeconds: number, reading: RenderStatsReading): void;
  dispose(): void;
}

export interface RuntimeUiFactories {
  createDevTools(entries: DevPanelEntry[]): RuntimeUiDevTools;
  createRenderStats(): RuntimeUiRenderStats;
  createPlayerHud(
    entries: HudPanelEntry[],
    view: HudViewSwitcher,
  ): RuntimeUiShell;
}

type WorldPanelModule = Pick<
  typeof import('../ui/DebugPanel'),
  'createWorldPanel'
>;
type SailingPanelModule = Pick<
  typeof import('../debug/SailingPanel'),
  'createSailingPanel'
>;
type CameraPanelModule = Pick<
  typeof import('../ui/CameraPanel'),
  'createCameraPanel'
>;
type TerrainPanelModule = Pick<
  typeof import('../debug/TerrainPanel'),
  'createTerrainPanel'
>;
type VoyagePanelModule = Pick<
  typeof import('../debug/VoyagePanel'),
  'createVoyagePanel'
>;
type WeatherPanelModule = Pick<
  typeof import('../debug/WeatherPanel'),
  'createWeatherPanel'
>;
type DeckPanelModule = Pick<
  typeof import('../debug/DeckPanel'),
  'createDeckPanel'
>;
type OceanPanelModule = Pick<
  typeof import('../debug/OceanLab'),
  'createOceanLab'
>;
type GraphicsPanelModule = Pick<
  typeof import('../debug/GraphicsPanel'),
  'createGraphicsPanel'
>;
type InspectionPanelModule = Pick<
  typeof import('../debug/InspectionPanel'),
  'createInspectionPanel'
>;
type SoundPanelModule = Pick<
  typeof import('../debug/SoundPanel'),
  'createSoundPanel'
>;

export interface RuntimeUiPanelLoaders {
  world(): Promise<WorldPanelModule>;
  sailing(): Promise<SailingPanelModule>;
  camera(): Promise<CameraPanelModule>;
  terrain(): Promise<TerrainPanelModule>;
  voyage(): Promise<VoyagePanelModule>;
  weather(): Promise<WeatherPanelModule>;
  deck(): Promise<DeckPanelModule>;
  inspection(): Promise<InspectionPanelModule>;
  ocean(): Promise<OceanPanelModule>;
  graphics(): Promise<GraphicsPanelModule>;
  sound(): Promise<SoundPanelModule>;
}

export interface RuntimeUiOptions {
  labEnabled: boolean;
  /**
   * Which interface this session gets: the developer tools (`?debug`) or the
   * player HUD. One simulation, two shells; see `RuntimeUiShell`.
   */
  debugUiEnabled: boolean;
  world: RuntimeUiWorldOptions;
  sailing?: RuntimeUiSailingOptions;
  cameras: CameraSystem;
  /** The live sound system, for the sound panel's trims and readout. */
  ambience: Ambience;
  terrain?: RuntimeUiTerrainOptions;
  voyage?: { control: import('../world/voyageClock').VoyageClockControl };
  weather?: {
    system: import('../weather/WeatherSystem').WeatherSystem;
    seaWind(): { speedMps: number; directionDeg: number; gustiness: number };
    presentation?: import('../weather/WeatherPresentation').WeatherPresentation;
    /**
     * WX2's sea coupling — decision D5's switch. Offered to both the Weather
     * panel and the ocean laboratory, because "does the sea follow the wind?"
     * is a question you ask from either side and there must be one answer.
     */
    coupling?: import('../ocean/WindSeaMemory').SeaCouplingControl;
  };
  deck?: RuntimeUiDeckOptions;
  inspection?: InspectionRayRecorder;
  getSimHandle(): SimHandle;
  stats: RuntimeUiStatsSources;
  factories?: RuntimeUiFactories;
  panelLoaders?: RuntimeUiPanelLoaders;
}

const DEFAULT_FACTORIES: RuntimeUiFactories = {
  createDevTools: (entries) => new DevTools(entries),
  createRenderStats: () => new RenderStats(),
  createPlayerHud: (entries, view) => new PlayerHud(entries, view),
};

const DEFAULT_PANEL_LOADERS: RuntimeUiPanelLoaders = {
  world: () => import('../ui/DebugPanel'),
  sailing: () => import('../debug/SailingPanel'),
  camera: () => import('../ui/CameraPanel'),
  terrain: () => import('../debug/TerrainPanel'),
  voyage: () => import('../debug/VoyagePanel'),
  weather: () => import('../debug/WeatherPanel'),
  deck: () => import('../debug/DeckPanel'),
  inspection: () => import('../debug/InspectionPanel'),
  ocean: () => import('../debug/OceanLab'),
  graphics: () => import('../debug/GraphicsPanel'),
  sound: () => import('../debug/SoundPanel'),
};

const DEEP_LINK_PANEL: Readonly<Record<string, string>> = {
  '1': 'world',
  ocean: 'ocean',
  camera: 'camera',
  inspect: 'inspection',
  graphics: 'graphics',
  terrain: 'terrain',
  voyage: 'voyage',
  sound: 'sound',
};

/**
 * Owns the optional production UI shell and every lazy panel entry.
 *
 * Concrete simulation/render resources remain outside this class. Panel code
 * is still imported only after selection, SimHandle is read only after the
 * relevant module has loaded, and the normal frame path mutates one retained
 * RenderStats record rather than allocating a new aggregate each callback.
 */
export class RuntimeUi {
  /** The interface shell this session got: developer tools, or the player HUD. */
  private readonly shell: RuntimeUiShell | undefined;
  private readonly renderStats: RuntimeUiRenderStats | undefined;
  private readonly statsReading: RenderStatsReading | undefined;
  private worldPanel: DebugPanel | undefined;
  private graphicsPanel: GraphicsPanel | undefined;

  constructor(private readonly options: RuntimeUiOptions) {
    if (options.labEnabled) {
      this.shell = undefined;
      this.renderStats = undefined;
      this.statsReading = undefined;
      return;
    }

    const factories = options.factories ?? DEFAULT_FACTORIES;
    // Keep the established synchronous creation order: shell, then stats.
    // The player HUD carries its own performance page, so the persistent
    // developer chip is not built at all in that session — one reading, read
    // by whichever of them is on screen.
    this.shell = options.debugUiEnabled
      ? factories.createDevTools(this.createPanelEntries())
      : factories.createPlayerHud(
          createPlayerHudEntries(this.createPlayerHudSources()),
          {
            modeName: () => options.cameras.modeName,
            setMode: (mode) => options.cameras.setMode(mode),
          },
        );
    this.renderStats = options.debugUiEnabled
      ? factories.createRenderStats()
      : undefined;
    this.statsReading = createStatsReading(options.stats);
  }

  /** Live graphics trims persist after the panel is hidden. */
  get graphicsTrims(): GraphicsState | undefined {
    return this.graphicsPanel?.state;
  }

  /** The unopened world panel has the established neutral exposure bias. */
  get worldExposureBias(): number {
    return this.worldPanel?.state.exposureBias ?? 1;
  }

  /** Stable, allocation-free browser-frame UI tail. */
  readonly update = (frame: Readonly<BrowserFrameDriverReading>): void => {
    const { shell, renderStats, statsReading } = this;
    if (!shell || !statsReading) return;

    // A clean-view toggle hides the persistent performance chip as well.
    renderStats?.setVisible(shell.chromeShown);
    refreshStatsReading(statsReading, frame, this.options.stats);
    renderStats?.update(frame.presentationDeltaSeconds, statsReading);
    shell.update(frame.presentationDeltaSeconds);
  };

  /** Open the same shared-shell panel selected by the existing URL aliases. */
  openDeepLink(debugMode: string | null | undefined): void {
    if (debugMode === null || debugMode === undefined) return;
    const panel = DEEP_LINK_PANEL[debugMode];
    if (panel) void this.shell?.open(panel);
  }

  /** Preserve the existing shell-before-stats teardown order. */
  dispose(): void {
    this.shell?.dispose();
    this.renderStats?.dispose();
  }

  /**
   * What the player interface is allowed to reach, and nothing more.
   *
   * Note what is *not* here: the tow harness, the manual heading override, the
   * exposure bias, every graphics trim, the wave amplitude, the buoyancy
   * harness. Those are not hidden behind a collapsed section — they are absent
   * from the page's sources, so no player page can grow one by accident.
   *
   * `getSimHandle` is called lazily, inside the closures, because the facade
   * is bound after this object is constructed.
   */
  private createPlayerHudSources(): PlayerHudSources {
    const { options } = this;
    return {
      sailing: options.sailing
        ? {
            controls: options.sailing.controls,
            crew: options.sailing.crew,
            read: options.sailing.read,
          }
        : undefined,
      ocean: {
        state: () => options.getSimHandle().seaStates.state,
        apply: (next) => {
          const sim = options.getSimHandle();
          sim.setSeaState(next, 0);
          sim.warmFoam();
        },
      },
      world: {
        world: options.world.world,
        astronomy: options.world.astronomy,
        openingResolution: options.world.openingResolution,
        onTimeCommitted: options.world.requestCloudCacheRebase,
      },
      cameras: options.cameras,
      performance: {
        reading: () => {
          if (!this.statsReading) {
            throw new Error('performance page opened without a stats reading');
          }
          return this.statsReading;
        },
        nativePixelRatio: options.stats.nativePixelRatio,
      },
    };
  }

  private createPanelEntries(): DevPanelEntry[] {
    const { options } = this;
    const loaders = options.panelLoaders ?? DEFAULT_PANEL_LOADERS;
    const entries: DevPanelEntry[] = [
      {
        id: 'world',
        label: 'World & lighting',
        hint: 'Ship speed, course, sky clock, exposure, globe',
        load: async () => {
          const { createWorldPanel } = await loaders.world();
          this.worldPanel = createWorldPanel(
            options.world.world,
            options.world.astronomy,
            options.world.waves,
            options.world.motionControls,
            options.world.telemetry,
            options.world.requestCloudCacheRebase,
            options.world.openingResolution,
          );
          return this.worldPanel;
        },
      },
    ];

    if (options.sailing) {
      entries.push({
        id: 'sailing',
        label: 'Sailing',
        hint: 'Tiller, rudder physics, tack and helm state',
        load: async () => {
          const { createSailingPanel } = await loaders.sailing();
          return createSailingPanel(
            options.sailing!.controls,
            options.sailing!.read,
            () => {
              options.sailing!.controls.commandRudderDeg(0);
              options.world.motionControls.releaseTow();
            },
            options.sailing!.crew,
          );
        },
      });
    }

    entries.push({
      id: 'camera',
      label: 'Camera',
      hint: 'Mode, scale, framing, head stabilisation',
      load: async () => {
        const { createCameraPanel } = await loaders.camera();
        return createCameraPanel(options.cameras);
      },
    });

    if (options.terrain) {
      entries.push({
        id: 'terrain',
        label: 'Terrain',
        hint: 'Live land distance and terrain-only haze',
        load: async () => {
          // The mount owns resource construction and may still be in flight.
          // Do not load the panel module until that exact promise settles.
          const handle = await options.terrain!.handlePromise();
          if (!handle) {
            throw new Error('Synthetic terrain failed to mount');
          }
          const { createTerrainPanel } = await loaders.terrain();
          return createTerrainPanel(handle);
        },
      });
    }

    if (options.voyage) {
      entries.push({
        id: 'voyage',
        label: 'Voyage clock',
        hint: 'Voyage-time compression: fixed rate or governed by nearest land',
        load: async () => {
          const { createVoyagePanel } = await loaders.voyage();
          return createVoyagePanel(options.voyage!.control);
        },
      });
    }

    if (options.weather) {
      entries.push({
        id: 'weather',
        label: 'Weather',
        hint: "Presets, glass, physical cat's-paws, rain, lightning and WorldWind cue",
        load: async () => {
          const { createWeatherPanel } = await loaders.weather();
          return createWeatherPanel(
            options.weather!.system,
            options.weather!.seaWind,
            options.weather!.coupling,
            options.weather!.presentation,
          );
        },
      });
    }

    if (options.deck) {
      entries.push({
        id: 'deck',
        label: 'Deck & walking',
        hint: 'Body, walk, step, heel slip, collision volumes',
        load: async () => {
          const { createDeckPanel } = await loaders.deck();
          return createDeckPanel(
            options.deck!.walker,
            options.cameras,
            options.deck!.shipGroup,
          );
        },
      });
    }

    if (options.inspection) {
      entries.push({
        id: 'inspection',
        label: 'Scene inspection',
        hint: 'Freeze a clicked ray, hit point, mesh and face',
        load: async () => {
          const { createInspectionPanel } = await loaders.inspection();
          return createInspectionPanel(options.inspection!);
        },
      });
    }

    entries.push(
      {
        id: 'ocean',
        label: 'Ocean laboratory',
        hint: 'Sea states, wind, swell, whitewater',
        load: async () => {
          const { createOceanLab } = await loaders.ocean();
          return createOceanLab(
            options.getSimHandle(),
            options.weather?.coupling,
          );
        },
      },
      {
        id: 'graphics',
        label: 'Graphics',
        hint: 'Atmosphere, exposure, ocean optics, stars, lamp',
        load: async () => {
          const { createGraphicsPanel } = await loaders.graphics();
          this.graphicsPanel = createGraphicsPanel(options.getSimHandle());
          return this.graphicsPanel;
        },
      },
      {
        id: 'sound',
        label: 'Sound',
        hint: 'Per-voice trims, solo, and what each voice is driven by',
        load: async () => {
          const { createSoundPanel } = await loaders.sound();
          return createSoundPanel(options.ambience);
        },
      },
      {
        id: 'buoyancy',
        label: 'Buoyancy lab',
        hint: 'Stepped harness — reloads the page',
        load: async () => {
          throw new Error('navigates');
        },
        navigateTo: '?debug=buoyancy',
      },
    );
    return entries;
  }
}

function createStatsReading(
  sources: RuntimeUiStatsSources,
): RenderStatsReading {
  return {
    profilingReady: false,
    fps: undefined,
    frameMs: undefined,
    renderScale: 0,
    nativeScale: 1,
    bufferWidth: 0,
    bufferHeight: 0,
    cpu: sources.cpuProfiler.reading,
    gpu: sources.gpuProfiler.reading,
    oceanAtmosphereEvaluations: 0,
    skyRadianceLutWidth: 0,
    skyRadianceLutHeight: 0,
    skyRadianceLutEnabled: false,
    oceanVertexSlots: 0,
    oceanResidualSlots: 0,
    oceanResidualActiveSlots: 0,
    oceanResidualLoopMode: 'active',
    oceanResidualPhaseEnabled: false,
    oceanDetailOctaves: 0,
    oceanDetailRepresentation: 'analytic',
    oceanDetailTextureStyle: 'spectral',
    oceanFoamEnabled: false,
    oceanFlatFragment: false,
    cloudViewSteps: 0,
    cloudSunSteps: 0,
    cloudAdvectionMappings: 2,
    cloudPageTableFetches: 2,
    cloudCacheFetches: 3,
    cloudVisibleTiles: 0,
    cloudGuardTiles: 0,
    cloudResidentTiles: 0,
    cloudSlotCapacity: 0,
    cloudUnmappedGuardTiles: 0,
    cloudUnmappedVisibleTiles: 0,
    cloudCacheBytes: 0,
    cloudFullCacheBytes: 0,
    cloudAtlasWidth: 0,
    cloudAtlasHeight: 0,
    cloudBakedTiles: 0,
    cloudRebaseTiles: 0,
    cloudOnDemandTiles: 0,
    cloudStagingTiles: 0,
    cloudCatchUpTiles: 0,
    cloudSteadyBudget: 0,
    cloudSwapped: false,
  };
}

function refreshStatsReading(
  target: RenderStatsReading,
  frame: Readonly<BrowserFrameDriverReading>,
  sources: RuntimeUiStatsSources,
): void {
  const cloud = sources.cloudDome.reading;
  const profile = sources.ocean.profileSettings;

  target.profilingReady = frame.profilingReady;
  target.fps = frame.cadence.fps;
  target.frameMs = frame.cadence.frameMs;
  target.renderScale = sources.renderer.getPixelRatio();
  target.nativeScale = sources.nativePixelRatio();
  target.bufferWidth = sources.canvas.width;
  target.bufferHeight = sources.canvas.height;
  target.cpu = sources.cpuProfiler.reading;
  target.gpu = sources.gpuProfiler.reading;
  target.cloudViewSteps = sources.quality.cloudMarch;
  target.cloudSunSteps = sources.quality.cloudSunSteps;
  target.cloudAdvectionMappings = 2;
  target.cloudPageTableFetches = 2;
  target.cloudCacheFetches = 3;
  target.cloudVisibleTiles = cloud.visibleTiles;
  target.cloudGuardTiles = cloud.guardTiles;
  target.cloudResidentTiles = cloud.residentTiles;
  target.cloudSlotCapacity = cloud.slotCapacity;
  target.cloudUnmappedGuardTiles = cloud.unmappedGuardTiles;
  target.cloudUnmappedVisibleTiles = cloud.unmappedVisibleTiles;
  target.cloudCacheBytes = cloud.cacheBytes;
  target.cloudFullCacheBytes = cloud.fullCacheBytes;
  target.cloudAtlasWidth = cloud.atlasWidth;
  target.cloudAtlasHeight = cloud.atlasHeight;
  target.cloudBakedTiles = cloud.bakedTiles;
  target.cloudRebaseTiles = cloud.rebaseTiles;
  target.cloudOnDemandTiles = cloud.onDemandTiles;
  target.cloudStagingTiles = cloud.stagingTiles;
  target.cloudCatchUpTiles = cloud.catchUpTiles;
  target.cloudSteadyBudget = cloud.steadyBudget;
  target.cloudSwapped = cloud.swapped;
  target.oceanAtmosphereEvaluations = sources.ocean
    .skyRadianceLutEnabled
    ? 0
    : 2;
  target.skyRadianceLutWidth = sources.radianceLut.width;
  target.skyRadianceLutHeight = sources.radianceLut.height;
  target.skyRadianceLutEnabled = sources.ocean.skyRadianceLutEnabled;
  target.oceanVertexSlots = profile.vertexWaveSlots;
  target.oceanResidualSlots = profile.residualWaveSlots;
  target.oceanResidualActiveSlots = Math.min(
    sources.waves.residualActiveCount,
    profile.residualWaveSlots,
  );
  target.oceanResidualLoopMode = profile.residualLoopMode;
  target.oceanResidualPhaseEnabled = profile.residualPhaseEnabled;
  target.oceanDetailOctaves = profile.detailOctaves;
  target.oceanDetailRepresentation = profile.detailRepresentation;
  target.oceanDetailTextureStyle = profile.detailTextureStyle;
  target.oceanFoamEnabled = profile.foamEnabled;
  target.oceanFlatFragment = profile.flatFragment;
}
