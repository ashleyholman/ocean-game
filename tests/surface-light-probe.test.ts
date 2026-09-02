import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SurfaceLightProbe } from '../src/runtime/diagnostics/SurfaceLightProbe';
import { setPortalLight } from '../src/scene/WorldPbrMaterial';
import { applyToneCurve } from '../src/scene/toneMapping';
import { bakeEnclosedPortalLight } from '../src/vessel/schooner/interiorLightBake';
import {
  CHANNEL_WINDOWS,
  interiorLightModel,
  vertexLightResponse,
} from '../src/vessel/schooner/interiorLight';
import { findStation } from '../src/vessel/schooner/stations';

/**
 * The inspection probe is an instrument, and an instrument that drifts from
 * the thing it measures is worse than none. These tests hold its arithmetic
 * to the modules it reports on: the bake it interpolates, the model it
 * recomputes, and the tone curve it predicts display values through.
 */

/** A small vertical plane standing in the captain's cabin, facing forward. */
function cabinWallMesh(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(0.6, 0.6);
  // PlaneGeometry faces +z already; place it mid-cabin like the aft wall.
  geometry.translate(0, 3.4, -7.2);
  bakeEnclosedPortalLight(geometry);
  const material = new THREE.MeshStandardMaterial({
    color: 0x808080,
    name: 'test:cabin-wall',
  });
  material.defines = { WORLD_PBR_PORTAL_LIGHT: '' };
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'test:cabin-wall';
  return mesh;
}

function probeFor(target: THREE.Object3D, group: THREE.Object3D): SurfaceLightProbe {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 50);
  camera.position.set(0, 3.4, -5.2);
  camera.lookAt(0, 3.4, -7.2);
  camera.updateMatrixWorld();
  return new SurfaceLightProbe({
    camera: () => camera,
    target: () => target,
    vesselGroup: () => group,
    sun: () => ({
      directionWorld: new THREE.Vector3(0, 1, 0),
      color: new THREE.Color(1, 0.9, 0.8),
      intensity: 5,
    }),
    exposure: () => 11.8,
  });
}

describe('SurfaceLightProbe', () => {
  it('reports baked attributes that match the model recomputation', () => {
    const group = new THREE.Group();
    const mesh = cabinWallMesh();
    group.add(mesh);
    group.updateMatrixWorld(true);
    const probe = probeFor(mesh, group);

    const sample = probe.probeNdc(0, 0);
    expect(sample).not.toBeNull();
    expect(sample!.room).toBe('cabin');
    expect(sample!.portalMaterial).toBe(true);
    expect(sample!.baked).not.toBeNull();
    // The plane is flat and the bake is linear over it, so interpolated
    // attributes must equal the model's answer at the interpolated point to
    // within interpolation error across a 0.6 m face.
    for (let p = 0; p < 4; p++) {
      expect(sample!.baked!.direct[p]).toBeCloseTo(sample!.model!.direct[p], 2);
      expect(sample!.baked!.bounce[p]).toBeCloseTo(sample!.model!.bounce[p], 2);
    }
    expect(sample!.baked!.skyVisibility).toBe(0);
  });

  it('sums terms into total and predicts display through the real tone curve', () => {
    const group = new THREE.Group();
    const mesh = cabinWallMesh();
    group.add(mesh);
    group.updateMatrixWorld(true);
    const probe = probeFor(mesh, group);

    // Give the windows channel a known light and dark the rest.
    for (let p = 0; p < 4; p++) {
      const zero = new THREE.Vector3();
      setPortalLight(p, zero, zero);
    }
    setPortalLight(
      CHANNEL_WINDOWS,
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(0.5, 0.5, 0.5),
    );

    const sample = probe.probeNdc(0, 0)!;
    const direct = sample.baked!.direct[CHANNEL_WINDOWS];
    // The default bath-gradient mix is 1, so the effective bounce is the
    // gradient bake — the same mix the vertex stage applies.
    const bounce = sample.baked!.bounceGradient[CHANNEL_WINDOWS];
    expect(sample.terms.portalDirect!.rgb[0]).toBeCloseTo(direct, 6);
    expect(sample.terms.portalBounce!.rgb[0]).toBeCloseTo(bounce * 0.5, 6);

    // An interior wall sees no sky and, facing forward under a zenith sun
    // with a plane for a world, no beam either (cosine is zero).
    expect(sample.terms.sky.lum).toBe(0);
    expect(sample.terms.sun.cosine).toBe(0);

    const expectedTotal = direct + bounce * 0.5;
    expect(sample.terms.total.rgb[0]).toBeCloseTo(expectedTotal, 6);

    const expectedRadiance = (expectedTotal * sample.albedo.rgb[0]) / Math.PI;
    expect(sample.radiance.rgb[0]).toBeCloseTo(expectedRadiance, 6);
    const expectedDisplay = applyToneCurve(
      [
        expectedRadiance,
        (expectedTotal * sample.albedo.rgb[1]) / Math.PI,
        (expectedTotal * sample.albedo.rgb[2]) / Math.PI,
      ],
      11.8,
    );
    expect(sample.display.tonemapped.rgb[0]).toBeCloseTo(expectedDisplay[0], 6);
  });

  it('point probes answer without a camera and agree with the model', () => {
    const group = new THREE.Group();
    group.updateMatrixWorld(true);
    const probe = probeFor(group, group);

    const sample = probe.probePoint(0, 3.4, -7.2, 0, 0, 1);
    const model = interiorLightModel();
    const expected = vertexLightResponse(model, 0, 3.4, -7.2, 0, 0, 1);
    expect(sample.room).toBe('cabin');
    for (let p = 0; p < 4; p++) {
      expect(sample.model!.direct[p]).toBeCloseTo(expected.direct[p], 6);
      expect(sample.model!.bounce[p]).toBeCloseTo(expected.bounce[p], 6);
    }
  });

  it('grid cells carry identity and luminance for every ray', () => {
    const group = new THREE.Group();
    const mesh = cabinWallMesh();
    group.add(mesh);
    group.updateMatrixWorld(true);
    const probe = probeFor(mesh, group);

    const grid = probe.probeGrid(4, 3);
    expect(grid).toHaveLength(12);
    const hits = grid.filter((cell) => cell.object !== null);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.object).toBe('test:cabin-wall');
      expect(hit.room).toBe('cabin');
      expect(hit.displayLum).not.toBeNull();
    }
  });
});

describe('stations', () => {
  it('finds stations case-insensitively for URL parameters', () => {
    expect(findStation('cabin')?.label).toBe('Cabin');
    expect(findStation('Ladder foot')?.label).toBe('Ladder foot');
    expect(findStation('nowhere')).toBeUndefined();
  });
});
