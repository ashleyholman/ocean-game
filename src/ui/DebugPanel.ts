import type {
  AstronomyFrame,
  AstronomyProvider,
} from '../astronomy/AstronomyProvider';
import {
  daysInUtcYear,
} from '../astronomy/AstronomyProvider';
import type { WaveField } from '../scene/Waves';
import type { VesselMotionDebugControls } from '../vessel/VesselMotion';
import type { PlanetaryWorld } from '../world/PlanetaryWorld';
import {
  createNavigationTelemetry,
  deriveNavigationTelemetry,
} from '../world/navigation';
import {
  formatWaterAwareOpeningDiagnostic,
  formatWaterAwareTeleportNotice,
  type WaterAwareOpeningSuccess,
} from '../terrain/WaterAwareOpeningResolver';
import {
  resolveGlobalTerrainTeleport,
} from '../terrain/globalTerrainTeleportRuntime';
import { DeveloperGlobe } from './DeveloperGlobe';

const RAD_TO_DEG = 180 / Math.PI;

interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  /** Pointer/key release after the last live `input` update. */
  onCommit?: (value: number) => void;
  read?: () => number;
}

interface SliderHandle {
  input: HTMLInputElement;
  render(value: number): void;
}

export interface DebugState {
  exposureBias: number;
}

/** Instantaneous world-wind state, prepared per frame by the simulation. */
export interface WorldWindTelemetry {
  meanSpeedMps: number;
  meanDirectionTowardDeg: number;
  gustiness: number;
  instantaneousSpeedMps: number;
  gustDirectionOffsetDeg: number;
  apparentSpeedMps: number;
  /** Null when no vessel yaw exists or the apparent wind is calm. */
  apparentAngleOffBowDeg: number | null;
  pointOfSail: string | null;
}

/** One sail's line in the force readout. */
export interface SailLineTelemetry {
  name: string;
  state: string;
  aoaDeg: number;
  luffing: boolean;
  forceN: number;
}

/** Per-frame sail-force state (S2), prepared by the simulation. */
export interface SailForceTelemetry {
  /** Model-axis totals: +forward drive, +x side force (to port), heel/yaw torques. */
  driveForwardN: number;
  sideForceN: number;
  heelTorqueNm: number;
  yawMomentNm: number;
  perSail: readonly SailLineTelemetry[];
}

/** Live values the readout needs that are not reachable from the world model. */
export interface WorldPanelTelemetry {
  fps?: number;
  exposure: number;
  astronomyFrame: Readonly<AstronomyFrame>;
  /**
   * The drift sail's state, or **null on a vessel that has no drift sail**.
   *
   * Which today means the production schooner, where the line read "sail down"
   * on every frame of every session since the raft stopped being the vessel.
   * True and useless is worse than absent: a readout that never changes teaches
   * the eye to stop reading that part of the panel, and the two lines beside it
   * are ones that do change.
   *
   * The MECHANISM stays. `WindSystem.toggleSail` is what the raft, the buoyancy
   * lab and the ship viewer drive their speed from, and it was verified this
   * session as genuinely still needed. This is the readout, not the control.
   */
  sailUp: boolean | null;
  wind: WorldWindTelemetry;
  /** Null on vessels without a rig force model. */
  sails: SailForceTelemetry | null;
}

/**
 * Developer controls and telemetry for the world and lighting.
 *
 * Dynamically imported by the developer-tools shell, so neither the DOM nor the
 * globe nor the astronomy scrubs exist until the panel is opened. Wind and wave
 * controls used to live here; they now belong to the ocean laboratory, which
 * owns the sea state.
 */
export class DebugPanel {
  readonly state: DebugState = { exposureBias: 1 };

  private readonly root: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly globe: DeveloperGlobe;
  private readonly syncers: Array<() => void> = [];
  private readonly navigation = createNavigationTelemetry();
  private readonly daySlider: SliderHandle;

