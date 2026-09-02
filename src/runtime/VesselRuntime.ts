import * as THREE from 'three';

import type { CameraSystem } from '../camera/CameraSystem';
import { WALKING_STABILISATION } from '../camera/EmbodiedCameraController';
import type {
  CameraContext,
  VesselAnchor,
  VesselFramingEnvelope,
} from '../camera/types';
import type { DeckWalker } from '../player/DeckWalker';
import type { Ocean } from '../scene/Ocean';
import type { TimeOfDay } from '../scene/TimeOfDay';
import type { WaveField } from '../scene/Waves';
import type { WindSystem } from '../scene/WindSystem';
import type {
  Vessel,
  VesselPhysicsContext,
  VesselPresentationContext,
} from '../vessel/Vessel';
import {
  modelYawForVelocity,
  resolveCanonicalHorizontalVelocity,
  resolveTrueHeadingDirection,
  trueHeadingForModelYaw,
  type VesselMotionDebugControls,
  type VesselSpeedTarget,
} from '../vessel/VesselMotion';
import type { SailingControls } from '../vessel/schooner/SailingControls';
import type {
  SailingCrewSensorReadout,
  SailingCrewSensors,
} from '../vessel/schooner/crew/CrewObservations';
import type {
  SailingCrew,
  SailingCrewReadout,
} from '../vessel/schooner/crew/SailingCrew';
import type { Schooner } from '../vessel/schooner/Schooner';
import type { SchoonerSailForces } from '../vessel/schooner/SchoonerSailForces';
import { AUTHORED_TRIM_RAD, SAILS } from '../vessel/schooner/rig';
import type { RigTrimAnglesRad, SailName } from '../vessel/schooner/rig';
import { createSailClothFlow } from '../vessel/schooner/rigGeometry';
import type {
  RigLoftState,
  SailClothFlow,
  SailClothState,
} from '../vessel/schooner/rigGeometry';
import { sailShakeFraction } from '../vessel/schooner/sailAero';
import type { SailSetState } from '../vessel/schooner/sailAero';
import type { RuntimeSailClothMode } from './RuntimeOptions';
import {
  apparentWindRender,
  pointOfSailName,
  trueWindAngleDeg,
  windAngleOffBowDeg,
  windRenderHeadingRad,
  windRenderToBody,
  windRenderVector,
  type WorldWind,
} from '../world/WorldWind';
import { lengthVec3 } from '../world/math';
import { trimDegForTrueWindAngle } from '../world/openingVoyage';
import {
  createNavigationTelemetry,
  deriveNavigationTelemetry,
} from '../world/navigation';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import type { NavigationTelemetry } from '../world/types';
import { PlanetaryVesselMotionBridge } from './PlanetaryVesselMotionBridge';

export interface VesselRuntimeInput {
  readonly pickLow: THREE.Vector3;
  readonly pickHigh: THREE.Vector3;
  movementAxes(): { forward: number; right: number };
}

/**
 * Whatever is holding the player's body this frame, if anything is.
 *
 * A seat, a berth or a climb — this runtime does not care which, and naming the
 * shape rather than the class is what keeps it that way. It takes the axes as
 * well as the time because one kind of station *moves*: the fore shrouds hold
 * the body where it stood and travel the eye along an authored spline, and the
 * thing that drives that travel is the walk input.
 */
export interface PlayerStationStep {
  step(dt: number, axes: { forward: number; right: number }): void;
}

export interface VesselRuntimeWindState {
  speedMps: number;
  directionDeg: number;
  gustiness: number;
}

export interface VesselRuntimeWorldWindTelemetry {
  meanSpeedMps: number;
  meanDirectionTowardDeg: number;
  gustiness: number;
  instantaneousSpeedMps: number;
  gustDirectionOffsetDeg: number;
  apparentSpeedMps: number;
  apparentAngleOffBowDeg: number | null;
  pointOfSail: string | null;
}

export interface VesselRuntimeSailForceTelemetry {
  driveForwardN: number;
  sideForceN: number;
  heelTorqueNm: number;
  yawMomentNm: number;
  perSail: ReadonlyArray<{
    name: string;
    state: string;
    aoaDeg: number;
    luffing: boolean;
    forceN: number;
  }>;
}

/**
 * What the vessel is doing that can be heard.
 *
 * A presentation-only reading, in the same family as the wind and sail
 * telemetry above and gathered for the same reason: audio must read canonical
 * state rather than keep a second copy of it. Every field is republished from
 * an owner that already computes it — the aero result, the resistance model,
 * the buoyant body — and nothing here is derived twice.
 *
 * Unlike its neighbours this one is filled into a retained record rather than
 * allocated, because it is read on every rendered frame rather than when a
 * panel is open.
 */
export interface VesselRuntimeAcousticsTelemetry {
  /**
   * Apparent wind at the hull, m/s.
   *
   * `SailAeroResult.hullApparentSpeedMps` where there is a rig — the same
   * vector the blanketing geometry is built on, and built on the deterministic
   * *instantaneous* wind, so gusts arrive without a second gust process.
   * Falls back to the vessel-level apparent wind for the diagnostic raft.
   */
  apparentWindMps: number;
  /** Cloth set and evaluated this frame, m². */
  setClothAreaM2: number;
  /**
   * Cloth actually in motion, m² — area weighted by `sailShakeFraction`.
   *
   * Continuous, and deliberately not an area gated on `PerSailForce.luffing`.
   * That boolean is `sailLuffFactor(aoa) < 0.5`, a step cut out of a smooth
   * curve; using it would switch the sound on at full volume the instant a
   * sail crossed ten degrees. This is the same quantity the M6 cloth loft
   * takes its shake from, out of the same function, so what you hear and what
   * you see cannot disagree about how unsettled the rig is.
   */
  shakingClothAreaM2: number;
  /** |roll rate| + |pitch rate| from the buoyant body, rad/s. */
  hullWorkRateRadPerS: number;
  /**
   * Speed of the hull through the water, m/s.
   *
   * The resistance model's own `meanRelativeForwardWaterSpeedMps` where there
   * is one; canonical speed over the ground otherwise. Those differ in a
   * current, and the honest number for a bow wave is the first.
   */
  speedThroughWaterMps: number;
}

