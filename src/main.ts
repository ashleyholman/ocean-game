import * as THREE from 'three';
import './styles.css';

import {
  AstronomyProvider,
  createAstronomyFrame,
} from './astronomy/AstronomyProvider';
import { Ambience } from './audio/Ambience';
import { CameraSystem } from './camera/CameraSystem';
import { vesselFramingEnvelope } from './camera/vesselFraming';
import { InputController } from './input/InputController';
import { Ocean, type InteriorCutoutMode } from './scene/Ocean';
import { FoamField } from './scene/FoamField';
import { createFoamLookup } from './scene/foamLookup';
import { CrestSpray } from './scene/CrestSpray';
import type { Vessel } from './vessel/Vessel';
import { Raft } from './vessel/raft/Raft';
import { Schooner } from './vessel/schooner/Schooner';
import { CABIN_SOLE_Y } from './vessel/schooner/hullForm';
import { createSchoonerInteriorCutoutVolume } from './vessel/schooner/interiorCutoutVolume';
import { BrowserDiagnosticsBridge } from './runtime/diagnostics/BrowserDiagnosticsBridge';
import { SailingControls } from './vessel/schooner/SailingControls';
import { SchoonerSailForces } from './vessel/schooner/SchoonerSailForces';
import { SailingCrewSensors } from './vessel/schooner/crew/CrewObservations';
import { SailingCrew } from './vessel/schooner/crew/SailingCrew';
import { SCHOONER_DECK_ENVIRONMENT } from './vessel/schooner/deckObstacles';
import { DeckWalker } from './player/DeckWalker';
import {
  trueHeadingForModelYaw,
  VesselSpeedTarget,
} from './vessel/VesselMotion';
import { SkySystem } from './scene/SkySystem';
import { StarField } from './scene/StarField';
import { TimeOfDay } from './scene/TimeOfDay';
import * as colourPipeline from './scene/colourPipeline';
import { WaveField } from './scene/Waves';
import { WindSystem } from './scene/WindSystem';
import { WorldWind } from './world/WorldWind';
import { WeatherSystem } from './weather/WeatherSystem';
import { WeatherPresentation } from './weather/WeatherPresentation';
import { WorldRenderAdapter } from './scene/WorldRenderAdapter';
import { WorldLighting } from './scene/WorldLighting';
import {
  getPortalLightMix,
  getPortalSkySource,
  isWorldDebugViewActive,
  setBathGradientMix,
  setPortalLightMix,
  setPortalSkySource,
  setWorldDebugView,
  setWorldSh,
} from './scene/WorldPbrMaterial';
import { findSeaState, PRODUCTION_SEA_STATE } from './ocean/presets';
import { SeaStateController } from './ocean/SeaStateController';
import type { SeaState } from './ocean/seaState';
import { WindSeaCoupling } from './ocean/WindSeaMemory';
import { CpuProfiler } from './render/CpuProfiler';
import {
  GpuProfiler,
  GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN,
  GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN,
} from './render/GpuProfiler';
import { OceanTemporalResolve } from './render/OceanTemporalResolve';
import { ScenePresentPass } from './render/ScenePresentPass';
import { Hint } from './ui/Hint';
import { ActionBar } from './ui/ActionBar';
import { DeskFocus } from './ui/DeskFocus';
import { canUseDeskPointer, DeskPointer } from './player/DeskPointer';
import { deskItems } from './vessel/schooner/deskItems';
import { buildShipInteractables } from './vessel/schooner/shipInteractables';
import { SeatedStation } from './player/SeatedStation';
import { cabinBarometerTarget } from './vessel/schooner/captainsDesk';
import { occupiedStation, setOccupiedStation } from './vessel/schooner/seatState';
import type { StationName } from './vessel/schooner/seatState';
import { shipStation } from './vessel/schooner/shipStations';
import { setScotopicStrength } from './scene/scotopic';
import { setTimberMode } from './vessel/schooner/timberFinish';
import { ALOFT_STABILISATION } from './vessel/schooner/aloftComfort';
import {
  advanceClimb,
  beginLayingDown,
  isAtTheFoot,
  resetClimb,
  setClimbProgress,
} from './vessel/schooner/aloftState';
import { climbAnchors } from './vessel/schooner/riggingClimb';
import type { ClimbSide } from './vessel/schooner/riggingClimb';
import { climbWalkEntry, shouldWalkOffClimb } from './vessel/schooner/climbInteraction';
import { WALKING_STABILISATION } from './camera/EmbodiedCameraController';
import type { PlayerAction } from './ui/ActionBar';
import { REACH, type ReachHit } from './player/Interactables';
import { PresentationClock } from './world/clock';
import { deriveNavigationTelemetry } from './world/navigation';
import {
  OPENING_LATITUDE_DEG,
  OPENING_LONGITUDE_DEG,
  OPENING_ORDERED_COURSE_DEG,
  OPENING_SPEED_MPS,
  OPENING_TRUE_HEADING_RAD,
  OPENING_UTC_SECONDS,
  openingTrimDeg,
} from './world/openingVoyage';
import { PlanetaryWorld } from './world/PlanetaryWorld';
import { VoyageClockControl } from './world/voyageClock';
import { BrowserFrameDriver } from './runtime/BrowserFrameDriver';
import { BrowserViewport } from './runtime/BrowserViewport';
import { EnvironmentRuntime } from './runtime/EnvironmentRuntime';
import { ProductionSimulationRuntime } from './runtime/ProductionSimulationRuntime';
import { WakePresentationController } from './runtime/WakePresentationController';
import { createRuntimeRenderer } from './runtime/createRenderer';
import { RenderPipeline } from './runtime/RenderPipeline';
import { RuntimeLifecycle } from './runtime/RuntimeLifecycle';
import { resolveRuntimeOptions } from './runtime/RuntimeOptions';
import { resolveRuntimeQuality } from './runtime/RuntimeQuality';
import {
  RuntimeUi,
  type RuntimeUiWorldTelemetry,
} from './runtime/RuntimeUi';
import { VesselRuntime } from './runtime/VesselRuntime';
import type { GpuDetailPass } from './render/GpuProfiler';
import {
  onTerrainDrawOrderChange,
  setTerrainDrawOrder,
  type TerrainDrawOrder,
} from './terrain/terrainDrawOrder';
import type { SimHandle } from './runtime/diagnostics/SimHandle';
import {
  createSimHandle,
  createSimHandleBinding,
} from './runtime/diagnostics/createSimHandle';
import {
  createDiagnosticExecutionGate,
  createRuntimeDiagnostics,
} from './runtime/diagnostics/RuntimeDiagnostics';
import {
  startPerformanceEvidenceHosts,
  startTerrainAndViewerEvidenceHosts,
} from './runtime/diagnostics/startEvidenceHosts';
import { startInspectionHost } from './runtime/diagnostics/InspectionHost';

export type {
  OceanDetailContactSheet,
  OceanDetailContactSheetSet,
  OceanDetailContactSheetView,
  SimHandle,
  WakeBowFeature,
  WakeDiagnosticMotionState,
  WakeTrailFeature,
} from './runtime/diagnostics/SimHandle';

const DEG_TO_RAD = Math.PI / 180;
// The opening situation — heading, sheets and standing helm order — is derived
// from the production sea in src/world/openingVoyage.ts, not restated here.
const INITIAL_LATITUDE_RAD = OPENING_LATITUDE_DEG * DEG_TO_RAD;
const INITIAL_LONGITUDE_RAD = OPENING_LONGITUDE_DEG * DEG_TO_RAD;
const INITIAL_TRUE_COURSE_RAD = OPENING_TRUE_HEADING_RAD;
const INITIAL_UTC_SECONDS = OPENING_UTC_SECONDS;

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hintElement = document.getElementById('hint') as HTMLElement;
const params = new URLSearchParams(window.location.search);
const runtimeOptions = resolveRuntimeOptions(params, {
  viewportWidth: window.innerWidth,
  viewportHeight: window.innerHeight,
  screenWidth: window.screen?.width,
  screenHeight: window.screen?.height,
  isTouch: window.matchMedia('(hover: none) and (pointer: coarse)').matches,
});
const {
  debugMode,
  debugUiEnabled,
  fixedPixelRatio,
  initialOceanTemporalEnabled,
  depthMode: requestedDepthMode,
  depthModeWasRequested,
  cloudMarchOverride,
  buoyancyLabEnabled,
  captureHostEnabled,
  schoonerViewerEnabled,
  raftEnabled,
  interiorCutoutMode,
  interiorCabinViewEnabled,
  interiorDeskViewEnabled,
  aloftViewEnabled,
  initialDirectShadowing,
  sailClothMode,
  scotopicStrength: initialScotopicStrength,
  timberMode,
  capturePort,
  isTouch,
  isSmallScreen,
} = runtimeOptions;

// Explicit global terrain resolves the authored opening against the real mask
// before the canonical world exists (it sits in open water, so it resolves to
// itself; an authored land point would be moved to qualified water). The conditional dynamic import keeps Natural Earth
// and the bootstrap query out of synthetic/off startup; their lazy World panel
// may later load the resolver module's formatter. Those paths retain the
// authored coordinates byte-for-byte.
const globalOpeningResolution =
  runtimeOptions.terrainMode === 'global'
    ? await import('./terrain/globalTerrainOpeningRuntime').then(
        ({ resolveGlobalTerrainOpening }) =>
          resolveGlobalTerrainOpening({
            latitudeRad: INITIAL_LATITUDE_RAD,
            longitudeRad: INITIAL_LONGITUDE_RAD,
            outboundCourseRad: INITIAL_TRUE_COURSE_RAD,
          }),
      )
    : undefined;
const openingLatitudeRad =
  globalOpeningResolution?.resolved.latitudeRad ?? INITIAL_LATITUDE_RAD;
const openingLongitudeRad =
  globalOpeningResolution?.resolved.longitudeRad ?? INITIAL_LONGITUDE_RAD;
