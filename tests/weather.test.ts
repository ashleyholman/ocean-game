import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findSeaState } from '../src/ocean/presets';
import { vec3 } from '../src/world/math';
import { geodeticToEcef } from '../src/world/wgs84';
import { WorldWind } from '../src/world/WorldWind';
import {
  OPENING_LATITUDE_DEG,
  OPENING_LONGITUDE_DEG,
  OPENING_UTC_SECONDS,
} from '../src/world/openingVoyage';
import {
  PRESSURE_SWING_HPA,
  WeatherField,
  WEATHER_DEFAULT_SEED,
} from '../src/weather/WeatherField';
import {
  WeatherSystem,
  barometerReadingOf,
  neutralWeatherState,
} from '../src/weather/WeatherSystem';
import {
  HPA_PER_INCH_OF_MERCURY,
  STANDARD_PRESSURE_HPA,
  WEATHER_BOUNDS,
  assertWeatherStateWithinBounds,
  compassDeltaDeg,
  glassTendency,
  hpaFromInchesOfMercury,
  inchesOfMercuryFromHpa,
  wrapCompassDeg,
} from '../src/weather/WeatherState';
import {
  buildWeatherEvidence,
  validateWeatherEvidence,
  weatherEvidenceBaseWind,
  weatherEvidenceField,
} from '../src/weather/WeatherEvidence';

const DEG_TO_RAD = Math.PI / 180;

function openingPosition() {
  const position = vec3();
  geodeticToEcef(
    OPENING_LATITUDE_DEG * DEG_TO_RAD,
    OPENING_LONGITUDE_DEG * DEG_TO_RAD,
    0,
    position,
  );
  return position;
}

function fakeWorld(position = openingPosition(), utcSeconds = OPENING_UTC_SECONDS) {
  return {
    state: { worldInstantUtcSeconds: utcSeconds, positionEcefM: position },
  };
}

const BASE = Object.freeze({ speedMps: 6.0, directionDeg: 144, gustiness: 0.25 });

// ---------------------------------------------------------------------------
// Units and signs. House rule 7: anything new gets a pinned test the day it is
// born, and pressure units plus the sign of a falling glass were named in the
// round brief as the convention trap most likely to be got wrong.
// ---------------------------------------------------------------------------

describe('pressure units and the sign of a falling glass', () => {
  it('reads standard pressure as 29.92 inches of mercury', () => {
    expect(inchesOfMercuryFromHpa(STANDARD_PRESSURE_HPA)).toBeCloseTo(29.9213, 4);
  });

  it('round-trips hPa through inches', () => {
    for (const hpa of [955, 980, 1013.25, 1030, 1050]) {
      expect(hpaFromInchesOfMercury(inchesOfMercuryFromHpa(hpa))).toBeCloseTo(hpa, 9);
    }
    expect(HPA_PER_INCH_OF_MERCURY).toBeCloseTo(33.863886, 6);
  });

  it('calls a NEGATIVE trend falling and a POSITIVE trend rising', () => {
    expect(glassTendency(-5)).toBe('falling rapidly');
    expect(glassTendency(-2)).toBe('falling');
    expect(glassTendency(-0.5)).toBe('falling slowly');
    expect(glassTendency(0)).toBe('steady');
    expect(glassTendency(-0)).toBe('steady');
    expect(glassTendency(0.5)).toBe('rising slowly');
    expect(glassTendency(2)).toBe('rising');
    expect(glassTendency(5)).toBe('rising rapidly');
  });

  it('never reports a steady glass as falling by a negative nothing', () => {
    const field = weatherEvidenceField();
    const state = field.derive(0, field.anchor.positionEcefM, BASE);
    // The anchor is a stationary point of the field, so the tendency there is
    // zero to within the cosine of a quarter turn. It must not be -0.
    expect(Object.is(state.pressureTrendHpaPer3h, -0)).toBe(false);
    expect(glassTendency(state.pressureTrendHpaPer3h)).toBe('steady');
  });
});

