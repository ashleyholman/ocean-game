import {
  windAngleOffBowDeg,
  windRenderHeadingRad,
  windRenderToBody,
  windRenderVector,
  type WindVector,
} from '../../world/WorldWind';
import {
  AUTHORED_TRIM_DEG,
  HARD_TRIM_DEG,
  RUDDER_LIMIT_DEG,
  WORKING_TRIM_DEG,
  type SailingControls,
} from './SailingControls';
import type { SailName } from './rig';
import {
  runSailCase,
  type SailRunScriptView,
  type TrajectorySample,
} from './SailingForceEvidence';
import {
  BARE_POLES,
  FULL_SAIL,
  SAIL_AERO_GEOMETRY,
  WORKING_SAIL,
  type CanvasState,
} from './sailAero';

/** v2: S4 — maneuvers sail the live control surface; the tack gate is a
 * success gate and the capture band is nullable. */
export const SAILING_STEERING_EVIDENCE_FORMAT_VERSION = 2;

/**
 * Steering evidence: turn circles, tack/gybe/irons maneuvers, weather helm.
 *
 * Three committed products (design §9), one shared harness:
 *
 * `ship:turn`  — steady circles under an honest synthetic thrust (the scene
 *                has no propeller; wind would break the port/starboard
 *                mirror, so a labelled constant force along the heading
 *                stands in for propulsion, its work on the energy budget).
 *                Radius is read as v/r from the settled window, not fitted.
 * `ship:tack`  — full maneuvers on the live S4 control surface: helm over,
 *                way carried through the eye, sheets worked at crew rate.
 *                The classic tack completes from every with-way entry now
 *                (S3's frozen trim could not); the gybe is the other sound
 *                course reversal; and five escape-from-irons cases measure
 *                which recovery mechanism actually frees her — the answer
 *                being the stern-board helm, NOT a backed headsail, for a
 *                reason the gates state.
 * `ship:helm`  — the weather-helm curve: rudder angle that zeroes the net
 *                yaw moment on a captive zero-leeway heading at the solved
 *                polar speed, per canvas balance. The leeway-solved version
 *                is the polar's job, not this file's.
 */

const RAD_TO_DEG = 180 / Math.PI;
const PHYSICS_HZ = 240;
const PROBE_SETTLE_SECONDS = 6;
const SPEED_BISECTION_ITERATIONS = 12;
const HELM_BISECTION_ITERATIONS = 12;
const SPEED_SEARCH_MAX_MPS = 6.5;

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return values.length > 0 ? total / values.length : 0;
}

// --- ship:turn ---------------------------------------------------------------

export interface TurnCircleCase {
  targetSpeedMps: number;
  thrustN: number;
  rudderCommandDeg: number;
  /** Straight-line speed the frame before the helm went over. */
  approachSpeedMps: number;
  steadySpeedMps: number;
  steadyYawRateRadPerS: number;
  /** v̄/|r̄| over the settled window. */
  steadyRadiusM: number;
  /** Signed angle from heading to velocity; positive = sliding toward port. */
  steadyDriftAngleDeg: number;
  /** 1 − steady/approach: the way she sheds in a turn. */
  speedLossFraction: number;
  /** max |r − r̄| / |r̄| over the window — the steadiness check. */
  yawRateUnsteadiness: number;
  maxEnergyOverWorkJ: number;
  trajectory?: TrajectorySample[];
}

export interface ShipTurnEvidence {
  formatVersion: number;
  status: string;
  contract: {
    method: string;
    scope: string;
    validationMeaning: string;
  };
  configuration: {
    physicsHz: number;
    helmOverSeconds: number;
    totalSeconds: number;
    steadyWindowSeconds: number;
    rudderAnglesDeg: number[];
    targetSpeedsMps: number[];
  };
  cases: TurnCircleCase[];
  straightLineControls: Array<{
    targetSpeedMps: number;
    thrustN: number;
    finalSpeedMps: number;
    yawDriftRad: number;
  }>;
  stoppedShip: {
    rudderCommandDeg: number;
    durationSeconds: number;
    finalYawRad: number;
    finalSpeedMps: number;
  };
  gates: {
    stoppedShipTurnRad: number;
    radiusMonotonicWithHelm: boolean;
    mirrorMaxRelativeError: number;
    minRadiusM: number;
    maxRadiusM: number;
    maxEnergyOverWorkJ: number;
    maxYawRateUnsteadiness: number;
  };
}

const TURN_HELM_OVER_S = 40;
const TURN_TOTAL_S = 200;
const TURN_WINDOW_S = 40;
const TURN_ANGLES_DEG = [10, 20, 30];
const TURN_TARGET_SPEEDS_MPS = [2.5, 4];

/** Calm-water drag at a captive speed — the thrust that holds it. */
function probeDragN(speedMps: number): number {
  const run = runSailCase({
    durationSeconds: PROBE_SETTLE_SECONDS,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: speedMps,
    yawRad: 0,
    windSpeedMps: 0,
    windDirectionTowardDeg: 0,
    gustiness: 0,
    canvas: BARE_POLES,
    tack: 'starboard',
    mode: 'captive-tow',
    towVelocityX: 0,
    towVelocityZ: speedMps,
    towYawRad: 0,
    sampleEverySeconds: PROBE_SETTLE_SECONDS,
  });
  return -run.finalResistanceBodyZN;
}

function driftAngleDeg(
  yawRad: number,
  velocityX: number,
  velocityZ: number,
): number {
  const speed = Math.hypot(velocityX, velocityZ);
  if (speed < 1e-9) return 0;
  const headingX = Math.sin(yawRad);
  const headingZ = Math.cos(yawRad);
  const along = velocityX * headingX + velocityZ * headingZ;
  const across = velocityX * headingZ - velocityZ * headingX;
  return Math.atan2(across, along) * RAD_TO_DEG;
}

function runTurnCase(
  targetSpeedMps: number,
  thrustN: number,
  rudderCommandDeg: number,
  recordTrajectory: boolean,
): TurnCircleCase {
  let approachSpeedMps = 0;
  const windowYawRates: number[] = [];
  const windowSpeeds: number[] = [];
  const windowDrifts: number[] = [];
  const run = runSailCase({
    durationSeconds: TURN_TOTAL_S,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: targetSpeedMps,
    yawRad: 0,
    windSpeedMps: 0,
    windDirectionTowardDeg: 0,
    gustiness: 0,
    canvas: BARE_POLES,
    tack: 'starboard',
    thrustN,
    recordTrajectory,
    sampleEverySeconds: 4,
    script: (view: SailRunScriptView) => {
      if (view.timeSeconds < TURN_HELM_OVER_S) {
        approachSpeedMps = Math.hypot(view.velocityX, view.velocityZ);
        view.helm.commandRudderDeg(0);
      } else {
        view.helm.commandRudderDeg(rudderCommandDeg);
      }
      if (view.timeSeconds >= TURN_TOTAL_S - TURN_WINDOW_S) {
        windowYawRates.push(view.yawRateRadPerSecond);
        windowSpeeds.push(Math.hypot(view.velocityX, view.velocityZ));
        windowDrifts.push(
          driftAngleDeg(view.yawRad, view.velocityX, view.velocityZ),
        );
      }
    },
  });
  const steadyYawRate = mean(windowYawRates);
  const steadySpeed = mean(windowSpeeds);
  let unsteadiness = 0;
  for (const rate of windowYawRates) {
    unsteadiness = Math.max(
      unsteadiness,
      Math.abs(rate - steadyYawRate) / Math.max(Math.abs(steadyYawRate), 1e-9),
    );
  }
  return {
    targetSpeedMps,
    thrustN: round(thrustN, 3),
    rudderCommandDeg,
    approachSpeedMps: round(approachSpeedMps, 5),
    steadySpeedMps: round(steadySpeed, 5),
    steadyYawRateRadPerS: round(steadyYawRate, 7),
    steadyRadiusM: round(steadySpeed / Math.max(Math.abs(steadyYawRate), 1e-9), 3),
    steadyDriftAngleDeg: round(mean(windowDrifts), 4),
    speedLossFraction: round(1 - steadySpeed / Math.max(approachSpeedMps, 1e-9), 5),
    yawRateUnsteadiness: round(unsteadiness, 6),
    maxEnergyOverWorkJ: round(run.maxEnergyOverWorkJ, 6),
    trajectory: run.trajectory,
  };
}

