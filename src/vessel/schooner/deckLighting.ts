import type * as THREE from 'three';

/**
 * Effective share of the local lower hemisphere occupied by sunlit deck and
 * nearby timber for a receiver standing within the bulwarks.
 *
 * This is a geometric/view-factor approximation, not a light multiplier. The
 * remaining hemisphere is open air, sea or distant ship structure and returns
 * no first-bounce deck radiance. A value below one also admits the shadows and
 * gaps that a single uniform field cannot resolve.
 */
export const DECK_LOCAL_BOUNCE_COVERAGE = 0.42;

/**
 * Cosine-convolved share of a uniform lower-hemisphere radiator.
 *
 * `upDotNormal` is +1 on a deck top, 0 on a wall and -1 underneath. The exact
 * isotropic-hemisphere result is therefore 0, 1/2 and 1 respectively.
 */
export function lowerHemisphereDiffuseWeight(upDotNormal: number): number {
  return Math.min(Math.max(0.5 * (1 - upDotNormal), 0), 1);
}

/**
 * Build the irradiance returned by the deck before the receiver orientation is
 * applied in `WorldPbrMaterial`.
 *
 * The deck receives pi times the cosine-weighted sky mean plus the direct beam
 * projected onto the ship's current up axis. Lambertian timber returns
 * `reflectance * incident / pi` as radiance; integrating that radiance over a
 * full lower hemisphere multiplies by pi again, so those factors cancel. The
 * result is true RGB irradiance in the same units as the world SH probe.
 */
export function updateDeckLocalBounceIrradiance(
  out: THREE.Vector3,
  deckUpWorld: THREE.Vector3,
  skyHemisphericRadiance: THREE.Vector3,
  sunDirection: THREE.Vector3,
  sunColor: THREE.Color,
  sunIntensity: number,
  deckReflectance: THREE.Color,
  coverage = DECK_LOCAL_BOUNCE_COVERAGE,
): THREE.Vector3 {
  const viewFactor = Math.min(Math.max(coverage, 0), 1);
  const sunCosine = Math.min(
    Math.max(deckUpWorld.dot(sunDirection), 0),
    1,
  );
  const direct = Math.max(sunIntensity, 0) * sunCosine;

  out.set(
    deckReflectance.r *
      (Math.PI * Math.max(skyHemisphericRadiance.x, 0) + sunColor.r * direct) *
      viewFactor,
    deckReflectance.g *
      (Math.PI * Math.max(skyHemisphericRadiance.y, 0) + sunColor.g * direct) *
      viewFactor,
    deckReflectance.b *
      (Math.PI * Math.max(skyHemisphericRadiance.z, 0) + sunColor.b * direct) *
      viewFactor,
  );
  return out;
}