  constructor(
    private readonly world: PlanetaryWorld,
    private readonly astronomy: AstronomyProvider,
    waves: WaveField,
    private readonly vesselMotion: VesselMotionDebugControls,
    private readonly telemetry: () => WorldPanelTelemetry,
    private readonly onCanonicalTimeCommit: () => void,
    private readonly openingResolution?: Readonly<WaterAwareOpeningSuccess>,
  ) {
    deriveNavigationTelemetry(world.state, this.navigation);

    this.root = document.createElement('aside');
    this.root.className = 'debug';

    const title = document.createElement('h2');
    title.textContent = 'Drift · planetary diagnostics';
    this.root.appendChild(title);

    this.addSlider({
      label: 'Local apparent solar time',
      min: 0,
      max: 24,
      step: 1 / 120,
      value: astronomy.localApparentSolarTimeHours(world.state),
      format: formatClockHours,
      onChange: (value) =>
        astronomy.setLocalApparentSolarTime(world, value),
      onCommit: () => this.onCanonicalTimeCommit(),
      read: () => astronomy.localApparentSolarTimeHours(world.state),
    });

    const initialCalendar = astronomy.localApparentSolarCalendar(
      world.state,
    );
    this.daySlider = this.addSlider({
      label: 'Day of year',
      min: 1,
      max: initialCalendar.daysInYear,
      step: 1,
      value: initialCalendar.dayOfYear,
      format: (value) => {
        const current =
          astronomy.localApparentSolarCalendar(world.state);
        const calendar = new Date(
          Date.UTC(current.year, 0, Math.round(value)),
        );
        return `${Math.round(value)} · ${calendar.toLocaleDateString('en-AU', {
          day: '2-digit',
          month: 'short',
          timeZone: 'UTC',
        })}`;
      },
      onChange: (value) =>
        astronomy.setDayOfYearPreservingLocalApparentSolarTime(
          world,
          Math.round(value),
        ),
      onCommit: () => this.onCanonicalTimeCommit(),
      read: () =>
        astronomy.localApparentSolarCalendar(world.state).dayOfYear,
    });
    this.root.appendChild(buildMonthMarkers(initialCalendar.year));

    this.addSlider({
      label: 'Astronomical clock rate',
      min: 0,
      max: 144,
      step: 1,
      value: world.state.worldSecondsPerRealSecond,
      format: (value) => `${value.toFixed(0)} world s / real s`,
      onChange: (value) => world.setWorldSecondsPerRealSecond(value),
      read: () => world.state.worldSecondsPerRealSecond,
    });

    this.addCheckbox(
      'Freeze Sun, Moon and stars',
      world.state.paused,
      (checked) => world.setPaused(checked),
      () => world.state.paused,
    );

    this.addVesselMotionControls();

    let globe!: DeveloperGlobe;
    globe = new DeveloperGlobe(
      this.navigation.latitudeRad,
      this.navigation.longitudeRad,
      (selection) => {
        let target = selection;
        if (this.openingResolution) {
          const decision = resolveGlobalTerrainTeleport(selection);
          globe.setSelectionNotice(
            formatWaterAwareTeleportNotice(decision),
            decision.target ?? undefined,
          );
          if (!decision.target) {
            return;
          }
          target = decision.target;
        } else {
          globe.setSelectionNotice(null);
        }
        astronomy.teleportPreservingLocalApparentSolarTime(
          world,
          target.latitudeRad,
          target.longitudeRad,
        );
      },
    );
    this.globe = globe;
    this.root.appendChild(this.globe.element);

    this.addSlider({
      label: 'Wave amplitude',
      min: 0,
      max: 2.5,
      step: 0.01,
      value: waves.amplitude,
      format: (value) =>
        `${value.toFixed(2)}× (${(waves.amplitudeSum * value).toFixed(2)} m)`,
      onChange: (value) => {
        waves.amplitude = value;
      },
    });

    this.addSlider({
      label: 'Ship / tow true heading',
      min: 0,
      max: 359,
      step: 1,
      value: this.vesselMotion.trueHeadingRad() * RAD_TO_DEG,
      format: (value) => `${value.toFixed(0)}°`,
      // Issuing a heading is an explicit captive-tow command until a rudder
      // exists. In free mode the readback follows the integrated vessel yaw.
      onChange: (value) =>
        this.vesselMotion.setTrueHeadingRad(value / RAD_TO_DEG),
      read: () => this.vesselMotion.trueHeadingRad() * RAD_TO_DEG,
    });

    this.addSlider({
      label: 'Exposure bias',
      min: 0.25,
      max: 3,
      step: 0.01,
      value: 1,
      format: (value) => `${value.toFixed(2)}×`,
      onChange: (value) => {
        this.state.exposureBias = value;
      },
    });

    this.stats = document.createElement('pre');
    this.stats.className = 'stats';
    this.root.appendChild(this.stats);
    // Parenting is the shell's job — it decides when the panel is on screen.
  }