export function buildShipTurnEvidence(): ShipTurnEvidence {
  const cases: TurnCircleCase[] = [];
  const straightLineControls: ShipTurnEvidence['straightLineControls'] = [];

  for (const target of TURN_TARGET_SPEEDS_MPS) {
    const thrustN = probeDragN(target);
    const control = runSailCase({
      durationSeconds: TURN_TOTAL_S,
      callerHz: 60,
      voyageCompression: 30,
      velocityX: 0,
      velocityZ: target,
      yawRad: 0,
      windSpeedMps: 0,
      windDirectionTowardDeg: 0,
      gustiness: 0,
      canvas: BARE_POLES,
      tack: 'starboard',
      thrustN,
      sampleEverySeconds: TURN_TOTAL_S,
    });
    straightLineControls.push({
      targetSpeedMps: target,
      thrustN: round(thrustN, 3),
      finalSpeedMps: round(
        Math.hypot(control.finalVelocityX, control.finalVelocityZ),
        5,
      ),
      yawDriftRad: round(control.finalYawRad, 8),
    });
    for (const angle of TURN_ANGLES_DEG) {
      for (const sign of [1, -1]) {
        cases.push(
          runTurnCase(
            target,
            thrustN,
            sign * angle,
            // One representative trajectory pair per speed for inspection.
            angle === 20,
          ),
        );
      }
    }
  }

  const stopped = runSailCase({
    durationSeconds: 30,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 0,
    yawRad: 0,
    windSpeedMps: 0,
    windDirectionTowardDeg: 0,
    gustiness: 0,
    canvas: BARE_POLES,
    tack: 'starboard',
    rudderCommandDeg: () => 30,
    sampleEverySeconds: 30,
  });

  let radiusMonotonicWithHelm = true;
  let mirrorMaxRelativeError = 0;
  let minRadiusM = Infinity;
  let maxRadiusM = 0;
  let maxEnergyOverWorkJ = -Infinity;
  let maxYawRateUnsteadiness = 0;
  for (const target of TURN_TARGET_SPEEDS_MPS) {
    for (const sign of [1, -1]) {
      let previousRadius = Infinity;
      for (const angle of TURN_ANGLES_DEG) {
        const found = cases.find(
          (c) =>
            c.targetSpeedMps === target && c.rudderCommandDeg === sign * angle,
        )!;
        if (found.steadyRadiusM >= previousRadius) {
          radiusMonotonicWithHelm = false;
        }
        previousRadius = found.steadyRadiusM;
      }
    }
    for (const angle of TURN_ANGLES_DEG) {
      const port = cases.find(
        (c) => c.targetSpeedMps === target && c.rudderCommandDeg === angle,
      )!;
      const starboard = cases.find(
        (c) => c.targetSpeedMps === target && c.rudderCommandDeg === -angle,
      )!;
      mirrorMaxRelativeError = Math.max(
        mirrorMaxRelativeError,
        Math.abs(port.steadyRadiusM - starboard.steadyRadiusM) /
          Math.max(port.steadyRadiusM, starboard.steadyRadiusM),
      );
    }
  }
  for (const c of cases) {
    minRadiusM = Math.min(minRadiusM, c.steadyRadiusM);
    maxRadiusM = Math.max(maxRadiusM, c.steadyRadiusM);
    maxEnergyOverWorkJ = Math.max(maxEnergyOverWorkJ, c.maxEnergyOverWorkJ);
    maxYawRateUnsteadiness = Math.max(
      maxYawRateUnsteadiness,
      c.yawRateUnsteadiness,
    );
  }

  return {
    formatVersion: SAILING_STEERING_EVIDENCE_FORMAT_VERSION,
    status:
      'S3: steady turn circles under commanded rudder with synthetic thrust ' +
      'standing in for propulsion. Sails and wind are deliberately absent so ' +
      'the port/starboard mirror is a pure hull+rudder statement.',
    contract: {
      method:
        'Constant force along the heading holds way; helm goes over after a ' +
        'straight approach; radius is steady speed over steady yaw rate in ' +
        'the settled window, not a geometric fit.',
      scope:
        'Two target speeds x rudder 10/20/30 both directions, flat water. ' +
        'Plus straight-line controls, and a stopped ship with full helm.',
      validationMeaning:
        'Mirror symmetry, radius-vs-helm monotonicity, no turn without way, ' +
        'the energy gate under thrust, and steadiness of the settled circle. ' +
        'Radii are model results from provisional coefficients, not claims ' +
        'of measured ship performance.',
    },
    configuration: {
      physicsHz: PHYSICS_HZ,
      helmOverSeconds: TURN_HELM_OVER_S,
      totalSeconds: TURN_TOTAL_S,
      steadyWindowSeconds: TURN_WINDOW_S,
      rudderAnglesDeg: [...TURN_ANGLES_DEG],
      targetSpeedsMps: [...TURN_TARGET_SPEEDS_MPS],
    },
    cases,
    straightLineControls,
    stoppedShip: {
      rudderCommandDeg: 30,
      durationSeconds: 30,
      finalYawRad: round(stopped.finalYawRad, 12),
      finalSpeedMps: round(
        Math.hypot(stopped.finalVelocityX, stopped.finalVelocityZ),
        8,
      ),
    },
    gates: {
      stoppedShipTurnRad: round(Math.abs(stopped.finalYawRad), 12),
      radiusMonotonicWithHelm,
      mirrorMaxRelativeError: round(mirrorMaxRelativeError, 8),
      minRadiusM: round(minRadiusM, 3),
      maxRadiusM: round(maxRadiusM, 3),
      maxEnergyOverWorkJ: round(maxEnergyOverWorkJ, 6),
      maxYawRateUnsteadiness: round(maxYawRateUnsteadiness, 6),
    },
  };
}

// --- ship:tack ---------------------------------------------------------------

export interface ManeuverTraceSample {
  timeSeconds: number;
  windAngleOffBowDeg: number;
  speedMps: number;
  yawRateRadPerS: number;
  rudderDeg: number;
}

export interface TackCase {
  windSpeedMps: number;
  /** True-wind source angle the approach leg holds, negative = starboard. */
  entryAngleDeg: number;
  /** Seconds of held approach before the order. */
  entryDelaySeconds: number;
  entrySpeedMps: number;
  completed: boolean;
  timeToCrossEyeS: number | null;
  /** Speed as the bow crossed the eye — entry-invariant in this model. */
  eyeCrossSpeedMps: number | null;
  timeToCompleteS: number | null;
  minSpeedMps: number;
  exitSpeedMps: number;
  /** Where the in-irons attractor held her (mean wind angle, final 20 s);
   * null when the tack completed. */
  captureAngleDeg: number | null;
  maxEnergyOverWorkJ: number;
  trace: ManeuverTraceSample[];
}

export interface GybeCase {
  windSpeedMps: number;
  completed: boolean;
  timeToCompleteS: number | null;
  /** Heading swing through dead astern, ±170° to ±170°. */
  transitSeconds: number | null;
  maxYawRateRadPerS: number;
  maxEnergyOverWorkJ: number;
  trace: ManeuverTraceSample[];
}

/**
 * Caught in irons: head to wind, dead in the water, rudder useless. The
 * question this case answers is whether the ship can get herself out —
 * and by which means.
 */
