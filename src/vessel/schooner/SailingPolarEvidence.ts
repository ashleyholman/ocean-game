import { buildSchoonerBuoyancy } from './SchoonerBuoyancy';
import { RUDDER_LIMIT_DEG } from './SailingControls';
import { SCHOONER_HORIZONTAL_ADDED_MASS } from './SchoonerHorizontalDynamics';
import {
  runSailCase,
  SAILING_HULL_SPEED_MPS,
  type SailBreakdownEntry,
} from './SailingForceEvidence';
import {
  BEATING_SAIL,
  FULL_SAIL,
  SAIL_AERO_COEFFICIENTS,
  WORKING_SAIL,
  type CanvasState,
  type TackSide,
} from './sailAero';
import { RIG_TRIM_LIMITS, type SailName } from './rig';

/**
 * v4: S6c — the coefficient round. Induced drag, aback lift and a live
 * camber re-price every point in this file (see the round handover). Three
 * things changed in the file's *shape* as well as its numbers:
 *
 * - each sheet reports `closeHauledAngleDeg`, the pointing limit the model
 *   now has of its own, which is what FINDING S4-1 was about;
 * - the leeway and helm gates are scoped to the **sailing sector**, because
 *   outside it the honest answer at a captive heading is "she crabs", and a
 *   gate that forbids that is a gate against measuring it;
 * - a fifth sheet, `BEATING_SAIL`, so the square topsail's aback drag is
 *   separable from everything else the round changed;
 * - `minSpeedDeltaVsFrozenMps` is gone. It was S4's equal-or-better gate
 *   against the v2 frozen-trim file, and equal-or-better is exactly the
 *   wrong question to ask of a round whose whole point is that the old
 *   numbers were too fast. The comparison is printed by the export tool and
 *   written up in the handover, where a human reads it.
 */
export const SAILING_POLAR_EVIDENCE_FORMAT_VERSION = 4;

/**
 * The polar — steady speed against true wind angle, helm held (S3 form).
 *
 * WHAT KIND OF POLAR THIS IS, HONESTLY
 * ------------------------------------
 * Each point is a **three-unknown force balance on a captive heading**,
 * the S3 regeneration the S2 file promised: sequential relaxation solves
 * the tow speed (surge balance), the leeway angle (sway balance — the keel
 * carries the rig's side force at a real drift angle now) and the rudder
 * angle (yaw balance — the weather-helm column), then heel settles at the
 * solution and the whole state is read. Still captive and quasi-static:
 * the heading is prescribed, the three residuals are driven to (near)
 * zero, and the reported residuals say exactly how near. Since S4 every
 * probe is trimmed to draw for its own apparent wind, so the fixed point is
 * the equilibrium at best settings — this paragraph used to end "no live
 * trim (S4), so the frozen reach-set sheets still flatten the polar", which
 * had been untrue since the round it named.
 *
 * "No drive in the no-go zone" appears as a zero solved speed with a
 * negative drive at rest. The surfing allowance on the hull-speed gate is
 * stated, not implied: bounded flat-water force balance cannot surf, so
 * the allowance is thin.
 */

const PHYSICS_HZ = 240;
/** Bisection settle per force probe; heel gets a longer settle at the end. */
const PROBE_SETTLE_SECONDS = 6;
const HEEL_SETTLE_SECONDS = 20;
const SPEED_BISECTION_ITERATIONS = 12;
const SPEED_SEARCH_MAX_MPS = 6.5;
const LEEWAY_SEARCH_MAX_DEG = 20;
const RELAXATION_ROUNDS = 3;
/** Stated surfing allowance over the ~4.7 m/s hull speed. */
export const POLAR_HULL_SPEED_ALLOWANCE = 1.25;