// Before anything builds a vessel. `woods` is read while the schooner's
// materials are constructed and `grain` sets a define that has to be present
// at first compile, so a mode set after the ship exists is a mode that does
// nothing — silently, which is the shape of bug the A/B registry's read-back
// requirement exists to catch.
setTimberMode(timberMode);
// Before `ScenePresentPass`, which reads the strength on its first frame and
// latches a rod state from it. The parse itself now lives in `RuntimeOptions`
// with every other URL decision; this is the push, and it is the whole of what
// `?scotopic=` does at startup.
setScotopicStrength(initialScotopicStrength);
const runtimeQuality = resolveRuntimeQuality(
  isSmallScreen,
  cloudMarchOverride,
);
const lifecycle = new RuntimeLifecycle();

// --- renderer ---------------------------------------------------------------
const renderer = createRuntimeRenderer({
  canvas,
  // `?capture=1` joins the two labs here for the reason `captureHost.ts`
  // opens with: a retained buffer is the difference between a capture that can
  // be read and one that comes back black.
  preserveDrawingBuffer:
    buoyancyLabEnabled || schoonerViewerEnabled || captureHostEnabled,
  depthMode: requestedDepthMode,
  depthModeWasRequested,
});
const cpuProfiler = new CpuProfiler();
/**
 * The profiler's endpoint rotation has to be in SUBMISSION order, and the
 * terrain A/B moves terrain across the sea. Both the boot arm and every later
 * live flip go through here (TERR-131/134).
 */
const gpuDetailPassesFor = (
  order: TerrainDrawOrder,
): readonly GpuDetailPass[] =>
  order === 'before'
    ? GPU_DETAIL_PASSES_TERRAIN_BEFORE_OCEAN
    : GPU_DETAIL_PASSES_TERRAIN_AFTER_OCEAN;
setTerrainDrawOrder(runtimeOptions.terrainDrawOrder);
const gpuProfiler = new GpuProfiler(
  renderer,
  gpuDetailPassesFor(runtimeOptions.terrainDrawOrder),
);
let terrainDrawsBeforeOcean = runtimeOptions.terrainDrawOrder === 'before';
onTerrainDrawOrderChange((order) => {
  terrainDrawsBeforeOcean = order === 'before';
  gpuProfiler.setDetailPasses(gpuDetailPassesFor(order));
});

const adaptivePixelRatioTarget = Math.min(
  window.devicePixelRatio || 1,
  runtimeQuality.maximumPixelRatio,
);
const initialPixelRatioCap = fixedPixelRatio ?? adaptivePixelRatioTarget;
const applyPixelRatio = (cap: number): void =>
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, cap),
  );
applyPixelRatio(initialPixelRatioCap);

const scene = new THREE.Scene();

// --- authoritative world and presentation consumers ------------------------
const worldWind = new WorldWind();
const wind = new WindSystem();

/**
 * Whether this page's vessel is moved by the raft-era kinematic drift model.
 *
 * This flag decides whether the world advances on
 * `speedTarget.targetSpeedMps` rather than integrated sail forces, whether the
 * global R command is bound, and whether desktop advertises it. Those facts
 * used to be decided separately, which is how the production schooner ended up
 * advertising a control that reached nothing but a word in a debug panel.
 *
 * The object mast tap is deliberately narrower and is keyed to `raftEnabled`:
 * unlike the viewer, the raft publishes the physical target the player can
 * point at from embodied reach.
 *
 * True for the diagnostic raft (`?debug=raft`, `?debug=buoyancy`) and the
 * schooner viewer (`?debug=schooner`, `?debug=ship`). The raft is a supported
 * diagnostic vessel, so every part of `WindSystem`'s sail — the animated
 * `sail` float, `sailRaised`, `toggleSail`, `targetDriftSpeedMps` and the two
 * `driftSpeed*` constants — stays exactly where it is.
 */
const driftSailVessel = raftEnabled || schoonerViewerEnabled;
const world = new PlanetaryWorld({
  worldInstantUtcSeconds: INITIAL_UTC_SECONDS,
  latitudeRad: openingLatitudeRad,
  longitudeRad: openingLongitudeRad,
  initialCourseRad: INITIAL_TRUE_COURSE_RAD,
  // The schooner joins a passage already under way; the raft has no rig and
  // keeps its drift.
  initialSpeedMps: raftEnabled ? wind.driftSpeedSailDown : OPENING_SPEED_MPS,
});
const vesselSpeedTarget = new VesselSpeedTarget(
  () => wind.targetDriftSpeedMps,
);
const astronomy = new AstronomyProvider();
const astronomyFrame = createAstronomyFrame();
const worldRender = new WorldRenderAdapter();
const presentationClock = new PresentationClock();

/**
 * Live policy over voyage-time compression. Honest 1× by default; `?voyage=`
 * or the Voyage panel raise it, and governed mode caps the nearest land's
 * apparent slide. Fed each frame from the terrain handle's live land
 * distance; with terrain off the sample stays land-free and governed mode
 * runs at full compression.
 */
const voyageClock = new VoyageClockControl(world, {
  mode: runtimeOptions.voyageMode,
  fixedRate: runtimeOptions.voyageFixedRate,
  omegaMaxDegPerS: runtimeOptions.voyageOmegaMaxDegPerS,
});

const quality = runtimeQuality.ocean;
const lighting = new TimeOfDay();

/**
 * The sea state, and the wave field it resolves to.
 *
 * The component slot budget is deliberately identical on every device. Mobile
 * saves its budget on mesh density, detail octaves, foam resolution and spray
 * count — none of which the active vessel can feel. Cutting components instead
 * would make the vessel float differently on a phone while the parity probe stayed
 * green, because CPU and GPU would still agree with each other.
 */
const seaStates = new SeaStateController(findSeaState(PRODUCTION_SEA_STATE));
const waves = new WaveField(seaStates.state);

/**
 * The present weather — the glass, and the wind it implies.
 *
 * Built here, after the sea state, because the opening sea's generating wind is
 * the prevailing wind it departs from. It takes that wind **once**: WX2 cut the
 * per-frame read, so from the second frame on the causation runs one way only,
 * weather to sea. It anchors on the world's opening position and instant, so
 * the voyage begins in a settled spell with the wind she already had, to the
 * last bit. `?weather=off` puts it back to the sea state verbatim; clear, rain
 * and storm are selectable review records over the same state path.
 */
const weather = new WeatherSystem({
  world,
  source: runtimeOptions.weatherSource,
  rate: runtimeOptions.weatherRate,
  baseWind: {
    speedMps: seaStates.state.generatingWind.speedMps,
    directionDeg: seaStates.state.generatingWind.directionDeg,
    gustiness: seaStates.state.generatingWind.gustiness,
  },
});

/**
 * And the sea's memory of it — WX2's deliverable.
 *
 * Decision D5: coupled in play, `Independent` in the laboratory.
 * `?seaCoupling=independent` opens uncoupled, and the Weather and Ocean panels
 * both carry the switch. Coupled, the wind can freshen minutes before the water
 * is big and the water can stay up after the wind has gone; uncoupled, the sea
 * is exactly where the lab put it while the weather does what it likes, which
 * is how the mismatched combinations get built.
 */
const windSeaCoupling = new WindSeaCoupling(
  seaStates,
  seaStates.state,
  runtimeOptions.seaFollowsWeather,
);

/**
 * Somebody chose a sea — a preset button, a lab slider, a capture host.
 *
 * Two things follow and they have to happen together. The memory forgets the
 * wind that grew the last sea and adopts this one's, and (when coupled) weather
 * declares that wind to be the wind blowing right now. Do only the first and
 * the coupler drags the new sea straight back off the preset; do only the
 * second and the sea it is being dragged toward is the old one.
 */
function adoptChosenSeaState(chosen: SeaState): void {
  windSeaCoupling.rebase(chosen, weather.elapsedSeconds);
  if (!windSeaCoupling.coupled) return;
  weather.recalibrateTo(
    chosen.generatingWind.speedMps,
    chosen.generatingWind.directionDeg,
    chosen.generatingWind.gustiness,
  );
}

const sky = new SkySystem(
  quality.cloudOctaves,
  quality.cloudMarch,
  quality.cloudShapeOctaves,
  quality.cloudSunSteps,
  runtimeQuality.cloudCache.atlasWidth,
  runtimeQuality.cloudCache.atlasHeight,
  runtimeQuality.cloudCache.slotCapacity,
);
const stars = new StarField(sky.uniforms);
// `?starDome=near` restores the 485 m dome for an A/B against the far-plane
// one; production parks the catalogue behind every solid thing in the world.
stars.domeAnchor = runtimeOptions.starDomeAnchor;
const foamQuality = runtimeQuality.foam;
const ocean = new Ocean(waves, quality, foamQuality, sky.uniforms);
const foam = new FoamField(waves, foamQuality);
const crestSpray = new CrestSpray(runtimeQuality.crestSpray);

/**
 * The schooner is the vessel now, and the raft is opt-in behind `?debug=raft`.
 *
 * `docs/ship/SHIP_ROUND_HANDOVER.md` section 7 said the swap happens "once, late, when
 * she is genuinely better". The world lighting round is what made her better:
 * before it she was a featureless dark mass with no sky to reflect, which is
 * not a vessel anyone would choose to sail.
 *
 * Only the selected vessel is constructed. The legacy raft is a diagnostic
 * implementation, not hidden production state.
 */
/**
 * Exactly one body advances the wave field. Whichever vessel is aboard is the
 * one that owns it — two advancing one field runs the sea at double speed.
 */
const activeVessel: Vessel = raftEnabled ? new Raft() : new Schooner();
const schooner = activeVessel instanceof Schooner ? activeVessel : undefined;
const setInteriorCutoutMode = (mode: InteriorCutoutMode): void => {
  ocean.setInteriorCutoutMode(mode);
  schooner?.setInteriorStencilEnabled(mode === 'stencil');
};
if (schooner) {
  ocean.setInteriorCutoutVolume(createSchoonerInteriorCutoutVolume());
  setInteriorCutoutMode(interiorCutoutMode);
}
/**
 * Foam-field reconstruction A/B, defaulting to the replacement.
 *
 * Unlike the hull-wake switches owned by `WakePresentationController`, this
 * one is not wake-only: the same lookup serves every whitecap in the sea.
 * Legacy therefore has to stay reachable as an exact arm, because accepting
 * the replacement is a judgement about ambient foam as much as about the trail.
 */
