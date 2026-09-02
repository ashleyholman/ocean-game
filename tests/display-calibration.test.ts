import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  CALIBRATION_LADDER,
  CALIBRATION_REFERENCE_FLOOR_CODE,
  CALIBRATION_TARGET_MARGIN_CODES,
  NIGHT_SEA_DISPLAY_LUMINANCE,
  calibrationSummary,
  codeToLinear,
  liftGammaForBlackFloor,
  srgbCode,
  srgbDecode,
  srgbEncode,
} from '../src/scene/displayCalibration';
import {
  DEFAULT_SCOTOPIC_STRENGTH,
  SCOTOPIC_KNEE_HI,
  SCOTOPIC_LIFT_GAMMA,
  applyScotopic,
  scotopicLift,
  scotopicLiftScale,
} from '../src/scene/scotopic';

/**
 * Part C — the display calibration retained for the optional Part A model.
 *
 * The measurement itself cannot be tested from node: it is a person looking at
 * a screen. What can be tested is that the model built on top of it is sound —
 * that the shipped 0% path never consumes it, that the derivation still
 * inverts the operator rather than fitting it for an explicit opt-in, and that
 * no answer the ladder can produce sends that optional night anywhere absurd.
 */

const luma = (c: readonly [number, number, number]): number =>
  0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

describe('the sRGB transfer, which everything here is counted in', () => {
  it('round-trips every 8-bit code exactly', () => {
    for (let code = 0; code <= 255; code++) {
      expect(srgbCode(codeToLinear(code)), `code ${code}`).toBe(code);
    }
  });

  it('is its own inverse either way round', () => {
    for (let i = 0; i <= 100; i++) {
      const v = i / 100;
      expect(srgbDecode(srgbEncode(v))).toBeCloseTo(v, 12);
      expect(srgbEncode(srgbDecode(v))).toBeCloseTo(v, 12);
    }
  });
});

describe('the lift, derived from a measured black floor', () => {
  it('inverts the operator rather than fitting it', () => {
    // The claim is that g = ln(Y/K)/ln(T/K) is exactly the gamma whose lift
    // carries the night sea to the target. Check it by running the operator's
    // own curve forward at the derived gamma and landing on the target.
    for (const floor of [2, 6, 12, 16, 24, 32]) {
      const gamma = liftGammaForBlackFloor(floor);
      const target = codeToLinear(floor + CALIBRATION_TARGET_MARGIN_CODES);
      expect(
        scotopicLift(NIGHT_SEA_DISPLAY_LUMINANCE, gamma),
        `floor ${floor}`,
      ).toBeCloseTo(target, 9);
    }
  });

  it('reproduces Part A exactly for the floor Part A assumed', () => {
    // The reference floor is DERIVED so that this holds — it is whatever floor
    // makes the model agree with the shipping constant. If it ever stops
    // holding, the model and the operator have drifted apart.
    expect(liftGammaForBlackFloor(CALIBRATION_REFERENCE_FLOOR_CODE)).toBeCloseTo(
      SCOTOPIC_LIFT_GAMMA,
      9,
    );
    // And it lands where Part A said an uncalibrated laptop in a lit room sits.
    expect(CALIBRATION_REFERENCE_FLOOR_CODE).toBeGreaterThan(12);
    expect(CALIBRATION_REFERENCE_FLOOR_CODE).toBeLessThan(19);
  });

  it('lifts more for a worse display and less for a better one', () => {
    let previous = 0;
    for (const floor of CALIBRATION_LADDER) {
      const gamma = liftGammaForBlackFloor(floor);
      expect(gamma, `floor ${floor}`).toBeGreaterThanOrEqual(previous);
      previous = gamma;
    }
    expect(liftGammaForBlackFloor(2)).toBeLessThan(SCOTOPIC_LIFT_GAMMA);
    expect(liftGammaForBlackFloor(36)).toBeGreaterThan(SCOTOPIC_LIFT_GAMMA);
  });

  it('stays sane at both ends of the ladder', () => {
    // Every answer a player can physically give, including the daft ones.
    for (const floor of CALIBRATION_LADDER) {
      const gamma = liftGammaForBlackFloor(floor);
      expect(Number.isFinite(gamma), `floor ${floor}`).toBe(true);
      expect(gamma, `floor ${floor}`).toBeGreaterThanOrEqual(1);
      expect(gamma, `floor ${floor}`).toBeLessThanOrEqual(4);
      // The night sea must come out brighter than it went in, and must not be
      // driven up past the knee where the operator is supposed to retire.
      const lifted = scotopicLift(NIGHT_SEA_DISPLAY_LUMINANCE, gamma);
      expect(lifted, `floor ${floor}`).toBeGreaterThanOrEqual(
        NIGHT_SEA_DISPLAY_LUMINANCE,
      );
      expect(lifted, `floor ${floor}`).toBeLessThan(SCOTOPIC_KNEE_HI);
    }
  });

  it('leaves the join C1 at every gamma, so recalibrating cannot draw a seam', () => {
    // The scale is what keeps the lifted curve passing through the knee. If a
    // calibration could move the gamma without moving the scale with it, the
    // operator would step at the knee and put a ring in the sky.
    for (const floor of CALIBRATION_LADDER) {
      const gamma = liftGammaForBlackFloor(floor);
      expect(scotopicLift(SCOTOPIC_KNEE_HI, gamma), `floor ${floor}`).toBeCloseTo(
        SCOTOPIC_KNEE_HI,
        12,
      );
      expect(scotopicLiftScale(gamma)).toBeCloseTo(
        Math.pow(SCOTOPIC_KNEE_HI, 1 - 1 / gamma),
        12,
      );
    }
  });

  it('keeps the operator inert above the knee whatever the calibration says', () => {
    // Part A's clause, re-checked at every gamma the ladder can produce: the
    // lamp and the daylight guarantee must not depend on the player's panel.
    for (const floor of CALIBRATION_LADDER) {
      const gamma = liftGammaForBlackFloor(floor);
      const bright: [number, number, number] = [0.98, 0.65, 0.4];
      expect(applyScotopic(bright, [0, 0, 0], 1, gamma), `floor ${floor}`).toEqual(
        bright,
      );
      const anything: [number, number, number] = [0.002, 0.004, 0.006];
      expect(applyScotopic(anything, anything, 0, gamma), `floor ${floor}`).toEqual(
        anything,
      );
    }
  });

  it('puts the night sea the promised distance above the floor it measured', () => {
    // The whole point, stated as the thing a player would check.
    for (const floor of [4, 8, 14, 20, 29]) {
      const gamma = liftGammaForBlackFloor(floor);
      const sea: [number, number, number] = [
        NIGHT_SEA_DISPLAY_LUMINANCE,
        NIGHT_SEA_DISPLAY_LUMINANCE,
        NIGHT_SEA_DISPLAY_LUMINANCE,
      ];
      const seen = srgbCode(luma(applyScotopic(sea, sea, 1, gamma)));
      expect(seen - floor, `floor ${floor}`).toBeGreaterThanOrEqual(
        CALIBRATION_TARGET_MARGIN_CODES - 1,
      );
      expect(seen - floor, `floor ${floor}`).toBeLessThanOrEqual(
        CALIBRATION_TARGET_MARGIN_CODES + 1,
      );
    }
  });
});

