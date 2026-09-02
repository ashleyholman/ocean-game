import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import { PHYSICS_STEP } from '../src/vessel/BuoyantBody';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  RUDDER_LIMIT_DEG,
  RUDDER_RATE_DEG_PER_S,
  SailingControls,
} from '../src/vessel/schooner/SailingControls';
import { runSailCase } from '../src/vessel/schooner/SailingForceEvidence';
import {
  SCHOONER_RUDDER_COEFFICIENTS,
  createSchoonerResistanceResult,
  evaluateSchoonerResistance,
  rudderDragCoefficient,
  rudderLiftCoefficient,
  rudderStallFactorAt,
  type SchoonerResistanceResult,
} from '../src/vessel/schooner/SchoonerResistance';
import { BARE_POLES } from '../src/vessel/schooner/sailAero';

const DEG_TO_RAD = Math.PI / 180;

/**
 * One captive instant in level, still water: prescribe body velocity, yaw
 * rate and rudder deflection, read the full resistance result. The rudder
 * increment's signs below are pinned by these measurements, per the S1 rule:
 * conventions are asserted against computed forces, never against comments.
 */
function evaluateCaptive(options: {
  forwardSpeedMps?: number;
  portSpeedMps?: number;
  yawRateRadPerSecond?: number;
  rudderAngleDeg?: number;
}): SchoonerResistanceResult {
  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  body.snapToSurface(waves, 0, 0, 0);
  body.update(
    0,
    waves,
    0,
    0,
    0,
    PHYSICS_STEP,
    options.portSpeedMps ?? 0,
    options.forwardSpeedMps ?? 0,
  );
  return evaluateSchoonerResistance(
    {
      contacts: body.contacts,
      modelYawRad: 0,
      yawRateRadPerSecond: options.yawRateRadPerSecond ?? 0,
      rudderAngleRad: (options.rudderAngleDeg ?? 0) * DEG_TO_RAD,
    },
    createSchoonerResistanceResult(),
  );
}

describe('rudder lift and stall curves', () => {
  it('holds attached flow to the stall band and keeps a stalled floor', () => {
    const { stallStartDeg, stallEndDeg, stallFloor } =
      SCHOONER_RUDDER_COEFFICIENTS;
    expect(rudderStallFactorAt(0)).toBe(1);
    expect(rudderStallFactorAt(stallStartDeg)).toBe(1);
    expect(rudderStallFactorAt(stallEndDeg)).toBeCloseTo(stallFloor, 12);
    expect(rudderStallFactorAt(90)).toBeCloseTo(stallFloor, 12);
    let previous = 1;
    for (let a = stallStartDeg; a <= stallEndDeg; a += 1) {
      const factor = rudderStallFactorAt(a);
      expect(factor).toBeLessThanOrEqual(previous);
      previous = factor;
    }
  });

  it('rises through the working band, folds at 90°, and reverses astern', () => {
    let previous = 0;
    for (let a = 1; a <= SCHOONER_RUDDER_COEFFICIENTS.stallStartDeg; a += 1) {
      const lift = rudderLiftCoefficient(a * DEG_TO_RAD);
      expect(lift).toBeGreaterThan(previous);
      previous = lift;
    }
    expect(rudderLiftCoefficient(Math.PI / 2)).toBeCloseTo(0, 12);
    // The chord line has no head or tail: flow from astern at the same acute
    // attack angle carries the same magnitude with the opposite sign — the
    // sternway steering reversal, as an exact identity of the curve.
    for (const a of [5, 15, 30, 60]) {
      expect(rudderLiftCoefficient((180 - a) * DEG_TO_RAD)).toBeCloseTo(
        -rudderLiftCoefficient(a * DEG_TO_RAD),
        12,
      );
    }
    // Induced-plus-pressure drag grows with attack angle from a clean zero.
    expect(rudderDragCoefficient(0)).toBe(0);
    expect(rudderDragCoefficient(10 * DEG_TO_RAD)).toBeGreaterThan(0);
    expect(rudderDragCoefficient(30 * DEG_TO_RAD)).toBeGreaterThan(
      rudderDragCoefficient(10 * DEG_TO_RAD),
    );
  });
});

