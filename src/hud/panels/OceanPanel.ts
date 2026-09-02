/**
 * The sea, chosen rather than measured.
 *
 * The ocean laboratory has sixty-odd controls over a sea state because every
 * one of them is a question someone had to answer with their eyes. A visitor
 * has one question — "can I see it rough?" — so this page is the roster of
 * playable seas under their own names, plus the two things worth moving on
 * their own: how hard it is blowing and from where.
 *
 * The presets are not restated or renamed here. They are the same rows the
 * laboratory offers, applied the same way, so "Southern Ocean rough" on this
 * page is the same sea as "Southern Ocean rough" on that one; only the
 * diagnostic fixtures are withheld.
 *
 * A change lands immediately. The controller can morph between states over
 * minutes and does so beautifully, but a player who picks a gale and sees
 * nothing happen for two minutes concludes the control is broken — so this
 * page snaps and warms the foam, exactly as the laboratory's preset buttons
 * do.
 */

import { HudGroup, formatBearing, metresPerSecondToKnots } from '../hudControls';
import type { HudPanel } from '../PlayerHud';
import { SEA_STATES } from '../../ocean/presets';
import { cloneSeaState, type SeaState } from '../../ocean/seaState';

export interface OceanPanelSources {
  /** The live (possibly mid-transition) sea state. */
  state(): SeaState;
  /** Adopt a sea state now, and warm the foam so it is not empty. */
  apply(next: SeaState): void;
}

const PLAYABLE = SEA_STATES.filter((state) => state.purpose === 'PLAYABLE');

export function createOceanPanel(sources: OceanPanelSources): HudPanel {
  const group = new HudGroup();
  let draft = cloneSeaState(sources.state());
  let presetName = draft.name;

  const apply = (): void => {
    sources.apply(cloneSeaState(draft));
  };
  const mutate = (edit: (state: SeaState) => void): void => {
    const next = cloneSeaState(draft);
    edit(next);
    draft = next;
    apply();
  };

  group.select(
    'Sea state',
    PLAYABLE.map((state) => ({ value: state.name, label: state.label })),
    (value) => {
      const preset = PLAYABLE.find((state) => state.name === value);
      if (!preset) return;
      presetName = value;
      draft = cloneSeaState(preset);
      apply();
      group.sync();
    },
    () => presetName,
  );

  group.section('Wind');
  group.slider({
    label: 'Wind speed',
    min: 0,
    max: 25,
    step: 0.5,
    value: draft.generatingWind.speedMps,
    format: (value) =>
      `${metresPerSecondToKnots(value).toFixed(0)} kn · ${value.toFixed(1)} m/s`,
    onChange: (value) =>
      mutate((state) => {
        (state.generatingWind as { speedMps: number }).speedMps = value;
      }),
    read: () => draft.generatingWind.speedMps,
  });
  group.slider({
    label: 'Wind from',
    min: 0,
    max: 359,
    step: 1,
    value: windFromDeg(draft),
    format: formatBearing,
    onChange: (value) =>
      mutate((state) => {
        (state.generatingWind as { directionDeg: number }).directionDeg = value + 180;
      }),
    read: () => windFromDeg(draft),
  });

  return {
    element: group.element,
    update(): void {
      group.sync();
    },
    dispose(): void {
      group.element.remove();
    },
  };
}

/** The bearing a sailor names the wind by: where it blows *from*. */
function windFromDeg(state: SeaState): number {
  return (((state.generatingWind.directionDeg + 180) % 360) + 360) % 360;
}
