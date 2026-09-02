/**
 * Ocean optical profile — the water's *optics*, separated from its *motion*.
 *
 * The sea-state system owns displacement, roughness statistics and foam
 * history; this profile owns how that surface turns light into colour: the
 * water column's absorption and backscatter, the reflection and glitter
 * behaviour, foam irradiance gains and the clear-air haze length.
 *
 * One instance ships in this round — clear, deep, low-productivity open
 * ocean. A future weather or geography system supplies others (coastal
 * green, bloom, glacial milk) by swapping constants; nothing here reaches
 * into planetary or sea-state code.
 */

export interface OceanOpticsProfile {
  /** Column absorption, m^-1, at roughly 620/550/460 nm. */
  absorption: readonly [number, number, number];
  /** Column backscatter, m^-1. Body reflectance is bb/(a+bb). */
  backscatter: readonly [number, number, number];
  /**
   * Converts the sky's hemisphere-MEAN radiance into the downwelling
   * irradiance the water column receives. The physically honest value is π
   * (E = π·L̄ for an isotropic hemisphere); the shipping value predates that
   * derivation. Live-tunable through `Ocean.applyOptics`.
   */
  ambientIrradianceGain: number;
  /** Diffuse-sky share of downwelling irradiance on the water body. */
  bodySkyGain: number;
  /** Direct-sun share of downwelling irradiance on the water body. */
  bodySunGain: number;
  /** Multiplies the statistical glitter roughness sqrt(2 sigma^2). */
  roughnessScale: number;
  /** Reflection-lobe width as a fraction of the glitter width. */
  reflectLobeRatio: number;
  /**
   * How far below 1.0 the grazing Fresnel F90 falls at full reflect
   * roughness. A wind-roughened sea never reaches mirror grazing
   * reflectance; slope statistics, shadowing and multi-bounce eat it.
   */
  grazingRolloff: number;
  /** Clear-air extinction length for atmospheric perspective, metres. */
  hazeDistanceM: number;
  /** Foam irradiance gains (dimensionless, applied to sky/sun radiance). */
  foamSkyGain: number;
  foamSunGain: number;
  /** Moon glitter gain relative to the moon's sky in-scatter power. */
  moonSpecularGain: number;
}

/**
 * Clear, deep, oligotrophic open ocean (Jerlov type I-like).
 *
 * Absorption/backscatter give an irradiance reflectance
 * Rw = bb/(a+bb) = (0.0022, 0.016, 0.094) — the cobalt of gyre water.
 * Haze 9000 m is 30-60 km visibility, a genuinely clear marine day; the
 * previous 2600 m was 10 km visibility, which is why the far view drowned
 * in white air.
 */
/**
 * The flat backscatter this profile used before the spectral shape was fixed.
 * A/B scaffolding; goes with scene/colourPipeline.ts.
 */
export const LEGACY_FLAT_BACKSCATTER: readonly [number, number, number] = [
  0.00105, 0.00094, 0.00112,
];

export const CLEAR_DEEP_OCEAN: OceanOpticsProfile = {
  absorption: [0.3, 0.058, 0.017],
  /**
   * Backscatter, spectrally shaped rather than flat.
   *
   * The values here before were (0.00105, 0.00094, 0.00112) — a blue-to-red
   * ratio of 1.07, i.e. essentially grey. Seawater does not backscatter greyly.
   * In water this clear the backscatter is dominated by MOLECULAR scattering,
   * which follows lambda^-4.32, and across the profile's own band centres
   * (620 / 550 / 460 nm) that is a blue-to-red ratio of 3.63.
   *
   * A grey backscatter with a strongly blue absorption gives a body colour that
   * is bluish but washed: Rw came out (0.0035, 0.0159, 0.0618), ratios
   * 0.056 : 0.258 : 1. With the real spectral shape it is 0.023 : 0.170 : 1 —
   * a deep blue rather than a blue-grey — and 1.5x brighter in the blue channel,
   * because scattering more blue back is exactly what makes clear water blue.
   *
   * Anchored at the unchanged 550 nm value, and blended 75/25 with a flat
   * particulate component: even a gyre has some particles, and pure molecular
   * scattering is the limit case rather than the honest answer.
   */
  backscatter: [0.00066, 0.00094, 0.00176],
  /**
   * 6.0, Ash's value, and HIGHER than the π this round derived — for a reason
   * that is on the record rather than a retreat from the derivation. π·L̄ is
   * the honest irradiance from a hemisphere of mean radiance L̄, and it was
   * right while the sky was drawn at full radiance. The sky now ships trimmed
   * to 0.6 of the model (see uSkyGainTrim), which dims the very L̄ this
   * integrates, so the gain climbs to buy back what the trim took. The two
   * numbers are a pair; neither is meaningful alone.
   */
  ambientIrradianceGain: 6.0,
  /** 1/Q, Q ≈ 4 sr: irradiance reflectance → upwelling radiance. */
  bodySkyGain: 0.25,
  /**
   * ZERO, and this one is Ash's call rather than radiometry's — the sun does
   * light the water column, and 1/Q is what the same derivation gives for it.
   *
   * The evidence for overriding that: the sea reads best at sunset, where
   * `max(uSunDir.y, 0)` collapses and this term goes to nothing on its own.
   * That is the same observation as "turn the sun gain off", arrived at from
   * the other end, and it says the sun's contribution to the WATER wants to
   * live in the glitter — a sparkle pool on the facets that face it — rather
   * than as a uniform lift under the whole surface. Spread evenly it is just
   * a pedestal, and a pedestal under a deep blue is what made the midday sea
   * read as pale cornflower against every reference photograph.
   *
   * What this costs: the water no longer brightens as the sun climbs, except
   * through its glitter and its sky. A future round that wants that back
   * should put it somewhere with structure, not here.
   */
  bodySunGain: 0,
  roughnessScale: 1.0,
  reflectLobeRatio: 0.55,
  grazingRolloff: 1.0,
  hazeDistanceM: 9000,
  /** Production whitewater brightness, chosen by eye. */
  foamSkyGain: 0.1,
  foamSunGain: 0.16,
  // Restrained silver path. The old 3.5 gain made moon glitter compete with
  // the lantern and read like a yellow recolouring of the Sun's lane.
  //
  // 0.75 -> 0.09 when Part B raised MOON_SKY_POWER from 0.070 to 1.0. This is a
  // RATIO to the moon's sky power — the shader computes uMoonPower * uMoonSpecular
  // — so leaving it alone would have multiplied the moonglade by 14.3 on the
  // spot, and the spec's own acceptance says the glitter path must stay a path
  // rather than become a blown sheet.
  //
  // The number holds the moonglade's ON-SCREEN brightness where Ash's eye put
  // it, at the full-moon-at-40-degrees operating point: power x gain x exposure
  // was 0.070 x 0.75 x 4.29 = 0.225, and the exposure at that point is now 2.46,
  // so the gain that reproduces it is 0.225 / (1.0 x 2.46) = 0.0915.
  //
  // DELIBERATELY CONSERVATIVE, and the alternative is worth stating because it
  // is the physical one. The moon is now fourteen times stronger and the sea
  // around it has come up twelve times with it, so a glitter path that grew with
  // them — gain ~0.645, holding the RATIO rather than the absolute — is what
  // physics argues for. It was not taken because a moonglade that bright was
  // already tried, at gain 3.5, and rejected by eye for competing with the
  // lantern; re-creating a known-rejected look on a reasoning argument is not
  // this round's call to make. This is the dial if the moonglade reads too meek
  // against the brighter sea.
  moonSpecularGain: 0.09,
};

