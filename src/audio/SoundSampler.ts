/**
 * The one place audio reads the world.
 *
 * Everything downstream of here — the mapping, the mixer, the graph — sees
 * only a `SoundWorldState` of plain numbers. That is what makes the mapping
 * testable in node, and it is also the architectural claim: audio is a
 * presentation system, so it reads canonical state at one boundary and never
 * becomes a second authority for any of it.
 *
 * Read the list of what this file *does not* do:
 *
 * - it does not compute whitecap coverage — the ocean phase already did, for
 *   the foam, and hands its exact value in;
 * - it does not compute apparent wind — the aero model publishes the hull's;
 * - it does not difference a position for speed — the resistance model already
 *   publishes speed through the water;
 * - it does not track whether a hatch is open — `isClosureOpen` is the answer,
 *   the same one the light, the walker and the player's verb all read;
 * - it does not decide which room the listener is in — `lightRoomAt` does,
 *   and it is the same function the interior lighting solves against.
 *
 * Called once per rendered frame from the scene phase, and allocation-free:
 * one retained state record, three retained vectors, one retained matrix.
 */

import * as THREE from 'three';

import type { CameraSystem } from '../camera/CameraSystem';
import type { SeaState } from '../ocean/seaState';
import type { WaveField } from '../scene/Waves';
import { isClosureOpen } from '../vessel/schooner/closures';
import { lightRoomAt } from '../vessel/schooner/interiorLight';
import type { VesselRuntimeAcousticsTelemetry } from '../runtime/VesselRuntime';
import type { VesselAnchor } from '../camera/types';
import {
  createSoundWorldState,
  type SoundRoomName,
  type SoundWorldState,
} from './soundState';

/**
 * What the sampler needs, stated structurally.
 *
 * Written as the narrowest shape that works rather than as the concrete
 * classes, so a test can drive the sampler with four literals and so the audio
 * package does not acquire a dependency on the whole vessel runtime.
 */
export interface SoundSamplerPorts {
  cameras: Pick<CameraSystem, 'camera' | 'modeName'>;
  vessel: {
    readonly cameraAnchor: VesselAnchor;
    readonly bowWorld: Readonly<THREE.Vector3>;
    readAcoustics(): Readonly<VesselRuntimeAcousticsTelemetry>;
  };
  waves: Pick<WaveField, 'significantHeight' | 'dominantPeriod'>;
  /**
   * Whether this vessel has an interior worth muffling.
   *
   * The diagnostic raft has no rooms, and asking `lightRoomAt` about a point
   * inside a raft would answer with the schooner's cabin — the geometry is
   * module-level and knows nothing about which hull is afloat. False skips the
   * lookup entirely rather than producing a confident wrong answer.
   */
  hasInterior: boolean;
}

export class SoundSampler {
  private readonly state = createSoundWorldState();
  private readonly listenerLocal = new THREE.Vector3();
  private readonly toBow = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly inverseVessel = new THREE.Matrix4();

  constructor(private readonly ports: SoundSamplerPorts) {}

  /**
   * Fill the retained state from this frame's canonical values.
   *
   * `sea` and `whitecapCoverage` are passed rather than fetched because the
   * frame has already resolved both and the transaction's whole discipline is
   * that every phase sees the same sea instant. Re-reading the controller's
   * live getter here is exactly the mistake the ocean phase's comment warns
   * about.
   */
  sample(sea: Readonly<SeaState>, whitecapCoverage: number): Readonly<SoundWorldState> {
    const { cameras, vessel, waves } = this.ports;
    const state = this.state;
    const camera = cameras.camera;
    const anchor = vessel.cameraAnchor;

    state.mode = cameras.modeName;

    // Slant distance to the vessel, measured from the camera to the hull's own
    // waterline point rather than to the render origin: in production the
    // anchor's x and z are zero but its y is the live water surface, and a
    // camera two metres above a five-metre crest is not five metres from the
    // ship.
    state.vesselDistanceM = Math.hypot(
      camera.position.x - anchor.x,
      camera.position.y - anchor.waterlineY,
      camera.position.z - anchor.z,
    );

    // The room the *ear* is in, from the listener's ship-local position. Doing
    // it this way rather than from the walker's feet means there is no camera
    // mode branch anywhere in the system: the cinematic camera is outdoors
    // because it is outside the hull, not because of what it is called, and a
    // transition that flies into the cabin muffles when it crosses the deck.
    state.room = this.ports.hasInterior ? this.roomOfListener(anchor) : null;

    state.bowBearingRad = this.bowBearing();

    state.significantHeightM = waves.significantHeight;
    state.dominantPeriodS = waves.dominantPeriod;
    state.whitecapCoverage = whitecapCoverage;
    state.whitewaterGeneration = sea.whitewater.generation;

    const acoustics = vessel.readAcoustics();
    state.apparentWindMps = acoustics.apparentWindMps;
    state.setClothAreaM2 = acoustics.setClothAreaM2;
    state.shakingClothAreaM2 = acoustics.shakingClothAreaM2;
    state.hullWorkRateRadPerS = acoustics.hullWorkRateRadPerS;
    state.speedThroughWaterMps = acoustics.speedThroughWaterMps;

    state.hatchwayBoardsOpen = isClosureOpen('hatchwayBoards');
    state.foreScuttleLidOpen = isClosureOpen('foreScuttleLid');

    return state;
  }

  private roomOfListener(anchor: VesselAnchor): SoundRoomName | null {
    this.inverseVessel.copy(anchor.matrixWorld).invert();
    this.listenerLocal
      .copy(this.ports.cameras.camera.position)
      .applyMatrix4(this.inverseVessel);
    return lightRoomAt(
      this.listenerLocal.x,
      this.listenerLocal.y,
      this.listenerLocal.z,
    );
  }

  /**
   * Signed bearing of the bow from the listener's facing, radians.
   *
   * Horizontal only — the pan law has no elevation term, and pretending
   * otherwise would swing the bow off to one side merely because the camera is
   * looking down at it. Zero when the listener is standing on the bow, which
   * is the degenerate case and the right answer for it.
   *
   * The listener's "right" is derived from its *heading*, not from its own
   * right-hand axis, which makes the bearing immune to camera roll. That
   * matters: the embodied camera inherits a share of the vessel's roll, and a
   * pan that swung as she rolled would put the bow wave in your left ear at
   * the bottom of every roll. Tilting your head does not move the bow.
   */
  private bowBearing(): number {
    const camera = this.ports.cameras.camera;
    this.toBow.copy(this.ports.vessel.bowWorld).sub(camera.position);
    if (this.toBow.x * this.toBow.x + this.toBow.z * this.toBow.z < 1e-8) {
      return 0;
    }

    camera.getWorldDirection(this.forward);
    const fx = this.forward.x;
    const fz = this.forward.z;
    if (fx * fx + fz * fz < 1e-8) {
      // Looking straight up or straight down: the head has no heading at all,
      // the horizontal field collapses, and centre is the only honest answer.
      return 0;
    }

    // Horizontal right of a heading (fx, fz) in this Y-up frame is (-fz, fx).
    // Both vectors share a magnitude, so `atan2` needs neither normalised.
    return Math.atan2(
      this.toBow.x * -fz + this.toBow.z * fx,
      this.toBow.x * fx + this.toBow.z * fz,
    );
  }
}
