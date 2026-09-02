import type { WaveField } from '../../scene/Waves';
import { PHYSICS_STEP, type BuoyantBody } from '../BuoyantBody';
import type {
  MutableHorizontalVelocity,
  VesselHorizontalDynamicsBridge,
} from '../VesselMotion';
import {
  createSchoonerResistanceResult,
  evaluateSchoonerResistance,
  type SchoonerResistanceResult,
} from './SchoonerResistance';

/** Matches the 50 ms presentation clamp and BuoyantBody's emergency guard. */
const MAX_SUBSTEPS = 12;

/**
 * Constant horizontal added-mass coefficients, as fractions of rigid mass
 * (surge, sway) and dry yaw inertia (yaw). Design §6.4: the passive round
 * deliberately shipped dry inertias; sailing makes the gap visible in
 * acceleration and turn dynamics. These are explicit provisional mid-band
 * values — no strip theory, no tank data — to be retuned against the S3
 * turn-circle evidence. They are diagonal and body-frame: a slender hull
 * entrains far more water moving sideways than ahead.
 *
 * Changing any of these changes the passive baselines; regenerate
 * `ship:dynamics`, `ship:dynamics:response` and `ship:sailing` in the same
 * commit, per the standing rule.
 */
export const SCHOONER_HORIZONTAL_ADDED_MASS = Object.freeze({
  surge: 0.06,
  sway: 0.4,
  yaw: 0.3,
} as const);

/** Horizontal components of an external (non-water) wrench, world axes. */
export interface HorizontalExternalForce {
  forceWorldXN: number;
  forceWorldZN: number;
  /** About the vertical axis; positive turns the bow toward +x/port. */
  yawMomentNm: number;
}

/**
 * Per-substep source of external horizontal force — the sail rig, later a
 * tow line. Called once per fixed 240 Hz substep with the state that substep
 * integrates from, *before* the body's own update, so the provider may also
 * write `body.externalWrench` for the same instant. Evaluated in both bridge
 * modes: under captive tow the horizontal components are reported but not
 * integrated (the tow prescribes velocity), while the body wrench still
 * applies — a towed ship under sail heels.
 */
export interface HorizontalExternalForceProvider {
  evaluateSubstep(
    stepSeconds: number,
    body: BuoyantBody,
    yawRad: number,
    yawRateRadPerSecond: number,
    velocityWorldX: number,
    velocityWorldZ: number,
    out: HorizontalExternalForce,
  ): void;
  /** Re-anchor any internal clock; called from `reset`. */
  reset?(): void;
}

/**
 * Read-only fixed-step telemetry boundary for physical instruments and sensory
 * adapters. It observes the previous completed instant after resistance and
 * external-force evaluation, before this substep integrates. Human policy is
 * deliberately a separate `HorizontalSubstepCommander` and never receives
 * this exact surface.
 */
export interface HorizontalSubstepTruthObserver {
  observeSubstep(
    stepSeconds: number,
    body: BuoyantBody,
    yawRad: number,
    yawRateRadPerSecond: number,
    velocityWorldX: number,
    velocityWorldZ: number,
    resistance: Readonly<SchoonerResistanceResult>,
  ): void;
  reset?(): void;
}

/** Human/operator decisions fed only by an observation provider at composition. */
export interface HorizontalSubstepCommander {
  advanceSubstep(stepSeconds: number): void;
  reset?(): void;
}

/**
 * The helm's seam into the substep loop (S3). Each fixed substep integrates
 * with `currentRudderRad`, then `advanceSubstep` walks the rate limiter
 * across that substep — so commands take effect at the crewed rate on the
 * same 240 Hz grid the forces use, exactly caller-rate invariant. Absent,
 * every trajectory is bit-identical to the amidships-helm passive model.
 */
export interface RudderAngleProvider {
  /** Rudder deflection for the substep about to integrate, radians. */
  readonly currentRudderRad: number;
  /** Advance the rate limiter across one fixed substep. */
  advanceSubstep(stepSeconds: number): void;
  /** Return the helm to amidships; called from `reset`. */
  reset?(): void;
}