describe("Part C after Ash's 0% verdict", () => {
  it('is inactive and truthful on the shipped path', () => {
    expect(DEFAULT_SCOTOPIC_STRENGTH).toBe(0);
    expect(calibrationSummary(DEFAULT_SCOTOPIC_STRENGTH)).toMatch(
      /inactive.*does not change the shipped picture/i,
    );
  });

  it('is only offered when the optional observer has been enabled', () => {
    const settings = readFileSync('src/hud/panels/SettingsPanel.ts', 'utf8');
    expect(settings).toContain('if (scotopicStrength() > 0)');
    expect(settings).toContain('Calibrate optional night vision');

    const overlay = readFileSync('src/hud/displayCalibrationOverlay.ts', 'utf8');
    expect(overlay).toContain('Night-vision compensation is off');
    expect(overlay).toContain('the picture is unchanged');
  });
});

describe('the ladder the player is shown', () => {
  it('starts at pure black, as a control', () => {
    // A player who reports seeing this one has told us the reading is
    // unreliable. Without it there is no guard at all against the urge to see
    // something where nothing is drawn.
    expect(CALIBRATION_LADDER[0]).toBe(0);
  });

  it('rises, and spans the answers a real display can give', () => {
    for (let i = 1; i < CALIBRATION_LADDER.length; i++) {
      expect(CALIBRATION_LADDER[i]).toBeGreaterThan(CALIBRATION_LADDER[i - 1]);
    }
    // A good panel in a dark room lands near the bottom, a laptop with a window
    // behind it near the top. Both have to be expressible.
    expect(CALIBRATION_LADDER[1]).toBeLessThanOrEqual(3);
    expect(CALIBRATION_LADDER[CALIBRATION_LADDER.length - 1]).toBeGreaterThanOrEqual(
      40,
    );
    expect(CALIBRATION_LADDER).toContain(
      CALIBRATION_LADDER.find(
        (code) => Math.abs(code - CALIBRATION_REFERENCE_FLOOR_CODE) < 4,
      ),
    );
  });

  it('is the same ladder the overlay draws', () => {
    // The patches and the maths must not be able to disagree about what a
    // click meant.
    const overlay = readFileSync('src/hud/displayCalibrationOverlay.ts', 'utf8');
    expect(overlay).toContain("from '../scene/displayCalibration'");
    expect(overlay).toContain('for (const code of CALIBRATION_LADDER)');
    expect(overlay).toContain('rgb(${code}, ${code}, ${code})');
  });

  it('makes the player wait before it asks', () => {
    // A reading of near-black taken straight after looking at a lit interface
    // measures the interface. Short, but not zero.
    const overlay = readFileSync('src/hud/displayCalibrationOverlay.ts', 'utf8');
    const match = overlay.match(/const SETTLE_SECONDS = (\d+)/);
    expect(match).not.toBeNull();
    const seconds = Number((match as RegExpMatchArray)[1]);
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThanOrEqual(10);
  });

  it('reaches the renderer live, without a page reload', () => {
    // Measured in the browser on one frozen frame at a moonless -34 degree
    // night, flipping the calibration in place: the sky reads sRGB 15 at a
    // measured floor of 2, 29 uncalibrated, and 49 at a floor of 36. The wiring
    // that makes that possible is the lift being a UNIFORM the pass republishes
    // on a calibration change, rather than a constant baked into the shader.
    const pass = readFileSync('src/render/ScenePresentPass.ts', 'utf8');
    expect(pass).toContain('onDisplayCalibrationChange');
    expect(pass).toContain('uScotopicLift');
    expect(pass).toContain('calibratedLiftGamma()');
    // And the scale must be republished with the gamma or the join steps.
    expect(pass).toContain('scotopicLiftScale(gamma)');
  });

  it('is reachable from settings when opted in, and says what it concluded', () => {
    const settings = readFileSync('src/hud/panels/SettingsPanel.ts', 'utf8');
    expect(settings).toContain('if (scotopicStrength() > 0)');
    expect(settings).toContain('openDisplayCalibration');
    expect(settings).toContain('calibrationSummary()');
    // And can be undone, or the measurement is a trap.
    expect(settings).toContain('setDisplayCalibration(null)');
  });
});
