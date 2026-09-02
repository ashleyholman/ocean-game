/**
 * The audio A/B bench.
 *
 * Ash is the only one who can say whether any of this *sounds* right, and he
 * cannot say it about a mix. So this panel exists to take the mix apart: a
 * trim per voice, a solo that silences the other five, and — the part that
 * turns out to matter most — a live readout of the world state each voice is
 * being driven by, next to the gain it produced.
 *
 * That last column is the point. "The rigging is too loud" and "the rigging is
 * responding to the wrong number" are different faults with the same symptom,
 * and until the panel showed apparent wind beside the rigging's gain there was
 * no way to tell them apart without reading the source. It also works with the
 * sound muted and in a browser that has never had a gesture, because the
 * mapping runs whether or not there is anything to play it through.
 */

import type { Ambience } from '../audio/Ambience';
import { SOUND_LAYERS, type SoundLayerName } from '../audio/SoundMixer';
import { ControlGroup, ensurePanelStyle } from '../ui/controls';

/** What each voice is driven by, for the readout's middle column. */
const DRIVER_LABEL: Readonly<Record<SoundLayerName, string>> = Object.freeze({
  swell: 'Hs',
  breakers: 'whitecap',
  rigging: 'app. wind',
  cloth: 'shaking m²',
  bow: 'thru water',
  hull: 'work rate',
});

export function createSoundPanel(ambience: Ambience): {
  element: HTMLElement;
  update(dt: number): void;
  dispose(): void;
} {
  ensurePanelStyle();

  const root = document.createElement('aside');
  root.className = 'devpanel';
  root.style.top = '12px';
  root.style.right = '12px';

  const title = document.createElement('h2');
  title.textContent = 'Drift · sound';
  root.appendChild(title);

  const controls = new ControlGroup(root);
  const mixer = ambience.mixer;

  controls.section('Master');
  controls.checkbox(
    'Muted',
    mixer.muted,
    (checked) => {
      if (checked !== mixer.muted) ambience.toggleMute();
    },
    () => mixer.muted,
  );
  controls.slider({
    label: 'Master gain',
    min: 0,
    max: 1,
    step: 0.01,
    value: mixer.master,
    format: (v) => v.toFixed(2),
    onChange: (v) => {
      mixer.master = v;
    },
    read: () => mixer.master,
  });

  // Solo is a select rather than six radio buttons because "off" has to be one
  // click away from any state. Hunting for the voice you soloed three minutes
  // ago is how a diagnostic tool becomes the bug.
  controls.section('Solo');
  controls.select(
    'Hear only',
    [
      { value: '', label: 'Full mix' },
      ...SOUND_LAYERS.map((layer) => ({ value: layer, label: layer })),
    ],
    '',
    (value) => ambience.setSolo(value === '' ? null : (value as SoundLayerName)),
    () => mixer.solo ?? '',
  );

  controls.section('Voice trims');
  for (const layer of SOUND_LAYERS) {
    controls.slider({
      label: layer,
      min: 0,
      max: 1,
      step: 0.01,
      value: mixer.layers[layer],
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        mixer.layers[layer] = v;
      },
      read: () => mixer.layers[layer],
    });
  }

  controls.buttons([
    {
      label: 'All to unity',
      title: 'Reset every voice trim and clear the solo',
      onClick: () => {
        for (const layer of SOUND_LAYERS) mixer.layers[layer] = 1;
        ambience.setSolo(null);
      },
    },
  ]);

  controls.section('Live');
  const readout = controls.readout();

  return {
    element: root,
    update(): void {
      controls.sync();
      readout.textContent = describe(ambience);
    },
    dispose(): void {
      root.remove();
    },
  };
}

/**
 * The live readout: what the world is doing, and what it produced.
 *
 * Deliberately shows the *driver* beside the gain for each voice. A gain of
 * zero with a driver of zero is the system working; a gain of zero with a
 * driver of nine is a bug, and the two look identical in a meter.
 */
function describe(ambience: Ambience): string {
  const state = ambience.worldState;
  const levels = ambience.voiceLevels;
  const driver: Record<SoundLayerName, number> = {
    swell: state.significantHeightM,
    breakers: state.whitecapCoverage,
    rigging: state.apparentWindMps,
    cloth: state.shakingClothAreaM2,
    bow: state.speedThroughWaterMps,
    hull: state.hullWorkRateRadPerS,
  };
  const gain: Record<SoundLayerName, number> = {
    swell: levels.swell.gain,
    breakers: levels.breakers.gain,
    rigging: levels.rigging.gain,
    cloth: levels.cloth.gain,
    bow: levels.bow.gain,
    hull: levels.hull.gain,
  };
  const frequency: Record<SoundLayerName, number> = {
    swell: levels.swell.cutoffHz,
    breakers: levels.breakers.centreHz,
    rigging: levels.rigging.centreHz,
    cloth: levels.cloth.centreHz,
    bow: levels.bow.centreHz,
    hull: levels.hull.centreHz,
  };

  const rows = SOUND_LAYERS.map((layer) => {
    const bar = '#'.repeat(Math.round(gain[layer] * 18)).padEnd(18, '.');
    return [
      layer.padEnd(9),
      bar,
      gain[layer].toFixed(3).padStart(6),
      `${Math.round(frequency[layer])}`.padStart(6),
      `  ${DRIVER_LABEL[layer]} ${driver[layer].toFixed(2)}`,
    ].join(' ');
  });

  return [
    `context   ${ambience.isRunning ? 'running' : 'absent (silent)'}`,
    `listener  ${state.mode}  ${state.vesselDistanceM.toFixed(1)} m from her`,
    `room      ${state.room ?? 'open air'}   air ${levels.air.gain.toFixed(2)} @ ${Math.round(levels.air.cutoffHz)} Hz`,
    `closures  boards ${state.hatchwayBoardsOpen ? 'up' : 'laid'}   scuttle ${state.foreScuttleLidOpen ? 'open' : 'shut'}`,
    `bow pan   ${levels.bow.pan >= 0 ? '+' : ''}${levels.bow.pan.toFixed(2)}   slat ${levels.cloth.slatHz.toFixed(2)} Hz`,
    `master    ${levels.master.toFixed(3)}`,
    '',
    'voice     level              gain     Hz   driver',
    ...rows,
  ].join('\n');
}
