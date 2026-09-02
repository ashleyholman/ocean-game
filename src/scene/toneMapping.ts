/**
 * The display transform.
 *
 * This game is sky and water. Both are large, smooth, strongly-coloured fields
 * that spend most of the day in the bright half of the range, which is exactly
 * where a per-channel filmic curve does its damage: it compresses the biggest
 * channel first, so a saturated blue loses its blue before it loses anything
 * else and arrives on screen as pale grey-cyan. ACES did that here, measurably
 * — 20-30% of the chroma out of every bright band, and green lifted 11-18%
 * relative to blue, which is what "greeny and washed out" was.
 *
 * So the transform is built the other way round. Compression acts on the PEAK
 * CHANNEL, and all three channels are then scaled by one common factor. A
 * common factor cannot change a ratio, so hue and saturation are carried
 * through the shoulder exactly; only brightness is traded for headroom. Nothing
 * below `SHOULDER` is touched at all, so the majority of the picture is the
 * colour the renderer computed, unedited.
 *
 * Highlights still have to go white — a sun disc, a cloud shoulder, a specular
 * glint on a wave face all read wrong if they hold their hue at display white.
 * That is a separate, explicit term, driven by how much headroom the pixel
 * actually consumed, so it engages on the things that are genuinely over-range
 * and leaves a merely bright sky alone.
 *
 * There is no toe. A lifted black point is a film artefact, and this world has
 * to spend half its time at night where the shadow range is the picture.
 */
import * as THREE from 'three';

import {
  isLegacyToneCurve,
  isShadowToeEnabled,
  onColourPipelineChange,
} from './colourPipeline';

/**
 * Where compression starts, as a fraction of display white.
 *
 * Everything below this is passed through untouched. High, because a sky that
 * spends the afternoon at 0.6-0.9 of white should be the colour it was
 * computed to be; the shoulder exists for what is above the range, not for
 * what is merely in the top of it.
 *
 * 0.80 stands, and `?shoulder=` exists because the case for lowering it is
 * real but the change did not earn its cost. Measured at a 70 degree sun, the
 * daylight sky's BLUE channel runs about 1.7x display white, and the shoulder
 * squashes everything from 1.0x to 1.7x into two or three output levels: over
 * three quarters of the sky sits at 250-252. That is a genuine loss of
 * gradient, confined to one channel — red and green still vary, which is why
 * the sky reads correctly despite it.
 *
 * Lowering this to 0.70 spreads that band across about nine levels instead.
 * Judged by eye it is nearly invisible in the sky and plainly visible on the
 * sails, which lose a few levels of white for it. Not a trade worth making by
 * default; it is a page-load switch rather than a live one for the same reason
 * the toe is — it changes the chunk's source text, which is not part of
 * three's program cache key, so a live flip would leave compiled programs
 * running the old curve. The water is unaffected at any setting: it sits near
 * 0.3 of display white, far below the join.
 */
function readShoulderOverride(): number {
  if (typeof window === 'undefined') return 0.8;
  const raw = new URLSearchParams(window.location.search).get('shoulder');
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0.2 && value < 0.99 ? value : 0.8;
}

export const TONE_SHOULDER = readShoulderOverride();

/**
 * Where highlight bleaching reaches halfway to white, in multiples of display
 * white. The ramp is quadratic in the over-range amount and is exactly zero
 * below 1.0: a sky twice display white is a BRIGHT SKY and must stay blue,
 * while a sun disc or a specular glint is twenty to a hundred times over and
 * has to go white or it reads as coloured plastic.
 *
 * 3.0, down from 8.0, and this is the term that draws a backlit cloud.
 *
 * A max-channel shoulder has one failure mode and 8.0 sat in the middle of it.
 * Once the peak channel saturates, the common scale factor collapses, so every
 * other channel is squashed along with it and a whole bright region maps to
 * nearly one colour. Measured over 89 cloud samples around a setting sun, the
 * luminance spread across the cloud field was 15.4 levels against ACES's 24.9 —
 * the clouds lost their shape and went to a flat orange wash, which is exactly
 * what it looked like. Bleaching is the escape: as a pixel goes further
 * over-range its colour moves toward white, and white is somewhere the other
 * channels can still climb to after the peak has stopped. At 3.0 the same
 * measurement gives 26.6.
 *
 * It costs nothing at midday. The bright band over the horizon runs about 1.5x
 * display white there, and the quadratic ramp is still near zero at 1.5 — sky
 * saturation measures identically at every value of this constant from 8.0 down
 * to 2.0.
 */
export const TONE_BLEACH_HALF = 3.0;

/**
 * Shadow toe: how much of the neutral floor is taken out of the darkest
 * channel, as a fraction of it, and the ceiling on that in absolute terms.
 *
 * What a film toe actually does to a deep blue sea is remove the small grey
 * pedestal sitting under it, and that is most of why the old ACES pipeline
 * rendered water people liked: its toe drove the water's red channel to about
 * 2/255. That is also one code away from clipping, which bands on a smooth
 * gradient and reads as flat black on a different display, so this is the same
 * effect built to stop short of it.
 *
 * PROPORTIONAL, not an absolute offset. Subtracting a fixed amount is what ACES
 * and the Khronos Neutral toe do, and it works by daylight and destroys a
 * night: measured, an absolute toe of 0.012 took the night sea's red channel to
 * 0 while the day sea only went to 10. Taking a FRACTION of the darkest channel
 * scales with the scene, so it can never reach zero and never clips — the night
 * sea keeps 4/255 where a fixed offset left it 0.
 *
 * The absolute cap is what keeps it off the highlights: a sunlit cloud is
 * near-neutral, so a purely proportional term would eat its brightness and tint
 * it. Capped, a bright cloud loses 0.02 and measures unchanged at (254,252,251).
 */
