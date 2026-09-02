/**
 * Scotopic vision — the observer, modelled at last.
 *
 * SHIPPING STATUS: retained as an opt-in graphics experiment. Ash rejected the
 * look on 2026-08-17 and chose 0%; `DEFAULT_SCOTOPIC_STRENGTH` is authoritative.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured on this pipeline (`tools`-free probe driving the real `TimeOfDay`,
 * numbers reproduced in `docs/graphics/NIGHT_VISIBILITY_PART_A.md`), a moonless
 * night presents the zenith sky at a display luminance of 0.0035 and the
 * horizon band at 0.0107 — sRGB codes 11 and 27. On a laptop panel in a lit
 * room the screen's own reflected flare sits at 5-15% of panel white, so both
 * of those arrive underneath the reflection of the room. The night is not
 * artistically too dark; it is beneath the display's noise floor.
 *
 * The fix is NOT more photons. Nothing here touches a linear radiance: this
 * operator runs after the display transform, on values already in 0..1. What it
 * models is the part of the chain the renderer never had — the eye. Below
 * roughly 0.01 cd/m the human retina is rod-dominated, and three things follow,
 * all of which help:
 *
 *   1. SENSITIVITY rises. That is the visibility win.
 *   2. COLOUR VANISHES. Rods are monochromatic and peak bluer than cones, so a
 *      dim field desaturates toward blue-grey. Desaturation is part of the
 *      effect, not a cost paid for it.
 *   3. ACUITY DROPS. Rods pool over many receptors. A slight loss of fine
 *      detail in the deepest shadows is correct, and it pays for itself by
 *      hiding the near-black quantisation noise the lift would otherwise
 *      magnify eightfold.
 *
 * WHY THE LIFT HELPS EVEN THOUGH IT COMPRESSES CODE-SPACE CONTRAST
 * ----------------------------------------------------------------
 * The lift is compressive, so it moves the night sky and the night horizon from
 * 13 sRGB codes apart to 8. Counted in codes that is a loss. Counted on the
 * panel it is a gain, and the panel is what the requirement is about. With a
 * 250 cd/m display carrying 15 cd/m of room reflection, the unlifted pair sit
 * at 16.4 and 17.7 cd/m — a Weber contrast of 8%, most of it drowned in flare.
 * Lifted they sit at 20.2 and 22.3 — 10.4%, and both are further clear of the
 * flare floor where the eye's contrast sensitivity is better. That arithmetic
 * is the whole argument for the operator's shape, so it is written down here
 * rather than left as taste.
 *
 * WHAT IS MEASURED AND WHAT IS CHOSEN
 * -----------------------------------
 * MEASURED: every display luminance quoted above and every adaptation
 * luminance below, from the real `TimeOfDay` through the real tone curve.
 * DERIVED: the rod ramp's two anchors (the twilight definitions), and
 * `LIFT_SCALE` (fixed by continuity at the knee, not chosen).
 * CHOSEN: the knee, the lift gamma, the desaturation depth, the acuity depth
 * and the rod tint. These are look constants and Ash's eye is the authority on
 * them; they are gathered here so they can be moved in one place.
 */

/**
 * Display luminance at and above which the pixel is treated as photopic and is
 * passed through EXACTLY unchanged.
 *
 * 0.08. The separation this has to buy is measured: at night the lantern's
 * glass globe renders at display luminance 0.700 and its warm flame core at
 * 0.722,
 * while the sky sits at 0.0035 and the brightest part of the horizon band at
 * 0.0107. 0.08 is 8.8x below the globe and 7.5x above the horizon — the lamp
 * and the sea are on opposite sides of it with an order of magnitude to spare
 * in both directions, which is what "the lantern is not desaturated along with
 * the sea" means in a number.
 */
export const SCOTOPIC_KNEE_HI = 0.08;

/**
 * Display luminance at and below which the pixel is fully rod-driven.
 *
 * 0.004, just under the measured night sky. Below this the whole operator is at
 * full strength; between here and the knee it fades out. Both ends of the fade
 * are a `smoothstep`, so the operator is C1 across the join and cannot draw a
 * Mach band along the iso-luminance contour where it retires.
 */
export const SCOTOPIC_KNEE_LO = 0.004;

