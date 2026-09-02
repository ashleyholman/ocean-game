import { describe, expect, it } from 'vitest';
import {
  FOAM_WAKE_STREAK_FRAME,
  FOAM_WIND_STREAK_FRAME,
  advanceFoamStreakFrame,
  createFoamStreakFrame,
  publishFoamStreakFrame,
  type FoamStreakFrameConfig,
} from '../src/scene/foamStreakFrame';
import { DIRECTION_WANDER_DEG, WorldWind } from '../src/world/WorldWind';

const TEST_CONFIG: FoamStreakFrameConfig = {
  releaseDeg: 20,
  releaseStreak: 0.05,
  crossfadeSeconds: 2,
};

function aim(deg: number): { x: number; z: number } {
  const r = (deg * Math.PI) / 180;
  return { x: Math.cos(r), z: Math.sin(r) };
}

function drive(
  frame: ReturnType<typeof createFoamStreakFrame>,
  config: FoamStreakFrameConfig,
  deg: number,
  streak: number,
  seconds: number,
  dt = 1 / 60,
): void {
  const target = aim(deg);
  for (let t = 0; t < seconds; t += dt) {
    advanceFoamStreakFrame(frame, config, target.x, target.z, streak, dt);
  }
}

function heldDeg(frame: { heldX: number; heldZ: number }): number {
  return (Math.atan2(frame.heldZ, frame.heldX) * 180) / Math.PI;
}

describe('foam streak frame latch', () => {
  it('seeds on the first target without a cross-fade', () => {
    const frame = createFoamStreakFrame();
    const t = aim(37);
    advanceFoamStreakFrame(frame, TEST_CONFIG, t.x, t.z, 0.3, 1 / 60);
    expect(frame.seeded).toBe(true);
    expect(heldDeg(frame)).toBeCloseTo(37, 6);
    expect(frame.blend).toBe(0);
  });

  it('holds the frame exactly while the target wanders inside the release', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 0, 0.3, 1);
    const held = { x: frame.heldX, z: frame.heldZ };

    // Sweep the target over the whole interior of the release cone, forwards
    // and back, for a minute of frames.
    for (let i = 0; i < 3600; i++) {
      const deg = 19 * Math.sin(i / 40);
      const t = aim(deg);
      advanceFoamStreakFrame(frame, TEST_CONFIG, t.x, t.z, 0.3, 1 / 60);
    }

    // Bit-for-bit. A frame that moved at all would slide the pattern by
    // |q| * dtheta, and there is no dtheta small enough to be safe.
    expect(frame.heldX).toBe(held.x);
    expect(frame.heldZ).toBe(held.z);
    expect(frame.blend).toBe(0);
  });

  it('releases past the threshold and retires the new frame exactly once', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 0, 0.3, 1);

    const target = aim(30);
    advanceFoamStreakFrame(frame, TEST_CONFIG, target.x, target.z, 0.3, 1 / 60);
    expect(frame.blend).toBeGreaterThan(0);
    expect(heldDeg(frame)).toBeCloseTo(0, 6);
    expect(Math.atan2(frame.nextZ, frame.nextX) * (180 / Math.PI)).toBeCloseTo(30, 6);

    // Mid-fade the held frame is still the OLD one: the dissolve happens in the
    // shader between two constant patterns, never by moving either.
    drive(frame, TEST_CONFIG, 30, 0.3, 1);
    expect(frame.blend).toBeGreaterThan(0);
    expect(frame.blend).toBeLessThan(1);
    expect(heldDeg(frame)).toBeCloseTo(0, 6);

    drive(frame, TEST_CONFIG, 30, 0.3, 2);
    expect(frame.blend).toBe(0);
    expect(heldDeg(frame)).toBeCloseTo(30, 6);
  });

  it('never re-aims a release in flight', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 0, 0.3, 1);

    const first = aim(30);
    advanceFoamStreakFrame(frame, TEST_CONFIG, first.x, first.z, 0.3, 1 / 60);
    const snapshot = { x: frame.nextX, z: frame.nextZ };

    // Swing the target hard while the fade runs. Re-aiming `next` here would
    // reinstate exactly the sliding lever this module removes.
    for (let i = 0; i < 60; i++) {
      const t = aim(30 + i * 2);
      advanceFoamStreakFrame(frame, TEST_CONFIG, t.x, t.z, 0.3, 1 / 60);
      expect(frame.nextX).toBe(snapshot.x);
      expect(frame.nextZ).toBe(snapshot.z);
    }
  });

  it('releases on anisotropy alone, since streak also scales q', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 0, 0.3, 1);
    drive(frame, TEST_CONFIG, 0, 0.3 + TEST_CONFIG.releaseStreak * 0.5, 1);
    expect(frame.blend).toBe(0);
    expect(frame.heldStreak).toBe(0.3);

    const t = aim(0);
    advanceFoamStreakFrame(frame, TEST_CONFIG, t.x, t.z, 0.5, 1 / 60);
    expect(frame.blend).toBeGreaterThan(0);
    expect(frame.nextStreak).toBe(0.5);
  });

  it('holds the frame when the target degenerates', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 40, 0.3, 1);
    const held = { x: frame.heldX, z: frame.heldZ };
    for (let i = 0; i < 600; i++) {
      advanceFoamStreakFrame(frame, TEST_CONFIG, 0, 0, 0.3, 1 / 60);
    }
    expect(frame.heldX).toBe(held.x);
    expect(frame.heldZ).toBe(held.z);
    expect(frame.blend).toBe(0);
  });

  it('publishes held and pending frames as (dirX, dirZ, streak)', () => {
    const frame = createFoamStreakFrame();
    drive(frame, TEST_CONFIG, 0, 0.3, 1);
    const t = aim(30);
    advanceFoamStreakFrame(frame, TEST_CONFIG, t.x, t.z, 0.42, 1 / 60);

    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    publishFoamStreakFrame(frame, a, b);
    expect(a).toEqual({ x: frame.heldX, y: frame.heldZ, z: frame.heldStreak });
    expect(b).toEqual({ x: frame.nextX, y: frame.nextZ, z: frame.nextStreak });
  });
});

