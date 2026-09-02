import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import type { DevPanel } from '../ui/DevTools';
import {
  WEATHER_RATE_RANGE,
  type WeatherSource,
  type WeatherSystem,
} from '../weather/WeatherSystem';
import { WEATHER_BOUNDS, compassDeltaDeg } from '../weather/WeatherState';
import type { SeaCouplingControl } from '../ocean/WindSeaMemory';
import type { WeatherPresentation } from '../weather/WeatherPresentation';

const SLIDER_STEPS = 1000;

/**
 * The glass, authored review conditions, and their read-only presentation.
 *
 * **Condition** includes the round's A/B and regression guard — house rule 8,
 * no toggle no merge. `neutral` hands the sea state's own wind straight through
 * with no arithmetic; `live` runs the generator; clear/rain/storm are authored
 * review records that still travel through the same WeatherState → WorldWind
 * path as live weather.
 *
 * **Rate** multiplies the weather clock, which is otherwise the astronomical
 * calendar's own 30× (decision D1). It is the escape hatch that decision was
 * taken with: at 20× a three-day frontal passage is seven real minutes, which
 * is how you look at weather without living through it.
 *
 * **Coupling** is decision D5, added by WX2: coupled in play, `Independent` in
 * the laboratory. Coupled, the wind-sea target is driven from the present wind
 * through `SeaStateController`'s own transition over a sea-like duration, so
 * the water gets windy before it gets big and stays up after the wind drops.
 * Independent, weather still owns the wind and the sea is left exactly where
 * the ocean laboratory put it, which is how a rough sea under a light air gets
 * built.
 *
 * The readout deliberately shows three winds, not two: the wind now, the wind
 * this sea was grown by, and the sea state's own record. Those diverging is the
 * entire deliverable of these two rounds — before WX1 they were one number and
 * could not be.
 */
export class WeatherPanel implements DevPanel {
  readonly element: HTMLDivElement;

  private readonly controls: ControlGroup;
  private readonly readout: HTMLPreElement;
  private mirroredSource: WeatherSource;