export interface IronsEscapeCase {
  /**
   * What the crew does. `drift` is the do-nothing control; the other
   * three separate the two candidate mechanisms — the backed sail and
   * the stern-board helm — so neither can take credit for the other.
   */
  method:
    | 'drift'
    | 'backed-headsail'
    | 'helm-only'
    | 'backed-headsail-and-helm';
  windSpeedMps: number;
  /** Bow paid off far enough to sail (|wind angle| ≥ the fill sector). */
  escaped: boolean;
  timeToPayOffS: number | null;
  /** Which way she fell off: 'port'/'starboard' bow down, or null. */
  fellOffToward: 'port' | 'starboard' | null;
  /** Where she ended up pinned when she did NOT escape (mean wind angle
   * over the final window) — the attractor that held her. */
  settledAngleDeg: number | null;
  /** Which side the headsail was backed to (and the helm ordered toward);
   * the sheets are flat on the PORT side throughout, so 'starboard' is
   * falling off away from the sheets and 'port' is toward them. */
  backedToward: 'port' | 'starboard';
  /** Greatest sternway made while stuck — a real ship gathers it. */
  maxSternwayMps: number;
  /** Speed once she is through and sailing again. */
  exitSpeedMps: number;
  /** Mean absolute yaw rate over the escape, deg/s — the S3 stern-board
   * recovery managed 0.05°/s, which is what "hopeless" looked like. */
  meanYawRateDegPerS: number;
  maxEnergyOverWorkJ: number;
  trace: ManeuverTraceSample[];
}

export interface ShipTackEvidence {
  formatVersion: number;
  status: string;
  contract: {
    method: string;
    scope: string;
    validationMeaning: string;
  };
  tacks: TackCase[];
  gybe: GybeCase;
  ironsEscapes: IronsEscapeCase[];
  gates: {
    /**
     * FLIPPED FALSE AGAIN IN S6c, and the reversal is deliberate.
     *
     * S3 measured this false (in-irons capture at the frozen reach trim).
     * S4 flipped it true by hardening the sheets at the order. S6c's
     * induced-drag term prices hard-sheeted lift for the first time — a
     * gaff main is AR 3.06 and pays CL²/(π·AR·e) for every bit of it — and
     * the flat maneuvering trims no longer buy enough drive to carry her
     * from the eye out to a close-hauled groove that has itself moved from
     * ~45° to 55-60°. She goes round; she does not settle.
     *
     * READ THIS WITH `everyWithWayEntryCrossesEye`, WHICH IS STILL TRUE.
     * The bow crosses the wind on every entry at 1.11-1.43 m/s. What fails
     * is the last 20° of the evolution, and it fails against a script that
     * holds one fixed helm angle and one fixed pair of trims until a fixed
     * completion angle. The CREW have a different tack — work the sheets
     * against the cloth, stern-board if she hangs — and it completes:
     * `voyage-baseline.json`, three tacks ordered and three completed on a
     * 4 km beat. The stale instrument is this script, not the ship.
     */
    classicTackCompletesAtAnyEntry: boolean;
    /** Stronger S4 form: EVERY with-way entry stays. False since S6c. */
    everyWithWayEntryCompletes: boolean;
    /**
     * Every with-way entry crossed the eye — way IS carried through. This
     * is the half of S4's win that survived the coefficient round, and it
     * only survives because the tacks now hand the square topsail: with it
     * set and aback, no entry reached the eye at all.
     */
    everyWithWayEntryCrossesEye: boolean;
    /**
     * [min, max] capture angle over failed with-way entries; null when
     * every entry completes (the S4 expectation, no longer met).
     *
     * S6c reads **21.0-32.6°**, on the far side of the eye. S3's was
     * 34.0-34.9° on the near side. Same attractor, same mechanism — the
     * sails fill, their weather moment pins her, yaw rate goes to zero —
     * reached from the other direction because she now gets through the
     * wind and cannot get away from it.
     */
    captureAngleBandDeg: [number, number] | null;
    /** [min, max] speed crossing the eye over with-way entries. */
    eyeCrossSpeedBandMps: [number, number];
    /** The from-rest order never even reaches the eye. */
    lowWayFailsBeforeEye: boolean;
    maxEnergyOverWorkJ: number;
    /** She wears (gybes) soundly — the course reversal that works today. */
    gybeCompleted: boolean;
    gybeMaxYawRateRadPerS: number;
    /**
     * IRONS. FINDING S4-2 IS CLOSED AND EVERY GATE BELOW REVERSED (S6c).
     *
     * S4 measured five cases and found that the one technique a real crew
     * uses — back a headsail — did literally nothing, because
     * `sailLiftCoefficient` returned 0 for any negative angle of attack.
     * That branch exists now. All five cases free her, and the two
     * attractors S4 documented are both gone.
     */
    ironsSternBoardEscapes: boolean;
    /**
     * THE FINDING, CLOSED: a backed headsail alone now frees her in 48.4 s
     * where S4 measured her pinned at −18.8° for the whole 240 s timeout.
     * Gated TRUE. It was gated false with an instruction to come here and
     * say so deliberately the day the aback branch landed; this is that.
     */
    ironsBackedHeadsailAloneEscapes: boolean;
    /**
     * How many seconds the backed sail saves when added to the helm.
     * Still NEGATIVE — −2.6 s, worse than S4's −0.5 s. Backing a sail and
     * putting the helm the same way are two ways of doing one job, and
     * doing both is not twice as good; the backed cloth's drag holds her
     * sternway down, and sternway is what makes the reversed blade bite.
     */
    ironsBackedHeadsailSecondsSaved: number;
    /** Seconds to pay off under the helm alone. 79.9 s → 48.0 s. */
    ironsSternBoardPayOffS: number | null;
    /**
     * Left alone she pays off in 44.3 s, where S4 measured 229.2 s.
     *
     * THIS IS THE ONE TO BE SUSPICIOUS OF. S4 already flagged the drift
     * case as an artefact — rigid cloth cannot flog, so eased sheets act
     * like small set sails — and the aback branch makes that artefact
     * stronger, not weaker: her flat-sheeted cloth is now *pressed* on its
     * other face rather than idling at `cdLuffing`. 44 s is a plausible
     * time for a real ship to fall off unaided, so the number is not
     * absurd, but it is reached for a reason that is partly modelling
     * convenience. Surfaced, not fixed: the fix is flogging forces, which
     * the design has deferred since v1.
     */
    ironsDriftPayOffS: number | null;
    /**
     * Falling off TOWARD the sheeted side used to meet a second attractor
     * at ≈20° instead of paying off. It does not any more — she frees in
     * 64.1 s, slower than the other way (48.0 s) but free. Null means the
     * attractor is gone, which since S6c is the expected reading.
     */
    ironsTowardSheetsAttractorDeg: number | null;
  };
}

/** True-wind source angle off the bow at a yaw, harness frame (heading 0). */
function windAngleAtYawDeg(
  windDirectionTowardDeg: number,
  windSpeedMps: number,
  yawRad: number,
  scratchRender: WindVector,
  scratchBody: WindVector,
): number {
  windRenderVector(
    windRenderHeadingRad(windDirectionTowardDeg, 0),
    windSpeedMps,
    scratchRender,
  );
  windRenderToBody(scratchRender.x, scratchRender.z, yawRad, scratchBody);
  return windAngleOffBowDeg(scratchBody.x, scratchBody.z);
}

const TACK_HELM_DEG = -25;
/** Default approach: a close reach — "a good full before the eye". */
const TACK_ENTRY_ANGLE_DEG = -65;
/** The course she settles onto once through: the close-hauled groove. */
const TACK_EXIT_ANGLE_DEG = 55;
const TACK_COMPLETE_ANGLE_DEG = 42;
const TACK_TIMEOUT_S = 150;
/** Capture statistics read over the maneuver's final window. */
const TACK_CAPTURE_WINDOW_S = 20;

/**
 * S4's trim actions — the fix the S3 finding named. Hardened sheets bring
 * every fill threshold inside the old ±34° attractor (a sail trimmed to
 * 10–14° starts drawing ~20° off the wind, where the frozen 26–37° reach
 * set needed 38–42°), so the moment the bow pays off past the eye there is
 * drive behind the turn instead of a weather moment ahead of it.
 * Magnitudes in degrees; the sign is the tack (positive = port side).
 */
// MANEUVERING trims, flatter than the polar schedule's 20° steady working
// floor — and measured to be necessary: hauled only to 20°, every entry
// crosses the eye and then dies in the fill band (min speed 0.22–0.34 m/s, no
// completion) because cloth that starts drawing at ≈30° is still too close to
// the 34° attractor. Hauled flat for the evolution — which is what "haul taut,
// lee-oh" is — she stays, every entry. The sheets ease back to working trim
// once the tack is complete, so the flat haul lives only inside the maneuver,
// exactly as it did aboard.
//
// The table itself moved to `SailingControls.ts` when S5's trimmers needed the
// same numbers as their hard-in floor; the values are unchanged.
const TACK_HARD_TRIMS_DEG = HARD_TRIM_DEG;

