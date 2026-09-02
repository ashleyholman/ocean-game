/** Mean physical angular radius of the Moon as seen from Earth, radians. */
export const MOON_PHYSICAL_ANGULAR_RADIUS_RAD = 0.00465;

/**
 * The deliberately enlarged in-game disc.
 *
 * At 0.0122 rad the diameter is about 1.40 degrees, 2.62× life size. Ash
 * explicitly preferred a readable Moon to a life-size six-pixel dot. This is
 * presentation only: direct light, sky fill, glitter, phase, and astronomy all
 * continue to use their physical shared state.
 */
export const MOON_PRESENTATION_RADIUS_RAD = 0.0122;

/** Sub-pixel angular feather around the enlarged disc's silhouette. */
export const MOON_DISC_EDGE_FEATHER_RAD = 0.00045;

/** Barely visible reflected Earth light on the unlit hemisphere. */
export const MOON_EARTHSHINE_FLOOR = 0.006;

/** Rough regolith brightens more evenly than a polished Lambert sphere. */
export const MOON_REGOLITH_RESPONSE_EXPONENT = 0.32;

/** Width of the anti-aliased lighting terminator in normal-dot-light units. */
export const MOON_TERMINATOR_HALF_WIDTH = 0.03;

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function smoothstep01(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

/**
 * CPU mirror of the shader's spherical phase response.
 *
 * `normalDotSun` is the dot product between a visible point's sphere normal
 * and the Moon-to-Sun direction. A step mask made every phase look like a disc
 * cut by a geometric stencil; continuous regolith shading supplies the form
 * cue a lit sphere needs from bright limb through terminator.
 */
export function moonRegolithPhaseMask(normalDotSun: number): number {
  if (!Number.isFinite(normalDotSun)) return MOON_EARTHSHINE_FLOOR;
  const cosine = Math.max(normalDotSun, 0);
  const direct = Math.pow(cosine, MOON_REGOLITH_RESPONSE_EXPONENT);
  const terminator = smoothstep01(
    (normalDotSun + MOON_TERMINATOR_HALF_WIDTH) /
      (2 * MOON_TERMINATOR_HALF_WIDTH),
  );
  return (
    MOON_EARTHSHINE_FLOOR +
    (1 - MOON_EARTHSHINE_FLOOR) * direct * terminator
  );
}
