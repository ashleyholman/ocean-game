/**
 * Everything the sound of the game is allowed to depend on.
 *
 * This record is the boundary. `SoundSampler` fills it from canonical state
 * once a frame; `soundMapping.ts` turns it into gains and cutoffs and knows
 * nothing else. Two consequences fall out of that, and both are the point:
 *
 * - **Audio is never a second source of truth.** There is no wind speed in
 *   here that was not read from `WorldWind`, no wave height that was not read
 *   from `WaveField`, no whitecap coverage that was not read from the value
 *   the ocean phase had already computed for the foam. If a field cannot be
 *   traced back to an owner named in `RUNTIME_ARCHITECTURE.md`, it does not
 *   belong in this file.
 * - **The whole mapping is testable in node.** Nothing here is a Three.js
 *   object, an `AudioContext`, or a live mutated vector borrowed from another
 *   system. It is plain numbers, so a test can set a dead calm or a storm by
 *   writing eighteen fields.
 *
 * One record is retained and rewritten each frame. Nothing in the frame path
 * allocates.
 */

import type { LightRoomName } from '../vessel/schooner/interiorLight';

/**
 * The room the listener is in, or `null` in the open air.
 *
 * Deliberately the *same* type the interior lighting solves over, imported
 * rather than restated: five rooms is a fact about the ship, and a second
 * hand-written copy of the list would drift the first time a sixth appears.
 */
export type SoundRoomName = LightRoomName;

/** Which camera the listener is riding. Reported, not used as a lever — see the handover. */
export type SoundListenerMode = 'cinematic' | 'embodied';

export interface SoundWorldState {
  // --- the listener --------------------------------------------------------
  mode: SoundListenerMode;
  /**
   * Distance from the listener to the vessel, metres.
   *
   * Slant, not ground: a camera 267 m above the ship at full zoom is far from
   * it even though its ground distance is what the ocean disc cares about.
   */
  vesselDistanceM: number;
  /** The room the listener's *ear* is in, from its ship-local position. */
  room: SoundRoomName | null;
  /**
   * Bearing of the vessel's bow from the listener's facing, radians.
   *
   * 0 is dead ahead, +π/2 is to the listener's right, −π/2 to the left. Only
   * the bow-water voice uses it; see `bowPan`.
   */
  bowBearingRad: number;

  // --- the sea -------------------------------------------------------------
  /** `WaveField.significantHeight`, metres. The resolved spectrum's Hs. */
  significantHeightM: number;
  /** `WaveField.dominantPeriod`, seconds. */
  dominantPeriodS: number;
  /** Monahan coverage fraction, as the ocean phase already computed it. */
  whitecapCoverage: number;
  /** `SeaState.whitewater.generation`; the preset's foam-rate multiplier. */
  whitewaterGeneration: number;

  // --- the wind ------------------------------------------------------------
  /**
   * Apparent wind at the hull, m/s — what the rig actually feels.
   *
   * *Apparent*, emphatically: a schooner running before a gale has a quiet
   * rig, and a true-wind-driven hiss would get that exactly backwards. This
   * comes from `SailAeroResult.hullApparentSpeedMps`, which is built on the
   * deterministic instantaneous wind, so the gusts arrive for free and no
   * gust process is duplicated here.
   */
  apparentWindMps: number;

  // --- the rig -------------------------------------------------------------
  /** Cloth set and evaluated this frame, m². Zero when everything is furled. */
  setClothAreaM2: number;
  /**
   * Cloth actually in motion, m².
   *
   * Already weighted by `sailShakeFraction` — a continuous 0..1 per sail that
   * folds in the attachment curve, the aback case, the blanketing and the
   * wind. So this is not "the area of the sails that are luffing"; it is how
   * much canvas is thundering, and it falls to zero in a calm on its own
   * without the mapping needing a second wind term.
   */
  shakingClothAreaM2: number;

  // --- the hull ------------------------------------------------------------
  /** |roll rate| + |pitch rate|, rad/s. How hard she is working. */
  hullWorkRateRadPerS: number;
  /** Speed of the hull through the water, m/s. */
  speedThroughWaterMps: number;

  // --- the closures --------------------------------------------------------
  /** `isClosureOpen('hatchwayBoards')`. Read, never mirrored. */
  hatchwayBoardsOpen: boolean;
  /** `isClosureOpen('foreScuttleLid')`. */
  foreScuttleLidOpen: boolean;
}

/**
 * A silent, becalmed, deck-level world.
 *
 * This is the state a test starts from and the state the sampler falls back to
 * before there is a vessel to read. Every voice must be quiet here except the
 * sea's own floor, which is deliberately not zero: a flat calm still slaps.
 */
export function createSoundWorldState(): SoundWorldState {
  return {
    mode: 'cinematic',
    vesselDistanceM: 0,
    room: null,
    bowBearingRad: 0,
    significantHeightM: 0,
    dominantPeriodS: 0,
    whitecapCoverage: 0,
    whitewaterGeneration: 1,
    apparentWindMps: 0,
    setClothAreaM2: 0,
    shakingClothAreaM2: 0,
    hullWorkRateRadPerS: 0,
    speedThroughWaterMps: 0,
    hatchwayBoardsOpen: false,
    foreScuttleLidOpen: false,
  };
}
