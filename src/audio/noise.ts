/**
 * Deterministic noise for the sound graph.
 *
 * Every voice in `SoundGraph` is one of these buffers played back at a
 * different rate through a different filter, so this file is the only place
 * the sound of the game is actually *generated*. It contains no `AudioContext`
 * and no `Math.random()`: given a seed it writes the same samples on every
 * machine, in node and in the browser alike, which is what lets a test assert
 * on the waveform rather than on the fact that a buffer exists.
 *
 * The seed matters for more than tidiness. A seeded trace is this project's
 * whole contract — `WorldWind` opens by saying it has no `Math.random()`, and
 * the audio sat twenty lines away calling it. If a session is ever replayed
 * from a seed, the hiss has to come back the same or the recording is of a
 * different sea.
 */

/**
 * 32-bit mixing PRNG (mulberry32).
 *
 * Chosen over a linear congruential generator because the low bits of an LCG
 * are visibly periodic, and a noise buffer is exactly the place where a weak
 * low bit becomes an audible tone. Its state is one integer, so a voice can
 * carry its own stream without allocating.
 */
export function createNoiseRandom(seed: number): () => number {
  // Force the seed into an unsigned 32-bit word so a float, a negative number
  // or a string-derived hash all behave.
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeds, named once, so two voices never accidentally share a waveform. */
export const NOISE_SEED = Object.freeze({
  /** The long, slow-moving buffer the sea and the rigging both draw on. */
  broadband: 0x53_45_41_00,
  /** A second, decorrelated buffer so two layers do not phase-lock. */
  broadbandAlt: 0x53_45_41_01,
  /** One-shot low thunder; separate so a strike never reveals a sea-loop phase. */
  thunder: 0x54_48_4e_44,
});

/**
 * Default buffer length, seconds.
 *
 * Long enough that the loop is not a rhythm — a 5 s loop under a slow fade is
 * audible as a pulse once you know to listen for it — and short enough that
 * three of them are a few megabytes rather than tens.
 */
export const NOISE_SECONDS = 11;

/**
 * How much of the previous sample each new one keeps.
 *
 * A one-pole leaky integrator on white noise tilts the spectrum by about
 * −6 dB/octave above its corner; pink is −3, so this is browner than pink and
 * deliberately so. Sea noise measured at a ship's rail is dominated by the
 * low end, and a true-white hiss reads as a radio rather than as water. The
 * corner sits at roughly `(1 - POLE) * sampleRate / (2 pi)` — about 460 Hz at
 * 48 kHz — so everything the wash cares about is on the tilted slope.
 */
const POLE = 0.94;

/**
 * Gain restoring unit-ish variance after the integrator eats it.
 *
 * A one-pole filter with coefficient `a` on unit-variance white noise leaves
 * variance `(1-a)^2 / (1-a^2)`; the reciprocal square root of that is 5.61 at
 * a = 0.94. Rounded down slightly so the tail of the distribution does not
 * clip the float buffer on a long run.
 */
const INTEGRATOR_GAIN = 5.2;

/**
 * Fill `out` with seeded, spectrally tilted noise and a seamless loop point.
 *
 * The caller owns the array, so this works on a `Float32Array` obtained from
 * an `AudioBuffer` in the browser and on a plain one in a test. Returns `out`
 * for convenience.
 */
export function fillNoise(out: Float32Array, seed: number): Float32Array {
  const length = out.length;
  if (length === 0) return out;

  const random = createNoiseRandom(seed);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = random() * 2 - 1;
    last = POLE * last + (1 - POLE) * white;
    out[i] = last * INTEGRATOR_GAIN;
  }

  // Cross-fade the head into the tail so the loop seam is not a click. An
  // eighth of the buffer is the ceiling; below that the fade is 0.1 s, which
  // is long against the integrator's own memory and short against the loop.
  const fade = Math.min(Math.floor(length * 0.05), Math.floor(length / 8));
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    out[i] = out[i] * k + out[length - fade + i] * (1 - k);
  }
  return out;
}

/**
 * Peak absolute sample, for tests and for a sanity check before upload.
 *
 * The integrator's output is unbounded in principle; in practice it settles
 * near ±1. A voice that came back at 12 would be a coefficient typo, and this
 * is how the test says so.
 */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i]);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}
