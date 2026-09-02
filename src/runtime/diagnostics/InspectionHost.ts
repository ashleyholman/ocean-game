import * as THREE from 'three';
import type { AstronomyProvider } from '../../astronomy/AstronomyProvider';
import type { DeckWalker } from '../../player/DeckWalker';
import {
  setBathGradientMix,
  setPortalLightMix,
  setPortalSkySource,
  setWorldDebugView,
  type WorldDebugView,
} from '../../scene/WorldPbrMaterial';
import type { Schooner } from '../../vessel/schooner/Schooner';
import { findStation } from '../../vessel/schooner/stations';
import { findSeaState } from '../../ocean/presets';
import {
  CLOSURE_NAMES,
  resetClosures,
  setClosureOpen,
} from '../../vessel/schooner/closures';
import type { ClosureName } from '../../vessel/schooner/closures';
import type { SimHandle } from './SimHandle';
import {
  SurfaceLightProbe,
  type GridCell,
  type ProbeConditions,
  type SurfaceLightSample,
} from './SurfaceLightProbe';

/**
 * The deterministic-view host: URL parameters in, a settled reproducible
 * frame and an analytical probe out.
 *
 * This exists so an agent (or a bookmark) can name a complete viewing
 * condition — time of day, where the eye stands, where it looks — and get
 * the same frame every run, plus `window.__driftInspect` to interrogate what
 * is on it. The alternative it replaces is documented pain: driving the
 * debug panels by synthetic clicks and reading the picture back by eye.
 *
 * PARAMETERS (all optional; any of them activates the host)
 * ----------------------------------------------------------
 *   inspect=1                     activate with defaults
 *   solarTime=<hours>             local apparent solar time, decimal hours
 *   dayOfYear=<1..366>            calendar day, preserving solar time
 *   stand=<station>|<x,z[,y]>     put the walker somewhere (see stations.ts)
 *   look=<yawDeg,pitchDeg>        eye direction: yaw 0 = toward the bow,
 *                                 180 = toward the stern, positive pitch up
 *   freezeTime=0                  let the world clock run (frozen by default)
 *   sea=<preset>                  a sea-state preset by name (see presets.ts),
 *                                 applied at once with the foam field warmed
 *   view=<distanceM,altitudeM[,azimuthDeg]>
 *                                 the cinematic camera's distance, height and
 *                                 optionally its orbit azimuth, for an exterior
 *                                 capture with a stated framing
 *   heading=<deg>                 put the ship on a true heading under the
 *                                 captive diagnostic tow, for a stated framing
 *   portalMix=<0..1>              interior lighting A/B
 *   worldView=<term>              a term view, by its WorldDebugView name
 *
 * SETTLING, AND WHY THE SENTINEL IS LATE
 * --------------------------------------
 * A scrubbed clock invalidates the sky LUT, the cloud gate, the world probe
 * and the eye's adaptation, each of which settles on its own schedule. The
 * host applies conditions, forces the synchronous world-lighting rebuild the
 * contact sheets use, snaps adaptation, and only then publishes
 * `__driftInspect.ready = true`. A capture taken before the sentinel is a
 * capture of the transition, not the condition.
 */

export interface InspectionHostDependencies {
  params: URLSearchParams;
  sim: SimHandle;
  astronomy: AstronomyProvider;
  deckWalker?: DeckWalker;
  schooner?: Schooner;
  /** The live sun as the renderer sees it, multipliers included. */
  sunLight: THREE.DirectionalLight;
  requestCloudCacheRebase(): void;
  waitPresentedFrames(count: number): Promise<void>;
}