/** Working trim eased to after the tack completes — the steady close-
 * hauled set, matching the polar schedule's working floor. The number itself
 * moved to `SailingControls.ts` when S6's trimmers needed the same exit trim
 * for a crewed tack; the value is unchanged. */
const TACK_EXIT_TRIM_DEG = WORKING_TRIM_DEG;

/** The angle on the new bow at which the held (backed) staysail is let
 * draw — "hold the weather sheet till she pays off". */
const TACK_BACKED_STAYSAIL_RELEASE_DEG = 12;

function commandTackTrims(
  helm: SailingControls,
  sign: 1 | -1,
  options?: { holdStaysail?: boolean },
): void {
  for (const [sail, magnitude] of Object.entries(TACK_HARD_TRIMS_DEG) as [
    SailName,
    number,
  ][]) {
    if (options?.holdStaysail && sail === 'foreStaysail') continue;
    helm.commandTrimDeg(sail, sign * magnitude);
  }
  helm.commandFishermanSide(sign > 0 ? 'port' : 'starboard');
}

/**
 * Evidence-only course hold on the true-wind angle. Without it the free
 * ship does what S2a documented: wanders under the sail yaw moment and
 * rounds up long before she has way for the maneuver. A small P-D law on
 * the wind angle is the least helm that keeps an approach honest; the
 * production, human-shaped version of this is S5's `Helmsman`.
 */
function courseHoldRudderDeg(
  targetAngleDeg: number,
  angleDeg: number,
  yawRateRadPerSecond: number,
): number {
  const errorDeg = angleDeg - targetAngleDeg;
  const damping = -yawRateRadPerSecond * RAD_TO_DEG;
  const command = 1.5 * errorDeg + 2.0 * damping;
  return Math.max(-25, Math.min(25, command));
}

function runTackCase(
  windSpeedMps: number,
  entryAngleDeg: number,
  entryDelaySeconds: number,
  /**
   * Way on the ship when the case begins. A tack starts from an established
   * leg; from a standstill the rudder has no authority (force scales with
   * inflow speed squared) and the sail moment weathercocks her before she
   * can gather way — which is exactly what the low-way failure case
   * demonstrates by starting from rest.
   */
  initialSpeedMps: number,
): TackCase {
  const windDirectionTowardDeg = -entryAngleDeg;
  const scratchRender: WindVector = { x: 0, z: 0 };
  const scratchBody: WindVector = { x: 0, z: 0 };
  const durationSeconds = entryDelaySeconds + TACK_TIMEOUT_S;
  let entrySpeedMps = 0;
  let attached = false;
  let ordered = false;
  let crossed = false;
  let staysailReleased = false;
  let completed = false;
  let timeToCrossEyeS: number | null = null;
  let eyeCrossSpeedMps: number | null = null;
  let timeToCompleteS: number | null = null;
  let minSpeedMps = Infinity;
  const captureAngles: number[] = [];
  const trace: ManeuverTraceSample[] = [];
  let lastTraceSecond = -Infinity;

  const run = runSailCase({
    durationSeconds,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: initialSpeedMps,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg,
    gustiness: 0,
    canvas: FULL_SAIL,
    tack: 'starboard',
    sampleEverySeconds: durationSeconds,
    script: (view) => {
      if (!attached) {
        // S4: the maneuver is sailed on the live control surface — the
        // same rate-limited sheets and helm a player works. The approach
        // leg sails the authored trims the controls start at.
        attached = true;
        view.sails.attachControls(view.helm);
        // "HAND THE TOPSAIL" — the order that comes before "ready about" on
        // a topsail schooner, and the one this harness did not know (S6c).
        //
        // A square sail cannot be braced to draw close-hauled: her braces
        // stop at 22° and the apparent wind is 40° forward of that, so on
        // the approach it already stands 65° ABACK. Until the coefficient
        // round an aback sail carried nothing and the point was invisible;
        // it is now 35 m² of pressed cloth at CD ~ 1.0, and MEASURED that is
        // what stops the tack — carrying it, no with-way entry reaches the
        // eye at all (captured -48 to -67 degrees), while the same script
        // with the aback branch switched off and the induced-drag term left
        // in crosses the eye on every entry. The topsail, not induced drag,
        // is the term that takes her way away.
        //
        // The production crew have known this since S6: the hand at the
        // yard reports `cannot draw` and the navigator strikes it 4.0 s
        // later, which is why `ship:voyage` beats to windward with three
        // tacks ordered and three completed while this harness could not
        // tack at all. This line is the harness catching up with the crew,
        // and it is the only change the coefficient round made to a
        // maneuver script. It is given at the top of the approach leg
        // because it is a separate evolution — 150 crew-seconds — and it
        // has to be finished before the helm goes down.
        view.helm.commandSetState('foreTopsail', 'furled');
      }
      const speed = Math.hypot(view.velocityX, view.velocityZ);
      const angle = windAngleAtYawDeg(
        windDirectionTowardDeg,
        windSpeedMps,
        view.yawRad,
        scratchRender,
        scratchBody,
      );
      if (view.timeSeconds >= durationSeconds - TACK_CAPTURE_WINDOW_S) {
        captureAngles.push(angle);
      }
      if (view.timeSeconds < entryDelaySeconds) {
        // Held on the approach course while the leg settles; a free helm
        // would let her round up under the sail moment (S2a's wander).
        entrySpeedMps = speed;
        view.helm.commandRudderDeg(
          courseHoldRudderDeg(
            entryAngleDeg,
            angle,
            view.yawRateRadPerSecond,
          ),
        );
      } else {
        if (!ordered) {
          ordered = true;
          minSpeedMps = speed;
          // "Ready about": harden everything for the beat as the helm goes
          // down. Measured against the alternative (carrying the reach trim
          // into the turn and hardening at −45°): hardening at the order
          // completes all three with-way entries in 89–132 s; the delayed
          // harden loses the beam-reach entry outright — the sheets are
          // still walking when she reaches the fill band, which is the S3
          // failure in miniature. Early is right.
          commandTackTrims(view.helm, 1);
        }
        minSpeedMps = Math.min(minSpeedMps, speed);
        if (!crossed && angle >= 0) {
          crossed = true;
          timeToCrossEyeS = view.timeSeconds - entryDelaySeconds;
          eyeCrossSpeedMps = speed;
          // "Lee-oh": haul everything across — except the staysail, held
          // aback on the old sheet to push the bow through the fill band.
          commandTackTrims(view.helm, -1, { holdStaysail: true });
        }
        if (
          crossed &&
          !staysailReleased &&
          angle >= TACK_BACKED_STAYSAIL_RELEASE_DEG
        ) {
          staysailReleased = true;
          view.helm.commandTrimDeg(
            'foreStaysail',
            -TACK_HARD_TRIMS_DEG.foreStaysail!,
          );
        }
        if (!completed && crossed && angle >= TACK_COMPLETE_ANGLE_DEG) {
          completed = true;
          timeToCompleteS = view.timeSeconds - entryDelaySeconds;
          // Tack complete: ease from the flat maneuvering haul to the
          // steady close-hauled working trim on the new board.
          for (const sail of Object.keys(TACK_HARD_TRIMS_DEG) as SailName[]) {
            if (sail === 'foreTopsail') continue;
            view.helm.commandTrimDeg(sail, -TACK_EXIT_TRIM_DEG);
          }
        }
        // "Shift your helm": if she hangs in stays and gathers sternway, the
        // rudder steers reversed (the model's sternway steering, pinned by
        // test), so the turning helm reverses with it — the stern-board
        // recovery every square-rigger manual teaches. Without this the
        // held headway helm actively backs her out of the tack.
        const alongSpeedMps =
          view.velocityX * Math.sin(view.yawRad) +
          view.velocityZ * Math.cos(view.yawRad);
        view.helm.commandRudderDeg(
          completed
            ? courseHoldRudderDeg(
                TACK_EXIT_ANGLE_DEG,
                angle,
                view.yawRateRadPerSecond,
              )
            : alongSpeedMps >= 0
              ? TACK_HELM_DEG
              : -TACK_HELM_DEG,
        );
      }
      if (view.timeSeconds - lastTraceSecond >= 2) {
        lastTraceSecond = view.timeSeconds;
        trace.push({
          timeSeconds: round(view.timeSeconds, 2),
          windAngleOffBowDeg: round(angle, 2),
          speedMps: round(speed, 4),
          yawRateRadPerS: round(view.yawRateRadPerSecond, 5),
          rudderDeg: round(view.helm.rudderAngleDeg, 2),
        });
      }
    },
  });

  return {
    windSpeedMps,
    entryAngleDeg,
    entryDelaySeconds,
    entrySpeedMps: round(entrySpeedMps, 4),
    completed,
    timeToCrossEyeS: timeToCrossEyeS === null ? null : round(timeToCrossEyeS, 2),
    eyeCrossSpeedMps:
      eyeCrossSpeedMps === null ? null : round(eyeCrossSpeedMps, 4),
    timeToCompleteS: timeToCompleteS === null ? null : round(timeToCompleteS, 2),
    minSpeedMps: round(minSpeedMps, 4),
    exitSpeedMps: round(
      Math.hypot(run.finalVelocityX, run.finalVelocityZ),
      4,
    ),
    captureAngleDeg: completed ? null : round(mean(captureAngles), 3),
    maxEnergyOverWorkJ: round(run.maxEnergyOverWorkJ, 6),
    trace,
  };
}

