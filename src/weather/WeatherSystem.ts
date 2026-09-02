/**
 * The weather provider, and the one place the scene reads it.
 *
 * Shape taken from `docs/world/WORLD_MODEL.md`'s named extension point —
 * `(positionEcefM, worldInstantUtcSeconds) → …` — rather than invented here.
 *
 * WHAT WX1 CHANGED, AND WHAT WX2 CHANGED AFTER IT
 * ------------------------------------------------
 * Before WX1 `WorldWind.meanSpeedMps` was identically `seaState.wind.speedMps`,
 * every frame, so "the wind now" and "the wind that grew this sea" were one
 * number and the difference between them could not be said. WX1 put the seam
 * here: `VesselRuntime` sets the world wind from this system's record.
 *
 * WX1 still took its *prevailing* wind from the sea state every frame, which
 * meant the sea remained the ultimate source. WX2 cut that. The prevailing
 * wind is now this object's own, adopted once at construction from the opening
 * sea and afterwards only on an explicit act — somebody pressing a preset
 * button or moving an ocean-lab slider, through `recalibrateTo`. Nothing reads
 * back from the sea, so `WindSeaMemory` can drive the sea from the wind
 * without the two forming a loop.
 *
 * `recalibrateTo` is how the laboratory keeps working. It declares "the wind
 * is *this*, now": the prevailing wind becomes the given one and the field's
 * departure is re-zeroed at the present instant, so the chosen wind blows
 * immediately, to the last bit, and the weather goes on departing from it.
 *
 * THE CLOCK — decision D1
 * -----------------------
 * Weather *state* runs on the astronomical calendar, which is 30× by default
 * (`src/world/clock.ts`, 48 real minutes per world day). The rate below is a
 * multiplier on top of that and lives on a dev slider; 1 is the shipped value,
 * so a twelve-hour frontal passage is twenty-four real minutes.
 *
 * The number 30 is deliberately not restated here. It is read from the world
 * clock by consuming world seconds. `docs/world/WORLD_MODEL.md` said 72× for a
 * long time and that stale figure is where the original weather specification
 * got its own wrong 72× from; a constant copied is a constant that rots.
 *
 * Two accepted consequences, both dev-visible: pausing the world clock pauses
 * the weather, and dragging the Sun across six hours drags the weather with it.
 * `SkySystem`'s `CLOUD_WALL_RATE` refuses exactly that for cloud *motion*, and
 * still does — advection stays on the wall clock. Only the state is on the
 * calendar. That split is D1's known cost.
 */

import type { Vec3d } from '../world/math';
import {
  WeatherField,
  WEATHER_DEFAULT_SEED,
  type WeatherBaseWind,
} from './WeatherField';
import {
  STANDARD_PRESSURE_HPA,
  WEATHER_BOUNDS,
  cloneWeatherState,
  glassTendency,
  inchesOfMercuryFromHpa,
  type GlassTendency,
  type WeatherState,
} from './WeatherState';
import {
  isWeatherPresetName,
  weatherPresetState,
  type WeatherPresetName,
} from './WeatherPresets';

/**
 * Where the record comes from.
 *
 * `neutral` is the lab's off switch and WX1's regression guard in one — house
 * rule 8, no toggle no merge. `live` is the generated voyage; clear/rain/storm
 * are bounded authored review conditions. In neutral the wind is the base
 * wind's own floats with no arithmetic done to them at all, and every other
 * field is the value the scene used before weather existed.
 */
export type WeatherSource = 'live' | 'neutral' | WeatherPresetName;

/** The dev rate slider's range. 1 is shipped: weather time is world time. */
export const WEATHER_RATE_RANGE = Object.freeze({ min: 0.1, max: 120 });

/** The clear-air values weather must reproduce exactly when it is neutral. */
export const NEUTRAL_SKY = Object.freeze({
  /** `src/scene/SkySystem.ts`'s production `uCloudCover`. */
  cloudCoverThreshold: 0.7,
  /** `CLOUD_BASE` in `src/scene/shaders/lib.ts`. */
  cloudCeilingM: 1100,
  /** `hazeDistanceM` in `src/scene/oceanOptics.ts`. */
  visibilityM: 9000,
  gustPatchMetres: 100,
  gustPeriodSeconds: 40,
});

/** The narrow wind shape `VesselRuntime.updateFrameNavigationAndWind` takes. */
export interface WeatherWind {
  readonly speedMps: number;
  readonly directionDeg: number;
  readonly gustiness: number;
}

/** What the captain's glass shows. One reading, derived in one place. */
export interface BarometerReading {
  readonly pressureHpa: number;
  readonly inchesOfMercury: number;
  readonly trendHpaPer3h: number;
  readonly tendency: GlassTendency;
}

