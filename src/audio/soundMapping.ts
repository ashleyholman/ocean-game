/**
 * Every mapping from the world to a gain, a cutoff or a rate.
 *
 * This file is the round's actual product. It is pure arithmetic over
 * `SoundWorldState`: no `AudioContext`, no Three.js, no clock, no state of its
 * own. `SoundGraph` is a thin thing that copies these numbers onto Web Audio
 * parameters, and it can be thrown away and rewritten without touching a
 * single decision recorded here.
 *
 * The rules every curve in this file obeys, and that `tests/sound-mapping.test.ts`
 * enforces:
 *
 * 1. **Bounded.** Every gain lands in [0, 1] before the mixer's trims, for any
 *    input at all — including the absurd ones a lab preset can produce.
 * 2. **Continuous.** No steps. A hatch that slams is the graph's smoothing to
 *    arrange, not a discontinuity in the map.
 * 3. **Monotonic where the world is.** A rising wind never makes the rigging
 *    quieter; a ship going faster never makes less noise at the bow; moving
 *    the listener away never makes the ship louder.
 * 4. **Defined at the edges.** Dead calm, full storm, ship stopped, ship at
 *    hull speed. No divisions that can reach zero, no `Math.pow` of a negative.
 *
 * SATURATION, AND WHY IT IS EVERYWHERE
 * ------------------------------------
 * Nearly every curve here is `x / (x + k)`. It is worth saying once why.
 * A physical source's power keeps climbing with the wind long after the ear
 * has stopped reporting the difference, and a mix has a ceiling — the sum of
 * six voices at unity is distortion, not a storm. `x / (x + k)` is the
 * simplest function that is zero at zero, strictly increasing everywhere, and
 * asymptotic to one, with a single legible parameter: `k` is the input value
 * at which the voice reaches half. So every constant named `*_HALF` below can
 * be read as "the sea state / wind / speed at which you hear half of this".
 * That is a number Ash can argue with, which a gain curve fitted to nothing
 * is not.
 */

import type { SoundWorldState } from './soundState';
import { roomAcoustics } from './interiorAcoustics';
import type { SoundLayerName, SoundMixerTrims } from './SoundMixer';

// --- shared shapes -----------------------------------------------------------

/** Clamp to [0, 1]. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * `x / (x + half)`, guarded.
 *
 * Zero at and below zero, strictly increasing, asymptotic to one. `half` is
 * the input at which the result is 0.5.
 */
export function saturating(value: number, half: number): number {
  if (!(value > 0)) return 0;
  return value / (value + half);
}

