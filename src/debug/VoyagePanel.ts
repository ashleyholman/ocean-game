import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import type { DevPanel } from '../ui/DevTools';
import type { VoyageClockControl, VoyageClockMode } from '../world/voyageClock';
import {
  VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE,
  VOYAGE_RATE_RANGE,
} from '../world/voyageClock';

const SLIDER_STEPS = 1000;

/**
 * Live controls over the voyage clock — the instrument the timescale question
 * is settled with, not the answer to it.
 *
 * The verdict this panel exists to collect: does a landfall read as *sailing*
 * at honest 1×, and does the governed ramp read as "making good speed" or as
 * "the land is on rails"? Fixed mode is the honest baseline and the old 30×
 * for comparison; governed mode caps the nearest land's apparent bearing
 * drift at the slide budget, so compression buys sea-room only where no land
 * can witness it. The chosen mode and knobs mirror into the URL so a
 * convincing (or damning) configuration can be pasted straight into review.
 */
export class VoyagePanel implements DevPanel {
  readonly element: HTMLDivElement;

  private readonly controls: ControlGroup;
  private readonly readout: HTMLPreElement;

  constructor(private readonly voyage: VoyageClockControl) {
    ensurePanelStyle();

    this.element = document.createElement('div');
    this.element.className = 'devpanel';

    const heading = document.createElement('h2');
    heading.textContent = 'Voyage · clock & land slide';
    this.element.appendChild(heading);

    this.controls = new ControlGroup(this.element);
    this.controls.section('voyage-time compression');

    this.controls.select(
      'Mode',
      [
        { value: 'fixed', label: 'fixed rate' },
        { value: 'governed', label: 'governed by nearest land' },
      ],
      voyage.currentMode,
      (value) => {
        this.voyage.setMode(value as VoyageClockMode);
        this.mirrorUrl();
      },
      () => this.voyage.currentMode,
    );

    this.controls.slider({
      label: 'Fixed rate',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: toLogSlider(
        voyage.currentFixedRate,
        VOYAGE_RATE_RANGE.min,
        VOYAGE_RATE_RANGE.max,
      ),
      format: (value) =>
        `${fromLogSlider(
          value,
          VOYAGE_RATE_RANGE.min,
          VOYAGE_RATE_RANGE.max,
        ).toFixed(1)}×`,
      onChange: (value) => {
        this.voyage.setFixedRate(
          fromLogSlider(value, VOYAGE_RATE_RANGE.min, VOYAGE_RATE_RANGE.max),
        );
        this.mirrorUrl();
      },
      read: () =>
        toLogSlider(
          this.voyage.currentFixedRate,
          VOYAGE_RATE_RANGE.min,
          VOYAGE_RATE_RANGE.max,
        ),
    });

    this.controls.slider({
      label: 'Slide budget (governed)',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: toLogSlider(
        voyage.currentOmegaMaxDegPerS,
        VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.min,
        VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.max,
      ),
      format: (value) =>
        `${fromLogSlider(
          value,
          VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.min,
          VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.max,
        ).toFixed(2)}°/s`,
      onChange: (value) => {
        this.voyage.setOmegaMaxDegPerS(
          fromLogSlider(
            value,
            VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.min,
            VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.max,
          ),
        );
        this.mirrorUrl();
      },
      read: () =>
        toLogSlider(
          this.voyage.currentOmegaMaxDegPerS,
          VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.min,
          VOYAGE_OMEGA_MAX_DEG_PER_S_RANGE.max,
        ),
    });

    this.readout = this.controls.readout();
    this.update();
  }

  update(): void {
    this.controls.sync();
    const { nearestLandM, speedOverGroundMps } = this.voyage.sample;
    const slide = this.voyage.apparentSlideDegPerS();
    const knots = speedOverGroundMps * 1.94384;
    this.readout.textContent = [
      `Mode          ${this.voyage.currentMode}`,
      `Live rate     ${this.voyage.currentRate.toFixed(2)}× (target ${this.voyage
        .targetRate()
        .toFixed(2)}×)`,
      `Nearest land  ${
        nearestLandM === undefined
          ? 'none in world'
          : `${(nearestLandM / 1000).toFixed(2)} km`
      }`,
      `Speed         ${speedOverGroundMps.toFixed(2)} m/s (${knots.toFixed(1)} kn)`,
      `Land slide    ${slide === undefined ? '—' : `${slide.toFixed(3)}°/s apparent`}`,
      '',
      'A true 6 kn passage 5 km off shows ~0.04°/s.',
      'Governed mode compresses only what no land can see.',
    ].join('\n');
  }

  dispose(): void {}

  private mirrorUrl(): void {
    const url = new URL(window.location.href);
    if (this.voyage.currentMode === 'governed') {
      url.searchParams.set('voyage', 'governed');
    } else {
      url.searchParams.set(
        'voyage',
        Number(this.voyage.currentFixedRate.toFixed(1)).toString(),
      );
    }
    url.searchParams.set(
      'voyageOmega',
      Number(this.voyage.currentOmegaMaxDegPerS.toFixed(2)).toString(),
    );
    window.history.replaceState(window.history.state, '', url);
  }
}

export function createVoyagePanel(voyage: VoyageClockControl): VoyagePanel {
  return new VoyagePanel(voyage);
}

function toLogSlider(value: number, minimum: number, maximum: number): number {
  const clamped = Math.min(maximum, Math.max(minimum, value));
  return (
    (Math.log(clamped / minimum) / Math.log(maximum / minimum)) * SLIDER_STEPS
  );
}

function fromLogSlider(value: number, minimum: number, maximum: number): number {
  const t = Math.min(1, Math.max(0, value / SLIDER_STEPS));
  return minimum * Math.pow(maximum / minimum, t);
}
