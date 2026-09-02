import { describe, expect, it } from 'vitest';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import {
  DEFAULT_VOYAGE_OMEGA_MAX_DEG_PER_S,
  governedVoyageRate,
  VOYAGE_RATE_RANGE,
  VoyageClockControl,
} from '../src/world/voyageClock';

const DEG = Math.PI / 180;

function makeWorld(): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 0, 15, 9, 0) / 1000,
    latitudeRad: -33.9 * DEG,
    longitudeRad: 151.9 * DEG,
    initialCourseRad: 68 * DEG,
    initialSpeedMps: 3,
  });
}

describe('governed voyage rate', () => {
  it('solves rate = omega·d / v and clamps to the voyage range', () => {
    // The calibration table from the timescale analysis: 3 m/s (≈6 kn) under
    // a 0.2°/s slide budget.
    expect(governedVoyageRate(10_000, 3, 0.2)).toBeCloseTo(11.64, 2);
    expect(governedVoyageRate(50_000, 3, 0.2)).toBe(VOYAGE_RATE_RANGE.max);
    expect(governedVoyageRate(2_000, 3, 0.2)).toBeCloseTo(2.33, 2);
    // Close inshore the honest floor holds; compression never goes below 1x.
    expect(governedVoyageRate(500, 3, 0.2)).toBe(VOYAGE_RATE_RANGE.min);
  });

  it('treats a vessel without steering way as stationary', () => {
    // ω = v·rate/d is zero at any compression when v ≈ 0, and the quotient
    // ω_max·d/v explodes — full compression is the honest answer.
    expect(governedVoyageRate(2_000, 0, 0.2)).toBe(VOYAGE_RATE_RANGE.max);
    expect(governedVoyageRate(2_000, 0.01, 0.2)).toBe(VOYAGE_RATE_RANGE.max);
  });

  it('rejects non-finite inputs', () => {
    expect(() => governedVoyageRate(Number.NaN, 3, 0.2)).toThrow();
    expect(() => governedVoyageRate(1000, -1, 0.2)).toThrow();
  });
});

describe('voyage clock control', () => {
  it('holds the world at the honest default in fixed mode', () => {
    const world = makeWorld();
    const clock = new VoyageClockControl(world);
    expect(world.voyageSecondsPerRealSecond).toBe(1);
    clock.update(1, { nearestLandM: 6_000, speedOverGroundMps: 3 });
    expect(world.voyageSecondsPerRealSecond).toBe(1);
    expect(clock.currentMode).toBe('fixed');
    expect(clock.currentOmegaMaxDegPerS).toBe(
      DEFAULT_VOYAGE_OMEGA_MAX_DEG_PER_S,
    );
  });

  it('eases toward a new fixed rate instead of stepping', () => {
    const world = makeWorld();
    const clock = new VoyageClockControl(world);
    clock.setFixedRate(30);
    clock.update(0.5, { nearestLandM: undefined, speedOverGroundMps: 3 });
    const partway = world.voyageSecondsPerRealSecond;
    expect(partway).toBeGreaterThan(1);
    expect(partway).toBeLessThan(30);
    for (let i = 0; i < 40; i += 1) {
      clock.update(0.5, { nearestLandM: undefined, speedOverGroundMps: 3 });
    }
    expect(world.voyageSecondsPerRealSecond).toBe(30);
  });

  it('governs against the nearest land and reopens on open water', () => {
    const world = makeWorld();
    const clock = new VoyageClockControl(world, { mode: 'governed' });
    // 10 km off at 3 m/s under the default 0.2°/s budget targets ~11.6x.
    clock.update(0, { nearestLandM: 10_000, speedOverGroundMps: 3 });
    expect(clock.targetRate()).toBeCloseTo(11.64, 2);
    // No land in the world: nothing witnesses full compression.
    clock.update(0, { nearestLandM: undefined, speedOverGroundMps: 3 });
    expect(clock.targetRate()).toBe(VOYAGE_RATE_RANGE.max);
    for (let i = 0; i < 60; i += 1) {
      clock.update(0.5, { nearestLandM: undefined, speedOverGroundMps: 3 });
    }
    expect(world.voyageSecondsPerRealSecond).toBe(VOYAGE_RATE_RANGE.max);
    // Land sighted: the target collapses and the rate ramps back down.
    clock.update(0.5, { nearestLandM: 2_000, speedOverGroundMps: 3 });
    expect(clock.targetRate()).toBeCloseTo(2.33, 2);
    expect(world.voyageSecondsPerRealSecond).toBeLessThan(
      VOYAGE_RATE_RANGE.max,
    );
  });

  it('does not move on a zero-delta update', () => {
    const world = makeWorld();
    const clock = new VoyageClockControl(world, { fixedRate: 1 });
    clock.setFixedRate(30);
    clock.update(0, { nearestLandM: undefined, speedOverGroundMps: 3 });
    expect(world.voyageSecondsPerRealSecond).toBe(1);
  });

  it('reports the apparent slide of the nearest land', () => {
    const world = makeWorld();
    const clock = new VoyageClockControl(world, { fixedRate: 30 });
    for (let i = 0; i < 60; i += 1) {
      clock.update(0.5, { nearestLandM: 5_000, speedOverGroundMps: 3 });
    }
    // 3 m/s × 30 over 5 km ≈ 1.03°/s — the sliding-island picture.
    expect(clock.apparentSlideDegPerS()).toBeCloseTo(1.03, 2);
  });
});