  constructor(
    private readonly weather: WeatherSystem,
    private readonly seaWind: () => {
      speedMps: number;
      directionDeg: number;
      gustiness: number;
    },
    private readonly coupling?: SeaCouplingControl,
    private readonly presentation?: WeatherPresentation,
  ) {
    ensurePanelStyle();
    this.mirroredSource = weather.source;

    this.element = document.createElement('div');
    this.element.className = 'devpanel';

    const heading = document.createElement('h2');
    heading.textContent = 'Weather · condition and glass';
    this.element.appendChild(heading);

    this.controls = new ControlGroup(this.element);
    this.controls.section('source');

    this.controls.select(
      'Condition',
      [
        { value: 'live', label: 'Live — generated voyage' },
        { value: 'clear', label: 'Clear — settled high' },
        { value: 'rain', label: 'Rain — low and falling' },
        { value: 'storm', label: 'Storm — electrical squall' },
        { value: 'neutral', label: 'Off — neutral baseline' },
      ],
      weather.source,
      (value) => {
        this.weather.setSource(value as WeatherSource);
        this.mirrorUrl();
      },
      () => this.weather.source,
    );

    this.controls.section("cat's-paws");
    this.controls.slider({
      label: 'Gust excess',
      min: WEATHER_BOUNDS.gustExcessMps.min,
      max: WEATHER_BOUNDS.gustExcessMps.max,
      step: 0.1,
      value: weather.state.gustExcessMps,
      format: (value) => `${value.toFixed(1)} m/s`,
      onChange: (gustExcessMps) => this.setGustField({ gustExcessMps }),
      read: () => this.weather.state.gustExcessMps,
    });
    this.controls.slider({
      label: 'Patch size',
      min: WEATHER_BOUNDS.gustPatchMetres.min,
      max: WEATHER_BOUNDS.gustPatchMetres.max,
      step: 1,
      value: weather.state.gustPatchMetres,
      format: (value) => `${value.toFixed(0)} m`,
      onChange: (gustPatchMetres) => this.setGustField({ gustPatchMetres }),
      read: () => this.weather.state.gustPatchMetres,
    });
    this.controls.slider({
      label: 'Patch passage',
      min: WEATHER_BOUNDS.gustPeriodSeconds.min,
      max: WEATHER_BOUNDS.gustPeriodSeconds.max,
      step: 1,
      value: weather.state.gustPeriodSeconds,
      format: (value) => `${value.toFixed(0)} s`,
      onChange: (gustPeriodSeconds) => this.setGustField({ gustPeriodSeconds }),
      read: () => this.weather.state.gustPeriodSeconds,
    });

    if (this.coupling) {
      const coupling = this.coupling;
      this.controls.section('the sea');
      this.controls.select(
        'Coupling',
        [
          { value: 'follow', label: 'Follow weather — the sea remembers' },
          { value: 'independent', label: 'Independent — the lab sets the sea' },
        ],
        coupling.coupled ? 'follow' : 'independent',
        (value) => coupling.setCoupled(value === 'follow'),
        () => (coupling.coupled ? 'follow' : 'independent'),
      );
    }

    if (this.presentation) {
      const presentation = this.presentation;
      this.controls.section('presentation');
      this.controls.checkbox(
        'Near rain',
        presentation.rainEnabled,
        (enabled) => presentation.setRainEnabled(enabled),
        () => presentation.rainEnabled,
      );
      this.controls.checkbox(
        'Lightning + delayed thunder',
        presentation.lightningEnabled,
        (enabled) => presentation.setLightningEnabled(enabled),
        () => presentation.lightningEnabled,
      );
      this.controls.checkbox(
        'In-world WorldWind vector',
        presentation.windCueVisible,
        (visible) => presentation.setWindCueVisible(visible),
        () => presentation.windCueVisible,
      );
      this.controls.buttons([
        {
          label: 'Trigger review strike',
          title: 'Deterministic bolt with distance-delayed thunder',
          onClick: () => presentation.triggerLightning(),
        },
      ]);
    }

    this.controls.section('weather clock');

    this.controls.slider({
      label: 'Rate',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: toLogSlider(weather.rate),
      format: (value) => `${fromLogSlider(value).toFixed(2)}× calendar`,
      onChange: (value) => {
        this.weather.setRate(fromLogSlider(value));
        this.mirrorUrl();
      },
      read: () => toLogSlider(this.weather.rate),
    });

    this.readout = this.controls.readout();
    this.update();
  }