export interface SchoonerHorizontalDynamicsResult {
  yawRad: number;
  yawRateRadPerSecond: number;
  substeps: number;
  encounterDisplacementX: number;
  encounterDisplacementZ: number;
  kineticEnergyJ: number;
  /**
   * Cumulative work done by the external force on surge/sway/yaw since
   * `reset`, joules. The energy gate's budget: with water only dissipating,
   * horizontal kinetic energy may rise by at most this much.
   */
  externalWorkJ: number;
  /** Last evaluated external force; zero when no provider is attached. */
  readonly externalForce: HorizontalExternalForce;
  readonly resistance: SchoonerResistanceResult;
}

/**
 * Force-integrated surge, sway and yaw for the canonical schooner.
 *
 * Velocity is never stored here. Each caller supplies the transient render-
 * frame projection of canonical ECEF velocity, this fixed-step integrator
 * overwrites that view, and the bridge commits every midpoint displacement and
 * final velocity back to `PlanetaryWorld`. The schooner owns only orientation
 * and yaw rate, which are vessel state rather than navigation state.
 */
export class SchoonerHorizontalDynamics {
  private accumulatorSeconds = 0;
  private externalWorkJoules = 0;
  private readonly resistance = createSchoonerResistanceResult();
  private readonly external: HorizontalExternalForce = {
    forceWorldXN: 0,
    forceWorldZN: 0,
    yawMomentNm: 0,
  };
  /**
   * Optional external-force source (the sail rig). Absent, every trajectory
   * is bit-identical to the passive model — the zero-default contract the
   * committed passive evidence pins.
   */
  externalForces: HorizontalExternalForceProvider | undefined;
  /**
   * Optional helm (S3's `SailingControls`). Absent — or held amidships —
   * the resistance evaluation is bit-identical to the passive model.
   */
  helm: RudderAngleProvider | undefined;
  /** S5 truth → instrument/cue adapter; exact telemetry stops here. */
  substepTruthObserver: HorizontalSubstepTruthObserver | undefined;
  /** S5 human policy; composed separately so it cannot consume truth above. */
  substepCommander: HorizontalSubstepCommander | undefined;
  private readonly result: SchoonerHorizontalDynamicsResult = {
    yawRad: 0,
    yawRateRadPerSecond: 0,
    substeps: 0,
    encounterDisplacementX: 0,
    encounterDisplacementZ: 0,
    kineticEnergyJ: 0,
    externalWorkJ: 0,
    externalForce: this.external,
    resistance: this.resistance,
  };

  constructor(
    readonly massKg: number,
    readonly yawInertiaKgM2: number,
    readonly physicsStepSeconds = PHYSICS_STEP,
  ) {
    assertPositiveFinite(massKg, 'horizontal mass');
    assertPositiveFinite(yawInertiaKgM2, 'yaw inertia');
    assertPositiveFinite(physicsStepSeconds, 'horizontal physics step');
  }

  /** Running external-work total, readable mid-advance (e.g. per commit). */
  get externalWorkSoFarJ(): number {
    return this.externalWorkJoules;
  }

  /**
   * The most recent advance's view — the same stable object `advance`
   * returns, refreshed in place. The sailing dev panel reads the rudder and
   * resistance telemetry from here between advances.
   */
  get lastAdvance(): SchoonerHorizontalDynamicsResult {
    return this.result;
  }

  reset(): void {
    this.accumulatorSeconds = 0;
    this.externalWorkJoules = 0;
    this.external.forceWorldXN = 0;
    this.external.forceWorldZN = 0;
    this.external.yawMomentNm = 0;
    this.externalForces?.reset?.();
    this.substepTruthObserver?.reset?.();
    this.substepCommander?.reset?.();
    this.helm?.reset?.();
  }

