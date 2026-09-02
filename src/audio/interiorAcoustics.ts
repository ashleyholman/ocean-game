/**
 * How much of the outside a room lets in.
 *
 * This mirrors the interior *light* model deliberately and at one specific
 * point: the runtime lever is a per-opening gate, and the gate is the closure
 * table, read through `isClosureOpen`. There is no second notion of "is it
 * open" anywhere in the audio system. `Schooner.publishPortalLight` zeroes
 * `CHANNEL_SCUTTLE`'s irradiance when the lid is shut; this file shuts the
 * same opening for sound, from the same boolean.
 *
 * What it does *not* borrow is the light model's numbers, and it must not.
 * Two reasons, both physical:
 *
 * - **A grating is opaque to light and transparent to sound.** The hatchway's
 *   grating passes its open-cell fraction of the daylight and essentially all
 *   of the noise, because audible wavelengths are 0.02–17 m and the lattice
 *   pitch is centimetres. The cabin's crown glass is the mirror image: it
 *   passes 0.65 of the light and almost none of the sea.
 * - **Light attenuates by geometry, sound by transmission loss.** The light
 *   solve is a radiosity transfer built from form factors; a boarded hold is
 *   dark because no photon path exists. A boarded hold is *quiet* because
 *   30 mm of oak has a transmission loss of tens of decibels — but it is not
 *   silent, and the sound that does get through has lost its top end first.
 *   That is what "muffled" means, and it is why the openness below drives a
 *   filter cutoff as well as a gain.
 *
 * Every number here is authored by ear-less reasoning about deal boards and
 * open hatches. They are feel numbers in the same sense the crew's timings
 * are, and Ash is the one who gets to say whether the hold is dead enough.
 */

import type { SoundRoomName } from './soundState';

/**
 * How open each room is to the outside when nothing is shut, 0..1.
 *
 * 1 is standing on the weather deck. These are the *base* values; the two
 * gated closures multiply into them at runtime.
 *
 * - `landing` — the foot of the companionway, and the companionway has no
 *   door. A permanently open 1.2 m² hole two metres from your head; you hear
 *   the sea nearly as well as on deck, which is exactly why the officer of
 *   the watch could be called from it.
 * - `wardroom` — under the cargo hatchway, which carries a grating. Acoustically
 *   an open hole (see above), set below the landing only because it is deeper
 *   in the hull and further from the rail.
 * - `cabin` — stern windows that do not open, plus the doorway to the landing.
 *   Almost everything it hears has come round a corner.
 * - `forecastle` — the scuttle when the lid is up; the wardroom doorway when
 *   it is down.
 * - `hold` — nothing of its own. It hears the wardroom through the boards,
 *   and only when they are lifted.
 */
const BASE_OPENNESS: Readonly<Record<SoundRoomName, number>> = Object.freeze({
  landing: 0.62,
  wardroom: 0.44,
  cabin: 0.24,
  forecastle: 0.20,
  hold: 0.05,
});

/**
 * How open each room becomes when its own closure is opened.
 *
 * Only two rooms have one. Shutting a closure does not take a room to zero —
 * it takes it back to whatever leaks through the doorways and the deck seams,
 * which is `BASE_OPENNESS`. That asymmetry is the same one the scuttle's light
 * channel comment records: a gate must not be allowed to remove a path the
 * room had before the gate existed.
 */
const OPENED_OPENNESS: Readonly<Partial<Record<SoundRoomName, number>>> =
  Object.freeze({
    /** Lid up: a 0.6 m hole straight to the weather deck, over your head. */
    forecastle: 0.58,
    /** Boards lifted: the hold hears the wardroom, and the wardroom hears the sky. */
    hold: 0.30,
  });

/** Cutoff of the muffling lowpass when a room is completely shut up, Hz. */
export const MUFFLED_CUTOFF_HZ = 170;

/**
 * Cutoff when the listener is in the open air, Hz.
 *
 * Above the audible band on purpose: at full openness the muffling filter must
 * be a no-op, not a tone control that quietly darkens the whole game.
 */
export const OPEN_CUTOFF_HZ = 19000;

/**
 * How much of an air-borne voice survives a completely shut room.
 *
 * Not zero. A ship at sea with every hatch on is still full of the sea; you
 * simply cannot hear the top of it any more.
 */
export const SEALED_AIR_GAIN = 0.14;

/**
 * How much louder the hull's own working gets when you are inside it.
 *
 * The one voice that goes *up* below decks. Sitting in the wardroom you are
 * inside the sound box: the working of futtocks and knees arrives through the
 * timber against your back rather than through the air, and it is the loudest
 * thing in the ship. Shutting the hatch does not quiet it — shutting the hatch
 * takes away its competition.
 */
export const STRUCTURE_BORNE_GAIN = 2.1;

export interface RoomAcoustics {
  /** 0 = sealed, 1 = standing on deck. */
  readonly openness: number;
  /** Gain multiplier for anything arriving through the air. */
  readonly airGain: number;
  /** Cutoff of the muffling lowpass, Hz. */
  readonly cutoffHz: number;
  /** Gain multiplier for anything arriving through the timber. */
  readonly structureGain: number;
}

/**
 * Resolve a room and the closure booleans into what the listener hears.
 *
 * `room === null` is the open air and is the identity: openness 1, unity gain,
 * cutoff above the band. Passing a room the ship does not have is treated as
 * the open air rather than throwing, because an audio system that crashes the
 * frame loop over an unrecognised room name is a worse failure than one that
 * forgets to muffle.
 */
export function roomAcoustics(
  room: SoundRoomName | null,
  closures: { hatchwayBoardsOpen: boolean; foreScuttleLidOpen: boolean },
): RoomAcoustics {
  if (room === null) {
    return {
      openness: 1,
      airGain: 1,
      cutoffHz: OPEN_CUTOFF_HZ,
      structureGain: 1,
    };
  }

  const base = BASE_OPENNESS[room];
  if (base === undefined) {
    return {
      openness: 1,
      airGain: 1,
      cutoffHz: OPEN_CUTOFF_HZ,
      structureGain: 1,
    };
  }

  let openness = base;
  if (room === 'forecastle' && closures.foreScuttleLidOpen) {
    openness = OPENED_OPENNESS.forecastle!;
  } else if (room === 'hold' && closures.hatchwayBoardsOpen) {
    openness = OPENED_OPENNESS.hold!;
  }

  return {
    openness,
    airGain: SEALED_AIR_GAIN + (1 - SEALED_AIR_GAIN) * openness,
    cutoffHz: cutoffForOpenness(openness),
    structureGain: STRUCTURE_BORNE_GAIN,
  };
}

/**
 * Openness to a filter cutoff, geometrically rather than linearly.
 *
 * Pitch is logarithmic, so a linear interpolation between 170 Hz and 19 kHz
 * spends nine tenths of the slider in the top octave and the door appears to
 * slam shut at the very end of its travel. A geometric interpolation makes
 * equal steps of openness equal numbers of octaves, which is what "half as
 * muffled" has to mean.
 *
 * Strictly increasing in `openness`, exact at both ends.
 */
export function cutoffForOpenness(openness: number): number {
  const t = openness <= 0 ? 0 : openness >= 1 ? 1 : openness;
  return MUFFLED_CUTOFF_HZ * (OPEN_CUTOFF_HZ / MUFFLED_CUTOFF_HZ) ** t;
}

/** The rooms this model knows, for tests and the dev panel's readout. */
export const SOUND_ROOMS: readonly SoundRoomName[] = Object.freeze(
  Object.keys(BASE_OPENNESS) as SoundRoomName[],
);