// --- caught in irons, and getting out of it ----------------------------------

const IRONS_TIMEOUT_S = 240;
/** Paid off this far, the sails can fill and she is sailing again — the
 * polar's sailing sector opens ≈35–40° at the working trim floor. */
const IRONS_ESCAPE_ANGLE_DEG = 45;
/** How hard the backed headsail is sheeted to windward. Well outside the
 * working trims: a backed sail is deliberately presenting its front face,
 * not trying to draw. */
const IRONS_BACKED_SHEET_DEG = 55;
/**
 * The stuck state's sheets: flat, where a failed tack leaves them
 * (`TACK_HARD_TRIMS_DEG`'s maneuvering haul). Measured head to wind at
 * rest, every sail luffs at EVERY sheet angle and drive is ≈−1050 N —
 * she is genuinely in irons, being pushed astern. But the luffing sails
 * still carry one-sided drag proportional to how far they are eased
 * (yaw moment 0.18 kNm at 0°, 0.86 kNm at 60°), because the model's
 * cloth is a rigid surface and cannot flog. Eased sheets therefore sail
 * her out of irons unaided in ~75 s, which is a flogging artefact rather
 * than seamanship — so the stuck state is measured with the sheets flat,
 * where that artefact is smallest and the backed sail is the real
 * asymmetry.
 */
const IRONS_STUCK_SHEET_DEG = 12;

/**
 * Can she get out of irons?
 *
 * Starts head to wind, dead in the water — the state a botched tack leaves
 * a ship in, where the rudder has no flow and cannot answer. Three
 * methods, one of them the do-nothing control so the others mean
 * something:
 *
 * - `drift`: sheets eased, helm amidships, nobody does anything;
 * - `backed-headsail`: the fore staysail sheeted hard to windward so the
 *   wind pushes on its FRONT face. This is the technique that matters,
 *   because it does not need boat speed — only wind, which is present. A
 *   headsail is well forward of the pivot, so its push swings the bow;
 * - `backed-headsail-and-helm`: the same, plus the helm put over. Under
 *   sternway the blade steers reversed (pinned by test in S3), so the
 *   commanded angle shifts sign with the along-heading speed exactly as
 *   the tack script does.
 *
 * Which way she falls off is a RESULT, not a prescription: the case backs
 * the sail to one side and reports the side she actually went.
 */
function runIronsEscapeCase(
  method: IronsEscapeCase['method'],
  windSpeedMps: number,
  /** Which side the headsail is backed to. The side she ACTUALLY falls
   * off toward is measured, not assumed — that is the whole question. */
  backTo: 'port' | 'starboard' = 'port',
): IronsEscapeCase {
  // Wind source dead ahead at yaw 0: she is exactly head to wind.
  const windDirectionTowardDeg = 0;
  const scratchRender: WindVector = { x: 0, z: 0 };
  const scratchBody: WindVector = { x: 0, z: 0 };
  let attached = false;
  let escaped = false;
  let timeToPayOffS: number | null = null;
  let fellOffToward: 'port' | 'starboard' | null = null;
  let maxSternwayMps = 0;
  let yawRateSum = 0;
  let yawRateSamples = 0;
  const settleAngles: number[] = [];
  const trace: ManeuverTraceSample[] = [];
  let lastTraceSecond = -Infinity;

  const run = runSailCase({
    durationSeconds: IRONS_TIMEOUT_S,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: 0,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg,
    gustiness: 0,
    canvas: FULL_SAIL,
    tack: 'starboard',
    sampleEverySeconds: IRONS_TIMEOUT_S,
    script: (view) => {
      if (!attached) {
        attached = true;
        view.sails.attachControls(view.helm);
        // Sheets flat, where a failed tack leaves them; nothing draws.
        for (const sail of Object.keys(TACK_HARD_TRIMS_DEG) as SailName[]) {
          if (sail === 'foreTopsail') continue;
          view.helm.commandTrimDeg(sail, IRONS_STUCK_SHEET_DEG);
        }
        if (method === 'backed-headsail' || method === 'backed-headsail-and-helm') {
          // Back the staysail to the named side, so the wind loads the
          // face that shoves the bow the other way. Which way she
          // actually goes is measured, never reasoned.
          view.helm.commandTrimDeg(
            'foreStaysail',
            (backTo === 'port' ? 1 : -1) * IRONS_BACKED_SHEET_DEG,
          );
        }
      }
      const speed = Math.hypot(view.velocityX, view.velocityZ);
      const angle = windAngleAtYawDeg(
        windDirectionTowardDeg,
        windSpeedMps,
        view.yawRad,
        scratchRender,
        scratchBody,
      );
      const alongSpeedMps =
        view.velocityX * Math.sin(view.yawRad) +
        view.velocityZ * Math.cos(view.yawRad);
      if (alongSpeedMps < 0) {
        maxSternwayMps = Math.max(maxSternwayMps, -alongSpeedMps);
      }
      yawRateSum += Math.abs(view.yawRateRadPerSecond);
      yawRateSamples++;
      if (view.timeSeconds >= IRONS_TIMEOUT_S - TACK_CAPTURE_WINDOW_S) {
        settleAngles.push(angle);
      }

      if (!escaped && Math.abs(angle) >= IRONS_ESCAPE_ANGLE_DEG) {
        escaped = true;
        timeToPayOffS = view.timeSeconds;
        // Positive wind angle = wind over the port side (the W1 relabel),
        // which means her bow fell off to starboard.
        fellOffToward = angle > 0 ? 'starboard' : 'port';
        // Once she is round, sheet in on the tack she actually landed on
        // and let her gather way — the exit speed is the proof she is
        // sailing again rather than merely pointing somewhere else.
        const sign = angle > 0 ? 1 : -1;
        for (const sail of Object.keys(TACK_HARD_TRIMS_DEG) as SailName[]) {
          if (sail === 'foreTopsail') continue;
          view.helm.commandTrimDeg(sail, sign * TACK_EXIT_TRIM_DEG);
        }
      }
      const usesHelm =
        method === 'helm-only' || method === 'backed-headsail-and-helm';
      if (usesHelm && !escaped) {
        // Helm hard over to swing the same way the backed sail would
        // push, shifted for sternway like the tack's stern-board
        // recovery — the blade steers reversed once the flow reverses.
        const helmSign = backTo === 'port' ? -1 : 1;
        view.helm.commandRudderDeg(
          helmSign * (alongSpeedMps >= 0 ? RUDDER_LIMIT_DEG : -RUDDER_LIMIT_DEG),
        );
      } else if (escaped) {
        view.helm.commandRudderDeg(
          courseHoldRudderDeg(
            fellOffToward === 'starboard' ? 55 : -55,
            angle,
            view.yawRateRadPerSecond,
          ),
        );
      }
      if (view.timeSeconds - lastTraceSecond >= 5) {
        lastTraceSecond = view.timeSeconds;
        trace.push({
          timeSeconds: round(view.timeSeconds, 2),
          windAngleOffBowDeg: round(angle, 2),
          speedMps: round(speed, 4),
          yawRateRadPerS: round(view.yawRateRadPerSecond, 5),
          rudderDeg: round(view.helm.rudderAngleDeg, 2),
        });
      }
    },
  });

  return {
    method,
    windSpeedMps,
    escaped,
    timeToPayOffS: timeToPayOffS === null ? null : round(timeToPayOffS, 2),
    fellOffToward,
    settledAngleDeg: escaped ? null : round(mean(settleAngles), 3),
    backedToward: backTo,
    maxSternwayMps: round(maxSternwayMps, 4),
    exitSpeedMps: round(Math.hypot(run.finalVelocityX, run.finalVelocityZ), 4),
    meanYawRateDegPerS: round(
      yawRateSamples === 0
        ? 0
        : ((yawRateSum / yawRateSamples) * 180) / Math.PI,
      5,
    ),
    maxEnergyOverWorkJ: round(run.maxEnergyOverWorkJ, 6),
    trace,
  };
}