export interface PolarPoint {
  /** True-wind source angle off the bow, degrees; the polar reports the
   * drawing side of each tack as a positive angle. */
  windAngleOffBowDeg: number;
  steadySpeedMps: number;
  steadyHeelDeg: number;
  /** Solved drift angle to leeward, degrees; 0 when she makes no way. */
  leewayDeg: number;
  /** Rudder holding the course, degrees; null when she makes no way or the
   * helm cannot balance inside its range. */
  balanceRudderDeg: number | null;
  /** How closed the three balances actually are at the solution. */
  residuals: { surgeN: number; swayN: number; yawNm: number };
  /** Drive at zero speed — negative inside the no-go zone. */
  driveAtRestN: number;
  luffingCount: number;
  /** The trim-to-draw schedule at the solution (S4), degrees, signed for
   * the reported (starboard-geometry) tack. */
  trimsDeg: Partial<Record<SailName, number>>;
  perSail: SailBreakdownEntry[];
}

export interface PolarSheet {
  windSpeedMps: number;
  canvas: string;
  points: PolarPoint[];
  /** Same solve on the mirrored tack; the symmetry gate's other half. */
  mirrorMaxSpeedErrorMps: number;
  bestSpeedMps: number;
  bestAngleDeg: number;
  maxHeelDeg: number;
  /**
   * THE POINTING LIMIT, and the number this round exists to create.
   *
   * The smallest true-wind angle on the grid at which she makes
   * `SAILING_SECTOR_SPEED_FRACTION` of this sheet's best speed — i.e. where
   * she stops crabbing and starts sailing. Null if no point does.
   *
   * A fraction of her own best rather than an absolute speed, so it means
   * the same thing in 4 m/s and in 12, and so it cannot be gamed by a sheet
   * that is slow everywhere.
   */
  closeHauledAngleDeg: number | null;
}

/**
 * Where the sailing sector begins, as a fraction of a sheet's best speed.
 *
 * Below it a captive heading is still solvable and the solve is still
 * honest, but what it is describing is a ship being dragged sideways: at 45°
 * in 8 m/s FULL_SAIL she makes 1.03 m/s with 20° of leeway and needs 22° of
 * helm. That is a real answer to a real question and it belongs in the file;
 * it is not a state whose leeway and helm should be gated as if she were
 * sailing.
 */
export const SAILING_SECTOR_SPEED_FRACTION = 0.5;

export interface SailingPolarEvidence {
  formatVersion: number;
  status: string;
  contract: {
    method: string;
    scope: string;
    validationMeaning: string;
  };
  configuration: {
    physicsHz: number;
    probeSettleSeconds: number;
    heelSettleSeconds: number;
    speedBisectionIterations: number;
    relaxationRounds: number;
    leewaySearchMaxDeg: number;
    hullSpeedMps: number;
    hullSpeedAllowance: number;
    addedMass: typeof SCHOONER_HORIZONTAL_ADDED_MASS;
    angleGridDeg: number[];
  };
  sheets: PolarSheet[];
  gates: {
    noGoMaxSpeedMps: number;
    reachBeatsRunEverySheet: boolean;
    maxSpeedAnySheetMps: number;
    hullSpeedBoundMps: number;
    mirrorMaxSpeedErrorMps: number;
    fullSailHeelAt12Deg: number;
    heelBandDeg: [number, number];
    /** Leeway **inside the sailing sector**: real, small, and bounded. */
    maxLeewayDeg: number;
    /** Largest helm any sailing-sector point needs to hold its course. */
    maxAbsBalanceRudderDeg: number;
    /**
     * The worst (highest) close-hauled angle over the sheets — how close to
     * the wind the rig can be made to sail at all. Gated into a band in
     * BOTH directions: too high and she cannot beat, too low and the
     * pointing limit FINDING S4-1 asked for has gone missing again.
     */
    closeHauledAngleDeg: number | null;
    /**
     * Whether any sailing-sector point ran the leeway search to its bound.
     * Inside the sector it must not: a saturated leeway is the solver
     * reporting the edge of its box, not a drift angle.
     */
    sailingSectorLeewaySaturated: boolean;
  };
}

const ANGLE_GRID_DEG = [
  0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
];

interface SolvedPoint {
  point: PolarPoint;
  mirrorSpeedMps: number;
}

interface CaptiveProbe {
  surgeN: number;
  swayN: number;
  yawNm: number;
  heelRad: number;
  perSail: () => SailBreakdownEntry[];
  luffingCount: number;
}