  /** Root element, for the developer-tools shell to mount and hide. */
  get element(): HTMLElement {
    return this.root;
  }

  update(): void {
    const { fps, exposure, astronomyFrame, sailUp, wind, sails } =
      this.telemetry();
    for (const sync of this.syncers) sync();

    const state = this.world.state;
    const date = new Date(state.worldInstantUtcSeconds * 1000);
    const solarCalendar =
      this.astronomy.localApparentSolarCalendar(state);
    const daysThisYear = solarCalendar.daysInYear;
    if (Number(this.daySlider.input.max) !== daysThisYear) {
      this.daySlider.input.max = String(daysThisYear);
      replaceMonthMarkers(this.root, solarCalendar.year);
    }

    deriveNavigationTelemetry(state, this.navigation);
    this.globe.update(
      this.navigation.latitudeRad,
      this.navigation.longitudeRad,
    );
    const solarTimeHours =
      this.astronomy.localApparentSolarTimeHours(state);
    const course =
      this.navigation.trueCourseRad === null
        ? `unavailable (${this.navigation.courseUnavailableReason})`
        : `${(this.navigation.trueCourseRad * RAD_TO_DEG).toFixed(5)}° true`;
    const sunAzimuth =
      astronomyFrame.sunHorizontal.azimuthRad === null
        ? 'unavailable (pole)'
        : `${(astronomyFrame.sunHorizontal.azimuthRad * RAD_TO_DEG).toFixed(4)}°`;
    const sunElevationDeg =
      astronomyFrame.sunHorizontal.elevationRad * RAD_TO_DEG;
    const fpsText = fps === undefined ? '—' : fps.toFixed(0);
    const motionText = this.vesselMotion.isPrescribedSpeed()
      ? `captive tow · ${this.vesselMotion.targetSpeedMps().toFixed(2)} m/s`
      : 'free passive dynamics';

    this.stats.textContent = [
      `${fpsText} fps · exposure ${exposure.toFixed(2)}` +
        (sailUp === null ? '' : ` · sail ${sailUp ? 'up' : 'down'}`),
      '',
      `lat      ${(this.navigation.latitudeRad * RAD_TO_DEG).toFixed(7)}°`,
      `lon      ${(this.navigation.longitudeRad * RAD_TO_DEG).toFixed(7)}°`,
      `height   ${this.navigation.heightM.toFixed(4)} m`,
      `ECEF X   ${state.positionEcefM.x.toFixed(3)} m`,
      `ECEF Y   ${state.positionEcefM.y.toFixed(3)} m`,
      `ECEF Z   ${state.positionEcefM.z.toFixed(3)} m`,
      `speed    ${this.navigation.speedOverGroundMps.toFixed(6)} m/s`,
      `voyage   ${this.world.voyageSecondsPerRealSecond.toFixed(1)}× · ${(this.navigation.speedOverGroundMps * this.world.voyageSecondsPerRealSecond).toFixed(3)} global m/real s`,
      `motion   ${motionText}`,
      `course   ${course}`,
      `vel X    ${state.velocityEcefMps.x.toFixed(8)} m/s`,
      `vel Y    ${state.velocityEcefMps.y.toFixed(8)} m/s`,
      `vel Z    ${state.velocityEcefMps.z.toFixed(8)} m/s`,
      ...(this.openingResolution
        ? ['', formatWaterAwareOpeningDiagnostic(this.openingResolution)]
        : []),
      '',
      `wind     ${wind.meanSpeedMps.toFixed(2)} m/s toward ${formatCompassDeg(wind.meanDirectionTowardDeg)} · gustiness ${wind.gustiness.toFixed(2)}`,
      `gust     ${wind.instantaneousSpeedMps.toFixed(2)} m/s · dir ${wind.gustDirectionOffsetDeg >= 0 ? '+' : ''}${wind.gustDirectionOffsetDeg.toFixed(1)}°`,
      wind.apparentAngleOffBowDeg === null
        ? `apparent ${wind.apparentSpeedMps.toFixed(2)} m/s`
        : `apparent ${wind.apparentSpeedMps.toFixed(2)} m/s · ${Math.abs(wind.apparentAngleOffBowDeg).toFixed(0)}° off bow (${wind.apparentAngleOffBowDeg >= 0 ? 'port' : 'starboard'}) · ${wind.pointOfSail}`,
      ...(sails === null
        ? []
        : [
            `sails    drive ${sails.driveForwardN.toFixed(0)} N · side ${Math.abs(sails.sideForceN).toFixed(0)} N (${sails.sideForceN >= 0 ? 'port' : 'starboard'})`,
            `rig      heel ${(sails.heelTorqueNm / 1000).toFixed(1)} kNm · yaw ${(sails.yawMomentNm / 1000).toFixed(1)} kNm`,
            ...sails.perSail.map(
              (sail) =>
                `  ${sail.name.slice(0, 8).padEnd(9)}${sail.state.padEnd(7)}${sail.state === 'furled' ? '' : `${sail.aoaDeg >= 0 ? '+' : ''}${sail.aoaDeg.toFixed(0)}° ${sail.luffing ? 'LUFF' : 'draw'} ${sail.forceN.toFixed(0)} N`}`,
            ),
          ]),
      '',
      `UTC      ${date.toISOString()}`,
      `LAST     ${formatClockHours(solarTimeHours)}`,
      `solar    day ${solarCalendar.dayOfYear}/${daysThisYear} · ${formatSolarDate(solarCalendar)}`,
      `rate     ${state.worldSecondsPerRealSecond.toFixed(0)}×${state.paused ? ' · PAUSED' : ''}`,
      `sun az   ${sunAzimuth}`,
      `sun el   ${sunElevationDeg.toFixed(4)}° · ${sunElevationDeg >= 0 ? 'above' : 'below'} horizon`,
    ].join('\n');
  }