const GYBE_HELM_DEG = 15;
const GYBE_COMPLETE_ANGLE_DEG = 142;
const GYBE_SETTLE_S = 60;
const GYBE_TIMEOUT_S = 150;

function runGybeCase(windSpeedMps: number): GybeCase {
  const windDirectionTowardDeg = 140; // source 140° off the starboard bow
  const scratchRender: WindVector = { x: 0, z: 0 };
  const scratchBody: WindVector = { x: 0, z: 0 };
  let attached = false;
  let flipped = false;
  let completed = false;
  let timeToCompleteS: number | null = null;
  let transitStartS: number | null = null;
  let transitSeconds: number | null = null;
  let maxYawRateRadPerS = 0;
  const trace: ManeuverTraceSample[] = [];
  let lastTraceSecond = -Infinity;

  const run = runSailCase({
    durationSeconds: GYBE_SETTLE_S + GYBE_TIMEOUT_S,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    // A gybe starts from a made broad-reach leg, same as the tack's leg.
    velocityZ: 3.5,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg,
    gustiness: 0,
    canvas: FULL_SAIL,
    tack: 'starboard',
    sampleEverySeconds: GYBE_SETTLE_S + GYBE_TIMEOUT_S,
    script: (view) => {
      if (!attached) {
        attached = true;
        view.sails.attachControls(view.helm);
      }
      const speed = Math.hypot(view.velocityX, view.velocityZ);
      const angle = windAngleAtYawDeg(
        windDirectionTowardDeg,
        windSpeedMps,
        view.yawRad,
        scratchRender,
        scratchBody,
      );
      if (view.timeSeconds >= GYBE_SETTLE_S) {
        maxYawRateRadPerS = Math.max(
          maxYawRateRadPerS,
          Math.abs(view.yawRateRadPerSecond),
        );
        if (transitStartS === null && angle <= -170) {
          transitStartS = view.timeSeconds;
        }
        if (!flipped && Math.abs(angle) >= 178) {
          flipped = true;
          // Dead astern: the booms come across. Mirror every trim to the
          // new gybe at crew rate — the S4 replacement for the frozen flip.
          for (const [sail, trim] of Object.entries(AUTHORED_TRIM_DEG)) {
            if (sail === 'mainGaffTopsail') continue; // slaved
            if (sail === 'mainTopmastStaysail') {
              view.helm.commandFishermanSide('starboard');
              continue;
            }
            view.helm.commandTrimDeg(sail as SailName, -trim);
          }
        }
        if (
          transitStartS !== null &&
          transitSeconds === null &&
          flipped &&
          angle > 0 &&
          angle <= 170
        ) {
          transitSeconds = view.timeSeconds - transitStartS;
        }
        if (
          !completed &&
          flipped &&
          angle > 0 &&
          angle <= GYBE_COMPLETE_ANGLE_DEG
        ) {
          completed = true;
          timeToCompleteS = view.timeSeconds - GYBE_SETTLE_S;
        }
        view.helm.commandRudderDeg(
          completed
            ? courseHoldRudderDeg(140, angle, view.yawRateRadPerSecond)
            : GYBE_HELM_DEG,
        );
      } else {
        view.helm.commandRudderDeg(
          courseHoldRudderDeg(-140, angle, view.yawRateRadPerSecond),
        );
      }
      if (view.timeSeconds - lastTraceSecond >= 2) {
        lastTraceSecond = view.timeSeconds;
        trace.push({
          timeSeconds: round(view.timeSeconds, 2),
          windAngleOffBowDeg: round(angle, 2),
          speedMps: round(speed, 4),
          yawRateRadPerS: round(view.yawRateRadPerSecond, 5),
          rudderDeg: round(view.helm.rudderAngleDeg, 2),
        });
      }
    },
  });

  return {
    windSpeedMps,
    completed,
    timeToCompleteS: timeToCompleteS === null ? null : round(timeToCompleteS, 2),
    transitSeconds: transitSeconds === null ? null : round(transitSeconds, 2),
    maxYawRateRadPerS: round(maxYawRateRadPerS, 6),
    maxEnergyOverWorkJ: round(run.maxEnergyOverWorkJ, 6),
    trace,
  };
}

/** Single-case entry point for diagnostics; the evidence runs five. */
export function runIronsEscape(
  method: IronsEscapeCase['method'],
  windSpeedMps: number,
  backTo: 'port' | 'starboard' = 'port',
): IronsEscapeCase {
  return runIronsEscapeCase(method, windSpeedMps, backTo);
}

