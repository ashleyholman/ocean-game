/**
 * The day ladder — one contact sheet showing the same sea under every light the
 * world can make.
 *
 * This world is outdoors, on water, for twenty-four hours a day. A change to
 * the display transform, the sky's colour or the exposure meter cannot be
 * judged on a single frame at noon: the terms that make noon beautiful are the
 * same terms that decide whether dusk goes muddy, and the only way to see that
 * is to put the whole arc side by side.
 *
 * Every rung fixes the same three things — camera, sea state, cloud deck — and
 * varies only the sun. Exposure is snapped rather than adapted, so each frame
 * shows the meter's answer for that light instead of a trail from the last one.
 */
import * as THREE from 'three';

import type { SimCapability } from '../runtime/diagnostics/SimHandle';

export type DayLadderCapability = SimCapability<
  | 'canvas'
  | 'lighting'
  | 'refreshLighting'
  | 'renderFrame'
  | 'sky'
  | 'stepSimulation'
  | 'world'
>;
import { buildContactSheet, grab, post, toBlob, type SheetFrame } from './labCapture';

export interface DayLadderRung {
  label: string;
  /** Target solar elevation in degrees. */
  elevationDeg: number;
  /** Take the descending branch of the day (afternoon/evening) when true. */
  descending: boolean;
}

/**
 * The rungs worth having an opinion about. Weighted toward the low sun, which
 * is where every term in the sky model is changing fastest and where the
 * failures have historically been.
 */
export const DEFAULT_RUNGS: readonly DayLadderRung[] = [
  { label: 'dawn   sun -6', elevationDeg: -6, descending: false },
  { label: 'sunrise sun +1', elevationDeg: 1, descending: false },
  { label: 'morning sun +20', elevationDeg: 20, descending: false },
  { label: 'midday  sun max', elevationDeg: 90, descending: false },
  { label: 'afternoon sun +40', elevationDeg: 40, descending: true },
  { label: 'golden  sun +8', elevationDeg: 8, descending: true },
  { label: 'sunset  sun 0', elevationDeg: 0, descending: true },
  { label: 'dusk    sun -4', elevationDeg: -4, descending: true },
  { label: 'twilight sun -9', elevationDeg: -9, descending: true },
  { label: 'night   sun -20', elevationDeg: -20, descending: true },
];

/** Frames rendered per rung before the grab, so caches and LUTs settle. */
const SETTLE_FRAMES = 8;

function solarElevationDeg(sim: DayLadderCapability): number {
  return (sim.lighting.solarElevationRad * 180) / Math.PI;
}

/**
 * Find the world instant on today's arc that puts the sun at `elevationDeg`.
 *
 * A coarse sweep to bracket the branch, then a bisection. Targets above the
 * day's actual maximum land on local noon, which is what "midday" should mean
 * at any latitude and season rather than an error.
 */
