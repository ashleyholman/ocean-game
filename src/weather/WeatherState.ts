/**
 * `WeatherState` — the one weather record, upstream of everything.
 *
 * Read `docs/weather/WEATHER_CONCEPT.md` §4 before changing anything here. The
 * short version: until this file existed the project had exactly one wind
 * number and it belonged to the sea state, so "the wind has freshened but the
 * sea has not built yet" was inexpressible. This record is the *present*
 * weather; `SeaState.wind` remains the wind that grew this sea. WX1 separates
 * the names; WX2 gives the sea its memory.
 *
 * UNITS AND SIGN CONVENTIONS — read before touching any number
 * ------------------------------------------------------------
 * - `pressureHpa` is hectopascals, identical to the millibar a period glass is
 *   graduated in. Standard sea-level pressure is 1013.25 hPa. The captain's
 *   instrument shows inches of mercury because a 1770s marine barometer is a
 *   mercury column; `inchesOfMercuryFromHpa` is the only conversion and it is
 *   pinned by test.
 * - `pressureTrendHpaPer3h` is the *analytic* rate of change of the pressure
 *   at this position, expressed over the three hours a synoptic tendency is
 *   conventionally quoted over. **Negative is a falling glass**, which is the
 *   deteriorating direction. This sign is the convention trap this round was
 *   warned about; `tests/weather.test.ts` pins it in both directions.
 * - `windDirectionDeg` is the compass heading the wind blows **toward**,
 *   degrees clockwise from north — identical to `WorldWind` (`WorldWind.ts:12`)
 *   and to every sea-state direction. The bearing a sailor *names* a wind by is
 *   `windDirectionDeg + 180`.
 * - `cloudCoverThreshold` matches `uCloudCover`'s existing semantics: it is a
 *   *mean threshold* on the cloud weather map, not a coverage fraction, and it
 *   runs the other way round — a lower threshold means more cloud. Today's
 *   production value is 0.70 (`src/scene/SkySystem.ts`). The weather
 *   presentation publishes it into that existing uniform/cache seam.
 *
 * WHAT IS AND IS NOT WIRED IN WX1
 * -------------------------------
 * `windSpeedMps`, `windDirectionDeg` and `gustiness` reach the instantaneous
 * `WorldWind` seam. WX3's spatial field separately consumes the physical gust
 * excess, patch size and passage time below for ocean presentation only. Sky,
 * precipitation, visibility and electrical activity have their established
 * read-only presentation consumers. Cloud type/ceiling remain staged. The
 * neutral-state claim is unchanged: every newly visible consumer has an exact
 * zero path.
 */

/** Standard sea-level pressure, hPa. The neutral state's reading. */
export const STANDARD_PRESSURE_HPA = 1013.25;

/** One inch of mercury at 0 °C and standard gravity, in hPa. */
export const HPA_PER_INCH_OF_MERCURY = 33.863886;

/** Convert a pressure in hPa to the inches a period marine glass reads. */
export function inchesOfMercuryFromHpa(pressureHpa: number): number {
  return pressureHpa / HPA_PER_INCH_OF_MERCURY;
}

/** Convert a barometer's inches of mercury back to hPa. */
export function hpaFromInchesOfMercury(inches: number): number {
  return inches * HPA_PER_INCH_OF_MERCURY;
}

/**
 * The word a mariner puts on the tendency. Thresholds are the Beaufort-era
 * ones a ship's log uses: 1 hPa in three hours is a change worth writing down,
 * 3 is a gale warning in itself.
 */
export type GlassTendency =
  | 'falling rapidly'
  | 'falling'
  | 'falling slowly'
  | 'steady'
  | 'rising slowly'
  | 'rising'
  | 'rising rapidly';

export function glassTendency(trendHpaPer3h: number): GlassTendency {
  if (trendHpaPer3h <= -3) return 'falling rapidly';
  if (trendHpaPer3h <= -1.5) return 'falling';
  if (trendHpaPer3h <= -0.3) return 'falling slowly';
  if (trendHpaPer3h < 0.3) return 'steady';
  if (trendHpaPer3h < 1.5) return 'rising slowly';
  if (trendHpaPer3h < 3) return 'rising';
  return 'rising rapidly';
}

/**
 * Cloud character. One deck exists (`CLOUD_MARCH = 192` cumulus); these are the
 * type channel `CLOUD_STRUCTURE_HANDOVER.md` specifies and WX4 will consume.
 * Naming them now costs nothing and keeps the record honest about intent.
 */
export type WeatherCloudType = 'fair' | 'cumulus' | 'stratocumulus' | 'overcast';

export interface WeatherState {
  /** Weather seconds elapsed since the glass was set. Pure input, echoed back. */
  readonly weatherElapsedSeconds: number;

  /** hPa. Standard is 1013.25. */
  readonly pressureHpa: number;
  /** hPa per three hours. Negative is a falling glass. */
  readonly pressureTrendHpaPer3h: number;

  /** m/s, ten-metre mean wind. */
  readonly windSpeedMps: number;
  /** Compass degrees the wind blows toward, in [0, 360). */
  readonly windDirectionDeg: number;
  /** 0–1, the excursion scale `WorldWind` already takes. */
  readonly gustiness: number;

