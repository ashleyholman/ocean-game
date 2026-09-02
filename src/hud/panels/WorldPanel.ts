/**
 * Where in the world, and when.
 *
 * The developer world panel with the developer half taken off: no ECEF
 * readout, no astronomical clock rate, no wave amplitude, no tow harness, no
 * exposure bias. What is left is the four controls that change the light, kept
 * deliberately in the developer panel's own terms — this is local apparent
 * solar time, not "time of day", because that is what it is, and the clock
 * ticks while you watch it.
 *
 * Sun, moon and stars are real astronomy, so the globe is not decoration:
 * teleport to the North Atlantic in January and the sky over you is a northern
 * winter sky, with the sun in the south and the day short.
 */

import { HudGroup } from '../hudControls';
import type { HudPanel } from '../PlayerHud';
import type { AstronomyProvider } from '../../astronomy/AstronomyProvider';
import type { PlanetaryWorld } from '../../world/PlanetaryWorld';
import {
  createNavigationTelemetry,
  deriveNavigationTelemetry,
} from '../../world/navigation';
import { DeveloperGlobe } from '../../ui/DeveloperGlobe';
import type { GlobalTerrainSource } from '../../terrain/GlobalTerrainSource';
import {
  resolveGlobalTerrainTeleport,
} from '../../terrain/globalTerrainTeleportRuntime';
import {
  formatWaterAwareOpeningDiagnostic,
  formatWaterAwareTeleportNotice,
  type WaterAwareOpeningSuccess,
} from '../../terrain/WaterAwareOpeningResolver';

export interface WorldPanelSources {
  world: PlanetaryWorld;
  astronomy: AstronomyProvider;
  /** Defaults to the same shared coarse source used by live terrain. */
  terrainSource?: GlobalTerrainSource;
  /** Persistent authored/resolved publication for explicit-global startup. */
  openingResolution?: Readonly<WaterAwareOpeningSuccess>;
  /** Let the cloud cache rebase after a scrub lands somewhere new. */
  onTimeCommitted(): void;
}

/** Open water, deliberately: every one of these is a sea, not a coastline. */
const DESTINATIONS = [
  { label: 'Coral Sea', latitudeDeg: -15.5, longitudeDeg: 152.5 },
  { label: 'Southern Ocean', latitudeDeg: -55, longitudeDeg: 140 },
  { label: 'North Atlantic', latitudeDeg: 54, longitudeDeg: -25 },
  { label: 'Norwegian Sea', latitudeDeg: 68, longitudeDeg: 2 },
] as const;

export function createWorldPanel(sources: WorldPanelSources): HudPanel {
  const { world, astronomy, onTimeCommitted } = sources;
  const group = new HudGroup();
  const navigation = createNavigationTelemetry();
  deriveNavigationTelemetry(world.state, navigation);

  group.slider({
    label: 'Local apparent solar time',
    min: 0,
    max: 24,
    step: 1 / 120,
    value: astronomy.localApparentSolarTimeHours(world.state),
    format: formatClockHours,
    onChange: (value) => astronomy.setLocalApparentSolarTime(world, value),
    onCommit: () => onTimeCommitted(),
    read: () => astronomy.localApparentSolarTimeHours(world.state),
  });
  group.sliderMarkers([
    '12am',
    '3am',
    '6am',
    '9am',
    'noon',
    '3pm',
    '6pm',
    '9pm',
    '12am',
  ]);

  group.toggle(
    'Freeze time of day',
    (on) => world.setPaused(on),
    () => world.state.paused,
  );

  const calendar = astronomy.localApparentSolarCalendar(world.state);
  const daySlider = group.slider({
    label: 'Day of year',
    min: 1,
    max: calendar.daysInYear,
    step: 1,
    value: calendar.dayOfYear,
    format: (value) => formatDayOfYear(world, astronomy, value),
    onChange: (value) =>
      astronomy.setDayOfYearPreservingLocalApparentSolarTime(
        world,
        Math.round(value),
      ),
    onCommit: () => onTimeCommitted(),
    read: () => astronomy.localApparentSolarCalendar(world.state).dayOfYear,
  });
  const markers = group.monthMarkers(calendar.year);

  group.section('Location');
  if (sources.openingResolution) {
    group.note(formatWaterAwareOpeningDiagnostic(sources.openingResolution));
  }
  let globe!: DeveloperGlobe;
  globe = new DeveloperGlobe(
    navigation.latitudeRad,
    navigation.longitudeRad,
    (selection) => {
      let target = selection;
      if (sources.openingResolution) {
        const decision = resolveGlobalTerrainTeleport(
          selection,
          sources.terrainSource,
        );
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
    sources.terrainSource,
  );
  const holder = document.createElement('div');
  holder.className = 'hud-globe';
  holder.appendChild(globe.element);
  group.element.appendChild(holder);
  group.note(
    `${isTouchHost() ? 'Tap' : 'Click'} a location on the globe to teleport.` +
      (sources.openingResolution
        ? ' Land and near-coast selections move to qualified nearby water; deeply inland selections are rejected.'
        : ''),
  );
  // These remain useful open-water shortcuts even now the globe carries the
  // coarse shared land mask: each is deliberately a sea, not a coastline.
  group.buttons(
    DESTINATIONS.map((destination) => ({
      label: destination.label,
      title: `${Math.abs(destination.latitudeDeg).toFixed(0)}° ${
        destination.latitudeDeg < 0 ? 'south' : 'north'
      }`,
      onClick: () => {
        globe.setSelectionNotice(null);
        astronomy.teleportPreservingLocalApparentSolarTime(
          world,
          (destination.latitudeDeg * Math.PI) / 180,
          (destination.longitudeDeg * Math.PI) / 180,
        );
      },
    })),
  );

  // Start "overdue" so the first rendered frame fills the page in.
  let accumulated = Number.POSITIVE_INFINITY;

  return {
    element: group.element,
    update(dtSeconds: number): void {
      accumulated += dtSeconds;
      // The solar clock is a clock: it is read back fast enough to tick
      // visibly rather than to lurch a minute at a time.
      if (accumulated < 0.05) return;
      accumulated = 0;
      group.sync();

      const solar = astronomy.localApparentSolarCalendar(world.state);
      if (Number(daySlider.max) !== solar.daysInYear) {
        daySlider.max = String(solar.daysInYear);
      }
      if (markers.dataset.year !== String(solar.year)) {
        group.fillMonthMarkers(markers, solar.year);
      }
      deriveNavigationTelemetry(world.state, navigation);
      globe.update(navigation.latitudeRad, navigation.longitudeRad);
    },
    dispose(): void {
      globe.dispose();
      group.element.remove();
    },
  };
}

function isTouchHost(): boolean {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** hh:mm:ss, exactly as the developer world panel has always shown it. */
function formatClockHours(hours: number): string {
  if (hours === 24) return '24:00:00';
  let totalSeconds = Math.round(hours * 3600) % 86_400;
  if (totalSeconds < 0) totalSeconds += 86_400;
  return [
    Math.floor(totalSeconds / 3600),
    Math.floor((totalSeconds % 3600) / 60),
    totalSeconds % 60,
  ]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatDayOfYear(
  world: PlanetaryWorld,
  astronomy: AstronomyProvider,
  value: number,
): string {
  const current = astronomy.localApparentSolarCalendar(world.state);
  const date = new Date(Date.UTC(current.year, 0, Math.round(value)));
  // The date alone. The day number it is derived from is the slider's own
  // coordinate, not something to read.
  return date.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