  update(): void {
    // Ocean-panel preset choices can intentionally exit an authored weather
    // condition through `recalibrateTo`; keep a reload honest about that
    // external source change as well as changes made in this panel.
    if (this.weather.source !== this.mirroredSource) this.mirrorUrl();
    this.controls.sync();
    const state = this.weather.state;
    const glass = this.weather.barometer;
    const sea = this.seaWind();
    // Measured against the MEMORY where there is one, not against the sea's
    // driving wind: those two are the same number whenever the wind is
    // freshening, because the wind now IS what is working on the water. The gap
    // that says something is the one between the wind and the sea it has
    // actually managed to build.
    const reference = this.coupling?.developedWind ?? sea;
    const gap = state.windSpeedMps - reference.speedMps;
    const veer = compassDeltaDeg(reference.directionDeg, state.windDirectionDeg);
    const hours = state.weatherElapsedSeconds / 3600;

    this.readout.textContent = [
      `Glass         ${glass.pressureHpa.toFixed(1)} hPa  ` +
        `(${glass.inchesOfMercury.toFixed(2)} inHg)`,
      `Tendency      ${glass.trendHpaPer3h >= 0 ? '+' : ''}` +
        `${glass.trendHpaPer3h.toFixed(2)} hPa/3h — ${glass.tendency}`,
      '',
      `Wind now      ${state.windSpeedMps.toFixed(2)} m/s ` +
        `toward ${state.windDirectionDeg.toFixed(1)}°`,
      `Cat's-paws    ±${state.gustExcessMps.toFixed(1)} m/s, ` +
        `${state.gustPatchMetres.toFixed(0)} m / ${state.gustPeriodSeconds.toFixed(0)} s`,
      `Sea driven by ${sea.speedMps.toFixed(2)} m/s ` +
        `toward ${sea.directionDeg.toFixed(1)}°`,
      ...(this.coupling
        ? [
            `Sea grown by  ${this.coupling.developedWind.speedMps.toFixed(2)} m/s ` +
              `toward ${this.coupling.developedWind.directionDeg.toFixed(1)}° ` +
              `(${this.coupling.coupled ? 'following' : 'independent'})`,
          ]
        : []),
      `Ahead of sea  ${gap >= 0 ? '+' : ''}${gap.toFixed(2)} m/s, ` +
        `${veer >= 0 ? 'veered' : 'backed'} ${Math.abs(veer).toFixed(1)}°`,
      '',
      `Sky           cover thr ${state.cloudCoverThreshold.toFixed(3)}, ` +
        `${state.cloudType}, ceiling ${state.cloudCeilingM.toFixed(0)} m`,
      `Rain          ${state.precipRateMmPerHour.toFixed(2)} mm/h, ` +
        `visibility ${(state.visibilityM / 1000).toFixed(1)} km`,
      `Electrical    ${(state.electricalActivity * 100).toFixed(0)}%`,
      ...(this.presentation
        ? (() => {
            const reading = this.presentation!.reading;
            return [
              `Rain draw      ${reading.activeRainDrops} streaks ` +
                `(${reading.rainEnabled ? 'on' : 'off'})`,
              `WorldWind cue  ${reading.windSpeedMps.toFixed(2)} m/s toward ` +
                `${reading.windDirectionTowardDeg.toFixed(1)}° ` +
                `(${reading.windCueVisible ? 'shown' : 'hidden'})`,
              `Storm events   flash ${reading.lastFlashId ?? '—'}, thunder ` +
                `${reading.lastThunderId ?? '—'}, ${reading.pendingThunder} pending`,
            ];
          })()
        : []),
      '',
      `Weather clock ${hours.toFixed(2)} world hours since the glass was set`,
      `Anchor glass  ${this.weather.field.anchorPressureHpa.toFixed(1)} hPa`,
      '',
      'Cover threshold, visibility, near rain, lightning/thunder and the',
      'optional world wind vector are live. Cloud type/ceiling and far rain remain staged.',
    ].join('\n');
  }

  dispose(): void {}

  private setGustField(
    patch: Partial<{
      gustExcessMps: number;
      gustPatchMetres: number;
      gustPeriodSeconds: number;
    }>,
  ): void {
    const state = this.weather.state;
    this.weather.setGustFieldControls({
      gustExcessMps: patch.gustExcessMps ?? state.gustExcessMps,
      gustPatchMetres: patch.gustPatchMetres ?? state.gustPatchMetres,
      gustPeriodSeconds: patch.gustPeriodSeconds ?? state.gustPeriodSeconds,
    });
  }

  private mirrorUrl(): void {
    const url = new URL(window.location.href);
    if (this.weather.source === 'neutral') {
      url.searchParams.set('weather', 'off');
    } else if (
      this.weather.source === 'clear' ||
      this.weather.source === 'rain' ||
      this.weather.source === 'storm'
    ) {
      url.searchParams.set('weather', this.weather.source);
    } else {
      url.searchParams.set(
        'weather',
        Number(this.weather.rate.toFixed(2)).toString(),
      );
    }
    window.history.replaceState(window.history.state, '', url);
    this.mirroredSource = this.weather.source;
  }
}

export function createWeatherPanel(
  weather: WeatherSystem,
  seaWind: () => { speedMps: number; directionDeg: number; gustiness: number },
  coupling?: SeaCouplingControl,
  presentation?: WeatherPresentation,
): WeatherPanel {
  return new WeatherPanel(weather, seaWind, coupling, presentation);
}

function toLogSlider(value: number): number {
  const { min, max } = WEATHER_RATE_RANGE;
  const clamped = Math.min(max, Math.max(min, value));
  return (Math.log(clamped / min) / Math.log(max / min)) * SLIDER_STEPS;
}

function fromLogSlider(value: number): number {
  const { min, max } = WEATHER_RATE_RANGE;
  const t = Math.min(1, Math.max(0, value / SLIDER_STEPS));
  return min * Math.pow(max / min, t);
}
