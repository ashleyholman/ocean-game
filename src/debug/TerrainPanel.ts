import type { SyntheticTerrainHandle } from '../terrain/syntheticTerrainHarness';
import {
  SYNTHETIC_TERRAIN_HAZE_KM,
  SYNTHETIC_TERRAIN_RANGE_KM,
} from '../terrain/syntheticTerrainHarness';
import {
  getTerrainDrawOrder,
  setTerrainDrawOrder,
  type TerrainDrawOrder,
} from '../terrain/terrainDrawOrder';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';
import type { DevPanel } from '../ui/DevTools';

const SLIDER_STEPS = 1000;
const RANGE_REFRESH_MS = 120;

/**
 * Live controls for the URL-gated R1 terrain fixture.
 *
 * Range changes rebuild the small deterministic fixture, so they are
 * throttled while the pointer is moving and committed immediately on release.
 * Haze is a material uniform and therefore updates every input event without
 * rebuilding geometry. Both values are mirrored into the URL so a tuned view
 * can be bookmarked or pasted into the next review.
 */
export class TerrainPanel implements DevPanel {
  readonly element: HTMLDivElement;

  private readonly controls: ControlGroup;
  private readonly readout: HTMLPreElement;
  private readonly minimumRangeKm: number;
  private requestedRangeKm: number;
  private lastRangeRefreshMs = -Infinity;
  private rangeRefreshTimer: number | undefined;

  constructor(private readonly terrain: SyntheticTerrainHandle) {
    ensurePanelStyle();

    this.element = document.createElement('div');
    this.element.className = 'devpanel';

    const heading = document.createElement('h2');
    heading.textContent = 'Terrain · distance & haze';
    this.element.appendChild(heading);

    this.controls = new ControlGroup(this.element);
    this.controls.section('live synthetic terrain');

    this.minimumRangeKm = SYNTHETIC_TERRAIN_RANGE_KM.min;
    this.requestedRangeKm = terrain.getRangeKm();
    this.controls.slider({
      label: 'Nearest land distance',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: toLogSlider(
        this.requestedRangeKm,
        this.minimumRangeKm,
        SYNTHETIC_TERRAIN_RANGE_KM.max,
      ),
      format: (value) =>
        formatKm(
          fromLogSlider(
            value,
            this.minimumRangeKm,
            SYNTHETIC_TERRAIN_RANGE_KM.max,
          ),
        ),
      onChange: (value) =>
        this.queueRangeRefresh(
          fromLogSlider(
            value,
            this.minimumRangeKm,
            SYNTHETIC_TERRAIN_RANGE_KM.max,
          ),
        ),
      onCommit: (value) =>
        this.commitRangeRefresh(
          fromLogSlider(
            value,
            this.minimumRangeKm,
            SYNTHETIC_TERRAIN_RANGE_KM.max,
          ),
        ),
      read: () =>
        toLogSlider(
          terrain.getRangeKm(),
          this.minimumRangeKm,
          SYNTHETIC_TERRAIN_RANGE_KM.max,
        ),
    });

    this.controls.slider({
      label: 'Terrain haze distance',
      min: 0,
      max: SLIDER_STEPS,
      step: 1,
      value: toLogSlider(
        terrain.getHazeDistanceKm(),
        SYNTHETIC_TERRAIN_HAZE_KM.min,
        SYNTHETIC_TERRAIN_HAZE_KM.max,
      ),
      format: (value) =>
        formatKm(
          fromLogSlider(
            value,
            SYNTHETIC_TERRAIN_HAZE_KM.min,
            SYNTHETIC_TERRAIN_HAZE_KM.max,
          ),
        ),
      onChange: (value) => {
        const hazeDistanceKm = fromLogSlider(
          value,
          SYNTHETIC_TERRAIN_HAZE_KM.min,
          SYNTHETIC_TERRAIN_HAZE_KM.max,
        );
        terrain.setHazeDistanceKm(hazeDistanceKm);
        replaceQueryNumber('haze', hazeDistanceKm);
      },
      read: () =>
        toLogSlider(
          terrain.getHazeDistanceKm(),
          SYNTHETIC_TERRAIN_HAZE_KM.min,
          SYNTHETIC_TERRAIN_HAZE_KM.max,
        ),
    });

    this.controls.select(
      'Draw order vs sea',
      [
        { value: 'after', label: 'after (ships)' },
        { value: 'before', label: 'before (occludes sea)' },
      ],
      getTerrainDrawOrder(),
      (value) => {
        setTerrainDrawOrder(value as TerrainDrawOrder);
        replaceQueryText('terrainOrder', value);
      },
      () => getTerrainDrawOrder(),
    );

    this.readout = this.controls.readout();
    this.update();
  }

