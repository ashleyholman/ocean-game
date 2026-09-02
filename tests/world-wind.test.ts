import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WindSystem } from '../src/scene/WindSystem';
import {
  DIRECTION_WANDER_DEG,
  SPEED_GUST_AMPLITUDE_FRACTION,
  WORLD_WIND_DEFAULT_SEED,
  WorldWind,
  apparentWindRender,
  pointOfSailName,
  trueWindAngleDeg,
  windAngleOffBowDeg,
  windRenderHeadingRad,
  windRenderToBody,
  windRenderVector,
  wrapDegrees180,
} from '../src/world/WorldWind';
import {
  WORLD_WIND_EVIDENCE_CONTRACT,
  buildWorldWindPresetEvidence,
  validateWorldWindEvidence,
  worldWindEvidencePresetNames,
  type WorldWindEvidence,
} from '../src/world/WorldWindEvidence';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Presentation heading for a model yaw at zero frame offset, via the identical
 * reduction `main.ts` uses (`atan2(bowX, -bowZ)` on the render bow vector).
 * Model yaw 0 must land on presentation heading 180 — the documented trap.
 */
function renderHeadingDegForModelYaw(modelYawRad: number): number {
  const bowX = Math.sin(modelYawRad);
  const bowZ = Math.cos(modelYawRad);
  let deg = Math.atan2(bowX, -bowZ) * RAD_TO_DEG;
  if (deg < 0) deg += 360;
  return deg;
}

describe('wind direction conventions', () => {
  it('matches WindSystem.setOceanWind exactly for the render vector', () => {
    const windSystem = new WindSystem();
    const out = { x: 0, z: 0 };
    for (const directionDeg of [0, 45, 68, 90, 123.4, 180, 270, 359]) {
      for (const frameDeg of [0, -37.25, 90, 214.6]) {
        for (const speed of [0.8, 6, 12.5]) {
          const headingRad = windRenderHeadingRad(directionDeg, frameDeg);
          windSystem.setOceanWind(headingRad, speed);
          windRenderVector(headingRad, speed, out);
          expect(out.x).toBeCloseTo(windSystem.direction.x * speed, 12);
          expect(out.z).toBeCloseTo(windSystem.direction.y * speed, 12);
          expect(speed).toBe(windSystem.strength);
        }
      }
    }
  });

  it('pins model yaw zero to presentation heading 180', () => {
    expect(renderHeadingDegForModelYaw(0)).toBeCloseTo(180, 12);
  });

  it('pins hand-computed true wind angles', () => {
    // Positive = wind over the model +x side (see WorldWind.ts and finding W1).
    expect(trueWindAngleDeg(0, 180)).toBeCloseTo(0, 12); // from dead ahead
    expect(trueWindAngleDeg(0, 0)).toBeCloseTo(180, 12); // from dead astern
    expect(trueWindAngleDeg(0, 90)).toBeCloseTo(90, 12); // from the west
    expect(trueWindAngleDeg(90, 180)).toBeCloseTo(90, 12); // east ship, north wind
    expect(trueWindAngleDeg(350, 190)).toBeCloseTo(-20, 12);
  });

  it('agrees between the compass route and the body-frame route at every yaw', () => {
    const vector = { x: 0, z: 0 };
    const body = { x: 0, z: 0 };
    for (let yawDeg = -180; yawDeg <= 180; yawDeg += 15) {
      for (let towardDeg = 0; towardDeg < 360; towardDeg += 22.5) {
        const yawRad = yawDeg * (Math.PI / 180);
        windRenderVector(windRenderHeadingRad(towardDeg, 0), 6, vector);
        windRenderToBody(vector.x, vector.z, yawRad, body);
        const bodyAngle = windAngleOffBowDeg(body.x, body.z);
        const compassAngle = trueWindAngleDeg(
          renderHeadingDegForModelYaw(yawRad),
          towardDeg,
        );
        expect(wrapDegrees180(bodyAngle - compassAngle)).toBeCloseTo(0, 9);
      }
    }
  });

  it('names wind toward render +x a beam reach for the yaw-zero ship', () => {
    const vector = { x: 0, z: 0 };
    const body = { x: 0, z: 0 };
    windRenderVector(windRenderHeadingRad(90, 0), 8, vector);
    expect(vector.x).toBeCloseTo(8, 12);
    expect(vector.z).toBeCloseTo(0, 12);
    windRenderToBody(vector.x, vector.z, 0, body);
    const angle = windAngleOffBowDeg(body.x, body.z);
    expect(Math.abs(angle)).toBeCloseTo(90, 12);
    expect(pointOfSailName(angle)).toBe('beam-reach');
  });

  it('wraps degrees into (-180, 180]', () => {
    expect(wrapDegrees180(0)).toBe(0);
    expect(wrapDegrees180(180)).toBe(180);
    expect(wrapDegrees180(-180)).toBe(180);
    expect(wrapDegrees180(540)).toBe(180);
    expect(wrapDegrees180(-190)).toBeCloseTo(170, 12);
    expect(wrapDegrees180(90)).toBe(90);
    expect(wrapDegrees180(-90)).toBe(-90);
  });

  it('names the points of sail by sector', () => {
    expect(pointOfSailName(0)).toBe('head-to-wind');
    expect(pointOfSailName(-30)).toBe('head-to-wind');
    expect(pointOfSailName(60)).toBe('close-hauled');
    expect(pointOfSailName(-90)).toBe('beam-reach');
    expect(pointOfSailName(120)).toBe('broad-reach');
    expect(pointOfSailName(180)).toBe('run');
    expect(pointOfSailName(-165)).toBe('run');
  });
});

