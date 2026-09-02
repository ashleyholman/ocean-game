/**
 * Sailing her, for someone who is not debugging the sailing.
 *
 * The developer sailing panel is the whole control surface: eight sheets, four
 * set states each, rudder physics, stall factors, the crew's perception model
 * and a sixty-second trace of it. This page is the ship as a person aboard her
 * would work it — where she is pointing, where she has been asked to point,
 * what the helmsman is doing about the difference, and how much canvas she is
 * carrying.
 *
 * Every control here is an *order*. A course is spoken to the helmsman through
 * the same utterance and reaction delays the developer panel uses; setting or
 * handing sail is work the crew go and do at their own pace, which is why the
 * canvas buttons show the job in progress rather than pretending it is done.
 */

import { HudGroup, formatBearing, metresPerSecondToKnots } from '../hudControls';
import { pointOfSailName } from '../../world/WorldWind';
import {
  AUTHORED_TRIM_DEG,
  RUDDER_LIMIT_DEG,
  SET_STATE_HOIST_FRACTION,
  SHEET_TRIMMED_SAILS,
  type SailingControls,
  type SheetTrimmedSail,
} from '../../vessel/schooner/SailingControls';
import { RIG_TRIM_LIMITS, SAILS, type SailName } from '../../vessel/schooner/rig';
import {
  BARE_POLES,
  FULL_SAIL,
  REEFED_SAIL,
  WORKING_SAIL,
  type CanvasState,
} from '../../vessel/schooner/sailAero';
import {
  COMPASS_HEIGHT,
  COMPASS_WIDTH,
  drawCompassRose,
  prepareCompassCanvas,
} from '../compassRose';
import type { HudPanel } from '../PlayerHud';
import type { SailingCrew } from '../../vessel/schooner/crew/SailingCrew';
import type { SailingPanelState } from '../../debug/SailingPanel';

export interface SailingPanelSources {
  controls: SailingControls;
  crew?: SailingCrew;
  read(): SailingPanelState;
}

export function createSailingPanel(sources: SailingPanelSources): HudPanel {
  const { controls, crew, read } = sources;
  const group = new HudGroup();

  const canvas = group.canvas(
    COMPASS_WIDTH,
    COMPASS_HEIGHT,
    'Compass, ordered course, wind and rudder',
  );
  prepareCompassCanvas(canvas);

  const speed = group.stat('knots through the water');
  const lines = group.lines();

  // The order the helmsman is holding, mirrored locally so the slider does not
  // snap back while it is being dragged toward a course not yet spoken.
  let courseOrderDeg =
    read().crew?.helmsman.orderedCourseDeg ?? read().headingTrueDeg;

  if (crew) {
    group.section('Steering');
    group.slider({
      label: 'Ordered course',
      min: 0,
      max: 359,
      step: 1,
      value: courseOrderDeg,
      format: formatBearing,
      onChange: (value) => {
        courseOrderDeg = value;
      },
      onCommit: (value) => {
        courseOrderDeg = value;
        crew.orderCompassCourse(value);
      },
      read: () => courseOrderDeg,
    });
    group.buttons([
      {
        label: 'Hold this heading',
        title: 'Order the course currently under the bow',
        onClick: () => {
          courseOrderDeg = read().headingTrueDeg;
          crew.orderCompassCourse(courseOrderDeg);
        },
      },
      {
        label: 'Stop steering',
        title: 'The helmsman lets the tiller go; she carries on as she is',
        onClick: () => crew.standDownHelm(),
      },
    ]);
  }

  buildSailControls(group, controls);

  // Start "overdue" so the first rendered frame fills the page in.
  let accumulated = Number.POSITIVE_INFINITY;

  return {
    element: group.element,
    update(dtSeconds: number): void {
      const state = read();
      // The card is redrawn every frame — it is the one thing on this page
      // genuinely in motion — while text and slider read-back settle at a rate
      // the eye can follow instead of flickering per frame.
      drawCompassRose(canvas, {
        headingDeg: state.headingTrueDeg,
        orderedCourseDeg: state.crew?.helmsman.orderedCourseDeg ?? null,
        rudderBladeDeg: state.rudderBladeDeg,
        rudderOrderDeg: controls.rudderTargetDeg,
        rudderLimitDeg: RUDDER_LIMIT_DEG,
        // The angle off the bow is signed against the wind's *source*, so the
        // bearing it blows from is the heading less that angle.
        windFromDeg:
          state.trueWindAngleOffBowDeg === null
            ? null
            : state.headingTrueDeg - state.trueWindAngleOffBowDeg,
      });

      accumulated += dtSeconds;
      if (accumulated < 0.1) return;
      accumulated = 0;
      group.sync();

      speed.textContent = metresPerSecondToKnots(state.speedMps).toFixed(1);
      lines.textContent = describeSailing(state, controls);
    },
    dispose(): void {
      group.element.remove();
    },
  };
}