describe('commanded rudder deflection', () => {
  it('reproduces the passive model bit-exactly at zero deflection', () => {
    const condition = {
      forwardSpeedMps: 3.2,
      portSpeedMps: 0.4,
      yawRateRadPerSecond: 0.05,
    };
    const passive = evaluateCaptive(condition);
    const amidships = evaluateCaptive({ ...condition, rudderAngleDeg: 0 });

    expect(amidships.forceBodyN.x).toBe(passive.forceBodyN.x);
    expect(amidships.forceBodyN.z).toBe(passive.forceBodyN.z);
    expect(amidships.yawMomentNm).toBe(passive.yawMomentNm);
    expect(amidships.rudderDeflectionForceXN).toBe(0);
    expect(amidships.rudderDeflectionForceZN).toBe(0);
    expect(amidships.rudderDeflectionYawMomentNm).toBe(0);
    // The blade telemetry still reads without deflection.
    expect(amidships.rudderInflowSpeedMps).toBeGreaterThan(3);
  });

  it('turns the bow to port with positive deflection under headway', () => {
    const result = evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: 10 });
    // Lift pushes the stern to starboard (−x), the drag increment slows her,
    // and the moment about the yaw reference turns the bow to +x/port.
    expect(result.rudderDeflectionForceXN).toBeLessThan(0);
    expect(result.rudderDeflectionForceZN).toBeLessThan(0);
    expect(result.rudderDeflectionYawMomentNm).toBeGreaterThan(0);
    expect(result.rudderInflowAngleDeg).toBeCloseTo(0, 6);
    expect(result.rudderEffectiveAoaDeg).toBeCloseTo(-10, 6);
  });

  it('mirrors port and starboard helm exactly at clean headway', () => {
    const port = evaluateCaptive({ forwardSpeedMps: 3, rudderAngleDeg: 12 });
    const starboard = evaluateCaptive({
      forwardSpeedMps: 3,
      rudderAngleDeg: -12,
    });
    expect(port.rudderDeflectionForceXN).toBeCloseTo(
      -starboard.rudderDeflectionForceXN,
      8,
    );
    expect(port.rudderDeflectionYawMomentNm).toBeCloseTo(
      -starboard.rudderDeflectionYawMomentNm,
      8,
    );
    expect(port.rudderDeflectionForceZN).toBeCloseTo(
      starboard.rudderDeflectionForceZN,
      8,
    );
  });

  it('steers backwards making sternway, as real ships do', () => {
    const ahead = evaluateCaptive({ forwardSpeedMps: 2, rudderAngleDeg: 10 });
    const astern = evaluateCaptive({ forwardSpeedMps: -2, rudderAngleDeg: 10 });
    expect(Math.abs(astern.rudderInflowAngleDeg)).toBeCloseTo(180, 6);
    expect(ahead.rudderDeflectionYawMomentNm).toBeGreaterThan(0);
    expect(astern.rudderDeflectionYawMomentNm).toBeLessThan(0);
  });

  it('does not answer her helm when stopped, and scales with speed squared', () => {
    const stopped = evaluateCaptive({ forwardSpeedMps: 0, rudderAngleDeg: 25 });
    expect(stopped.rudderDeflectionForceXN).toBe(0);
    expect(stopped.rudderDeflectionForceZN).toBe(0);
    expect(stopped.rudderDeflectionYawMomentNm).toBe(0);

    const slow = evaluateCaptive({ forwardSpeedMps: 2, rudderAngleDeg: 15 });
    const fast = evaluateCaptive({ forwardSpeedMps: 4, rudderAngleDeg: 15 });
    const ratio =
      fast.rudderDeflectionYawMomentNm / slow.rudderDeflectionYawMomentNm;
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('sees the yaw-rate inflow at the blade that contacts do not carry', () => {
    // Contact hull-point velocity excludes yaw rate (the documented gotcha);
    // the blade must add it explicitly, once, at its centroid. Pure rotation
    // therefore reads as pure lateral inflow at the stern: bow swinging to
    // port drags the blade to starboard, so water crosses it toward +x.
    const rotating = evaluateCaptive({
      yawRateRadPerSecond: 0.1,
      rudderAngleDeg: 0,
    });
    expect(rotating.rudderInflowSpeedMps).toBeGreaterThan(0.6);
    expect(rotating.rudderInflowSpeedMps).toBeLessThan(0.8);
    expect(rotating.rudderInflowAngleDeg).toBeCloseTo(90, 6);
  });

  it('summed force fields stay closed with the deflection increment', () => {
    const result = evaluateCaptive({
      forwardSpeedMps: 3.5,
      portSpeedMps: 0.5,
      yawRateRadPerSecond: 0.04,
      rudderAngleDeg: 18,
    });
    expect(result.forceBodyN.x).toBeCloseTo(
      result.hullLateralForceN +
        result.backboneLateralForceN +
        result.rudderLateralForceN +
        result.rudderDeflectionForceXN,
      6,
    );
    expect(result.forceBodyN.z).toBeCloseTo(
      result.frictionForceN +
        result.formForceN +
        result.residuaryForceN +
        result.rudderDeflectionForceZN,
      6,
    );
    expect(result.yawMomentNm).toBeCloseTo(
      result.hullYawMomentNm +
        result.backboneYawMomentNm +
        result.rudderYawMomentNm +
        result.rudderDeflectionYawMomentNm,
      6,
    );
  });

  it('rejects a deflection outside the physical ±90° envelope', () => {
    expect(() =>
      evaluateCaptive({ forwardSpeedMps: 2, rudderAngleDeg: 91 }),
    ).toThrow(/rudder angle/);
  });
});

