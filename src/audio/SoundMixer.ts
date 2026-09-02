/**
 * The audio A/B switch.
 *
 * This project settles every look question by pulling one thing out and
 * putting it back, and there is no reason sound should be the exception —
 * except that until now there was nothing to pull. A wash and a hiss summed
 * into one master gain can only be judged as a whole, and "it sounds wrong"
 * is not a finding anybody can act on.
 *
 * So: a trim per voice, a solo, and a mute, all session-only, all live, none
 * of them ever written back into canonical state. They are resolved inside
 * `resolveVoices` rather than applied to the graph afterwards, which means the
 * numbers a test asserts on are the numbers the panel produces.
 *
 * This file imports nothing. `soundMapping` imports the layer names from here
 * rather than the other way round, so there is no cycle between the mapping
 * and the thing that trims it.
 */

/**
 * The six voices, in the order the panel lists them.
 *
 * Two fields (`swell`, `breakers`) then four sources (`rigging`, `cloth`,
 * `bow`, `hull`) — the same split that decides which of them the distance law
 * applies to. See `shipAudibility`.
 */
export const SOUND_LAYERS = [
  'swell',
  'breakers',
  'rigging',
  'cloth',
  'bow',
  'hull',
] as const;

export type SoundLayerName = (typeof SOUND_LAYERS)[number];

export interface SoundMixerTrims {
  /** Master gain, 0..1. */
  master: number;
  /** True while the whole thing is silent. Starts true — see `Ambience`. */
  muted: boolean;
  /** Per-voice trim, 0..1, multiplying the mapped gain. */
  layers: Record<SoundLayerName, number>;
  /** When set, every other voice is silent. The inspection lever. */
  solo: SoundLayerName | null;
}

/**
 * Master gain when unmuted.
 *
 * Inherited unchanged from the raft-era ambience so this round does not
 * silently change how loud the game is while it is changing what the game is
 * made of. If it is wrong it should be wrong the same amount as before.
 */
export const DEFAULT_MASTER_GAIN = 0.22;

export function createSoundMixerTrims(): SoundMixerTrims {
  return {
    master: DEFAULT_MASTER_GAIN,
    // Browsers block audio before a gesture and this project's harnesses run
    // without one, so silence is the only correct initial state.
    muted: true,
    layers: {
      swell: 1,
      breakers: 1,
      rigging: 1,
      cloth: 1,
      bow: 1,
      hull: 1,
    },
    solo: null,
  };
}