/**
 * Working the ship, at the level of "more sail" and "sheet in".
 *
 * The developer panel gives every sail its own set state and its own sheet,
 * which is the right tool for tuning a rig and far too many decisions for a
 * visitor. Here the eight sails are worked as a crew works them — by plan —
 * and the sheets move together on one slider.
 *
 * TRIM IS ONE NUMBER, AND IT IS NOT ONE ANGLE
 * -------------------------------------------
 * The rig is not sheeted to a single angle: the authored fan runs 26° on the
 * main out to 37° on the flying jib, because each sail forward is eased more
 * to keep the slot open behind it. So the slider carries the *fan*, scaling
 * every sheet about its own share of it. Hauling in hauls the whole rig in,
 * and the sail plan keeps its shape while it happens.
 */
function buildSailControls(group: HudGroup, controls: SailingControls): void {
  const work = createCanvasProgress(controls);

  group.section('Sail');
  group.segmented(
    'Canvas',
    CANVAS_PLANS.map(({ key, label }) => ({ value: key, label })),
    (key) => {
      const plan = CANVAS_PLANS.find((entry) => entry.key === key);
      if (!plan) return;
      for (const [sail, state] of Object.entries(plan.plan)) {
        controls.commandSetState(sail as SailName, state);
      }
    },
    () => currentCanvasKey(controls),
    () => work.read(),
  );

  group.slider({
    label: 'Sheets',
    min: SHEET_EASE_MIN_DEG,
    max: SHEET_EASE_MAX_DEG,
    step: 1,
    value: meanSheetDeg(controls),
    format: (value) =>
      value <= SHEET_EASE_MIN_DEG + 0.5
        ? 'hauled flat'
        : value >= SHEET_EASE_MAX_DEG - 0.5
          ? 'right out'
          : `${value.toFixed(0)}°`,
    onChange: (value) => applySheetEase(controls, value),
    read: () => meanSheetDeg(controls),
  });
  group.buttons([
    {
      label: 'Swap sheets to the other side',
      title:
        'Same angle, opposite side — what the crew do when she comes through ' +
        'the wind',
      onClick: () => sheetsAcross(controls),
    },
  ]);
}

/** The four plans offered, in order of how much canvas they carry. */
const CANVAS_PLANS: ReadonlyArray<{
  key: string;
  label: string;
  plan: CanvasState;
}> = [
  { key: 'full', label: 'Full', plan: FULL_SAIL },
  { key: 'working', label: 'Working', plan: WORKING_SAIL },
  { key: 'reefed', label: 'Reefed', plan: REEFED_SAIL },
  { key: 'furled', label: 'Furled', plan: BARE_POLES },
];

/** The plan she is *ordered* to, or 'mixed' while she is between two. */
function currentCanvasKey(controls: SailingControls): string {
  for (const { key, plan } of CANVAS_PLANS) {
    const matches = Object.entries(plan).every(
      ([sail, state]) => controls.targetSetState(sail as SailName) === state,
    );
    if (matches) return key;
  }
  return 'mixed';
}

/**
 * How far through the ordered sail change the crew are.
 *
 * Measured in cloth: the total hoist still to travel, against however much was
 * outstanding when the order was at its largest. That makes the fill honest
 * about the *work* rather than about elapsed time — a sail waiting its turn
 * behind another (the gaff topsail must come in before the mainsail can) holds
 * the bar where it is, because nothing is moving yet.
 */
function createCanvasProgress(controls: SailingControls): {
  read(): { value: string; fraction: number } | null;
} {
  let peak = 0;
  return {
    read: () => {
      let remaining = 0;
      for (const sail of SAILS) {
        remaining += Math.abs(
          SET_STATE_HOIST_FRACTION[controls.targetSetState(sail.name)] -
            controls.hoistFraction(sail.name),
        );
      }
      if (remaining <= 1e-6) {
        peak = 0;
        return null;
      }
      peak = Math.max(peak, remaining);
      return {
        value: currentCanvasKey(controls),
        fraction: 1 - remaining / peak,
      };
    },
  };
}

/** Hard in, and right out to the boom's mechanical limit. */
const SHEET_EASE_MIN_DEG = 8;
const SHEET_EASE_MAX_DEG = 46;

