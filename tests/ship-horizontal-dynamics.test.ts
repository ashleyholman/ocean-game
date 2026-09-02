import { describe, expect, it } from 'vitest';
import { findSeaState } from '../src/ocean/presets';
import { WaveField } from '../src/scene/Waves';
import type { VesselHorizontalDynamicsBridge } from '../src/vessel/VesselMotion';
import { buildSchoonerBuoyancy } from '../src/vessel/schooner/SchoonerBuoyancy';
import {
  SchoonerHorizontalDynamics,
  horizontalKineticEnergyJ,
} from '../src/vessel/schooner/SchoonerHorizontalDynamics';
import {
  buildSchoonerHorizontalDynamicsEvidence,
} from '../src/vessel/schooner/SchoonerHorizontalDynamicsEvidence';
import {
  runFreeHorizontalResponseCase,
} from '../src/vessel/schooner/SchoonerHorizontalResponseEvidence';
import { buildLoadedShip } from '../src/vessel/schooner/massModel';
import { PlanetaryWorld } from '../src/world/PlanetaryWorld';
import { distanceVec3, lengthVec3 } from '../src/world/math';

interface HarnessOptions {
  velocityX?: number;
  velocityZ?: number;
  yawRad?: number;
  yawRateRadPerSecond?: number;
  voyageCompression?: number;
  mode?: VesselHorizontalDynamicsBridge['mode'];
  towVelocityX?: number;
  towVelocityZ?: number;
  towYawRad?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const waves = new WaveField(findSeaState('FLAT'));
  const body = buildSchoonerBuoyancy();
  const dynamics = new SchoonerHorizontalDynamics(
    body.mass,
    body.inertiaYaw,
  );
  const velocity = {
    x: options.velocityX ?? 0,
    z: options.velocityZ ?? 0,
  };
  let yawRad = options.yawRad ?? 0;
  let yawRateRadPerSecond = options.yawRateRadPerSecond ?? 0;
  const world = new PlanetaryWorld({
    worldInstantUtcSeconds: Date.UTC(2026, 7, 5) / 1000,
    latitudeRad: -35 * (Math.PI / 180),
    longitudeRad: 138 * (Math.PI / 180),
    initialCourseRad: Math.PI,
    initialSpeedMps: 0,
    voyageSecondsPerRealSecond: options.voyageCompression ?? 30,
  });
  world.setTangentVelocityMps(velocity.x, -velocity.z);

  let distanceTravelledM = 0;
  const energies: number[] = [];
  const speeds: number[] = [];
  const lateralBodySpeeds: number[] = [];
  const yawRates: number[] = [];
  const bridge: VesselHorizontalDynamicsBridge = {
    mode: options.mode ?? 'free',
    towVelocityWorldMps: {
      x: options.towVelocityX ?? 0,
      z: options.towVelocityZ ?? 0,
    },
    towYawRad: options.towYawRad ?? 0,
    commitStep(
      physicsDeltaSeconds,
      encounterDisplacementX,
      encounterDisplacementZ,
      endVelocityX,
      endVelocityZ,
      endYawRad,
      endYawRate,
    ) {
      const committed = world.advanceTangentMotionStep(
        physicsDeltaSeconds,
        encounterDisplacementX,
        -encounterDisplacementZ,
        endVelocityX,
        -endVelocityZ,
      );
      distanceTravelledM += committed.distanceTravelledM;
      const cy = Math.cos(endYawRad);
      const sy = Math.sin(endYawRad);
      lateralBodySpeeds.push(endVelocityX * cy - endVelocityZ * sy);
      speeds.push(Math.hypot(endVelocityX, endVelocityZ));
      yawRates.push(endYawRate);
      energies.push(horizontalKineticEnergyJ(
        body.mass,
        body.inertiaYaw,
        endVelocityX,
        endVelocityZ,
        endYawRate,
      ));
    },
  };

