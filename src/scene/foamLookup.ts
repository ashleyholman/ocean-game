/**
 * How the ocean fragment reconstructs the persistent foam field.
 *
 * The field is coarse on purpose — the near level is 384 m across 256 texels,
 * so one texel is 1.5 m of sea — and it is magnified hard whenever the camera
 * is anywhere near the water. Bilinear magnification of a grid that coarse
 * shows its grid: the interpolant is C0 but not C1, its gradient jumps at every
 * texel boundary, and the level sets kink into the diamond lattice the original
 * lookup called a rhombus.
 *
 * That artifact was real. The medicine was not. The established lookup hid the
 * lattice by displacing the sample itself, by up to 0.9 texel — 1.35 m of open
 * water — along a per-pixel high-frequency noise. Dithering a sample position
 * only works when the thing being sampled is smooth at the dither's scale.
 * Ambient foam is: broad patches re-injected in place, which is why this stood
 * for as long as it did. A hull wake is not, and after WK-R made the field
 * texel-exact (R1) and pushed deposits near saturation (R2) it stopped being
 * smooth at any scale: neighbouring pixels began landing on opposite sides of a
 * hard foam edge 1.35 m apart. That reads as blotching, as a bow collar torn
 * off the stem into free-floating patches, and — because the noise re-rolls as
 * the camera and the field move under it — as white/blue pixel buzz that
 * nothing averages away, ocean TAA being opt-in.
 *
 * So fix the reconstruction instead of the sample. `smoothing` warps the
 * within-texel fraction with a quintic whose derivative vanishes at both ends,
 * which makes the interpolant C1 across texel boundaries and removes the
 * gradient jump the lattice *is*. It moves no sample: a foam edge stays exactly
 * where the field put it, and there is no per-pixel noise left to buzz.
 *
 * Both levers stay live rather than being baked, because the blast radius is
 * wider than the wake — this lookup serves every whitecap in the sea — and
 * because `legacy` has to remain available as an exact A/B arm until Ash signs
 * the change off.
 */

/** Sample displacement, in texels, of the established lookup. */
export const FOAM_LOOKUP_LEGACY_JITTER_TEXELS = 0.9;

/**
 * Sample displacement of the replacement.
 *
 * Exactly zero, and that is the point rather than an untuned default: any
 * non-zero value re-introduces the same failure in proportion, and the quintic
 * reconstruction below removes the lattice this was hiding without one. Kept as
 * a lever, not a literal, so the claim stays falsifiable by eye.
 */
export const FOAM_LOOKUP_JITTER_TEXELS = 0;

/**
 * Fraction of the quintic fraction-warp applied at the replacement setting.
 *
 * Not 1. A full warp drives the interpolant's derivative to zero at every texel
 * centre as well as every boundary, which trades the diamond lattice for a grid
 * of 1.5 m plateaus — a different grid artifact, and a more legible one on a
 * flat sea. Partial warp keeps enough of the linear ramp to stay featureless
 * between texels while still killing the gradient jump at their edges.
 *
 * WK-R10: that reasoning is right and 0.75 was on the wrong side of it. At the
 * hull level's 0.375 m texels the plateaus were legible as a hard axis-aligned
 * staircase along the whole foam boundary — the coverage threshold's iso-line
 * snapping to the texel grid, which is what a plateaued field does to any
 * threshold laid over it. Falsified by eye against 0 and 0.40 on the shipping
 * wake harness, hull hidden, from directly above; 0.40 keeps the organic
 * scallop of plain bilinear with no lattice returning. Still a lever, not a
 * literal: `sim.setFoamLookupValues(0, s)` walks it live and
 * `sim.setFoamLookupLegacy(true)` is still the exact pre-R5 arm.
 */
export const FOAM_LOOKUP_SMOOTHING = 0.4;

export interface FoamLookup {
  /** Sample displacement in texels, along the detail-noise gradient. */
  jitterTexels: number;
  /** 0 is plain bilinear; 1 is the full quintic fraction-warp. */
  smoothing: number;
}

export function createFoamLookup(): FoamLookup {
  return { jitterTexels: FOAM_LOOKUP_JITTER_TEXELS, smoothing: FOAM_LOOKUP_SMOOTHING };
}

/**
 * Resolve the A/B arm into caller-owned output.
 *
 * The legacy arm must be bit-for-bit the established render — 0.9 texels of
 * jitter and no warp at all — so that a sheet captured through it can still be
 * compared against every sheet captured before this change.
 */
export function resolveFoamLookup(legacy: boolean, out: FoamLookup): FoamLookup {
  out.jitterTexels = legacy
    ? FOAM_LOOKUP_LEGACY_JITTER_TEXELS
    : FOAM_LOOKUP_JITTER_TEXELS;
  out.smoothing = legacy ? 0 : FOAM_LOOKUP_SMOOTHING;
  return out;
}

/**
 * Clamp hand-set lab values into the range the shader is defined over.
 *
 * The jitter ceiling is the legacy value: nothing about this lookup gets better
 * past the setting that broke it, and leaving room above it in the lab only
 * invites tuning in a direction already known to fail.
 */
export function clampFoamLookup(lookup: Readonly<FoamLookup>, out: FoamLookup): FoamLookup {
  const jitter = Number.isFinite(lookup.jitterTexels) ? lookup.jitterTexels : 0;
  const smoothing = Number.isFinite(lookup.smoothing) ? lookup.smoothing : 0;
  out.jitterTexels = Math.min(Math.max(jitter, 0), FOAM_LOOKUP_LEGACY_JITTER_TEXELS);
  out.smoothing = Math.min(Math.max(smoothing, 0), 1);
  return out;
}
