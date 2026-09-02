import { bench, describe } from 'vitest';
import * as THREE from 'three';
import { TimeOfDay } from '../src/scene/TimeOfDay';
import type { CloudFieldState } from '../src/scene/SkySystem';

const DEG = Math.PI / 180;
const sunElevation = 8 * DEG;
const moonElevation = -30 * DEG;
const sun = new THREE.Vector3(Math.cos(sunElevation), Math.sin(sunElevation), 0);
const moon = new THREE.Vector3(-Math.cos(moonElevation), Math.sin(moonElevation), 0);
const options = { time: 1_500, warmupTime: 750 } as const;

/** Benchmark-only stand-in for the previous one-ray direct-sun path. */
class PointSunTimeOfDay extends TimeOfDay {
  protected override sunDiscCloudTransmittance(): number {
    return super.cloudTransmittance(this.sunDirection);
  }
}

function cloudyRefresh(time: TimeOfDay, cover: number): () => void {
  const clouds: CloudFieldState = { offsetX: 137, offsetZ: -42, evolve: 19 };
  let frame = 0;
  return () => {
    const sample = frame++ & 255;
    clouds.offsetX = 137 + sample * 0.17;
    clouds.offsetZ = -42 - sample * 0.11;
    clouds.evolve = 19 + sample * 0.003;
    time.setCloudState(cover, 1, clouds);
    time.refreshFromAstronomy(
      1 / 60,
      sun,
      0,
      sunElevation,
      moon,
      Math.PI,
      moonElevation,
      0.5,
    );
  };
}

describe('TimeOfDay CPU lighting', () => {
  for (const [label, cover] of [
    ['overcast', 0.15],
    ['broken', 0.7],
    ['mostly clear', 0.95],
  ] as const) {
    bench(
      `${label}: previous point ray`,
      cloudyRefresh(new PointSunTimeOfDay(), cover),
      options,
    );
    bench(
      `${label}: 4-of-16 solar disc`,
      cloudyRefresh(new TimeOfDay(), cover),
      options,
    );
  }
});
