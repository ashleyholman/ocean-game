import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SH_FLOAT_COUNT,
  equirectCosineIrradiance,
  equirectDirection,
  projectEquirectToSh,
  shIrradiance,
} from '../src/scene/sphericalHarmonics';
import {
  getPortalSkySource,
  samplePortalSkyIrradiance,
  setPortalSkySampler,
  setPortalSkySource,
  setWorldSh,
} from '../src/scene/WorldPbrMaterial';

/**
 * §17.5's fix: the portal channels integrate the world source map directly
 * instead of reconstructing through the L2 SH. Two things are under test —
 * the integral itself (same conventions as the projection, so the two paths
 * agree wherever the basis is adequate), and the bus that switches between
 * them (the A/B must fall back to the SH whenever the map has nothing).
 */

const W = 128;
const H = 64;

function makeMap(radiance: (dir: [number, number, number]) => [number, number, number]): Float32Array {
  const data = new Float32Array(W * H * 4);
  const dir: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      equirectDirection((i + 0.5) / W, (j + 0.5) / H, dir);
      const [r, g, b] = radiance(dir);
      const p = (j * W + i) * 4;
      data[p] = r;
      data[p + 1] = g;
      data[p + 2] = b;
      data[p + 3] = 1;
    }
  }
  return data;
}

describe('equirectCosineIrradiance', () => {
  it('returns pi*L for a uniform sphere, any normal', () => {
    const map = makeMap(() => [2, 1, 0.5]);
    const normals: Array<[number, number, number]> = [
      [0, 1, 0],
      [0, -1, 0],
      [1, 0, 0],
      [0.6, 0.48, 0.64],
    ];
    for (const [x, y, z] of normals) {
      const [r, g, b] = equirectCosineIrradiance(map, W, H, x, y, z);
      expect(r).toBeCloseTo(2 * Math.PI, 2);
      expect(g).toBeCloseTo(1 * Math.PI, 2);
      expect(b).toBeCloseTo(0.5 * Math.PI, 2);
    }
  });

  it('sees nothing from a source entirely behind the plane', () => {
    // Sky-only map: radiance in the upper hemisphere, none below.
    const map = makeMap((d) => (d[1] > 0 ? [1, 1, 1] : [0, 0, 0]));
    const down = equirectCosineIrradiance(map, W, H, 0, -1, 0);
    const up = equirectCosineIrradiance(map, W, H, 0, 1, 0);
    expect(down[0]).toBeLessThan(up[0] * 0.02);
    expect(up[0]).toBeCloseTo(Math.PI, 1);
  });

  it('agrees with the SH path on a sky the basis can hold', () => {
    // A smooth gradient sky is inside L2's competence; the two paths must
    // agree there, or the A/B is comparing different suns.
    const map = makeMap((d) => {
      const t = 0.5 + 0.5 * d[1];
      return [0.4 + 0.6 * t, 0.5 + 0.5 * t, 0.7 + 0.3 * t];
    });
    const sh = projectEquirectToSh(map, W, H, new Float32Array(SH_FLOAT_COUNT));
    for (const [x, y, z] of [
      [0, 1, 0],
      [0.8, 0.6, 0],
      [0, 0.2, 0.98],
    ] as Array<[number, number, number]>) {
      const direct = equirectCosineIrradiance(map, W, H, x, y, z);
      const viaSh = shIrradiance(sh, x, y, z, [0, 0, 0]);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(direct[c] - viaSh[c]) / viaSh[c]).toBeLessThan(0.03);
      }
    }
  });

  it('documents the L2 misstatement on a spiky sky the map path is immune to', () => {
    // A compact 60x solar cap over a dim sky. The L2 basis smears the cap's
    // energy into its constant band and INFLATES the anti-solar irradiance
    // ~1.8x; the direct integral is exact by construction. On the game's
    // real sky the two paths agree within ~2% at every measured hour
    // (§17.6 — which is how the dusk darkness was proven honest); this
    // pathological map is why the map path exists anyway: the day the sky
    // grows a spike the basis cannot hold, the channels do not inherit it.
    const sunDir: [number, number, number] = [1, 0.05, 0];
    const map = makeMap((d) => {
      const toSun = d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2];
      const lobe = toSun > 0.9 ? 60 : 0;
      const sky = d[1] > 0 ? 1 : 0.15;
      return [sky + lobe, sky + lobe, sky + lobe];
    });
    const sh = projectEquirectToSh(map, W, H, new Float32Array(SH_FLOAT_COUNT));
    const antiSolar = equirectCosineIrradiance(map, W, H, -1, 0.05, 0);
    const viaSh = shIrradiance(sh, -1, 0.05, 0, [0, 0, 0]);
    expect(viaSh[0]).toBeGreaterThan(antiSolar[0] * 1.3);
  });
});

describe('the portal-sky bus', () => {
  afterEach(() => {
    setPortalSkySampler(null);
    setPortalSkySource('map');
  });

  it('defaults to the map and falls back to the SH when it has nothing', () => {
    expect(getPortalSkySource()).toBe('map');
    const sh = new Float32Array(SH_FLOAT_COUNT);
    sh[0] = 1; // constant band: uniform-ish SH sky
    sh[1] = 0.5;
    sh[2] = 0.25;
    setWorldSh(sh);
    // No sampler installed: the map side must answer through the SH.
    const out = new THREE.Vector3();
    samplePortalSkyIrradiance(new THREE.Vector3(0, 1, 0), out);
    expect(out.x).toBeGreaterThan(0);
    const shAnswer = out.clone();

    // A sampler that declines (pre-first-readback) must also yield the SH.
    setPortalSkySampler(() => false);
    samplePortalSkyIrradiance(new THREE.Vector3(0, 1, 0), out);
    expect(out.equals(shAnswer)).toBe(true);
  });

  it('uses the sampler when it answers, and the SH when switched to sh', () => {
    setPortalSkySampler((_direction, out) => {
      out.set(7, 8, 9);
      return true;
    });
    const out = new THREE.Vector3();
    samplePortalSkyIrradiance(new THREE.Vector3(0, 1, 0), out);
    expect(out.x).toBe(7);

    setPortalSkySource('sh');
    samplePortalSkyIrradiance(new THREE.Vector3(0, 1, 0), out);
    expect(out.x).not.toBe(7);
  });
});
