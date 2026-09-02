import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { TimeOfDay } from '../src/scene/TimeOfDay';

import {
  GLSL_SKY_PROBE,
  lobeCoverage,
  SH_COEFFICIENTS,
  evaluateSkyProbe,
  fibonacciHemisphere,
  flatProbe,
  shBasis,
} from '../src/scene/skyHarmonics';

/** Project a radiance function over the upper hemisphere onto the L2 basis. */
function project(
  directions: ReadonlyArray<readonly [number, number, number]>,
  radiance: (x: number, y: number, z: number) => [number, number, number],
): Float32Array {
  const coefficients = new Float32Array(SH_COEFFICIENTS * 3);
  const basis: number[] = [];
  // Equal solid angle per sample: the hemisphere is 2*PI steradians.
  const dOmega = (2 * Math.PI) / directions.length;
  for (const [x, y, z] of directions) {
    const l = radiance(x, y, z);
    shBasis(x, y, z, basis);
    for (let i = 0; i < SH_COEFFICIENTS; i++) {
      coefficients[i * 3] += l[0] * basis[i] * dOmega;
      coefficients[i * 3 + 1] += l[1] * basis[i] * dOmega;
      coefficients[i * 3 + 2] += l[2] * basis[i] * dOmega;
    }
  }
  return coefficients;
}

const UP: [number, number, number] = [0, 1, 0];