let foamLookupLegacy = false;
const foamLookup = createFoamLookup();
/**
 * The sail rig as a force source (S2): full authored canvas at frozen trim,
 * driven by the instantaneous world wind, injected through the dynamics'
 * external-force seam. The drawn sails are all set, so the physics carries
 * the same canvas the eye sees.
 */
const sailForces = schooner ? new SchoonerSailForces(worldWind) : undefined;
if (schooner && sailForces) {
  schooner.horizontalDynamics.externalForces = sailForces;
}
/**
 * The helm (S3): a rate-limited tiller through the dynamics' rudder seam.
 * Commands come from the sailing dev panel today and any future input the
 * same way; uncommanded, the physics is bit-identical to amidships helm.
 */
const sailingControls = schooner
  ? new SailingControls(openingTrimDeg())
  : undefined;
if (schooner && sailingControls) {
  schooner.horizontalDynamics.helm = sailingControls;
}
/**
 * S4: the physics reads the live control surface — per-sail set states,
 * hoists and trims — instead of the frozen canvas. The controls start at
 * the authored trims, so an untouched session is the S2/S3 rig exactly.
 */
if (sailForces && sailingControls) {
  sailForces.attachControls(sailingControls);
}
/**
 * S5 checkpoint: exact vessel/aero truth stops in `SailingCrewSensors`; the
 * human policy receives only its `HelmObservation`. Both advance on the same
 * 240 Hz grid as the S4 actuator, in that order, through separate dynamics
 * seams. Main is the composition boundary and the only place they meet.
 */
let sailingCrew: SailingCrew | undefined;
let sailingCrewSensors: SailingCrewSensors | undefined;
if (schooner && sailingControls && sailForces) {
  sailingCrew = new SailingCrew(sailingControls);
  sailingCrewSensors = new SailingCrewSensors({
    seed: sailingCrew.seed,
    headingDegForModelYaw: (modelYawRad) =>
      trueHeadingForModelYaw(world.state, modelYawRad) / DEG_TO_RAD,
    rudderTargetDeg: () => sailingControls.rudderTargetDeg,
    sailAero: () => sailForces.lastResult,
    focus: () => sailingCrew!.focus,
  });
  schooner.horizontalDynamics.substepTruthObserver = sailingCrewSensors;
  schooner.horizontalDynamics.substepCommander = {
    advanceSubstep: (stepSeconds) =>
      sailingCrew!.advanceSubstep(
        stepSeconds,
        sailingCrewSensors!.helmObservation,
        (sail) => sailingCrewSensors!.sailObservation(sail),
      ),
    reset: () => sailingCrew!.reset(),
  };
  // Someone is already at the tiller holding a course when the page opens.
  // Spoken here rather than pre-loaded into the helmsman on purpose: the order
  // goes through the ordinary utterance and reaction pipeline, so the first
  // seconds show a real human picking the ship up, not a servo latching.
  sailingCrew.orderCompassCourse(OPENING_ORDERED_COURSE_DEG);
  // And hands are already at the sheets keeping her drawing. Same reasoning:
  // spoken, so the opening seconds show each station picking its sail up in
  // its own time rather than every sheet snapping to a stored setting.
  sailingCrew.orderTrimToDraw();
}
// One scene-graph traversal, once, after the active vessel is fully assembled.
// The camera thereafter consumes only this immutable eight-corner envelope;
// neither mesh geometry nor Box3 is touched on the frame path.
const activeVesselFraming = vesselFramingEnvelope(activeVessel.group);
ocean.setVesselOcclusionRadius(activeVessel.halfBeamM);
/**
 * The camera. One rig, two modes, one active three.js camera.
 *
 * The legacy raft optionally supplies a castaway-visibility capability. The
 * camera decides when to cull; the vessel implementation decides what to hide.
 */
const cameras = new CameraSystem({
  setFigureVisible: (visible) => {
    activeVessel.setEmbodiedFigureVisible?.(visible);
  },
});

/**
 * The player's body, on the schooner's deck.
 *
 * The raft has no walk: it is 3 m of lashed logs with a seated castaway, and
 * its embodied camera is that figure's eye. The schooner is the vessel this
 * exists for — and until it did, `V` aboard her put the camera at the raft's
 * authored anchor, 0.905 m above the baseline, which on the schooner is three
 * metres below the deck and 1.4 m below the sea.
 */
const deckWalker = schooner ? new DeckWalker(SCHOONER_DECK_ENVIRONMENT) : undefined;
const vesselRuntime = new VesselRuntime({
  vessel: activeVessel,
  schooner,
  sailForces,
  sailingControls,
  sailingCrew,
  sailingCrewSensors,
  cameras,
  deckWalker,
  vesselFraming: activeVesselFraming,
  world,
  waves,
  wind,
  worldWind,
  lighting,
  ocean,
  speedTarget: vesselSpeedTarget,
  productionEncounterEnabled: !driftSailVessel,
  sailClothMode,
  initialTrueHeadingRad: INITIAL_TRUE_COURSE_RAD,
  input: () => input,
  captureContacts: () => wakePresentation.captureContacts(),
});
vesselRuntime.initializeDeckWalker();

// Direct review entry point for the alternate cutout. It puts the eye in the
// cabin where an uncut crest lies over the sole; normal controls remain live,
// and V still returns to the exterior without changing the selected technique.
if (deckWalker && interiorCabinViewEnabled) {
  vesselRuntime.placeCabinView(CABIN_SOLE_Y);
}

ocean.attachFoam(
  foam.nearTexture,
  foam.farTexture,
  foam.hullTexture,
  foam.nearOrigin,
  foam.farOrigin,
  foam.hullOrigin,
);
sky.setGpuProfiler(gpuProfiler);
// The prefix endpoints between the sky dome and the star draw. `endPass` is
// idempotent within a frame, so the sea can safely close a boundary a terrain
// tile has already closed — which is what keeps the rotation completing when
// no terrain is mounted at all (`?terrain=off`) and the terrain bucket then
// reads about zero instead of stalling every other bucket with it.
ocean.mesh.onBeforeRender = () => {
  gpuProfiler.endPass('sceneOpaque');
  if (terrainDrawsBeforeOcean) gpuProfiler.endPass('terrain');
  gpuProfiler.beginPass('ocean');
};
ocean.mesh.onAfterRender = () => gpuProfiler.endPass('ocean');
stars.mesh.onBeforeRender = () => {
  if (!terrainDrawsBeforeOcean) gpuProfiler.endPass('terrain');
  gpuProfiler.beginPass('stars');
};
stars.mesh.onAfterRender = () => gpuProfiler.endPass('stars');

scene.add(sky.mesh);
scene.add(stars.mesh);
scene.add(ocean.mesh);
scene.add(crestSpray.points);
for (const object of activeVessel.sceneObjects) scene.add(object);

/**
 * Silence every inline 1-LSB dither while the frame is aimed at a linear-HDR
 * buffer. There are exactly two surfaces that carry one — the sea and the sky
 * dome — and both write it past `colorspace_fragment`, which is the one place
 * three's render-target rule cannot reach. Anything added later that writes
 * past the encode belongs on this list, and the sweep in tests/scotopic.test.ts
 * is what will notice if it is not.
 */
const setInlineQuantisationDither = (enabled: boolean): void => {
  ocean.setQuantisationDither(enabled);
  sky.setQuantisationDither(enabled);
};

/**
 * The frame's display transform, and the observer looking through it.
 *
 * Built before the temporal resolve because the resolve hands it the resolved
 * colour rather than presenting on its own: whichever path draws the frame, the
 * tone curve, the scotopic operator and the dither are applied exactly once, in
 * one shader. See `render/ScenePresentPass.ts`.
 */
const scenePresent = new ScenePresentPass(renderer, {
  adaptationLuminance: () => lighting.retinalLuminance,
  setInlineQuantisationDither,
});

let oceanTemporalStability = 50;
let oceanTemporal: OceanTemporalResolve | undefined = initialOceanTemporalEnabled
  ? new OceanTemporalResolve(
      renderer,
      ocean,
      true,
      sky.mesh,
      [stars.mesh],
      scenePresent,
      setInlineQuantisationDither,
    )
  : undefined;

const wakePresentation = new WakePresentationController({
  contacts: activeVessel.body.contacts,
  overtopEvents: activeVessel.body.overtopEvents,
  waves,
  presentWind: worldWind,
  ocean,
  encounterVelocity: vesselRuntime.encounterVelocity,
  vesselHalfBeamM: activeVessel.halfBeamM,
  schooner,
});
vesselRuntime.initializeProductionHeading();
waves.setOrigin(0, 0);

/**
 * Whether the foam field carries its contents downwind.
 *
 * A diagnostic kill-switch rather than a setting. The advection pass resamples
 * the whole field through a bilinear fetch at a fractional texel offset twelve
 * times a second, which is exactly the shape of thing that can put a shimmer in
 * the far field where a screen pixel already covers many texels — so it needs
 * to be answerable by eye, in motion, which no still frame or pixel statistic
 * can do for it.
 */
let foamAdvectionEnabled = true;
const productionSurfaceTuning = {
  foamFrozen: false,
  foamStrength: 1,
  // Airborne salt loading as a multiple of SALT_DENSITY_FULL. The shipping
  // 0.25 was selected against the rough Southern Ocean; spray activity already
  // carries wind, authored intensity, and gust modulation.
  saltScale: 0.25,
};
const environment: EnvironmentRuntime = new EnvironmentRuntime({
  world,
  astronomy,
  astronomyFrame,
  worldRender,
  navigationTelemetry: vesselRuntime.navigationTelemetry,
  deriveNavigationTelemetry,
  wind,
  sky,
  stars,
  lighting,
  ocean,
  waves,
  renderer,
  scene,
  // These resources deliberately retain their established construction order.
  // The startup derivation below does not touch the late getters.
  get sunLight() {
    return sunLight;
  },
  get moonLight() {
    return moonLight;
  },
  get worldLighting() {
    return worldLighting;
  },
  lamp: activeVessel.lamp,
  vesselLighting: vesselRuntime.presentationContext,
  cameraPosition: () => cameras.camera.position,
  cameraFarM: () => cameras.camera.far,
  presentationElapsedSeconds: () => presentationClock.elapsedSeconds,
  graphicsTrims: () => runtimeUi.graphicsTrims,
  worldExposureBias: () => runtimeUi.worldExposureBias,
  interiorEyeAdaptation: () => schooner?.interiorEyeAdaptation() ?? 1,
  publishWorldSh: setWorldSh,
  initialDirectShadowing,
});