// --- the trim-to-draw schedule (S4) ------------------------------------------

/**
 * The flattest the schedule ever sheets a working sail, degrees.
 *
 * IT IS NO LONGER THE MODEL'S POINTING LIMIT, AND THAT IS THE S6c RESULT
 * ----------------------------------------------------------------------
 * S4 found (and this comment used to say) that the aero had no induced
 * drag, so nothing in the physics stopped her pointing: with an 8° floor
 * she carried **2.68 m/s at 30° off the true wind** and the no-go gate
 * blew. This number was the stand-in — the pointing limit enforced the way
 * the period did it, a gaff main kept over the quarter — and S4 said
 * plainly that it was holding the model up.
 *
 * The induced-drag term landed in S6c and took the job back. Re-measured on
 * the same ladder, 8 m/s, 30° true, FULL_SAIL:
 *
 * | sheet floor | before (S4) | after (S6c) |
 * |---|---|---|
 * | 8°  | 2.68 m/s | **0 — dead, −770 N at rest** |
 * | 12° | — | **0 — dead, −749 N** |
 * | 16° | — | **0 — dead, −986 N** |
 * | 20° | 0.15 m/s | **0 — dead, −1454 N** |
 *
 * She cannot be made to sail at 30° at ANY sheeting the rig permits, which
 * is what "the rig has a pointing limit of its own" means. At 45° and 55°
 * the floor is worth 0.05 m/s and nothing respectively — the apparent angle
 * there is wide enough that the lift-peak rule is not clamping.
 *
 * So the number is kept, and kept at 20°, for the reason it should always
 * have had: **it is what a crew does.** Nothing is riding on it now, and it
 * could be lowered without the gates noticing. It is a policy, and the S5/S6
 * crew share its value through `SailingControls.WORKING_TRIM_DEG`, so moving
 * it is a crew decision and not an aerodynamic one.
 *
 * Steady-sailing floor only: the tack evidence hauls momentarily flatter
 * inside the evolution and eases back to this.
 */
const MIN_DRAWING_SHEET_DEG = 20;

/**
 * The apparent-wind source angle off the bow, degrees [0, 180], for a
 * captive state: true source `sourceAbsDeg` off one bow, boat towed at
 * `speedMps` along her heading with `leewayDeg` of drift to leeward.
 * Symmetric in the tack, so worked WLOG with the source to starboard.
 */
export function apparentSourceAngleDeg(
  sourceAbsDeg: number,
  windSpeedMps: number,
  speedMps: number,
  leewayDeg: number,
): number {
  const a = (sourceAbsDeg * Math.PI) / 180;
  const lam = (leewayDeg * Math.PI) / 180;
  // Body frame, bow +z, source on −x: apparent source = wind-source unit
  // scaled by wind speed plus the boat's own velocity.
  const sx = -windSpeedMps * Math.sin(a) - speedMps * Math.sin(lam);
  const sz = windSpeedMps * Math.cos(a) + speedMps * Math.cos(lam);
  return (Math.atan2(Math.abs(sx), sz) * 180) / Math.PI;
}

/**
 * What a competent trimmer does, as one rule per sail (design §6.1's lift
 * peak): sheet each fore-and-aft sail so its cloth stands `aoaPeakDeg` off
 * the apparent wind, clamped to the rig's mechanical stops — which IS the
 * downwind barn-door limit — and never inside a working minimum. The
 * square topsail braces its yard toward square-on. Magnitudes; the caller
 * signs them with the tack, and this is the polar's "live-trim best settings".
 *
 * It is NOT what S5's crew do, and an earlier version of this comment claiming
 * it was "S5's `Trimmers` policy in fixture form" was wrong in a way worth
 * naming: this rule reads the exact apparent angle and recomputes every
 * substep, which is precisely the oracle a human trimmer may not call. The
 * production hands work from delayed cues and land 2–10° away from these
 * numbers. The schedule's job is to be the yardstick they are measured
 * against — see `SailingCrewEvidence`'s trim cases — not the policy they run.
 *
 * It is also not an optimum. Recomputed every substep in a seaway it can be
 * beaten by a crew who simply leave a sail alone while the apparent angle
 * wanders, which the working-trims case measures at 1.002 of it.
 */