describe('apparent wind', () => {
  it('equals the true wind for a stationary point', () => {
    const out = { x: 0, z: 0 };
    apparentWindRender(3.2, -1.7, 0, 0, out);
    expect(out.x).toBe(3.2);
    expect(out.z).toBe(-1.7);
  });

  it('strengthens beating into the wind and weakens running before it', () => {
    const out = { x: 0, z: 0 };
    const body = { x: 0, z: 0 };
    // Ship sailing due north (model yaw PI) at 4 m/s: render velocity (0, -4).
    const northYaw = Math.PI;

    // True wind from the north: blows toward 180, render vector (0, +6).
    windRenderVector(windRenderHeadingRad(180, 0), 6, out);
    apparentWindRender(out.x, out.z, 0, -4, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(10, 12);
    windRenderToBody(out.x, out.z, northYaw, body);
    expect(windAngleOffBowDeg(body.x, body.z)).toBeCloseTo(0, 7);

    // True wind from astern: blows toward 0, render vector (0, -6).
    windRenderVector(windRenderHeadingRad(0, 0), 6, out);
    apparentWindRender(out.x, out.z, 0, -4, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(2, 12);
    windRenderToBody(out.x, out.z, northYaw, body);
    expect(Math.abs(windAngleOffBowDeg(body.x, body.z))).toBeCloseTo(180, 7);
  });
});

describe('world wind gust process', () => {
  it('is a pure function of elapsed wind time, independent of step pattern', () => {
    const a = new WorldWind();
    const b = new WorldWind();
    a.setMean(9, 68, 0.45);
    b.setMean(9, 68, 0.45);
    // Dyadic steps sum exactly, so equality is exact, not approximate.
    for (let i = 0; i < 512; i++) a.advance(1 / 64);
    for (let i = 0; i < 128; i++) b.advance(1 / 16);
    expect(a.elapsedSeconds).toBe(b.elapsedSeconds);
    expect(a.instantaneousSpeedMps).toBe(b.instantaneousSpeedMps);
    expect(a.instantaneousDirectionTowardDeg).toBe(
      b.instantaneousDirectionTowardDeg,
    );
  });

  it('differs between seeds and repeats within a seed', () => {
    const a = new WorldWind(WORLD_WIND_DEFAULT_SEED);
    const b = new WorldWind(WORLD_WIND_DEFAULT_SEED);
    const c = new WorldWind(WORLD_WIND_DEFAULT_SEED + 1);
    for (const wind of [a, b, c]) {
      wind.setMean(9, 68, 0.45);
      wind.advance(12.375);
    }
    expect(a.instantaneousSpeedMps).toBe(b.instantaneousSpeedMps);
    expect(a.instantaneousSpeedMps).not.toBe(c.instantaneousSpeedMps);
  });

  it('reproduces the mean exactly at zero gustiness', () => {
    const wind = new WorldWind();
    wind.setMean(9, 68, 0);
    for (let i = 0; i < 100; i++) {
      wind.advance(0.73);
      expect(wind.instantaneousSpeedMps).toBe(9);
      expect(wind.instantaneousDirectionTowardDeg).toBe(68);
      expect(wind.gustDirectionOffsetDeg).toBe(0);
    }
  });

  it('stays inside its stated amplitude bounds', () => {
    const wind = new WorldWind();
    const gustiness = 0.5;
    wind.setMean(12.5, 4, gustiness);
    const speedBound = 12.5 * SPEED_GUST_AMPLITUDE_FRACTION * gustiness;
    const directionBound = DIRECTION_WANDER_DEG * gustiness;
    for (let i = 0; i < 4000; i++) {
      wind.advance(0.25);
      expect(Math.abs(wind.gustSpeedFraction)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(wind.instantaneousSpeedMps - 12.5),
      ).toBeLessThanOrEqual(speedBound + 1e-12);
      expect(
        Math.abs(wind.gustDirectionOffsetDeg),
      ).toBeLessThanOrEqual(directionBound + 1e-12);
    }
  });

  it('rejects invalid means and steps', () => {
    const wind = new WorldWind();
    expect(() => wind.setMean(-1, 0, 0)).toThrow(RangeError);
    expect(() => wind.setMean(5, Number.NaN, 0)).toThrow(RangeError);
    expect(() => wind.setMean(5, 0, 1.5)).toThrow(RangeError);
    expect(() => wind.advance(-0.1)).toThrow(RangeError);
  });
});

describe('committed gust evidence', () => {
  const evidence = JSON.parse(
    readFileSync('evidence/world-wind/gust-baseline.json', 'utf8'),
  ) as WorldWindEvidence;

  it('covers every non-debug preset and passes every physical gate', () => {
    expect(evidence.presets.map((preset) => preset.name)).toEqual(
      worldWindEvidencePresetNames(),
    );
    expect(evidence.contract).toEqual(WORLD_WIND_EVIDENCE_CONTRACT);
    expect(() => validateWorldWindEvidence(evidence)).not.toThrow();
  });

  it('is reproduced exactly by a fresh computation', () => {
    for (const name of ['CURRENT_MODERATE', 'WIND_CHOP']) {
      const committed = evidence.presets.find((preset) => preset.name === name);
      expect(committed).toBeDefined();
      expect(buildWorldWindPresetEvidence(name)).toEqual(committed);
    }
  });
});
