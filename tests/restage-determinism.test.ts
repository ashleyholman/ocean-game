import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { findSeaState } from '../src/ocean/presets';
import { CLOUD_TILE_REFRESH_FRAMES, CloudTileScheduler } from '../src/scene/cloudTileScheduler';
import { SparseTilePool } from '../src/scene/SparseTilePool';
import { TimeOfDay } from '../src/scene/TimeOfDay';
import { WaveField } from '../src/scene/Waves';
import { WindSystem } from '../src/scene/WindSystem';
import { PlanetaryVesselMotionBridge } from '../src/runtime/PlanetaryVesselMotionBridge';
import { Schooner } from '../src/vessel/schooner/Schooner';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import { WorldWind } from '../src/world/WorldWind';

/**
 * "The same request produces the same frame", checked on state.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The project's whole character is that a seed reproduces a trace, and the
 * capture host measured that it did not: staging one scene twice on a page
 * differed over 54-94% of its pixels, mean 2.6-4.3 of 255, against 0.04 for
 * two fresh pages. Three causes were traced, and two more were found while
 * fixing them — all five the same shape: an owner holding state that
 * `resetSimulation` could not reach.
 *
 * The fixes are one line each and the gate is not, so the gate is the point. A
 * test that runs the thing, restarts it, runs it again and compares is worth
 * more than five one-line resets, because the next integrator someone adds
 * will be forgotten in exactly the same way. The fourth and fifth causes are
 * the proof: they were found by re-running the check on a live page after the
 * three named ones were fixed, and both had been sitting there for rounds.
 *
 * WHY STATE AND NOT PIXELS
 * ------------------------
 * A pixel test needs a GPU, a browser and a page; this needs node and 30 ms,
 * so it runs on every commit rather than when somebody remembers. The cost is
 * that it can only see what it can name — see "WHAT THIS CANNOT SEE" at the
 * foot of the file.
 *
 * EVERY CASE HAS A NEGATIVE CONTROL
 * ---------------------------------
 * Each property is asserted twice: once that a restart reproduces, and once
 * that *without* the restart it does not. A determinism test with no negative
 * control is indistinguishable from a test of a constant, and two of these
 * would have passed vacuously while the defect was live.
 *
 * THE BOUND THIS BUYS
 * -------------------
 * Measured on a live page at 960x600 through the capture host's own staging
 * recipe, with a different scene staged between every repeat: one scene staged
 * three times differs by mean 0.00004/255, max 1, over 0.01% of pixels — the
 * 8-bit quantisation floor. It was mean 2.6-4.3/255 over 54-94% of pixels.
 * Full table and caveats in docs/graphics/AGENT_INSPECTION.md.
 */

const DEG = Math.PI / 180;
/** The capture host's own settling delta. Same recipe, same numbers. */
const SETTLE_DELTA_SECONDS = 1 / 60;

/* ------------------------------------------------------------------ *
 * Cause 1: the cloud tile scheduler's round-robin cursor.
 * ------------------------------------------------------------------ */