export function trimToDrawDeg(
  apparentSourceAbsDeg: number,
): Partial<Record<SailName, number>> {
  const aoa = SAIL_AERO_COEFFICIENTS.aoaPeakDeg;
  const sheet = (name: SailName): number =>
    Math.min(
      Math.max(apparentSourceAbsDeg - aoa, MIN_DRAWING_SHEET_DEG),
      RIG_TRIM_LIMITS[name].maxDeg,
    );
  return {
    mainsail: sheet('mainsail'),
    foresail: sheet('foresail'),
    foreStaysail: sheet('foreStaysail'),
    jib: sheet('jib'),
    flyingJib: sheet('flyingJib'),
    foreTopsail: Math.min(
      Math.max(180 - apparentSourceAbsDeg, 0),
      RIG_TRIM_LIMITS.foreTopsail.maxDeg,
    ),
  };
}

function signedTrims(
  schedule: Partial<Record<SailName, number>>,
  sign: 1 | -1,
): Partial<Record<SailName, number>> {
  const signed: Partial<Record<SailName, number>> = {};
  for (const [sail, deg] of Object.entries(schedule)) {
    signed[sail as SailName] = sign * deg!;
  }
  return signed;
}

/**
 * One captive settle: the ship towed at `speedMps` along her course with
 * `leewayDeg` of drift to leeward, rudder held at `rudderDeg`, wind source
 * `angle` degrees off the bow on the given tack's side. Returns all three
 * balance residuals in heading axes (yaw 0: surge = z, sway = x).
 */
function captiveProbe(
  angleDeg: number,
  tack: TackSide,
  windSpeedMps: number,
  speedMps: number,
  leewayDeg: number,
  rudderDeg: number,
  canvas: CanvasState,
  settleSeconds: number,
): CaptiveProbe {
  const signedAngle = tack === 'starboard' ? -angleDeg : angleDeg;
  // Leeward is where the sails push: +x/port on the starboard-wind
  // geometry, mirrored on the port tack. Rudder mirrors with it.
  const leewardSign = tack === 'starboard' ? 1 : -1;
  const leewayRad = (leewayDeg * Math.PI) / 180;
  const towVelocityX = leewardSign * speedMps * Math.sin(leewayRad);
  const towVelocityZ = speedMps * Math.cos(leewayRad);
  // S4: every probe is trimmed to draw for ITS apparent wind — the trim
  // consistent with the speed being tested, so the solved fixed point is
  // the equilibrium at best settings.
  const fixedTrimsDeg = signedTrims(
    trimToDrawDeg(
      apparentSourceAngleDeg(angleDeg, windSpeedMps, speedMps, leewayDeg),
    ),
    leewardSign,
  );
  const run = runSailCase({
    durationSeconds: settleSeconds,
    callerHz: 60,
    voyageCompression: 30,
    velocityX: towVelocityX,
    velocityZ: towVelocityZ,
    yawRad: 0,
    windSpeedMps,
    windDirectionTowardDeg: -signedAngle,
    gustiness: 0,
    canvas,
    tack,
    fixedTrimsDeg,
    mode: 'captive-tow',
    towVelocityX,
    towVelocityZ,
    towYawRad: 0,
    sampleEverySeconds: settleSeconds,
    rudderCommandDeg: () => leewardSign * rudderDeg,
  });
  const aero = run.sails.lastResult;
  // At yaw 0 the world axes are the body axes: surge along z, sway toward
  // port along x. The aero's model-frame totals differ from body axes only
  // by the small settled heel, which is exactly the frame the cloth is in.
  let sailDriveN = aero.windage.forceModelZN;
  let sailSideN = aero.windage.forceModelXN;
  for (const sail of aero.perSail) {
    sailDriveN += sail.forceModelZN;
    sailSideN += sail.forceModelXN;
  }
  return {
    surgeN: run.finalResistanceBodyZN + sailDriveN,
    swayN: leewardSign * (run.finalResistanceBodyXN + sailSideN),
    yawNm: leewardSign * (run.finalResistanceYawMomentNm + aero.yawMomentNm),
    heelRad: run.finalRollRad,
    luffingCount: aero.luffingCount,
    perSail: () =>
      aero.perSail.map((sail) => ({
        name: sail.name,
        state: sail.state,
        areaM2: round(sail.areaM2, 4),
        aoaDeg: round(sail.aoaDeg, 3),
        luffing: sail.luffing,
        blanketFactor: round(sail.blanketFactor, 4),
        aspectRatioEff: round(sail.aspectRatioEff, 4),
        camberDrawn: round(sail.camberDrawn, 5),
        liftCoefficient: round(sail.liftCoefficient, 4),
        dragCoefficient: round(sail.dragCoefficient, 4),
        inducedDragCoefficient: round(sail.inducedDragCoefficient, 4),
        forceModelN: {
          x: round(sail.forceModelXN, 3),
          y: round(sail.forceModelYN, 3),
          z: round(sail.forceModelZN, 3),
        },
      })),
  };
}