/**
 * The lift, as the reciprocal exponent of a power curve on display luminance.
 *
 * 2.0. Its effect, measured through the sRGB encode: the night sky goes from
 * code 11 to 35, the night sea from 14 to 40, the horizon band from 27 to 48.
 * Roughly a stop and a half of display code, which is the order of the gap
 * between "black" and "legible" on an uncalibrated panel.
 */
export const SCOTOPIC_LIFT_GAMMA = 2.0;

/**
 * The lift's scale factor. DERIVED, not chosen — `SCOTOPIC_KNEE_HI` raised to
 * `1 - 1/gamma` is exactly the value that makes the lifted curve pass through
 * the knee, so the lifted and unlifted branches agree in VALUE there as well as
 * being faded together by the `smoothstep`. That is what makes the join C1: the
 * blend weight and its derivative both vanish at the knee, and so does the
 * difference being blended.
 */
export const SCOTOPIC_LIFT_SCALE = scotopicLiftScale(SCOTOPIC_LIFT_GAMMA);

/**
 * The scale that makes a lift of this gamma pass exactly through the knee.
 * `KNEE_HI^(1-1/g)` and nothing else will do it, which is why the calibration
 * may move the gamma freely without ever putting a seam at the join.
 */
export function scotopicLiftScale(gamma: number): number {
  return Math.pow(SCOTOPIC_KNEE_HI, 1 - 1 / gamma);
}

/** The lifted display luminance for a given gamma. The operator's core curve. */
export function scotopicLift(luminance: number, gamma: number): number {
  return scotopicLiftScale(gamma) * Math.pow(Math.max(luminance, 0), 1 / gamma);
}

/** How much of the chroma the rods take, at full rod dominance. */
export const SCOTOPIC_DESATURATION = 0.8;

/** How much of the fine detail the rods lose, at full rod dominance. */
export const SCOTOPIC_ACUITY_LOSS = 0.35;

/**
 * Ceiling on how far a neighbour may exceed the centre pixel before the acuity
 * blur stops averaging it in, in display luminance.
 *
 * Without it the blur is a bleed: a star, a spark of moon glitter or the edge
 * of the lantern is a bright pixel sitting in a dark neighbourhood, and a plain
 * box filter would smear it into the sea. This is the same clamp the temporal
 * resolve uses on history for the same reason. 0.02 is a fifth of the knee, so
 * it averages freely inside the dark band and refuses at its edge.
 */
export const SCOTOPIC_ACUITY_CLAMP = 0.02;

/**
 * The colour of the rod signal, normalised to unit Rec.709 luminance.
 *
 * CHOSEN, not derived, and worth being explicit about why no derivation was
 * available. The Purkinje shift is real — rod peak sensitivity is at 507 nm
 * against the cones' 555 — but V'(lambda) is a scalar efficiency, not a
 * chromaticity, and the perceived blueness of night vision is an appearance
 * effect rather than a spectrum that can be projected onto three primaries. So
 * this is the film and offline-rendering convention: a roughly 10 000 K
 * blue-grey. Ash's eye is the authority on the depth of it.
 */
const ROD_TINT_RAW: readonly [number, number, number] = [0.82, 0.97, 1.35];

function normaliseToUnitLuminance(
  c: readonly [number, number, number],
): [number, number, number] {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / y, c[1] / y, c[2] / y];
}

export const SCOTOPIC_ROD_TINT = normaliseToUnitLuminance(ROD_TINT_RAW);

// --- the rod ramp -----------------------------------------------------------