describe('re-staging the cloud cache scheduler', () => {
  /** One amortized generation over a fixed guard set, as CloudDome drives it. */
  function runGeneration(
    scheduler: CloudTileScheduler,
    tileCount: number,
    frames: number,
  ): number[] {
    const required = new Set(
      Array.from({ length: tileCount }, (_, index) => index),
    );
    const ready = new Int32Array(tileCount);
    ready.fill(-1);
    const order: number[] = [];
    for (let frame = 0; frame < frames; frame++) {
      const schedule = scheduler.select(1, ready, required, frame, false);
      scheduler.markReady(1, ready, schedule.indices);
      order.push(...schedule.indices);
    }
    return order;
  }

  it('refreshes the same tiles in the same order after a reset', () => {
    const tileCount = 96;
    const scheduler = new CloudTileScheduler(tileCount);

    // Forty frames is the capture host's shortened warm; it deliberately stops
    // part-way through the sixty-frame cycle, which is what leaves the cursor
    // somewhere arbitrary.
    const first = runGeneration(scheduler, tileCount, 40);
    expect(scheduler.nextIndex).not.toBe(0);

    scheduler.reset();
    expect(scheduler.nextIndex).toBe(0);
    const second = runGeneration(scheduler, tileCount, 40);

    expect(second).toEqual(first);
  });

  it('does NOT refresh the same tiles without the reset', () => {
    const tileCount = 96;
    const scheduler = new CloudTileScheduler(tileCount);
    const first = runGeneration(scheduler, tileCount, 40);
    const second = runGeneration(scheduler, tileCount, 40);

    // The measured defect, in miniature: the second staging starts wherever
    // the first abandoned the round robin and freezes a different subset.
    expect(second).not.toEqual(first);
  });

  it('drops every residency so slot assignment does not depend on history', () => {
    const pool = new SparseTilePool(64, 16);
    pool.reconcile([5, 6, 7, 8]);
    const beforeReset = pool.slotFor(5);
    pool.reconcile([9, 10, 11, 12]);

    pool.reset();
    expect(pool.residentCount).toBe(0);
    pool.reconcile([5, 6, 7, 8]);
    expect(pool.slotFor(5)).toBe(beforeReset);
  });

  it('keeps a full generation reachable in sixty frames after a reset', () => {
    // The cursor is not the only thing reset touches, and a reset that broke
    // the scheduler's actual job would still pass the equality tests above.
    const tileCount = 66;
    const scheduler = new CloudTileScheduler(tileCount);
    runGeneration(scheduler, tileCount, 17);
    scheduler.reset();
    const covered = new Set(
      runGeneration(scheduler, tileCount, CLOUD_TILE_REFRESH_FRAMES),
    );
    expect(covered.size).toBe(tileCount);
  });
});

/* ------------------------------------------------------------------ *
 * Cause 2: the meters that never come back down.
 * ------------------------------------------------------------------ */

