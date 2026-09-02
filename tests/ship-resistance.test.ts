import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import { PHYSICS_STEP } from '../src/vessel/BuoyantBody';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  SCHOONER_RESISTANCE_GEOMETRY,
  createSchoonerResistanceResult,
  evaluateSchoonerResistance,
  ittc1957FrictionCoefficient,
  schoonerResiduaryCoefficient,
} from '../src/vessel/schooner/SchoonerResistance';
import {
  buildSchoonerResistanceEvidence,
  runSchoonerResistanceCase,
} from '../src/vessel/schooner/SchoonerResistanceEvidence';

function relativeDifference(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
}

describe('canonical schooner resistance geometry', () => {
  it('derives bounded wetted and lateral areas from all 39 hull stations', () => {
    const geometry = SCHOONER_RESISTANCE_GEOMETRY;

    expect(geometry.stations).toHaveLength(39);
    expect(geometry.waterlineLengthM).toBeGreaterThan(14);
    expect(geometry.waterlineLengthM).toBeLessThan(15);
    expect(geometry.wettedSurfaceAreaM2).toBeGreaterThan(60);
    expect(geometry.wettedSurfaceAreaM2).toBeLessThan(160);
    expect(geometry.hullLateralAreaM2).toBeGreaterThan(20);
    expect(geometry.hullLateralAreaM2).toBeLessThan(40);
    expect(geometry.backboneLateralAreaM2).toBeGreaterThan(4);
    expect(geometry.backboneLateralAreaM2).toBeLessThan(15);
    expect(geometry.rudderLateralAreaM2).toBeGreaterThan(0.5);
    expect(geometry.rudderLateralAreaM2).toBeLessThan(4);
  });

  it('implements the sourced ITTC friction line and a bounded residuary curve', () => {
    expect(ittc1957FrictionCoefficient(0)).toBe(0);
    expect(ittc1957FrictionCoefficient(1e7)).toBeCloseTo(0.003, 12);
    expect(ittc1957FrictionCoefficient(1e8)).toBeLessThan(
      ittc1957FrictionCoefficient(1e7),
    );
    expect(schoonerResiduaryCoefficient(0)).toBe(0);
    expect(schoonerResiduaryCoefficient(0.35)).toBeCloseTo(0.0025, 12);
    expect(schoonerResiduaryCoefficient(10)).toBe(0.08);
  });
});