/**
 * THE OBSERVER'S ADAPTATION LUMINANCE IS MODELLED IN REAL UNITS, NOT READ OFF
 * THE RENDERER.
 *
 * Part A anchored the rod ramp on this pipeline's own exposure meter, matched at
 * the two twilight definitions. That worked exactly as long as the SUN was the
 * only thing moving, and Part B broke it in one measurement: raise the moon to a
 * real order of magnitude and a HALF moon renders the night DARKER than no moon
 * at all — the meter climbs enough to close the exposure and strip the rod lift,
 * while a half moon's own light (phase brightness is cubic, so an eighth of a
 * full one) cannot pay for what it took away.
 *
 * The cause is not the moon. It is that this pipeline compresses the night far
 * harder than it compresses twilight, and by a different factor for each light:
 *
 *     moonless -> end of nautical twilight    reality 8x     here 1.15x
 *     moonless -> end of civil twilight       reality 5000x  here 3.87x
 *
 * A single compressed scalar therefore cannot order two different light sources
 * the way an eye orders them, and no amount of re-fitting the ramp's endpoints
 * will make it, because the two sources need different fits.
 *
 * So the observer stops reading the renderer. This is the spec's own thesis
 * taken one step further — "the pipeline models the light and the camera but not
 * the observer" — and an observer that adapts to the RENDERER's luminance is
 * still not being modelled, it is just being driven by a different lie. The eye
 * adapts to the real world's luminance, so that is what is modelled here, in
 * cd/m2, from textbook twilight values, and the renderer's compression never
 * enters it.
 *
 * The exposure meter is unchanged and still reads the rendered sky. A camera
 * meters what is in front of it; an eye adapts to where it is standing. They are
 * different instruments and they now have different inputs, which is the point.
 */

/** Clear day sky, well above the horizon. */
const RETINAL_DAYLIGHT_CD = 3000;
/** Sun on the horizon. */
const RETINAL_SUNSET_CD = 1000;
/** End of civil twilight, -6 deg: the last light you can work outdoors by. */
const RETINAL_CIVIL_CD = 5;
/** End of nautical twilight, -12 deg: the sea horizon is no longer discernible. */
const RETINAL_NAUTICAL_CD = 0.008;
/** End of astronomical twilight and everything after it, moonless. */
const RETINAL_MOONLESS_CD = 1e-3;
/**
 * A full moon overhead, as landscape luminance.
 *
 * 0.1 cd/m2. Note where this sits: a hundred times a moonless night, and fifty
 * times DIMMER than the end of civil twilight. Both halves of that matter — the
 * first is why a full moon is unmistakable, the second is why it leaves you very
 * nearly as dark-adapted as no moon at all. Our meter had it the other way
 * round, which is the whole reason this model exists.
 */
const RETINAL_FULL_MOON_CD = 0.1;

/** Twilight knots: [sun elevation deg, sky luminance cd/m2]. Log-interpolated. */
const TWILIGHT_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [10, RETINAL_DAYLIGHT_CD],
  [0, RETINAL_SUNSET_CD],
  [-6, RETINAL_CIVIL_CD],
  [-12, RETINAL_NAUTICAL_CD],
  [-18, RETINAL_MOONLESS_CD],
];

/**
 * Real sky luminance for a sun elevation, cd/m2, interpolated in log luminance
 * between the twilight knots and flat outside them.
 *
 * -6 and -12 are exact knots, which is what makes the daylight guarantee exact:
 * at -6 this returns RETINAL_CIVIL_CD to the bit, the ramp's `smoothstep`
 * receives its upper edge exactly, and rod dominance is 0.0 rather than 1e-7.
 * Part A had to round a measured constant down to buy that; here it falls out.
 */
export function twilightLuminanceCd(sunElevationDeg: number): number {
  const first = TWILIGHT_KNOTS[0];
  if (sunElevationDeg >= first[0]) return first[1];
  for (let i = 1; i < TWILIGHT_KNOTS.length; i++) {
    const [hiDeg, hiCd] = TWILIGHT_KNOTS[i - 1];
    const [loDeg, loCd] = TWILIGHT_KNOTS[i];
    if (sunElevationDeg >= loDeg) {
      if (sunElevationDeg === hiDeg) return hiCd;
      if (sunElevationDeg === loDeg) return loCd;
      const t = (sunElevationDeg - loDeg) / (hiDeg - loDeg);
      return Math.pow(10, Math.log10(loCd) + t * (Math.log10(hiCd) - Math.log10(loCd)));
    }
  }
  return RETINAL_MOONLESS_CD;
}

/**
 * What the moon adds to the landscape, cd/m2.
 *
 * Illuminance from a source scales with the sine of its elevation, so a moon on
 * the horizon lights almost nothing however full it is. `phaseBrightness` is the
 * disc-integrated brightness the rest of the pipeline already uses — cubic in
 * illuminated fraction, because the opposition surge makes a half-lit disc far
 * less than half as bright.
 */