/** Irradiance reflectance of the water column, Rw = bb / (a + bb). */
export function waterBodyReflectance(
  profile: OceanOpticsProfile,
): [number, number, number] {
  const rw = (i: number): number =>
    profile.backscatter[i] / (profile.absorption[i] + profile.backscatter[i]);
  return [rw(0), rw(1), rw(2)];
}

/**
 * The DERIVED body-radiance chain, offered as the photo-match A/B arm.
 *
 * The shader's body term is `Rw × (ambient·skyGain + sun·sinθ·sunGain)`, and
 * every factor in it is now derived rather than tasted:
 *
 *  - `ambientIrradianceGain`: downwelling irradiance from a hemisphere of
 *    mean radiance L̄ is exactly π·L̄, which is where this started. It ships
 *    above π to compensate the sky's radiance trim — see the field's note.
 *  - `bodySkyGain = bodySunGain = 1/Q with Q = 4 sr`: Rw is an IRRADIANCE
 *    reflectance (E_up/E_down), but the shader needs upwelling RADIANCE. The
 *    conversion is E_up/Q, with Q ≈ 3.5–4.5 sr measured for clear-ocean
 *    upwelling light fields; 4 is the middle of that range. The shipping
 *    shader never applied Q at all — its gains (0.32/0.30) absorbed part of
 *    it by eye and left the body ≈ 2.3× (sky share) and 1.2× (sun share)
 *    brighter than the chain derives. That surplus is the pale, milky cast
 *    Ash's reference photo does not have: measured against it our water ran
 *    its blue channel 1.5–2.5× too bright at a 65° sun.
 *  - `foamSkyGain = 0.1`: the production whitewater brightness chosen by eye.
 *    It supersedes the earlier 0.75 compensation used while the ambient water
 *    lighting chain was being re-derived.
 *  - `grazingRolloff`: the one look value in the set, judged live rather than
 *    derived, and now at its maximum of 1.0. It cuts the grazing Fresnel that
 *    turns the distance into a sky mirror; the structural half of that problem is
 *    the roughness lift on the incidence cosine, which is what finally gave
 *    the horizon a hard edge.
 *
 * Applied through `Ocean.applyOptics`, which also feeds the hull's reflected
 * sea — one water, one brightness, per the world-lighting round's rule.
 *
 * This IS the shipping chain as of the detail/optics round; the constant is
 * kept as a named set so the lab can restore it after exploring, and so the
 * A/B against `LEGACY_BODY_OPTICS` stays runnable.
 */
export const DERIVED_BODY_OPTICS = {
  ambientIrradianceGain: 6.0,
  bodySkyGain: 0.25,
  /** Not 1/Q — a look decision. See the field's note on CLEAR_DEEP_OCEAN. */
  bodySunGain: 0,
  foamSkyGain: 0.1,
  grazingRolloff: 1.0,
} as const;

/**
 * The eye-tuned chain this replaced, for the A/B's other arm.
 *
 * Literals rather than reads of `CLEAR_DEEP_OCEAN`: that profile now carries
 * the derived values, so deriving these from it would make both arms of the
 * comparison the same water and quietly turn the A/B into a no-op.
 */
export const LEGACY_BODY_OPTICS = {
  ambientIrradianceGain: 5.6,
  bodySkyGain: 0.32,
  bodySunGain: 0.3,
  foamSkyGain: 0.42,
  grazingRolloff: 0.55,
} as const;
