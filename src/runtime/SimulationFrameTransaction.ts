export interface SimulationFrameStep {
  readonly presentationDeltaSeconds: number;
  readonly rawRealDeltaSeconds: number;
}

interface MutableSimulationFrameStep {
  presentationDeltaSeconds: number;
  rawRealDeltaSeconds: number;
}

/**
 * The authoritative simulation-to-presentation transaction.
 *
 * These phases deliberately describe the current ownership model rather than
 * pretending the existing mutable subsystems are immutable snapshots. Each
 * phase publishes the state required by the next one, and the ordered contract
 * gives normal frames and deterministic evidence stepping one shared path.
 */
export interface SimulationFramePhases {
  advanceWorld(step: SimulationFrameStep): void;
  integrateVessel(step: SimulationFrameStep): void;
  deriveEnvironment(step: SimulationFrameStep): void;
  presentVesselAndCamera(step: SimulationFrameStep): void;
  updateSurfaceEffects(step: SimulationFrameStep): void;
  prepareOcean(step: SimulationFrameStep): void;
  prepareScene(step: SimulationFrameStep): void;
}

export const SIMULATION_FRAME_PHASES = [
  'advanceWorld',
  'integrateVessel',
  'deriveEnvironment',
  'presentVesselAndCamera',
  'updateSurfaceEffects',
  'prepareOcean',
  'prepareScene',
] as const satisfies readonly (keyof SimulationFramePhases)[];

/** Allocation-free coordinator for one complete simulation frame. */
export class SimulationFrameTransaction {
  private readonly frameStep: MutableSimulationFrameStep = {
    presentationDeltaSeconds: 0,
    rawRealDeltaSeconds: 0,
  };

  constructor(private readonly phases: SimulationFramePhases) {}

  step(
    presentationDeltaSeconds: number,
    rawRealDeltaSeconds = presentationDeltaSeconds,
  ): void {
    this.frameStep.presentationDeltaSeconds = presentationDeltaSeconds;
    this.frameStep.rawRealDeltaSeconds = rawRealDeltaSeconds;

    this.phases.advanceWorld(this.frameStep);
    this.phases.integrateVessel(this.frameStep);
    this.phases.deriveEnvironment(this.frameStep);
    this.phases.presentVesselAndCamera(this.frameStep);
    this.phases.updateSurfaceEffects(this.frameStep);
    this.phases.prepareOcean(this.frameStep);
    this.phases.prepareScene(this.frameStep);
  }
}