function seekSunElevation(
  sim: DayLadderCapability,
  dayStartUtc: number,
  target: number,
  descending: boolean,
): number {
  const sample = (t: number): number => {
    sim.world.setWorldInstantUtcSeconds(t);
    sim.refreshLighting();
    return solarElevationDeg(sim);
  };

  const STEP = 300;
  let noonT = dayStartUtc;
  let noonE = -Infinity;
  const samples: Array<{ t: number; e: number }> = [];
  for (let t = dayStartUtc; t < dayStartUtc + 86400; t += STEP) {
    const e = sample(t);
    samples.push({ t, e });
    if (e > noonE) {
      noonE = e;
      noonT = t;
    }
  }
  if (target >= noonE) return noonT;

  // Pick the bracketing pair on the requested branch.
  let lo = NaN;
  let hi = NaN;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const crossing = (a.e - target) * (b.e - target) <= 0;
    if (!crossing) continue;
    const isDescending = b.e < a.e;
    if (isDescending !== descending) continue;
    lo = a.t;
    hi = b.t;
    break;
  }
  if (Number.isNaN(lo) || Number.isNaN(hi)) return noonT;

  for (let i = 0; i < 30; i++) {
    const mid: number = (lo + hi) / 2;
    const e = sample(mid);
    const belowTarget = descending ? e > target : e < target;
    if (belowTarget) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Slide the cloud deck until the sun stands in clear air, without changing how
 * cloudy the sky is.
 *
 * Two things have to be true for a rung to be comparable to its neighbours.
 * The sun must be unoccluded, or the rung is a coin toss between "sunlit sea"
 * and "the key light is off". And the deck must be about as thick as it was
 * before the search, because the exposure meter reads the sky's mean: a search
 * that happens to land on a hole in the cloud opens a stop and a half and the
 * ladder stops measuring the thing it was built to measure.
 *
 * So: collect every offset that clears the sun, then take the one whose
 * hemispheric mean is closest to the deck we started with.
 */
function clearTheSun(sim: DayLadderCapability): number {
  const lighting = sim.lighting;
  const sun = lighting.sunDirection.clone();
  if (sun.y <= 0.01) return 1;

  const baseX = sim.sky.cloudField.offsetX;
  const baseZ = sim.sky.cloudField.offsetZ;
  const probe = new THREE.Vector3();
  const meanLuminance = (): number => {
    const h = lighting.hemisphericRadiance;
    return 0.2126 * h.x + 0.7152 * h.y + 0.0722 * h.z;
  };

  sim.refreshLighting();
  const baseMean = meanLuminance();

  let best = { t: -1, x: baseX, z: baseZ, drift: Infinity };
  for (let i = 0; i < 1200; i++) {
    const x = baseX + i * 331;
    const z = baseZ + i * 197;
    sim.sky.jumpCloudField(x, z);
    sim.refreshLighting();
    probe.copy(sun);
    const t = lighting.cloudTransmittance(probe);
    if (t < 0.9) {
      if (best.t < 0.9 && t > best.t) best = { t, x, z, drift: Infinity };
      continue;
    }
    const drift = Math.abs(meanLuminance() - baseMean) / Math.max(baseMean, 1e-6);
    if (best.t < 0.9 || drift < best.drift) best = { t, x, z, drift };
    if (drift < 0.02) break;
  }

  sim.sky.jumpCloudField(best.x, best.z);
  sim.refreshLighting();
  return best.t;
}

export interface DayLadderOptions {
  name?: string;
  rungs?: readonly DayLadderRung[];
  /** Put the sun in clear air at every rung. Default true. */
  clearSun?: boolean;
  columns?: number;
  cellWidth?: number;
  onProgress?: (message: string) => void;
}

/**
 * Render the ladder and POST it to `tools/capture-server.mjs`.
 *
 * Restores the clock and pause state afterwards: a diagnostic that leaves the
 * world somewhere else is a diagnostic nobody runs twice.
 */
export async function captureDayLadder(
  sim: DayLadderCapability,
  options: DayLadderOptions = {},
): Promise<boolean> {
  const rungs = options.rungs ?? DEFAULT_RUNGS;
  const restoreUtc = sim.world.state.worldInstantUtcSeconds;
  const restorePaused = sim.world.state.paused;
  const restoreCloudX = sim.sky.cloudField.offsetX;
  const restoreCloudZ = sim.sky.cloudField.offsetZ;
  const dayStart = restoreUtc - 43200;

  sim.world.setPaused(true);
  const frames: SheetFrame[] = [];

  try {
    for (const rung of rungs) {
      options.onProgress?.(`day ladder · ${rung.label}`);
      const t = seekSunElevation(sim, dayStart, rung.elevationDeg, rung.descending);
      sim.world.setWorldInstantUtcSeconds(t);
      sim.refreshLighting();

      let sunT = 1;
      if (options.clearSun !== false) sunT = clearTheSun(sim);

      for (let i = 0; i < SETTLE_FRAMES; i++) {
        sim.stepSimulation(1 / 60);
        sim.renderFrame();
      }
      sim.renderFrame();

      const elev = solarElevationDeg(sim).toFixed(1);
      const exposure = sim.lighting.exposure.toFixed(2);
      frames.push({
        image: grab(sim.canvas, 0.5),
        label: `${rung.label}  (${elev} deg)  exp ${exposure}  sunT ${sunT.toFixed(2)}`,
      });
    }

    const sheet = buildContactSheet(frames, {
      columns: options.columns ?? 5,
      cellWidth: options.cellWidth ?? 460,
      title: options.name ?? 'day ladder',
      subtitle:
        'same camera, same sea, same cloud deck — only the sun moves. ' +
        'sunT is the cloud transmittance toward the sun (1.0 = clear air).',
    });
    return await post(options.name ?? 'day-ladder', await toBlob(sheet, 'image/jpeg', 0.94));
  } finally {
    sim.sky.jumpCloudField(restoreCloudX, restoreCloudZ);
    sim.world.setWorldInstantUtcSeconds(restoreUtc);
    sim.world.setPaused(restorePaused);
    sim.refreshLighting();
  }
}