describe('compass helpers', () => {
  it('wraps into [0, 360)', () => {
    expect(wrapCompassDeg(0)).toBe(0);
    expect(wrapCompassDeg(360)).toBe(0);
    expect(wrapCompassDeg(-1)).toBe(359);
    expect(wrapCompassDeg(721)).toBe(1);
  });

  it('differences 359 to 1 as +2 degrees, not -358', () => {
    expect(compassDeltaDeg(359, 1)).toBe(2);
    expect(compassDeltaDeg(1, 359)).toBe(-2);
    expect(compassDeltaDeg(0, 180)).toBe(180);
    expect(compassDeltaDeg(180, 0)).toBe(180);
  });
});

// ---------------------------------------------------------------------------
// THE CLAIM THIS ROUND MAY SELF-CERTIFY.
// ---------------------------------------------------------------------------

describe('the neutral state is bit-for-bit what shipped before it', () => {
  it('hands the base wind back as its own floats, with no arithmetic', () => {
    const neutral = neutralWeatherState(BASE);
    expect(Object.is(neutral.windSpeedMps, BASE.speedMps)).toBe(true);
    expect(Object.is(neutral.windDirectionDeg, BASE.directionDeg)).toBe(true);
    expect(Object.is(neutral.gustiness, BASE.gustiness)).toBe(true);
    expect(neutral.gustExcessMps).toBe(0);
  });

  it('reproduces the scene constants weather has not been wired to yet', () => {
    const neutral = neutralWeatherState(BASE);
    expect(neutral.cloudCoverThreshold).toBe(0.7);
    expect(neutral.cloudCeilingM).toBe(1100);
    expect(neutral.visibilityM).toBe(9000);
    expect(neutral.precipRateMmPerHour).toBe(0);
    expect(neutral.pressureHpa).toBe(STANDARD_PRESSURE_HPA);
    expect(neutral.pressureTrendHpaPer3h).toBe(0);
  });

  it('is what a neutral-source system produces, for every sea preset', () => {
    for (const name of ['CURRENT_MODERATE', 'CALM', 'STORM']) {
      let preset;
      try {
        preset = findSeaState(name);
      } catch {
        continue;
      }
      const weather = new WeatherSystem({
        world: fakeWorld(),
        source: 'neutral',
        baseWind: {
          speedMps: preset.generatingWind.speedMps,
          directionDeg: preset.generatingWind.directionDeg,
          gustiness: preset.generatingWind.gustiness,
        },
      });
      expect(Object.is(weather.wind.speedMps, preset.generatingWind.speedMps)).toBe(true);
      expect(Object.is(weather.wind.directionDeg, preset.generatingWind.directionDeg)).toBe(true);
      expect(Object.is(weather.wind.gustiness, preset.generatingWind.gustiness)).toBe(true);
    }
  });

  it('LIVE weather at the anchor instant is also bit-identical', () => {
    // The stronger half of the claim: the shipped default, not only the off
    // switch, leaves the first frame exactly where it was. The anchor is a
    // stationary point of the field and `calibratedWind` short-circuits there.
    const weather = new WeatherSystem({
      world: fakeWorld(),
      source: 'live',
      baseWind: { ...BASE },
    });
    expect(Object.is(weather.wind.speedMps, BASE.speedMps)).toBe(true);
    expect(Object.is(weather.wind.directionDeg, BASE.directionDeg)).toBe(true);
    expect(Object.is(weather.wind.gustiness, BASE.gustiness)).toBe(true);
    expect(weather.state.gustExcessMps).toBe(
      BASE.speedMps * BASE.gustiness * 0.4,
    );
  });

  it('puts the identical triple into WorldWind, live or neutral', () => {
    // The proof at the seam itself: whatever `WorldWind` computes downstream,
    // it computes from arguments that have not moved.
    for (const source of ['live', 'neutral'] as const) {
      const weather = new WeatherSystem({
        world: fakeWorld(),
        source,
        baseWind: { ...BASE },
      });
      const withWeather = new WorldWind();
      withWeather.setMean(
        weather.wind.speedMps,
        weather.wind.directionDeg,
        weather.wind.gustiness,
      );
      const asBefore = new WorldWind();
      asBefore.setMean(BASE.speedMps, BASE.directionDeg, BASE.gustiness);

      expect(Object.is(withWeather.meanSpeedMps, asBefore.meanSpeedMps)).toBe(true);
      expect(
        Object.is(
          withWeather.meanDirectionTowardDeg,
          asBefore.meanDirectionTowardDeg,
        ),
      ).toBe(true);
      expect(Object.is(withWeather.gustiness, asBefore.gustiness)).toBe(true);

      // And the gust process on top of it, at a few instants along the clock.
      for (const t of [0, 0.5, 7, 61.25, 600]) {
        expect(withWeather.instantaneousSpeedMpsAt(t)).toBe(
          asBefore.instantaneousSpeedMpsAt(t),
        );
        expect(withWeather.instantaneousDirectionTowardDegAt(t)).toBe(
          asBefore.instantaneousDirectionTowardDegAt(t),
        );
      }
    }
  });

  it('reproduces CURRENT_MODERATE 6.0 m/s at 144 degrees', () => {
    const preset = findSeaState('CURRENT_MODERATE');
    expect(preset.generatingWind.speedMps).toBe(6.0);
    expect(preset.generatingWind.directionDeg).toBe(144);
    const weather = new WeatherSystem({
      world: fakeWorld(),
      baseWind: weatherEvidenceBaseWind(),
    });
    expect(weather.state.windSpeedMps).toBeCloseTo(6.0, 12);
    expect(weather.state.windDirectionDeg).toBeCloseTo(144, 12);
  });
});