describe('sky harmonics', () => {
  it('samples equal solid angle, with no repeated elevation or azimuth', () => {
    const points = fibonacciHemisphere(64);
    expect(points.length).toBe(64);
    for (const [x, y, z] of points) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
      expect(y).toBeGreaterThan(0);
    }
    // The set this replaced put six samples on each of two rings, which is what
    // made it useless for fitting anything above l=0. No two samples here may
    // share an elevation.
    const elevations = new Set(points.map(([, y]) => y.toFixed(6)));
    expect(elevations.size).toBe(64);
  });

  it('is orthonormal on the sphere, so a projection is a projection', () => {
    // Full sphere this time: orthonormality is a property of the basis, and if
    // it does not hold the coefficients are not independent and the
    // reconstruction is not the least-squares fit it is claimed to be.
    const count = 20000;
    const basis: number[] = [];
    const gram = Array.from({ length: SH_COEFFICIENTS }, () =>
      new Array<number>(SH_COEFFICIENTS).fill(0),
    );
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dOmega = (4 * Math.PI) / count;
    for (let i = 0; i < count; i++) {
      const y = 1 - (2 * (i + 0.5)) / count;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const theta = golden * i;
      shBasis(Math.cos(theta) * r, y, Math.sin(theta) * r, basis);
      for (let a = 0; a < SH_COEFFICIENTS; a++) {
        for (let b = 0; b < SH_COEFFICIENTS; b++) {
          gram[a][b] += basis[a] * basis[b] * dOmega;
        }
      }
    }
    for (let a = 0; a < SH_COEFFICIENTS; a++) {
      for (let b = 0; b < SH_COEFFICIENTS; b++) {
        expect(gram[a][b]).toBeCloseTo(a === b ? 1 : 0, 2);
      }
    }
  });

  it('reproduces a uniform sky as its own radiance', () => {
    // The anchoring property. A hemisphere of uniform radiance L must come back
    // as L when evaluated straight up — this is what makes the probe a strict
    // generalisation of the whole-dome mean it replaces, rather than a new
    // quantity in unfamiliar units that everything downstream has to be
    // retuned against.
    const coefficients = project(fibonacciHemisphere(256), () => [0.4, 0.7, 1.3]);
    const out: [number, number, number] = [0, 0, 0];
    evaluateSkyProbe(coefficients, UP[0], UP[1], UP[2], out);
    expect(out[0]).toBeCloseTo(0.4, 2);
    expect(out[1]).toBeCloseTo(0.7, 2);
    expect(out[2]).toBeCloseTo(1.3, 2);
  });

  it('carries direction: a blue zenith over a pale horizon stays blue at the zenith', () => {
    // The whole point. The flat mean gave one answer everywhere; this must give
    // the zenith its own, and it must be bluer than the mean.
    const sky = (_x: number, y: number): [number, number, number] => {
      // Deep blue overhead, bright and pale near the horizon.
      const t = Math.max(y, 0);
      return [0.2 + 1.6 * (1 - t), 0.4 + 1.4 * (1 - t), 1.0 + 0.9 * (1 - t)];
    };
    const directions = fibonacciHemisphere(256);
    const coefficients = project(directions, (x, y) => sky(x, y));

    const zenith: [number, number, number] = [0, 0, 0];
    evaluateSkyProbe(coefficients, UP[0], UP[1], UP[2], zenith);
    const grazing: [number, number, number] = [0, 0, 0];
    evaluateSkyProbe(coefficients, 0.995, 0.1, 0, grazing);

    const saturation = (c: number[]): number =>
      (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    // Zenith keeps its chroma; the low direction is measurably paler.
    expect(saturation(zenith)).toBeGreaterThan(saturation(grazing) + 0.1);
    // And it is not merely a rescaling of one colour: the two differ in hue.
    expect(zenith[0] / zenith[2]).toBeLessThan(grazing[0] / grazing[2] - 0.1);
  });

  it('flatProbe reconstructs one radiance in every direction', () => {
    // The A/B path has to go through the same shader code as the real one, or
    // the comparison toggles a branch as well as the thing under test.
    const coefficients = new Float32Array(SH_COEFFICIENTS * 3);
    flatProbe(coefficients, { x: 1.314, y: 1.405, z: 1.706 });
    const out: [number, number, number] = [0, 0, 0];
    for (const dir of [UP, [1, 0.05, 0], [0.5, 0.5, 0.7071], [-0.3, 0.9, 0.3]]) {
      const d = dir as [number, number, number];
      const n = Math.hypot(d[0], d[1], d[2]);
      evaluateSkyProbe(coefficients, d[0] / n, d[1] / n, d[2] / n, out);
      expect(out[0]).toBeCloseTo(1.314, 5);
      expect(out[1]).toBeCloseTo(1.405, 5);
      expect(out[2]).toBeCloseTo(1.706, 5);
    }
  });

  it('the GLSL mirror uses the same constants as the CPU evaluator', () => {
    // Two implementations of one formula is two chances to be wrong, and a
    // mismatch here shows up as water that disagrees with its own lighting.
    // The GLSL folds COSINE_LOBE[band] * basisConstant / PI into literals;
    // this recomputes them and checks the source text carries those numbers.
    const A = [3.141592653589793, 2.0943951023931953, 0.7853981633974483];
    const expected: Record<string, number> = {
      C0: (A[0] * 0.282095) / Math.PI,
      C1: (A[1] * 0.488603) / Math.PI,
      C2: (A[2] * 1.092548) / Math.PI,
      C3: (A[2] * 0.315392) / Math.PI,
      C4: (A[2] * 0.546274) / Math.PI,
    };
    for (const [name, value] of Object.entries(expected)) {
      const match = GLSL_SKY_PROBE.match(
        new RegExp(`const float ${name} = ([0-9.]+);`),
      );
      expect(match, `${name} missing from GLSL_SKY_PROBE`).toBeTruthy();
      expect(Number(match![1])).toBeCloseTo(value, 6);
    }
  });
});