export function moonLuminanceCd(
  moonElevationDeg: number,
  phaseBrightness: number,
  visibility: number,
): number {
  const sinElevation = Math.max(Math.sin(moonElevationDeg * (Math.PI / 180)), 0);
  return RETINAL_FULL_MOON_CD * phaseBrightness * visibility * sinElevation;
}

/** What the eye is adapted to, cd/m2. Sun and moon, plus the moonless floor. */
export function retinalLuminanceCd(state: {
  sunElevationDeg: number;
  moonElevationDeg: number;
  moonPhaseBrightness: number;
  moonVisibility: number;
}): number {
  return (
    twilightLuminanceCd(state.sunElevationDeg) +
    moonLuminanceCd(
      state.moonElevationDeg,
      state.moonPhaseBrightness,
      state.moonVisibility,
    )
  );
}

/**
 * Adaptation luminance at which the eye is still fully cone-driven, cd/m2.
 *
 * The end of civil twilight, by definition rather than by fit: the last light in
 * which ordinary outdoor activity is possible without artificial illumination.
 */
export const SCOTOPIC_PHOTOPIC_ADAPTATION = RETINAL_CIVIL_CD;

/**
 * Adaptation luminance at which the eye is fully rod-driven, cd/m2.
 *
 * The end of nautical twilight, again by definition: the point at which the sea
 * horizon is no longer discernible — the eye has run out of cones.
 */
export const SCOTOPIC_SCOTOPIC_ADAPTATION = RETINAL_NAUTICAL_CD;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * How rod-dominated the observer is, 0..1, from the real-world luminance the
 * eye is adapted to (`TimeOfDay.retinalLuminance`, cd/m2).
 *
 * Interpolated in LOG luminance, because adaptation is logarithmic in light.
 *
 * Modelled consequences:
 *
 *     sun   0 deg   1000 cd/m2    rod 0.000  (and every brighter hour with it)
 *     sun  -6 deg      5 cd/m2    rod 0.000
 *     sun  -9 deg    0.20 cd/m2   rod 0.500
 *     sun -12 deg   0.008 cd/m2   rod 1.000
 *     moonless night 0.001 cd/m2  rod 1.000
 *     HALF moon at 40 deg         rod 0.995
 *     FULL moon at 40 deg         rod 0.744
 *
 * The last two lines are the ones to keep, and they are why this reads a
 * modelled luminance instead of the renderer's meter. A full moon is genuinely
 * near the top of the mesopic range, so the observer partly returns to cone
 * vision and the moon carries more of the legibility itself. A HALF moon is not
 * — it is a tenth of a full one and it leaves you essentially as dark-adapted as
 * no moon at all. Driven off the compressed meter, a half moon came out at rod
 * 0.399 and the night went DARKER when it rose. See the block comment above.
 */
export function rodDominance(adaptationLuminance: number): number {
  const l = Math.log10(Math.max(adaptationLuminance, 1e-9));
  return (
    1 -
    smoothstep(
      Math.log10(SCOTOPIC_SCOTOPIC_ADAPTATION),
      Math.log10(SCOTOPIC_PHOTOPIC_ADAPTATION),
      l,
    )
  );
}

/**
 * The adaptation luminance at which the offscreen buffer is switched in, as a
 * multiple of the photopic anchor.
 *
 * Above 1.0 by construction, and that is the point rather than a safety margin.
 * The pass changes where MSAA resolves and where transparency blends — small,
 * real, and nothing to do with the observer model. Engaging it while
 * `rodDominance` is still exactly zero means there is always a stretch of
 * twilight in which the buffer is running and the operator is provably inert,
 * which is where to look for an artefact of the path itself.
 */
export const SCOTOPIC_ENGAGE_RATIO = 1.35;
/** Hysteresis. Wide enough that a cloud crossing the meter cannot chatter it. */
export const SCOTOPIC_RELEASE_RATIO = 1.75;

/**
 * Whether the frame should be routed through the offscreen buffer.
 *
 * Pure, and separated from the pass so the "daylight takes the original code
 * path" clause can be checked without a GPU. Note the `rod > 0` term on the
 * release side: the operator's adaptation lags the meter by seconds, so the
 * buffer has to stay in until the last of it has unwound rather than snapping
 * out mid-fade.
 */