  update(): void {
    this.controls.sync();
    const rangeKm = this.terrain.getRangeKm();
    const hazeKm = this.terrain.getHazeDistanceKm();
    // The slider states where the fixture was MOUNTED; the vessel then sails.
    // Both belong on screen — a readout that only quotes the mount goes stale
    // the moment anything moves, which is exactly the case TERR-104 is about.
    const liveKm = this.terrain.getNearestLandM() / 1000;
    const transmission = Math.exp(-liveKm / hazeKm);
    const stats = this.terrain.system.stats;
    this.readout.textContent = [
      `Fixture       ${this.terrain.fixtureId}`,
      `Mounted at    ${formatKm(rangeKm)}`,
      `Nearest land  ${formatKm(liveKm)} now`,
      `Terrain haze  ${formatKm(hazeKm)}`,
      `Land retained ${(transmission * 100).toFixed(0)}% at nearest point`,
      `Residency     ${stats.tiles} tiles · ${stats.triangles.toLocaleString()} tris` +
        ` · ${(stats.geometryBytes / (1024 * 1024)).toFixed(1)} MB`,
      `Draw order    ${stats.drawOrder} the sea (renderOrder ${stats.renderOrder})`,
      `Slider range  ${formatKm(this.minimumRangeKm)}–${formatKm(SYNTHETIC_TERRAIN_RANGE_KM.max)}`,
      '',
      'Lower haze distance = hazier land.',
      'Distance is measured to the nearest above-water terrain.',
      'Sliders are logarithmic; the URL follows your tuning.',
    ].join('\n');
  }

  dispose(): void {
    if (this.rangeRefreshTimer !== undefined) {
      window.clearTimeout(this.rangeRefreshTimer);
      this.rangeRefreshTimer = undefined;
    }
  }

  private queueRangeRefresh(rangeKm: number): void {
    this.requestedRangeKm = rangeKm;
    const waitMs = Math.max(
      0,
      RANGE_REFRESH_MS - (performance.now() - this.lastRangeRefreshMs),
    );
    if (waitMs === 0) {
      this.applyRequestedRange();
      return;
    }
    if (this.rangeRefreshTimer !== undefined) return;
    this.rangeRefreshTimer = window.setTimeout(() => {
      this.rangeRefreshTimer = undefined;
      this.applyRequestedRange();
    }, waitMs);
  }

  private commitRangeRefresh(rangeKm: number): void {
    this.requestedRangeKm = rangeKm;
    if (this.rangeRefreshTimer !== undefined) {
      window.clearTimeout(this.rangeRefreshTimer);
      this.rangeRefreshTimer = undefined;
    }
    this.applyRequestedRange();
  }

  private applyRequestedRange(): void {
    this.terrain.setRangeKm(this.requestedRangeKm);
    this.lastRangeRefreshMs = performance.now();
    replaceQueryNumber('range', this.terrain.getRangeKm());
  }
}

export function createTerrainPanel(
  terrain: SyntheticTerrainHandle,
): TerrainPanel {
  return new TerrainPanel(terrain);
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

function formatKm(value: number): string {
  if (value < 10) return `${value.toFixed(1)} km`;
  return `${value.toFixed(0)} km`;
}

function replaceQueryText(name: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  window.history.replaceState(window.history.state, '', url);
}

function replaceQueryNumber(name: string, value: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set(name, Number(value.toFixed(2)).toString());
  window.history.replaceState(window.history.state, '', url);
}