describe('sky sampling accuracy', () => {
  /**
   * The estimator's own error, against a dense reference of the same function.
   *
   * This guard exists because its absence cost real picture quality for a long
   * time. The sample set here before was a zenith point plus rings of six at 45
   * and 15 degrees; measured against 4000 stratified directions it over-reported
   * the cosine-weighted mean by 49% under heavy cloud and 154% under a clear
   * sky. That mean is what the sea's rough reflection converges to, so the water
   * was reflecting a dome one and a half to two and a half times too bright,
   * with an error that moved with cloud cover — and nothing said so, because the
   * only assertions on it compared the estimator against itself.
   */
  const DEG = Math.PI / 180;
  function refreshAt(time: TimeOfDay, elevationDeg: number): void {
    const e = elevationDeg * DEG;
    const m = -30 * DEG;
    time.refreshFromAstronomy(
      1e6,
      new THREE.Vector3(Math.cos(e), Math.sin(e), 0),
      0,
      e,
      new THREE.Vector3(-Math.cos(m), Math.sin(m), 0),
      Math.PI,
      m,
      0.5,
    );
  }

  function referenceMean(time: TimeOfDay, count: number): number {
    const out: [number, number, number] = [0, 0, 0];
    const dir = new THREE.Vector3();
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const [x, y, z] of fibonacciHemisphere(count)) {
      dir.set(x, y, z);
      time.skyWithClouds(dir, out);
      r += out[0] * y;
      g += out[1] * y;
      b += out[2] * y;
      w += y;
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / w;
  }

  for (const [label, cover] of [
    ['heavy cloud', 0.15],
    ['broken', 0.62],
    ['clear', 0.95],
  ] as const) {
    it(`estimates the whole-dome mean within 10% under ${label}`, () => {
      const time = new TimeOfDay();
      time.setCloudState(cover, 1, { offsetX: 0, offsetZ: 0, evolve: 0 });
      refreshAt(time, 45);
      const h = time.hemisphericRadiance;
      const estimate = 0.2126 * h.x + 0.7152 * h.y + 0.0722 * h.z;
      const reference = referenceMean(time, 4000);
      expect(Math.abs(estimate - reference) / reference).toBeLessThan(0.10);
    });
  }

  it('reconstructs the whole-dome mean at the zenith from the probe alone', () => {
    // The probe and the flat mean must agree where they overlap, or the A/B
    // switch changes brightness as well as directionality and tells you nothing.
    const time = new TimeOfDay();
    time.setCloudState(0.62, 1, { offsetX: 0, offsetZ: 0, evolve: 0 });
    refreshAt(time, 45);
    const out: [number, number, number] = [0, 0, 0];
    evaluateSkyProbe(time.skySh, 0, 1, 0, out);
    const h = time.hemisphericRadiance;
    expect(out[0]).toBeCloseTo(h.x, 1);
    expect(out[1]).toBeCloseTo(h.y, 1);
    expect(out[2]).toBeCloseTo(h.z, 1);
  });
});

describe('lobe coverage', () => {
  it('is one at the zenith and one half at the horizon', () => {
    expect(lobeCoverage(1)).toBeCloseTo(1, 6);
    expect(lobeCoverage(0)).toBeCloseTo(0.5, 6);
  });

  it('matches a numerically integrated cosine lobe clipped to the sky', () => {
    // The claim is that 0.5 + 0.5*y is the fraction of a clamped-cosine lobe
    // about `dir` that lies over the upper hemisphere. Integrate it directly
    // rather than trusting the algebra.
    const count = 200000;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (const elevation of [0, 0.2, 0.5, 0.8, 1]) {
      const r = Math.sqrt(Math.max(1 - elevation * elevation, 0));
      const axis = [r, elevation, 0];
      let over = 0;
      let total = 0;
      for (let i = 0; i < count; i++) {
        const y = 1 - (2 * (i + 0.5)) / count;
        const rad = Math.sqrt(Math.max(1 - y * y, 0));
        const theta = golden * i;
        const d = [Math.cos(theta) * rad, y, Math.sin(theta) * rad];
        const cosine = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
        if (cosine <= 0) continue;
        total += cosine;
        if (d[1] > 0) over += cosine;
      }
      expect(over / total).toBeCloseTo(lobeCoverage(elevation), 2);
    }
  });

  it('leaves hue alone: it is a brightness correction only', () => {
    const coefficients = new Float32Array(SH_COEFFICIENTS * 3);
    flatProbe(coefficients, { x: 0.2, y: 0.5, z: 1.0 });
    const low: [number, number, number] = [0, 0, 0];
    evaluateSkyProbe(coefficients, 0.995, 0.1, 0, low);
    expect(low[0] / low[2]).toBeCloseTo(0.2, 5);
    expect(low[1] / low[2]).toBeCloseTo(0.5, 5);
  });
});