export function scotopicPassEngaged(state: {
  adaptationLuminance: number;
  strength: number;
  rod: number;
  engaged: boolean;
}): boolean {
  if (state.strength <= 0) return false;
  const ratio = state.adaptationLuminance / SCOTOPIC_PHOTOPIC_ADAPTATION;
  return state.engaged
    ? ratio < SCOTOPIC_RELEASE_RATIO || state.rod > 1e-4
    : ratio < SCOTOPIC_ENGAGE_RATIO;
}

// --- the switch -------------------------------------------------------------

/** Ash's recorded shipping verdict: no lift, desaturation or acuity loss. */
export const DEFAULT_SCOTOPIC_STRENGTH = 0;

/**
 * `?scotopic=1` turns the optional observer model on; `?scotopic=<0..1>` opens
 * it at a partial strength. Absent, it is fully off. Ash rejected the look at
 * the end of the 2026-08-17 walkthrough and asked for 0%, not a weaker tuning,
 * so the unlifted direct-to-canvas night is the product and the model is now the
 * experiment.
 *
 * A LIVE switch, unlike `?noToe=1`, and the difference is structural rather
 * than a preference: the toe changes the tone curve's shader SOURCE, which is
 * not part of three's program cache key, so flipping it at runtime would leave
 * compiled programs running the old code. This moves a uniform. Both sides of
 * the A/B are therefore available in one page load, which is what a legibility
 * judgement needs.
 *
 * PARSED IN `RuntimeOptions`, NOT HERE. This module used to read
 * `window.location.search` at module-evaluation time, which is against that
 * file's own stated rule — "runtime systems should not parse query parameters
 * independently" — and the rule is not tidiness. A parameter read at import
 * time is read before `resolveRuntimeOptions` has run, in an order the import
 * graph decides, in a module that has no way to be told it is running inside a
 * test or a node harness; the `typeof window` guard it needed to survive that
 * is the tell. Now the URL is read once, in one place, and pushed in from
 * `main.ts` before anything is built over it — the same shape as `?timber=`.
 *
 * The throw stays here with the value it validates, because the range and the
 * message belong to this module. Note that it is deliberately stricter than
 * `setScotopicStrength`, which CLAMPS: a slider that runs off its end should
 * stop at the end, and a URL that asks for a strength this module does not have
 * should say so rather than silently getting a different night.
 */
export function parseScotopicStrength(raw: string | null): number {
  if (raw === null) return DEFAULT_SCOTOPIC_STRENGTH;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `[scotopic] unknown ?scotopic=${raw} — use 0 (off, the default), 1 (on) or a strength in between`,
    );
  }
  return value;
}

let strength = DEFAULT_SCOTOPIC_STRENGTH;
const listeners = new Set<() => void>();

/** Overall strength of the observer model, 0..1. */
export function scotopicStrength(): number {
  return strength;
}

export function setScotopicStrength(value: number): void {
  const next = Math.min(1, Math.max(0, value));
  if (next === strength) return;
  strength = next;
  for (const listener of listeners) listener();
}

export function onScotopicChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --- the operator ------------------------------------------------------------

/**
 * GLSL. `scotopicVision` takes a tone-mapped display-referred colour, the same
 * colour box-filtered over its four neighbours, and the rod dominance, and
 * returns the colour the observer sees.
 *
 * It is EXACTLY the identity when `rod` is zero, and exactly the identity for
 * any pixel whose luminance is at or above `SCOTOPIC_KNEE_HI` — not
 * approximately, not to within a rounding: the blend weight is a `smoothstep`
 * that is literally 0.0 there and the function returns its argument. That is
 * the whole proof of the "daylight is unchanged" and "the lantern keeps its
 * colour" clauses, and it is why the early return is written as a guard rather
 * than folded into arithmetic.
 */
