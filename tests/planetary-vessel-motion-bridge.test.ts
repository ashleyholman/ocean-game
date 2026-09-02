import { describe, expect, it } from 'vitest';
import { PlanetaryVesselMotionBridge } from '../src/runtime/PlanetaryVesselMotionBridge';
import type { VesselHorizontalDynamicsBridge } from '../src/vessel/VesselMotion';

type TangentMotionCall = [
  physicsDeltaSeconds: number,
  encounterRightDisplacementM: number,
  encounterForwardDisplacementM: number,
  endRightMps: number,
  endForwardMps: number,
];

describe('planetary vessel motion bridge', () => {
  it('converts render axes at the canonical-world boundary and retains mutable controls', () => {
    const calls: TangentMotionCall[] = [];
    const world = {
      advanceTangentMotionStep(
        physicsDeltaSeconds: number,
        encounterRightDisplacementM: number,
        encounterForwardDisplacementM: number,
        endRightMps: number,
        endForwardMps: number,
      ): void {
        calls.push([
          physicsDeltaSeconds,
          encounterRightDisplacementM,
          encounterForwardDisplacementM,
          endRightMps,
          endForwardMps,
        ]);
      },
    };
    const towVelocity = { x: 1.25, z: -2.5 };
    const bridge: VesselHorizontalDynamicsBridge =
      new PlanetaryVesselMotionBridge(world, towVelocity);

    expect(bridge.mode).toBe('free');
    expect(bridge.towYawRad).toBe(0);
    expect(bridge.towVelocityWorldMps).toBe(towVelocity);

    bridge.mode = 'captive-tow';
    bridge.towYawRad = 0.75;
    bridge.towVelocityWorldMps.x = 3.5;
    towVelocity.z = -4.5;

    expect(bridge.mode).toBe('captive-tow');
    expect(bridge.towYawRad).toBe(0.75);
    expect(towVelocity.x).toBe(3.5);
    expect(bridge.towVelocityWorldMps.z).toBe(-4.5);

    bridge.commitStep(1 / 240, 2, 3, 4, 5, 0.6, 0.7);

    expect(calls).toEqual([[1 / 240, 2, -3, 4, -5]]);
  });
});