  dispose(): void {
    this.globe.dispose();
    this.root.remove();
  }

  private addVesselMotionControls(): void {
    const readout = document.createElement('div');
    readout.className = 'motion-readout';
    this.root.appendChild(readout);

    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const add = (
      label: string,
      title: string,
      action: () => void,
    ): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = title;
      button.addEventListener('click', action);
      buttons.appendChild(button);
    };
    add('−1 m/s', 'Reduce the ship speed immediately by 1 m/s', () =>
      this.vesselMotion.decreaseSpeed());
    add('+1 m/s', 'Increase the ship speed immediately by 1 m/s', () =>
      this.vesselMotion.increaseSpeed());
    add('Stop', 'Set prescribed ship speed to zero', () =>
      this.vesselMotion.stop());
    add('Release tow', 'Release the ship into passive force-integrated motion', () =>
      this.vesselMotion.releaseTow());
    this.root.appendChild(buttons);

    this.syncers.push(() => {
      readout.textContent = [
        `Ship motion  ${this.vesselMotion.actualSpeedMps().toFixed(2)} m/s`,
        this.vesselMotion.isPrescribedSpeed()
          ? `captive tow ${this.vesselMotion.targetSpeedMps().toFixed(2)} m/s`
          : 'free passive dynamics',
      ].join(' · ');
    });
  }

  private addSlider(options: SliderOptions): SliderHandle {
    const label = document.createElement('label');
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = options.label;
    const value = document.createElement('span');
    row.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value);

    const format =
      options.format ?? ((currentValue: number) => currentValue.toFixed(2));
    const render = (currentValue: number): void => {
      value.textContent = format(currentValue);
    };
    render(options.value);

    input.addEventListener('input', () => {
      const currentValue = Number(input.value);
      options.onChange(currentValue);
      render(currentValue);
    });
    input.addEventListener('change', () => {
      options.onCommit?.(Number(input.value));
    });

    label.append(row, input);
    this.root.appendChild(label);

    if (options.read) {
      this.syncers.push(() => {
        const currentValue = options.read!();
        if (document.activeElement !== input) {
          input.value = String(currentValue);
        }
        render(
          document.activeElement === input
            ? Number(input.value)
            : currentValue,
        );
      });
    } else {
      this.syncers.push(() => render(Number(input.value)));
    }
    return { input, render };
  }

  private addCheckbox(
    labelText: string,
    initialValue: boolean,
    onChange: (checked: boolean) => void,
    read: () => boolean,
  ): void {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = initialValue;
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(input, text);
    input.addEventListener('change', () => onChange(input.checked));
    this.syncers.push(() => {
      if (document.activeElement !== input) input.checked = read();
    });
    this.root.appendChild(label);
  }
}