export const TONE_TOE_STRENGTH = 0.5;
export const TONE_TOE_MAX = 0.02;

function glslSource(toe: boolean): string {
  return /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {

  color *= toneMappingExposure;

${
  toe
    ? `  // Shadow toe: take a fraction of the darkest channel out of all three,
  // saturating at TOE_MAX so highlights are untouched. Slope at the origin is
  // TOE_STRENGTH and the join is C1, so there is no kink to band on.
  const float k = ${TONE_TOE_STRENGTH.toFixed(4)};
  const float T = ${TONE_TOE_MAX.toFixed(4)};
  float floorC = min( color.r, min( color.g, color.b ) );
  float off = floorC < 2.0 * T / k
    ? k * floorC - k * k * floorC * floorC / ( 4.0 * T )
    : T;
  color = max( color - off, vec3( 0.0 ) );
`
    : ''
}
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < ${TONE_SHOULDER.toFixed(4)} ) return color;

  // Hyperbolic shoulder on the peak channel: value and slope both match the
  // linear segment at the join, and the curve approaches 1 without reaching it.
  const float d = 1.0 - ${TONE_SHOULDER.toFixed(4)};
  float rolled = 1.0 - d * d / ( peak + d - ${TONE_SHOULDER.toFixed(4)} );

  // One common factor for all three channels: the ratios, and therefore the
  // hue and the saturation, survive the shoulder untouched.
  color *= rolled / peak;

  // Bleach only what actually ran out of range, and then only gradually. This
  // is what lets a bright cloud keep its shape once the peak channel has
  // stopped moving — see TONE_BLEACH_HALF.
  float over = max( peak - 1.0, 0.0 );
  const float k2 = ${(TONE_BLEACH_HALF * TONE_BLEACH_HALF).toFixed(2)};
  float bleach = over * over / ( over * over + k2 );
  return mix( color, vec3( rolled ), bleach );

}
`;
}

let installed = false;

/**
 * Replace three's stub `CustomToneMapping` with the curve above, once.
 *
 * Every material in the scene reaches the display through
 * `#include <tonemapping_fragment>`, built-in and hand-written alike, so
 * patching the shared chunk is what makes the sky, the ocean, the ship and the
 * spray agree on one transform.
 *
 * The TONE CURVE can be A/B'd live because three keys its program cache on
 * `renderer.toneMapping`, so changing that value is enough to make every
 * material recompile onto the other transform. The SHADOW TOE cannot: it
 * changes the chunk's source text, which is not part of any cache key, so a
 * live flip would leave every already-compiled program running the old code.
 * It is therefore a page-load switch — `?noToe=1` — and honest about it.
 */
export function installToneCurve(renderer: THREE.WebGLRenderer): void {
  if (!installed) {
    const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
    const stub = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
    if (!chunk.includes(stub)) {
      throw new Error(
        'three.js CustomToneMapping stub not found — the tone curve would ' +
          'silently fall back to a pass-through.',
      );
    }
    THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(
      stub,
      glslSource(isShadowToeEnabled()),
    );
    installed = true;
  }
  // A/B scaffolding. three keys its program cache on `toneMapping`, so this
  // assignment is the whole switch — every material recompiles onto the other
  // transform by itself. See scene/colourPipeline.ts.
  const select = (): void => {
    renderer.toneMapping = isLegacyToneCurve()
      ? THREE.ACESFilmicToneMapping
      : THREE.CustomToneMapping;
  };
  select();
  onColourPipelineChange(select);
}

/**
 * CPU mirror of the curve, for the exposure meter and for any harness that has
 * to predict what a computed radiance will look like on screen.
 */
export function applyToneCurve(
  linear: readonly [number, number, number],
  exposure: number,
): [number, number, number] {
  const c: [number, number, number] = [
    linear[0] * exposure,
    linear[1] * exposure,
    linear[2] * exposure,
  ];
  if (isShadowToeEnabled()) {
    const floorC = Math.min(c[0], c[1], c[2]);
    const k = TONE_TOE_STRENGTH;
    const T = TONE_TOE_MAX;
    const off =
      floorC < (2 * T) / k ? k * floorC - (k * k * floorC * floorC) / (4 * T) : T;
    for (let i = 0; i < 3; i++) c[i] = Math.max(c[i] - off, 0);
  }
  const peak = Math.max(c[0], c[1], c[2]);
  if (peak < TONE_SHOULDER) return c;

  const d = 1 - TONE_SHOULDER;
  const rolled = 1 - (d * d) / (peak + d - TONE_SHOULDER);
  const scale = rolled / peak;
  const over = Math.max(peak - 1, 0);
  const bleach =
    (over * over) / (over * over + TONE_BLEACH_HALF * TONE_BLEACH_HALF);
  for (let i = 0; i < 3; i++) {
    c[i] = c[i] * scale * (1 - bleach) + rolled * bleach;
  }
  return c;
}