interface EquilibriumSolution {
  speedMps: number;
  leewayDeg: number;
  rudderDeg: number | null;
  driveAtRestN: number;
  residuals: { surgeN: number; swayN: number; yawNm: number };
}

/**
 * Sequential-relaxation equilibrium: speed on the surge balance, leeway on
 * the sway balance, rudder on the yaw balance, iterated to a fixed point.
 * Each variable's residual is monotone in it over the search range (drive
 * falls with speed, keel side force rises with leeway, rudder moment rises
 * with deflection under headway), which is what makes plain bisection safe.
 * Exported for the test suite's spot check against the committed polar.
 */
export function solveEquilibrium(
  angleDeg: number,
  tack: TackSide,
  windSpeedMps: number,
  canvas: CanvasState,
): EquilibriumSolution {
  const probe = (
    speedMps: number,
    leewayDeg: number,
    rudderDeg: number,
  ): CaptiveProbe =>
    captiveProbe(
      angleDeg,
      tack,
      windSpeedMps,
      speedMps,
      leewayDeg,
      rudderDeg,
      canvas,
      PROBE_SETTLE_SECONDS,
    );

  const atRest = probe(0, 0, 0);
  if (atRest.surgeN <= 0) {
    // No net drive from a standstill: in irons (or pure windage astern).
    return {
      speedMps: 0,
      leewayDeg: 0,
      rudderDeg: null,
      driveAtRestN: atRest.surgeN,
      residuals: {
        surgeN: atRest.surgeN,
        swayN: atRest.swayN,
        yawNm: atRest.yawNm,
      },
    };
  }

  let speed = 0;
  let leeway = 0;
  let rudder: number | null = 0;
  for (let round = 0; round < RELAXATION_ROUNDS; round++) {
    const iterations = round === 0 ? SPEED_BISECTION_ITERATIONS : 8;
    // Speed on the surge balance at the current leeway and helm.
    let low = 0;
    let high = SPEED_SEARCH_MAX_MPS;
    const atMax = probe(high, leeway, rudder ?? 0);
    if (atMax.surgeN > 0) {
      throw new Error(
        `polar solve: still net drive at ${high} m/s ` +
          `(angle ${angleDeg}, wind ${windSpeedMps})`,
      );
    }
    for (let i = 0; i < iterations; i++) {
      const mid = (low + high) / 2;
      if (probe(mid, leeway, rudder ?? 0).surgeN > 0) low = mid;
      else high = mid;
    }
    speed = (low + high) / 2;
    if (speed < 0.3) {
      // She barely moves: leeway and helm are not meaningful DOF here.
      leeway = 0;
      rudder = null;
      break;
    }

    // Leeway on the sway balance: at zero drift the rig's side force is
    // unopposed (positive toward leeward); the keel's force grows with
    // drift until it carries it.
    let leewayLow = 0;
    let leewayHigh = LEEWAY_SEARCH_MAX_DEG;
    if (probe(speed, leewayHigh, rudder ?? 0).swayN > 0) {
      // The keel cannot carry the rig even at the search bound — report
      // the bound rather than extrapolating.
      leeway = leewayHigh;
    } else {
      for (let i = 0; i < 7; i++) {
        const mid = (leewayLow + leewayHigh) / 2;
        if (probe(speed, mid, rudder ?? 0).swayN > 0) leewayLow = mid;
        else leewayHigh = mid;
      }
      leeway = (leewayLow + leewayHigh) / 2;
    }

    // Rudder on the yaw balance at the solved speed and leeway. In the
    // leeward-signed frame the moment rises with deflection under headway.
    let rudderLow = -RUDDER_LIMIT_DEG;
    let rudderHigh = RUDDER_LIMIT_DEG;
    const atLow = probe(speed, leeway, rudderLow);
    const atHigh = probe(speed, leeway, rudderHigh);
    if (!(atLow.yawNm < 0 && atHigh.yawNm > 0)) {
      rudder = null;
    } else {
      for (let i = 0; i < 7; i++) {
        const mid = (rudderLow + rudderHigh) / 2;
        if (probe(speed, leeway, mid).yawNm > 0) rudderHigh = mid;
        else rudderLow = mid;
      }
      rudder = (rudderLow + rudderHigh) / 2;
    }
  }

  const solved = probe(speed, leeway, rudder ?? 0);
  return {
    speedMps: speed,
    leewayDeg: leeway,
    rudderDeg: rudder,
    driveAtRestN: atRest.surgeN,
    residuals: {
      surgeN: solved.surgeN,
      swayN: solved.swayN,
      yawNm: solved.yawNm,
    },
  };
}