  return {
    waves,
    body,
    dynamics,
    velocity,
    world,
    bridge,
    energies,
    speeds,
    lateralBodySpeeds,
    yawRates,
    get yawRad() {
      return yawRad;
    },
    get yawRateRadPerSecond() {
      return yawRateRadPerSecond;
    },
    get distanceTravelledM() {
      return distanceTravelledM;
    },
    advance(dtSeconds: number) {
      const result = dynamics.advance(
        dtSeconds,
        body,
        waves,
        0,
        0,
        velocity,
        yawRad,
        yawRateRadPerSecond,
        bridge,
      );
      yawRad = result.yawRad;
      yawRateRadPerSecond = result.yawRateRadPerSecond;
      return result;
    },
  };
}

function runSeconds(
  harness: ReturnType<typeof createHarness>,
  seconds: number,
  callerHz: number,
): void {
  const calls = Math.round(seconds * callerHz);
  for (let i = 0; i < calls; i++) harness.advance(1 / callerHz);
}

function expectNonIncreasing(values: readonly number[], tolerance = 1e-9): void {
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBeLessThanOrEqual(values[i - 1] + tolerance);
  }
}

describe('schooner horizontal rigid-body properties', () => {
  it('derives yaw inertia from the same distributed loaded mass budget', () => {
    const body = buildSchoonerBuoyancy();
    const loaded = buildLoadedShip();

    expect(body.inertiaYaw).toBeCloseTo(loaded.properties.inertiaYaw, 8);
    expect(body.inertiaYaw).toBeGreaterThan(body.mass * 8);
    expect(body.inertiaYaw).toBeLessThan(body.mass * 40);
  });

  it('preserves frame-wide overtopping events across composed fixed steps', () => {
    const waves = new WaveField(findSeaState('FLAT'));
    const body = buildSchoonerBuoyancy();
    body.snapToSurface(waves, 0, 0, 0);
    body.overtopEvents.push({
      x: 0,
      y: 0,
      z: 0,
      speed: 1,
      depth: 0.1,
      durationSeconds: 1 / 240,
      contactWidthM: 1,
      tributaryAreaM2: 1,
      stationIndex: 0,
      batchStepIndex: 0,
      stationLocalZ: 0,
      boardingSide: 'starboard',
      flowX: 0,
      flowZ: 0,
    });

    body.update(0, waves, 0, 0, 0, undefined, 0, 0, true);
    expect(body.overtopEvents).toHaveLength(1);
    body.update(0, waves, 0, 0, 0);
    expect(body.overtopEvents).toHaveLength(0);
  });
});

/**
 * Every case here integrates thousands of fixed physics steps, and two
 * different tests in this block have failed a loaded full run and passed
 * alone immediately afterwards — a timeout, not a result. Both sides of the
 * 2026-08-06 merge fixed this independently; the merged policy is the
 * suite-wide 60 s default in `vite.config.ts`, with explicit 120 s budgets
 * on the multi-minute decay and evidence cases below. Budgets are headroom,
 * not targets.
 */
