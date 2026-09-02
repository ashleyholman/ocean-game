/**
 * The handful of preferences that are a matter of taste rather than of
 * composition — how fast the view turns, and which way up it goes.
 *
 * Switching between the two views is not here: it is the one thing on this
 * interface a player reaches for constantly, so it lives as its own control
 * over the picture (`PlayerHud`'s view switcher) rather than three taps deep in
 * a panel. What is left is genuinely settings.
 */

import { HudGroup } from '../hudControls';
import type { HudPanel } from '../PlayerHud';
import type { CameraSystem } from '../../camera/CameraSystem';
import {
  calibrationSummary,
  setDisplayCalibration,
} from '../../scene/displayCalibration';
import { scotopicStrength } from '../../scene/scotopic';
import { openDisplayCalibration } from '../displayCalibrationOverlay';

export function createSettingsPanel(cameras: CameraSystem): HudPanel {
  const group = new HudGroup();

  // Part C only calibrates Part A's rejected observer model. Do not offer a
  // player a measurement that has no effect on the shipped, 0%-strength night;
  // keep it reachable for an explicit `?scotopic=1` lab session.
  if (scotopicStrength() > 0) {
    group.section('Display');
    const verdict = group.note(calibrationSummary());
    const refresh = (): void => {
      verdict.textContent = calibrationSummary();
    };
    group.buttons([
      {
        label: 'Calibrate optional night vision',
        title:
          'Five seconds of black and one click. Finds the level below which your screen, in this room, shows nothing.',
        onClick: () => openDisplayCalibration(refresh),
      },
      {
        label: 'Forget',
        title: 'Forget the display measurement for optional night vision',
        onClick: () => {
          setDisplayCalibration(null);
          refresh();
        },
      },
    ]);
  }

  group.section('Looking about');
  group.slider({
    label: 'Look sensitivity',
    min: 0.5,
    max: 6,
    step: 0.05,
    value: cameras.lookControl.gain,
    format: (value) => `${value.toFixed(2)}×`,
    onChange: (value) => {
      cameras.lookControl.gain = value;
    },
    read: () => cameras.lookControl.gain,
  });
  group.toggle(
    'Invert look',
    (on) => {
      cameras.lookControl.invert = on;
    },
    () => cameras.lookControl.invert,
  );

  group.section('Reset');
  group.buttons([
    {
      label: 'Outside view',
      title: 'Back to the authored outside composition',
      onClick: () => cameras.resetCinematic(),
    },
    {
      label: 'Look forward',
      title: 'Face the way the sailor is facing',
      onClick: () => cameras.resetEmbodiedLook(),
    },
  ]);

  group.section('Keys');
  const keys = group.lines();
  keys.textContent = [
    'V        change view',
    'W A S D  walk the deck, aboard',
    'drag     look around',
    'scroll   change the outside view scale',
    'M        sound',
    '\\        hide the interface',
  ].join('\n');

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