environment.deriveInitialLighting();
vesselRuntime.snapInitialSurfacePose();

// --- lights -----------------------------------------------------------------
// Directional and ambient lights consume the same real astronomical frame and
// atmospheric radiance as the visible sky and ocean reflection.
const sunLight = new THREE.DirectionalLight(0xffffff, 1);
// One directional depth map, containing the vessel and nothing else. The sea
// receives from it — real hull and rig cut the glitter lane — but does not cast
// into it; see SHADOW_VERTEX_SHADER in Ocean.ts for why a shadow map is the
// wrong instrument for a surface whose detail lives below its texel.
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
// Sized for the schooner, not the raft. The box was +/-4 m — a raft-shaped
// volume that clipped a 15.5 m hull at both ends, so the bulwark shaded the
// midships deck and nothing else, and she cast no shadow on her own quarters.
// +/-14 m covers her length with room for a heeled mast.
//
// The map doubles with the box so the texel footprint stays where it was:
// +/-4 m over 1024 texels is 7.8 mm, +/-14 m over 2048 is 13.7 mm. Not
// identical — nearly four times the area for twice the resolution never is —
// and the bias below is re-tuned for the coarser texel rather than left to
// produce acne on the deck planking.
const SUN_SHADOW_HALF_EXTENT = 14;
sunLight.shadow.camera.left = -SUN_SHADOW_HALF_EXTENT;
sunLight.shadow.camera.right = SUN_SHADOW_HALF_EXTENT;
sunLight.shadow.camera.top = SUN_SHADOW_HALF_EXTENT;
sunLight.shadow.camera.bottom = -SUN_SHADOW_HALF_EXTENT;
// Depth span is the one shadow-map dimension that costs no texels: the lateral
// extent above sets resolution, near/far only spend depth precision, and 24 bits
// over half a kilometre still resolves under a tenth of a millimetre. So the
// interval is sized by where the vessel's shadow LANDS rather than by how far
// the box may reasonably stretch. A 14 m mast under a 2-degree sun throws its
// shadow four hundred metres downwind; anything shorter truncates her shadow in
// exactly the sunset framing where it is most visible. 40 m ahead of her covers
// the hull itself with the sun near the zenith.
const SUN_SHADOW_LIGHT_DISTANCE = 600;
sunLight.shadow.camera.near = SUN_SHADOW_LIGHT_DISTANCE - 40;
sunLight.shadow.camera.far = SUN_SHADOW_LIGHT_DISTANCE + 440;
// `shadow.bias` is in normalised depth, so its world meaning scales with the
// interval above: keep the offset ~3 cm of real water, the value the deck
// planking was tuned against, rather than a constant that silently became a
// third of a metre when the span grew.
const SUN_SHADOW_DEPTH_RANGE =
  sunLight.shadow.camera.far - sunLight.shadow.camera.near;
sunLight.shadow.bias = -0.03 / SUN_SHADOW_DEPTH_RANGE;
/**
 * How much of the direct sun a shadow actually removes: all of it.
 *
 * This was 0.5 — a deliberate softening from the shadow round, standing in
 * for the short-range interreflection that did not exist then: a bulwark's
 * shadow on planking really is filled in by the lit deck a metre away. Both
 * halves of that missing bounce are real terms now — the deck's own
 * first-bounce field above (`deckLighting.ts`) and the room transfer below
 * (`interiorLight.ts`) — so the stand-in had to go, and not for tidiness:
 * BELOW DECKS a half-strength shadow means the hull only removes half the
 * sun, and every surface in a closed cabin whose normal tilted sunward was
 * lit straight through the planking. That was most of the "one wall black,
 * one wall lit" complaint this round was opened for.
 *
 * If the deck now reads harsh under swaying sail shadows, that is a real
 * above-deck retune to take on its own — Ash's call, 2026-08-12 — not a
 * reason to put the leak back.
 */
sunLight.shadow.intensity = 1.0;
// Only the vessel is in this map, and the vessel's geometry carries normals, so
// unlike the ocean receiver this offset is real work. Three's shadowmap_vertex
// chunk zeroes the normal offset unless the *geometry* has a `normal`
// attribute (`HAS_NORMAL`), which the ocean disc does not — do not tune this
// number expecting it to reach the water.
sunLight.shadow.normalBias = 0.03;
sunLight.shadow.radius = 1.5;
// The soft-shadow filter sizes itself in metres and spends the result in
// texels, so it needs the box and the map resolution in one number. Derived
// here from the camera actually in use, never restated as a literal.
ocean.setSunShadowTexelWorld(
  (sunLight.shadow.camera.right - sunLight.shadow.camera.left) /
    sunLight.shadow.mapSize.x,
);
scene.add(sunLight);
scene.add(sunLight.target);

environment.initializeDirectShadows();

const moonLight = new THREE.DirectionalLight(0x9fb6e0, 0);
scene.add(moonLight);
scene.add(moonLight.target);

/**
 * The world's indirect light: an L2 probe for diffuse, a PMREM for specular,
 * both convolutions of one camera-independent source.
 *
 * This replaces the two-colour `HemisphereLight` that used to stand in for the
 * whole sky. That light was a reasonable lie for a raft — a plank deck under an
 * open sky is nearly the only thing a hemisphere fill gets right — and it was
 * hopeless for a hull, which is read almost entirely through what it reflects.
 * A hemisphere fill has no reflection to give.
 *
 * `environmentIntensity` stays at three's default of 1 and is not a control.
 */
const worldLighting = new WorldLighting(renderer, sky.uniforms, sky.defines);
scene.environmentIntensity = 1;

// UI panel loaders and diagnostics are constructed before their shared facade.
// Bind it synchronously before any evidence host or animation callback starts.
const simHandleBinding = createSimHandleBinding();

// --- interface --------------------------------------------------------------
// The harness replaces the whole interface; the player-facing hint would only
// sit on top of the contact line we are trying to look at.
const hint = new Hint(hintElement, isTouch, {
  // The viewer keeps the global R drift command, but unlike the raft it does
  // not publish an object mast target. Do not advertise a tap with no object.
  driftSail: isTouch ? raftEnabled : driftSailVessel,
});
if (buoyancyLabEnabled) hint.hide();
const ambience = new Ambience();
// Built above so the input controller can bind mute and the first-gesture
// start; given the world here, now that there is a vessel and a camera to
// listen from. `hasInterior` is the schooner test rather than a walker test:
// the room lookup is module-level schooner geometry, so asking it about a
// point near the diagnostic raft would confidently answer "the cabin".
ambience.attachWorld({
  cameras,
  vessel: vesselRuntime,
  waves,
  hasInterior: schooner !== undefined,
});

/**
 * Rain, storm events and the optional in-world wind vector are consumers only.
 * The preset enters through `WeatherSystem`; every presentation wind sample is
 * read back from the already-published `WorldWind`, so no effect owns a second
 * direction, magnitude or gust clock.
 */
const weatherAnchor = new THREE.Vector3();
const weatherReviewDirection = new THREE.Vector3();
let terrainHazeHook: ((visibilityM: number) => void) | undefined;
let explicitTerrainHazeOverrideHook: (() => void) | undefined;
const weatherPresentation = new WeatherPresentation({
  worldWind,
  frameHeadingDeg: () => waves.frameHeading,
  cameraPosition: () => cameras.camera.position,
  anchorPosition: () => {
    const anchor = vesselRuntime.cameraAnchor;
    // The optional vector is a deck teaching aid, not a current arrow. Derive
    // the deck from the active buoyant body's measured freeboard so the same
    // placement works on both the schooner and the much smaller raft.
    return weatherAnchor.set(
      anchor.x,
      anchor.waterlineY + activeVessel.body.freeboard,
      anchor.z,
    );
  },
  vesselYawRad: () => vesselRuntime.cameraAnchor.yaw,
  vesselHalfBeamM: () => activeVessel.halfBeamM,
  vesselHalfLengthM: () => activeVessel.halfLengthM,
  reviewStrikeBearingRad: () => {
    cameras.camera.getWorldDirection(weatherReviewDirection);
    // Keep the deterministic review bolt inside the active view but just off
    // its centreline, where the schooner's masts and sails would hide it.
    return (
      Math.atan2(weatherReviewDirection.x, -weatherReviewDirection.z) +
      Math.PI / 12
    );
  },
  playThunder: (cue) => ambience.triggerThunder(cue.intensity, cue.distanceM),
  setCloudCoverThreshold: (threshold, discontinuous) => {
    sky.uniforms.uCloudCover.value = threshold;
    if (discontinuous) sky.requestCloudCacheRebase();
  },
  setVisibilityM: (visibilityM) => {
    ocean.setHazeDistanceM(visibilityM);
    terrainHazeHook?.(visibilityM);
  },
});
scene.add(weatherPresentation.group);

/**
 * What can be worked by hand, and the line that says so.
 *
 * The pick is done here rather than in `VesselRuntime` because it is a question
 * about *the player*, not about the vessel: where the eye is, where it points,
 * and what is inside arm's reach of it. The vessel supplies the boxes and knows
 * nothing about who is looking.
 */
/**
 * The body's seat, wherever aboard it is sitting or lying.
 *
 * Owned here for the same reason the reach pick is: it is a question about
 * *the player* — where their eye is and whether their feet are doing anything —
 * and the vessel only supplies the pose. See `SeatedStation` for why this is
 * not a third camera mode.
 *
 * **One `SeatedStation` for eleven places, not eleven of them.** A body is in
 * at most one station, so the controller is one object whose pose asks
 * `seatState.ts` which station that is. Eleven controllers would be eleven
 * things that could each be seated at once, all of them writing the same eye,
 * and the last one to `step` would win.
 *
 * `setOccupiedStation` runs before `sitDown`, and the order is load-bearing:
 * the pose closure reads the name, and the settle begins on the very frame the
 * chair is asked to draw itself out.
 */