// ---------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------

describe('the weather field', () => {
  it('is a pure function of the weather clock and the position', () => {
    const field = weatherEvidenceField();
    const position = field.anchor.positionEcefM;
    for (const t of [0, 900, 3600, 86_400, 259_200]) {
      const a = field.derive(t, position, BASE);
      const b = field.derive(t, position, BASE);
      expect(a).toEqual(b);
    }
  });

  it('gives two fields on the same seed and anchor the same answers', () => {
    const a = weatherEvidenceField();
    const b = weatherEvidenceField();
    for (const t of [0, 5000, 120_000]) {
      expect(a.derive(t, a.anchor.positionEcefM, BASE)).toEqual(
        b.derive(t, b.anchor.positionEcefM, BASE),
      );
    }
  });

  it('gives different weather on a different seed', () => {
    const a = new WeatherField(openingPosition(), OPENING_UTC_SECONDS, WEATHER_DEFAULT_SEED);
    const b = new WeatherField(openingPosition(), OPENING_UTC_SECONDS, WEATHER_DEFAULT_SEED + 1);
    const at = 40_000;
    expect(a.derive(at, a.anchor.positionEcefM, BASE).pressureHpa).not.toBeCloseTo(
      b.derive(at, b.anchor.positionEcefM, BASE).pressureHpa,
      3,
    );
  });

  it('begins in a settled spell — slack isobars and a steady glass', () => {
    // Not decoration: an anchor on a steep gradient inverts the whole
    // glass-to-wind relationship. See the note in `WeatherField`.
    const field = weatherEvidenceField();
    expect(field.anchorGradient.magnitude).toBeLessThan(1e-12);
    expect(Math.abs(field.anchorWind.speedMps)).toBeLessThan(1e-10);
  });

  it('keeps every field inside its documented bound across three days', () => {
    const field = weatherEvidenceField();
    const position = field.anchor.positionEcefM;
    for (let hour = 0; hour <= 72; hour += 0.1) {
      assertWeatherStateWithinBounds(
        field.derive(hour * 3600, position, BASE),
        `hour ${hour}`,
      );
    }
  });

  it('centres the pressure on standard rather than on wherever it started', () => {
    const field = weatherEvidenceField();
    const position = field.anchor.positionEcefM;
    let below = 0;
    let above = 0;
    for (let hour = 0; hour <= 240; hour += 0.5) {
      const p = field.derive(hour * 3600, position, BASE).pressureHpa;
      if (p < STANDARD_PRESSURE_HPA) below += 1;
      else above += 1;
      expect(p).toBeGreaterThanOrEqual(STANDARD_PRESSURE_HPA - PRESSURE_SWING_HPA);
      expect(p).toBeLessThanOrEqual(STANDARD_PRESSURE_HPA + PRESSURE_SWING_HPA);
    }
    // The glass has to be able to fall, which is the point of the round. An
    // earlier build anchored the pressure to standard and spent whole voyages
    // on one side of it.
    expect(below).toBeGreaterThan(0);
    expect(above).toBeGreaterThan(0);
  });

  it('keeps the wind direction continuous through north', () => {
    const field = weatherEvidenceField();
    const position = field.anchor.positionEcefM;
    let previous = field.derive(0, position, BASE).windDirectionDeg;
    let sawWrap = false;
    // A long walk on a fine step, so the bearing certainly crosses north.
    for (let t = 60; t <= 400 * 3600; t += 60) {
      const now = field.derive(t, position, BASE).windDirectionDeg;
      expect(now).toBeGreaterThanOrEqual(0);
      expect(now).toBeLessThan(360);
      const step = compassDeltaDeg(previous, now);
      expect(Math.abs(step)).toBeLessThan(5);
      if (Math.abs(now - previous) > 180) sawWrap = true;
      previous = now;
    }
    // The raw numbers must actually wrap somewhere, or the test above proved
    // nothing about the 359 -> 1 crossing it claims to cover.
    expect(sawWrap).toBe(true);
  });

  it('makes a falling glass bring wind', () => {
    const field = weatherEvidenceField();
    const position = field.anchor.positionEcefM;
    const trends: number[] = [];
    const speeds: number[] = [];
    for (let t = 0; t <= 72 * 3600; t += 360) {
      const state = field.derive(t, position, BASE);
      trends.push(state.pressureTrendHpaPer3h);
      speeds.push(state.windSpeedMps);
    }
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const mt = mean(trends);
    const ms = mean(speeds);
    let cov = 0;
    let vt = 0;
    let vs = 0;
    for (let i = 0; i < trends.length; i++) {
      cov += (trends[i] - mt) * (speeds[i] - ms);
      vt += (trends[i] - mt) ** 2;
      vs += (speeds[i] - ms) ** 2;
    }
    expect(cov / Math.sqrt(vt * vs)).toBeLessThan(-0.3);
  });

  it('bounds the sky it derives across the whole reachable pressure range', () => {
    const field = weatherEvidenceField();
    for (let p = 955; p <= 1050; p += 1) {
      for (const trend of [-12, -6, -3, 0, 3, 12]) {
        const sky = field.deriveSky(p, trend);
        expect(sky.cloudCoverThreshold).toBeGreaterThanOrEqual(
          WEATHER_BOUNDS.cloudCoverThreshold.min,
        );
        expect(sky.cloudCoverThreshold).toBeLessThanOrEqual(
          WEATHER_BOUNDS.cloudCoverThreshold.max,
        );
        expect(sky.precipRateMmPerHour).toBeGreaterThanOrEqual(0);
        expect(sky.precipRateMmPerHour).toBeLessThanOrEqual(
          WEATHER_BOUNDS.precipRateMmPerHour.max,
        );
        expect(sky.visibilityM).toBeGreaterThanOrEqual(WEATHER_BOUNDS.visibilityM.min);
        expect(Number.isFinite(sky.cloudCeilingM)).toBe(true);
      }
    }
  });

  it('is dry and clear in a settled high', () => {
    const field = weatherEvidenceField();
    const sky = field.deriveSky(1030, 1);
    expect(sky.precipRateMmPerHour).toBe(0);
    expect(sky.visibilityM).toBe(9000);
    expect(sky.cloudCoverThreshold).toBe(0.7);
    expect(sky.cloudType).toBe('fair');
  });

  it('rains and closes in when the glass is low and falling', () => {
    const field = weatherEvidenceField();
    const sky = field.deriveSky(985, -6);
    expect(sky.precipRateMmPerHour).toBeGreaterThan(5);
    expect(sky.visibilityM).toBeLessThan(6000);
    expect(sky.cloudCoverThreshold).toBeLessThan(0.4);
    expect(sky.cloudType).toBe('overcast');
  });
});

