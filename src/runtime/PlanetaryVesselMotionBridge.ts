import type {
  HorizontalDynamicsMode,
  MutableHorizontalVelocity,
  VesselHorizontalDynamicsBridge,
} from '../vessel/VesselMotion';

/** Canonical-world surface required by the vessel motion adapter. */
export interface PlanetaryTangentMotionTarget {
  advanceTangentMotionStep(
    physicsDeltaSeconds: number,
    encounterRightDisplacementM: number,
    encounterForwardDisplacementM: number,
    endRightMps: number,
    endForwardMps: number,
  ): unknown;
}

/**
 * Commits vessel-render-axis motion into canonical tangent-world axes.
 *
 * Vessel/render +Z points aft, while canonical tangent +forward maps to render
 * -Z. The fixed-step integrator supplies render-axis values, so both Z values
 * are negated exactly once at this boundary.
 */
export class PlanetaryVesselMotionBridge
  implements VesselHorizontalDynamicsBridge
{
  mode: HorizontalDynamicsMode = 'free';
  towYawRad = 0;

  constructor(
    private readonly world: PlanetaryTangentMotionTarget,
    readonly towVelocityWorldMps: MutableHorizontalVelocity,
  ) {}

  commitStep(
    physicsDeltaSeconds: number,
    encounterDisplacementX: number,
    encounterDisplacementZ: number,
    endVelocityX: number,
    endVelocityZ: number,
  ): void {
    this.world.advanceTangentMotionStep(
      physicsDeltaSeconds,
      encounterDisplacementX,
      -encounterDisplacementZ,
      endVelocityX,
      -endVelocityZ,
    );
  }
}
