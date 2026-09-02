import * as THREE from 'three';

import type { WorldWind } from '../world/WorldWind';
import { windRenderHeadingRad, windRenderVector } from '../world/WorldWind';

export const RAIN_MAX_DROPS = 1400;
export const RAIN_MAX_RATE_MM_PER_HOUR = 40;
export const RAIN_SEED = 0x5241494e; // 'RAIN'

export const RAIN_HORIZONTAL_SPAN_M = 74;
export const RAIN_VERTICAL_SPAN_M = 34;
const FALL_SPEED_MPS = 18;
const WIND_DRIFT_FRACTION = 0.34;

export interface RainPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RainVector {
  x: number;
  z: number;
}

export interface RainDropSegment {
  headX: number;
  headY: number;
  headZ: number;
  tailX: number;
  tailY: number;
  tailZ: number;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function rainHash01(index: number, channel: number, seed = RAIN_SEED): number {
  return (
    mix32(seed ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(channel + 1, 0x85ebca77)) /
    0x1_0000_0000
  );
}

function wrapCentred(value: number, span: number): number {
  return ((value + span * 0.5) % span + span) % span - span * 0.5;
}

export function rainDropCount(
  precipitationMmPerHour: number,
  maximum = RAIN_MAX_DROPS,
): number {
  const rate = Math.min(
    RAIN_MAX_RATE_MM_PER_HOUR,
    Math.max(0, precipitationMmPerHour),
  );
  return Math.round(maximum * Math.sqrt(rate / RAIN_MAX_RATE_MM_PER_HOUR));
}

/**
 * Sample one periodic, world-anchored streak without allocating.
 *
 * Camera position only selects which periodic image is nearby. Inside a cell,
 * moving the camera does not move the drop; time supplies the fall, while the
 * present `WorldWind` vector supplies the streak's lean.
 */
export function sampleRainDrop(
  index: number,
  elapsedSeconds: number,
  camera: Readonly<RainPoint>,
  presentWind: Readonly<RainVector>,
  out: RainDropSegment,
  seed = RAIN_SEED,
): RainDropSegment {
  // Horizontal phase is fixed in world space. Recomputing an accumulated
  // advection as `presentWind * elapsed` would teleport the whole field when a
  // preset changed direction; the present wind belongs in the streak velocity
  // below, where it changes lean without moving an already-falling drop.
  const worldX =
    (rainHash01(index, 0, seed) - 0.5) * RAIN_HORIZONTAL_SPAN_M;
  const worldZ =
    (rainHash01(index, 1, seed) - 0.5) * RAIN_HORIZONTAL_SPAN_M;
  const worldY =
    (rainHash01(index, 2, seed) - 0.5) * RAIN_VERTICAL_SPAN_M -
    FALL_SPEED_MPS * elapsedSeconds;

  out.headX =
    camera.x + wrapCentred(worldX - camera.x, RAIN_HORIZONTAL_SPAN_M);
  out.headY =
    camera.y + wrapCentred(worldY - camera.y, RAIN_VERTICAL_SPAN_M);
  out.headZ =
    camera.z + wrapCentred(worldZ - camera.z, RAIN_HORIZONTAL_SPAN_M);

  const velocityX = presentWind.x * WIND_DRIFT_FRACTION;
  const velocityZ = presentWind.z * WIND_DRIFT_FRACTION;
  const speed = Math.hypot(velocityX, FALL_SPEED_MPS, velocityZ);
  const length = 0.62 + rainHash01(index, 3, seed) * 0.72;
  out.tailX = out.headX - (velocityX / speed) * length;
  out.tailY = out.headY + (FALL_SPEED_MPS / speed) * length;
  out.tailZ = out.headZ - (velocityZ / speed) * length;
  return out;
}

const scratchWind: RainVector = { x: 0, z: 0 };
const scratchSegment: RainDropSegment = {
  headX: 0,
  headY: 0,
  headZ: 0,
  tailX: 0,
  tailY: 0,
  tailZ: 0,
};

/** Near-rain line field. All storage is allocated once; updates rewrite it in place. */
export class RainField {
  readonly lines: THREE.LineSegments;

  private readonly positions = new Float32Array(RAIN_MAX_DROPS * 2 * 3);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: 0xb7cad4,
    transparent: true,
    opacity: 0.44,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
  private enabledValue = true;
  private activeDropsValue = 0;

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = 'weather:near-rain';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    this.lines.visible = false;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  set enabled(enabled: boolean) {
    this.enabledValue = enabled;
    if (!enabled) this.lines.visible = false;
  }

  get activeDrops(): number {
    return this.activeDropsValue;
  }

  update(
    elapsedSeconds: number,
    precipitationMmPerHour: number,
    camera: Readonly<RainPoint>,
    worldWind: WorldWind,
    frameHeadingDeg: number,
  ): void {
    const count = this.enabledValue ? rainDropCount(precipitationMmPerHour) : 0;
    this.activeDropsValue = count;
    this.lines.visible = count > 0;
    this.geometry.setDrawRange(0, count * 2);
    if (count === 0) return;

    windRenderVector(
      windRenderHeadingRad(
        worldWind.instantaneousDirectionTowardDeg,
        frameHeadingDeg,
      ),
      worldWind.instantaneousSpeedMps,
      scratchWind,
    );
    for (let index = 0; index < count; index++) {
      sampleRainDrop(index, elapsedSeconds, camera, scratchWind, scratchSegment);
      const offset = index * 6;
      this.positions[offset] = scratchSegment.headX;
      this.positions[offset + 1] = scratchSegment.headY;
      this.positions[offset + 2] = scratchSegment.headZ;
      this.positions[offset + 3] = scratchSegment.tailX;
      this.positions[offset + 4] = scratchSegment.tailY;
      this.positions[offset + 5] = scratchSegment.tailZ;
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
