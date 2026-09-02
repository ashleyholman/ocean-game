import * as THREE from 'three';
import type { VesselFramingEnvelope } from './types';

/**
 * Capture an assembled vessel's axis-aligned local bounds as eight stable points.
 *
 * `Box3.setFromObject` sees every mesh already attached to the vessel. Capturing
 * once, after construction, means a later mast/rig round automatically enlarges
 * the camera subject without putting a second copy of those dimensions in the
 * camera. The returned vectors are vessel-local, so the controller can apply the
 * current presentation matrix without rebuilding a box or allocating per frame.
 */
export function vesselFramingEnvelope(object: THREE.Object3D): VesselFramingEnvelope {
  object.updateMatrixWorld(true);
  const worldBounds = new THREE.Box3().setFromObject(object, true);
  if (worldBounds.isEmpty()) return vesselFramingEnvelopeFromPoints([new THREE.Vector3()]);

  const toLocal = object.matrixWorld.clone().invert();
  const { min, max } = worldBounds;
  const points: THREE.Vector3[] = [];
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        points.push(new THREE.Vector3(x, y, z).applyMatrix4(toLocal));
      }
    }
  }
  return vesselFramingEnvelopeFromPoints(points);
}

/** Build the same immutable envelope for synthetic vessels in tests/tools. */
export function vesselFramingEnvelopeFromPoints(
  source: readonly THREE.Vector3[],
): VesselFramingEnvelope {
  const points = source.length > 0
    ? source.map((point) => point.clone())
    : [new THREE.Vector3()];
  const bounds = new THREE.Box3().setFromPoints(points);
  const size = bounds.getSize(new THREE.Vector3());
  return {
    points: Object.freeze(points),
    widthM: size.x,
    heightM: size.y,
    lengthM: size.z,
    radiusM: size.length() * 0.5,
  };
}

/** Compatibility helper for callers that only need the stable corner list. */
export function vesselFramingPoints(object: THREE.Object3D): readonly THREE.Vector3[] {
  return vesselFramingEnvelope(object).points;
}