const captainsSeat =
  schooner && deckWalker
    ? new SeatedStation(
        deckWalker,
        cameras,
        () => {
          const name = occupiedStation();
          if (!name) throw new Error('the seat was asked for a pose with nobody in it');
          return shipStation(name).pose();
        },
        (seated) => {
          if (!seated) {
            setOccupiedStation(null);
            // **Back to the deck's head model the moment the body is on its
            // feet.** The aloft model is the walking one plus a sway fraction,
            // and that fraction is derived against a 12.5 m lever; left in place
            // on a deck it would trim a half-metre motion the player is standing
            // in the middle of. One place restores it, because there is one
            // place a body stops being aloft.
            Object.assign(cameras.stabilisation, WALKING_STABILISATION);
            resetClimb();
          }
          schooner.syncSeat();
        },
      )
    : undefined;

/**
 * Which gang a station name means, or `null` for the eleven that are furniture.
 *
 * The name carries the side because `seatState.ts` holds a name and nothing
 * else — the same reason `lamp:` carries its room. Read back here rather than
 * kept in a second variable, which is the drift this ship has removed six times.
 */
function climbSideOf(name: StationName | null): ClimbSide | null {
  if (name === 'climbPort') return 1;
  if (name === 'climbStarboard') return -1;
  return null;
}

/** Take a station, or leave it if the body is already in that one. */
function useStation(name: StationName): void {
  if (!captainsSeat) return;
  if (captainsSeat.isSeated) {
    // **Every station, not just this one.** You get out of a bunk before you
    // sit at a table: hopping from one seated pose straight into another would
    // cut the camera across the ship with the body still standing where it
    // was, and the reach pick is dead while seated anyway, so the only way to
    // ask for a second station is through the action bar's own "Stand up".
    leaveStation();
    return;
  }
  setOccupiedStation(name);
  resetClimb();
  const side = climbSideOf(name);
  if (side !== null) Object.assign(cameras.stabilisation, ALOFT_STABILISATION);
  captainsSeat.sitDown();
}

/**
 * Get out of whatever the body is in.
 *
 * Eleven of the twelve stations release at once, because the body never moved
 * and the eye has 0.6 m to travel back. The two climbs cannot: the body is on
 * the deck and the eye is nine metres up, so letting go would drop the camera
 * down the mast in half a second. Space aloft starts the descent instead and
 * `stepAloft` releases the station when the body reaches the foot — one button
 * that always works, and the whole way down visible.
 */
function leaveStation(): void {
  if (!captainsSeat) return;
  const side = climbSideOf(occupiedStation());
  if (side !== null && !isAtTheFoot(side)) {
    beginLayingDown();
    return;
  }
  captainsSeat.standUp();
}

/**
 * One frame of being aloft, run before the seat writes the eye.
 *
 * The walker's own movement axes drive it, so W climbs and S comes down with no
 * second binding to learn — the same arrangement the fore scuttle's ladder uses.
 * Ordering matters and is the reason this is a wrapper rather than a separate
 * callback: `advanceClimb` moves the progress, `SeatedStation.step` then asks
 * the station for a pose built from it, so the eye is never a frame behind the
 * body's own position on the ladder.
 */
/**
 * Walking entry is edge-like even though movement input is held state.
 *
 * After stepping off at the foot, the same held descent key can still point
 * toward the shrouds in deck coordinates while the camera eases back to the
 * body. Requiring a release before another automatic entry prevents that one
 * continuous gesture from taking the climb again. A fresh walk re-arms it.
 */
let climbWalkEntryArmed = true;

function stepAloft(dt: number, axes: { forward: number; right: number }): void {
  if (!captainsSeat) return;
  const moving = Math.hypot(axes.forward, axes.right) > 0.15;
  if (!moving) climbWalkEntryArmed = true;

  // The walker has already taken this frame's deck step. If that step carried
  // the body into a gang, take its ordinary station row now: the same settle,
  // state and camera path as Space, with no parallel climb mechanism.
  if (!captainsSeat.isSeated && !captainsSeat.isSettling && climbWalkEntryArmed) {
    const walkedInto = climbWalkEntry(
      { x: deckWalker!.x, y: deckWalker!.eyeY(), z: deckWalker!.z },
      axes,
      cameras.embodied.yaw,
    );
    if (walkedInto) {
      climbWalkEntryArmed = false;
      useStation(walkedInto);
    }
  }

  const side = climbSideOf(occupiedStation());
  if (side !== null && captainsSeat.isSeated && !captainsSeat.isSettling) {
    const laidDown = advanceClimb(side, dt, axes.forward);
    // Holding the down/back walk through the final rung is itself the step off
    // the ladder. Space remains the hands-free lay-down route; neither is the
    // only door out any more.
    if (laidDown || shouldWalkOffClimb(side, axes.forward)) {
      climbWalkEntryArmed = false;
      captainsSeat.standUp();
    }
  }
  captainsSeat.step(dt);
}

if (captainsSeat) vesselRuntime.attachSeat({ step: stepAloft });

// Direct review entry point for the desk. `?interiorView=desk` opens seated at
// it — the composition is fixed, so walking aft and down the companionway for
// every screenshot of it was a tax on looking at the thing at all. Normal
// controls stay live: standing up leaves you in the cabin on your feet, and V
// still returns to the exterior.
if (captainsSeat && deckWalker && interiorDeskViewEnabled) {
  setOccupiedStation('deskChair');
  const pose = shipStation('deskChair').pose();
  deckWalker.placeAt(pose.x - 0.55, pose.z, CABIN_SOLE_Y);
  cameras.setDiagnosticMode('embodied');
  captainsSeat.snapToSeat();
}

// The same door for the masthead. `?interiorView=lookout` opens standing on the
// fore top, with the body left on the deck at the foot of the gang exactly where
// climbing would have left it — so Space starts an honest descent and arrives
// somewhere a player can walk away from, rather than dropping them out of the
// sky at the mast.
if (captainsSeat && deckWalker && schooner && aloftViewEnabled) {
  const side: ClimbSide = -1;
  const foot = climbAnchors(side)[0].hold;
  deckWalker.placeAt(foot.x, foot.z);
  setOccupiedStation(side > 0 ? 'climbPort' : 'climbStarboard');
  setClimbProgress(1);
  Object.assign(cameras.stabilisation, ALOFT_STABILISATION);
  cameras.setDiagnosticMode('embodied');
  captainsSeat.snapToSeat();
}

const interactables = schooner
  ? buildShipInteractables({
      lamps: {
        isLit: (room) => schooner.isLampWantedLit(room),
        toggle: (room) => schooner.toggleLamp(room),
      },
      stations: captainsSeat ? { use: useStation } : undefined,
    })
  : undefined;
const actionBar = new ActionBar(document.body, isTouch);
const reachDirection = new THREE.Vector3();

/**
 * The desk's own interaction: a cursor, a name under it, and a thing that opens.
 *
 * Owned here beside the reach pick and for the same reason — it is a question
 * about the player, not about the vessel. The vessel supplies the boxes; who is
 * pointing at them is this file's business.
 *
 * The targets are rebuilt each pick rather than cached because `deskItems()` is
 * a handful of boxes derived from the desk's own geometry, and the alternative
 * is a cached list that goes stale the first time an item moves — which is the
 * fault this whole round has been avoiding one table at a time.
 */
const deskFocus = new DeskFocus(document.body, {
  // **Closures over the live records, not a snapshot.** The chronometer's only
  // claim is that it keeps the same time as the sun over the ship; handing it
  // copies taken at construction would give a dial that was right once, on the
  // first frame, and then quietly wrong for the rest of the voyage.
  chronometer: () => ({
    utcSeconds: world.state.worldInstantUtcSeconds,
    longitudeRad: vesselRuntime.navigationTelemetry.longitudeRad,
  }),
  // The same closure discipline, and here it is a stated gate rather than a
  // preference: WX1 requires the barometer's reading and the committed weather
  // series to be one number at the same instant, which they are because
  // `barometerReadingOf` is the only place either of them is derived.
  barometer: () => weather.barometer,
});
const deskPointer = new DeskPointer();
const deskHoverLabel = document.createElement('div');
deskHoverLabel.className = 'deskhover';
document.body.appendChild(deskHoverLabel);

function deskTargets() {
  const targets = deskItems().map((item) => ({
    box: item.box,
    value: { label: item.label, view: item.view },
  }));
  // The glass is not on the desk — it is screwed to the lining forward of the
  // chart rack — but it is read from the chair with the same cursor and opens
  // into the same overlay, so it joins the same pick list. A second mechanism
  // for one object would be a second mechanism to keep in step.
  const glass = cabinBarometerTarget();
  targets.push({ box: glass.box, value: { label: glass.label, view: glass.view } });
  return targets;
}

/** What the cursor is over, on the desk — or `null`. Seated only. */
function deskItemAt(clientX: number, clientY: number) {
  if (
    !canUseDeskPointer({
      seated: captainsSeat?.isSeated === true,
      atDesk: occupiedStation() === 'deskChair',
      embodied: cameras.modeName === 'embodied',
    }) ||
    !schooner
  ) return null;
  return deskPointer.pick(
    clientX,
    clientY,
    canvas,
    cameras.camera,
    activeVessel.group.matrixWorld,
    deskTargets(),
    REACH,
  );
}

function showDeskHover(clientX: number, clientY: number): void {
  // No hover while something is open: the page is over the desk, and a label
  // naming the thing you are already reading is a label for a state the player
  // has left.
  const item = deskFocus.openView === null ? deskItemAt(clientX, clientY) : null;
  if (!item) {
    deskHoverLabel.classList.remove('deskhover--visible');
    return;
  }
  if (deskHoverLabel.textContent !== item.label) deskHoverLabel.textContent = item.label;
  deskHoverLabel.style.left = `${clientX}px`;
  deskHoverLabel.style.top = `${clientY}px`;
  deskHoverLabel.classList.add('deskhover--visible');
}