/** Structurally what this system needs of `PlanetaryWorld`; no import cycle. */
export interface WeatherWorldSource {
  readonly state: {
    readonly worldInstantUtcSeconds: number;
    readonly positionEcefM: Readonly<Vec3d>;
  };
}

export interface WeatherSystemOptions {
  world: WeatherWorldSource;
  seed?: number;
  source?: WeatherSource;
  rate?: number;
  /**
   * The prevailing wind the departure is measured from — the opening sea's
   * generating wind, taken once. After construction only `recalibrateTo`
   * moves it.
   */
  baseWind: WeatherBaseWind;
}

export interface WeatherGustFieldControls {
  readonly gustExcessMps: number;
  readonly gustPatchMetres: number;
  readonly gustPeriodSeconds: number;
}

export class WeatherSystem {
  readonly field: WeatherField;

  private readonly world: WeatherWorldSource;
  private readonly base: WeatherBaseWind;
  private sourceValue: WeatherSource;
  private rateValue: number;
  private weatherElapsed = 0;
  private lastUtcSeconds: number;
  /**
   * The field wind the departure is measured from. `undefined` means the
   * voyage anchor, which is WX1's behaviour and the shipped default.
   */
  private calibration: { east: number; north: number } | undefined;
  /** Dev-lab override; selecting a coherent condition clears it. */
  private gustFieldOverride: WeatherGustFieldControls | undefined;
  private current: WeatherState;
  private readonly windView: { speedMps: number; directionDeg: number; gustiness: number };

  constructor(options: WeatherSystemOptions) {
    this.world = options.world;
    this.base = { ...options.baseWind };
    this.sourceValue = options.source ?? 'live';
    this.rateValue = options.rate ?? 1;
    this.lastUtcSeconds = options.world.state.worldInstantUtcSeconds;
    this.field = new WeatherField(
      options.world.state.positionEcefM,
      this.lastUtcSeconds,
      options.seed ?? WEATHER_DEFAULT_SEED,
    );
    this.current = this.produce();
    this.windView = {
      speedMps: this.current.windSpeedMps,
      directionDeg: this.current.windDirectionDeg,
      gustiness: this.current.gustiness,
    };
  }

  get source(): WeatherSource {
    return this.sourceValue;
  }

  setSource(source: WeatherSource): void {
    this.sourceValue = source;
    this.gustFieldOverride = undefined;
    this.refresh();
  }