export interface InspectionGlobal {
  ready: boolean;
  /** What the host actually applied, echoed for the capture's provenance. */
  applied: Record<string, unknown>;
  conditions(): ProbeConditions;
  probeNdc(ndcX: number, ndcY: number): SurfaceLightSample | null;
  probePoint(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
  ): SurfaceLightSample;
  probeGrid(columns: number, rows: number): GridCell[];
  /** One call for the CLI: conditions + grid, JSON-ready. */
  report(columns?: number, rows?: number): {
    applied: Record<string, unknown>;
    conditions: ProbeConditions;
    grid: GridCell[];
  };
}

declare global {
  interface Window {
    __driftInspect?: InspectionGlobal;
  }
}

const INSPECTION_PARAMS = [
  'inspect',
  'solarTime',
  'dayOfYear',
  'stand',
  'look',
  'portalMix',
  'worldView',
  'adaptation',
  'bathGradient',
  'portalSky',
  'lamps',
  'lampsShadow',
  'open',
  'sea',
  'view',
  'heading',
] as const;

export function inspectionRequested(params: URLSearchParams): boolean {
  return INSPECTION_PARAMS.some((name) => params.has(name));
}

/** Parse "a,b[,c]" into numbers, or null when any piece is not a number. */
function parseNumbers(raw: string | null, count: number): number[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length < count || parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

export function startInspectionHost(
  dependencies: InspectionHostDependencies,
): void {
  const { params } = dependencies;
  if (!inspectionRequested(params)) return;
  void runInspectionHost(dependencies).catch((error) => {
    console.error('[inspect] host failed', error);
  });
}

async function runInspectionHost(
  dependencies: InspectionHostDependencies,
): Promise<void> {
  const {
    params,
    sim,
    astronomy,
    deckWalker,
    schooner,
    sunLight,
    requestCloudCacheRebase,
    waitPresentedFrames,
  } = dependencies;
  const { cameras, world, lighting, renderer, vessel } = sim;
  const applied: Record<string, unknown> = {};

  // Let the first real frames run: materials compile, the probe publishes,
  // the walker exists. Conditions applied into a half-built scene apply to
  // nothing.
  await waitPresentedFrames(3);

  // --- the clock ------------------------------------------------------------
  const freeze = params.get('freezeTime') !== '0';
  world.setPaused(freeze);
  applied.freezeTime = freeze;

  const solarTime = Number(params.get('solarTime'));
  if (Number.isFinite(solarTime) && params.has('solarTime')) {
    astronomy.setLocalApparentSolarTime(world, solarTime);
    applied.solarTime = solarTime;
  }
  const dayOfYear = Number(params.get('dayOfYear'));
  if (Number.isFinite(dayOfYear) && params.has('dayOfYear')) {
    astronomy.setDayOfYearPreservingLocalApparentSolarTime(
      world,
      Math.round(dayOfYear),
    );
    applied.dayOfYear = Math.round(dayOfYear);
  }
  if (applied.solarTime !== undefined || applied.dayOfYear !== undefined) {
    sim.refreshLighting();
    requestCloudCacheRebase();
  }

  // --- the sea -----------------------------------------------------------------
  // Applied at once, not over the transition a player would see, and with the
  // foam field warmed so a paused world still shows the whitewater the state
  // would carry. `findSeaState` falls back to the production sea for a name it
  // does not know, so `applied.sea` echoes the state actually used.
  const seaName = params.get('sea');
  if (seaName) {
    const state = findSeaState(seaName);
    sim.setSeaState(state, 0);
    sim.clearFoam();
    sim.warmFoam();
    applied.sea = state.name;
  }

  // --- the heading ---------------------------------------------------------------
  // The captive tow the wake evidence uses: it is the one way to *state* a
  // heading rather than order one and wait for the helm, and a capture wants
  // the ship where the framing says, not where the crew would have her.
  const heading = Number(params.get('heading'));
  if (Number.isFinite(heading) && params.has('heading')) {
    const speed = sim.wakeDiagnosticMotionState().targetSpeedMps;
    sim.setWakeDiagnosticTow(
      Number.isFinite(speed) && speed > 0 ? speed : 3,
      (heading * Math.PI) / 180,
      0,
    );
    applied.heading = heading;
  }

  // --- the switches ----------------------------------------------------------
  const portalMix = Number(params.get('portalMix'));
  if (Number.isFinite(portalMix) && params.has('portalMix')) {
    setPortalLightMix(portalMix);
    applied.portalMix = portalMix;
  }
  const worldView = params.get('worldView');
  if (worldView) {
    setWorldDebugView(worldView as WorldDebugView);
    applied.worldView = worldView;
  }
  const adaptation = params.get('adaptation');
  if (
    adaptation === 'fixed' ||
    adaptation === 'metered' ||
    adaptation === 'gaze' ||
    adaptation === 'room-lift'
  ) {
    schooner?.setAdaptationMode(adaptation);
    applied.adaptation = adaptation;
  }
  const bathGradient = Number(params.get('bathGradient'));
  if (Number.isFinite(bathGradient) && params.has('bathGradient')) {
    setBathGradientMix(bathGradient);
    applied.bathGradient = bathGradient;
  }
  const portalSky = params.get('portalSky');
  if (portalSky === 'map' || portalSky === 'sh') {
    setPortalSkySource(portalSky);
    applied.portalSky = portalSky;
  }
  // The lanterns-below A/B: auto is the room-driven latch (the shipping
  // policy), on/off force all of them for the pairs a latch would never show.
  const lamps = params.get('lamps');
  if (lamps === 'auto' || lamps === 'on' || lamps === 'off') {
    schooner?.setLampsMode(lamps);
    applied.lamps = lamps;
  }
  const lampsShadow = params.get('lampsShadow');
  if (lampsShadow === '0' || lampsShadow === '1') {
    schooner?.setLampsShadow(lampsShadow === '1');
    applied.lampsShadow = lampsShadow === '1';
  }

  // --- what is open ------------------------------------------------------------
  // **The hatches, before the body is placed.** A capture of the fore scuttle
  // or the hold wants the ship in a stated state, and until this existed the
  // only way to see either of them open was to walk over and press Space —
  // which is exactly the hand-driving this tool exists to remove.
  //
  // Named closures are opened and every other one is put back to how she
  // starts, so `--open` states the whole configuration rather than mutating
  // whatever the last run left behind. `syncClosures` then makes the drawn
  // meshes agree, which is the one call that keeps a hatch from being visibly
  // shut and mechanically open.
  if (params.has('open')) {
    resetClosures();
    const names = (params.get('open') ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const opened: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      if ((CLOSURE_NAMES as readonly string[]).includes(name)) {
        setClosureOpen(name as ClosureName, true);
        opened.push(name);
      } else {
        unknown.push(name);
      }
    }
    schooner?.syncClosures();
    applied.opened = opened;
    if (unknown.length > 0) applied.openUnknown = unknown;
  }

  // --- the eye ----------------------------------------------------------------
  // `setDiagnosticMode` cuts straight to the controller instead of flying the
  // authored transition: a capture taken mid-flight is a capture of nowhere,
  // and the adaptation snap below must read the eye's true final position.
  const stand = params.get('stand');
  if (stand && deckWalker) {
    const coords = parseNumbers(stand, 2);
    if (coords) {
      const [x, z, fromY] = coords;
      applied.stand = { x, z, fromY };
      if (!deckWalker.placeAt(x, z, fromY)) applied.standRefused = true;
    } else {
      const station = findStation(stand);
      if (station) {
        applied.stand = station.label;
        if (!deckWalker.placeAt(station.x, station.z, station.fromY)) {
          applied.standRefused = true;
        }
      } else {
        applied.standUnknown = stand;
      }
    }
    // Hold the body where it was put: the settle frames below are seconds of
    // heel slip on a trimmed deck, which is enough to pour a body down an
    // open companionway while the capture waits for the light to steady.
    deckWalker.setHeld(true);
    cameras.setDiagnosticMode('embodied');
  }

  // An exterior framing: distance and altitude for the cinematic camera, cut
  // to directly like the embodied placement above rather than flown to.
  const view = parseNumbers(params.get('view'), 2);
  if (view) {
    cameras.setDiagnosticMode('cinematic');
    cameras.setDiagnosticView(view[0], view[1]);
    const viewApplied: Record<string, number> = {
      distanceMetres: view[0],
      altitudeMetres: view[1],
    };
    if (view.length >= 3) {
      cameras.cinematic.setAzimuth((view[2] * Math.PI) / 180);
      viewApplied.azimuthDeg = view[2];
    }
    applied.view = viewApplied;
  }

  const look = parseNumbers(params.get('look'), 2);
  if (look) {
    // URL yaw is a human convention: 0 = toward the bow, 180 = the stern.
    // The embodied controller's yaw 0 faces the stern (−z), so convert.
    const yaw = Math.PI - (look[0] * Math.PI) / 180;
    const pitch = (look[1] * Math.PI) / 180;
    cameras.setDiagnosticMode('embodied');
    cameras.embodied.look = { yaw, pitch };
    applied.look = { yawDeg: look[0], pitchDeg: look[1] };
  }

  // Clean frame by default: both interface shells put their chrome away on
  // the same `\` key a human uses, so the host speaks that contract rather
  // than growing a parallel API. The controls hint is on its own 9.5 s timer
  // outside that contract, so it is put away directly. `chrome=1` keeps the
  // interface visible.
  if (params.get('chrome') !== '1') {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\' }));
    document.getElementById('hint')?.style.setProperty('display', 'none');
    applied.chromeHidden = true;
  }

  // --- settle -------------------------------------------------------------------
  // Two frames pose the camera and rerun the visibility test; the forced
  // world-lighting rebuild then publishes the probe this frame instead of
  // whenever its cadence next fires; adaptation snaps against the fresh
  // below-decks verdict; two more frames let the uniforms reach the GPU.
  await waitPresentedFrames(2);
  sim.refreshWorldLighting();
  schooner?.snapEyeAdaptation();
  // The lamps' latches are path-dependent by design, and this host jumps
  // the clock — the latch state the page booted into is a path the capture's
  // hour never walked. Reseed so the next frame re-derives each from its
  // now-fresh room signal (day-side answer inside the hysteresis band)...
  if (schooner) {
    for (const lamp of schooner.interiorLamps.values()) lamp.reseedLatch();
  }
  await waitPresentedFrames(1);
  // ...then every flame jumps its 2 s presentation ramp (and its swing to
  // rest): a dusk capture must show the lamp the latch decided on, not
  // however far a match had burned when the shutter fired.
  schooner?.lamp.snapLit();
  if (schooner) {
    for (const lamp of schooner.interiorLamps.values()) lamp.snapLit();
  }
  await waitPresentedFrames(2);

  const probe = new SurfaceLightProbe({
    camera: () => cameras.camera,
    target: () => vessel.group,
    vesselGroup: () => vessel.group,
    sun: () => ({
      directionWorld: lighting.sunDirection.clone().normalize(),
      color: sunLight.color,
      intensity: sunLight.intensity,
    }),
    exposure: () => renderer.toneMappingExposure,
  });

  const inspect: InspectionGlobal = {
    ready: true,
    applied,
    conditions: () => probe.conditions(),
    probeNdc: (x, y) => probe.probeNdc(x, y),
    probePoint: (x, y, z, nx, ny, nz) => probe.probePoint(x, y, z, nx, ny, nz),
    probeGrid: (columns, rows) => probe.probeGrid(columns, rows),
    report: (columns = 16, rows = 9) => ({
      applied,
      conditions: probe.conditions(),
      grid: probe.probeGrid(columns, rows),
    }),
  };
  window.__driftInspect = inspect;
  console.info('[inspect] ready', applied);
}