describe('foam streak frame release thresholds', () => {
  it('never releases the wind frame on the gust process alone', () => {
    // This is the measurement that started the round: at CURRENT_MODERATE the
    // wind's whole excursion is 3.4 degrees, and that alone was dragging the
    // grain across standing water at up to 1.8 m/s. The release angle has to
    // clear the wander at ANY gustiness, or the marquee comes back as a train
    // of dissolves instead of a slide.
    const wind = new WorldWind();
    wind.setMean(18, 210, 1);

    let widest = 0;
    for (let t = 0; t < 4000; t += 0.5) {
      widest = Math.max(widest, Math.abs(wind.gustDirectionOffsetDegAt(t)));
    }
    // Peak-to-peak is twice the one-sided excursion.
    expect(widest).toBeLessThanOrEqual(DIRECTION_WANDER_DEG);
    expect(FOAM_WIND_STREAK_FRAME.releaseDeg).toBeGreaterThan(2 * widest);

    const frame = createFoamStreakFrame();
    const mean = 210;
    const seed = aim(mean);
    advanceFoamStreakFrame(frame, FOAM_WIND_STREAK_FRAME, seed.x, seed.z, 0.3, 1 / 60);
    const held = { x: frame.heldX, z: frame.heldZ };
    for (let t = 0; t < 4000; t += 1 / 30) {
      const deg = mean + wind.gustDirectionOffsetDegAt(t);
      const d = aim(deg);
      advanceFoamStreakFrame(frame, FOAM_WIND_STREAK_FRAME, d.x, d.z, 0.3, 1 / 30);
    }
    expect(frame.heldX).toBe(held.x);
    expect(frame.heldZ).toBe(held.z);
    expect(frame.blend).toBe(0);
  });

  it('holds the wake frame through a seaway yaw and releases on a tack', () => {
    const frame = createFoamStreakFrame();
    const seed = aim(0);
    advanceFoamStreakFrame(frame, FOAM_WAKE_STREAK_FRAME, seed.x, seed.z, 0.3, 1 / 60);
    const held = { x: frame.heldX, z: frame.heldZ };

    // Three minutes of yawing +-4 degrees on a 7 s encounter period, which is
    // roughly what she does running before a moderate sea.
    for (let t = 0; t < 180; t += 1 / 60) {
      const deg = 4 * Math.sin((2 * Math.PI * t) / 7);
      const d = aim(deg);
      advanceFoamStreakFrame(frame, FOAM_WAKE_STREAK_FRAME, d.x, d.z, 0.3, 1 / 60);
    }
    expect(frame.heldX).toBe(held.x);
    expect(frame.heldZ).toBe(held.z);

    // A tack does move the grain, and should.
    drive(frame, FOAM_WAKE_STREAK_FRAME, 90, 0.3, 10);
    expect(heldDeg(frame)).toBeCloseTo(90, 6);
    expect(frame.blend).toBe(0);
  });
});
