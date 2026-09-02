/**
 * The Web Audio graph. Deliberately the thinnest part of the system.
 *
 * Every number this file writes was decided in `soundMapping.ts`. It contains
 * no curve, no threshold and no policy — only wiring, and the discipline of
 * writing each parameter through `setTargetAtTime` so nothing zippers.
 *
 * THE NO-CONTEXT PATH IS THE NORMAL PATH
 * --------------------------------------
 * There are four situations in which this class must produce silence and must
 * not throw, and only one of them is a failure:
 *
 * - the test environment is node and there is no `AudioContext` at all;
 * - the browser has not seen a user gesture yet, so autoplay is blocked;
 * - the player has muted;
 * - construction genuinely failed.
 *
 * They are handled identically — `context === undefined` and every method
 * returns early — because a frame loop must not care which one it is in. The
 * visual scene has run from the first frame since the raft, and audio that can
 * take the frame loop down with it would be a strictly worse trade than no
 * audio at all.
 *
 * ALLOCATION
 * ----------
 * `apply` is called once per rendered frame and allocates nothing. The buffers
 * are built once in `start`.
 */

import { NOISE_SEED, NOISE_SECONDS, fillNoise } from './noise';
import type { SoundVoiceLevels } from './soundMapping';

/** How fast a voice's gain chases its target, seconds. */
const GAIN_TAU = 0.35;
/** How fast a filter's corner moves, seconds. Slower: a sweep is conspicuous. */
const FREQUENCY_TAU = 0.5;
/** How fast the enclosure follows the listener through a hatchway, seconds. */
const ENCLOSURE_TAU = 0.30;
/** How fast the bow's pan follows the head, seconds. */
const PAN_TAU = 0.25;
/** The opening fade after the first gesture, seconds. Inherited unchanged. */
const START_TAU = 2.5;
/** How fast the master follows a mute, seconds. */
const MASTER_TAU = 0.35;

/**
 * Playback rates, one per voice.
 *
 * Two seeded buffers feed six voices, so the rates exist to keep any two of
 * them from walking in step. They are mutually irrational-ish rather than
 * simple ratios for exactly that reason: 0.5 and 1.0 would re-align every
 * loop and put a beat under the whole mix.
 */
const RATE = Object.freeze({
  swell: 1.0,
  breakers: 1.31,
  rigging: 0.61,
  cloth: 0.83,
  bow: 1.37,
  hull: 0.29,
});

/** Filter resonance per voice. Higher is narrower and more tonal. */
const Q = Object.freeze({
  swell: 0.6,
  breakers: 0.45,
  /** The rig is the one thing allowed to approach a pitch. */
  rigging: 1.2,
  cloth: 0.7,
  bow: 0.6,
  /** A groan is nearly a note. */
  hull: 2.2,
});

/** How deep the cloth's slat modulation cuts, as a fraction of its gain. */
const CLOTH_MODULATION_DEPTH = 0.45;

interface Voice {
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  /** `frequency` is a cutoff on the swell and a centre on the rest. */
  readonly frequency: AudioParam;
}

type AudioContextConstructor = new () => AudioContext;

export class SoundGraph {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private airFilter: BiquadFilterNode | undefined;
  private airGain: GainNode | undefined;
  private voices: Record<string, Voice> | undefined;
  private clothLfo: OscillatorNode | undefined;
  private bowPanner: StereoPannerNode | undefined;
  private thunderBuffer: AudioBuffer | undefined;
  private started = false;

  /** True once a context exists and the graph is playing (possibly at zero). */
  get running(): boolean {
    return this.context !== undefined;
  }