/** A click on the desk. Returns whether it was consumed — see `onSelect`. */
function selectOnDesk(clientX: number, clientY: number): boolean {
  if (deskFocus.openView !== null) return false;
  const item = deskItemAt(clientX, clientY);
  if (!item) return false;
  deskFocus.open(item.view);
  deskHoverLabel.classList.remove('deskhover--visible');
  return true;
}

function reachHit(): ReachHit | null {
  if (!interactables || !deckWalker || cameras.modeName !== 'embodied') return null;
  // Nothing is within reach of a seated player, and that is deliberate rather
  // than a gap. Sitting is its own view with its own way of choosing things —
  // the pointer, not the crosshair — and leaving the standing pick live would
  // offer "Lift the boards" to somebody at a desk two rooms away from them,
  // scored off an eye that is no longer where their body is.
  if (captainsSeat?.isSeated) return null;
  // Ship-local, both of them: the boxes are ship-local and the walker already
  // is, so the pick never has to leave the hull's own frame. The camera looks
  // down its own -Z, which is the convention `DeckWalker.step` also reads.
  const { yaw, pitch } = { yaw: cameras.embodied.yaw, pitch: cameras.embodied.pitch };
  reachDirection.set(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
  return interactables.pick(
    { x: deckWalker.x, y: deckWalker.eyeY(), z: deckWalker.z },
    reachDirection,
  );
}

/**
 * Everything the player could do this frame, most important first.
 *
 * **One list, and both the bar and the key read it.** The alternative — the bar
 * showing what the pick found while Space asked the pick again — is how the
 * chair became a trap the first time it worked: seated, the reach pick is
 * deliberately dead, so Space did nothing and there was no way to stand up. An
 * action the player can see and an action the key performs have to be the same
 * object, not two derivations that happen to agree in the cases anyone tested.
 */
function currentActions(): PlayerAction[] {
  // **Innermost first, always.** Space is "back out one level", so with the
  // book open it shuts the book and only then does it get you out of the chair.
  // Standing up with a page over the screen would be a state the player cannot
  // see they are in.
  if (deskFocus.openView !== null) {
    return [
      {
        id: 'closeItem',
        label: deskFocus.closeLabel,
        key: 'Space',
        perform: () => deskFocus.close(),
      },
    ];
  }
  if (captainsSeat?.isSeated) {
    // The label is the station's own, not a constant: a body in a bunk turns
    // out and a body at a table stands up, and the bar is the only place either
    // is ever read — the reach pick is dead while seated, so the row's occupied
    // verb has no other way to reach the screen.
    const station = occupiedStation();
    return [
      {
        id: 'stand',
        label: station ? shipStation(station).verb(true) : 'Stand up',
        key: 'Space',
        // **Leaving a climb is a descent, not a release**, and `leaveStation`
        // is where that fork lives so the bar cannot learn one of the two.
        perform: () => leaveStation(),
      },
    ];
  }
  const hit = reachHit();
  if (!hit) return [];
  return [
    {
      id: hit.interactable.name,
      label: hit.interactable.verb(hit.on),
      key: 'Space',
      perform: () => {
        // One call, not two. The row writes through to whichever module owns
        // that piece of state — `closures.ts` for a hatch, `seatState.ts` for
        // the chair — which is the single copy the geometry and the walker's
        // floor query both read. Flipping a local copy here as well is how the
        // prompt and the ship came to disagree about whether a hatch was open.
        hit.interactable.activate();
        schooner?.syncClosures();
      },
    },
  ];
}

function useWhatIsInReach(): void {
  // The first action is what the key does, always. A second action exists only
  // where there is a second control to press it with.
  currentActions()[0]?.perform();
}

const input = new InputController(canvas, cameras, {
  // Bound only where there is a drift sail to raise. On the schooner R used to
  // be a key that moved nothing but a debug string; now it is not a key.
  onToggleSail: driftSailVessel ? () => wind.toggleSail() : undefined,
  onTapSail: raftEnabled ? () => wind.toggleSail() : undefined,
  onToggleMute: () => ambience.toggleMute(),
  onFirstInteraction: () => ambience.start(),
  onUse: useWhatIsInReach,
  onSelect: selectOnDesk,
  touchWalkingEnabled: deckWalker !== undefined,
});

// Hover is desktop-only by construction rather than by a platform check: a
// touch device produces no pointer movement without a press, so this simply
// never fires there — which is the right behaviour, because a tap on a phone
// opens the thing rather than naming it.
lifecycle.listen(window, 'pointermove', (event) => {
  const pointer = event as PointerEvent;
  if (pointer.pointerType === 'touch') return;
  showDeskHover(pointer.clientX, pointer.clientY);
});

// Escape is the other way out of an open page, and it is the one a player
// reaches for without being told. It is deliberately not bound to standing up:
// a key that sometimes shuts a book and sometimes moves your body is a key
// nobody trusts.
lifecycle.listen(window, 'keydown', (event) => {
  if ((event as KeyboardEvent).key !== 'Escape') return;
  if (deskFocus.openView === null) return;
  deskFocus.close();
});

// The inspector is a development surface, but it is created before RuntimeUi
// so the debug menu can arm it. Its capture listener runs in the capture phase
// and consumes only the single click explicitly requested by the investigator.
const browserDiagnostics = import.meta.env.DEV
  ? new BrowserDiagnosticsBridge({
      document,
      canvas,
      camera: cameras.camera,
      scene,
      vessel: activeVessel.group,
      walker: deckWalker,
    })
  : undefined;

const runtimeUi: RuntimeUi = new RuntimeUi({
  labEnabled: buoyancyLabEnabled,
  debugUiEnabled,
  world: {
    world,
    astronomy,
    waves,
    motionControls: vesselRuntime.motionControls,
    openingResolution: globalOpeningResolution,
    telemetry: (): RuntimeUiWorldTelemetry => ({
      fps: browserFrameDriver.reading.cadence.fps,
      exposure: renderer.toneMappingExposure,
      astronomyFrame,
      // Null on the schooner: she has no drift sail, so the readout is
      // permanently "down" and says nothing. `driftSailVessel` is the same
      // discriminator that decides whether the toggle is bound at all.
      sailUp: driftSailVessel ? wind.sailRaised : null,
      wind: vesselRuntime.buildWindTelemetry(),
      sails: vesselRuntime.buildSailTelemetry(),
    }),
    requestCloudCacheRebase: () => sky.requestCloudCacheRebase(),
  },
  sailing:
    schooner && sailingControls && sailForces
      ? {
          controls: sailingControls,
          crew: sailingCrew,
          read: vesselRuntime.buildSailingPanelState,
        }
      : undefined,
  cameras,
  ambience,
  terrain: runtimeOptions.terrainMode === 'synthetic'
    ? { handlePromise: () => terrainHandlePromise }
    : undefined,
  voyage: { control: voyageClock },
  weather: {
    system: weather,
    seaWind: () => seaStates.state.generatingWind,
    coupling: windSeaCoupling,
    presentation: weatherPresentation,
  },
  deck: deckWalker
    ? { walker: deckWalker, shipGroup: activeVessel.group }
    : undefined,
  inspection: browserDiagnostics,
  getSimHandle: simHandleBinding.get,
  stats: {
    renderer,
    canvas,
    nativePixelRatio: () => window.devicePixelRatio || 1,
    cpuProfiler,
    gpuProfiler,
    quality,
    cloudDome: sky.cloudDome,
    radianceLut: sky.radianceLut,
    ocean,
    waves,
  },
});

// --- resize -----------------------------------------------------------------
const browserViewport = new BrowserViewport(window, renderer, cameras);
browserViewport.resize();
lifecycle.listen(window, 'resize', browserViewport.scheduleResize);
lifecycle.listen(window, 'orientationchange', browserViewport.scheduleResize);

// --- simulation -------------------------------------------------------------
const productionSimulation: ProductionSimulationRuntime =
  new ProductionSimulationRuntime({
    world: {
      presentationClock,
      wind,
      world,
      worldWind,
      seaStates,
      waves,
      weather,
      windSea: windSeaCoupling,
    },
    presentation: {
      vessel: vesselRuntime,
      wake: wakePresentation,
      environment,
      cameras,
      ambience,
      weather: weatherPresentation,
      ...(runtimeOptions.terrainMode === 'synthetic' && params.has('haze')
        ? {
            // A named capture/motion review owns its explicit terrain haze.
            // Weather has already derived this frame; ordinary sessions omit
            // this port and keep weather visibility exactly as before.
            applyExplicitTerrainHazeOverride: () =>
              explicitTerrainHazeOverrideHook?.(),
          }
        : {}),
    },
    surface: {
      renderer,
      foam,
      crestSpray,
      ocean,
      lighting,
      tuning: productionSurfaceTuning,
    },
    profilers: {
      cpu: cpuProfiler,
      gpu: gpuProfiler,
    },
  });

/**
 * Set by the terrain mount (default-on production land, TERR-103). Runs at
 * render time so every path that draws — the frame loop and the capture
 * harnesses' direct renderFrame calls alike — sees current tile matrices.
 * Terrain orchestration itself lives in src/terrain/TerrainSystem.ts, not
 * here.
 */
let terrainRenderHook: (() => void) | undefined;
let terrainNearestLandM: (() => number) | undefined;
let terrainDisposeHook: (() => void) | undefined;
let terrainMountDisposed = false;
let terrainHandlePromise:
  | Promise<
      | import('./terrain/syntheticTerrainHarness').SyntheticTerrainHandle
      | undefined
    >
  | undefined;

/**
 * Feed the voyage clock after the terrain hook has refreshed its state.
 * Presentation elapsed time is the delta source, so capture harnesses that
 * re-render a frozen world advance nothing.
 */
let voyageClockElapsedSeconds = presentationClock.elapsedSeconds;
const voyageClockHook = (): void => {
  const elapsed = presentationClock.elapsedSeconds;
  const realDeltaSeconds = Math.max(0, elapsed - voyageClockElapsedSeconds);
  voyageClockElapsedSeconds = elapsed;
  const velocity = world.state.velocityEcefMps;
  voyageClock.update(realDeltaSeconds, {
    nearestLandM: terrainNearestLandM?.(),
    speedOverGroundMps: Math.hypot(velocity.x, velocity.y, velocity.z),
  });
};

/**
 * Whether the frame is a picture or a measurement.
 *
 * A debug view, a category probe or a term view writes a computed quantity
 * straight to the framebuffer, deliberately past the tone curve, so that the
 * readback receives the number the shader produced rather than a photograph of
 * it. Nothing that re-photographs the frame may run over one of those — not the
 * temporal resolve, and not the scotopic present.
 */
function framePresentationCompatible(): boolean {
  return (
    !diagnosticExecution.active &&
    ocean.debugView === 0 &&
    ocean.residualCategoryMode === 'off' &&
    ocean.detailCategoryMode === 'off' &&
    // For the same reason the ocean's own debug view is excluded: a term
    // view is a measurement, and a measurement blended with the last seven
    // frames of a different measurement is not one.
    !isWorldDebugViewActive()
  );
}

let presentAdaptationElapsedSeconds = presentationClock.elapsedSeconds;

const renderPipeline = new RenderPipeline({
  beginSubmission: () => cpuProfiler.beginPass('renderSubmission'),
  prepareFrame: () => {
    terrainRenderHook?.();
    voyageClockHook();
    const elapsed = presentationClock.elapsedSeconds;
    const delta = Math.max(0, elapsed - presentAdaptationElapsedSeconds);
    presentAdaptationElapsedSeconds = elapsed;
    scenePresent.update(delta, framePresentationCompatible());
  },
  shouldUseTemporalResolve: () => {
    // The common (TAA-off) path is the original render call: no temporal object,
    // jitter, metadata draw, framebuffer copy or resolve participates at all.
    return oceanTemporal?.enabled === true && framePresentationCompatible();
  },
  renderTemporal: () => oceanTemporal?.render(scene, cameras.camera),
  prepareDirectRender: () => ocean.setTemporalDetailJitter(0, 0),
  // The pass declines whenever the observer model would do nothing, and the
  // frame then takes the original call, unchanged. That is what makes daylight
  // identical rather than merely close — it is the same code path it always was.
  renderDirect: () => {
    if (!scenePresent.render(scene, cameras.camera)) {
      renderer.render(scene, cameras.camera);
    }
  },
  endSubmission: () => cpuProfiler.endPass('renderSubmission'),
});

function renderFrame(): void {
  renderPipeline.render();
}

// --- loop -------------------------------------------------------------------
const initialFrameClockMilliseconds = performance.now();
/** Freezes normal-loop time while counterfactual diagnostic shaders run. */
const diagnosticExecution = createDiagnosticExecutionGate();

const browserFrameDriver: BrowserFrameDriver = new BrowserFrameDriver({
  initialNowMilliseconds: initialFrameClockMilliseconds,
  nowMilliseconds: () => performance.now(),
  documentHidden: () => document.hidden,
  pollViewport: browserViewport.poll,
  cpuProfiler,
  gpuProfiler,
  execution: diagnosticExecution,
  stepSimulation: productionSimulation.step,
  renderFrame,
  cloudCacheSwapped: () => sky.cloudDome.reading.swapped,
  serviceFrameReadback: () => runtimeDiagnostics.serviceFrameReadback(),
  captureIfRequested: import.meta.env.DEV
    ? () => runtimeDiagnostics.captureIfRequested()
    : undefined,
  fixedPixelRatio,
  adaptivePixelRatioTarget,
  initialPixelRatioCap,
  applyPixelRatio,
  afterFrame: (reading) => {
    browserDiagnostics?.publish();
    runtimeUi.update(reading);
    deskFocus.tick();
    actionBar.show(currentActions());
  },
});

// A background tab has no meaningful presentation cadence. The first visible
// callback establishes a new baseline; only the following interval is sampled.
lifecycle.listen(
  document,
  'visibilitychange',
  browserFrameDriver.resetCadence,
);

function nextPresentedFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitPresentedFrames(count: number): Promise<void> {
  for (let frameIndex = 0; frameIndex < count; frameIndex++) {
    await nextPresentedFrame();
  }
}

const runtimeDiagnostics = createRuntimeDiagnostics({
  execution: diagnosticExecution,
  renderer,
  canvas,
  gpuProfiler,
  ocean,
  sky,
  waves,
  foam,
  world,
  seaStates,
  cameras,
  lighting,
  quality,
  nextPresentedFrame,
  waitPresentedFrames,
  foamFreeze: {
    get value() {
      return productionSurfaceTuning.foamFrozen;
    },
    set value(value) {
      productionSurfaceTuning.foamFrozen = value;
    },
  },
  wakeState: wakePresentation,
  shadowing: {
    snapshot: environment.shadowingState,
    setBenchmarkSunMode: environment.setBenchmarkSunShadowMode,
    setSunShadowing: environment.setSunShadowing,
    setLanternShadowing: environment.setLanternShadowing,
  },
  // Visual-evidence modules need the complete public facade, but only after a
  // user starts one of their dynamically imported commands.
  getSimHandle: simHandleBinding.get,
  capturePort,
});

/**
 * Everything the diagnostic harness is allowed to touch. Exposing one explicit
 * surface keeps the harness from reaching into module internals, and keeps the
 * production path readable.
 */
const sim: SimHandle = simHandleBinding.bind(
  createSimHandle(
    {
      renderer,
      scene,
      canvas,
      cameras,
      vessel: activeVessel,
      ocean,
      waves,
      wind,
      world,
      sky,
      stars,
      lighting,
      foam,
      crestSpray,
      wakeSources: wakePresentation.wakeSources,
      seaStates,
      worldWind,
      onSeaStateChosen: adoptChosenSeaState,
    },
    {
      stepSimulation: productionSimulation.step,
      renderFrame,
      get elapsedSeconds() {
        return presentationClock.elapsedSeconds;
      },
      setElapsedSeconds(elapsedSeconds) {
        presentationClock.setElapsedSeconds(elapsedSeconds);
        // Both latches below turn this clock into a per-frame delta by
        // subtracting what they last saw. Rewinding the clock without
        // rewinding them leaves them in the future, `Math.max(0, ...)` pins
        // the delta at zero, and the voyage clock and the rod's adaptation
        // simply stop integrating until the clock climbs back past them —
        // silently, because zero is a legal delta.
        voyageClockElapsedSeconds = elapsedSeconds;
        presentAdaptationElapsedSeconds = elapsedSeconds;
      },
      resetHorizontalMotion: vesselRuntime.resetHorizontalMotion,
    },
    {
      worldLighting,
      encounterVelocity: vesselRuntime.encounterVelocity,
      sunShadow: sunLight.shadow,
      foamLookup,
      refreshLighting: environment.refreshLighting,
      refreshWorldLighting: environment.refreshWorldLighting,
      // Everything the frame loop integrates by hand, in one call. Three eye
      // meters — each a low pass over the whole session with no way back — and
      // the wind's gust clock. They live in four different objects, so this is
      // the only place that can rewind all of them together.
      resetIntegrators() {
        lighting.resetAdaptation();
        scenePresent.resetAdaptation();
        schooner?.resetEyeAdaptation();
        worldWind.reset();
        weatherPresentation.reset(presentationClock.elapsedSeconds);
      },
      setSunShadowing: environment.setSunShadowing,
      setLanternShadowing: environment.setLanternShadowing,
      shadowingState: environment.shadowingState,
      get exposureBias() {
        return environment.exposureBias;
      },
      set exposureBias(value) {
        environment.exposureBias = value;
      },
      get foamFrozen() {
        return productionSurfaceTuning.foamFrozen;
      },
      set foamFrozen(value) {
        productionSurfaceTuning.foamFrozen = value;
      },
      get foamAdvectionEnabled() {
        return foamAdvectionEnabled;
      },
      set foamAdvectionEnabled(value) {
        foamAdvectionEnabled = value;
      },
      get foamStrength() {
        return productionSurfaceTuning.foamStrength;
      },
      set foamStrength(value) {
        productionSurfaceTuning.foamStrength = value;
      },
      get foamLookupLegacy() {
        return foamLookupLegacy;
      },
      set foamLookupLegacy(value) {
        foamLookupLegacy = value;
      },
      get saltScale() {
        return productionSurfaceTuning.saltScale;
      },
      set saltScale(value) {
        productionSurfaceTuning.saltScale = value;
      },
      get oceanTemporal() {
        return oceanTemporal;
      },
      set oceanTemporal(value) {
        oceanTemporal = value;
      },
      get oceanTemporalStability() {
        return oceanTemporalStability;
      },
      set oceanTemporalStability(value) {
        oceanTemporalStability = value;
      },
    },
    {
      presentation: wakePresentation,
      speedTarget: vesselSpeedTarget,
      motionControls: vesselRuntime.motionControls,
      prescribeVesselSpeedMps: vesselRuntime.prescribeVesselSpeedMps,
      sailClothMode: () => vesselRuntime.sailClothMode,
      poseOnTrueWindAngleDeg: vesselRuntime.poseOnTrueWindAngleDeg,
      get diagnosticTowLeewayRad() {
        return vesselRuntime.diagnosticTowLeewayRad;
      },
      set diagnosticTowLeewayRad(value) {
        vesselRuntime.diagnosticTowLeewayRad = value;
      },
    },
    runtimeDiagnostics,
  ),
);

startPerformanceEvidenceHosts({
  params,
  sim,
  schooner,
  deckWalker,
  cabinSoleY: CABIN_SOLE_Y,
  setInteriorCutoutMode,
  waitPresentedFrames,
  runWhitewaterCostBenchmark: runtimeDiagnostics.runWhitewaterCostBenchmark,
  runPairedToggleBenchmark: runtimeDiagnostics.runPairedToggleBenchmark,
  runWakeTrailCostBenchmark: runtimeDiagnostics.runWakeTrailCostBenchmark,
  runWakeBowCostBenchmark: runtimeDiagnostics.runWakeBowCostBenchmark,
  runDirectShadowBenchmark: runtimeDiagnostics.runDirectShadowBenchmark,
});

// The deterministic-view host: URL-named conditions and camera pose, plus the
// analytical surface probe on `window.__driftInspect`. This is the agent-facing
// half of the inspection tooling; `tools/inspect-view.mjs` is the CLI over it.
startInspectionHost({
  params,
  sim,
  astronomy,
  deckWalker,
  schooner,
  sunLight,
  requestCloudCacheRebase: () => sky.requestCloudCacheRebase(),
  waitPresentedFrames,
});

/**
 * Terrain selection stays outside the frame loop. `?terrain=global` mounts
 * the coarse whole-world provider and follows canonical position, including a
 * WorldPanel teleport. The shipping default remains TERR-103's synthetic
 * headland. Explicit global bootstrap has already published and consumed its
 * water-aware opening resolution; `?terrain=off` restores the empty-ocean
 * baseline.
 * `GlobalTerrainHandle.update` refreshes both resident tiles and its
 * nearest-coast sample from this same canonical state before the voyage-clock
 * hook consumes that distance.
 */
if (runtimeOptions.syntheticTerrainEnabled) {
  if (runtimeOptions.terrainMode === 'global') {
    void (async () => {
      try {
        const { mountGlobalTerrain } = await import(
          './terrain/globalTerrainRuntime'
        );
        if (terrainMountDisposed) return;
        const handle = mountGlobalTerrain({
          scene,
          adapter: worldRender,
          state: world.state,
          skyRadianceLut: sky.radianceLut.texture,
          profiler: gpuProfiler,
        });
        handle.system.setHazeDistance(weather.state.visibilityM);
        terrainHazeHook = (visibilityM) =>
          handle.system.setHazeDistance(visibilityM);
        terrainRenderHook = () => handle.update(world.state);
        terrainNearestLandM = () => handle.getNearestLandM();
        terrainDisposeHook = () => handle.dispose();
      } catch (error) {
        console.error('[terrain] global coarse mount failed', error);
      }
    })();
  } else {
    terrainHandlePromise = (async () => {
      try {
        const { mountSyntheticTerrain } = await import(
          './terrain/syntheticTerrainHarness'
        );
        if (terrainMountDisposed) return undefined;
        const handle = mountSyntheticTerrain(params, {
          scene,
          adapter: worldRender,
          state: world.state,
          cameras,
          skyRadianceLut: sky.radianceLut.texture,
          profiler: gpuProfiler,
        });
        // Preserve the harness parser's clamped value before ordinary weather
        // visibility is applied. Only an explicit synthetic `?haze=` installs
        // the post-environment capture/diagnostic precedence hook.
        const explicitHazeDistanceM = handle.system.hazeDistanceM;
        handle.system.setHazeDistance(weather.state.visibilityM);
        terrainHazeHook = (visibilityM) =>
          handle.system.setHazeDistance(visibilityM);
        if (params.has('haze')) {
          explicitTerrainHazeOverrideHook = () =>
            handle.system.setHazeDistance(explicitHazeDistanceM);
        }
        terrainRenderHook = () => handle.update(world.state);
        terrainNearestLandM = () => handle.getNearestLandM();
        terrainDisposeHook = () => handle.system.dispose();
        return handle;
      } catch (error) {
        console.error('[terrain] synthetic mount failed', error);
        return undefined;
      }
    })();
  }
}

startTerrainAndViewerEvidenceHosts({
  params,
  sim,
  gpuProfiler,
  requestedDepthMode,
  terrainHandlePromise,
  schoonerViewerEnabled,
  schooner,
  waitPresentedFrames,
  nextPresentedFrame,
});

if (buoyancyLabEnabled) {
  // Code-split: none of this exists in the production bundle's entry chunk, and
  // it cannot run without the query parameter.
  renderer.setAnimationLoop(null);
  void import('./debug/BuoyancyLab').then(({ startBuoyancyLab }) =>
    startBuoyancyLab(sim),
  );
} else {
  renderer.setAnimationLoop(browserFrameDriver.frame);

  // Deep links open the same panels the launcher does, in the same shell. They
  // exist for bookmarks, automated capture and test harnesses — not as a second
  // way of building the UI.
  runtimeUi.openDeepLink(debugMode);
}

if (captureHostEnabled) {
  // The deterministic capture session: `window.__driftCapture`, tier assertion
  // and interleaved A/B sheets. Code-split like the labs, and started AFTER
  // the loop is attached above so detaching it means something.
  void import('./debug/captureHost').then(({ startCaptureHost }) =>
    startCaptureHost({
      params,
      sim,
      tier: runtimeQuality.tier,
      // `BrowserFrameDriver` skips the adaptive-resolution policy entirely
      // when a fixed ratio was asked for; without one the walk can move the
      // framebuffer between two frames of a comparison.
      adaptiveResolutionPinned: fixedPixelRatio !== undefined,
      deckWalker,
      snapEyeAdaptation: () => schooner?.snapEyeAdaptation(),
      stopAnimationLoop: () => renderer.setAnimationLoop(null),
      waitPresentedFrames,
    }),
  );
}

if (import.meta.env.DEV) {
  // Freshness stamp: answers "am I running the latest code?" at a glance
  // after any HMR ambiguity. The time is when this module was (re)loaded.
  console.info(
    `%c[drift] code loaded ${new Date().toLocaleTimeString()}`,
    'color:#7fc97f',
  );
  (window as unknown as Record<string, unknown>).__drift = {
    THREE,
    // The app's OWN colour-pipeline module instance. A harness that reaches for
    // it with its own dynamic import can get a second copy of the module —
    // Vite will serve './colourPipeline' and '/src/scene/colourPipeline.ts' as
    // distinct records — and then flips a flag nothing is reading.
    colourPipeline,
    renderer,
    scene,
    cameras,
    // The player's own body and the chair it can be sitting in. Both are the
    // app's real instances, for the reason the note above `colourPipeline`
    // gives: a harness that imports them itself gets a second copy and then
    // reads a seat nobody is sitting in.
    captainsSeat,
    currentActions,
    world,
    astronomy,
    astronomyFrame,
    worldRender,
    presentationClock,
    lighting,
    wind,
    waves,
    ocean,
    vessel: activeVessel,
    sky,
    stars,
    input,
    sim,
    worldLighting,
    // The body itself, so the interior can be inspected from the console.
    // Every below-decks fault this round has been found by putting the eye
    // somewhere specific and raycasting what it sees, and the panel's station
    // buttons only reach the places someone thought to name.
    deckWalker,
    // The interior lighting A/B, live and same-frame: 1 is the portal model,
    // 0 restores the legacy constant (and relights the companion spot with
    // it). A lighting verdict is only valid under the transform it was taken
    // through, so judge by flipping this, never by reloading.
    setPortalLightMix,
    getPortalLightMix,
    // The term views, from the console: which term owns a pixel is the first
    // question of every lighting fault, and importing the module dynamically
    // gets a second Vite copy whose switch nothing reads.
    setWorldDebugView,
    // And the culling switch: false draws the interior unconditionally, for
    // separating "lit wrong" from "not drawn".
    setInteriorCullingEnabled: (enabled: boolean) =>
      schooner?.setInteriorCullingEnabled(enabled),
    // The exposure adaptation A/B: 'room-lift' (this branch's default) puts
    // fixed per-room constants on the surfaces and retires the camera to ×1;
    // 'metered' follows the light at the eye's position; 'gaze' follows the
    // view cone (frame-metering feel); 'fixed' restores the old ×10
    // constant. All same-frame. `adaptationDebug()` prints meter/target/gain;
    // the Graphics panel has the sliders, including the per-room lift dials.
    setAdaptationMode: (mode: 'metered' | 'gaze' | 'fixed' | 'room-lift') =>
      schooner?.setAdaptationMode(mode),
    // The room-lift dials from the console: setRoomLift('cabin', 12).
    setRoomLift: (room: string, lift: number) =>
      schooner?.setRoomLift(room as Parameters<Schooner['setRoomLift']>[0], lift),
    roomLifts: () => schooner?.roomLifts(),
    // The bath-gradient A/B: 1 (default) reshapes each room's ambient bath
    // around its openings, 0 restores the flat room-mean, same frame.
    setBathGradientMix,
    // The portal-sky A/B (§17.6): 'map' (default) integrates the world
    // source pixels for the channels' sky; 'sh' is the L2 probe — measured
    // equivalent on the real sky, which is what acquitted it. Same frame.
    setPortalSkySource,
    getPortalSkySource,
    // Night dark-adaptation above deck — wired, ships OFF, judged in a night
    // session (the lantern round authored that darkness deliberately).
    setNightAdaptation: (enabled: boolean) =>
      schooner?.setNightAdaptation(enabled),
    adaptationDebug: () => schooner?.adaptationDebug(),
    // The lanterns below: one policy for all four rooms — mode ('auto' runs
    // each room-driven latch), intensity trim, the cap-occlusion shadow A/B
    // — and the readout with every room's signal. Per-lamp control is the
    // player's own Space action at the lamp.
    setLamps: (mode: 'auto' | 'on' | 'off') => schooner?.setLampsMode(mode),
    setLampsIntensity: (scale: number) => schooner?.setLampsIntensity(scale),
    setLampsShadow: (enabled: boolean) => schooner?.setLampsShadow(enabled),
    lampsDebug: () => schooner?.lampsDebug(),
  };
}

// Nothing here is worth logging in normal use, but a lost context should not
// fail silently during development.
lifecycle.listen(canvas, 'webglcontextlost', (event) => {
  event.preventDefault();
  console.warn('WebGL context lost');
});

lifecycle.add(() => {
  terrainMountDisposed = true;
  terrainRenderHook = undefined;
  terrainNearestLandM = undefined;
  terrainHazeHook = undefined;
  explicitTerrainHazeOverrideHook = undefined;
  terrainDisposeHook?.();
  terrainDisposeHook = undefined;
  browserDiagnostics?.dispose();
  hint.hide();
  actionBar.dispose();
  deskFocus.dispose();
  deskHoverLabel.remove();
  input.dispose();
  runtimeUi.dispose();
  weatherPresentation.dispose();
  ambience.dispose();
  gpuProfiler.dispose();
  oceanTemporal?.dispose();
  scenePresent.dispose();
  ocean.dispose();
  foam.dispose();
  crestSpray.dispose();
  sky.dispose();
  stars.dispose();
  activeVessel.dispose();
  renderer.dispose();
});

lifecycle.listen(window, 'beforeunload', () => lifecycle.dispose());
