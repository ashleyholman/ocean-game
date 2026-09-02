/** Deterministic lightning/thunder event policy, with no rendering or Web Audio. */

export const THUNDER_SPEED_OF_SOUND_MPS = 343;
export const STORM_EVENT_SLOT_SECONDS = 11;
export const STORM_EVENT_SEED = 0x53544f52; // 'STOR'

export interface StormEvent {
  readonly id: number;
  readonly flashAtSeconds: number;
  readonly thunderAtSeconds: number;
  readonly distanceM: number;
  readonly bearingRad: number;
  readonly intensity: number;
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/** A stable draw in [0, 1), keyed only by seed, slot and channel. */
export function stormHash01(slot: number, channel: number, seed = STORM_EVENT_SEED): number {
  const word =
    (seed ^ Math.imul((slot | 0) + 0x9e3779b9, 0x85ebca6b) ^
      Math.imul((channel | 0) + 1, 0xc2b2ae35)) >>>
    0;
  return mix32(word) / 0x1_0000_0000;
}

export function thunderDelaySeconds(distanceM: number): number {
  if (!Number.isFinite(distanceM) || distanceM < 0) {
    throw new RangeError(`thunder distance must be finite and >= 0, got ${distanceM}`);
  }
  return distanceM / THUNDER_SPEED_OF_SOUND_MPS;
}

/**
 * One possible event in a fixed time slot. Zero activity is exactly empty;
 * otherwise activity changes only the admission threshold, never event shape.
 */
export function stormEventForSlot(
  slot: number,
  electricalActivity: number,
  seed = STORM_EVENT_SEED,
): StormEvent | null {
  const activity = Math.min(1, Math.max(0, electricalActivity));
  if (activity === 0 || stormHash01(slot, 0, seed) >= activity * 0.82) return null;

  const flashAtSeconds =
    slot * STORM_EVENT_SLOT_SECONDS +
    0.7 +
    stormHash01(slot, 1, seed) * (STORM_EVENT_SLOT_SECONDS - 1.4);
  const distanceShape = stormHash01(slot, 2, seed);
  const distanceM = 320 + distanceShape * distanceShape * 1380;
  const bearingRad = stormHash01(slot, 3, seed) * Math.PI * 2;
  const intensity = 0.68 + stormHash01(slot, 4, seed) * 0.32;
  return {
    id: slot,
    flashAtSeconds,
    thunderAtSeconds: flashAtSeconds + thunderDelaySeconds(distanceM),
    distanceM,
    bearingRad,
    intensity,
  };
}

/** A deterministic manual strike used by the Weather panel's review button. */
export function manualStormEvent(
  flashAtSeconds: number,
  sequence: number,
  seed = STORM_EVENT_SEED,
): StormEvent {
  const id = -1 - sequence;
  const distanceShape = stormHash01(sequence, 12, seed);
  const distanceM = 420 + distanceShape * 880;
  return {
    id,
    flashAtSeconds,
    thunderAtSeconds: flashAtSeconds + thunderDelaySeconds(distanceM),
    distanceM,
    bearingRad: stormHash01(sequence, 13, seed) * Math.PI * 2,
    intensity: 0.82 + stormHash01(sequence, 14, seed) * 0.18,
  };
}

/** Two short pulses, completed in 240 ms; pure so render rate cannot reshape it. */
export function lightningEnvelope(secondsSinceFlash: number): number {
  if (secondsSinceFlash < 0 || secondsSinceFlash >= 0.24) return 0;
  if (secondsSinceFlash < 0.055) {
    return Math.sin((secondsSinceFlash / 0.055) * Math.PI);
  }
  if (secondsSinceFlash < 0.09) return 0.12;
  const t = (secondsSinceFlash - 0.09) / 0.15;
  return 0.58 * Math.sin(t * Math.PI);
}