function solvePoint(
  angleDeg: number,
  windSpeedMps: number,
  canvas: CanvasState,
): SolvedPoint {
  const starboard = solveEquilibrium(
    angleDeg,
    'starboard',
    windSpeedMps,
    canvas,
  );
  const port = solveEquilibrium(angleDeg, 'port', windSpeedMps, canvas);
  // The reported point reads the drawing tack (starboard geometry); the
  // mirrored solve exists for the symmetry gate.
  const settled = captiveProbe(
    angleDeg,
    'starboard',
    windSpeedMps,
    starboard.speedMps,
    starboard.leewayDeg,
    starboard.rudderDeg ?? 0,
    canvas,
    HEEL_SETTLE_SECONDS,
  );
  return {
    point: {
      windAngleOffBowDeg: angleDeg,
      steadySpeedMps: round(starboard.speedMps, 4),
      steadyHeelDeg: round((settled.heelRad * 180) / Math.PI, 3),
      leewayDeg: round(starboard.leewayDeg, 3),
      balanceRudderDeg:
        starboard.rudderDeg === null ? null : round(starboard.rudderDeg, 3),
      residuals: {
        surgeN: round(starboard.residuals.surgeN, 2),
        swayN: round(starboard.residuals.swayN, 2),
        yawNm: round(starboard.residuals.yawNm, 2),
      },
      driveAtRestN: round(starboard.driveAtRestN, 2),
      trimsDeg: Object.fromEntries(
        Object.entries(
          signedTrims(
            trimToDrawDeg(
              apparentSourceAngleDeg(
                angleDeg,
                windSpeedMps,
                starboard.speedMps,
                starboard.leewayDeg,
              ),
            ),
            1,
          ),
        ).map(([sail, deg]) => [sail, round(deg!, 2)]),
      ),
      luffingCount: settled.luffingCount,
      perSail: settled.perSail(),
    },
    mirrorSpeedMps: port.speedMps,
  };
}

