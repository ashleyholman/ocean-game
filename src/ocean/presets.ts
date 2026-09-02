/**
 * The sea-state preset matrix.
 *
 * These are physical descriptions, not tuned wave lists: every derived quantity
 * in the table below falls out of `spectrum.ts` from the wind and swell numbers
 * declared here. The comments quote what the model produces so the file can be
 * read as a specification and checked against it — `npm test` does exactly that
 * (`tests/sea-state.test.ts`).
 *
 * Vessel safety is not a property of the ocean. Presets only say whether they
 * are playable environments or diagnostic fixtures; comfort and survivability
 * belong to a vessel response model.
 */

import type { SeaState } from './seaState';
import {
  defaultRoughness,
  defaultWhitewater,
  noSwell,
  windSeaSteepnessFor,
} from './seaState';

/** Heading the reference swell travels towards. Presets vary about this. */
const BASE = 68;

export const SEA_STATES: readonly SeaState[] = [
  {
    name: 'FLAT',
    label: 'Flat (regression baseline)',
    seed: 11,
    generatingWind: { speedMps: 0, directionDeg: BASE, gustiness: 0, maturity: 0 },
    primary: noSwell(),
    secondary: noSwell(),
    windSeaSteepness: 0,
    roughness: { ...defaultRoughness(), fineRoughness: 0, detailStrength: 0 },
    whitewater: { ...defaultWhitewater(), generation: 0, sprayIntensity: 0 },
    purpose: 'PLAYABLE',
    notes:
      'Mathematically flat water. Exists so the buoyancy harness has a zero ' +
      'against which any residual motion is unambiguously a bug.',
  },

  {
    // Wind 0.8 m/s, maturity 0.15 -> wind sea Hs 0.002 m, Tp 0.6 s.
    // Primary Hs 0.07 m at 16 s. Combined Hs 0.070 m; max wave about 0.13 m.
    name: 'DEAD_CALM',
    label: 'Dead calm',
    seed: 21,
    generatingWind: {
      speedMps: 0.8,
      directionDeg: BASE,
      gustiness: 0.05,
      maturity: 0.15,
    },
    primary: {
      enabled: true,
      significantHeight: 0.07,
      peakPeriod: 16,
      directionDeg: BASE - 24,
      spreadDeg: 6,
      steepness: 0.22,
      groupiness: 0.6,
    },
    secondary: noSwell(),
    windSeaSteepness: 0.2,
    roughness: {
      fineRoughness: 0.10,
      detailScale: 3.4,
      detailStrength: 0.25,
      gustStreak: 0.02,
      microChop: 0,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0,
      sprayIntensity: 0,
      persistenceSeconds: 4,
    },
    purpose: 'PLAYABLE',
    notes:
      'Mirror water with the faintest long breathing under it. No whitecaps, ' +
      'no spray. Not perfectly static — a dead-flat mirror reads as a bug, not ' +
      'as calm.',
  },

  {
    // Wind 1.6 m/s, maturity 0.20 -> wind sea Hs 0.013 m, Tp 0.6 s.
    // Primary Hs 1.90 m at 15 s, spread 7 deg. Combined Hs 1.90 m.
    // Max individual wave about 3.5 m. Steepness Hs/L = 1.90/351 = 0.005.
    name: 'GLASSY_LONG_SWELL',
    label: 'Glassy long swell',
    seed: 22,
    generatingWind: {
      speedMps: 1.6,
      directionDeg: BASE + 10,
      gustiness: 0.08,
      maturity: 0.2,
    },
    primary: {
      enabled: true,
      significantHeight: 1.9,
      peakPeriod: 15,
      directionDeg: BASE - 18,
      spreadDeg: 7,
      steepness: 0.34,
      groupiness: 0.70,
    },
    secondary: noSwell(),
    windSeaSteepness: 0.25,
    roughness: {
      fineRoughness: 0.18,
      detailScale: 3.1,
      detailStrength: 0.30,
      gustStreak: 0.04,
      microChop: 0,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0.04,
      thresholdBias: 0.45,
      sprayIntensity: 0,
      persistenceSeconds: 5,
    },
    purpose: 'PLAYABLE',
    notes:
      'Large, smooth, organised faces with almost no local roughness — the ' +
      'reflection stays coherent across a whole wave. Slow clean heave and ' +
      'pitch. Essentially no whitecaps despite the size, because nothing is ' +
      'steep enough to break.',
  },

  {
    // Wind 4.6 m/s, maturity 0.40 -> wind sea Hs 0.209 m, Tp 2.08 s (L 6.8 m).
    // Primary Hs 1.45 m at 12 s. Combined Hs 1.47 m.
    name: 'LIGHT_BREEZE_OVER_SWELL',
    label: 'Light breeze over swell',
    seed: 23,
    generatingWind: {
      speedMps: 4.6,
      directionDeg: BASE + 46,
      gustiness: 0.22,
      maturity: 0.40,
    },
    primary: {
      enabled: true,
      significantHeight: 1.45,
      peakPeriod: 12,
      directionDeg: BASE - 14,
      spreadDeg: 17,
      steepness: 0.40,
      groupiness: 0.58,
    },
    secondary: noSwell(),
    windSeaSteepness: windSeaSteepnessFor(0.4),
    roughness: {
      fineRoughness: 0.62,
      detailScale: 2.6,
      detailStrength: 0.75,
      gustStreak: 0.22,
      microChop: 0.15,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0.22,
      thresholdBias: 0.22,
      sprayIntensity: 0.05,
      persistenceSeconds: 6,
    },
    purpose: 'PLAYABLE',
    notes:
      'Fine wind ripple crossing the faces of a moderate swell at 60 degrees ' +
      'to it, so the two systems stay visually separable. Occasional tiny ' +
      'whitecaps on the steepest crests only.',
  },

  {
    // Wind 9.0 m/s, maturity 0.26 -> wind sea Hs 0.520 m, Tp 3.16 s (L 15.5 m).
    // Wind-sea steepness Hs/L = 0.034 — young and steep.
    // Primary Hs 0.30 m at 9 s. Combined Hs 0.60 m.
    name: 'WIND_CHOP',
    label: 'Wind chop',
    seed: 24,
    generatingWind: {
      speedMps: 9.0,
      directionDeg: BASE + 8,
      gustiness: 0.45,
      maturity: 0.26,
    },
    primary: {
      enabled: true,
      significantHeight: 0.30,
      peakPeriod: 9,
      directionDeg: BASE - 52,
      spreadDeg: 20,
      steepness: 0.48,
      groupiness: 0.4,
    },
    secondary: noSwell(),
    windSeaSteepness: windSeaSteepnessFor(0.26),
    roughness: {
      fineRoughness: 1.25,
      detailScale: 2.0,
      detailStrength: 1.05,
      gustStreak: 0.55,
      microChop: 0.55,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 1.15,
      thresholdBias: -0.12,
      sprayIntensity: 0.75,
      persistenceSeconds: 5.5,
      windAdvection: 0.045,
    },
    purpose: 'PLAYABLE',
    notes:
      'Short, irregular, locally driven disorder with almost no remote swell ' +
      'under it. Small frequent whitecaps and noticeably more spray than any ' +
      'swell-only state. The raft filters the highest frequencies and rides ' +
      'the envelope.',
  },

  {
    // The visual-regression baseline: the 1765bb7 shipping ocean, restated.
    //
    // Audited against the original table (Hs = 4·√(Σa²/2) over its six
    // components = 1.165 m; dominant 0.33 m at 62 m; almost nothing below
    // 16 m — its sub-16 m amplitudes were 6/3/1.4 cm):
    //  - primary Hs 1.15 m at 6.3 s puts the carrier at ~0.27 m on 62 m, with
    //    set peaks past the old steady 0.33 m;
    //  - wind 6.0 m/s at maturity 0.28 is a young 4 m sea that mostly sits
    //    under the resolution floor — gentle short texture like the old
    //    5.6/10.4 m members, NOT a visible chop train. (The first restatement
    //    used maturity 0.44, whose 13 m wind peak dominated the near field
    //    with waves the old ocean never had.)
    //  - combined Hs 1.16 m. The first restatement shipped 0.55 m: the old
    //    preset's height had been derived as 2·√m0 instead of 4·√m0, so
    //    "current production ocean" sailed at half the height of the ocean it
    //    claimed to reproduce.
    //
    // THE WIND CROSSES THE SWELL, AND THAT IS THE POINT
    // -------------------------------------------------
    // It used to blow toward BASE, 14° off the primary's own travel heading.
    // Nothing is wrong with that sea — but it makes a comfortable beam reach
    // impossible to sail in it, because a beam reach is 90° off the wind and
    // the swell then lands 76–104° off the bow no matter which way you point.
    // Every heading that draws well puts the sea on the beam and rolls her.
    //
    // So the local breeze now blows square across the primary
    // (`primary.directionDeg + 90`), and the whole swell axis becomes
    // sailable: bow-on or stern-on to the sea *is* the beam reach. See
    // `src/world/openingVoyage.ts`, which derives the opening heading from
    // exactly this relationship rather than restating a number.
    //
    // Nothing scalar moved — height, period, steepness, whitecap coverage and
    // every derived spectral quantity are what they were. What changed is the
    // angle at which the small wind-sea texture, the gust streaks and the foam
    // streaks cross the dominant swell, which is a look change Ash signed off
    // by eye rather than one this comment can certify.
    name: 'CURRENT_MODERATE',
    label: 'Current production ocean',
    seed: 0,
    generatingWind: {
      speedMps: 6.0,
      directionDeg: BASE - 14 + 90,
      gustiness: 0.25,
      maturity: 0.28,
    },
    primary: {
      enabled: true,
      significantHeight: 1.15,
      peakPeriod: 6.3,
      directionDeg: BASE - 14,
      // Wide is safe under the compositional policy: spread sets the *fan's*
      // angular envelope, and the fan crosses at distinct scales (the old
      // ocean's own ±76° cross-hatch), never at the carrier's.
      spreadDeg: 34,
      steepness: 0.52,
      groupiness: 0.35,
    },
    secondary: noSwell(),
    windSeaSteepness: windSeaSteepnessFor(0.28),
    roughness: {
      fineRoughness: 0.85,
      detailScale: 2.4,
      detailStrength: 1.00,
      gustStreak: 0.28,
      microChop: 0.25,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0.12,
      thresholdBias: 0.20,
      sprayIntensity: 0.12,
      persistenceSeconds: 7.5,
      breakup: 0.89,
    },
    purpose: 'PLAYABLE',
    notes:
      'The condition the prototype has always shipped, restated in physical ' +
      'terms. This is the visual-regression baseline: it must not get worse.',
  },

  {
    // Wind 12.5 m/s, maturity 0.82 -> wind sea Hs 3.16 m, Tp 8.69 s (L 118 m).
    // Primary Hs 1.20 m at 11 s. Combined Hs 3.38 m. Beaufort 6.
    // Monahan whitecap coverage at 12.5 m/s: about 2.1 %.
    name: 'MATURE_WIND_SEA',
    label: 'Mature wind sea',
    seed: 26,
    generatingWind: {
      speedMps: 12.5,
      directionDeg: BASE + 4,
      gustiness: 0.5,
      maturity: 0.82,
    },
    primary: {
      enabled: true,
      significantHeight: 1.2,
      peakPeriod: 11,
      directionDeg: BASE - 30,
      spreadDeg: 14,
      steepness: 0.52,
      groupiness: 0.5,
    },
    secondary: noSwell(),
    windSeaSteepness: windSeaSteepnessFor(0.82),
    roughness: {
      fineRoughness: 1.35,
      detailScale: 2.1,
      detailStrength: 1.00,
      gustStreak: 0.7,
      microChop: 0.45,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 1.5,
      thresholdBias: -0.18,
      sprayIntensity: 1.0,
      persistenceSeconds: 9,
      windAdvection: 0.05,
      breakup: 0.6,
    },
    purpose: 'PLAYABLE',
    notes:
      'Directionally coherent but thoroughly irregular. Substantial whitecaps, ' +
      'persistent downwind foam streaks and moderate spindrift off the crests.',
  },

  {
    // Two systems crossing at 85 degrees.
    // Wind 7.5 m/s, maturity 0.55 -> wind sea Hs 0.764 m, Tp 4.13 s.
    // Primary Hs 1.75 m at 12.5 s towards 200 deg.
    // Secondary Hs 1.35 m at 9.0 s towards 285 deg. Combined Hs 2.34 m.
    name: 'CROSSING_SEAS',
    label: 'Crossing seas',
    seed: 27,
    generatingWind: {
      speedMps: 7.5,
      directionDeg: 250,
      gustiness: 0.35,
      maturity: 0.55,
    },
    primary: {
      enabled: true,
      significantHeight: 1.75,
      peakPeriod: 12.5,
      directionDeg: 200,
      spreadDeg: 10,
      steepness: 0.58,
      groupiness: 0.62,
    },
    secondary: {
      enabled: true,
      significantHeight: 1.35,
      peakPeriod: 9.0,
      directionDeg: 285,
      spreadDeg: 13,
      steepness: 0.60,
      groupiness: 0.5,
    },
    windSeaSteepness: windSeaSteepnessFor(0.55),
    roughness: {
      fineRoughness: 1.0,
      detailScale: 2.3,
      detailStrength: 0.90,
      gustStreak: 0.4,
      microChop: 0.35,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0.95,
      thresholdBias: -0.05,
      sprayIntensity: 0.45,
      persistenceSeconds: 7,
    },
    purpose: 'PLAYABLE',
    notes:
      'Two coherent swell trains crossing obliquely, with a moderate wind sea ' +
      'over them. The interference is physical, not noise: peaks where the two ' +
      'coincide break, troughs between them do not.',
  },

  {
    // Wind 5.5 m/s and falling, maturity 0.30 -> wind sea Hs 0.224 m, Tp 2.10 s.
    // Primary Hs 3.30 m at 14.5 s, groupiness 0.78 -> long, strong sets.
    // Secondary Hs 1.00 m at 10.5 s. Combined Hs 3.46 m.
    // Whitecap generation is deliberately low for the height: nothing local is
    // driving these waves any more.
    name: 'POST_STORM_SWELL',
    label: 'Post-storm swell',
    seed: 28,
    generatingWind: {
      speedMps: 5.5,
      directionDeg: BASE + 62,
      gustiness: 0.3,
      maturity: 0.30,
    },
    primary: {
      enabled: true,
      significantHeight: 3.3,
      peakPeriod: 14.5,
      directionDeg: BASE - 8,
      // Narrow is safe now: regularity-without-monochromaticity is supplied by
      // the sideband structure (sets) and the fan (cross-scale texture), so a
      // long-travelled swell can state its true discipline without collapsing
      // into a washboard.
      spreadDeg: 10,
      steepness: 0.44,
      groupiness: 0.78,
    },
    secondary: {
      enabled: true,
      significantHeight: 1.0,
      peakPeriod: 10.5,
      directionDeg: BASE + 35,
      spreadDeg: 12,
      steepness: 0.46,
      groupiness: 0.6,
    },
    windSeaSteepness: windSeaSteepnessFor(0.30),
    roughness: {
      fineRoughness: 0.55,
      detailScale: 2.7,
      detailStrength: 0.60,
      gustStreak: 0.2,
      microChop: 0.15,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 0.30,
      thresholdBias: 0.30,
      sprayIntensity: 0.1,
      // Long persistence: this sea has recently been much rougher, and the foam
      // it made has not finished decaying.
      persistenceSeconds: 15,
      breakup: 0.75,
    },
    purpose: 'PLAYABLE',
    notes:
      'Large, long, powerful and organised, with the local wind already gone. ' +
      'Markedly less whitewater than the wave height suggests, and what foam ' +
      'there is is old: broken up, drifting, fading.',
  },

  {
    // Wind 18 m/s, maturity 0.80 -> wind sea Hs 6.03 m, Tp 11.95 s (L 223 m).
    // Primary Hs 5.65 m at 9 s (L 126 m). Secondary Hs 1.60 m at 11 s.
    // Combined Hs 8.42 m; sum of amplitudes 14.15 m; sum(QAk) 0.84.
    // Monahan whitecap coverage at 18 m/s: about 6.0 %.
    //
    // Combined Hs rose from 6.41 m and sum(QAk) from 0.60, so this is both a
    // bigger and a markedly steeper sea than the one it replaces. That is the
    // point, and it has a cost: see the roll bound in ship-hydrostatics.test.ts.
    //
    // The primary is no longer a swell in any honest sense. A 9 s, 126 m
    // component is locally wind-driven; a Southern Ocean swell is three or four
    // times that wavelength and arrives from a storm days away. What the long
    // version looked like was rolling hills, and no amount of whitewater on top
    // of a 375 m hill reads as violence — the shape ladder was unambiguous that
    // the spectrum, not the shader, is where the danger lives. Chosen by eye
    // against the live sea; the numbers here are the lab's resolved readout of
    // what that choice produced, not estimates.
    //
    // Long swell under a gale is now unrepresented in the roster.
    // POST_STORM_SWELL keeps the long period but deliberately has no wind on it.
    name: 'SOUTHERN_OCEAN_ROUGH',
    label: 'Southern Ocean rough',
    seed: 29,
    generatingWind: {
      speedMps: 18,
      directionDeg: BASE + 14,
      gustiness: 0.7,
      maturity: 0.80,
    },
    primary: {
      enabled: true,
      significantHeight: 5.65,
      peakPeriod: 9,
      directionDeg: BASE + 2,
      spreadDeg: 11,
      steepness: 0.66,
      groupiness: 0.6,
    },
    secondary: {
      enabled: true,
      significantHeight: 1.6,
      peakPeriod: 11,
      directionDeg: BASE - 42,
      spreadDeg: 16,
      steepness: 0.64,
      groupiness: 0.45,
    },
    // Deliberately not windSeaSteepnessFor(maturity), which would give 0.75.
    // This is the value the sea was tuned against by eye: the lab's maturity
    // slider does not touch steepness, so the sea that got chosen was an 80%
    // fetch carrying a 62% fetch's crest sharpness. Keeping the two decoupled
    // here rather than quietly re-deriving it, because re-deriving it would
    // change the thing that was approved.
    windSeaSteepness: 0.795,
    roughness: {
      fineRoughness: 1.5,
      detailScale: 1.9,
      detailStrength: 0.90,
      gustStreak: 0.95,
      microChop: 0.50,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 2.1,
      thresholdBias: -0.30,
      sprayIntensity: 1.8,
      persistenceSeconds: 12,
      windAdvection: 0.075,
      breakup: 0.55,
    },
    purpose: 'PLAYABLE',
    notes:
      'Large long-period swell with a strong wind sea riding on it. Heavy ' +
      'whitewater, long streaks and strong downwind spray. This sea is allowed ' +
      'to wet and to swamp the raft; the raft is not required to survive it, ' +
      'and nothing about its buoyancy is altered to help it.',
  },

  {
    // Deliberately at the practical limit of the representation.
    // Wind 26 m/s, maturity 0.95 -> wind sea Hs 15.9 m, Tp 19.8 s.
    // Primary Hs 8.0 m at 18 s. Secondary Hs 4.0 m at 12 s.
    // Combined Hs 18.2 m. Exists to test stability, not playability.
    name: 'EXTREME_DEBUG',
    label: 'Extreme (debug only)',
    seed: 30,
    generatingWind: {
      speedMps: 26,
      directionDeg: BASE + 20,
      gustiness: 0.85,
      maturity: 0.95,
    },
    primary: {
      enabled: true,
      significantHeight: 8.0,
      peakPeriod: 18,
      directionDeg: BASE,
      spreadDeg: 12,
      steepness: 0.99,
      groupiness: 0.7,
    },
    secondary: {
      enabled: true,
      significantHeight: 4.0,
      peakPeriod: 12,
      directionDeg: BASE - 58,
      spreadDeg: 18,
      steepness: 0.98,
      groupiness: 0.5,
    },
    windSeaSteepness: 0.99,
    roughness: {
      fineRoughness: 1.7,
      detailScale: 1.8,
      detailStrength: 0.85,
      gustStreak: 1.0,
      microChop: 0.60,
    },
    whitewater: {
      ...defaultWhitewater(),
      generation: 2.8,
      thresholdBias: -0.42,
      sprayIntensity: 2.0,
      persistenceSeconds: 14,
      windAdvection: 0.09,
    },
    purpose: 'DIAGNOSTIC',
    notes:
      'As close to the folding limit of the Gerstner representation as it can ' +
      'safely get. Tests numerical stability, shader robustness, CPU/GPU parity ' +
      'and LOD under the worst geometry the field can produce. The raft is ' +
      'expected to be swamped and is not a subject of this test.',
  },

  {
    // Diagnostic. One component, time stopped: the spatial-parity reference.
    // Tp 5.06 s -> L 40.0 m. One component, so Hs = 4*sqrt(a^2/2) = 2.828 a;
    // Hs 1.41421 m therefore gives an amplitude of exactly 0.5 m.
    name: 'FROZEN_SINGLE',
    label: 'Single frozen wave (debug)',
    seed: 2,
    frozen: true,
    slotOverride: { wind: 0, primary: 1, secondary: 0 },
    generatingWind: { speedMps: 0, directionDeg: BASE, gustiness: 0, maturity: 0 },
    primary: {
      enabled: true,
      significantHeight: 1.41421,
      peakPeriod: 5.0596,
      directionDeg: BASE,
      spreadDeg: 0.02,
      steepness: 0.60,
      groupiness: 0,
    },
    secondary: noSwell(),
    windSeaSteepness: 0,
    roughness: { ...defaultRoughness(), fineRoughness: 0, detailStrength: 0 },
    whitewater: { ...defaultWhitewater(), generation: 0, sprayIntensity: 0 },
    purpose: 'DIAGNOSTIC',
    notes:
      'Exactly one Gerstner component with time stopped. The reference case ' +
      'for spatial CPU/GPU parity and for the inverse-displacement solve.',
  },
];

export const PRODUCTION_SEA_STATE = 'CURRENT_MODERATE';

export function findSeaState(name: string): SeaState {
  return (
    SEA_STATES.find((s) => s.name === name) ??
    SEA_STATES.find((s) => s.name === PRODUCTION_SEA_STATE)!
  );
}

/** Presets the buoyancy regression must re-run, in the order it runs them. */
export const REGRESSION_ORDER: readonly string[] = [
  'FLAT',
  'DEAD_CALM',
  'GLASSY_LONG_SWELL',
  'LIGHT_BREEZE_OVER_SWELL',
  'WIND_CHOP',
  'CURRENT_MODERATE',
  'MATURE_WIND_SEA',
  'CROSSING_SEAS',
  'POST_STORM_SWELL',
  'SOUTHERN_OCEAN_ROUGH',
  'EXTREME_DEBUG',
];
