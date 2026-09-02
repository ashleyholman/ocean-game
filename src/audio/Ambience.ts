/**
 * The sound of the game, as the composition root holds it.
 *
 * This class is a façade over four things that are each testable on their own:
 * a `SoundSampler` that reads canonical state, the pure `resolveVoices`
 * mapping, a `SoundMixer` of live trims, and a `SoundGraph` that may or may
 * not have an `AudioContext` behind it. Its own logic is four lines.
 *
 * The name is inherited. It was accurate when the whole system was a wash and
 * a hiss; it is now the ship as well as the weather, and a later round may
 * well rename it. It is kept for this one because `main.ts` and
 * `ProductionSimulationRuntime` are contended files and a rename would touch
 * both for no behavioural gain.
 *
 * WHAT HAPPENS WITH NO AUDIO AT ALL
 * ---------------------------------
 * `update` still runs the sampler and the mapping. That is deliberate and not
 * waste: the dev panel reads the resolved levels, so Ash can watch the six
 * voices respond to the sea with the sound muted or before he has clicked
 * anything, and a test can assert on a whole frame's worth of mapping without
 * a browser. Only `SoundGraph.apply` is a no-op, and only because there is
 * nothing to write to.
 */

import type { SeaState } from '../ocean/seaState';
import { SoundGraph } from './SoundGraph';
import {
  createSoundMixerTrims,
  type SoundLayerName,
  type SoundMixerTrims,
} from './SoundMixer';
import {
  createSoundVoiceLevels,
  resolveVoices,
  type SoundVoiceLevels,
} from './soundMapping';
import { SoundSampler, type SoundSamplerPorts } from './SoundSampler';
import { createSoundWorldState, type SoundWorldState } from './soundState';

export class Ambience {
  private readonly graph = new SoundGraph();
  private readonly trims: SoundMixerTrims = createSoundMixerTrims();
  private readonly levels: SoundVoiceLevels = createSoundVoiceLevels();
  /** Used until a sampler is attached, so `update` is always well defined. */
  private readonly fallbackState: SoundWorldState = createSoundWorldState();
  private sampler: SoundSampler | undefined;
  private sampledState: Readonly<SoundWorldState>;

  constructor() {
    this.sampledState = this.fallbackState;
  }

  get isMuted(): boolean {
    return this.trims.muted;
  }

  /** Live trims, for the dev shell. Session-only; never canonical state. */
  get mixer(): SoundMixerTrims {
    return this.trims;
  }

  /** This frame's resolved levels, for the dev shell's meters. */
  get voiceLevels(): Readonly<SoundVoiceLevels> {
    return this.levels;
  }

  /** The state the mapping last saw, for the dev shell's readout. */
  get worldState(): Readonly<SoundWorldState> {
    return this.sampledState;
  }

  /** True once a context exists. False in node, and before the first gesture. */
  get isRunning(): boolean {
    return this.graph.running;
  }

  /**
   * Give the ambience the world to listen to.
   *
   * Separate from the constructor because `main.ts` builds this object early —
   * the input controller needs it to bind the mute key and the first-gesture
   * start — while the vessel, camera and waves it listens to do not exist yet
   * at that point.
   */
  attachWorld(ports: SoundSamplerPorts): void {
    this.sampler = new SoundSampler(ports);
  }

  /** Build the audio graph. Called from the first user gesture. */
  start(): void {
    this.graph.start(this.trims.muted ? 0 : this.trims.master);
  }

  toggleMute(): void {
    this.trims.muted = !this.trims.muted;
  }

  /** Render a storm controller's already-delayed one-shot thunder cue. */
  triggerThunder(intensity: number, distanceM: number): void {
    this.graph.triggerThunder(intensity, distanceM);
  }

  /** Solo one voice, or `null` for the whole mix. The A/B lever. */
  setSolo(layer: SoundLayerName | null): void {
    this.trims.solo = layer;
  }

  /**
   * One frame: read the world, map it, write it.
   *
   * `sea` and `whitecapCoverage` come from the caller because the frame
   * transaction has already resolved both, and every phase must see the same
   * sea instant.
   */
  update(sea: Readonly<SeaState>, whitecapCoverage: number): void {
    this.sampledState =
      this.sampler?.sample(sea, whitecapCoverage) ?? this.fallbackState;
    resolveVoices(this.sampledState, this.trims, this.levels);
    this.graph.apply(this.levels);
  }

  dispose(): void {
    this.graph.dispose();
  }
}