function buildSheet(
  windSpeedMps: number,
  canvasName: string,
  canvas: CanvasState,
): PolarSheet {
  const points: PolarPoint[] = [];
  let mirrorMaxSpeedErrorMps = 0;
  let bestSpeedMps = -Infinity;
  let bestAngleDeg = 0;
  let maxHeelDeg = 0;
  for (const angle of ANGLE_GRID_DEG) {
    const solved = solvePoint(angle, windSpeedMps, canvas);
    points.push(solved.point);
    mirrorMaxSpeedErrorMps = Math.max(
      mirrorMaxSpeedErrorMps,
      Math.abs(solved.point.steadySpeedMps - solved.mirrorSpeedMps),
    );
    if (solved.point.steadySpeedMps > bestSpeedMps) {
      bestSpeedMps = solved.point.steadySpeedMps;
      bestAngleDeg = angle;
    }
    maxHeelDeg = Math.max(maxHeelDeg, Math.abs(solved.point.steadyHeelDeg));
  }
  // The pointing limit: the first angle off the wind at which she is
  // sailing rather than being dragged. Read off the finished sheet, because
  // it is defined against that sheet's own best speed.
  const sectorSpeed = bestSpeedMps * SAILING_SECTOR_SPEED_FRACTION;
  const closeHauled = points.find((point) => point.steadySpeedMps >= sectorSpeed);
  return {
    windSpeedMps,
    canvas: canvasName,
    points,
    mirrorMaxSpeedErrorMps: round(mirrorMaxSpeedErrorMps, 6),
    bestSpeedMps: round(bestSpeedMps, 4),
    bestAngleDeg,
    maxHeelDeg: round(maxHeelDeg, 3),
    closeHauledAngleDeg: closeHauled ? closeHauled.windAngleOffBowDeg : null,
  };
}

/** Is this point inside its sheet's sailing sector? */
function inSailingSector(sheet: PolarSheet, point: PolarPoint): boolean {
  return (
    point.steadySpeedMps >= sheet.bestSpeedMps * SAILING_SECTOR_SPEED_FRACTION
  );
}

