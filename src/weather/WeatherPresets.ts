import type { WeatherBaseWind } from './WeatherField';
import {
  assertWeatherStateWithinBounds,
  wrapCompassDeg,
  type WeatherState,
} from './WeatherState';

/** Authored review conditions. `live` remains the voyage's generated weather. */
export const WEATHER_PRESET_NAMES = ['clear', 'rain', 'storm'] as const;
export type WeatherPresetName = (typeof WEATHER_PRESET_NAMES)[number];

interface WeatherPresetTemplate {
  readonly pressureHpa: number;
  readonly pressureTrendHpaPer3h: number;
  readonly windSpeedMps: number;
  readonly windDirectionOffsetDeg: number;
  readonly gustiness: number;
  readonly gustExcessMps: number;
  readonly gustPatchMetres: number;
  readonly gustPeriodSeconds: number;
  readonly cloudCoverThreshold: number;
  readonly cloudType: WeatherState['cloudType'];
  readonly cloudCeilingM: number;
  readonly precipRateMmPerHour: number;
  readonly visibilityM: number;
  readonly electricalActivity: number;
}

/**
 * Coherent, bounded conditions rather than independent effect switches.
 *
 * Direction is relative to the voyage's prevailing wind so choosing a review
 * condition does not silently replace the geographical frame. Every value is
 * still published through `WeatherState`; the runtime then hands that wind to
 * `WorldWind`, which remains the sole instantaneous wind authority.
 */
export const WEATHER_PRESETS: Readonly<Record<WeatherPresetName, WeatherPresetTemplate>> =
  Object.freeze({
    clear: Object.freeze({
      pressureHpa: 1026,
      pressureTrendHpaPer3h: 0.6,
      windSpeedMps: 4.5,
      windDirectionOffsetDeg: 0,
      gustiness: 0.15,
      gustExcessMps: 0.3,
      gustPatchMetres: 180,
      gustPeriodSeconds: 80,
      cloudCoverThreshold: 0.82,
      cloudType: 'fair',
      cloudCeilingM: 1450,
      precipRateMmPerHour: 0,
      visibilityM: 15_000,
      electricalActivity: 0,
    }),
    rain: Object.freeze({
      pressureHpa: 995,
      pressureTrendHpaPer3h: -2.4,
      windSpeedMps: 10,
      windDirectionOffsetDeg: 18,
      gustiness: 0.55,
      gustExcessMps: 2.2,
      gustPatchMetres: 90,
      gustPeriodSeconds: 30,
      cloudCoverThreshold: 0.36,
      cloudType: 'overcast',
      cloudCeilingM: 700,
      precipRateMmPerHour: 12,
      visibilityM: 3500,
      electricalActivity: 0,
    }),
    storm: Object.freeze({
      pressureHpa: 975,
      pressureTrendHpaPer3h: -6.5,
      windSpeedMps: 18,
      windDirectionOffsetDeg: 38,
      gustiness: 0.9,
      gustExcessMps: 6.5,
      gustPatchMetres: 60,
      gustPeriodSeconds: 18,
      cloudCoverThreshold: 0.24,
      cloudType: 'overcast',
      cloudCeilingM: 450,
      precipRateMmPerHour: 32,
      visibilityM: 900,
      electricalActivity: 0.95,
    }),
  });

export function isWeatherPresetName(value: string): value is WeatherPresetName {
  return (WEATHER_PRESET_NAMES as readonly string[]).includes(value);
}

/** Build a fresh record so callers can retain snapshots without shared state. */
export function weatherPresetState(
  name: WeatherPresetName,
  baseWind: Readonly<WeatherBaseWind>,
  weatherElapsedSeconds = 0,
): WeatherState {
  const preset = WEATHER_PRESETS[name];
  const state: WeatherState = {
    weatherElapsedSeconds,
    pressureHpa: preset.pressureHpa,
    pressureTrendHpaPer3h: preset.pressureTrendHpaPer3h,
    windSpeedMps: preset.windSpeedMps,
    windDirectionDeg: wrapCompassDeg(
      baseWind.directionDeg + preset.windDirectionOffsetDeg,
    ),
    gustiness: preset.gustiness,
    gustExcessMps: preset.gustExcessMps,
    gustPatchMetres: preset.gustPatchMetres,
    gustPeriodSeconds: preset.gustPeriodSeconds,
    cloudCoverThreshold: preset.cloudCoverThreshold,
    cloudType: preset.cloudType,
    cloudCeilingM: preset.cloudCeilingM,
    precipRateMmPerHour: preset.precipRateMmPerHour,
    visibilityM: preset.visibilityM,
    electricalActivity: preset.electricalActivity,
  };
  assertWeatherStateWithinBounds(state, `weather preset ${name}`);
  return state;
}
