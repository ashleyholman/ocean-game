import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  solveEquilibrium,
  type SailingPolarEvidence,
} from '../src/vessel/schooner/SailingPolarEvidence';
import { FULL_SAIL } from '../src/vessel/schooner/sailAero';

/**
 * The polar contract, S3 form. The S2 version rebuilt the whole polar in
 * this test; the three-unknown equilibrium solve made a full rebuild a
 * many-minute affair, so the committed JSON now carries the curve (the
 * export tool enforces the same gates at regeneration) and this suite
 * verifies the committed gates plus one live spot solve — drift between
 * code and committed file cannot hide.
 */
describe('sailing polar evidence contract', () => {
  const evidence = JSON.parse(
    readFileSync('evidence/ship-sailing/polar-baseline.json', 'utf8'),
  ) as SailingPolarEvidence;

  it('carries every gate the export tool enforced', () => {
    const gates = evidence.gates;
    expect(evidence.formatVersion).toBe(4);

    // The no-go zone is dead: nothing sails inside 30° of the wind.
    expect(gates.noGoMaxSpeedMps).toBeLessThan(0.3);
    // A reach is the fastest point of sail on every sheet — never the run.
    expect(gates.reachBeatsRunEverySheet).toBe(true);
    // Bounded by hull speed with the stated (thin) surfing allowance.
    expect(gates.maxSpeedAnySheetMps).toBeLessThanOrEqual(
      gates.hullSpeedBoundMps,
    );
    // Port and starboard polars mirror to the ship's real centre-of-mass
    // asymmetry (her booms hang to leeward of centreline).
    expect(gates.mirrorMaxSpeedErrorMps).toBeLessThan(0.02);
    // The plan's stated heel target: full sail at 12 m/s heels her hard but
    // not on her beam ends.
    expect(gates.fullSailHeelAt12Deg).toBeGreaterThanOrEqual(
      gates.heelBandDeg[0],
    );
    expect(gates.fullSailHeelAt12Deg).toBeLessThanOrEqual(
      gates.heelBandDeg[1],
    );
    // The S3 columns, S6c-scoped: leeway real and bounded and helm a few
    // degrees not tens, INSIDE THE SAILING SECTOR. Outside it — at 45° in
    // 8 m/s she now makes 1 m/s with 20° of drift — the honest captive
    // answer is a crab, and the file reports it rather than being gated
    // against measuring it.
    expect(gates.maxLeewayDeg).toBeGreaterThan(0);
    expect(gates.maxLeewayDeg).toBeLessThanOrEqual(15);
    expect(gates.maxAbsBalanceRudderDeg).toBeGreaterThan(0);
    expect(gates.maxAbsBalanceRudderDeg).toBeLessThanOrEqual(12);
    expect(gates.sailingSectorLeewaySaturated).toBe(false);

    // THE POINTING LIMIT (S6c, FINDING S4-1). The rig now has one of its
    // own — induced drag on low-aspect gaff sails — so it is gated in both
    // directions: she must be able to beat, and she must not point like a
    // modern sloop. Every sheet must reach a sailing sector at all.
    expect(gates.closeHauledAngleDeg).not.toBeNull();
    expect(gates.closeHauledAngleDeg!).toBeGreaterThanOrEqual(45);
    expect(gates.closeHauledAngleDeg!).toBeLessThanOrEqual(75);
    for (const sheet of evidence.sheets) {
      expect(sheet.closeHauledAngleDeg, sheet.canvas).not.toBeNull();
    }

    // Structure: every sheet spans the grid, speeds rise with wind in the
    // drawing sector, and shortening sail sheds heel at the same wind.
    expect(evidence.sheets).toHaveLength(5);
    const at = (sheetIndex: number, angle: number) =>
      evidence.sheets[sheetIndex].points.find(
        (point) => point.windAngleOffBowDeg === angle,
      )!;
    expect(at(1, 90).steadySpeedMps).toBeGreaterThan(at(0, 90).steadySpeedMps);
    expect(at(2, 90).steadySpeedMps).toBeGreaterThan(at(0, 90).steadySpeedMps);
    const fullAt12 = evidence.sheets[2];
    const workingAt12 = evidence.sheets[3];
    expect(workingAt12.maxHeelDeg).toBeLessThan(fullAt12.maxHeelDeg);

    // S6c's fifth sheet: the same 8 m/s wind with the square topsail handed.
    // Close-hauled it must be FASTER than carrying it, because carrying it
    // close-hauled means carrying it aback, and an aback sail now costs
    // what an aback sail costs (FINDING S4-2). Off the wind, where the
    // topsail draws, the full rig must win.
    const beating = evidence.sheets[4];
    expect(beating.canvas).toBe('BEATING_SAIL');
    expect(beating.windSpeedMps).toBe(8);
    expect(at(4, 45).steadySpeedMps).toBeGreaterThan(at(1, 45).steadySpeedMps);
    expect(at(4, 60).steadySpeedMps).toBeGreaterThan(at(1, 60).steadySpeedMps);
    expect(at(4, 150).steadySpeedMps).toBeLessThan(at(1, 150).steadySpeedMps);

    // Head to wind she is actively pushed astern, on every sheet; where she
    // sails on a full-sail reach she carries real leeway and weather helm.
    for (const sheet of evidence.sheets) {
      expect(at(evidence.sheets.indexOf(sheet), 0).driveAtRestN).toBeLessThan(0);
    }
    const beam = at(1, 90);
    expect(beam.leewayDeg).toBeGreaterThan(0.5);
    expect(beam.balanceRudderDeg).not.toBeNull();
    // WEATHER HELM MOVED IN S6c, and this assertion moved with it — off a
    // number that sat inside the solver's own resolution, onto one that
    // does not. The rudder bisection resolves to 70/2^7 = 0.55°, so the
    // 8 m/s beam point's ±0.27° (was +0.27, now −0.27) says "neutral" both
    // before and after and never should have been gated for sign. The real
    // and resolvable movement is at 12 m/s: 3.01° → 1.37°, weather helm
    // roughly halved, because the low-aspect mainsail AFT gives up more
    // lift to induced drag than the high-aspect headsails FORWARD do, and
    // the centre of effort walks forward. Still weather helm, and gated as
    // such where the solver can see it.
    expect(Math.abs(beam.balanceRudderDeg!)).toBeLessThan(0.6);
    const beamHard = at(2, 90);
    expect(beamHard.balanceRudderDeg).not.toBeNull();
    expect(beamHard.balanceRudderDeg!).toBeGreaterThan(0.5);
    expect(beamHard.balanceRudderDeg!).toBeLessThan(3.0);
  });

  it('spot-resolves the 8 m/s full-sail beam point to the committed value', {
    tags: ['slow', 'sailing'],
    timeout: 300_000,
  }, () => {
    const committed = evidence.sheets[1].points.find(
      (point) => point.windAngleOffBowDeg === 90,
    )!;
    const solved = solveEquilibrium(90, 'starboard', 8, FULL_SAIL);
    expect(solved.speedMps).toBeCloseTo(committed.steadySpeedMps, 4);
    expect(solved.leewayDeg).toBeCloseTo(committed.leewayDeg, 3);
    expect(solved.rudderDeg).not.toBeNull();
    expect(solved.rudderDeg!).toBeCloseTo(committed.balanceRudderDeg!, 3);
  });
});