  get rate(): number {
    return this.rateValue;
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new RangeError(`weather rate must be finite and >= 0, got ${rate}`);
    }
    this.rateValue = rate;
  }

  /** Weather seconds since the glass was set. */
  get elapsedSeconds(): number {
    return this.weatherElapsed;
  }

  /** Set the weather clock directly — the evidence harness and tests only. */
  setElapsedSeconds(weatherElapsedSeconds: number): void {
    if (!Number.isFinite(weatherElapsedSeconds) || weatherElapsedSeconds < 0) {
      throw new RangeError(
        `weather elapsed must be finite and >= 0, got ${weatherElapsedSeconds}`,
      );
    }
    this.weatherElapsed = weatherElapsedSeconds;
    this.refresh();
  }

  /** The prevailing wind the field's departure is added to. */
  get prevailingWind(): Readonly<WeatherBaseWind> {
    return this.base;
  }

  /**
   * Declare that the wind is *this*, right now.
   *
   * The prevailing wind becomes the given one and the departure is re-zeroed
   * against the field's own wind at this instant and place, so `wind` returns
   * the given floats exactly — the same bit-for-bit guard WX1 earned at the
   * voyage anchor, re-armed wherever it is called. Afterwards the weather
   * departs from the new value as it did from the old.
   *
   * The only callers are explicit human acts: a sea-state preset button, an
   * ocean-lab wind slider, the HUD's Ocean page. Nothing calls it per frame,
   * because a per-frame caller is exactly the feedback loop WX2 exists to cut.
   */
  recalibrateTo(speedMps: number, directionDeg: number, gustiness: number): void {
    // A sea-state choice is itself an explicit declaration of present wind.
    // Leave an authored weather review preset before honouring it; otherwise a
    // storm preset would silently win and `recalibrateTo` would cease to mean
    // what every Ocean-panel caller relies on. Neutral/live keep their existing
    // A/B semantics.
    if (isWeatherPresetName(this.sourceValue)) this.sourceValue = 'live';
    this.base.speedMps = speedMps;
    this.base.directionDeg = directionDeg;
    this.base.gustiness = gustiness;
    this.calibration = this.field.geostrophicWindAt(
      this.weatherElapsed,
      this.world.state.positionEcefM,
    );
    this.refresh();
  }

  /**
   * Advance to the world clock's present instant and re-derive.
   *
   * Reads the clock rather than taking a delta so that pausing, scrubbing and
   * the astronomy panel's rate all reach weather without a second accumulator
   * that could disagree with the first.
   */
  advance(): void {
    const utc = this.world.state.worldInstantUtcSeconds;
    const worldDelta = utc - this.lastUtcSeconds;
    this.lastUtcSeconds = utc;
    this.weatherElapsed = Math.max(0, this.weatherElapsed + worldDelta * this.rateValue);
    this.refresh();
  }

  /** The frame's weather. One retained object, as the frame sea state is. */
  get state(): Readonly<WeatherState> {
    return this.current;
  }

  /** A copy, for anything that wants to keep one. §4 L0: cloned, not shared. */
  snapshot(): WeatherState {
    return cloneWeatherState(this.current);
  }

  /** Exactly what goes into `WorldWind.setMean`. */
  get wind(): Readonly<WeatherWind> {
    return this.windView;
  }

  get barometer(): BarometerReading {
    return barometerReadingOf(this.current);
  }

  /**
   * Tune WX3 in physical units. This is a presentation-field override only;
   * the mean wind, temporal WorldWind gust, sea memory and wave state do not
   * move. A subsequent condition choice restores that condition's coherent
   * authored values.
   */
  setGustFieldControls(controls: Readonly<WeatherGustFieldControls>): void {
    assertGustFieldControl(
      controls.gustExcessMps,
      WEATHER_BOUNDS.gustExcessMps,
      'gust excess',
    );
    assertGustFieldControl(
      controls.gustPatchMetres,
      WEATHER_BOUNDS.gustPatchMetres,
      'gust patch size',
    );
    assertGustFieldControl(
      controls.gustPeriodSeconds,
      WEATHER_BOUNDS.gustPeriodSeconds,
      'gust passage time',
    );
    this.gustFieldOverride = { ...controls };
    this.refresh();
  }

  private refresh(): void {
    this.current = this.produce();
    this.windView.speedMps = this.current.windSpeedMps;
    this.windView.directionDeg = this.current.windDirectionDeg;
    this.windView.gustiness = this.current.gustiness;
  }

  private produce(): WeatherState {
    let state: WeatherState;
    if (this.sourceValue === 'neutral') {
      state = neutralWeatherState(this.base, this.weatherElapsed);
    } else if (isWeatherPresetName(this.sourceValue)) {
      state = weatherPresetState(
        this.sourceValue,
        this.base,
        this.weatherElapsed,
      );
    } else {
      state = this.field.derive(
        this.weatherElapsed,
        this.world.state.positionEcefM,
        this.base,
        this.calibration,
      );
    }
    return this.gustFieldOverride
      ? { ...state, ...this.gustFieldOverride }
      : state;
  }
}

function assertGustFieldControl(
  value: number,
  bound: Readonly<{ min: number; max: number }>,
  name: string,
): void {
  if (!Number.isFinite(value) || value < bound.min || value > bound.max) {
    throw new RangeError(
      `${name} must be finite and in [${bound.min}, ${bound.max}], got ${value}`,
    );
  }
}

/**
 * The state of the world before this round: standard pressure, a steady glass,
 * today's sky constants, and the base wind's own floats untouched.
 */
export function neutralWeatherState(
  base: Readonly<WeatherBaseWind>,
  weatherElapsedSeconds = 0,
): WeatherState {
  return {
    weatherElapsedSeconds,
    pressureHpa: STANDARD_PRESSURE_HPA,
    pressureTrendHpaPer3h: 0,
    windSpeedMps: base.speedMps,
    windDirectionDeg: base.directionDeg,
    gustiness: base.gustiness,
    // Zero selects WX3's exact legacy-pixel path in FoamField and makes the
    // new Ocean roughness/whitecap readers literal no-ops.
    gustExcessMps: 0,
    gustPatchMetres: NEUTRAL_SKY.gustPatchMetres,
    gustPeriodSeconds: NEUTRAL_SKY.gustPeriodSeconds,
    cloudCoverThreshold: NEUTRAL_SKY.cloudCoverThreshold,
    cloudType: 'cumulus',
    cloudCeilingM: NEUTRAL_SKY.cloudCeilingM,
    precipRateMmPerHour: 0,
    visibilityM: NEUTRAL_SKY.visibilityM,
    electricalActivity: 0,
  };
}

/**
 * The glass, from the record. The instrument in the cabin and the evidence
 * exporter call this same function, so "what the barometer reads" and "what the
 * series says" cannot be two different numbers.
 */
export function barometerReadingOf(state: Readonly<WeatherState>): BarometerReading {
  return {
    pressureHpa: state.pressureHpa,
    inchesOfMercury: inchesOfMercuryFromHpa(state.pressureHpa),
    trendHpaPer3h: state.pressureTrendHpaPer3h,
    tendency: glassTendency(state.pressureTrendHpaPer3h),
  };
}
