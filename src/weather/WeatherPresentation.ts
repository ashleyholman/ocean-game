import * as THREE from 'three';

import type { WorldWind } from '../world/WorldWind';
import { RainField, type RainPoint } from './RainField';
import {
  STORM_EVENT_SLOT_SECONDS,
  lightningEnvelope,
  manualStormEvent,
  stormEventForSlot,
  stormHash01,
  thunderDelaySeconds,
  type StormEvent,
} from './StormEvents';
import type { WeatherState } from './WeatherState';
import { WeatherWindCue } from './WeatherWindCue';

const LIGHTNING_SEGMENTS = 13;
const LIGHTNING_STROKES = LIGHTNING_SEGMENTS - 1;
const MAX_SCHEDULE_CATCHUP_SECONDS = 60;

export interface ThunderCue {
  readonly eventId: number;
  readonly distanceM: number;
  readonly delaySeconds: number;
  readonly intensity: number;
}

export interface WeatherPresentationOptions {
  readonly worldWind: WorldWind;
  readonly frameHeadingDeg: () => number;
  readonly cameraPosition: () => Readonly<RainPoint>;
  readonly anchorPosition: () => Readonly<THREE.Vector3>;
  readonly vesselYawRad?: () => number;
  readonly vesselHalfBeamM?: () => number;
  readonly vesselHalfLengthM?: () => number;
  /** Current horizontal view bearing, used only by the manual review strike. */
  readonly reviewStrikeBearingRad?: () => number;
  readonly playThunder: (cue: Readonly<ThunderCue>) => void;
  /** Existing sky-cache seam. `discontinuous` requests one coherent rebase. */
  readonly setCloudCoverThreshold?: (
    threshold: number,
    discontinuous: boolean,
  ) => void;
  /** Existing ocean-haze seam; no second fog state is retained here. */
  readonly setVisibilityM?: (visibilityM: number) => void;
  readonly windCueVisible?: boolean;
}

export interface WeatherPresentationReading {
  readonly activeRainDrops: number;
  readonly rainEnabled: boolean;
  readonly lightningEnabled: boolean;
  readonly windCueVisible: boolean;
  readonly flashActive: boolean;
  readonly pendingThunder: number;
  readonly lastFlashId: number | null;
  readonly lastThunderId: number | null;
  readonly windSpeedMps: number;
  readonly windDirectionTowardDeg: number;
}

/**
 * Read-only weather presentation. It owns effects, never weather or wind.
 *
 * The weather record supplies precipitation/electrical activity; `WorldWind`
 * supplies every wind vector. This class has no wind setter and cannot create a
 * second gust clock. Its only clock input is absolute presentation time.
 */
export class WeatherPresentation {
  readonly group = new THREE.Group();
  readonly rain = new RainField();
  readonly windCue: WeatherWindCue;