  /** m/s — maximum signed departure of the spatial cat's-paw field. */
  readonly gustExcessMps: number;
  /** Metres — dominant cat's-paw patch size. */
  readonly gustPatchMetres: number;
  /** Seconds — time for the field to advect by one dominant patch. */
  readonly gustPeriodSeconds: number;

  /** `uCloudCover` semantics: a mean threshold, lower means more cloud. */
  readonly cloudCoverThreshold: number;
  readonly cloudType: WeatherCloudType;
  /** Metres above sea level. Today's deck base is 1100 m. */
  readonly cloudCeilingM: number;

  /** mm/h. Zero is dry; the near-rain presentation consumes this directly. */
  readonly precipRateMmPerHour: number;

  /** Metres — feeds `hazeDistanceM`, whose clear-air value is 9000 m. */
  readonly visibilityM: number;

  /** 0–1 admission probability for the seeded lightning schedule. */
  readonly electricalActivity: number;
}

/**
 * Documented finite bounds. Every generated field is clamped into these and the
 * committed evidence asserts the whole 72-hour trace stays inside them, so a
 * consumer added later can treat them as a contract rather than a hope.
 */
export const WEATHER_BOUNDS = Object.freeze({
  pressureHpa: Object.freeze({ min: 955, max: 1050 }),
  pressureTrendHpaPer3h: Object.freeze({ min: -12, max: 12 }),
  windSpeedMps: Object.freeze({ min: 0, max: 32 }),
  windDirectionDeg: Object.freeze({ min: 0, max: 360 }),
  gustiness: Object.freeze({ min: 0, max: 1 }),
  gustExcessMps: Object.freeze({ min: 0, max: 20 }),
  gustPatchMetres: Object.freeze({ min: 20, max: 600 }),
  gustPeriodSeconds: Object.freeze({ min: 4, max: 240 }),
  cloudCoverThreshold: Object.freeze({ min: 0.2, max: 0.95 }),
  cloudCeilingM: Object.freeze({ min: 300, max: 2400 }),
  precipRateMmPerHour: Object.freeze({ min: 0, max: 40 }),
  visibilityM: Object.freeze({ min: 400, max: 20000 }),
  electricalActivity: Object.freeze({ min: 0, max: 1 }),
});

/**
 * `windSpeedMps`'s ceiling is 32 on purpose: `WIND_VALIDITY_CEILING = 32` in
 * `src/ocean/spectrum.ts`, above which the whitecap and growth relations are
 * out of their fitted range. A weather round that raises this must read
 * `effectiveGrowthWind()` first.
 */
export const WEATHER_WIND_CEILING_SOURCE = 'src/ocean/spectrum.ts WIND_VALIDITY_CEILING';

export type WeatherBoundKey = keyof typeof WEATHER_BOUNDS;

export function clampToWeatherBound(key: WeatherBoundKey, value: number): number {
  const bound = WEATHER_BOUNDS[key];
  return Math.min(bound.max, Math.max(bound.min, value));
}

/** Wrap a compass bearing into [0, 360). */
export function wrapCompassDeg(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Shortest signed arc from `fromDeg` to `toDeg`, in (−180, 180]. */
export function compassDeltaDeg(fromDeg: number, toDeg: number): number {
  let delta = ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
  if (delta === -180) delta = 180;
  return delta;
}

/** Records are handed out cloned, never shared — §4 L0. */
export function cloneWeatherState(state: WeatherState): WeatherState {
  return { ...state };
}

/**
 * Throws on the first field outside its documented bound or non-finite.
 * Shared verbatim by the runtime, the tests and the evidence exporter so the
 * three cannot disagree about what "bounded" means.
 */
export function assertWeatherStateWithinBounds(
  state: WeatherState,
  context = 'weather state',
): void {
  const numeric: Array<[WeatherBoundKey, number]> = [
    ['pressureHpa', state.pressureHpa],
    ['pressureTrendHpaPer3h', state.pressureTrendHpaPer3h],
    ['windSpeedMps', state.windSpeedMps],
    ['windDirectionDeg', state.windDirectionDeg],
    ['gustiness', state.gustiness],
    ['gustExcessMps', state.gustExcessMps],
    ['gustPatchMetres', state.gustPatchMetres],
    ['gustPeriodSeconds', state.gustPeriodSeconds],
    ['cloudCoverThreshold', state.cloudCoverThreshold],
    ['cloudCeilingM', state.cloudCeilingM],
    ['precipRateMmPerHour', state.precipRateMmPerHour],
    ['visibilityM', state.visibilityM],
    ['electricalActivity', state.electricalActivity],
  ];
  if (!Number.isFinite(state.weatherElapsedSeconds)) {
    throw new RangeError(`${context}: weatherElapsedSeconds is not finite`);
  }
  for (const [key, value] of numeric) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${context}: ${key} is not finite (${value})`);
    }
    const bound = WEATHER_BOUNDS[key];
    if (value < bound.min || value > bound.max) {
      throw new RangeError(
        `${context}: ${key} = ${value} is outside [${bound.min}, ${bound.max}]`,
      );
    }
  }
  // The direction bound is half-open; 360 must have wrapped to 0.
  if (state.windDirectionDeg >= 360) {
    throw new RangeError(
      `${context}: windDirectionDeg = ${state.windDirectionDeg} must wrap into [0, 360)`,
    );
  }
}
