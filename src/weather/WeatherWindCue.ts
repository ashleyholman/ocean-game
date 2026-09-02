import * as THREE from 'three';

import type { WorldWind } from '../world/WorldWind';
import { windRenderHeadingRad } from '../world/WorldWind';

export interface WeatherWindCueSample {
  readonly directionX: number;
  readonly directionZ: number;
  readonly speedMps: number;
  readonly lengthM: number;
}

interface WeatherWindCuePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function sampleWeatherWindCue(
  worldWind: WorldWind,
  frameHeadingDeg: number,
): WeatherWindCueSample {
  const speedMps = worldWind.instantaneousSpeedMps;
  const heading = windRenderHeadingRad(
    worldWind.instantaneousDirectionTowardDeg,
    frameHeadingDeg,
  );
  return {
    directionX: Math.sin(heading),
    directionZ: -Math.cos(heading),
    speedMps,
    lengthM: 1.5 + Math.min(speedMps, 24) * (5.5 / 24),
  };
}

/** A developer-visible vector laid into the world beside the vessel. */
export class WeatherWindCue {
  readonly group = new THREE.Group();

  // ArrowHelper's shaft is a one-pixel GL line. The first live eye pass found
  // that it collapsed to a cyan dot in ordinary embodied and orbit views,
  // especially when the vector pointed partly toward the camera. A box shaft
  // and solid head retain a readable silhouette from every viewing altitude.
  private readonly arrowMaterial = new THREE.MeshBasicMaterial({
    color: 0x61d9ff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  private readonly shaftGeometry = new THREE.BoxGeometry(0.22, 0.34, 1);
  private readonly shaft = new THREE.Mesh(
    this.shaftGeometry,
    this.arrowMaterial,
  );
  private readonly headGeometry = new THREE.ConeGeometry(0.48, 0.9, 20);
  private readonly head = new THREE.Mesh(this.headGeometry, this.arrowMaterial);
  private readonly ringGeometry = new THREE.TorusGeometry(1.1, 0.09, 12, 64);
  private readonly ringMaterial = new THREE.MeshBasicMaterial({
    color: 0x61d9ff,
    transparent: true,
    opacity: 0.52,
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  private readonly ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
  private readonly direction = new THREE.Vector3(0, 0, -1);
  private readonly localShaftAxis = new THREE.Vector3(0, 0, 1);
  private readonly localHeadAxis = new THREE.Vector3(0, 1, 0);
  private enabledValue = false;
  private sampleValue: WeatherWindCueSample = {
    directionX: 0,
    directionZ: -1,
    speedMps: 0,
    lengthM: 1.5,
  };

  constructor(enabled = false) {
    this.group.name = 'weather:world-wind-cue';
    this.ring.name = 'weather:wind-origin-ring';
    this.shaft.name = 'weather:wind-shaft';
    this.head.name = 'weather:wind-head';
    this.ring.rotation.x = Math.PI / 2;
    this.ring.position.y = 0.025;
    // This is an optional teaching overlay, so ocean submission must not
    // erase it after it has been drawn. Its first live eye pass found the cue
    // enabled and correctly sampled but entirely absent from every orbit.
    for (const object of [this.ring, this.shaft, this.head]) {
      object.renderOrder = 20;
      object.frustumCulled = false;
    }
    this.group.add(this.ring, this.shaft, this.head);
    this.enabled = enabled;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  set enabled(enabled: boolean) {
    this.enabledValue = enabled;
    this.group.visible = enabled;
  }

  get sample(): Readonly<WeatherWindCueSample> {
    return this.sampleValue;
  }

  update(
    worldWind: WorldWind,
    frameHeadingDeg: number,
    anchor: Readonly<WeatherWindCuePoint>,
    vesselYawRad = 0,
    observer?: Readonly<WeatherWindCuePoint>,
    vesselHalfBeamM = 3.7,
    vesselHalfLengthM = 20,
  ): void {
    const sample = sampleWeatherWindCue(worldWind, frameHeadingDeg);
    this.sampleValue = sample;
    if (!this.enabledValue) return;
    this.direction.set(sample.directionX, 0, sample.directionZ);
    // Preserve the speed-reading length across vessels, but do not draw the
    // schooner's metre-wide arrowhead beside a 2.2 m-wide raft. The first raft
    // eye pass found that the fixed cross-section read as a large cyan object
    // attached to the craft rather than a lightweight teaching overlay.
    const presentationScale = THREE.MathUtils.clamp(
      vesselHalfBeamM / 3.7,
      0.4,
      1,
    );
    const headLength = Math.min(
      0.9 * presentationScale,
      sample.lengthM * 0.24,
    );
    const shaftLength = Math.max(0.3, sample.lengthM - headLength);
    this.shaft.scale.set(
      presentationScale,
      presentationScale,
      shaftLength,
    );
    this.shaft.position.copy(this.direction).multiplyScalar(shaftLength * 0.5);
    this.shaft.position.y = 0.2;
    this.shaft.quaternion.setFromUnitVectors(
      this.localShaftAxis,
      this.direction,
    );
    this.head.scale.set(
      presentationScale,
      headLength / 0.9,
      presentationScale,
    );
    this.head.position
      .copy(this.direction)
      .multiplyScalar(shaftLength + headLength * 0.5);
    this.head.position.y = 0.2;
    this.head.quaternion.setFromUnitVectors(this.localHeadAxis, this.direction);
    this.ring.scale.setScalar(presentationScale);
    // Beside the forward waist, floating above the bulwark as a teaching aid.
    // The original fixed world-X offset put the cue back inside a yawed hull;
    // rotate both the local side and forward offsets with the vessel instead.
    // The forward component also keeps it inside the standard helm field of
    // view; directly abeam required the player to know where to look first.
    const starboardX = -Math.cos(vesselYawRad);
    const starboardZ = Math.sin(vesselYawRad);
    const forwardX = Math.sin(vesselYawRad);
    const forwardZ = Math.cos(vesselYawRad);
    const observerSide = observer
      ? (observer.x - anchor.x) * starboardX +
        (observer.z - anchor.z) * starboardZ
      : 1;
    const nearSide = observerSide < 0 ? -1 : 1;
    const sideDistanceM = Math.max(1.8, vesselHalfBeamM + 1.5);
    const forwardDistanceM = Math.min(
      6,
      Math.max(1.6, vesselHalfLengthM * 0.3),
    );
    const sideX = sideDistanceM * starboardX * nearSide;
    const sideZ = sideDistanceM * starboardZ * nearSide;
    this.group.position.set(
      anchor.x + sideX + forwardX * forwardDistanceM,
      anchor.y + 1.1,
      anchor.z + sideZ + forwardZ * forwardDistanceM,
    );
  }

  dispose(): void {
    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.shaftGeometry.dispose();
    this.headGeometry.dispose();
    this.arrowMaterial.dispose();
    this.group.clear();
  }
}