export function buildSailingPolarEvidence(): SailingPolarEvidence {
  // Ensures the mass model loads (and fails loudly) before hours of solves.
  buildSchoonerBuoyancy();

  const sheets = [
    buildSheet(4, 'FULL_SAIL', FULL_SAIL),
    buildSheet(8, 'FULL_SAIL', FULL_SAIL),
    buildSheet(12, 'FULL_SAIL', FULL_SAIL),
    buildSheet(12, 'WORKING_SAIL', WORKING_SAIL),
    // S6c: the same 8 m/s wind as sheet 2, with the square topsail handed.
    // The two sheets side by side are the aback branch's own A/B.
    buildSheet(8, 'BEATING_SAIL', BEATING_SAIL),
  ];

  let noGoMaxSpeedMps = 0;
  let reachBeatsRunEverySheet = true;
  let maxSpeedAnySheetMps = 0;
  let mirrorMaxSpeedErrorMps = 0;
  let maxLeewayDeg = 0;
  let maxAbsBalanceRudderDeg = 0;
  let closeHauledAngleDeg: number | null = null;
  let sailingSectorLeewaySaturated = false;
  for (const sheet of sheets) {
    if (sheet.closeHauledAngleDeg !== null) {
      closeHauledAngleDeg = Math.max(
        closeHauledAngleDeg ?? 0,
        sheet.closeHauledAngleDeg,
      );
    }
    for (const point of sheet.points) {
      if (point.windAngleOffBowDeg <= 30) {
        noGoMaxSpeedMps = Math.max(noGoMaxSpeedMps, point.steadySpeedMps);
      }
      maxSpeedAnySheetMps = Math.max(maxSpeedAnySheetMps, point.steadySpeedMps);
      // Leeway and helm are gated where she SAILS. Outside the sector the
      // honest captive answer is a crab, and the file reports it.
      if (!inSailingSector(sheet, point)) continue;
      maxLeewayDeg = Math.max(maxLeewayDeg, point.leewayDeg);
      if (point.leewayDeg >= LEEWAY_SEARCH_MAX_DEG - 1e-6) {
        sailingSectorLeewaySaturated = true;
      }
      if (point.balanceRudderDeg !== null) {
        maxAbsBalanceRudderDeg = Math.max(
          maxAbsBalanceRudderDeg,
          Math.abs(point.balanceRudderDeg),
        );
      }
    }
    const run = sheet.points.find((p) => p.windAngleOffBowDeg === 180)!;
    if (sheet.bestSpeedMps <= run.steadySpeedMps || sheet.bestAngleDeg >= 160) {
      reachBeatsRunEverySheet = false;
    }
    mirrorMaxSpeedErrorMps = Math.max(
      mirrorMaxSpeedErrorMps,
      sheet.mirrorMaxSpeedErrorMps,
    );
  }
  const fullSailAt12 = sheets[2];

  return {
    formatVersion: SAILING_POLAR_EVIDENCE_FORMAT_VERSION,
    status:
      'S6c: helm-held equilibrium polar re-priced by the coefficient round ' +
      '— induced drag CL²/(π·AR·e) on each sail’s own effective aspect ' +
      'ratio, lift on an aback sail, and CLmax read from the camber the ' +
      'cloth is drawn at. She points worse and honestly: 30° is dead at ' +
      'every sheeting the rig permits, where the S4 file made 2.68 m/s at ' +
      'an 8° floor. Every point still solved with each sail trimmed to ' +
      'draw for its own apparent wind, the schedule reported per point.',
    contract: {
      method:
        'Per point: sequential-relaxation captive balance — tow speed on ' +
        'the surge residual, leeway on the sway residual, rudder on the ' +
        'yaw residual — then settle heel at the solution. Every probe is ' +
        'trimmed to draw for its own apparent wind, so the fixed point is ' +
        'the equilibrium at best settings. Both tacks solved; the mirror ' +
        'error is the symmetry gate.',
      scope:
        'True-wind angles 0-180 x winds 4/8/12 m/s x FULL_SAIL, plus ' +
        'WORKING_SAIL at 12 and BEATING_SAIL (square topsail handed) at 8. ' +
        'Flat water, gustiness 0.',
      validationMeaning:
        'No-go dead, reach fastest, hull-speed bound, tack symmetry, the ' +
        '12 m/s heel band, a close-hauled angle inside its band, and — ' +
        'INSIDE THE SAILING SECTOR — bounded leeway and few-degrees helm ' +
        'are validated; aero and added-mass coefficients remain ' +
        'provisional, and the span efficiency in the induced term is a ' +
        'stated constant rather than a derived one. The trim rule is a ' +
        'policy, not a per-point optimum — a schedule the S5 trimmers can ' +
        'actually sail — and it has no rule for handing a sail that cannot ' +
        'be braced to draw, which is why the BEATING_SAIL sheet exists.',
    },
    configuration: {
      physicsHz: PHYSICS_HZ,
      probeSettleSeconds: PROBE_SETTLE_SECONDS,
      heelSettleSeconds: HEEL_SETTLE_SECONDS,
      speedBisectionIterations: SPEED_BISECTION_ITERATIONS,
      relaxationRounds: RELAXATION_ROUNDS,
      leewaySearchMaxDeg: LEEWAY_SEARCH_MAX_DEG,
      hullSpeedMps: SAILING_HULL_SPEED_MPS,
      hullSpeedAllowance: POLAR_HULL_SPEED_ALLOWANCE,
      addedMass: SCHOONER_HORIZONTAL_ADDED_MASS,
      angleGridDeg: [...ANGLE_GRID_DEG],
    },
    sheets,
    gates: {
      noGoMaxSpeedMps: round(noGoMaxSpeedMps, 4),
      reachBeatsRunEverySheet,
      maxSpeedAnySheetMps: round(maxSpeedAnySheetMps, 4),
      hullSpeedBoundMps: round(
        SAILING_HULL_SPEED_MPS * POLAR_HULL_SPEED_ALLOWANCE,
        4,
      ),
      mirrorMaxSpeedErrorMps: round(mirrorMaxSpeedErrorMps, 6),
      fullSailHeelAt12Deg: fullSailAt12.maxHeelDeg,
      heelBandDeg: [15, 25],
      maxLeewayDeg: round(maxLeewayDeg, 3),
      maxAbsBalanceRudderDeg: round(maxAbsBalanceRudderDeg, 3),
      closeHauledAngleDeg,
      sailingSectorLeewaySaturated,
    },
  };
}

function round(value: number, digits = 8): number {
  if (!Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  const rounded = Math.round(value * scale) / scale;
  return Object.is(rounded, -0) ? 0 : rounded;
}