export function buildShipTackEvidence(): ShipTackEvidence {
  const withWay = [
    // The close-reach approach with a good full, at two winds.
    runTackCase(6, TACK_ENTRY_ANGLE_DEG, 60, 2.6),
    runTackCase(8, TACK_ENTRY_ANGLE_DEG, 60, 3.4),
    // Maximum way: a beam-reach entry near her best speed. If ANY entry
    // could complete the classic tack at this trim, this one would.
    runTackCase(8, -90, 60, 4.2),
  ];
  // Ordered from rest: she has no way, the rudder no authority, and she
  // must fail before the eye — the envelope's other end, asserted too.
  const lowWay = runTackCase(8, TACK_ENTRY_ANGLE_DEG, 6, 0);
  const tacks = [...withWay, lowWay];
  const gybe = runGybeCase(8);
  // Caught in irons: the do-nothing control, the real-seamanship
  // technique, the helm alone, both together, and the helm ordered the
  // other way. Five cases because separating the two mechanisms is the
  // whole point — with only "backed sail + helm" the sail would have
  // taken credit for the rudder's work.
  const ironsEscapes = [
    runIronsEscapeCase('drift', 8, 'port'),
    runIronsEscapeCase('backed-headsail', 8, 'port'),
    runIronsEscapeCase('helm-only', 8, 'port'),
    runIronsEscapeCase('backed-headsail-and-helm', 8, 'port'),
    runIronsEscapeCase('helm-only', 8, 'starboard'),
  ];
  const ironsBy = (
    method: IronsEscapeCase['method'],
    backTo: 'port' | 'starboard',
  ): IronsEscapeCase =>
    ironsEscapes.find((c) => c.method === method && c.backedToward === backTo)!;
  const ironsDrift = ironsBy('drift', 'port');
  const ironsBacked = ironsBy('backed-headsail', 'port');
  const ironsHelm = ironsBy('helm-only', 'port');
  const ironsBoth = ironsBy('backed-headsail-and-helm', 'port');
  const ironsTowardSheets = ironsBy('helm-only', 'starboard');

  let maxEnergyOverWorkJ = gybe.maxEnergyOverWorkJ;
  for (const t of tacks) {
    maxEnergyOverWorkJ = Math.max(maxEnergyOverWorkJ, t.maxEnergyOverWorkJ);
  }
  for (const escape of ironsEscapes) {
    maxEnergyOverWorkJ = Math.max(maxEnergyOverWorkJ, escape.maxEnergyOverWorkJ);
  }
  const captureAngles = withWay
    .filter((t) => !t.completed && t.captureAngleDeg !== null)
    .map((t) => t.captureAngleDeg!);
  const eyeSpeeds = withWay
    .filter((t) => t.eyeCrossSpeedMps !== null)
    .map((t) => t.eyeCrossSpeedMps!);

  return {
    formatVersion: SAILING_STEERING_EVIDENCE_FORMAT_VERSION,
    status:
      'S6c: THE S4 TACK GATE HAS FLIPPED BACK, and the coefficient round ' +
      'says why. The scripted tack now CROSSES THE EYE on every with-way ' +
      'entry and then hangs on the new bow at 21-33° — S3\'s ±34° in-irons ' +
      'attractor, returned. S4 flipped this gate by hardening the sheets, ' +
      'which worked because hard-sheeted lift was free; with induced drag ' +
      'CL²/(π·AR·e) it is not free, and the flat maneuvering trims no ' +
      'longer buy enough drive to sail her out to a close-hauled groove ' +
      'that has itself moved from ~45° to 55-60°. THE SHIP CAN STILL TACK: ' +
      '`evidence/ship-sailing/voyage-baseline.json` beats to windward with ' +
      'three tacks ordered and three completed, because the crew work the ' +
      'sheets continuously and stern-board her when she hangs, and this ' +
      'fixed-angle script does neither. What this file measures is the ' +
      'scripted evolution, and the scripted evolution is now the stale ' +
      'instrument. The irons gates flipped too, in the other direction: an ' +
      'aback sail carries lift now, so backing a headsail is a move that ' +
      'works and every escape case frees her.',
    contract: {
      method:
        'Free runs in flat water under steady wind, sailed on the live S4 ' +
        'control surface (rate-limited sheets and helm — the same path a ' +
        'player commands). The script holds the approach leg on the ' +
        'authored trims, hardens for the beat at the order, hauls across ' +
        'at the eye with the staysail held aback, and shifts the helm if ' +
        'she gathers sternway. The irons cases start her head to wind at ' +
        'rest with flat sheets and separate the two candidate escape ' +
        'mechanisms — backed sail and stern-board helm — one at a time.',
      scope:
        'Tacks from a close reach at 6 and 8 m/s, from a beam reach near ' +
        'best speed, and from rest; one gybe at 8 m/s worked across on the ' +
        'sheets; five escape-from-irons cases at 8 m/s. Her whole wardrobe, ' +
        'except that the tacks now HAND THE SQUARE TOPSAIL at the top of ' +
        'the approach leg — a square sail cannot be braced to draw ' +
        'close-hauled, and carrying it aback through a tack was measured ' +
        'to stop the maneuver dead (no entry even reached the eye). The ' +
        'gybe and irons cases keep the full wardrobe: off the wind the ' +
        'topsail draws, and head to wind it is edge-on.',
      validationMeaning:
        'Success is measured, not scripted: eye-crossing speed, completion ' +
        'time, the low-way non-crossing, the sound gybe, which escape ' +
        'mechanism actually frees her, and energy accounting through every ' +
        'maneuver. Timings are model results. Every gate is pinned in the ' +
        'direction that is TRUE, which after S6c includes two that are ' +
        'limitations: the scripted tack does not settle on the new board, ' +
        'and it is the SCRIPT that cannot, not the ship.',
    },
    tacks,
    gybe,
    ironsEscapes,
    gates: {
      classicTackCompletesAtAnyEntry: withWay.some((t) => t.completed),
      everyWithWayEntryCompletes: withWay.every((t) => t.completed),
      everyWithWayEntryCrossesEye: withWay.every(
        (t) => t.timeToCrossEyeS !== null,
      ),
      captureAngleBandDeg:
        captureAngles.length === 0
          ? null
          : [
              round(Math.min(...captureAngles), 3),
              round(Math.max(...captureAngles), 3),
            ],
      eyeCrossSpeedBandMps: [
        round(Math.min(...eyeSpeeds), 4),
        round(Math.max(...eyeSpeeds), 4),
      ],
      lowWayFailsBeforeEye: lowWay.timeToCrossEyeS === null && !lowWay.completed,
      maxEnergyOverWorkJ: round(maxEnergyOverWorkJ, 6),
      gybeCompleted: gybe.completed,
      gybeMaxYawRateRadPerS: gybe.maxYawRateRadPerS,
      ironsSternBoardEscapes: ironsHelm.escaped,
      ironsBackedHeadsailAloneEscapes: ironsBacked.escaped,
      ironsBackedHeadsailSecondsSaved:
        ironsHelm.timeToPayOffS !== null && ironsBoth.timeToPayOffS !== null
          ? round(ironsHelm.timeToPayOffS - ironsBoth.timeToPayOffS, 2)
          : 0,
      ironsSternBoardPayOffS: ironsHelm.timeToPayOffS,
      ironsDriftPayOffS: ironsDrift.timeToPayOffS,
      ironsTowardSheetsAttractorDeg: ironsTowardSheets.escaped
        ? null
        : ironsTowardSheets.settledAngleDeg,
    },
  };
}

// --- ship:helm ---------------------------------------------------------------

export interface HelmBalancePoint {
  windAngleOffBowDeg: number;
  steadySpeedMps: number;
  /** Rudder angle zeroing the net yaw moment; null when she makes no way
   * or the helm cannot balance the canvas inside its ±35° range. */
  balanceRudderDeg: number | null;
  /** Net yaw moment at the balance (or at amidships when unsolved). */
  residualYawMomentNm: number;
  /** The sail moment the rudder is holding, read at amidships helm. */
  sailYawMomentNm: number;
}

export interface HelmSheet {
  canvas: string;
  /** Area-weighted centre-of-effort z of the set canvas, metres. */
  canvasCoeZM: number;
  points: HelmBalancePoint[];
}

export interface ShipHelmEvidence {
  formatVersion: number;
  status: string;
  contract: {
    method: string;
    scope: string;
    validationMeaning: string;
  };
  configuration: {
    windSpeedMps: number;
    angleGridDeg: number[];
    probeSettleSeconds: number;
    speedBisectionIterations: number;
    helmBisectionIterations: number;
  };
  sheets: HelmSheet[];
  gates: {
    /** CoE z ordering of the canvas variants — the construction half. */
    coeOrderingAftToForward: string[];
    /** Balance-helm ordering matches CoE ordering at the beam — measured. */
    helmFollowsCanvasBalance: boolean;
    fullSailMaxAbsBalanceDeg: number;
    fullSailReachWeatherHelm: boolean;
  };
}

const HELM_ANGLE_GRID_DEG = [45, 60, 75, 90, 105, 120, 135, 150];
const HELM_WIND_MPS = 8;

export const HEADSAILS_ONLY: CanvasState = Object.freeze({
  ...BARE_POLES,
  foreStaysail: 'set',
  jib: 'set',
  flyingJib: 'set',
}) as CanvasState;

export const AFT_CANVAS: CanvasState = Object.freeze({
  ...BARE_POLES,
  mainsail: 'set',
  mainGaffTopsail: 'set',
}) as CanvasState;

interface CaptiveHelmProbe {
  surgeResidualN: number;
  netYawMomentNm: number;
  sailYawMomentNm: number;
}

/**
 * One captive settle on a fixed zero-leeway heading: tow at `speedMps` with
 * the wind source `angleDeg` off the starboard bow, rudder held at
 * `rudderDeg`, and read the settled force balance. The net yaw moment is the
 * water's (rudder increment included) plus the rig's — the same two terms
 * the free dynamics sums, so its zero is exactly "she holds this course".
 */
function captiveHelmProbe(
  angleDeg: number,
  windSpeedMps: number,
  canvas: CanvasState,
  speedMps: number,
  rudderDeg: number,
): CaptiveHelmProbe {
  const run = runSailCase({
    durationSeconds: PROBE_SETTLE_SECONDS,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: 0,
    velocityZ: speedMps,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg: angleDeg,
    gustiness: 0,
    canvas,
    tack: 'starboard',
    mode: 'captive-tow',
    towVelocityX: 0,
    towVelocityZ: speedMps,
    towYawRad: 0,
    sampleEverySeconds: PROBE_SETTLE_SECONDS,
    rudderCommandDeg: () => rudderDeg,
  });
  const aero = run.sails.lastResult;
  let sailDriveN = aero.windage.forceModelZN;
  for (const sail of aero.perSail) sailDriveN += sail.forceModelZN;
  return {
    surgeResidualN: run.finalResistanceBodyZN + sailDriveN,
    netYawMomentNm: run.finalResistanceYawMomentNm + aero.yawMomentNm,
    sailYawMomentNm: aero.yawMomentNm,
  };
}