describe('passive calm-water resistance', () => {
  it('vanishes exactly at rest and overwrites a reusable result', () => {
    const waves = new WaveField(findSeaState('FLAT'));
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    body.update(0, waves, 0, 0, 0);
    const reusable = createSchoonerResistanceResult();

    const result = evaluateSchoonerResistance(
      { contacts: body.contacts, modelYawRad: 0 },
      reusable,
    );

    expect(result).toBe(reusable);
    expect(result.forceBodyN).toEqual({ x: 0, y: 0, z: 0 });
    expect(result.yawMomentNm).toBe(0);
    expect(result.reynoldsNumber).toBe(0);
    expect(result.froudeNumber).toBe(0);
    expect(result.effectiveWettedSurfaceAreaM2).toBeCloseTo(
      SCHOONER_RESISTANCE_GEOMETRY.wettedSurfaceAreaM2,
      8,
    );
  });

  it('opposes straight motion, reverses astern and rises monotonically with speed', () => {
    const forward = [0.5, 1, 2, 3, 4, 5, 6].map((speed) =>
      runSchoonerResistanceCase({ forwardSpeedMps: speed }),
    );
    for (let i = 0; i < forward.length; i++) {
      const result = forward[i];
      expect(result.forceBodyN.z).toBeLessThan(0);
      expect(result.mechanicalPowerW).toBeLessThan(0);
      if (i > 0) {
        expect(-result.forceBodyN.z).toBeGreaterThan(-forward[i - 1].forceBodyN.z);
      }
    }

    const ahead = runSchoonerResistanceCase({ forwardSpeedMps: 3 });
    const astern = runSchoonerResistanceCase({ forwardSpeedMps: -3 });
    expect(astern.forceBodyN.z).toBeCloseTo(-ahead.forceBodyN.z, 8);
    expect(astern.mechanicalPowerW).toBeCloseTo(ahead.mechanicalPowerW, 8);
  });

  it('approaches zero continuously instead of applying a minimum-speed impulse', () => {
    const slow = runSchoonerResistanceCase({ forwardSpeedMps: 0.01 });
    const twiceAsFast = runSchoonerResistanceCase({ forwardSpeedMps: 0.02 });

    expect(slow.forceBodyN.z).toBeLessThan(0);
    expect(twiceAsFast.forceBodyN.z).toBeLessThan(slow.forceBodyN.z);
    expect(-slow.forceBodyN.z).toBeLessThan(1);
    expect(-twiceAsFast.forceBodyN.z).toBeLessThan(1);
  });

  it('keeps every force decomposition explicit and internally closed', () => {
    const result = runSchoonerResistanceCase({
      forwardSpeedMps: 3.8,
      portSpeedMps: 0.7,
      yawRateRadPerSecond: 0.08,
    });
    const components = result.components;

    expect(result.forceBodyN.z).toBeCloseTo(
      components.frictionForceN + components.formForceN + components.residuaryForceN,
      6,
    );
    expect(result.forceBodyN.x).toBeCloseTo(
      components.hullLateralForceN +
        components.backboneLateralForceN +
        components.rudderLateralForceN,
      6,
    );
    expect(result.yawMomentNm).toBeCloseTo(
      components.hullYawMomentNm +
        components.backboneYawMomentNm +
        components.rudderYawMomentNm,
      6,
    );
    expect(result.mechanicalPowerW).toBeLessThan(0);
  });

  it('is reciprocal in drift and always removes mechanical energy', () => {
    for (const lateralSpeed of [0.15, 0.5, 1]) {
      const starboard = runSchoonerResistanceCase({
        forwardSpeedMps: 4,
        portSpeedMps: -lateralSpeed,
      });
      const port = runSchoonerResistanceCase({
        forwardSpeedMps: 4,
        portSpeedMps: lateralSpeed,
      });

      expect(starboard.forceBodyN.x).toBeGreaterThan(0);
      expect(port.forceBodyN.x).toBeLessThan(0);
      expect(relativeDifference(starboard.forceBodyN.x, -port.forceBodyN.x)).toBeLessThan(1e-10);
      expect(relativeDifference(starboard.yawMomentNm, -port.yawMomentNm)).toBeLessThan(1e-10);
      expect(starboard.mechanicalPowerW).toBeLessThan(0);
      expect(port.mechanicalPowerW).toBeLessThan(0);
    }
  });

  it('opposes steady yaw and mirrors the complete captive-test envelope', () => {
    for (const yawRate of [0.02, 0.08, 0.16]) {
      const starboard = runSchoonerResistanceCase({
        forwardSpeedMps: 4,
        yawRateRadPerSecond: -yawRate,
      });
      const port = runSchoonerResistanceCase({
        forwardSpeedMps: 4,
        yawRateRadPerSecond: yawRate,
      });

      expect(starboard.yawMomentNm).toBeGreaterThan(0);
      expect(port.yawMomentNm).toBeLessThan(0);
      expect(relativeDifference(starboard.yawMomentNm, -port.yawMomentNm)).toBeLessThan(1e-10);
      expect(starboard.mechanicalPowerW).toBeLessThan(0);
      expect(port.mechanicalPowerW).toBeLessThan(0);
    }

    const evidence = buildSchoonerResistanceEvidence();
    expect(evidence.summary.straightTowDragMonotonic).toBe(true);
    expect(evidence.summary.maximumPositiveMechanicalPowerW).toBe(0);
    expect(evidence.summary.maximumDriftMirrorRelativeError).toBeLessThan(1e-10);
    expect(evidence.summary.maximumYawMirrorRelativeError).toBeLessThan(1e-10);

    // Broad scale gates, not claims of measured performance. They catch a lost
    // rho/area factor or a disabled hull-speed rise while leaving the explicit
    // provisional coefficients reviewable through the tracked evidence diff.
    expect(evidence.summary.dragAtFourMpsN).toBeGreaterThan(3_000);
    expect(evidence.summary.dragAtFourMpsN).toBeLessThan(8_000);
    expect(evidence.summary.effectivePowerAtFourMpsW).toBeGreaterThan(12_000);
    expect(evidence.summary.effectivePowerAtFourMpsW).toBeLessThan(32_000);
    const fiveMps = evidence.straightTow.find((result) => result.forwardSpeedMps === 5)!;
    const sixMps = evidence.straightTow.find((result) => result.forwardSpeedMps === 6)!;
    expect(-sixMps.forceBodyN.z).toBeGreaterThan(-fiveMps.forceBodyN.z * 3);
  });

  it('is invariant to the presentation yaw used to express the same body velocity', () => {
    const localVelocity = { x: 0.6, z: 3.2 };
    const yaw = 0.83;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const worldVelocity = {
      x: localVelocity.x * cy + localVelocity.z * sy,
      z: -localVelocity.x * sy + localVelocity.z * cy,
    };
    const flatA = new WaveField(findSeaState('FLAT'));
    const flatB = new WaveField(findSeaState('FLAT'));
    const bodyA = buildSchoonerBuoyancy();
    const bodyB = buildSchoonerBuoyancy();
    bodyA.snapToSurface(flatA, 0, 0, 0);
    bodyB.snapToSurface(flatB, 0, 0, yaw);
    bodyA.update(
      0,
      flatA,
      0,
      0,
      0,
      PHYSICS_STEP,
      localVelocity.x,
      localVelocity.z,
    );
    bodyB.update(
      0,
      flatB,
      0,
      0,
      yaw,
      PHYSICS_STEP,
      worldVelocity.x,
      worldVelocity.z,
    );

    const atZero = evaluateSchoonerResistance({
      contacts: bodyA.contacts,
      modelYawRad: 0,
    });
    const rotated = evaluateSchoonerResistance({
      contacts: bodyB.contacts,
      modelYawRad: yaw,
    });
    expect(rotated.forceBodyN.x).toBeCloseTo(atZero.forceBodyN.x, 8);
    expect(rotated.forceBodyN.z).toBeCloseTo(atZero.forceBodyN.z, 8);
    expect(rotated.yawMomentNm).toBeCloseTo(atZero.yawMomentNm, 8);
  });

  it('rejects a contact graph that is not the canonical schooner', () => {
    expect(() =>
      evaluateSchoonerResistance({ contacts: [], modelYawRad: 0 }),
    ).toThrow(/needs 39 contacts/);
  });
});
