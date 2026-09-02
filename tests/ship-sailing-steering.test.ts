import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildShipTackEvidence,
  buildShipTurnEvidence,
  solveHelmBalance,
  type ShipHelmEvidence,
  type ShipTackEvidence,
  type ShipTurnEvidence,
} from '../src/vessel/schooner/SailingSteeringEvidence';
import { FULL_SAIL } from '../src/vessel/schooner/sailAero';

const committedTurn = JSON.parse(
  readFileSync('evidence/ship-sailing/turn-baseline.json', 'utf8'),
) as ShipTurnEvidence;
const committedTack = JSON.parse(
  readFileSync('evidence/ship-sailing/tack-baseline.json', 'utf8'),
) as ShipTackEvidence;

/**
 * S3 steering contract tests. The gates live twice deliberately — here and
 * in the export tools — per the standing evidence convention: the tool
 * guards regeneration, the suite guards drift in between.
 *
 * Turn and tack rebuild their evidence live (minutes of solves) and compare
 * the result with the committed products. The helm curve is heavier still, so
 * the committed JSON carries it and one point is re-solved here as a spot
 * check.
 */

describe('ship:turn — steady circles under commanded rudder', () => {
  it('mirrors, tightens with helm, and does not turn without way', {
    tags: ['slow', 'sailing'],
    timeout: 600_000,
  }, () => {
    const evidence = buildShipTurnEvidence();
    const gates = evidence.gates;

    expect(evidence).toEqual(committedTurn);

    expect(gates.stoppedShipTurnRad).toBeLessThan(1e-8);
    expect(gates.radiusMonotonicWithHelm).toBe(true);
    expect(gates.mirrorMaxRelativeError).toBeLessThan(5e-3);
    expect(gates.minRadiusM).toBeGreaterThan(25);
    expect(gates.maxRadiusM).toBeLessThan(400);
    expect(gates.maxEnergyOverWorkJ).toBeLessThanOrEqual(1e-6);
    expect(gates.maxYawRateUnsteadiness).toBeLessThan(0.05);

    // Thrust calibration holds the straight-line controls near target.
    for (const control of evidence.straightLineControls) {
      expect(
        Math.abs(control.finalSpeedMps - control.targetSpeedMps),
      ).toBeLessThan(0.15);
    }
    // Radius is close to speed-independent — the classic manoeuvring
    // result, emergent rather than prescribed.
    for (const angle of evidence.configuration.rudderAnglesDeg) {
      const slow = evidence.cases.find(
        (c) => c.targetSpeedMps === 2.5 && c.rudderCommandDeg === angle,
      )!;
      const fast = evidence.cases.find(
        (c) => c.targetSpeedMps === 4 && c.rudderCommandDeg === angle,
      )!;
      expect(
        Math.abs(slow.steadyRadiusM - fast.steadyRadiusM) / fast.steadyRadiusM,
      ).toBeLessThan(0.05);
    }
    // She slides outward in the turn, more with more helm.
    const gentle = evidence.cases.find(
      (c) => c.targetSpeedMps === 4 && c.rudderCommandDeg === 10,
    )!;
    const hard = evidence.cases.find(
      (c) => c.targetSpeedMps === 4 && c.rudderCommandDeg === 30,
    )!;
    expect(Math.abs(hard.steadyDriftAngleDeg)).toBeGreaterThan(
      Math.abs(gentle.steadyDriftAngleDeg),
    );
    expect(hard.speedLossFraction).toBeGreaterThan(gentle.speedLossFraction);
  });
});