// ---------------------------------------------------------------------------
// The clock and the system.
// ---------------------------------------------------------------------------

describe('the weather system', () => {
  it('advances on world seconds, at the rate it is given', () => {
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, baseWind: { ...BASE } });
    expect(weather.elapsedSeconds).toBe(0);

    world.state.worldInstantUtcSeconds += 3600;
    weather.advance();
    expect(weather.elapsedSeconds).toBeCloseTo(3600, 9);

    weather.setRate(4);
    world.state.worldInstantUtcSeconds += 100;
    weather.advance();
    expect(weather.elapsedSeconds).toBeCloseTo(4000, 9);
  });

  it('does not restate the calendar 30x — it consumes world seconds', () => {
    // The stale-doc trap this round was warned about: WORLD_MODEL.md said 72x
    // for months. A weather clock that copied a number would have copied that
    // one. At rate 1 an hour of world time is an hour of weather.
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, baseWind: { ...BASE } });
    world.state.worldInstantUtcSeconds += 12 * 3600;
    weather.advance();
    expect(weather.elapsedSeconds).toBe(12 * 3600);
  });

  it('freezes when the rate is zero and never runs backwards past zero', () => {
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, rate: 0, baseWind: { ...BASE } });
    world.state.worldInstantUtcSeconds += 50_000;
    weather.advance();
    expect(weather.elapsedSeconds).toBe(0);

    weather.setRate(1);
    world.state.worldInstantUtcSeconds -= 99_999;
    weather.advance();
    expect(weather.elapsedSeconds).toBe(0);
  });

  it('rejects a nonsense rate', () => {
    const weather = new WeatherSystem({ world: fakeWorld(), baseWind: { ...BASE } });
    expect(() => weather.setRate(Number.NaN)).toThrow(RangeError);
    expect(() => weather.setRate(-1)).toThrow(RangeError);
  });

  it('switches between live and neutral without touching the clock', () => {
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, baseWind: { ...BASE } });
    world.state.worldInstantUtcSeconds += 40 * 3600;
    weather.advance();
    const elapsed = weather.elapsedSeconds;

    weather.setSource('neutral');
    expect(weather.elapsedSeconds).toBe(elapsed);
    expect(Object.is(weather.wind.speedMps, BASE.speedMps)).toBe(true);

    weather.setSource('live');
    expect(weather.elapsedSeconds).toBe(elapsed);
    expect(weather.wind.speedMps).not.toBe(BASE.speedMps);
  });

  it('adopts a newly declared wind exactly, live or neutral', () => {
    // The ocean laboratory must keep working. WX1 got this for free by reading
    // the sea's wind every frame; WX2 cut that read, so a preset button or a
    // wind slider now says so explicitly through `recalibrateTo` — and the
    // declared wind has to come back out as its own floats, not as a round trip
    // through hypot and atan2.
    for (const source of ['neutral', 'live'] as const) {
      const weather = new WeatherSystem({
        world: fakeWorld(),
        source,
        baseWind: { ...BASE },
      });
      weather.setElapsedSeconds(9 * 3600);
      weather.recalibrateTo(14, 300, 0.6);
      expect(weather.wind.speedMps).toBe(14);
      expect(weather.wind.directionDeg).toBe(300);
      expect(weather.wind.gustiness).toBe(0.6);
    }
  });

  it('goes on departing from a re-declared wind', () => {
    const weather = new WeatherSystem({
      world: fakeWorld(),
      source: 'live',
      baseWind: { ...BASE },
    });
    weather.setElapsedSeconds(4 * 3600);
    weather.recalibrateTo(9, 210, 0.4);
    expect(weather.wind.speedMps).toBe(9);
    // Six more world hours and the field has moved on from the new zero.
    weather.setElapsedSeconds(10 * 3600);
    expect(weather.wind.speedMps).not.toBe(9);
    expect(Number.isFinite(weather.wind.speedMps)).toBe(true);
  });

  it('hands out clones, never the retained record', () => {
    const weather = new WeatherSystem({ world: fakeWorld(), baseWind: { ...BASE } });
    const snapshot = weather.snapshot();
    expect(snapshot).not.toBe(weather.state);
    expect(snapshot).toEqual(weather.state);
  });

  it('never hands WorldWind a value it would reject', () => {
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, baseWind: { ...BASE } });
    const worldWind = new WorldWind();
    for (let hour = 0; hour <= 200; hour += 0.5) {
      world.state.worldInstantUtcSeconds = OPENING_UTC_SECONDS + hour * 3600;
      weather.advance();
      expect(() =>
        worldWind.setMean(
          weather.wind.speedMps,
          weather.wind.directionDeg,
          weather.wind.gustiness,
        ),
      ).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// The barometer, and the gate that it is the same number as the series.
// ---------------------------------------------------------------------------

describe('the barometer', () => {
  it('reads exactly the series value at the same instant', () => {
    const world = fakeWorld();
    const weather = new WeatherSystem({ world, baseWind: weatherEvidenceBaseWind() });
    for (let hour = 0; hour <= 72; hour += 1) {
      world.state.worldInstantUtcSeconds = OPENING_UTC_SECONDS + hour * 3600;
      weather.advance();
      const glass = weather.barometer;
      expect(glass.pressureHpa).toBe(weather.state.pressureHpa);
      expect(glass.inchesOfMercury).toBe(
        weather.state.pressureHpa / HPA_PER_INCH_OF_MERCURY,
      );
      expect(glass.trendHpaPer3h).toBe(weather.state.pressureTrendHpaPer3h);
      expect(glass.tendency).toBe(glassTendency(weather.state.pressureTrendHpaPer3h));
    }
  });

  it('matches the committed trace sample for sample', () => {
    const evidence = buildWeatherEvidence();
    for (const sample of evidence.trace) {
      const reading = barometerReadingOf({
        ...neutralWeatherState(BASE),
        pressureHpa: sample.pressureHpa,
        pressureTrendHpaPer3h: sample.pressureTrendHpaPer3h,
      });
      expect(reading.inchesOfMercury).toBeCloseTo(sample.inchesOfMercury, 5);
      expect(reading.tendency).toBe(sample.tendency);
    }
  });
});

// ---------------------------------------------------------------------------
// The committed evidence. `WorldWindEvidence`'s idiom exactly: recompute from
// scratch and require exact equality, so the record cannot drift from the code.
// ---------------------------------------------------------------------------

describe('the committed weather series', () => {
  const committed = JSON.parse(
    readFileSync('evidence/weather/series-baseline.json', 'utf8'),
  );

  it('is reproduced exactly by rebuilding it', () => {
    expect(buildWeatherEvidence()).toEqual(committed);
  });

  it('passes every physical gate', () => {
    validateWeatherEvidence(buildWeatherEvidence());
    validateWeatherEvidence(committed);
  });

  it('covers seventy-two world hours', () => {
    expect(committed.contract.durationWorldHours).toBe(72);
    expect(committed.trace.at(-1).worldHours).toBe(72);
  });

  it('records the neutral-state proof rather than describing it', () => {
    expect(committed.anchor.derivedWindMatchesBaseExactly).toBe(true);
    expect(committed.anchor.neutralWindMatchesBaseExactly).toBe(true);
    expect(committed.anchor.baseWind.speedMps).toBe(6.0);
    expect(committed.anchor.baseWind.directionDeg).toBe(144);
  });
});
