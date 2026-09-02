import type { BuoyantBody } from '../BuoyantBody';
import {
  windRenderHeadingRad,
  windRenderVector,
  type WindVector,
  type WorldWind,
} from '../../world/WorldWind';
import type {
  HorizontalExternalForce,
  HorizontalExternalForceProvider,
} from './SchoonerHorizontalDynamics';
import {
  createSailAeroResult,
  evaluateSailAero,
  frozenSailStates,
  FULL_SAIL,
  type CanvasState,
  type SailAeroInput,
  type SailAeroResult,
  type SailAeroSailState,
  type TackSide,
} from './sailAero';
import { SAILS } from './rig';
import type { SailName } from './rig';
import type { SailingControls } from './SailingControls';

/**
 * The schooner's sail-force stepper: the stateful glue between the world's
 * wind, the pure aero maths, and the two integrator seams.
 *
 * Attached as `SchoonerHorizontalDynamics.externalForces`, it is called once
 * per fixed 240 Hz substep. Each call it evaluates the instantaneous (gusty)
 * wind, runs `evaluateSailAero`, hands the horizontal components back to the
 * dynamics and writes the vertical/pitch/roll components onto the body's
 * external wrench for the same instant. Sail physics is the first consumer
 * of the *instantaneous* wind branch — presentation stays on the mean.
 *
 * THE SUBSTEP WIND CLOCK
 * ----------------------
 * Gusts are evaluated at `base + substepCount · h`: a monotone grid anchored
 * to the world wind clock at `reset` and advanced by counting substeps. The
 * gust process is a pure function of time, so this is exactly caller-rate
 * invariant and exactly reproducible — the same substep sequence sees the
 * same wind regardless of how frames chop it. The grid can drift from the
 * frame clock by at most one substep plus any emergency-discard remainder,
 * which is milliseconds of gust phase against 10–60 s gust periods.
 */
export class SchoonerSailForces implements HorizontalExternalForceProvider {
  /**
   * Which sails are set — the S2/S3 frozen-trim fixture surface. When no
   * controls are attached, each substep maps this canvas + tack onto the
   * authored trims and fixed-point hoists (`frozenSailStates`), which is
   * exactly the pre-S4 model. With controls attached (production), the
   * live per-sail state wins and these two fields are ignored.
   */
  canvas: CanvasState = FULL_SAIL;
  /** The tack the frozen trim is set for; 'starboard' is the drawn rig. */
  tack: TackSide = 'starboard';
  /** Presentation frame heading, degrees — `waves.frameHeading` in production. */
  frameHeadingDeg = 0;

  private controls: SailingControls | null = null;

  /** S4: read live trim and hoist from the control surface each substep. */
  attachControls(controls: SailingControls | null): void {
    this.controls = controls;
  }

  /**
   * Evidence fixture: per-sail trim overrides, degrees, applied on top of
   * the frozen canvas + tack mapping (ignored while controls are attached).
   * The polar's trim-to-draw schedule sets these; the slaved gaff topsail
   * follows a mainsail override unless it carries its own.
   */
  fixedTrimsDeg: Partial<Record<SailName, number>> | null = null;

  /** Latest full evaluation, for telemetry and evidence breakdowns. */
  readonly lastResult: SailAeroResult = createSailAeroResult();

  private substepCount = 0;
  private baseElapsedSeconds: number;
  private readonly trueWind: WindVector = { x: 0, z: 0 };
  private readonly sailStates: SailAeroSailState[] = frozenSailStates(
    FULL_SAIL,
    'starboard',
  );
  private readonly input: SailAeroInput = {
    trueWindWorldX: 0,
    trueWindWorldZ: 0,
    velocityWorldX: 0,
    velocityWorldY: 0,
    velocityWorldZ: 0,
    yawRad: 0,
    pitchRad: 0,
    rollRad: 0,
    yawRateRadPerSecond: 0,
    pitchRateRadPerSecond: 0,
    rollRateRadPerSecond: 0,
    comX: 0,
    comY: 0,
    comZ: 0,
    sails: this.sailStates,
  };

  constructor(private readonly worldWind: WorldWind) {
    this.baseElapsedSeconds = worldWind.elapsedSeconds;
  }

  reset(): void {
    this.substepCount = 0;
    this.baseElapsedSeconds = this.worldWind.elapsedSeconds;
  }

  evaluateSubstep(
    stepSeconds: number,
    body: BuoyantBody,
    yawRad: number,
    yawRateRadPerSecond: number,
    velocityWorldX: number,
    velocityWorldZ: number,
    out: HorizontalExternalForce,
  ): void {
    const windTime = this.baseElapsedSeconds + this.substepCount * stepSeconds;
    this.substepCount++;
    windRenderVector(
      windRenderHeadingRad(
        this.worldWind.instantaneousDirectionTowardDegAt(windTime),
        this.frameHeadingDeg,
      ),
      this.worldWind.instantaneousSpeedMpsAt(windTime),
      this.trueWind,
    );

    const input = this.input;
    input.trueWindWorldX = this.trueWind.x;
    input.trueWindWorldZ = this.trueWind.z;
    input.velocityWorldX = velocityWorldX;
    input.velocityWorldY = body.velocityY;
    input.velocityWorldZ = velocityWorldZ;
    input.yawRad = yawRad;
    input.pitchRad = body.pitch;
    input.rollRad = body.roll;
    input.yawRateRadPerSecond = yawRateRadPerSecond;
    input.pitchRateRadPerSecond = body.pitchRate;
    input.rollRateRadPerSecond = body.rollRate;
    input.comX = body.comX;
    input.comY = body.comY;
    input.comZ = body.comZ;
    if (this.controls) {
      const controls = this.controls;
      for (let i = 0; i < SAILS.length; i++) {
        const name = SAILS[i].name;
        const state = this.sailStates[i];
        state.label = controls.settledSetState(name);
        state.hoistFraction = controls.hoistFraction(name);
        state.trimDeg = controls.trimDeg(name);
      }
    } else {
      frozenSailStates(this.canvas, this.tack, this.sailStates);
      const overrides = this.fixedTrimsDeg;
      if (overrides) {
        for (let i = 0; i < SAILS.length; i++) {
          const name = SAILS[i].name;
          const trim =
            overrides[name] ??
            (name === 'mainGaffTopsail' ? overrides.mainsail : undefined);
          if (trim !== undefined) this.sailStates[i].trimDeg = trim;
        }
      }
    }

    const result = evaluateSailAero(input, this.lastResult);
    out.forceWorldXN = result.forceWorldXN;
    out.forceWorldZN = result.forceWorldZN;
    out.yawMomentNm = result.yawMomentNm;
    body.externalWrench.forceYN = result.forceWorldYN;
    body.externalWrench.pitchTorqueNm = result.pitchTorqueNm;
    body.externalWrench.rollTorqueNm = result.rollTorqueNm;
  }
}