describe('ship:tack — the maneuver envelope on the live control surface', () => {
  it('carries way through the eye but no longer settles on the new board', {
    tags: ['slow', 'sailing'],
    timeout: 300_000,
  }, () => {
    const evidence = buildShipTackEvidence();
    const gates = evidence.gates;

    expect(evidence).toEqual(committedTack);

    // THE S4 GATE FLIPPED BACK IN S6c, and the reversal is deliberate.
    //
    // S3 measured this false, S4 flipped it true by hardening the sheets at
    // the order, and the coefficient round has taken it away again: induced
    // drag prices the hard-sheeted lift S4 got for free, so the flat
    // maneuvering trims no longer drive her out to a close-hauled groove
    // that has itself moved from ~45° to 55–60°. She is captured on the FAR
    // side of the eye at 21–33°, which is S3's ±34° attractor reached from
    // the other direction.
    //
    // THE SHIP CAN STILL TACK. `voyage-baseline.json` beats to windward
    // with three tacks ordered and three completed, because the crew work
    // the sheets continuously and stern-board her when she hangs. This
    // fixed-angle script does neither, and it is the stale instrument.
    // If it ever completes again, that is a change to the script or the
    // coefficients and belongs here, said out loud.
    expect(gates.classicTackCompletesAtAnyEntry).toBe(false);
    expect(gates.everyWithWayEntryCompletes).toBe(false);
    expect(gates.captureAngleBandDeg).not.toBeNull();
    const [captureLow, captureHigh] = gates.captureAngleBandDeg!;
    expect(captureLow).toBeGreaterThan(10);
    expect(captureHigh).toBeLessThan(42);

    // What DID survive, and only because the tacks now hand the square
    // topsail first: she carries way through the wind on every entry. With
    // it set and 65° aback, measured, no entry reached the eye at all.
    expect(gates.everyWithWayEntryCrossesEye).toBe(true);
    const [eyeLow, eyeHigh] = gates.eyeCrossSpeedBandMps;
    expect(eyeLow).toBeGreaterThan(0.8);
    expect(eyeHigh).toBeLessThan(2.5);
    // Slow is honest — a heavy gaff schooner turns at her hull's own rate —
    // but she must never come to a dead stop in stays. The bound moved from
    // S4's 0.5 m/s because she is genuinely slower everywhere now.
    for (const tack of evidence.tacks.slice(0, 3)) {
      expect(tack.minSpeedMps).toBeGreaterThan(0.05);
    }
    expect(gates.lowWayFailsBeforeEye).toBe(true);
    expect(gates.maxEnergyOverWorkJ).toBeLessThanOrEqual(1e-6);
    expect(gates.gybeCompleted).toBe(true);
    expect(gates.gybeMaxYawRateRadPerS).toBeLessThan(0.15);
    expect(evidence.gybe.transitSeconds).not.toBeNull();
    expect(evidence.gybe.transitSeconds!).toBeLessThan(30);
  });

  it('gets out of irons by stern-boarding OR by a backed headsail (S6c)', {
    tags: ['slow', 'sailing'],
    timeout: 600_000,
  }, () => {
    const evidence = buildShipTackEvidence();
    const gates = evidence.gates;
    const at = (
      method: string,
      backedToward: string,
    ) =>
      evidence.ironsEscapes.find(
        (c) => c.method === method && c.backedToward === backedToward,
      )!;

    // She IS in irons at the start: head to wind, and the wind pushes her
    // bodily astern rather than forward.
    for (const escape of evidence.ironsEscapes) {
      expect(escape.maxSternwayMps).toBeGreaterThan(0.2);
    }

    // Left alone she pays off in 44 s, where S4 measured 229 s. So the gate
    // can no longer assert stuck-ness; it asserts she was CAUGHT at all,
    // because a ship that falls off the instant she is head to wind was
    // never in irons. Be suspicious of this number: S4 already flagged the
    // drift case as an artefact of cloth that cannot flog, and the aback
    // branch makes it stronger — flat-sheeted cloth is now pressed on its
    // other face instead of idling at `cdLuffing`.
    expect(gates.ironsDriftPayOffS).not.toBeNull();
    expect(gates.ironsDriftPayOffS!).toBeGreaterThan(20);

    // The helm under sternway frees her: the rudder steers reversed once
    // the flow does, so a ship with no headway still has a lever.
    expect(gates.ironsSternBoardEscapes).toBe(true);
    expect(gates.ironsSternBoardPayOffS!).toBeLessThan(150);
    expect(at('helm-only', 'port').fellOffToward).toBe('starboard');
    expect(at('helm-only', 'port').exitSpeedMps).toBeGreaterThan(0.5);

    // FINDING S4-2, CLOSED. S4 asserted the limitation — a backed headsail
    // did literally nothing, because `sailLiftCoefficient` returned 0 for
    // any negative angle of attack — and left an instruction to come here
    // and say so deliberately the day the branch landed. It landed in S6c:
    // backing a headsail frees her in 48 s where she used to be pinned at
    // −18.8° for the whole 240 s timeout.
    expect(gates.ironsBackedHeadsailAloneEscapes).toBe(true);
    expect(at('backed-headsail', 'port').escaped).toBe(true);
    // Still worth knowing, and still slightly negative: backing a sail and
    // putting the helm the same way are two ways of doing one job. The
    // backed cloth's drag holds her sternway down, and sternway is what
    // makes the reversed blade bite.
    expect(Math.abs(gates.ironsBackedHeadsailSecondsSaved)).toBeLessThan(5);

    // The second attractor is gone too. Falling off TOWARD the sheeted side
    // used to pin her at ≈20°; it is now merely the slow way round — 64 s
    // against 48 s — so S5's recovery rule relaxes from "impossible" to
    // "slower". Gated null so its return is loud.
    expect(gates.ironsTowardSheetsAttractorDeg).toBeNull();
    const towardSheets = at('helm-only', 'starboard');
    expect(towardSheets.escaped).toBe(true);
    expect(towardSheets.timeToPayOffS!).toBeGreaterThan(
      gates.ironsSternBoardPayOffS!,
    );
  });
});

describe('ship:helm — the committed weather-helm curve', () => {
  const evidence = JSON.parse(
    readFileSync('evidence/ship-sailing/helm-baseline.json', 'utf8'),
  ) as ShipHelmEvidence;

  it('carries the gates the export tool enforced', () => {
    expect(evidence.formatVersion).toBe(2);
    expect(evidence.gates.helmFollowsCanvasBalance).toBe(true);
    expect(evidence.gates.fullSailMaxAbsBalanceDeg).toBeGreaterThan(0.2);
    expect(evidence.gates.fullSailMaxAbsBalanceDeg).toBeLessThanOrEqual(10);
    expect(evidence.gates.fullSailReachWeatherHelm).toBe(true);
    // Four canvas balances from all-aft to headsails-only, CoE ordered.
    expect(evidence.gates.coeOrderingAftToForward).toHaveLength(4);
    expect(evidence.gates.coeOrderingAftToForward[0]).toBe('AFT_CANVAS');
    expect(
      evidence.gates.coeOrderingAftToForward[3],
    ).toBe('HEADSAILS_ONLY');
  });

  it('spot-resolves the full-sail beam balance to the committed value', { timeout: 120_000 }, () => {
    const committed = evidence.sheets
      .find((sheet) => sheet.canvas === 'FULL_SAIL')!
      .points.find((point) => point.windAngleOffBowDeg === 90)!;
    const solved = solveHelmBalance(90, FULL_SAIL);
    expect(solved.balanceRudderDeg).not.toBeNull();
    expect(committed.balanceRudderDeg).not.toBeNull();
    expect(solved.balanceRudderDeg!).toBeCloseTo(
      committed.balanceRudderDeg!,
      6,
    );
    expect(solved.steadySpeedMps).toBeCloseTo(committed.steadySpeedMps, 6);
  });
});