  /**
   * Advance one caller interval, mutating the supplied canonical velocity view.
   *
   * Resistance is evaluated at the beginning of each fixed step. Velocity and
   * yaw rate are advanced explicitly, while encounter/global displacement and
   * yaw angle use the step midpoint. The body then samples the same midpoint
   * motion, so wave origin and canonical voyage cannot drift apart.
   */
  advance(
    dtSeconds: number,
    body: BuoyantBody,
    waves: WaveField,
    localX: number,
    localZ: number,
    velocityWorldMps: MutableHorizontalVelocity,
    yawRad: number,
    yawRateRadPerSecond: number,
    bridge: VesselHorizontalDynamicsBridge,
  ): SchoonerHorizontalDynamicsResult {
    assertNonNegativeFinite(dtSeconds, 'horizontal dt');
    assertFinite(velocityWorldMps.x, 'horizontal velocity x');
    assertFinite(velocityWorldMps.z, 'horizontal velocity z');
    assertFinite(yawRad, 'horizontal yaw');
    assertFinite(yawRateRadPerSecond, 'horizontal yaw rate');

    let velocityX = velocityWorldMps.x;
    let velocityZ = velocityWorldMps.z;
    let yaw = wrapAngle(yawRad);
    let yawRate = yawRateRadPerSecond;
    if (bridge.mode === 'captive-tow') {
      assertFinite(bridge.towVelocityWorldMps.x, 'tow velocity x');
      assertFinite(bridge.towVelocityWorldMps.z, 'tow velocity z');
      assertFinite(bridge.towYawRad, 'tow yaw');
      velocityX = bridge.towVelocityWorldMps.x;
      velocityZ = bridge.towVelocityWorldMps.z;
      yaw = wrapAngle(bridge.towYawRad);
      yawRate = 0;
    }

    // Refresh once before applying a force. This also settles a newly built
    // body without consuming caller time and captures any tow/control change
    // made between frames.
    body.update(
      0,
      waves,
      localX,
      localZ,
      yaw,
      this.physicsStepSeconds,
      velocityX,
      velocityZ,
    );

    this.result.substeps = 0;
    this.result.encounterDisplacementX = 0;
    this.result.encounterDisplacementZ = 0;
    this.accumulatorSeconds += dtSeconds;

    while (
      this.accumulatorSeconds >= this.physicsStepSeconds &&
      this.result.substeps < MAX_SUBSTEPS
    ) {
      const h = this.physicsStepSeconds;
      evaluateSchoonerResistance(
        {
          contacts: body.contacts,
          modelYawRad: yaw,
          yawRateRadPerSecond: yawRate,
          rudderAngleRad: this.helm?.currentRudderRad ?? 0,
        },
        this.resistance,
      );
      // The provider sees the same instant the resistance saw, and may set
      // the body's external wrench for the body update this substep performs.
      this.externalForces?.evaluateSubstep(
        h,
        body,
        yaw,
        yawRate,
        velocityX,
        velocityZ,
        this.external,
      );
      this.substepTruthObserver?.observeSubstep(
        h,
        body,
        yaw,
        yawRate,
        velocityX,
        velocityZ,
        this.resistance,
      );
      // The commander sees only the observation object supplied at the
      // composition root. A target written here cannot teleport the blade:
      // the existing helm limiter still advances once, at the end of this
      // substep, for use by the next force evaluation.
      this.substepCommander?.advanceSubstep(h);

      let nextVelocityX = velocityX;
      let nextVelocityZ = velocityZ;
      let nextYawRate = yawRate;
      if (bridge.mode === 'free') {
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        let forceWorldX =
          this.resistance.forceBodyN.x * cy +
          this.resistance.forceBodyN.z * sy;
        let forceWorldZ =
          -this.resistance.forceBodyN.x * sy +
          this.resistance.forceBodyN.z * cy;
        let yawMoment = this.resistance.yawMomentNm;
        if (this.externalForces) {
          forceWorldX += this.external.forceWorldXN;
          forceWorldZ += this.external.forceWorldZN;
          yawMoment += this.external.yawMomentNm;
        }
        // Added mass is diagonal in the body frame: rotate the net force to
        // body axes, divide each axis by its virtual mass, rotate the
        // acceleration back. Kinetic energy remains the rigid-body quantity;
        // the entrained water's share of wind work is real dissipation-like
        // storage the energy gate treats conservatively.
        const addedMass = SCHOONER_HORIZONTAL_ADDED_MASS;
        const forceBodyX = forceWorldX * cy - forceWorldZ * sy;
        const forceBodyZ = forceWorldX * sy + forceWorldZ * cy;
        const accelBodyX = forceBodyX / (this.massKg * (1 + addedMass.sway));
        const accelBodyZ = forceBodyZ / (this.massKg * (1 + addedMass.surge));
        nextVelocityX += (accelBodyX * cy + accelBodyZ * sy) * h;
        nextVelocityZ += (-accelBodyX * sy + accelBodyZ * cy) * h;
        nextYawRate +=
          (yawMoment / (this.yawInertiaKgM2 * (1 + addedMass.yaw))) * h;
        if (this.externalForces) {
          // Work over the displacement actually integrated: force at the
          // step start times midpoint motion — the energy gate's budget.
          this.externalWorkJoules +=
            (this.external.forceWorldXN * (velocityX + nextVelocityX) +
              this.external.forceWorldZN * (velocityZ + nextVelocityZ) +
              this.external.yawMomentNm * (yawRate + nextYawRate)) *
            0.5 *
            h;
        }
      }

      assertFinite(nextVelocityX, 'integrated horizontal velocity x');
      assertFinite(nextVelocityZ, 'integrated horizontal velocity z');
      assertFinite(nextYawRate, 'integrated yaw rate');

      const midpointVelocityX = (velocityX + nextVelocityX) * 0.5;
      const midpointVelocityZ = (velocityZ + nextVelocityZ) * 0.5;
      const midpointYawRate = (yawRate + nextYawRate) * 0.5;
      const nextYaw =
        bridge.mode === 'captive-tow'
          ? wrapAngle(bridge.towYawRad)
          : wrapAngle(yaw + midpointYawRate * h);
      const midpointYaw = midpointAngle(yaw, nextYaw);
      const displacementX = midpointVelocityX * h;
      const displacementZ = midpointVelocityZ * h;

      body.update(
        h,
        waves,
        localX,
        localZ,
        midpointYaw,
        h,
        midpointVelocityX,
        midpointVelocityZ,
        true,
      );
      bridge.commitStep(
        h,
        displacementX,
        displacementZ,
        nextVelocityX,
        nextVelocityZ,
        nextYaw,
        nextYawRate,
      );

      velocityX = nextVelocityX;
      velocityZ = nextVelocityZ;
      yaw = nextYaw;
      yawRate = nextYawRate;
      this.result.encounterDisplacementX += displacementX;
      this.result.encounterDisplacementZ += displacementZ;

      // The previous body update used midpoint kinematics for integration.
      // Re-evaluate without advancing time so the next force sees the exact
      // end velocity and attitude.
      body.update(
        0,
        waves,
        localX,
        localZ,
        yaw,
        h,
        velocityX,
        velocityZ,
        true,
      );

      // The substep integrated with its start-of-step rudder angle; the helm
      // walks across the substep now so the next force sees the moved blade.
      this.helm?.advanceSubstep(h);

      this.accumulatorSeconds -= h;
      if (this.accumulatorSeconds < 1e-14) this.accumulatorSeconds = 0;
      this.result.substeps++;
    }
    if (this.result.substeps === MAX_SUBSTEPS) {
      // Same bounded-stall policy as BuoyantBody. Main clamps to this exact
      // window, so discarding time is an emergency path rather than normal play.
      this.accumulatorSeconds = 0;
    }

    evaluateSchoonerResistance(
      {
        contacts: body.contacts,
        modelYawRad: yaw,
        yawRateRadPerSecond: yawRate,
        rudderAngleRad: this.helm?.currentRudderRad ?? 0,
      },
      this.resistance,
    );
    velocityWorldMps.x = velocityX;
    velocityWorldMps.z = velocityZ;
    body.lastSubsteps = this.result.substeps;
    this.result.yawRad = yaw;
    this.result.yawRateRadPerSecond = yawRate;
    this.result.externalWorkJ = this.externalWorkJoules;
    this.result.kineticEnergyJ = horizontalKineticEnergyJ(
      this.massKg,
      this.yawInertiaKgM2,
      velocityX,
      velocityZ,
      yawRate,
    );
    return this.result;
  }
}

export function horizontalKineticEnergyJ(
  massKg: number,
  yawInertiaKgM2: number,
  velocityX: number,
  velocityZ: number,
  yawRateRadPerSecond: number,
): number {
  return (
    0.5 * massKg * (velocityX * velocityX + velocityZ * velocityZ) +
    0.5 * yawInertiaKgM2 * yawRateRadPerSecond * yawRateRadPerSecond
  );
}

function midpointAngle(start: number, end: number): number {
  return wrapAngle(start + wrapAngle(end - start) * 0.5);
}

function wrapAngle(angle: number): number {
  let wrapped = (angle + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  assertFinite(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative, got ${value}`);
}

function assertPositiveFinite(value: number, name: string): void {
  assertFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive, got ${value}`);
}