export interface VesselRuntimeSailingPanelState {
  mode: 'free' | 'captive-tow';
  speedMps: number;
  headingTrueDeg: number;
  yawRateDegPerS: number;
  apparentWindMps: number;
  apparentAngleOffBowDeg: number | null;
  pointOfSail: string | null;
  /**
   * Signed angle of the *true* wind's source off the bow, or null in a calm.
   *
   * Point of sail is a true-wind idea: a beam reach is still a beam reach when
   * boat speed has drawn the apparent wind twenty degrees forward of it. The
   * apparent angle above is what the sails see and what a trim decision is
   * made against; this is what the passage is called.
   */
  trueWindAngleOffBowDeg: number | null;
  rudderBladeDeg: number;
  rudderInflowMps: number;
  rudderEffectiveAoaDeg: number;
  rudderStallFactor: number;
  rudderYawMomentNm: number;
  tack: string;
  driveForwardN: number;
  heelDeg: number;
  luffingCount: number;
  perSail: Array<{
    name: SailName;
    state: SailSetState;
    aoaDeg: number;
    luffing: boolean;
    driveN: number;
  }>;
  crew: SailingCrewReadout | null;
  crewSensors: SailingCrewSensorReadout | null;
}

export interface VesselRuntimeOptions {
  vessel: Vessel;
  schooner: Schooner | undefined;
  sailForces: SchoonerSailForces | undefined;
  sailingControls: SailingControls | undefined;
  sailingCrew?: SailingCrew;
  sailingCrewSensors?: SailingCrewSensors;
  cameras: CameraSystem;
  deckWalker: DeckWalker | undefined;
  vesselFraming: VesselFramingEnvelope;
  world: PlanetaryWorld;
  waves: WaveField;
  wind: WindSystem;
  worldWind: WorldWind;
  lighting: TimeOfDay;
  ocean: Ocean;
  speedTarget: VesselSpeedTarget;
  productionEncounterEnabled: boolean;
  /** M6 sail presentation. Absent is the milestone's `alive` cloth. */
  sailClothMode?: RuntimeSailClothMode;
  initialTrueHeadingRad: number;
  input(): VesselRuntimeInput;
  captureContacts(): void;
}

const DEBUG_SPEED_STEP_MPS = 1;
const DEBUG_SPEED_MAX_MPS = 8;

/**
 * How much the wind has to change before the cloth is worth re-lofting.
 *
 * Not smoothing and not lag: the cloth shapes are smooth functions of these
 * inputs, so a quarter of a degree of AoA moves the drawn belly by well under
 * a millimetre. What the thresholds buy is the S4 property that a steady rig
 * costs nothing per frame; what they must never do is ration the *animation*,
 * which is why the flogging phase is outside them.
 */
const CLOTH_AOA_EPSILON_DEG = 0.25;
const CLOTH_WIND_EPSILON_MPS = 0.05;
const CLOTH_BLANKET_EPSILON = 0.01;

/**
 * Coordinates vessel motion, presentation, navigation, walking, and telemetry.
 *
 * All concrete scene resources are constructed by the composition root and
 * injected unchanged. The runtime owns only stable policy records and scratch;
 * its frame methods are allocation-free except for the pre-existing walking,
 * rig-scan, and diagnostic telemetry records documented at their call sites.
 */
export class VesselRuntime {
  readonly encounterVelocity = { x: 0, z: 0 };
  readonly navigationTelemetry: NavigationTelemetry =
    createNavigationTelemetry();
  readonly horizontalMotionBridge: PlanetaryVesselMotionBridge;
  readonly physicsContext: VesselPhysicsContext;
  readonly presentationContext: VesselPresentationContext;
  readonly motionControls: VesselMotionDebugControls;
  /**
   * Restart everything that carries the vessel's horizontal motion.
   *
   * Always present, on every vessel. It used to exist only when a schooner
   * did, which quietly left the raft and the schooner viewer with no way to
   * put the canonical voyage back — and the voyage is where most of that state
   * actually lives, hull or no hull.
   */
  readonly resetHorizontalMotion: () => void;

  private commandedTrueHeadingRad: number;
  private diagnosticTowLeeway = 0;
  private readonly vesselMotionNavigation = createNavigationTelemetry();
  private readonly frameVelocity = { x: 0, z: 0 };
  private readonly vesselApparentWind = { x: 0, z: 0 };
  private readonly stationaryHeadingDirection = { x: 0, z: -1 };
  private readonly towVelocity = { x: 0, z: 0 };
  private readonly acousticsReading: VesselRuntimeAcousticsTelemetry = {
    apparentWindMps: 0,
    setClothAreaM2: 0,
    shakingClothAreaM2: 0,
    hullWorkRateRadPerS: 0,
    speedThroughWaterMps: 0,
  };
  private readonly windTelemetryVector = { x: 0, z: 0 };
  private readonly windTelemetryBody = { x: 0, z: 0 };
  private readonly localGravity = { x: 0, y: -1, z: 0 };
  private readonly scratchGravity = new THREE.Vector3();
  private readonly scratchBasis = new THREE.Matrix4();
  private readonly vesselSternWorld = new THREE.Vector3();
  private readonly vesselBowWorld = new THREE.Vector3();
  private readonly vesselAxisLocalY: number;
  private readonly vesselHalfLength: number;
  private readonly loftedTrims: RigTrimAnglesRad;
  private readonly loftedHoists: Record<SailName, number>;
  /** The M6 cloth state handed to the loft, rewritten in place each frame. */
  private readonly clothFlow: Record<SailName, SailClothFlow>;
  private readonly clothState: SailClothState;
  private readonly loftState: RigLoftState;
  /** Presentation seconds the flogging phase is read off. */
  private clothElapsedSeconds = 0;
  private readonly cameraContext: CameraContext;
  private waveOriginBeforeVesselX = 0;
  private waveOriginBeforeVesselZ = 0;