  /** For the dev panel's readout; `null` before there is a context. */
  get sampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }

  /**
   * Build the graph. Idempotent, and safe to call where no audio exists.
   *
   * Must be called from a user gesture in a browser; calling it earlier is not
   * an error, it simply produces a context that never leaves `suspended`.
   */
  start(initialMaster: number): void {
    if (this.started) return;
    this.started = true;

    const ctx = createContext();
    if (!ctx) return;
    this.context = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.master = master;

    // The enclosure bus: everything that reaches the ear through the air goes
    // through one lowpass and one gain, because muffling is a property of the
    // room and not of each source.
    const airFilter = ctx.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 19000;
    airFilter.Q.value = 0.7;
    const airGain = ctx.createGain();
    airGain.gain.value = 1;
    airFilter.connect(airGain).connect(master);
    this.airFilter = airFilter;
    this.airGain = airGain;

    const broadband = makeNoiseBuffer(ctx, NOISE_SEED.broadband);
    const alternate = makeNoiseBuffer(ctx, NOISE_SEED.broadbandAlt);
    this.thunderBuffer = makeNoiseBuffer(ctx, NOISE_SEED.thunder);

    const voices: Record<string, Voice> = {};

    // --- the sea, arriving through the air ---------------------------------
    voices.swell = this.addVoice(ctx, broadband, RATE.swell, 'lowpass', Q.swell, airFilter);
    voices.breakers = this.addVoice(
      ctx, alternate, RATE.breakers, 'bandpass', Q.breakers, airFilter,
    );

    // --- the ship, arriving through the air --------------------------------
    voices.rigging = this.addVoice(
      ctx, broadband, RATE.rigging, 'bandpass', Q.rigging, airFilter,
    );

    // Cloth is the one voice with a rhythm. Its gain node feeds a second gain
    // whose parameter an oscillator is summed into: a Web Audio `AudioParam`
    // adds every connected signal to its own value, so a 0.55 intrinsic and a
    // ±0.45 sine give a voice that beats between a tenth and full without a
    // `ConstantSourceNode` and without a per-frame JavaScript envelope.
    const clothVca = ctx.createGain();
    clothVca.gain.value = 1 - CLOTH_MODULATION_DEPTH;
    clothVca.connect(airFilter);
    voices.cloth = this.addVoice(ctx, alternate, RATE.cloth, 'bandpass', Q.cloth, clothVca);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 1;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = CLOTH_MODULATION_DEPTH;
    lfo.connect(lfoDepth).connect(clothVca.gain);
    lfo.start();
    this.clothLfo = lfo;

    // The bow is the only placed source, so it is the only one behind a panner.
    // `createStereoPanner` is feature-detected rather than assumed: where it is
    // missing the bow simply plays centred, which is a fair description of a
    // bow wave heard from anywhere on a 15 m deck.
    const panner =
      typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : undefined;
    if (panner) {
      panner.connect(airFilter);
      this.bowPanner = panner;
    }
    voices.bow = this.addVoice(
      ctx, broadband, RATE.bow, 'bandpass', Q.bow, panner ?? airFilter,
    );

    // --- the ship, arriving through the timber -----------------------------
    // Straight to the master, deliberately bypassing the enclosure bus: the
    // hull's groan does not come in through the hatch, it comes in through the
    // frame you are leaning on, and shutting the hatch cannot muffle it.
    voices.hull = this.addVoice(ctx, alternate, RATE.hull, 'bandpass', Q.hull, master);

    this.voices = voices;

    void ctx.resume();
    master.gain.setTargetAtTime(initialMaster, ctx.currentTime, START_TAU);
  }

  /**
   * Write one frame of resolved levels onto the graph.
   *
   * A no-op with no context, which is the node path and the pre-gesture path.
   */
  apply(levels: Readonly<SoundVoiceLevels>): void {
    const ctx = this.context;
    const voices = this.voices;
    const master = this.master;
    if (!ctx || !voices || !master) return;

    const now = ctx.currentTime;

    setVoice(voices.swell, levels.swell.gain, levels.swell.cutoffHz, now);
    setVoice(voices.breakers, levels.breakers.gain, levels.breakers.centreHz, now);
    setVoice(voices.rigging, levels.rigging.gain, levels.rigging.centreHz, now);
    setVoice(voices.cloth, levels.cloth.gain, levels.cloth.centreHz, now);
    setVoice(voices.bow, levels.bow.gain, levels.bow.centreHz, now);
    setVoice(voices.hull, levels.hull.gain, levels.hull.centreHz, now);

    this.clothLfo?.frequency.setTargetAtTime(levels.cloth.slatHz, now, GAIN_TAU);
    this.bowPanner?.pan.setTargetAtTime(levels.bow.pan, now, PAN_TAU);

    this.airGain?.gain.setTargetAtTime(levels.air.gain, now, ENCLOSURE_TAU);
    this.airFilter?.frequency.setTargetAtTime(levels.air.cutoffHz, now, ENCLOSURE_TAU);

    master.gain.setTargetAtTime(levels.master, now, MASTER_TAU);
  }

  /**
   * Play one already-delayed thunder cue.
   *
   * Scheduling belongs to the deterministic storm controller. This method is
   * deliberately only a one-shot renderer: distance shapes attenuation and
   * bandwidth, while the caller decides *when* speed-of-sound delay expires.
   * Like every graph method it is a safe no-op before the first gesture.
   */
  triggerThunder(intensity: number, distanceM: number): void {
    const ctx = this.context;
    const master = this.master;
    const buffer = this.thunderBuffer;
    if (!ctx || !master || !buffer) return;

    const strength = Math.min(1, Math.max(0, intensity));
    const distance = Math.max(0, Number.isFinite(distanceM) ? distanceM : 0);
    if (strength === 0) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // More distant thunder is broader and slower, without a random pitch draw.
    source.playbackRate.value = 0.58 + 0.18 / (1 + distance / 900);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.72;
    filter.frequency.value = 420 + 1050 / (1 + distance / 650);

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const peak = strength * (0.56 / (1 + distance / 1150));
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.055);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 4.2);

    // Thunder arrives through the air, so a listener below decks hears the
    // same enclosure low-pass/gain as every other exterior source.
    source.connect(filter).connect(gain).connect(this.airFilter ?? master);
    source.start(now);
    source.stop(now + 4.25);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  /** Release the context. Safe to call when there never was one. */
  dispose(): void {
    const ctx = this.context;
    this.context = undefined;
    this.voices = undefined;
    this.master = undefined;
    this.airFilter = undefined;
    this.airGain = undefined;
    this.clothLfo = undefined;
    this.bowPanner = undefined;
    this.thunderBuffer = undefined;
    if (!ctx) return;
    try {
      void ctx.close();
    } catch {
      // A context that refuses to close is not worth taking the page down for.
    }
  }

  private addVoice(
    ctx: AudioContext,
    buffer: AudioBuffer,
    rate: number,
    type: BiquadFilterType,
    q: number,
    destination: AudioNode,
  ): Voice {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rate;

    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter).connect(gain).connect(destination);
    source.start();

    return { filter, gain, frequency: filter.frequency };
  }
}

function setVoice(voice: Voice, gain: number, frequencyHz: number, now: number): void {
  voice.gain.gain.setTargetAtTime(gain, now, GAIN_TAU);
  voice.frequency.setTargetAtTime(frequencyHz, now, FREQUENCY_TAU);
}

/**
 * Seeded noise into an `AudioBuffer`.
 *
 * The seed is the whole point: `fillNoise` writes the same samples on every
 * machine, so this buffer is a function of the sample rate alone.
 */
function makeNoiseBuffer(ctx: AudioContext, seed: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * NOISE_SECONDS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  fillNoise(buffer.getChannelData(0), seed);
  return buffer;
}

/** Find and construct a context, or return undefined without complaining. */
function createContext(): AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) return undefined;
  try {
    return new Ctor();
  } catch {
    return undefined;
  }
}
