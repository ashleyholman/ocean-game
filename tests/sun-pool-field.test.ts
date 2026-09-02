import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { TimeOfDay } from '../src/scene/TimeOfDay';
import type { CloudFieldState } from '../src/scene/SkySystem';

const SUN = new THREE.Vector3(0.31, 0.82, 0.48).normalize();
const SAMPLE_POINTS = [
  [-1800, -1200],
  [-900, 300],
  [0, 0],
  [450, -750],
  [1200, 900],
  [2100, -300],
] as const;

function field(patch: Partial<CloudFieldState> = {}): CloudFieldState {
  return {
    offsetX: 137,
    offsetZ: -42,
    evolve: 260,
    ...patch,
  };
}

function sampler(
  cloudField: CloudFieldState,
  opacity = 0.86,
): TimeOfDay {
  const time = new TimeOfDay();
  time.setCloudState(0.5, opacity, cloudField);
  return time;
}

function samples(time: TimeOfDay): number[] {
  return SAMPLE_POINTS.map(([x, z]) =>
    time.sunPoolTransmittanceAt(x, z, SUN),
  );
}

describe('one-sample moving sun-pool field', () => {
  it('is deterministic, bounded, and spatial beneath broken cloud', () => {
    const time = sampler(field());
    const first = samples(time);
    const second = samples(time);

    expect(second).toEqual(first);
    expect(first.every((value) => Number.isFinite(value))).toBe(true);
    expect(first.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(new Set(first.map((value) => value.toFixed(6))).size).toBeGreaterThan(1);
  });

  it('rides both cloud drift and shape evolution', () => {
    const baseline = samples(sampler(field()));
    const drifted = samples(sampler(field({ offsetX: 777, offsetZ: -511 })));
    const evolved = samples(sampler(field({ evolve: 980 })));

    expect(drifted).not.toEqual(baseline);
    expect(evolved).not.toEqual(baseline);
  });

  it('is continuous under an observer-origin rebase', () => {
    const baselineField = field();
    const deltaX = 640;
    const deltaZ = -469;
    const rebased = sampler(field({
      offsetX: baselineField.offsetX + deltaX,
      offsetZ: baselineField.offsetZ + deltaZ,
    }));
    const baseline = sampler(baselineField);

    for (const [x, z] of SAMPLE_POINTS) {
      expect(
        rebased.sunPoolTransmittanceAt(x - deltaX, z - deltaZ, SUN),
      ).toBeCloseTo(baseline.sunPoolTransmittanceAt(x, z, SUN), 12);
    }
  });

  it('returns the exact neutral value when clouds are absent or the sun is down', () => {
    const cloudsOff = sampler(field(), 0);
    const belowHorizon = new THREE.Vector3(0.4, -0.1, 0.9).normalize();

    for (const [x, z] of SAMPLE_POINTS) {
      expect(cloudsOff.sunPoolTransmittanceAt(x, z, SUN)).toBe(1);
      expect(
        sampler(field()).sunPoolTransmittanceAt(x, z, belowHorizon),
      ).toBe(1);
    }
  });

  it('stays finite through the grazing-sun reach cap', () => {
    const time = sampler(field());
    for (const elevationSin of [0.004, 0.008, 0.016, 0.05, 0.13]) {
      const direction = new THREE.Vector3(
        Math.sqrt(1 - elevationSin * elevationSin),
        elevationSin,
        0,
      );
      for (const [x, z] of SAMPLE_POINTS) {
        const transmission = time.sunPoolTransmittanceAt(x, z, direction);
        expect(Number.isFinite(transmission)).toBe(true);
        expect(transmission).toBeGreaterThanOrEqual(0);
        expect(transmission).toBeLessThanOrEqual(1);
      }
    }
  });
});