  constructor(private readonly options: VesselRuntimeOptions) {
    this.commandedTrueHeadingRad = options.initialTrueHeadingRad;
    this.horizontalMotionBridge = new PlanetaryVesselMotionBridge(
      options.world,
      this.towVelocity,
    );
    this.physicsContext = {
      dt: 0,
      waves: options.waves,
      localX: 0,
      localZ: 0,
      wind: options.wind,
      elapsed: 0,
      encounterVelocity: this.encounterVelocity,
      horizontalMotion: options.productionEncounterEnabled
        ? this.horizontalMotionBridge
        : undefined,
    };
    this.presentationContext = {
      dt: 0,
      localX: 0,
      localZ: 0,
      wind: options.wind,
      elapsed: 0,
      sunDirection: options.lighting.sunDirection,
      sunColor: options.lighting.sunLightColor,
      sunIntensity: 0,
      moonDirection: options.lighting.moonDirection,
      moonColor: options.lighting.moonLightColor,
      moonIntensity: 0,
      ambientRadiance: options.lighting.ambientRadiance,
      skyHemisphericRadiance: options.lighting.hemisphericRadiance,
      sceneExposure: 1,
      apparentWindRender: this.vesselApparentWind,
    };
    this.cameraContext = {
      dt: 0,
      vessel: {
        matrixWorld: options.vessel.group.matrixWorld,
        pitch: 0,
        yaw: 0,
        roll: 0,
        x: 0,
        z: 0,
        waterlineY: 0,
        designWaterlineY: options.vessel.body.designWaterlineY,
        framing: options.vesselFraming,
      },
      waterHeightAt: (x, z) => options.waves.sampleHeight(x, z),
    };
    this.vesselAxisLocalY = options.vessel.waterlineLocalY;
    this.vesselHalfLength = options.vessel.halfLengthM;
    this.loftedTrims = { ...AUTHORED_TRIM_RAD };
    this.loftedHoists = Object.fromEntries(
      SAILS.map((sail) => [sail.name, 1]),
    ) as Record<SailName, number>;
    this.clothFlow = Object.fromEntries(
      SAILS.map((sail) => [sail.name, createSailClothFlow()]),
    ) as Record<SailName, SailClothFlow>;
    this.clothState = {
      flow: this.clothFlow,
      elapsedSeconds: 0,
      animate: (options.sailClothMode ?? 'alive') === 'alive',
    };
    this.loftState = {
      trims: this.loftedTrims,
      hoists: this.loftedHoists,
      // `?cloth=flat` never attaches a cloth state, which is exactly what
      // makes that arm byte-identical to the pre-M6 loft.
      cloth: options.sailClothMode === 'flat' ? undefined : this.clothState,
    };
    this.motionControls = {
      actualSpeedMps: this.actualVesselSpeedMps,
      targetSpeedMps: () => options.speedTarget.targetSpeedMps,
      isPrescribedSpeed: () => options.speedTarget.isPrescribed,
      increaseSpeed: () =>
        this.prescribeVesselSpeedMps(
          this.actualVesselSpeedMps() + DEBUG_SPEED_STEP_MPS,
        ),
      decreaseSpeed: () =>
        this.prescribeVesselSpeedMps(
          this.actualVesselSpeedMps() - DEBUG_SPEED_STEP_MPS,
        ),
      stop: () => this.prescribeVesselSpeedMps(0),
      releaseTow: () => {
        this.rememberMovingCourseAsHeading();
        this.diagnosticTowLeeway = 0;
        options.speedTarget.resumeLegacy();
      },
      trueHeadingRad: () => {
        if (
          options.schooner &&
          options.productionEncounterEnabled &&
          !options.speedTarget.isPrescribed
        ) {
          return trueHeadingForModelYaw(
            options.world.state,
            options.schooner.yaw,
          );
        }
        return this.commandedTrueHeadingRad;
      },
      setTrueHeadingRad: (headingRad) => {
        this.commandedTrueHeadingRad =
          ((headingRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        if (
          options.productionEncounterEnabled &&
          !options.speedTarget.isPrescribed
        ) {
          options.speedTarget.prescribe(this.actualVesselSpeedMps());
        }
        if (this.actualVesselSpeedMps() > 1e-12) {
          options.world.setTrueCourseRad(this.commandedTrueHeadingRad);
        }
      },
    };
    this.resetHorizontalMotion = () => this.restoreOpeningMotion();
  }

  /**
   * Put every horizontal-motion owner back to the state the page loaded with.
   *
   * The order is the order the values depend on each other in:
   *
   *  1. the canonical voyage, because the model heading is derived from it;
   *  2. the commanded heading, back to the opening course rather than whatever
   *     `rememberMovingCourseAsHeading` last observed;
   *  3. the hull's own integrator and yaw;
   *  4. the frame's encounter velocity, so the first step after the restart
   *     does not sail on last scene's number;
   *  5. the production heading, re-derived from (1) and (2).
   *
   * Step 5 matters as much as step 1. `modelYawForVelocity` picks the branch
   * nearest the yaw it is handed, so re-deriving from a stale yaw could return
   * the opening heading plus a full turn — the same angle, a different number,
   * and a state comparison that fails for a reason nobody can see.
   */
  private restoreOpeningMotion(): void {
    const { schooner, world } = this.options;
    world.restoreOpeningVoyage();
    this.commandedTrueHeadingRad = this.options.initialTrueHeadingRad;
    this.encounterVelocity.x = 0;
    this.encounterVelocity.z = 0;
    this.horizontalMotionBridge.towYawRad = 0;
    this.towVelocity.x = 0;
    this.towVelocity.z = 0;
    // Mirrors the presentation clock, which the restart has just rewound to
    // zero. It is re-read every frame so this only closes the one-frame gap,
    // but a restart that leaves an obviously stale number behind invites the
    // next reader to trust it.
    this.clothElapsedSeconds = 0;
    if (!schooner) return;
    schooner.resetHorizontalMotion();
    this.initializeProductionHeading();
  }

  get cameraAnchor(): VesselAnchor {
    return this.cameraContext.vessel;
  }

  get observerDisplacementX(): number {
    return this.options.waves.originWorldX - this.waveOriginBeforeVesselX;
  }

  get observerDisplacementZ(): number {
    return this.options.waves.originWorldZ - this.waveOriginBeforeVesselZ;
  }

  /**
   * The bow, in render-frame world coordinates.
   *
   * Republished rather than recomputed: `prepareOceanMasks` already places
   * this point for the ocean's occlusion capsule, in the phase immediately
   * before the one audio runs in, so the sound of water at the bow is placed
   * at the same bow the sea is being cut by. A live mutated vector — read it
   * inside the frame, never retain it.
   */
  get bowWorld(): Readonly<THREE.Vector3> {
    return this.vesselBowWorld;
  }

  get diagnosticTowLeewayRad(): number {
    return this.diagnosticTowLeeway;
  }

  set diagnosticTowLeewayRad(value: number) {
    this.diagnosticTowLeeway = value;
  }

  /**
   * The seat the player may be sitting in, if this vessel has one.
   *
   * Attached after construction because the seat needs the walker and the
   * camera, which this runtime is itself given — so it cannot be built before
   * this object exists. A property rather than a constructor argument is the
   * honest expression of that, and the only alternative was a two-phase
   * constructor that hid the same fact.
   */
  private seat: PlayerStationStep | undefined;

  attachSeat(seat: PlayerStationStep): void {
    this.seat = seat;
  }

  /** Apply the authored embodied-camera/walker opening state. */
  initializeDeckWalker(): void {
    const { cameras, deckWalker } = this.options;
    if (!deckWalker) return;
    Object.assign(cameras.stabilisation, WALKING_STABILISATION);
    deckWalker.placeAt(0, 1.4);
    cameras.embodied.eyeLocal.set(
      deckWalker.x,
      deckWalker.eyeY(),
      deckWalker.z,
    );
    cameras.embodied.headLocal.copy(cameras.embodied.eyeLocal);
  }

  /** Diagnostic direct entry into the cabin, preserving normal controls. */
  placeCabinView(cabinSoleY: number): void {
    const { cameras, deckWalker } = this.options;
    if (!deckWalker) return;
    deckWalker.placeAt(0, -5.9, cabinSoleY);
    cameras.setDiagnosticMode('embodied');
    cameras.look = { yaw: Math.PI, pitch: (-24 * Math.PI) / 180 };
    cameras.embodied.eyeLocal.set(
      deckWalker.x,
      deckWalker.eyeY(),
      deckWalker.z,
    );
    cameras.embodied.headLocal.copy(cameras.embodied.eyeLocal);
  }

  /** Align the production schooner's model yaw to the initial true heading. */
  initializeProductionHeading(): void {
    const { productionEncounterEnabled, schooner, world } = this.options;
    if (!productionEncounterEnabled || !schooner) return;
    resolveTrueHeadingDirection(
      world.state,
      this.commandedTrueHeadingRad,
      this.stationaryHeadingDirection,
    );
    schooner.yaw = modelYawForVelocity(
      this.stationaryHeadingDirection,
      schooner.yaw,
    );
  }

  /** Initial post-astronomy hull settle; the raft intentionally has none. */
  snapInitialSurfacePose(): void {
    const { schooner, waves } = this.options;
    if (!schooner) return;
    this.prepareProductionHorizontalMotion();
    schooner.snapToSurface(waves, 0, 0);
  }

  /** Production force integration or the established diagnostic kinematic path. */
  advanceWorldMotion(presentationDeltaSeconds: number): void {
    const { productionEncounterEnabled, speedTarget, world } = this.options;
    if (productionEncounterEnabled) {
      this.prepareProductionHorizontalMotion();
      return;
    }
    world.advancePhysicsSeconds(
      presentationDeltaSeconds,
      speedTarget.targetSpeedMps,
    );
    this.prepareProductionHorizontalMotion();
  }

  /**
   * Derive the pre-vessel frame heading, world wind, and vessel cue.
   * EnvironmentRuntime deliberately re-derives the same navigation scratch
   * after fixed-step canonical commits; these are two different instants.
   *
   * `presentWind` is **the wind now**, and since WX1 that is no longer the same
   * thing as the wind that grew this sea. The caller chooses the source; at the
   * neutral weather state it is the sea state's own wind, unchanged and to the
   * last bit. See `src/weather/WeatherSystem.ts`.
   */
  updateFrameNavigationAndWind(
    presentationDeltaSeconds: number,
    presentWind: Readonly<VesselRuntimeWindState>,
  ): void {
    const { sailForces, waves, wind, worldWind } = this.options;
    waves.setFrameHeadingDeg(this.frameHeadingOffsetDeg());
    worldWind.setMean(
      presentWind.speedMps,
      presentWind.directionDeg,
      presentWind.gustiness,
    );
    worldWind.advance(presentationDeltaSeconds);
    wind.setOceanWind(
      windRenderHeadingRad(
        worldWind.meanDirectionTowardDeg,
        waves.frameHeading,
      ),
      worldWind.meanSpeedMps,
    );
    if (sailForces) sailForces.frameHeadingDeg = waves.frameHeading;
    this.computeApparentWindRender(this.vesselApparentWind);
  }

  /** Physics first, then the read-only wake contact handoff. */
  integrate(
    presentationDeltaSeconds: number,
    presentationElapsedSeconds: number,
  ): void {
    const { vessel, waves } = this.options;
    this.waveOriginBeforeVesselX = waves.originWorldX;
    this.waveOriginBeforeVesselZ = waves.originWorldZ;
    this.physicsContext.dt = presentationDeltaSeconds;
    this.physicsContext.elapsed = presentationElapsedSeconds;
    vessel.advancePhysics(this.physicsContext);
    this.options.captureContacts();
  }

  /** Finished vessel pose → matrix → walker → camera, in that order. */
  present(
    presentationDeltaSeconds: number,
    presentationElapsedSeconds: number,
  ): void {
    const { cameras, vessel } = this.options;
    // The cloth's flogging clock is presentation time, like every other
    // animated thing aboard — the crew's evolutions are on the world clock,
    // but canvas shaking in the wind is something you watch in real seconds.
    this.clothElapsedSeconds = presentationElapsedSeconds;
    this.presentationContext.dt = presentationDeltaSeconds;
    this.presentationContext.elapsed = presentationElapsedSeconds;
    vessel.updatePresentation(this.presentationContext);
    vessel.group.updateMatrixWorld();
    this.stepDeckWalker(presentationDeltaSeconds);

    const anchor = this.cameraContext.vessel as MutableVesselAnchor;
    anchor.pitch = vessel.group.rotation.x;
    anchor.yaw = vessel.group.rotation.y;
    anchor.roll = vessel.group.rotation.z;
    anchor.waterlineY = vessel.body.designWaterlineWorldY();
    anchor.x = 0;
    anchor.z = 0;
    (this.cameraContext as MutableCameraContext).dt =
      presentationDeltaSeconds;
    cameras.update(this.cameraContext);
    // After the camera has settled: the portal culling reads the finished
    // frustum, and a frame-late answer here would flash the interior for one
    // frame every time the eye crosses a coaming. Guarded because diagnostic
    // harnesses drive this runtime with partial camera systems.
    const camera = (cameras as { camera?: THREE.Camera }).camera;
    if (camera) {
      camera.updateMatrixWorld();
      vessel.updateInteriorVisibility?.(camera);
    }
  }

  /** Active lamp, live posed occlusion capsule, and schooner cutout transform. */
  prepareOceanMasks(): void {
    const { ocean, schooner, vessel } = this.options;
    ocean.setLamp(vessel.lamp.flameWorld, vessel.lamp.renderEmission);
    vessel.group.updateMatrixWorld();
    this.vesselSternWorld
      .set(0, this.vesselAxisLocalY, -this.vesselHalfLength)
      .applyMatrix4(vessel.group.matrixWorld);
    this.vesselBowWorld
      .set(0, this.vesselAxisLocalY, this.vesselHalfLength)
      .applyMatrix4(vessel.group.matrixWorld);
    ocean.setVesselOcclusion(
      this.vesselSternWorld,
      this.vesselBowWorld,
    );
    if (schooner) {
      ocean.setInteriorCutoutTransform(vessel.group.matrixWorld);
    }
  }

  /** Publish the active vessel's live trim-picking segment. */
  updateTrimPickTargets(): void {
    const { vessel } = this.options;
    const input = this.options.input();
    if (vessel.updateTrimPickTargets) {
      vessel.updateTrimPickTargets(input.pickLow, input.pickHigh);
    } else {
      input.pickLow.setFromMatrixPosition(vessel.group.matrixWorld);
      input.pickHigh.copy(input.pickLow);
    }
  }

  /** Exact-value rig re-loft, still called after ambience inside the phase. */
  refreshRigLoft(): void {
    const { sailingControls, schooner } = this.options;
    if (!schooner || !sailingControls) return;
    const DEG_TO_RAD = Math.PI / 180;
    let moved = false;
    for (const key of Object.keys(
      this.loftedTrims,
    ) as (keyof RigTrimAnglesRad)[]) {
      const current = sailingControls.trimDeg(key) * DEG_TO_RAD;
      if (current !== this.loftedTrims[key]) {
        this.loftedTrims[key] = current;
        moved = true;
      }
    }
    for (const sail of SAILS) {
      const current = sailingControls.hoistFraction(sail.name);
      if (current !== this.loftedHoists[sail.name]) {
        this.loftedHoists[sail.name] = current;
        moved = true;
      }
    }
    if (this.refreshClothState()) moved = true;
    if (!moved) return;
    schooner.updateRigLoft(this.loftState);
  }

  /**
   * Copy the aero's per-sail verdict and the trimmers' reports onto the cloth
   * state, and say whether the cloth has anything new to draw.
   *
   * THE FRAME BUDGET LIVES HERE
   * ---------------------------
   * S4's rule was "re-loft on any exact change", and with only trims and
   * hoists in the state that meant nothing at all happened on a settled rig.
   * Angle of attack is not like that: it moves every substep because the
   * *wind* moves, so reading it exactly would re-loft the whole live rig on
   * every frame of a steady beat and quietly undo S4's cheap-frames property.
   *
   * So flow changes are thresholded and the flogging clock is not: a sail that
   * is actually shaking gets a fresh phase every frame (that is the animation,
   * and it cannot be rationed — see the S4 review's FAULT 2), while a steady
   * rig in a steady breeze goes back to doing nothing.
   */
  private refreshClothState(): boolean {
    const { sailForces, sailingCrew } = this.options;
    if (!sailForces || this.options.sailClothMode === 'flat') return false;
    const aero = sailForces.lastResult;
    const trimmers = sailingCrew?.trimmers;
    let changed = false;
    let shaking = false;
    for (let i = 0; i < aero.perSail.length; i++) {
      const source = aero.perSail[i];
      const target = this.clothFlow[source.name];
      const cannotDraw = trimmers?.cannotDraw(source.name) ?? false;
      if (
        Math.abs(source.aoaDeg - target.aoaDeg) >= CLOTH_AOA_EPSILON_DEG ||
        Math.abs(source.apparentSpeedMps - target.apparentSpeedMps) >=
          CLOTH_WIND_EPSILON_MPS ||
        Math.abs(source.blanketFactor - target.blanketFactor) >=
          CLOTH_BLANKET_EPSILON ||
        cannotDraw !== target.cannotDraw
      ) {
        target.aoaDeg = source.aoaDeg;
        target.apparentSpeedMps = source.apparentSpeedMps;
        target.blanketFactor = source.blanketFactor;
        target.cannotDraw = cannotDraw;
        changed = true;
      }
      // Cloth that is neither drawing nor firmly aback is cloth in motion.
      if (source.active && (source.luffing || cannotDraw)) shaking = true;
    }
    if (this.clothState.animate && shaking) {
      this.clothState.elapsedSeconds = this.clothElapsedSeconds;
      changed = true;
    }
    return changed;
  }

  /**
   * The sail presentation the rig was actually LOFTED with — M6's `?cloth=`.
   *
   * Derived from the two objects the loft reads rather than echoed back from
   * `options.sailClothMode`, and that distinction is the whole reason this
   * getter earns its place in the A/B registry. A switch that reports the value
   * it was asked for cannot detect the case the registry exists to catch: an arm
   * that did not take. `cloth` is absent from the loft state only for `flat`,
   * and `animate` is true only for `alive`, so these two fields between them
   * name the arm the rig is genuinely drawing.
   */
  get sailClothMode(): RuntimeSailClothMode {
    if (this.loftState.cloth === undefined) return 'flat';
    return this.clothState.animate ? 'alive' : 'still';
  }

  /**
   * Capture only: put her on a named point of sail, as an initial condition.
   *
   * REVIEW_QUEUE 2.6 asks for six things and five of them are point-of-sail
   * dependent — the square topsail aback on a beat, twist on an eased main,
   * slatting through a tack. The capture host could name a sea, an instant, an
   * eye and a bearing, and could not name the one thing a question about SAILS
   * is actually about, so the ship was photographed on whatever point of sail
   * the opening voyage happened to give her.
   *
   * The angle is the signed TRUE wind angle off the bow, degrees, in
   * `trueWindAngleDeg`'s sign: positive is the wind over the port side, so +45
   * is close-hauled on the port tack and 180 is dead downwind. The heading that
   * produces it is resolved against the wind that is actually blowing, which is
   * why this lives here and not in the capture host — the host has no honest way
   * to reach the present wind, and a point of sail resolved against the sea
   * state's authored wind would be wrong the moment the weather moved it.
   *
   * THREE THINGS HAPPEN, and they are one call because doing any of them alone
   * produces a picture that is a lie:
   *
   *  1. The heading is commanded, which puts the hull on the captive tow at the
   *     speed she is already making. Free sailing would turn toward the new
   *     heading over the better part of a minute and a staging is 1.2 seconds.
   *  2. The model yaw is snapped to it, so the hull is pointing where the tow is
   *     going on the first frame rather than the fortieth.
   *  3. The sheets are re-sided for the resulting tack, by the same rule the
   *     opening condition uses. Without this a scene on the other tack draws
   *     every sail aback and captions it a broad reach.
   *
   * Returns the angle that TOOK, for the same reason `settleSun` returns the
   * elevation that took: the caption must be the drawn frame, not the request.
   */
  readonly poseOnTrueWindAngleDeg = (angleDeg: number): number => {
    if (!Number.isFinite(angleDeg)) {
      throw new RangeError(
        `point of sail must be a finite angle off the bow, got ${angleDeg}`,
      );
    }
    const { sailingControls, worldWind } = this.options;
    const windTowardDeg = worldWind.meanDirectionTowardDeg;
    // The inverse of `trueWindAngleDeg`: angle = heading - (toward + 180).
    const headingDeg = windTowardDeg + 180 + angleDeg;
    this.diagnosticTowLeeway = 0;
    this.motionControls.setTrueHeadingRad(headingDeg * (Math.PI / 180));
    this.initializeProductionHeading();
    const achieved = trueWindAngleDeg(headingDeg, windTowardDeg);
    if (sailingControls) {
      for (const [sail, degrees] of Object.entries(
        trimDegForTrueWindAngle(achieved),
      )) {
        sailingControls.setInitialTrimDeg(sail as SailName, degrees);
      }
    }
    return achieved;
  };

  readonly prescribeVesselSpeedMps = (speedMps: number): void => {
    const bounded = Math.min(Math.max(speedMps, 0), DEBUG_SPEED_MAX_MPS);
    this.rememberMovingCourseAsHeading();
    this.options.speedTarget.prescribe(bounded);
    this.options.world.setSpeedPreservingDirection(bounded);
    if (bounded > 0) {
      this.options.world.setTrueCourseRad(this.commandedTrueHeadingRad);
    }
  };

  readonly buildWindTelemetry = (): VesselRuntimeWorldWindTelemetry => {
    const { schooner, worldWind } = this.options;
    this.computeApparentWindRender(this.windTelemetryVector);
    const apparentSpeedMps = Math.hypot(
      this.windTelemetryVector.x,
      this.windTelemetryVector.z,
    );
    let apparentAngleOffBowDeg: number | null = null;
    let pointOfSail: string | null = null;
    if (schooner && apparentSpeedMps > 1e-6) {
      windRenderToBody(
        this.windTelemetryVector.x,
        this.windTelemetryVector.z,
        schooner.yaw,
        this.windTelemetryBody,
      );
      apparentAngleOffBowDeg = windAngleOffBowDeg(
        this.windTelemetryBody.x,
        this.windTelemetryBody.z,
      );
      pointOfSail = pointOfSailName(apparentAngleOffBowDeg);
    }
    return {
      meanSpeedMps: worldWind.meanSpeedMps,
      meanDirectionTowardDeg: worldWind.meanDirectionTowardDeg,
      gustiness: worldWind.gustiness,
      instantaneousSpeedMps: worldWind.instantaneousSpeedMps,
      gustDirectionOffsetDeg: worldWind.gustDirectionOffsetDeg,
      apparentSpeedMps,
      apparentAngleOffBowDeg,
      pointOfSail,
    };
  };

  /**
   * Fill and return the live acoustics reading. Allocation-free.
   *
   * Called once per rendered frame by the sound sampler, from the same scene
   * phase the old ambience update lived in. The record is retained and
   * rewritten, so the caller must consume it before the next frame.
   */
  readonly readAcoustics = (): Readonly<VesselRuntimeAcousticsTelemetry> => {
    const { sailForces, schooner, vessel } = this.options;
    const out = this.acousticsReading;

    const aero = sailForces?.lastResult;
    if (aero) {
      out.apparentWindMps = aero.hullApparentSpeedMps;
      out.setClothAreaM2 = aero.activeClothAreaM2;
      let shaking = 0;
      for (const sail of aero.perSail) {
        if (!sail.active) continue;
        // `cannotDraw` is passed false until the M6 cloth branch merges and
        // brings `Trimmers.cannotDraw(sail)` — the allocation-free accessor —
        // with it. Until then the sound under-reports a sail the hand has
        // given up on, which is the safe direction to be wrong in. See the
        // handover's owed list.
        shaking +=
          sail.areaM2 *
          sailShakeFraction(
            sail.aoaDeg,
            sail.apparentSpeedMps,
            sail.blanketFactor,
            false,
          );
      }
      out.shakingClothAreaM2 = shaking;
    } else {
      out.apparentWindMps = Math.hypot(
        this.vesselApparentWind.x,
        this.vesselApparentWind.z,
      );
      out.setClothAreaM2 = 0;
      out.shakingClothAreaM2 = 0;
    }

    const body = vessel.body;
    out.hullWorkRateRadPerS = Math.abs(body.rollRate) + Math.abs(body.pitchRate);

    out.speedThroughWaterMps = schooner
      ? Math.abs(
          schooner.horizontalDynamics.lastAdvance.resistance
            .meanRelativeForwardWaterSpeedMps,
        )
      : this.actualVesselSpeedMps();

    return out;
  };

  readonly buildSailTelemetry =
    (): VesselRuntimeSailForceTelemetry | null => {
      const { sailForces } = this.options;
      if (!sailForces) return null;
      const result = sailForces.lastResult;
      let driveForwardN = result.windage.forceModelZN;
      let sideForceN = result.windage.forceModelXN;
      for (const sail of result.perSail) {
        driveForwardN += sail.forceModelZN;
        sideForceN += sail.forceModelXN;
      }
      return {
        driveForwardN,
        sideForceN,
        heelTorqueNm: result.rollTorqueNm,
        yawMomentNm: result.yawMomentNm,
        perSail: result.perSail.map((sail) => ({
          name: sail.name,
          state: sail.state,
          aoaDeg: sail.aoaDeg,
          luffing: sail.luffing,
          forceN: Math.hypot(
            sail.forceModelXN,
            sail.forceModelYN,
            sail.forceModelZN,
          ),
        })),
      };
    };

  readonly buildSailingPanelState =
    (): VesselRuntimeSailingPanelState => {
      const { productionEncounterEnabled, sailForces, sailingControls, schooner } =
        this.options;
      const degPerRad = 180 / Math.PI;
      const wind = this.buildWindTelemetry();
      const advance = schooner!.horizontalDynamics.lastAdvance;
      const resistance = advance.resistance;
      const aero = sailForces!.lastResult;
      let driveForwardN = aero.windage.forceModelZN;
      for (const sail of aero.perSail) driveForwardN += sail.forceModelZN;
      const headingTrueDeg =
        ((trueHeadingForModelYaw(this.options.world.state, schooner!.yaw) *
          degPerRad) %
          360 +
          360) %
        360;
      return {
        mode:
          productionEncounterEnabled &&
          !this.options.speedTarget.isPrescribed
            ? 'free'
            : 'captive-tow',
        speedMps: this.actualVesselSpeedMps(),
        headingTrueDeg,
        yawRateDegPerS: schooner!.yawRate * degPerRad,
        apparentWindMps: wind.apparentSpeedMps,
        apparentAngleOffBowDeg: wind.apparentAngleOffBowDeg,
        pointOfSail: wind.pointOfSail,
        trueWindAngleOffBowDeg:
          wind.meanSpeedMps > 1e-6
            ? trueWindAngleDeg(headingTrueDeg, wind.meanDirectionTowardDeg)
            : null,
        rudderBladeDeg: resistance.rudderAngleRad * degPerRad,
        rudderInflowMps: resistance.rudderInflowSpeedMps,
        rudderEffectiveAoaDeg: resistance.rudderEffectiveAoaDeg,
        rudderStallFactor: resistance.rudderStallFactor,
        rudderYawMomentNm: resistance.rudderDeflectionYawMomentNm,
        tack:
          sailingControls!.trimDeg('mainsail') >= 0
            ? 'starboard'
            : 'port',
        driveForwardN,
        heelDeg: schooner!.body.roll * degPerRad,
        luffingCount: aero.luffingCount,
        perSail: aero.perSail.map((sail) => ({
          name: sail.name,
          state: sail.state,
          aoaDeg: sail.aoaDeg,
          luffing: sail.luffing,
          driveN: sail.forceModelZN,
        })),
        crew: this.options.sailingCrew?.readout() ?? null,
        crewSensors: this.options.sailingCrewSensors?.readout() ?? null,
      };
    };

  private readonly actualVesselSpeedMps = (): number =>
    lengthVec3(this.options.world.state.velocityEcefMps);

  private rememberMovingCourseAsHeading(): void {
    const { productionEncounterEnabled, schooner, world } = this.options;
    if (schooner && productionEncounterEnabled) {
      this.commandedTrueHeadingRad = trueHeadingForModelYaw(
        world.state,
        schooner.yaw,
      );
      return;
    }
    deriveNavigationTelemetry(world.state, this.vesselMotionNavigation);
    if (this.vesselMotionNavigation.trueCourseRad !== null) {
      this.commandedTrueHeadingRad =
        this.vesselMotionNavigation.trueCourseRad;
    }
  }

  private prepareProductionHorizontalMotion(): void {
    const { productionEncounterEnabled, schooner, speedTarget, world } =
      this.options;
    if (!productionEncounterEnabled || !schooner) {
      this.encounterVelocity.x = 0;
      this.encounterVelocity.z = 0;
      return;
    }
    resolveCanonicalHorizontalVelocity(
      world.state,
      this.encounterVelocity,
    );
    this.horizontalMotionBridge.mode = speedTarget.isPrescribed
      ? 'captive-tow'
      : 'free';
    if (this.horizontalMotionBridge.mode === 'captive-tow') {
      resolveTrueHeadingDirection(
        world.state,
        this.commandedTrueHeadingRad,
        this.stationaryHeadingDirection,
      );
      const towSpeedMps = speedTarget.targetSpeedMps;
      const leewayCos = Math.cos(this.diagnosticTowLeeway);
      const leewaySin = Math.sin(this.diagnosticTowLeeway);
      this.towVelocity.x =
        (this.stationaryHeadingDirection.x * leewayCos +
          this.stationaryHeadingDirection.z * leewaySin) *
        towSpeedMps;
      this.towVelocity.z =
        (this.stationaryHeadingDirection.z * leewayCos -
          this.stationaryHeadingDirection.x * leewaySin) *
        towSpeedMps;
      this.horizontalMotionBridge.towYawRad = modelYawForVelocity(
        this.stationaryHeadingDirection,
        schooner.yaw,
      );
    }
  }

  private frameHeadingOffsetDeg(): number {
    const { schooner, world } = this.options;
    deriveNavigationTelemetry(world.state, this.navigationTelemetry);
    const trueCourse = this.navigationTelemetry.trueCourseRad;
    let trueReference: number;
    let renderBearing: number;
    if (trueCourse === null) {
      if (!schooner) return 0;
      trueReference = trueHeadingForModelYaw(world.state, schooner.yaw);
      renderBearing = Math.atan2(
        Math.sin(schooner.yaw),
        -Math.cos(schooner.yaw),
      );
    } else {
      trueReference = trueCourse;
      resolveCanonicalHorizontalVelocity(world.state, this.frameVelocity);
      renderBearing = Math.atan2(
        this.frameVelocity.x,
        -this.frameVelocity.z,
      );
    }
    return (
      (((renderBearing - trueReference) * 180) / Math.PI + 540) % 360
    ) - 180;
  }

  private computeApparentWindRender(out: { x: number; z: number }): void {
    const { waves, worldWind } = this.options;
    windRenderVector(
      windRenderHeadingRad(
        worldWind.instantaneousDirectionTowardDeg,
        waves.frameHeading,
      ),
      worldWind.instantaneousSpeedMps,
      out,
    );
    apparentWindRender(
      out.x,
      out.z,
      this.encounterVelocity.x,
      this.encounterVelocity.z,
      out,
    );
  }

  private stepDeckWalker(dt: number): void {
    const { cameras, deckWalker, vessel } = this.options;
    if (!deckWalker) return;
    this.scratchBasis.extractRotation(vessel.group.matrixWorld);
    this.scratchGravity
      .set(0, -1, 0)
      .applyMatrix4(this.scratchBasis.transpose());
    this.localGravity.x = this.scratchGravity.x;
    this.localGravity.y = this.scratchGravity.y;
    this.localGravity.z = this.scratchGravity.z;

    // Preserve the existing input/literal allocation behaviour for this slice.
    const axes =
      cameras.modeName === 'embodied'
        ? this.options.input().movementAxes()
        : { forward: 0, right: 0 };
    deckWalker.step(
      dt,
      {
        forward: axes.forward,
        right: axes.right,
        yaw: cameras.embodied.yaw,
      },
      this.localGravity,
    );
    cameras.embodied.eyeLocal.set(
      deckWalker.x,
      deckWalker.eyeY(),
      deckWalker.z,
    );
    cameras.embodied.headLocal.copy(cameras.embodied.eyeLocal);
    // **After the body, every frame, and that ordering is the design.** While
    // the player is sitting, the seat writes the eye over the one the walker
    // just wrote — see `SeatedStation.step`. Doing it here rather than in the
    // main loop is what makes the ordering structural instead of a convention
    // somebody has to keep.
    //
    // **The axes go through as well as the time**, because one of the twelve
    // stations moves. A body on the fore shrouds is held where its feet were and
    // travels along an authored spline instead, and what drives it up and down
    // is the same forward axis that drives the walk — so the station needs the
    // input the walker just consumed rather than a binding of its own.
    this.seat?.step(dt, axes);
  }
}

interface MutableVesselAnchor extends VesselAnchor {
  pitch: number;
  yaw: number;
  roll: number;
  x: number;
  z: number;
  waterlineY: number;
}

interface MutableCameraContext extends CameraContext {
  dt: number;
}