describe('sailing controls — the helm', () => {
  it('clamps commands to the mechanical range and slews at the crewed rate', () => {
    const controls = new SailingControls();
    controls.commandRudderDeg(500);
    expect(controls.rudderTargetDeg).toBe(RUDDER_LIMIT_DEG);
    controls.commandRudderDeg(-500);
    expect(controls.rudderTargetDeg).toBe(-RUDDER_LIMIT_DEG);

    controls.reset();
    controls.commandRudderDeg(RUDDER_LIMIT_DEG);
    const substeps = Math.round(1 / PHYSICS_STEP);
    for (let i = 0; i < substeps; i++) controls.advanceSubstep(PHYSICS_STEP);
    expect(controls.rudderAngleDeg).toBeCloseTo(RUDDER_RATE_DEG_PER_S, 6);

    // Hard-over to hard-over inside the design's 3–4 second band, landing
    // exactly on the stop without overshoot.
    controls.reset();
    controls.commandRudderDeg(-RUDDER_LIMIT_DEG);
    let seconds = 0;
    while (
      controls.rudderAngleDeg !== -RUDDER_LIMIT_DEG &&
      seconds < 10
    ) {
      controls.advanceSubstep(PHYSICS_STEP);
      seconds += PHYSICS_STEP;
    }
    expect(controls.rudderAngleDeg).toBe(-RUDDER_LIMIT_DEG);
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(2);
  });

  it('leaves the passive trajectory bit-identical while never commanded', {
    tags: ['slow', 'sailing'],
  }, () => {
    const options = {
      durationSeconds: 12,
      callerHz: 60,
      voyageCompression: 30,
      velocityX: 0.2,
      velocityZ: 3,
      yawRad: 0.3,
      windSpeedMps: 0,
      windDirectionTowardDeg: 0,
      gustiness: 0,
      canvas: BARE_POLES,
      tack: 'starboard' as const,
    };
    const bare = runSailCase(options);
    const helmAttached = runSailCase({
      ...options,
      rudderCommandDeg: () => 0,
    });
    expect(helmAttached.finalVelocityX).toBe(bare.finalVelocityX);
    expect(helmAttached.finalVelocityZ).toBe(bare.finalVelocityZ);
    expect(helmAttached.finalYawRad).toBe(bare.finalYawRad);
    expect(helmAttached.finalYawRateRadPerSecond).toBe(
      bare.finalYawRateRadPerSecond,
    );
  });

  it('turns a coasting ship the way the helm orders, exactly rate-invariantly', {
    tags: ['slow', 'sailing'],
  }, () => {
    const options = {
      durationSeconds: 16,
      callerHz: 60,
      voyageCompression: 30,
      velocityX: 0,
      velocityZ: 4,
      yawRad: 0,
      windSpeedMps: 0,
      windDirectionTowardDeg: 0,
      gustiness: 0,
      canvas: BARE_POLES,
      tack: 'starboard' as const,
      // Helm over at t = 2 s, a whole-second boundary shared by every
      // caller rate below, so the substep-aligned command trace is identical.
      rudderCommandDeg: (t: number) => (t >= 2 ? 20 : 0),
    };
    // She is coasting and directionally stiff (long keel, deep deadwood), so
    // the claim here is structural — she turns the commanded way and keeps
    // turning. How fast is the turn-circle evidence's question, not this one.
    const run = runSailCase(options);
    expect(run.finalYawRad).toBeGreaterThan(0.2);
    expect(run.finalYawRateRadPerSecond).toBeGreaterThan(0.02);
    expect(run.helm!.rudderAngleDeg).toBeCloseTo(20, 9);

    const caller48 = runSailCase({ ...options, callerHz: 48 });
    const caller240 = runSailCase({ ...options, callerHz: 240 });
    expect(caller48.finalYawRad).toBe(caller240.finalYawRad);
    expect(caller48.finalVelocityX).toBe(caller240.finalVelocityX);
    expect(caller48.finalVelocityZ).toBe(caller240.finalVelocityZ);
  });
});