describe('re-staging the sky and its meters', () => {
  function stage(sky: TimeOfDay, sunElevationDeg: number, frames: number): void {
    const elevation = sunElevationDeg * DEG;
    const sun = new THREE.Vector3(Math.cos(elevation), Math.sin(elevation), 0);
    const moon = new THREE.Vector3(-Math.cos(elevation), Math.sin(elevation), 0);
    // Cover, so the amortized solar-disc transmittance is actually exercised;
    // with a clear sky that path short-circuits and its cursor never moves.
    sky.setCloudState(0.45, 0.8, { offsetX: 120, offsetZ: -80, evolve: 3 });
    for (let frame = 0; frame < frames; frame++) {
      sky.refreshFromAstronomy(
        SETTLE_DELTA_SECONDS,
        sun,
        0,
        elevation,
        moon,
        Math.PI,
        -20 * DEG,
        0.5,
      );
    }
  }

  /** Everything the sky publishes that a later frame could be sensitive to. */
  function readout(sky: TimeOfDay): number[] {
    return [
      sky.exposure,
      sky.adaptationLuminance,
      sky.retinalLuminance,
      sky.sunCloudTransmittance,
      sky.moonCloudTransmittance,
      sky.ambientRadiance.x,
      sky.ambientRadiance.y,
      sky.ambientRadiance.z,
      sky.hemisphericRadiance.x,
      sky.hemisphericRadiance.y,
      sky.hemisphericRadiance.z,
      ...Array.from(sky.skySh),
    ];
  }

  /**
   * A sheet's second scene, and then its first scene again.
   *
   * This is the shape the defect actually has. One scene staged twice in a row
   * would not have shown it as sharply: the meters are already near that
   * scene's target, so the residue is small. A real contact sheet walks
   * between conditions, and the interesting question is whether coming BACK to
   * a condition gives what leaving it gave.
   */
  const DAWN = 4;
  const AFTERNOON = 38;
  const WARM_FRAMES = 40;

  it('publishes bit-identical sky products when each staging resets first', () => {
    const sky = new TimeOfDay();

    sky.resetAdaptation();
    stage(sky, AFTERNOON, WARM_FRAMES);
    const first = readout(sky);

    sky.resetAdaptation();
    stage(sky, DAWN, WARM_FRAMES);

    sky.resetAdaptation();
    stage(sky, AFTERNOON, WARM_FRAMES);

    // Exact. Not `toBeCloseTo`: the claim is that the third staging recomputes
    // rather than continues, and a tolerance would pass a low pass that merely
    // got close, which is what the defect looked like in the first place.
    expect(readout(sky)).toEqual(first);
  });

  it('does NOT reproduce without resetAdaptation', () => {
    const sky = new TimeOfDay();

    sky.resetAdaptation();
    stage(sky, AFTERNOON, WARM_FRAMES);
    const first = readout(sky);

    stage(sky, DAWN, WARM_FRAMES);
    stage(sky, AFTERNOON, WARM_FRAMES);

    expect(readout(sky)).not.toEqual(first);
  });

  it('cannot wash the meter out by settling longer, which is why it is reset', () => {
    // The reason the fix is a reset and not "warm for more frames". The meter's
    // constant is four seconds and a capture session has no seconds to give
    // it: 40 frames is 0.67 s, so a staging recovers about 15% of the distance
    // from the previous scene's exposure. Even eight stagings' worth of frames
    // in one go does not arrive.
    const sky = new TimeOfDay();
    sky.resetAdaptation();
    stage(sky, AFTERNOON, WARM_FRAMES);
    const settled = sky.exposure;

    sky.resetAdaptation();
    stage(sky, DAWN, WARM_FRAMES);
    stage(sky, AFTERNOON, WARM_FRAMES * 8);

    expect(sky.exposure).not.toBe(settled);
    expect(Math.abs(sky.exposure - settled)).toBeGreaterThan(1e-6);
  });

  it('reproduces a SHORT staging, where the probe cursor is still visible', () => {
    // Why this case exists as well as the 40-frame one. The sky probe refreshes
    // 16 of its 256 directions per ordinary frame, so any staging longer than
    // 16 frames has walked the whole cache and the cursor's position no longer
    // shows. `cloudWarmFrames` is a scene parameter and 0 is a legal value —
    // the capture round used exactly that to isolate the cloud cache — so a
    // short staging is a supported request, and it is the one that can see the
    // amortization. Eight frames is inside one cycle.
    const short = 8;
    const sky = new TimeOfDay();

    sky.resetAdaptation();
    stage(sky, AFTERNOON, short);
    const first = readout(sky);

    sky.resetAdaptation();
    stage(sky, DAWN, short);
    sky.resetAdaptation();
    stage(sky, AFTERNOON, short);
    expect(readout(sky)).toEqual(first);

    const drifting = new TimeOfDay();
    drifting.resetAdaptation();
    stage(drifting, AFTERNOON, short);
    stage(drifting, DAWN, short);
    stage(drifting, AFTERNOON, short);
    expect(readout(drifting)).not.toEqual(first);
  });

  it('gives every staging of one scene the same exposure once reset', () => {
    const sky = new TimeOfDay();
    const exposures: number[] = [];
    for (let staging = 0; staging < 4; staging++) {
      sky.resetAdaptation();
      stage(sky, DAWN, WARM_FRAMES);
      sky.resetAdaptation();
      stage(sky, AFTERNOON, WARM_FRAMES);
      exposures.push(sky.exposure);
    }
    expect(new Set(exposures).size).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Cause 4: the wind's own clock. Not one of the three the capture round
 * named — found by re-running its check on a live page after those were
 * fixed, and worth more than the three because nobody was looking for it.
 * ------------------------------------------------------------------ */

describe('re-staging the wind', () => {
  function createWind(): WorldWind {
    const wind = new WorldWind();
    wind.setMean(9.5, 215, 0.4);
    return wind;
  }

  function settleWind(wind: WorldWind, frames: number): number[] {
    for (let frame = 0; frame < frames; frame++) {
      wind.advance(SETTLE_DELTA_SECONDS);
    }
    return [
      wind.instantaneousSpeedMps,
      wind.instantaneousDirectionTowardDeg,
      wind.gustSpeedFraction,
      wind.gustDirectionOffsetDeg,
    ];
  }

  it('meets the same gust after a reset', () => {
    const wind = createWind();
    const first = settleWind(wind, 40);

    settleWind(wind, 90);
    wind.reset();

    expect(settleWind(wind, 40)).toEqual(first);
  });

  it('does NOT meet the same gust without one', () => {
    // Which reaches the sails, then the yaw, then the camera. Measured on the
    // live page at 1.1e-5 rad of heading after forty settling frames.
    const wind = createWind();
    const first = settleWind(wind, 40);
    expect(settleWind(wind, 40)).not.toEqual(first);
  });

  it('is a pure function of the clock, which is why rewinding it suffices', () => {
    // The claim `reset` rests on. If any part of the gust state were carried
    // rather than derived, zeroing one number would not be a reset — and the
    // class having no `Math.random()` anywhere is what makes it true.
    const walked = createWind();
    settleWind(walked, 137);
    const jumped = createWind();
    jumped.advance(137 * SETTLE_DELTA_SECONDS);
    expect(walked.instantaneousSpeedMps).toBeCloseTo(
      jumped.instantaneousSpeedMps,
      9,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Cause 3: the vessel's attitude, and where it actually lives.
 * ------------------------------------------------------------------ */

describe('re-staging the vessel', () => {
  interface Harness {
    world: PlanetaryWorld;
    ship: Schooner;
    waves: WaveField;
    wind: WindSystem;
    bridge: PlanetaryVesselMotionBridge;
    encounterVelocity: { x: number; z: number };
  }

  function createHarness(): Harness {
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: Date.UTC(2026, 7, 5, 3) / 1000,
      latitudeRad: -33.9 * DEG,
      longitudeRad: 151.9 * DEG,
      initialCourseRad: 135 * DEG,
      initialSpeedMps: 3.2,
      voyageSecondsPerRealSecond: 1,
    });
    const encounterVelocity = { x: 0, z: 0 };
    const bridge = new PlanetaryVesselMotionBridge(world, {
      x: 0,
      z: 0,
    });
    return {
      world,
      ship: new Schooner({ advancesWaveField: false }),
      waves: new WaveField(findSeaState('CURRENT_MODERATE')),
      wind: new WindSystem(),
      bridge,
      encounterVelocity,
    };
  }

  /**
   * Settle exactly as the capture host does: a fixed count of identical
   * fixed-delta steps through the production force integrator.
   *
   * The encounter velocity is re-derived from the canonical world every frame,
   * which is the detail that made this cause hard to see — the number the hull
   * integrates is not stored on the hull.
   */
  function settle(harness: Harness, frames: number): void {
    const { world, ship, waves, wind, bridge, encounterVelocity } = harness;
    for (let frame = 0; frame < frames; frame++) {
      const velocity = world.state.velocityEcefMps;
      const frameEcef = world.state.surfaceFrameEcef;
      encounterVelocity.x =
        velocity.x * frameEcef.right.x +
        velocity.y * frameEcef.right.y +
        velocity.z * frameEcef.right.z;
      encounterVelocity.z = -(
        velocity.x * frameEcef.forward.x +
        velocity.y * frameEcef.forward.y +
        velocity.z * frameEcef.forward.z
      );
      ship.advancePhysics({
        dt: SETTLE_DELTA_SECONDS,
        waves,
        localX: 0,
        localZ: 0,
        wind,
        elapsed: frame * SETTLE_DELTA_SECONDS,
        encounterVelocity,
        horizontalMotion: bridge,
      });
    }
  }

  /**
   * The restart, exactly as `VesselRuntime.resetHorizontalMotion` performs it,
   * plus the flotation body that `resetSimulation` resets alongside it.
   */
  function restart(harness: Harness): void {
    harness.world.restoreOpeningVoyage();
    harness.encounterVelocity.x = 0;
    harness.encounterVelocity.z = 0;
    harness.bridge.towYawRad = 0;
    harness.ship.body.reset();
    harness.ship.resetHorizontalMotion();
    harness.waves.setTime(0);
  }

  /** Attitude and voyage: what the camera and the world are actually posed by. */
  function readout(harness: Harness): number[] {
    const { ship, world } = harness;
    return [
      ship.yaw,
      ship.yawRate,
      ship.body.pitch,
      ship.body.roll,
      ship.body.pitchRate,
      ship.body.rollRate,
      ship.body.comWorldY,
      ship.body.velocityY,
      world.state.positionEcefM.x,
      world.state.positionEcefM.y,
      world.state.positionEcefM.z,
      world.state.velocityEcefMps.x,
      world.state.velocityEcefMps.y,
      world.state.velocityEcefMps.z,
      world.state.surfaceFrameEcef.forward.x,
      world.state.surfaceFrameEcef.forward.y,
      world.state.surfaceFrameEcef.forward.z,
    ];
  }

  it('returns to the same attitude and voyage after a restart', () => {
    const harness = createHarness();
    harness.waves.setTime(0);
    settle(harness, 40);
    const first = readout(harness);

    restart(harness);
    settle(harness, 40);

    expect(readout(harness)).toEqual(first);
  });

  it('does NOT return without the restart, and diverges further the longer it settles', () => {
    const shortRun = createHarness();
    shortRun.waves.setTime(0);
    settle(shortRun, 4);
    const shortFirst = readout(shortRun);
    shortRun.ship.body.reset();
    shortRun.waves.setTime(0);
    settle(shortRun, 4);
    const shortDrift = Math.abs(readout(shortRun)[0] - shortFirst[0]);

    const longRun = createHarness();
    longRun.waves.setTime(0);
    settle(longRun, 40);
    const longFirst = readout(longRun);
    longRun.ship.body.reset();
    longRun.waves.setTime(0);
    settle(longRun, 40);
    const longDrift = Math.abs(readout(longRun)[0] - longFirst[0]);

    // Resetting the hull alone is what the code used to do. Both drift, and
    // the longer settle drifts further — the signature that told the capture
    // round this was unrestored state rather than an integrator's own
    // floating-point noise, which would not care how long it ran.
    expect(shortDrift).toBeGreaterThan(0);
    expect(longDrift).toBeGreaterThan(shortDrift);
  });

  it('restores the opening voyage without touching the clock', () => {
    // The capture host pins the instant, pauses the calendar and zeroes its
    // rate BEFORE restarting. A restart that restored a whole world snapshot
    // would undo all three and fight its own caller.
    const harness = createHarness();
    harness.world.setPaused(true);
    harness.world.setWorldSecondsPerRealSecond(0);
    harness.world.setWorldInstantUtcSeconds(1234567);
    settle(harness, 20);

    harness.world.restoreOpeningVoyage();

    expect(harness.world.state.paused).toBe(true);
    expect(harness.world.state.worldSecondsPerRealSecond).toBe(0);
    expect(harness.world.state.worldInstantUtcSeconds).toBe(1234567);
  });

  it('keeps the vessel sailing while the astronomical clock is paused', () => {
    // Stated as a test because it is the counter-intuitive fact the whole
    // third cause rests on: `setPaused` stops the calendar, not the ship, so a
    // "frozen" capture scene is still under way.
    const harness = createHarness();
    harness.world.setPaused(true);
    harness.world.setWorldSecondsPerRealSecond(0);
    const before = { ...harness.world.state.positionEcefM };
    settle(harness, 40);
    const after = harness.world.state.positionEcefM;

    expect(
      Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z),
    ).toBeGreaterThan(0);
  });
});

/*
 * WHAT THIS CANNOT SEE
 * --------------------
 * - Anything that needs a GL context: the foam field's history, the ocean's
 *   temporal resolve, the cloud cache's actual texels. The scheduler above is
 *   the cache's ORDER OF WORK, which is where the non-determinism was, but a
 *   cache that reset its cursor and kept its pixels would still pass here.
 * - The fifth cause, the cloud deck's drift phase. `SkySystem` needs a
 *   renderer to construct, so `SkySystem.reset` is exercised only through the
 *   live page and through the wiring test. It is the same bug as the wind's
 *   clock — an accumulator advanced per presentation frame, independent of the
 *   astronomical clock, which nothing rewound — and on a live page it was the
 *   LARGEST remaining term: 9% on the ambient fill, 0.7% on the exposure,
 *   against the exposure meter's own creep of 0.007%.
 * - The composed `resetSimulation` itself. Its wiring — that it calls the sky
 *   cache reset and the adaptation reset, and in what order — is pinned in
 *   `tests/sim-handle.test.ts`; this file pins that those resets do their job.
 * - Pixels, and therefore the bound. The measured re-stage residue lives in
 *   `docs/graphics/AGENT_INSPECTION.md`; re-measuring it needs `--verify`.
 */