function formatCompassDeg(deg: number): string {
  const wrapped = ((Math.round(deg) % 360) + 360) % 360;
  return `${String(wrapped).padStart(3, '0')}°`;
}

function formatClockHours(hours: number): string {
  if (hours === 24) return '24:00:00';
  let totalSeconds = Math.round(hours * 3600) % 86_400;
  if (totalSeconds < 0) totalSeconds += 86_400;
  const hour = Math.floor(totalSeconds / 3600);
  const minute = Math.floor((totalSeconds % 3600) / 60);
  const second = totalSeconds % 60;
  return [hour, minute, second]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatSolarDate(calendar: {
  year: number;
  monthIndex: number;
  dayOfMonth: number;
}): string {
  return [
    String(calendar.year).padStart(4, '0'),
    String(calendar.monthIndex + 1).padStart(2, '0'),
    String(calendar.dayOfMonth).padStart(2, '0'),
  ].join('-');
}

function buildMonthMarkers(year: number): HTMLDivElement {
  const markers = document.createElement('div');
  markers.className = 'month-markers';
  markers.dataset.monthMarkers = 'true';
  const days = daysInUtcYear(year);
  for (let month = 0; month < 12; month++) {
    const marker = document.createElement('span');
    marker.textContent = new Date(Date.UTC(year, month, 1))
      .toLocaleDateString('en-AU', { month: 'narrow', timeZone: 'UTC' });
    marker.style.left = `${
      ((Date.UTC(year, month, 1) - Date.UTC(year, 0, 1)) /
        86_400_000 /
        (days - 1)) *
      100
    }%`;
    markers.appendChild(marker);
  }
  return markers;
}

function replaceMonthMarkers(root: HTMLElement, year: number): void {
  root
    .querySelector<HTMLElement>('[data-month-markers="true"]')
    ?.replaceWith(buildMonthMarkers(year));
}

/**
 * Factory for the developer-tools shell.
 *
 * Exposure bias lives on the panel, so the shell hands back a stable object the
 * render loop can read whether or not the panel is currently on screen — hiding
 * the tools must not change the picture.
 */
export function createWorldPanel(
  world: PlanetaryWorld,
  astronomy: AstronomyProvider,
  waves: WaveField,
  vesselMotion: VesselMotionDebugControls,
  telemetry: () => WorldPanelTelemetry,
  onCanonicalTimeCommit: () => void,
  openingResolution?: Readonly<WaterAwareOpeningSuccess>,
): DebugPanel {
  return new DebugPanel(
    world,
    astronomy,
    waves,
    vesselMotion,
    telemetry,
    onCanonicalTimeCommit,
    openingResolution,
  );
}