describe('passive force-integrated schooner motion', () => {
  it('coasts down monotonically and keeps wave/global displacement coherent', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const harness = createHarness({ velocityZ: 4 });
    const startPosition = { ...harness.world.state.positionEcefM };
    const initialEnergy = horizontalKineticEnergyJ(
      harness.body.mass,
      harness.body.inertiaYaw,
      0,
      4,
      0,
    );

    runSeconds(harness, 30, 60);

    expectNonIncreasing(harness.speeds, 1e-12);
    expectNonIncreasing([initialEnergy, ...harness.energies], 1e-6);
    expect(harness.velocity.z).toBeLessThan(3.5);
    expect(harness.velocity.z).toBeGreaterThan(0);
    expect(harness.velocity.x).toBeCloseTo(0, 10);
    expect(harness.yawRateRadPerSecond).toBeCloseTo(0, 10);
    expect(harness.waves.originWorldX).toBeCloseTo(0, 10);
    expect(harness.waves.originWorldZ).toBeGreaterThan(0);
    expect(harness.distanceTravelledM).toBeCloseTo(
      harness.waves.originWorldZ * 30,
      7,
    );
    expect(distanceVec3(
      harness.world.state.positionEcefM,
      startPosition,
    )).toBeCloseTo(harness.distanceTravelledM, 2);
    expect(lengthVec3(harness.world.state.velocityEcefMps)).toBeCloseTo(
      Math.hypot(harness.velocity.x, harness.velocity.z),
      10,
    );
    expect(harness.body.lastSubsteps).toBe(4);
  });

  it('dissipates sideslip and yaw without adding rigid-body energy', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const sideslip = createHarness({ velocityX: 1, velocityZ: 4 });
    runSeconds(sideslip, 20, 60);
    expect(Math.abs(sideslip.lateralBodySpeeds.at(-1)!)).toBeLessThan(0.2);
    // No meaningful undershoot through zero. The bound has moved twice with
    // cause: S2b's sway added mass shifted the numerical tail to ~-8e-8, and
    // S3's keel-slope retune (backboneForwardLateralSlope 2.20 → 1.30, the
    // tack-evidence finding) leaves the sway-yaw pair marginally under
    // critical damping — one measured zero-crossing at -7.2e-4, 0.07% of the
    // release amplitude. That is a single microscopic recovery, not ringing;
    // the bound is set at ~3x the measurement.
    expect(
      sideslip.lateralBodySpeeds.every((value) => value >= -2e-3),
    ).toBe(true);
    expectNonIncreasing(sideslip.energies, 1e-6);

    const yaw = createHarness({ velocityZ: 4, yawRateRadPerSecond: 0.16 });
    runSeconds(yaw, 20, 60);
    expect(Math.abs(yaw.yawRateRadPerSecond)).toBeLessThan(0.01);
    expect(Math.max(...yaw.yawRates.map(Math.abs))).toBeLessThan(0.16);
    expectNonIncreasing(yaw.energies, 1e-6);
  });

  it('is invariant to caller rate because resistance is stepped at 240 Hz', () => {
    const at60 = createHarness({
      velocityX: 0.7,
      velocityZ: 4,
      yawRateRadPerSecond: 0.11,
    });
    const at120 = createHarness({
      velocityX: 0.7,
      velocityZ: 4,
      yawRateRadPerSecond: 0.11,
    });
    runSeconds(at60, 12, 60);
    runSeconds(at120, 12, 120);

    expect(at120.velocity.x).toBeCloseTo(at60.velocity.x, 11);
    expect(at120.velocity.z).toBeCloseTo(at60.velocity.z, 11);
    expect(at120.yawRad).toBeCloseTo(at60.yawRad, 11);
    expect(at120.yawRateRadPerSecond).toBeCloseTo(
      at60.yawRateRadPerSecond,
      11,
    );
    expect(at120.waves.originWorldX).toBeCloseTo(
      at60.waves.originWorldX,
      10,
    );
    expect(at120.waves.originWorldZ).toBeCloseTo(
      at60.waves.originWorldZ,
      10,
    );
  });

  it('keeps voyage compression out of local dynamics and water encounter', () => {
    const uncompressed = createHarness({
      velocityX: 0.5,
      velocityZ: 3,
      voyageCompression: 1,
    });
    const compressed = createHarness({
      velocityX: 0.5,
      velocityZ: 3,
      voyageCompression: 30,
    });
    runSeconds(uncompressed, 10, 60);
    runSeconds(compressed, 10, 60);

    expect(compressed.velocity.x).toBeCloseTo(uncompressed.velocity.x, 12);
    expect(compressed.velocity.z).toBeCloseTo(uncompressed.velocity.z, 12);
    expect(compressed.yawRad).toBeCloseTo(uncompressed.yawRad, 12);
    expect(compressed.yawRateRadPerSecond).toBeCloseTo(
      uncompressed.yawRateRadPerSecond,
      12,
    );
    expect(compressed.waves.originWorldX).toBeCloseTo(
      uncompressed.waves.originWorldX,
      12,
    );
    expect(compressed.waves.originWorldZ).toBeCloseTo(
      uncompressed.waves.originWorldZ,
      12,
    );
    expect(compressed.distanceTravelledM).toBeCloseTo(
      uncompressed.distanceTravelledM * 30,
      8,
    );
  });

  it('retains a captive tow that reports force without integrating it', () => {
    const yaw = 0.4;
    const speed = 4;
    const harness = createHarness({
      mode: 'captive-tow',
      towVelocityX: Math.sin(yaw) * speed,
      towVelocityZ: Math.cos(yaw) * speed,
      towYawRad: yaw,
    });
    runSeconds(harness, 8, 60);
    const result = harness.advance(0);

    expect(harness.velocity.x).toBeCloseTo(Math.sin(yaw) * speed, 12);
    expect(harness.velocity.z).toBeCloseTo(Math.cos(yaw) * speed, 12);
    expect(harness.yawRad).toBeCloseTo(yaw, 12);
    expect(harness.yawRateRadPerSecond).toBe(0);
    expect(result.resistance.forceBodyN.z).toBeLessThan(-3_000);
    expect(lengthVec3(harness.world.state.velocityEcefMps)).toBeCloseTo(
      speed,
      12,
    );
  });

  it('builds the complete tracked decay and invariance contract', {
    tags: ['slow', 'ship-physics'],
    timeout: 120_000,
  }, () => {
    const evidence = buildSchoonerHorizontalDynamicsEvidence();
    const { coastDown, sideslipDecay, yawDecay, captiveTow } = evidence.cases;

    expect(coastDown.summary.speedMonotonicNonIncreasing).toBe(true);
    expect(coastDown.summary.finalSpeedMps).toBeLessThan(
      coastDown.summary.initialSpeedMps,
    );
    expect(sideslipDecay.summary.finalAbsolutePortSpeedMps).toBeLessThan(
      sideslipDecay.summary.initialAbsolutePortSpeedMps * 0.2,
    );
    expect(yawDecay.summary.finalAbsoluteYawRateRadPerSecond).toBeLessThan(
      yawDecay.summary.initialAbsoluteYawRateRadPerSecond * 0.1,
    );
    for (const result of [coastDown, sideslipDecay, yawDecay]) {
      expect(result.summary.maximumPositiveEnergyStepJ).toBeLessThan(1e-5);
    }
    expect(captiveTow.summary.initialSpeedMps).toBeCloseTo(4, 10);
    expect(captiveTow.summary.finalSpeedMps).toBeCloseTo(4, 10);
    expect(
      evidence.invariance.callerRate.velocityErrorMps,
    ).toBeLessThan(1e-10);
    expect(evidence.invariance.callerRate.yawErrorRad).toBeLessThan(1e-10);
    expect(evidence.invariance.voyageCompression.localVelocityErrorMps).toBe(0);
    expect(
      evidence.invariance.voyageCompression.globalDistanceRatio,
    ).toBeCloseTo(30, 8);
  });

  it('runs the wave-response comparison through free horizontal dynamics', { timeout: 120_000 }, () => {
    const result = runFreeHorizontalResponseCase(54, {
      warmupSeconds: 0,
      measurementSeconds: 2,
      callerHz: 60,
    });

    expect(result.horizontal.endSpeedMps).toBeLessThan(4);
    expect(result.horizontal.speedMps.min).toBeGreaterThan(0);
    expect(result.contact.touchedSafetyLimiter).toBe(false);
    expect(result.maxWaveInverseSolveResidualMetres).toBeLessThan(1e-6);
  });
});
