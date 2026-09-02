import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  modelYawForVelocity,
  resolveCanonicalHorizontalVelocity,
  resolveEncounterVelocity,
  resolveTrueHeadingDirection,
  trueHeadingForModelYaw,
  VesselSpeedTarget,
} from '../src/vessel/VesselMotion';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';

const PHYSICS_STEP = 1 / 240;

describe('production vessel encounter motion', () => {
  it('projects speed onto the local course and points the bow along it', () => {
    const out = { x: 0, z: 0 };

    resolveEncounterVelocity({ x: 0, z: -2 }, 4, out);
    expect(out).toEqual({ x: 0, z: -4 });
    expect(modelYawForVelocity(out, 0)).toBeCloseTo(Math.PI, 12);

    resolveEncounterVelocity({ x: 3, z: 0 }, 4, out);
    expect(out).toEqual({ x: 4, z: 0 });
    expect(modelYawForVelocity(out, 0)).toBeCloseTo(Math.PI / 2, 12);

    resolveEncounterVelocity({ x: 0, z: 1 }, 4, out);
    expect(modelYawForVelocity(out, 0)).toBeCloseTo(0, 12);
    expect(modelYawForVelocity({ x: 0, z: 0 }, 1.25)).toBe(1.25);
  });

  it('keeps commanded true heading available when course is undefined at Stop', () => {
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: Date.UTC(2026, 0, 15) / 1000,
      latitudeRad: -35.484 * (Math.PI / 180),
      longitudeRad: 137.874 * (Math.PI / 180),
      initialCourseRad: 0,
      initialSpeedMps: 0,
    });
    const direction = { x: 0, z: 0 };

    resolveTrueHeadingDirection(world.state, 0, direction);
    expect(direction.x).toBeCloseTo(0, 12);
    expect(direction.z).toBeCloseTo(-1, 12);
    expect(modelYawForVelocity(direction, 0)).toBeCloseTo(Math.PI, 12);

    resolveTrueHeadingDirection(world.state, Math.PI / 2, direction);
    expect(direction.x).toBeCloseTo(1, 12);
    expect(direction.z).toBeCloseTo(0, 12);
    expect(modelYawForVelocity(direction, 0)).toBeCloseTo(Math.PI / 2, 12);

    resolveTrueHeadingDirection(world.state, Math.PI, direction);
    expect(direction.x).toBeCloseTo(0, 12);
    expect(direction.z).toBeCloseTo(1, 12);
    expect(modelYawForVelocity(direction, 0)).toBeCloseTo(0, 12);

    resolveTrueHeadingDirection(world.state, 3 * Math.PI / 2, direction);
    expect(direction.x).toBeCloseTo(-1, 12);
    expect(direction.z).toBeCloseTo(0, 12);
    expect(modelYawForVelocity(direction, 0)).toBeCloseTo(-Math.PI / 2, 12);
    expect(Math.hypot(
      world.state.velocityEcefMps.x,
      world.state.velocityEcefMps.y,
      world.state.velocityEcefMps.z,
    )).toBe(0);
  });

  it('round-trips canonical tangent velocity and model yaw without erasing sideslip', () => {
    const world = new PlanetaryWorld({
      worldInstantUtcSeconds: Date.UTC(2026, 0, 15) / 1000,
      latitudeRad: -35.484 * (Math.PI / 180),
      longitudeRad: 137.874 * (Math.PI / 180),
      initialCourseRad: 0,
      initialSpeedMps: 0,
    });
    const projected = { x: 0, z: 0 };
    world.setTangentVelocityMps(0.7, 3.2);

    resolveCanonicalHorizontalVelocity(world.state, projected);
    expect(projected.x).toBeCloseTo(0.7, 12);
    expect(projected.z).toBeCloseTo(-3.2, 12);

    for (const trueHeading of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const direction = { x: 0, z: 0 };
      resolveTrueHeadingDirection(world.state, trueHeading, direction);
      const yaw = modelYawForVelocity(direction, 0);
      expect(trueHeadingForModelYaw(world.state, yaw)).toBeCloseTo(
        trueHeading,
        12,
      );
    }
  });

  it('keeps a debug speed prescription as a control input, not another velocity', () => {
    let legacyTarget = 0.09;
    const target = new VesselSpeedTarget(() => legacyTarget);

    expect(target.targetSpeedMps).toBe(0.09);
    expect(target.isPrescribed).toBe(false);
    target.prescribe(4);
    legacyTarget = 0.55;
    expect(target.targetSpeedMps).toBe(4);
    expect(target.isPrescribed).toBe(true);
    target.resumeLegacy();
    expect(target.targetSpeedMps).toBe(0.55);
    expect(target.isPrescribed).toBe(false);
    expect(() => target.prescribe(-1)).toThrow(/non-negative/);
  });

  it('advances wave time and encounter distance together on one physics step', () => {
    const waves = new WaveField(findSeaState('CURRENT_MODERATE'));
    waves.setOrigin(12, -7);

    waves.advance(0.25, 4, -2);

    expect(waves.time).toBeCloseTo(0.25, 14);
    expect(waves.originWorldX).toBeCloseTo(13, 14);
    expect(waves.originWorldZ).toBeCloseTo(-7.5, 14);
  });

  it('matches an explicitly towed hull at every fixed physics sample', () => {
    const sea = findSeaState('CURRENT_MODERATE');
    const movingFrameWaves = new WaveField(sea);
    const explicitTowWaves = new WaveField(sea);
    const movingFrameBody = buildSchoonerBuoyancy();
    const explicitTowBody = buildSchoonerBuoyancy();
    const yaw = 0.7;
    const velocity = { x: 2.4, z: -1.8 };
    let towX = 0;
    let towZ = 0;

    movingFrameBody.snapToSurface(movingFrameWaves, 0, 0, yaw);
    explicitTowBody.snapToSurface(explicitTowWaves, 0, 0, yaw);

    for (let frame = 0; frame < 180; frame++) {
      movingFrameBody.update(
        1 / 60,
        movingFrameWaves,
        0,
        0,
        yaw,
        PHYSICS_STEP,
        velocity.x,
        velocity.z,
      );
      for (let substep = 0; substep < 4; substep++) {
        towX += velocity.x * PHYSICS_STEP;
        towZ += velocity.z * PHYSICS_STEP;
        explicitTowBody.update(
          PHYSICS_STEP,
          explicitTowWaves,
          towX,
          towZ,
          yaw,
          PHYSICS_STEP,
        );
      }

      expect(movingFrameWaves.originWorldX).toBeCloseTo(towX, 11);
      expect(movingFrameWaves.originWorldZ).toBeCloseTo(towZ, 11);
      expect(movingFrameWaves.time).toBeCloseTo(explicitTowWaves.time, 12);
      expect(movingFrameBody.comWorldY).toBeCloseTo(explicitTowBody.comWorldY, 10);
      expect(movingFrameBody.velocityY).toBeCloseTo(explicitTowBody.velocityY, 10);
      expect(movingFrameBody.pitch).toBeCloseTo(explicitTowBody.pitch, 10);
      expect(movingFrameBody.pitchRate).toBeCloseTo(explicitTowBody.pitchRate, 10);
      expect(movingFrameBody.roll).toBeCloseTo(explicitTowBody.roll, 10);
      expect(movingFrameBody.rollRate).toBeCloseTo(explicitTowBody.rollRate, 10);
    }
  }, 120_000);
});