/** Each sheet's share of the authored fan, so scaling keeps the shape. */
const SHEET_FAN_RATIO: Readonly<Record<SheetTrimmedSail, number>> = (() => {
  const magnitudes = SHEET_TRIMMED_SAILS.map((sail) =>
    Math.abs(AUTHORED_TRIM_DEG[sail]),
  );
  const mean =
    magnitudes.reduce((sum, value) => sum + value, 0) / magnitudes.length;
  return Object.fromEntries(
    SHEET_TRIMMED_SAILS.map((sail, index) => [sail, magnitudes[index] / mean]),
  ) as Record<SheetTrimmedSail, number>;
})();

/** Where the slider sits: the fan's current mean, ignoring which side it is on. */
function meanSheetDeg(controls: SailingControls): number {
  let total = 0;
  for (const sail of SHEET_TRIMMED_SAILS) {
    total += Math.abs(controls.trimDeg(sail));
  }
  return total / SHEET_TRIMMED_SAILS.length;
}

/**
 * The lee side the sheets are already on.
 *
 * Read from the mainsail, which is the one sail always set and always sheeted;
 * a rig sitting exactly amidships is treated as the authored starboard tack
 * rather than left undefined.
 */
function sheetSide(controls: SailingControls): number {
  return controls.trimDeg('mainsail') < 0 ? -1 : 1;
}

function applySheetEase(controls: SailingControls, easeDeg: number): void {
  const side = sheetSide(controls);
  for (const sail of SHEET_TRIMMED_SAILS) {
    const magnitude = Math.min(
      SHEET_FAN_RATIO[sail] * easeDeg,
      RIG_TRIM_LIMITS[sail].maxDeg,
    );
    controls.commandTrimDeg(sail, side * magnitude);
  }
}

/**
 * Every sheet to the other side at the same angle, fisherman dipped round with
 * them.
 *
 * She does not do this by herself: the rig holds whatever trim it was given, so
 * coming through the wind without shifting the sheets leaves every sail aback.
 */
function sheetsAcross(controls: SailingControls): void {
  for (const sail of SHEET_TRIMMED_SAILS) {
    controls.commandTrimDeg(sail, -controls.trimDeg(sail));
  }
  controls.commandFishermanSide(
    controls.trimDeg('mainTopmastStaysail') >= 0 ? 'starboard' : 'port',
  );
}

/**
 * The lines a passenger would ask about, in a sailor's words.
 *
 * The wind is named the way winds are named — by where it comes *from* — and
 * the point of sail is named from the TRUE wind, not the apparent one: at six
 * knots the apparent wind is drawn far enough forward that a beam reach would
 * otherwise report itself as close-hauled.
 */
function describeSailing(
  state: SailingPanelState,
  controls: SailingControls,
): string {
  const knots = metresPerSecondToKnots(state.apparentWindMps).toFixed(1);
  const angle = state.apparentAngleOffBowDeg;
  const apparent =
    angle === null
      ? `${knots} kn apparent`
      : `${knots} kn apparent · ${Math.abs(angle).toFixed(0)}° ${
          angle >= 0 ? 'to port' : 'to starboard'
        }`;
  return [
    `wind    ${apparent}`,
    `sailing ${
      state.trueWindAngleOffBowDeg === null
        ? 'becalmed'
        : pointOfSailName(state.trueWindAngleOffBowDeg)
    } · ${state.tack} tack · heel ${Math.abs(state.heelDeg).toFixed(1)}° ${
      // Roll is applied about the model's +z bow axis and +x is the port side
      // (`hullForm.ts`), so a positive roll lifts the port rail: positive heel
      // is heel to starboard.
      state.heelDeg >= 0 ? 'stbd' : 'port'
    }`,
    `sail    ${describeCanvas(state, controls)}`,
  ].join('\n');
}

/**
 * What she is carrying, and whether anyone is still working on it.
 *
 * A luffing count is the one piece of aero worth a visitor's attention — it is
 * the difference between sails that are driving and sails that are shaking,
 * which is what the sheet slider is for.
 */
function describeCanvas(
  state: SailingPanelState,
  controls: SailingControls,
): string {
  const key = currentCanvasKey(controls);
  const named =
    CANVAS_PLANS.find((plan) => plan.key === key)?.label.toLowerCase() ??
    'mixed';
  const working = state.perSail.some(
    (sail) =>
      controls.settledSetState(sail.name) !== controls.targetSetState(sail.name),
  );
  const luffing =
    state.luffingCount > 0 ? `${state.luffingCount} luffing` : 'all drawing';
  return `${named}${working ? ' · crew working' : ''} · ${luffing}`;
}