function solveHelmSpeed(
  angleDeg: number,
  canvas: CanvasState,
): number {
  const atRest = captiveHelmProbe(angleDeg, HELM_WIND_MPS, canvas, 0, 0);
  if (atRest.surgeResidualN <= 0) return 0;
  let low = 0;
  let high = SPEED_SEARCH_MAX_MPS;
  for (let i = 0; i < SPEED_BISECTION_ITERATIONS; i++) {
    const midpoint = (low + high) / 2;
    const probe = captiveHelmProbe(
      angleDeg,
      HELM_WIND_MPS,
      canvas,
      midpoint,
      0,
    );
    if (probe.surgeResidualN > 0) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

/** Exported for the test suite's spot check against the committed curve. */
export function solveHelmBalance(
  angleDeg: number,
  canvas: CanvasState,
): HelmBalancePoint {
  const speed = solveHelmSpeed(angleDeg, canvas);
  const amidships = captiveHelmProbe(
    angleDeg,
    HELM_WIND_MPS,
    canvas,
    speed,
    0,
  );
  if (speed < 0.3) {
    return {
      windAngleOffBowDeg: angleDeg,
      steadySpeedMps: round(speed, 4),
      balanceRudderDeg: null,
      residualYawMomentNm: round(amidships.netYawMomentNm, 2),
      sailYawMomentNm: round(amidships.sailYawMomentNm, 2),
    };
  }
  let low = -RUDDER_LIMIT_DEG;
  let high = RUDDER_LIMIT_DEG;
  const atLow = captiveHelmProbe(angleDeg, HELM_WIND_MPS, canvas, speed, low);
  const atHigh = captiveHelmProbe(angleDeg, HELM_WIND_MPS, canvas, speed, high);
  // Positive rudder makes positive yaw moment under headway, so the net
  // moment rises with rudder angle: a root needs low < 0 < high.
  if (!(atLow.netYawMomentNm < 0 && atHigh.netYawMomentNm > 0)) {
    return {
      windAngleOffBowDeg: angleDeg,
      steadySpeedMps: round(speed, 4),
      balanceRudderDeg: null,
      residualYawMomentNm: round(amidships.netYawMomentNm, 2),
      sailYawMomentNm: round(amidships.sailYawMomentNm, 2),
    };
  }
  let balance = 0;
  let residual = amidships.netYawMomentNm;
  for (let i = 0; i < HELM_BISECTION_ITERATIONS; i++) {
    balance = (low + high) / 2;
    const probe = captiveHelmProbe(
      angleDeg,
      HELM_WIND_MPS,
      canvas,
      speed,
      balance,
    );
    residual = probe.netYawMomentNm;
    if (residual > 0) high = balance;
    else low = balance;
  }
  return {
    windAngleOffBowDeg: angleDeg,
    steadySpeedMps: round(speed, 4),
    balanceRudderDeg: round(balance, 3),
    residualYawMomentNm: round(residual, 2),
    sailYawMomentNm: round(amidships.sailYawMomentNm, 2),
  };
}

/** Area-weighted CoE z over the sails set in a canvas state. */
export function canvasCoeZM(canvas: CanvasState): number {
  let areaSum = 0;
  let momentSum = 0;
  for (const sail of SAIL_AERO_GEOMETRY) {
    const state = canvas[sail.name];
    if (state === 'furled') continue;
    const variant = sail.variants.starboard[state === 'set' ? 'set' : state];
    if (!variant) continue;
    areaSum += variant.areaM2;
    momentSum += variant.areaM2 * variant.coe.z;
  }
  return areaSum > 0 ? momentSum / areaSum : 0;
}

export function buildShipHelmEvidence(): ShipHelmEvidence {
  const variants: Array<{ name: string; canvas: CanvasState }> = [
    { name: 'AFT_CANVAS', canvas: AFT_CANVAS },
    { name: 'FULL_SAIL', canvas: FULL_SAIL },
    { name: 'WORKING_SAIL', canvas: WORKING_SAIL },
    { name: 'HEADSAILS_ONLY', canvas: HEADSAILS_ONLY },
  ];
  const sheets: HelmSheet[] = variants.map((variant) => ({
    canvas: variant.name,
    canvasCoeZM: round(canvasCoeZM(variant.canvas), 4),
    points: HELM_ANGLE_GRID_DEG.map((angle) =>
      solveHelmBalance(angle, variant.canvas),
    ),
  }));

  // Construction half of the sign gate: order the variants by CoE z.
  const byCoe = [...sheets].sort((a, b) => a.canvasCoeZM - b.canvasCoeZM);
  const coeOrderingAftToForward = byCoe.map((sheet) => sheet.canvas);

  // Measured half, at the beam reach: canvas whose CoE sits further aft
  // gripes harder to weather, so its balance rudder sits further toward
  // the positive (leeward, on this starboard-wind geometry) stop.
  const beamBalance = (sheet: HelmSheet): number | null =>
    sheet.points.find((p) => p.windAngleOffBowDeg === 90)?.balanceRudderDeg ??
    null;
  let helmFollowsCanvasBalance = true;
  for (let i = 1; i < byCoe.length; i++) {
    const aft = beamBalance(byCoe[i - 1]);
    const forward = beamBalance(byCoe[i]);
    if (aft === null || forward === null || aft <= forward) {
      helmFollowsCanvasBalance = false;
    }
  }

  const fullSail = sheets.find((sheet) => sheet.canvas === 'FULL_SAIL')!;
  let fullSailMaxAbsBalanceDeg = 0;
  let fullSailReachWeatherHelm = true;
  for (const point of fullSail.points) {
    if (point.balanceRudderDeg === null) continue;
    if (
      point.windAngleOffBowDeg >= 60 &&
      point.windAngleOffBowDeg <= 120
    ) {
      fullSailMaxAbsBalanceDeg = Math.max(
        fullSailMaxAbsBalanceDeg,
        Math.abs(point.balanceRudderDeg),
      );
      if (
        point.windAngleOffBowDeg <= 105 &&
        point.balanceRudderDeg <= 0
      ) {
        fullSailReachWeatherHelm = false;
      }
    }
  }

  return {
    formatVersion: SAILING_STEERING_EVIDENCE_FORMAT_VERSION,
    status:
      'S3: weather-helm curve on a captive zero-leeway heading — rudder ' +
      'angle that zeroes the net yaw moment at the solved captive speed, ' +
      'per canvas balance. The leeway-solved equilibrium is the S3 polar ' +
      'regeneration.',
    contract: {
      method:
        'Per point: bisect captive speed to surge balance at amidships ' +
        'helm, then bisect the rudder angle to zero the summed water+rig ' +
        'yaw moment at that speed. Starboard-wind geometry throughout.',
      scope:
        'Wind 8 m/s, angles 45-150, four canvas balances from all-aft to ' +
        'headsails-only. Flat water, frozen trim.',
      validationMeaning:
        'Sign and ordering of helm against canvas balance (construction ' +
        'from CoE positions, verified by measurement) and the few-degrees ' +
        'magnitude band. The curve itself is a provisional-coefficient ' +
        'model result.',
    },
    configuration: {
      windSpeedMps: HELM_WIND_MPS,
      angleGridDeg: [...HELM_ANGLE_GRID_DEG],
      probeSettleSeconds: PROBE_SETTLE_SECONDS,
      speedBisectionIterations: SPEED_BISECTION_ITERATIONS,
      helmBisectionIterations: HELM_BISECTION_ITERATIONS,
    },
    sheets,
    gates: {
      coeOrderingAftToForward,
      helmFollowsCanvasBalance,
      fullSailMaxAbsBalanceDeg: round(fullSailMaxAbsBalanceDeg, 3),
      fullSailReachWeatherHelm,
    },
  };
}