export const GLSL_SCOTOPIC = /* glsl */ `
const float SCOTOPIC_KNEE_LO = ${SCOTOPIC_KNEE_LO.toFixed(6)};
const float SCOTOPIC_KNEE_HI = ${SCOTOPIC_KNEE_HI.toFixed(6)};
/**
 * The lift, and the scale that keeps it passing through the knee.
 *
 * A UNIFORM rather than a constant, and the reason is the display calibration:
 * the player measures their panel's black floor and the lift is re-derived from
 * it (see scene/displayCalibration.ts). A constant would mean the measurement
 * could only land on a page reload, and a calibration you cannot see take
 * effect is one nobody trusts. Component x is the gamma, y its derived scale.
 */
uniform vec2 uScotopicLift;
const float SCOTOPIC_DESATURATION = ${SCOTOPIC_DESATURATION.toFixed(6)};
const float SCOTOPIC_ACUITY_LOSS = ${SCOTOPIC_ACUITY_LOSS.toFixed(6)};
const vec3 SCOTOPIC_ROD_TINT = vec3(
  ${SCOTOPIC_ROD_TINT[0].toFixed(8)},
  ${SCOTOPIC_ROD_TINT[1].toFixed(8)},
  ${SCOTOPIC_ROD_TINT[2].toFixed(8)}
);

float scotopicLuma( vec3 c ) {
  return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
}

vec3 scotopicVision( vec3 c, vec3 blurred, float rod ) {
  float y = scotopicLuma( c );
  // How rod-driven THIS pixel is. Zero at and above the knee, and the operator
  // returns its argument untouched there — the lamp, the moon's glitter and the
  // bright stars never enter the branch below.
  float w = rod * ( 1.0 - smoothstep( SCOTOPIC_KNEE_LO, SCOTOPIC_KNEE_HI, y ) );
  if ( w <= 0.0 ) return c;

  // Acuity: rods pool, so the darks lose fine detail before anything else.
  vec3 src = mix( c, blurred, SCOTOPIC_ACUITY_LOSS * w );
  float ys = max( scotopicLuma( src ), 1e-7 );

  // Sensitivity. The scale makes this pass through the knee whatever the gamma
  // is, so the mix below is exactly the identity there in value as well as in
  // weight — which is what keeps a recalibration from putting a seam in the sky.
  float lifted = uScotopicLift.y * pow( ys, 1.0 / uScotopicLift.x );
  float target = mix( ys, lifted, w );

  // Purkinje: the rod signal is achromatic, and reads blue-grey.
  vec3 chroma = mix( src, ys * SCOTOPIC_ROD_TINT, SCOTOPIC_DESATURATION * w );

  // One common factor for all three channels, exactly as the tone curve's
  // shoulder does it: brightness is what changes, the ratios are already set.
  return chroma * ( target / ys );
}
`;

/**
 * CPU mirror of `scotopicVision`, for tests and for any harness that has to
 * predict what a display value will look like to the modelled observer.
 *
 * Kept beside the GLSL rather than in a test so the two are edited together;
 * `tests/scotopic.test.ts` pins them to the same arithmetic by re-deriving the
 * constants out of the GLSL source text.
 */
export function applyScotopic(
  colour: readonly [number, number, number],
  blurred: readonly [number, number, number],
  rod: number,
  liftGamma: number = SCOTOPIC_LIFT_GAMMA,
): [number, number, number] {
  const luma = (c: readonly [number, number, number]): number =>
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const y = luma(colour);
  const w = rod * (1 - smoothstep(SCOTOPIC_KNEE_LO, SCOTOPIC_KNEE_HI, y));
  if (w <= 0) return [colour[0], colour[1], colour[2]];

  const a = SCOTOPIC_ACUITY_LOSS * w;
  const src: [number, number, number] = [
    colour[0] + (blurred[0] - colour[0]) * a,
    colour[1] + (blurred[1] - colour[1]) * a,
    colour[2] + (blurred[2] - colour[2]) * a,
  ];
  const ys = Math.max(luma(src), 1e-7);
  const lifted = scotopicLift(ys, liftGamma);
  const target = ys + (lifted - ys) * w;

  const d = SCOTOPIC_DESATURATION * w;
  const scale = target / ys;
  return [
    (src[0] + (ys * SCOTOPIC_ROD_TINT[0] - src[0]) * d) * scale,
    (src[1] + (ys * SCOTOPIC_ROD_TINT[1] - src[1]) * d) * scale,
    (src[2] + (ys * SCOTOPIC_ROD_TINT[2] - src[2]) * d) * scale,
  ];
}