/** Hermite smoothstep between two edges, clamped. Matches the runtime's own. */
export function smoothstep(value: number, edge0: number, edge1: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// --- the listener ------------------------------------------------------------

/**
 * Inside this radius the ship is simply *here* and nothing is attenuated.
 *
 * She is 15.5 m long. Standing anywhere on her — or floating a few metres off
 * her quarter for a close cinematic composition — you are inside the sound of
 * her, not at a distance from a point source. The zoom curve's closest knot is
 * 12 m, so the tightest composition in the game sits exactly on this edge.
 */
export const SHIP_REFERENCE_M = 12;

/**
 * Beyond this the ship is silent, exactly.
 *
 * Not "very quiet" — zero, so the far cinematic camera is honestly a camera
 * watching a ship across water rather than a microphone taped to the mainmast.
 * 600 m is chosen against the zoom curve rather than against an absorption
 * coefficient: the authored knots are 12 / 25 / 45 / 130 / 330 / 750 / 1400 m,
 * so the ship fades out over the 330 → 750 stretch and is gone before the top
 * two compositions. The default opening composition is 45 m, where she is
 * still four fifths audible.
 */
export const SHIP_SILENCE_M = 600;

/**
 * How much of the ship's own noise reaches a listener `distanceM` away.
 *
 * Inverse-distance in amplitude (which is inverse-square in intensity, the
 * right law for a source radiating into a half-space), tapered to exactly zero
 * so the far camera hears nothing at all rather than an inaudible-but-billed
 * residue.
 *
 * **The sea does not go through this function, and that is the whole design.**
 * A ship is a source: back away from it and it gets quieter. The sea is a
 * *field*: it is under the camera at 1400 m exactly as much as it is under
 * your feet on the deck, and attenuating it with distance-from-the-ship would
 * be a category error that happens to sound like a fade-out. So pulling the
 * camera back does not make the world go quiet — it makes the *ship* go quiet
 * and leaves you with the sea, which is the correct and much better effect.
 *
 * Monotonically decreasing, continuous, 1 at the reference, 0 at silence.
 */
export function shipAudibility(distanceM: number): number {
  if (!(distanceM > SHIP_REFERENCE_M)) return 1;
  if (distanceM >= SHIP_SILENCE_M) return 0;
  const spreading = SHIP_REFERENCE_M / distanceM;
  // The taper only bites over the last half of the range, so it removes the
  // residue without distorting the inverse law where the law is doing the work.
  const taper = 1 - smoothstep(distanceM, SHIP_SILENCE_M * 0.5, SHIP_SILENCE_M);
  return spreading * taper;
}

/**
 * Where the bow sits in the stereo field, given its bearing from your facing.
 *
 * `sin(bearing)` and nothing more: full right at 90°, centre dead ahead, and —
 * correctly — centre again dead astern, because two ears cannot tell front
 * from back either. Bounded to [-1, 1] by construction.
 *
 * This is the only spatialisation in the system, and it is here rather than
 * everywhere because it is the only one that means anything. The rig is
 * directly overhead from every point on a 15.5 m deck; the sea is on all
 * sides; the hull is the floor. The bow is the one thing that is somewhere.
 */
export function bowPan(bearingRad: number): number {
  return Math.sin(bearingRad);
}

// --- the sea -----------------------------------------------------------------

/**
 * A dead flat calm is not silent.
 *
 * There is always some slop against the topsides. Setting this to zero makes
 * the calm presets sound like a bug rather than a calm.
 */
export const SWELL_FLOOR = 0.06;

/** Significant wave height at which the wash reaches half, metres. */
export const SWELL_HALF_HEIGHT_M = 2.4;

/** Wash cutoff for a sea with no period at all — the short, hard chop end. */
export const SWELL_CUTOFF_SHORT_HZ = 430;
/** Wash cutoff a long ocean swell asymptotes to. */
export const SWELL_CUTOFF_LONG_HZ = 105;
/** Period at which the cutoff has fallen halfway to the long limit, seconds. */
export const SWELL_PERIOD_HALF_S = 5;

/**
 * The body of the sea: the wash, driven by significant wave height.
 *
 * Replaces two summed sinusoids. The old wash breathed on a 46-second and a
 * 103-second cycle that existed nowhere in the physics; this one breathes
 * because `WaveField.significantHeight` breathes, which it does because the
 * spectrum it was resolved from did.
 */
export function swellGain(significantHeightM: number): number {
  return SWELL_FLOOR + (1 - SWELL_FLOOR) * saturating(significantHeightM, SWELL_HALF_HEIGHT_M);
}

/**
 * The wash gets lower as the dominant period gets longer.
 *
 * A 14-second Southern Ocean swell is a rumble; a 3-second wind chop is a
 * hiss, and the same sea state control moves both. Strictly decreasing in
 * period, defined at period 0 (a sea with no waves, where the gain is at its
 * floor and the cutoff is not audible anyway).
 */
export function swellCutoffHz(dominantPeriodS: number): number {
  const period = dominantPeriodS > 0 ? dominantPeriodS : 0;
  const span = SWELL_CUTOFF_SHORT_HZ - SWELL_CUTOFF_LONG_HZ;
  return SWELL_CUTOFF_LONG_HZ + span / (1 + period / SWELL_PERIOD_HALF_S);
}

/**
 * Whitecap coverage at which the breaking hiss reaches half.
 *
 * Calibrated against the model rather than invented: `whitecapCoverage` is the
 * Monahan fit rolled off to a 10.5 % ceiling, so it returns about 1 % at
 * 10 m/s and 10 % in a sustained storm. A half-point of 3 % puts the audible
 * knee at roughly force 6, which is where a real sea starts to *sound*
 * different rather than merely look it.
 */
export const BREAKER_HALF_COVERAGE = 0.03;

/** How far a preset's foam-rate multiplier is allowed to push the hiss. */
export const BREAKER_GENERATION_CEILING = 1.5;

/** Band centre of the breaking hiss in a light sea, Hz. */
export const BREAKER_CENTRE_LOW_HZ = 900;
/** Band centre with the sea fully covered, Hz. */
export const BREAKER_CENTRE_HIGH_HZ = 2100;

/**
 * The hiss of water actually breaking.
 *
 * Scaled by the same coverage number the foam field is scaled by, clamped by
 * the same `min(generation, 1.5)` the ocean phase applies to its statistical
 * far-field coverage. Two systems reading one number is the point; audio
 * computing its own Monahan fit would be the failure.
 */
export function breakerGain(coverage: number, generation: number): number {
  const bounded = Math.min(Math.max(generation, 0), BREAKER_GENERATION_CEILING);
  return saturating(Math.max(coverage, 0) * bounded, BREAKER_HALF_COVERAGE);
}

/** Heavier breaking is brighter as well as louder: more small bubbles. */
export function breakerCentreHz(coverage: number, generation: number): number {
  const drive = breakerGain(coverage, generation);
  return BREAKER_CENTRE_LOW_HZ + (BREAKER_CENTRE_HIGH_HZ - BREAKER_CENTRE_LOW_HZ) * drive;
}

// --- the rig -----------------------------------------------------------------

/**
 * Apparent wind, squared, at which the rigging reaches half — m²/s².
 *
 * Squared because the noise a cylinder sheds in a stream goes with dynamic
 * pressure long before it goes with anything else, and because the ear's
 * complaint about a linear wind curve is that a fresh breeze and a gale sound
 * the same. 90 m²/s² is 9.5 m/s — a strong breeze, force 5, which is where a
 * schooner's rigging genuinely starts to sing.
 */
export const RIGGING_HALF_PRESSURE = 90;

/** Band centre of the rigging in a stark calm, Hz. */
export const RIGGING_CENTRE_BASE_HZ = 240;
/** How much each m/s of apparent wind lifts that centre, Hz. */
export const RIGGING_CENTRE_PER_MPS = 46;
/** Ceiling on the centre; above this it is a whistle, not a rig. */
export const RIGGING_CENTRE_MAX_HZ = 1800;

/**
 * Wind in the rigging, scaled by *apparent* wind.
 *
 * The raft-era code lifted a hiss when a boolean said the sail was up. This
 * asks the rig what it is actually standing in. Running before a gale at eight
 * knots the apparent wind is quiet and so is the rig; hard on the wind in the
 * same breeze it howls. That difference is the single most recognisable thing
 * about being on a sailing vessel and the old code could not express it at all.
 */
export function riggingGain(apparentWindMps: number): number {
  const speed = Math.max(apparentWindMps, 0);
  return saturating(speed * speed, RIGGING_HALF_PRESSURE);
}

/** Aeolian shedding frequency climbs with flow speed; so does the band. */
export function riggingCentreHz(apparentWindMps: number): number {
  const speed = Math.max(apparentWindMps, 0);
  return Math.min(
    RIGGING_CENTRE_BASE_HZ + RIGGING_CENTRE_PER_MPS * speed,
    RIGGING_CENTRE_MAX_HZ,
  );
}

/**
 * Cloth in motion at which the thunder reaches half, m².
 *
 * An *area*, and the only voice measured in one. The whole sail plan is
 * 150–250 m², the two gaff sails carry most of it, and the three headsails are
 * a few tens each. A half-point of 20 m² therefore means: one headsail
 * shivering is clearly present but small (10 m² → 0.33), one big gaff sail
 * loose dominates the mix (60 m² → 0.75), and the whole rig let fly sits near
 * the ceiling without ever reaching it. Those are the three events worth
 * telling apart.
 *
 * Note what is *not* here: a wind term. `shakingClothAreaM2` has already been
 * weighted by `sailShakeFraction`, which folds in the wind, the blanketing and
 * the aback case. Multiplying by wind again would square it and make a
 * light-airs luff inaudible.
 */
export const CLOTH_HALF_AREA_M2 = 20;

/** Band centre of shaking cloth, Hz. Broad, and it does not move much. */
export const CLOTH_CENTRE_HZ = 680;

/** Slat rate of a great gaff sail in no wind at all, Hz — never heard. */
export const CLOTH_SLAT_BASE_HZ = 0.6;
/** How much faster it flogs per m/s of apparent wind. */
export const CLOTH_SLAT_PER_MPS = 0.12;
/** Ceiling: past this it is a rattle rather than a thunder. */
export const CLOTH_SLAT_MAX_HZ = 5;

/**
 * Canvas thundering.
 *
 * Straight off the area in motion, because that area is already the honest
 * answer to "how much cloth is doing this, and how hard". Zero when nothing is
 * set, zero in a calm, zero when every sail is drawing — all three for free,
 * out of `sailShakeFraction`, rather than out of special cases here.
 */
export function clothGain(shakingClothAreaM2: number): number {
  return saturating(shakingClothAreaM2, CLOTH_HALF_AREA_M2);
}

/**
 * How fast the cloth is beating, for the graph's amplitude modulation.
 *
 * A rig-wide rate driven by apparent wind, and the weakest number in this
 * file. The real flogging frequency is a property of each sail's *chord* — the
 * M6 loft flogs a one-metre chord at 2.4 Hz and longer cloth slower — and it
 * draws every sail on its own phase. Until this reads that phase, a sail you
 * can watch thundering and the thunder you can hear beat at two unrelated
 * rates. See the handover: this is the round's first follow-up, and it is a
 * merge away rather than a design problem.
 */
export function clothSlatHz(apparentWindMps: number): number {
  const speed = Math.max(apparentWindMps, 0);
  return Math.min(
    CLOTH_SLAT_BASE_HZ + CLOTH_SLAT_PER_MPS * speed,
    CLOTH_SLAT_MAX_HZ,
  );
}

// --- the hull ----------------------------------------------------------------

/**
 * Combined roll + pitch rate at which the hull's groan reaches half, rad/s.
 *
 * 0.22 rad/s is about 12.5°/s of total angular rate. In a moderate beam sea a
 * 15 m hull rolls a few degrees at a period of five or six seconds, peaking
 * near that; in a gale she is well past it. So the half-point sits where "she
 * is working" starts being the honest description.
 */
export const HULL_HALF_RATE_RAD_PER_S = 0.22;

/** Band centre of a working hull, Hz. Timber and tarred cordage under load. */
export const HULL_CENTRE_HZ = 155;

/**
 * The hull working with the sea.
 *
 * Driven by |roll rate| + |pitch rate| rather than by roll and pitch *angles*,
 * because a hull heeled steadily to fifteen degrees on a reach is silent and a
 * hull rolling through five is not. It is the movement that loads and unloads
 * the fastenings, and it is the only quantity here that peaks twice per roll.
 *
 * This is a groan, not a creak. Individual creaks are transients and a noise
 * band cannot make one; see the handover for what that would take.
 */
export function hullGain(workRateRadPerS: number): number {
  return saturating(Math.max(workRateRadPerS, 0), HULL_HALF_RATE_RAD_PER_S);
}

/**
 * Speed through the water, squared, at which the bow wave reaches half — m²/s².
 *
 * 6 m²/s² is 2.45 m/s, a little under five knots. Her hull speed on a ~13 m
 * waterline is about 4.5 m/s, so the half-point sits at just over half of it
 * and the top of the range still has somewhere to go.
 */
export const BOW_HALF_PRESSURE = 6;

/** Band centre of the bow wave at rest, Hz. */
export const BOW_CENTRE_BASE_HZ = 500;
/** How much each m/s of headway brightens it, Hz. */
export const BOW_CENTRE_PER_MPS = 90;

/**
 * Water at the bow, from the hull's speed *through the water*.
 *
 * Through the water, not over the ground and not the voyage-compressed
 * distance made good: it is the relative flow that makes the noise, which is
 * exactly the quantity `SchoonerResistance` already publishes as
 * `meanRelativeForwardWaterSpeedMps` for the friction line. Reading the
 * resistance model's own number rather than differencing a position is what
 * keeps this from becoming a second speed authority.
 */
export function bowGain(speedThroughWaterMps: number): number {
  const speed = Math.abs(speedThroughWaterMps);
  return saturating(speed * speed, BOW_HALF_PRESSURE);
}

/** Faster water is brighter water. */
export function bowCentreHz(speedThroughWaterMps: number): number {
  return BOW_CENTRE_BASE_HZ + BOW_CENTRE_PER_MPS * Math.abs(speedThroughWaterMps);
}

// --- the resolved frame ------------------------------------------------------

export interface SoundVoiceLevels {
  /** The body of the sea. A field: no distance law. */
  swell: { gain: number; cutoffHz: number };
  /** Breaking water. Also a field. */
  breakers: { gain: number; centreHz: number };
  /** Wind in the rigging. A source on the ship. */
  rigging: { gain: number; centreHz: number };
  /** Cloth shaking. A source on the ship, beating at `slatHz`. */
  cloth: { gain: number; centreHz: number; slatHz: number };
  /** Water at the bow. A source on the ship, and the only panned voice. */
  bow: { gain: number; centreHz: number; pan: number };
  /** The hull working. Structure-borne: louder inside, not quieter. */
  hull: { gain: number; centreHz: number };
  /**
   * The enclosure bus every air-borne voice passes through.
   *
   * One filter for four voices rather than four filters: muffling is a
   * property of the room the ear is in, not of each source, and modelling it
   * per-voice would be four chances to get the same number slightly different.
   */
  air: { gain: number; cutoffHz: number };
  /** Master gain after mute and the master trim. */
  master: number;
}

export function createSoundVoiceLevels(): SoundVoiceLevels {
  return {
    swell: { gain: 0, cutoffHz: SWELL_CUTOFF_SHORT_HZ },
    breakers: { gain: 0, centreHz: BREAKER_CENTRE_LOW_HZ },
    rigging: { gain: 0, centreHz: RIGGING_CENTRE_BASE_HZ },
    cloth: { gain: 0, centreHz: CLOTH_CENTRE_HZ, slatHz: CLOTH_SLAT_BASE_HZ },
    bow: { gain: 0, centreHz: BOW_CENTRE_BASE_HZ, pan: 0 },
    hull: { gain: 0, centreHz: HULL_CENTRE_HZ },
    air: { gain: 1, cutoffHz: 19000 },
    master: 0,
  };
}

/**
 * The whole frame's mapping, in one pure call.
 *
 * `out` is a retained record the caller owns; nothing is allocated. Returns
 * `out` so a test can write `resolveVoices(state, trims, createSoundVoiceLevels())`
 * in an expression.
 */
export function resolveVoices(
  state: Readonly<SoundWorldState>,
  trims: Readonly<SoundMixerTrims>,
  out: SoundVoiceLevels,
): SoundVoiceLevels {
  const enclosure = roomAcoustics(state.room, state);
  const audibility = shipAudibility(state.vesselDistanceM);

  // Solo is an inspection tool, so it is resolved here rather than in the
  // panel: the panel should be able to say "let me hear only the rigging" and
  // have every other number in this record actually go to zero, so a test of
  // the trims is a test of what Ash will hear.
  const layer = (name: SoundLayerName): number =>
    trims.solo !== null && trims.solo !== name ? 0 : clamp01(trims.layers[name]);

  out.swell.gain = clamp01(swellGain(state.significantHeightM)) * layer('swell');
  out.swell.cutoffHz = swellCutoffHz(state.dominantPeriodS);

  out.breakers.gain =
    clamp01(breakerGain(state.whitecapCoverage, state.whitewaterGeneration)) *
    layer('breakers');
  out.breakers.centreHz = breakerCentreHz(
    state.whitecapCoverage,
    state.whitewaterGeneration,
  );

  out.rigging.gain =
    clamp01(riggingGain(state.apparentWindMps)) * audibility * layer('rigging');
  out.rigging.centreHz = riggingCentreHz(state.apparentWindMps);

  out.cloth.gain =
    clamp01(clothGain(state.shakingClothAreaM2)) * audibility * layer('cloth');
  out.cloth.centreHz = CLOTH_CENTRE_HZ;
  out.cloth.slatHz = clothSlatHz(state.apparentWindMps);

  out.bow.gain =
    clamp01(bowGain(state.speedThroughWaterMps)) * audibility * layer('bow');
  out.bow.centreHz = bowCentreHz(state.speedThroughWaterMps);
  out.bow.pan = bowPan(state.bowBearingRad);

  // The one voice the enclosure makes louder. Its own gain carries the
  // structure-borne factor, so it must be clamped again after the multiply.
  out.hull.gain =
    clamp01(hullGain(state.hullWorkRateRadPerS) * enclosure.structureGain) *
    audibility *
    layer('hull');
  out.hull.centreHz = HULL_CENTRE_HZ;

  out.air.gain = enclosure.airGain;
  out.air.cutoffHz = enclosure.cutoffHz;

  out.master = trims.muted ? 0 : clamp01(trims.master);
  return out;
}