  private readonly lightningPositions = new Float32Array(LIGHTNING_SEGMENTS * 3);
  // WebGL line width is effectively one pixel on the supported browser path.
  // In live storm rain that made a 400–1,300 m bolt indistinguishable from one
  // more rain streak, so the same deterministic polyline is drawn as a small
  // preallocated stack of solid emissive strokes.
  private readonly lightningGeometry = new THREE.CylinderGeometry(1, 1, 1, 6);
  private readonly lightningMaterial = new THREE.MeshBasicMaterial({
    color: 0xdceeff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly lightningBolt: THREE.InstancedMesh;
  private readonly lightningStart = new THREE.Vector3();
  private readonly lightningEnd = new THREE.Vector3();
  private readonly lightningDelta = new THREE.Vector3();
  private readonly lightningMidpoint = new THREE.Vector3();
  private readonly lightningScale = new THREE.Vector3();
  private readonly lightningRotation = new THREE.Quaternion();
  private readonly lightningMatrix = new THREE.Matrix4();
  private readonly lightningAxis = new THREE.Vector3(0, 1, 0);
  private lightningEnabledValue = true;
  private lastElapsedSeconds: number | undefined;
  private currentFlash: StormEvent | null = null;
  private readonly thunderQueue: StormEvent[] = [];
  private manualSequence = 0;
  private lastCloudCeilingM = 500;
  private lastCloudCoverThreshold: number | undefined;
  private lastVisibilityM: number | undefined;
  private lastFlashIdValue: number | null = null;
  private lastThunderIdValue: number | null = null;

  constructor(private readonly options: WeatherPresentationOptions) {
    this.group.name = 'weather:presentation';
    this.lightningBolt = new THREE.InstancedMesh(
      this.lightningGeometry,
      this.lightningMaterial,
      LIGHTNING_STROKES,
    );
    this.lightningBolt.name = 'weather:lightning-bolt';
    this.lightningBolt.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lightningBolt.frustumCulled = false;
    this.lightningBolt.visible = false;
    this.lightningBolt.renderOrder = 9;

    this.windCue = new WeatherWindCue(options.windCueVisible ?? false);
    this.group.add(
      this.rain.lines,
      this.lightningBolt,
      this.windCue.group,
    );
  }

  get rainEnabled(): boolean {
    return this.rain.enabled;
  }

  setRainEnabled(enabled: boolean): void {
    this.rain.enabled = enabled;
  }

  get lightningEnabled(): boolean {
    return this.lightningEnabledValue;
  }

  setLightningEnabled(enabled: boolean): void {
    this.lightningEnabledValue = enabled;
    if (enabled) return;
    this.currentFlash = null;
    this.thunderQueue.length = 0;
    this.hideLightning();
  }

  get windCueVisible(): boolean {
    return this.windCue.enabled;
  }

  setWindCueVisible(visible: boolean): void {
    this.windCue.enabled = visible;
  }

  get reading(): WeatherPresentationReading {
    return {
      activeRainDrops: this.rain.activeDrops,
      rainEnabled: this.rain.enabled,
      lightningEnabled: this.lightningEnabledValue,
      windCueVisible: this.windCue.enabled,
      flashActive: this.lightningBolt.visible,
      pendingThunder: this.thunderQueue.length,
      lastFlashId: this.lastFlashIdValue,
      lastThunderId: this.lastThunderIdValue,
      windSpeedMps: this.options.worldWind.instantaneousSpeedMps,
      windDirectionTowardDeg:
        this.options.worldWind.instantaneousDirectionTowardDeg,
    };
  }

  /** One presentation frame, after camera and authoritative `WorldWind` update. */
  update(elapsedSeconds: number, state: Readonly<WeatherState>): void {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError(
        `weather presentation elapsed must be finite and >= 0, got ${elapsedSeconds}`,
      );
    }
    this.applyEnvironment(state);
    this.lastCloudCeilingM = state.cloudCeilingM;
    this.rain.update(
      elapsedSeconds,
      state.precipRateMmPerHour,
      this.options.cameraPosition(),
      this.options.worldWind,
      this.options.frameHeadingDeg(),
    );
    this.windCue.update(
      this.options.worldWind,
      this.options.frameHeadingDeg(),
      this.options.anchorPosition(),
      this.options.vesselYawRad?.() ?? 0,
      this.options.cameraPosition(),
      this.options.vesselHalfBeamM?.(),
      this.options.vesselHalfLengthM?.(),
    );
    this.updateStorm(elapsedSeconds, state.electricalActivity);
  }

  /**
   * Publish WeatherState into the established sky/ocean environment seams.
   * Called before lighting derivation in production; `update` repeats it as an
   * idempotent convenience for diagnostic hosts that only run presentation.
   */
  applyEnvironment(state: Readonly<WeatherState>): void {
    if (state.cloudCoverThreshold !== this.lastCloudCoverThreshold) {
      const previous = this.lastCloudCoverThreshold;
      this.options.setCloudCoverThreshold?.(
        state.cloudCoverThreshold,
        previous !== undefined &&
          Math.abs(state.cloudCoverThreshold - previous) >= 0.08,
      );
      this.lastCloudCoverThreshold = state.cloudCoverThreshold;
    }
    if (state.visibilityM !== this.lastVisibilityM) {
      this.options.setVisibilityM?.(state.visibilityM);
      this.lastVisibilityM = state.visibilityM;
    }
  }

  /** Deterministic review strike; its thunder uses the same delayed queue. */
  triggerLightning(): void {
    if (!this.lightningEnabledValue) return;
    const elapsedSeconds = this.lastElapsedSeconds ?? 0;
    const authored = manualStormEvent(elapsedSeconds, this.manualSequence++);
    const reviewBearingRad = this.options.reviewStrikeBearingRad?.();
    this.beginFlash(
      Number.isFinite(reviewBearingRad)
        ? { ...authored, bearingRad: reviewBearingRad! }
        : authored,
      this.lastCloudCeilingM,
    );
  }

  reset(elapsedSeconds = 0): void {
    this.lastElapsedSeconds = elapsedSeconds;
    this.currentFlash = null;
    this.thunderQueue.length = 0;
    this.manualSequence = 0;
    this.lastCloudCoverThreshold = undefined;
    this.lastVisibilityM = undefined;
    this.lastFlashIdValue = null;
    this.lastThunderIdValue = null;
    this.hideLightning();
  }

  dispose(): void {
    this.rain.dispose();
    this.windCue.dispose();
    this.lightningGeometry.dispose();
    this.lightningMaterial.dispose();
    this.group.clear();
  }

  private updateStorm(elapsedSeconds: number, electricalActivity: number): void {
    const previous = this.lastElapsedSeconds;
    this.lastElapsedSeconds = elapsedSeconds;
    if (!this.lightningEnabledValue) return;

    if (
      previous === undefined ||
      elapsedSeconds < previous ||
      elapsedSeconds - previous > MAX_SCHEDULE_CATCHUP_SECONDS
    ) {
      // A first frame, reset or resumed background tab establishes a baseline;
      // it does not replay a wall of old flashes and thunder into the present.
      this.currentFlash = null;
      this.thunderQueue.length = 0;
      this.hideLightning();
      return;
    }

    if (electricalActivity > 0 && elapsedSeconds > previous) {
      const firstSlot = Math.max(
        0,
        Math.floor(previous / STORM_EVENT_SLOT_SECONDS),
      );
      const lastSlot = Math.floor(elapsedSeconds / STORM_EVENT_SLOT_SECONDS);
      for (let slot = firstSlot; slot <= lastSlot; slot++) {
        const event = stormEventForSlot(slot, electricalActivity);
        if (
          event &&
          event.flashAtSeconds > previous &&
          event.flashAtSeconds <= elapsedSeconds
        ) {
          this.beginFlash(event, this.lastCloudCeilingM);
        }
      }
    }

    while (
      this.thunderQueue.length > 0 &&
      this.thunderQueue[0].thunderAtSeconds <= elapsedSeconds
    ) {
      const event = this.thunderQueue.shift()!;
      this.lastThunderIdValue = event.id;
      this.options.playThunder({
        eventId: event.id,
        distanceM: event.distanceM,
        delaySeconds: thunderDelaySeconds(event.distanceM),
        intensity: event.intensity,
      });
    }

    const flash = this.currentFlash;
    const envelope = flash
      ? lightningEnvelope(elapsedSeconds - flash.flashAtSeconds) * flash.intensity
      : 0;
    if (envelope <= 0) {
      if (flash && elapsedSeconds - flash.flashAtSeconds >= 0.24) {
        this.currentFlash = null;
      }
      this.hideLightning();
      return;
    }
    this.lightningBolt.visible = true;
    this.lightningMaterial.opacity = Math.min(1, 0.25 + envelope * 0.9);
  }

  private beginFlash(event: StormEvent, cloudCeilingM: number): void {
    this.currentFlash = event;
    this.lastFlashIdValue = event.id;
    this.thunderQueue.push(event);
    this.thunderQueue.sort((a, b) => a.thunderAtSeconds - b.thunderAtSeconds);

    const anchor = this.options.anchorPosition();
    const strikeX = anchor.x + Math.sin(event.bearingRad) * event.distanceM;
    const strikeZ = anchor.z - Math.cos(event.bearingRad) * event.distanceM;
    const topY = Math.max(anchor.y + 160, cloudCeilingM);
    const bottomY = 0.4;
    for (let index = 0; index < LIGHTNING_SEGMENTS; index++) {
      const t = index / (LIGHTNING_SEGMENTS - 1);
      const taper = Math.sin(t * Math.PI);
      const jitterX =
        (stormHash01(event.id, 30 + index) - 0.5) * 24 * taper;
      const jitterZ =
        (stormHash01(event.id, 60 + index) - 0.5) * 24 * taper;
      const offset = index * 3;
      this.lightningPositions[offset] = strikeX + jitterX;
      this.lightningPositions[offset + 1] = topY + (bottomY - topY) * t;
      this.lightningPositions[offset + 2] = strikeZ + jitterZ;
    }
    // At these deliberately reviewable ranges, a physically thin channel is
    // sub-pixel. Grow only its presentation width with distance so the bolt
    // stays a clear two-to-four-pixel event without moving or brightening it.
    const strokeRadiusM = 0.9 + event.distanceM * 0.001;
    for (let index = 0; index < LIGHTNING_STROKES; index++) {
      const startOffset = index * 3;
      const endOffset = (index + 1) * 3;
      this.lightningStart.set(
        this.lightningPositions[startOffset],
        this.lightningPositions[startOffset + 1],
        this.lightningPositions[startOffset + 2],
      );
      this.lightningEnd.set(
        this.lightningPositions[endOffset],
        this.lightningPositions[endOffset + 1],
        this.lightningPositions[endOffset + 2],
      );
      this.lightningDelta.subVectors(this.lightningEnd, this.lightningStart);
      const lengthM = this.lightningDelta.length();
      this.lightningMidpoint
        .copy(this.lightningStart)
        .add(this.lightningEnd)
        .multiplyScalar(0.5);
      this.lightningRotation.setFromUnitVectors(
        this.lightningAxis,
        this.lightningDelta.multiplyScalar(1 / Math.max(lengthM, 1e-6)),
      );
      this.lightningScale.set(strokeRadiusM, lengthM, strokeRadiusM);
      this.lightningMatrix.compose(
        this.lightningMidpoint,
        this.lightningRotation,
        this.lightningScale,
      );
      this.lightningBolt.setMatrixAt(index, this.lightningMatrix);
    }
    this.lightningBolt.instanceMatrix.needsUpdate = true;
    this.lightningBolt.visible = true;
  }

  private hideLightning(): void {
    this.lightningBolt.visible = false;
    this.lightningMaterial.opacity = 0;
  }
}
