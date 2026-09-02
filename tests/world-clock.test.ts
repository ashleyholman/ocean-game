import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REAL_SECONDS_PER_WORLD_DAY,
  DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND,
  DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
  PresentationClock,
  WORLD_SECONDS_PER_DAY,
  WorldClock,
} from '../src/world/clock';
import { distanceVec3 } from '../src/world/math';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';

const DEG = Math.PI / 180;

describe('astronomical clock and vessel-physics time domains', () => {
  it('defaults the calendar to the 30x day but the voyage to honest 1x travel', () => {
    expect(DEFAULT_WORLD_SECONDS_PER_REAL_SECOND).toBe(
      WORLD_SECONDS_PER_DAY / DEFAULT_REAL_SECONDS_PER_WORLD_DAY,
    );
    // Land made the old shared 30x default visible as terrain sliding across
    // a 1x sea; distance made good is now honest unless explicitly compressed.
    expect(DEFAULT_VOYAGE_SECONDS_PER_REAL_SECOND).toBe(1);
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: Date.UTC(2026, 0, 15, 9, 0) / 1000,
      latitudeRad: -33.9 * DEG,
      longitudeRad: 151.9 * DEG,
      initialCourseRad: 68 * DEG,
      initialSpeedMps: 0,
    });
    expect(world.voyageSecondsPerRealSecond).toBe(1);
    expect(world.speedResponseSeconds).toBe(12);
  });

  it('retunes voyage compression live without touching covered ground', () => {
    const world = makeWorld(1);
    world.setVoyageSecondsPerRealSecond(4);
    expect(world.voyageSecondsPerRealSecond).toBe(4);
    const result = world.advancePhysicsSeconds(1);
    expect(result.voyageDeltaSeconds).toBe(4);
    expect(result.distanceTravelledM).toBeCloseTo(4, 12);
    expect(() => world.setVoyageSecondsPerRealSecond(Number.NaN)).toThrow();
    expect(() => world.setVoyageSecondsPerRealSecond(-1)).toThrow();
  });

  it('compresses the global voyage without accelerating local water encounter', () => {
    const world = makeWorld(1);
    const startPosition = { ...world.state.positionEcefM };

    const result = world.advancePhysicsSeconds(1);

    expect(result.physicsDeltaSeconds).toBe(1);
    expect(result.voyageDeltaSeconds).toBe(30);
    expect(result.encounterDistanceM).toBeCloseTo(1, 12);
    expect(result.distanceTravelledM).toBeCloseTo(30, 12);
    expect(distanceVec3(world.state.positionEcefM, startPosition)).toBeCloseTo(
      30,
      5,
    );
    expect(Math.hypot(
      world.state.velocityEcefMps.x,
      world.state.velocityEcefMps.y,
      world.state.velocityEcefMps.z,
    )).toBeCloseTo(1, 12);
  });

  it('commits signed tangent motion while compressing displacement only', () => {
    const world = makeWorld(0);
    const startPosition = { ...world.state.positionEcefM };

    const result = world.advanceTangentMotionStep(
      0.5,
      0.75,
      -1,
      2.5,
      -0.5,
    );

    expect(result.encounterDistanceM).toBeCloseTo(1.25, 12);
    expect(result.distanceTravelledM).toBeCloseTo(37.5, 12);
    expect(distanceVec3(world.state.positionEcefM, startPosition)).toBeCloseTo(
      37.5,
      5,
    );
    expect(Math.hypot(
      world.state.velocityEcefMps.x,
      world.state.velocityEcefMps.y,
      world.state.velocityEcefMps.z,
    )).toBeCloseTo(Math.hypot(2.5, -0.5), 12);
    expect(() => world.advanceTangentMotionStep(0, 1, 0, 0, 0)).toThrow(
      /zero-duration/,
    );
  });

  it('advances exactly one astronomical day without moving the vessel', () => {
    const world = makeWorld(0.5);
    const startInstant = world.state.worldInstantUtcSeconds;
    const startPosition = { ...world.state.positionEcefM };
    const startVelocity = { ...world.state.velocityEcefMps };

    const worldDeltaSeconds = world.advanceClockRealSeconds(
      DEFAULT_REAL_SECONDS_PER_WORLD_DAY,
    );

    expect(worldDeltaSeconds).toBe(WORLD_SECONDS_PER_DAY);
    expect(world.state.worldInstantUtcSeconds - startInstant).toBe(
      WORLD_SECONDS_PER_DAY,
    );
    expect(world.state.positionEcefM).toEqual(startPosition);
    expect(world.state.velocityEcefMps).toEqual(startVelocity);
  });

  it('can fast-forward thirty astronomical days without replaying thirty voyages', () => {
    const world = makeWorld(0.5);
    const startPosition = { ...world.state.positionEcefM };

    expect(
      world.advanceClockRealSeconds(
        30 * DEFAULT_REAL_SECONDS_PER_WORLD_DAY,
      ),
    ).toBe(30 * WORLD_SECONDS_PER_DAY);
    expect(world.state.positionEcefM).toEqual(startPosition);
  });

  it('uses the pause control only to freeze the astronomical clock', () => {
    const world = makeWorld(0.5);
    const startInstant = world.state.worldInstantUtcSeconds;
    const startPosition = { ...world.state.positionEcefM };
    world.setPaused(true);

    expect(world.advanceClockRealSeconds(30)).toBe(0);
    const physics = world.advancePhysicsSeconds(30, 0.55);

    expect(world.state.worldInstantUtcSeconds).toBe(startInstant);
    expect(physics.physicsDeltaSeconds).toBe(30);
    expect(physics.encounterDistanceM).toBeGreaterThan(15);
    expect(physics.distanceTravelledM).toBeCloseTo(
      physics.encounterDistanceM * DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
      10,
    );
    expect(
      distanceVec3(world.state.positionEcefM, startPosition),
    ).toBeGreaterThan(450);
    expect(Math.hypot(
      world.state.velocityEcefMps.x,
      world.state.velocityEcefMps.y,
      world.state.velocityEcefMps.z,
    )).toBeGreaterThan(0.5);
  });

  it('keeps clock rate and pause settings out of identical physics advances', () => {
    const normal = makeWorld(0.09);
    const accelerated = makeWorld(0.09, 144);
    accelerated.setWorldSecondsPerRealSecond(12);
    accelerated.setPaused(true);
    expect(accelerated.voyageSecondsPerRealSecond).toBe(30);

    const normalResult = normal.advancePhysicsSeconds(8, 4);
    const acceleratedResult = accelerated.advancePhysicsSeconds(8, 4);

    expect(acceleratedResult).toEqual(normalResult);
    expect(
      distanceVec3(normal.state.positionEcefM, accelerated.state.positionEcefM),
    ).toBeLessThan(1e-9);
    expect(
      distanceVec3(normal.state.velocityEcefMps, accelerated.state.velocityEcefMps),
    ).toBeLessThan(1e-12);
  });

  it('does not let presentation time alter canonical state', () => {
    const world = makeWorld(0.5);
    const presentation = new PresentationClock();
    const before = world.createSnapshot();
    presentation.advanceRealSeconds(1000);
    expect(presentation.elapsedSeconds).toBe(1000);
    expect(world.createSnapshot()).toEqual(before);
  });

  it('integrates exponential speed response independently of physics step size', () => {
    const oneStep = makeWorld(0.09);
    const partitioned = makeWorld(0.09);
    const physicsSeconds = 12;

    const large = oneStep.advancePhysicsSeconds(physicsSeconds, 0.55);
    let partitionedDistanceM = 0;
    for (let index = 0; index < 720; index++) {
      partitionedDistanceM += partitioned.advancePhysicsSeconds(
        physicsSeconds / 720,
        0.55,
      ).distanceTravelledM;
    }

    expect(partitionedDistanceM).toBeCloseTo(large.distanceTravelledM, 8);
    expect(
      distanceVec3(
        oneStep.state.positionEcefM,
        partitioned.state.positionEcefM,
      ),
    ).toBeLessThan(0.001);
    expect(
      distanceVec3(
        oneStep.state.velocityEcefMps,
        partitioned.state.velocityEcefMps,
      ),
    ).toBeLessThan(1e-12);
  });

  it('can feed an unclamped stall to the sky and a bounded step to physics', () => {
    const world = makeWorld(0.5);
    const startInstant = world.state.worldInstantUtcSeconds;
    const clockDelta = world.advanceClockRealSeconds(30);
    const physics = world.advancePhysicsSeconds(0.1);

    expect(clockDelta).toBe(30 * DEFAULT_WORLD_SECONDS_PER_REAL_SECOND);
    expect(world.state.worldInstantUtcSeconds - startInstant).toBe(clockDelta);
    expect(physics.encounterDistanceM).toBeCloseTo(0.05, 12);
    expect(physics.distanceTravelledM).toBeCloseTo(1.5, 12);
  });

  it('WorldClock stores no independent mirrored instant', () => {
    const world = makeWorld(0);
    const clock = new WorldClock(world.state);
    clock.setCurrentUtcSeconds(1234.5);
    expect(world.state.worldInstantUtcSeconds).toBe(1234.5);
    clock.setWorldSecondsPerRealSecond(10);
    expect(clock.worldDeltaForRealSeconds(2)).toBe(20);
  });

  it('round-trips a versioned canonical snapshot', () => {
    const source = makeWorld(0.5);
    source.advanceClockRealSeconds(125.5);
    source.advancePhysicsSeconds(125.5, 0.55);
    source.setPaused(true);
    const snapshot = source.createSnapshot();
    const restored = makeWorld(1);
    restored.restoreSnapshot(snapshot);
    expect(restored.createSnapshot()).toEqual(snapshot);
  });

  it('rejects an invalid snapshot without partially corrupting state', () => {
    const world = makeWorld(0.5);
    const before = world.createSnapshot();
    const invalid = {
      ...before,
      positionEcefM: [Number.NaN, 0, 0],
    } as unknown as typeof before;
    expect(() => world.restoreSnapshot(invalid)).toThrow();
    expect(world.createSnapshot()).toEqual(before);
  });
});

function makeWorld(
  speedMps: number,
  astronomicalSecondsPerRealSecond =
    DEFAULT_WORLD_SECONDS_PER_REAL_SECOND,
): PlanetaryWorld {
  return new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 0, 15, 9, 0) / 1000,
    latitudeRad: -33.9 * DEG,
    longitudeRad: 151.9 * DEG,
    initialCourseRad: 68 * DEG,
    initialSpeedMps: speedMps,
    worldSecondsPerRealSecond: astronomicalSecondsPerRealSecond,
    // The compression-arithmetic tests below pin the classic 30x voyage; the
    // production default is asserted separately above.
    voyageSecondsPerRealSecond: 30,
  });
}
