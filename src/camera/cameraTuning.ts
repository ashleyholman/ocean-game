/**
 * The camera's numbers, and the curves that join them up.
 *
 * Everything here is pure: no three.js, no DOM, no state. The controllers ask
 * this module what a scale means and where a frame should sit, which is what
 * lets the whole geometry be tested without a renderer.
 *
 * THE COMPOSITION EQUATIONS
 * -------------------------
 * For a perspective camera with vertical FOV `f` whose forward axis is pitched
 * down by `theta`, a direction at depression angle `d` below horizontal lands at
 *
 *     fraction_from_top = 0.5 * (1 + tan(d - theta) / tan(f/2))
 *
 * The horizon is `d = 0` (the geometric dip at 300 m is 0.55 degrees, under two
 * pixels at 4K, and the sea here is flat anyway), which gives the horizon
 * placement used throughout:
 *
 *     F_horizon = 0.5 * (1 - tan(theta) / tan(f/2))
 *
 * FOUR QUANTITIES THAT ARE NOT THE SAME QUANTITY
 * ----------------------------------------------
 *   1. ELEVATION  — the angle of the camera *position* above the vessel.
 *   2. OPTICAL PITCH — the downward tilt of the camera's forward *axis*.
 *   3. FRAMING TARGET — the point the axis actually passes through, which is
 *      deliberately not the vessel.
 *   4. VESSEL SCREEN POSITION — where the vessel ends up, which is a
 *      consequence of the first three rather than an input.
 *
 * They are related by `theta = elevation - delta`, where `delta` is an angular
 * offset held constant as the user changes elevation. Holding `delta` rather
 * than `theta` is what keeps the vessel at a stable place in frame while the
 * player orbits, and lets the horizon rise out of frame in a deliberately steep
 * bird's-eye view instead of the vessel sliding off the bottom.
 *
 * `camera.lookAt(vessel)` is therefore wrong at every scale, not just some of
 * them: it forces `delta = 0`, which pins the vessel to the exact centre of the
 * frame and drags the horizon to wherever that leaves it.
 */

const DEG = Math.PI / 180;

/**
 * Monotone cubic Hermite interpolation (Fritsch-Carlson).
 *
 * Chosen over a plain cubic spline because it cannot overshoot: a spline
 * through rising distance knots can dip *backwards* between them, which would
 * make the zoom non-monotonic in the middle of its range while still passing
 * through every authored value. It is C1, so the zoom has no rate
 * discontinuity, and where the data is monotone the interpolant is too — which
 * is the invariant the tests assert rather than assume.
 */
export function monotoneCubic(
  xs: readonly number[],
  ys: readonly number[],
): (x: number) => number {
  const n = xs.length;
  if (n !== ys.length || n < 2) throw new Error('monotoneCubic: bad knots');

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(xs[i + 1] - xs[i]);
    slope.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }

  // Tangents: one-sided at the ends, weighted harmonic mean inside. The
  // harmonic mean is zero whenever the neighbouring slopes disagree in sign,
  // which is exactly what flattens the curve at a local extremum instead of
  // letting it overshoot past the knot.
  const m: number[] = new Array(n).fill(0);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1];
    const b = slope[i];
    if (a * b <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / a + w2 / b);
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}

/**
 * One authored point on the cinematic scale.
 *
 * Distance is the only thing authored. Altitude is `distance * sin(elevation)`
 * with a single constant elevation, and optical pitch comes from the horizon
 * fraction alone — so neither can drift out of step with the other.
 */
export interface CinematicKnot {
  readonly scale: number;
  readonly distance: number;
}

/**
 * The cinematic scale, from close external inspection to high aerial.
 *
 * Distance is interpolated in LOG space. A linear distance slider over the
 * reference 12 m to 1400 m range spends almost all of its travel in the aerial
 * views, so the close and default range — which is most of what anyone looks at
 * — would live in a sliver of the wheel. In log space every turn of the wheel
 * is the same *proportional* change, which is what the eye reads as zooming.
 *
 * The table below is the camera scale for every vessel. Vessel dimensions never
 * clamp or remap it: a player can always return to the same close inspection
 * distance, even when that deliberately crops a large rig. The controller may
 * translate the camera upward to improve the composition, but distance and
 * scroll response remain exactly authored here.
 *
 * The knots are compositions, not round numbers:
 *   0.00  close inspection, the vessel filling the lower half of the frame
 *   0.40  the default medium-close composition
 *   0.75  a medium vista where individual waves have visibly shrunk
 *   1.00  the far aerial view
 *
 * TWO RULES, HELD EXACTLY, AT EVERY SCALE
 * ---------------------------------------
 * RULE 1 — the horizon does not move. It sits `HORIZON_FROM_TOP` down the
 * frame at every distance. Since the optical pitch depends only on that
 * fraction and the field of view, the camera's *aim never changes* across the
 * whole 12–1400 m range: zooming out changes distance and nothing else.
 *
 * An earlier version tapered the fraction from 0.33 at the default to 0.20 at
 * the far end, on the theory that an aerial view wants more ocean in frame. It
 * reads as the camera scooping its nose down as you scroll out, with the sky
 * quietly draining away — two things changing when only one was asked for. The
 * ocean still fills two thirds of the frame at every scale; what grows with
 * distance is the *area of sea* inside that two thirds, which is the whole
 * point of the far view.
 *
 * RULE 2 — the authored distance and base height travel along one straight line.
 *
 * The line leaves the vessel at a fixed, shallow angle, so base height and
 * setback grow in proportion. The assembled-vessel framing pass may add a
 * Y-only lift to that base position, but it never remaps distance or changes the
 * camera quaternion. The line therefore remains the stable authored input while
 * the composition gains enough headroom for a taller rig.
 *
 * Before that lift, the slope decides where the vessel anchor sits in frame.
 * The identity below fixes the *gap* between the anchor and the horizon from the
 * elevation alone:
 *
 *     F_vessel - F_horizon = tan(elevation) / (2 tan(f/2))
 *
 * so with the horizon pinned at a third, a steep line puts the vessel low and a
 * shallow one puts it high. At 13.7 degrees the vessel lands at 60% down — on the
 * lower third line, with the sea beyond it crushed into the top third and the
 * sea on the camera's own side cut off by the bottom edge a few hundred metres
 * short of it, so the view reads as looking *past* the vessel rather than being
 * out there with it. At 11 degrees it lands at 55%, just above the middle of
 * the water and just below the middle of the frame, and the near edge of the
 * visible sea moves in from 38% of the vessel's distance to 48% of it.
 *
 * A shallower line costs distance, not height: holding 267 m of altitude at 11
 * degrees needs 1400 m of setback where 13.7 degrees needed 1100 m. That is the
 * whole trade, and it is worth paying — the vessel ends up under two pixels
 * across at the far end, which is the point being made rather than a defect.
 *
 * WHAT IS AUTHORED
 * ----------------
 * A single elevation, a single horizon fraction, and a table of distances:
 *
 *     theta     = atan((1 - 2 F_h) tan(f/2))     optical pitch, from rule 1
 *     altitude  = distance * sin(elevation)      from rule 2
 *     delta     = elevation - theta              aim offset, held under orbit
 *
 * Distance is interpolated in log space and is strictly increasing, so the base
 * altitude is too — monotone at every point, not merely at the knots.
 */
const HORIZON_FROM_TOP = 0.33;

/**
 * Slope of the line the camera travels out along, radians.
 *
 * 11 degrees: height is 0.194 of setback. See rule 2 for why this number and
 * not a steeper one.
 */
const CINEMATIC_ELEVATION = 11 * DEG;

export const CINEMATIC_KNOTS: readonly CinematicKnot[] = [
  { scale: 0.0, distance: 12 },
  { scale: 0.2, distance: 25 },
  { scale: 0.4, distance: 45 },
  { scale: 0.6, distance: 130 },
  { scale: 0.75, distance: 330 },
  { scale: 0.88, distance: 750 },
  { scale: 1.0, distance: 1400 },
];

/** The scale the camera opens on, and the one `reset` returns to. */
export const CINEMATIC_DEFAULT_SCALE = 0.4;

const logDistance = monotoneCubic(
  CINEMATIC_KNOTS.map((knot) => knot.scale),
  CINEMATIC_KNOTS.map((knot) => Math.log(knot.distance)),
);

/**
 * Clamps, written so that NaN comes out as the lower bound rather than as NaN.
 *
 * `value < 0 ? 0 : value > 1 ? 1 : value` is the obvious form and it passes NaN
 * straight through, because every comparison against NaN is false. One NaN
 * anywhere upstream — a zero-height viewport, a restored preference that was
 * never a number — then becomes a NaN scale, a NaN position, and a camera whose
 * matrix silently stops drawing anything. The invariant this round is held to
 * is "no NaN at any scale", and a clamp that launders NaN is the cheapest place
 * to make that true. Testing `>=` first inverts the sense of the NaN case: the
 * comparison is false, so the value falls through to the bound.
 */
export function clamp01(value: number): number {
  return value >= 0 ? (value <= 1 ? value : 1) : 0;
}

export function clamp(value: number, min: number, max: number): number {
  return value >= min ? (value <= max ? value : max) : min;
}

/** Slant distance from the vessel, metres. Strictly increasing in `scale`. */
export function cinematicDistance(scale: number): number {
  return Math.exp(logDistance(clamp01(scale)));
}

/** Authored horizon placement, as a fraction of frame height from the top. */
export function cinematicHorizonFraction(aspect: number): number {
  return HORIZON_FROM_TOP + aspectHorizonOffset(aspect);
}

/** Optical pitch that puts the horizon where rule 1 asks for it, radians. */
export function opticalPitchFor(
  horizonFromTop: number,
  tanHalfFov: number,
): number {
  return Math.atan((1 - 2 * horizonFromTop) * tanHalfFov);
}

/**
 * Elevation of the authored base position above the vessel, radians.
 *
 * One constant, at every scale: the camera runs out along a single straight
 * line. See rule 2.
 */
export function cinematicElevation(): number {
  return CINEMATIC_ELEVATION;
}

/** Authored base height above mean water, metres. Strictly increasing in scale. */
export function cinematicAltitude(scale: number): number {
  return cinematicDistance(scale) * Math.sin(CINEMATIC_ELEVATION);
}

/**
 * The angular offset held between the camera's forward axis and the vessel.
 *
 * Positive means the axis points *above* the vessel, which drops the vessel down
 * the frame. It is the elevation less the optical pitch, and it is angular
 * rather than a screen offset, so the framing survives a change of scale, of
 * aspect, or of field of view — and it is what the orbit holds constant, so
 * pushing the camera up moves the horizon rather than sliding the vessel.
 */
export function cinematicAimOffset(
  horizonFromTop: number,
  tanHalfFov: number,
): number {
  return CINEMATIC_ELEVATION - opticalPitchFor(horizonFromTop, tanHalfFov);
}

/** Where the vessel lands, as a fraction of frame height from the top. */
export function vesselFrameFraction(
  horizonFromTop: number,
  tanHalfFov: number,
): number {
  return (
    0.5 *
    (1 + Math.tan(cinematicAimOffset(horizonFromTop, tanHalfFov)) / tanHalfFov)
  );
}

/** Where a direction at depression `d` lands, as a fraction from the top. */
export function frameFractionForDepression(
  depressionRad: number,
  opticalPitchRad: number,
  tanHalfFov: number,
): number {
  return 0.5 * (1 + Math.tan(depressionRad - opticalPitchRad) / tanHalfFov);
}

/** Where the horizon lands, as a fraction of frame height from the top. */
export function horizonFraction(
  opticalPitchRad: number,
  tanHalfFov: number,
): number {
  return 0.5 * (1 - Math.tan(opticalPitchRad) / tanHalfFov);
}

// --- field of view ----------------------------------------------------------

/** Reference horizontal FOV for the cinematic camera; vertical is derived. */
const CINEMATIC_FOV_HORIZONTAL_REF = 71 * DEG;
const CINEMATIC_FOV_VERTICAL_MIN = 42 * DEG;
const CINEMATIC_FOV_VERTICAL_MAX = 62 * DEG;

/**
 * Reference horizontal FOV for the embodied camera, and its bounds.
 *
 * Wider than the cinematic camera because a human head is not a long lens.
 *
 * 102 degrees horizontal, which at 16:9 resolves to about 67 vertical. It was
 * 88/58, then 112/76, and now this — each of the three Ash's, off the slider.
 *
 * The case for 112 was made on the open deck: the rails run fore and aft, so
 * the geometry nearest the frame edges is nearly parallel to the view direction
 * and stretches very little, and a wide lens is what makes a small ship feel
 * like a place. That is still true up there.
 *
 * **What changed is that the game acquired interiors you sit still in.** A wide
 * lens flatters a deck and punishes a cabin: the captain's desk is 0.5 m from
 * the eye, its edges are near the frame edges, and at 112 they stretch. 102 is
 * inside the 90-105 desktop convention and gives up very little of the deck.
 *
 * There is a second reason to be at the wide end here rather than the narrow
 * one: field of view is what makes a small ship feel like a place. A narrow
 * lens crops the deck to whatever is straight ahead, which is exactly the
 * "there is no room on this ship" complaint.
 */
let embodiedFovHorizontalRef = 102 * DEG;

/**
 * Bounds on the *vertical* field, whatever the horizontal reference asks for.
 *
 * These exist for extreme aspects — a phone in portrait turns a wide horizontal
 * into a fisheye, an ultra-wide window turns it into a letterbox slit — and they
 * were 64-78, a fourteen-degree window. On a 2.1 aspect display that pinned the
 * result to the floor across most of the slider's travel: Ash dragged from 70 to
 * 105 and nothing moved, then everything moved at once above 106. **A clamp that
 * binds over most of a control's range reads as a broken control**, and it was
 * not visible because the slider showed the number it had asked for rather than
 * the number it got.
 *
 * 40-90 still catches the cases the guard is for and binds on nothing a desktop
 * or a phone will produce in normal use. The panel now also reports the vertical
 * field it actually ended up with, so a clamp is legible instead of mysterious.
 */
const EMBODIED_FOV_VERTICAL_MIN = 40 * DEG;
const EMBODIED_FOV_VERTICAL_MAX = 90 * DEG;

/** The reference horizontal field, radians. A live setting, not a constant. */
export function embodiedFovReference(): number {
  return embodiedFovHorizontalRef;
}

/** Set the reference horizontal field, radians. Clamped to a usable band. */
export function setEmbodiedFovReference(radians: number): void {
  embodiedFovHorizontalRef = clamp(radians, 60 * DEG, 130 * DEG);
}

/**
 * Hybrid Hor+: hold the horizontal field until the vertical clamp bites.
 *
 * Pure Hor+ on a tall phone gives a vertical field near 130 degrees, which
 * bends the horizon into a smile. Pure Vert- on a wide desktop throws away the
 * width the composition is built around. Clamping the derived vertical keeps
 * both ends honest.
 */
function horizontalPlus(
  aspect: number,
  reference: number,
  minVertical: number,
  maxVertical: number,
): number {
  const tanV = clamp(
    Math.tan(reference / 2) / Math.max(aspect, 1e-3),
    Math.tan(minVertical / 2),
    Math.tan(maxVertical / 2),
  );
  return 2 * Math.atan(tanV);
}

/** Vertical FOV for the cinematic camera at an aspect ratio, radians. */
export function cinematicFov(aspect: number): number {
  return horizontalPlus(
    aspect,
    CINEMATIC_FOV_HORIZONTAL_REF,
    CINEMATIC_FOV_VERTICAL_MIN,
    CINEMATIC_FOV_VERTICAL_MAX,
  );
}

/**
 * Vertical FOV for the embodied camera, radians.
 *
 * Constant with scale: there is no zoom in embodied mode, because a fixed field
 * is what makes the vessel feel like a place with a real size rather than a model
 * being inspected.
 */
export function embodiedFov(aspect: number): number {
  return horizontalPlus(
    aspect,
    embodiedFovHorizontalRef,
    EMBODIED_FOV_VERTICAL_MIN,
    EMBODIED_FOV_VERTICAL_MAX,
  );
}

/**
 * Portrait lift for the authored horizon.
 *
 * A tall frame filled two thirds with water reads as a wall, so the horizon is
 * allowed to sit lower on a phone. Applied as an offset to the authored
 * fraction rather than as a second table, so there is one composition curve.
 */
export function aspectHorizonOffset(aspect: number): number {
  const t = clamp01((aspect - 0.6) / 0.4);
  return 0.05 * (1 - t);
}

// --- orbit limits -----------------------------------------------------------

/** The steepest bird's-eye orbit. Short of vertical, where azimuth degenerates. */
export const ELEVATION_MAX = 82 * DEG;

/**
 * How far the camera must stay above the water it is looking across.
 *
 * Derived from the sea that is actually there, not from a constant: a 6 m
 * floor is generous in DEAD_CALM and underwater in SOUTHERN_OCEAN_ROUGH, whose
 * crests reach many metres. The caller passes the local surface height it
 * sampled, and this adds the clearance a camera needs to read as flying over
 * the sea rather than swimming in it.
 *
 * It scales with distance because the consequence of getting close to the
 * surface scales with distance. At nine metres the camera is inspecting the
 * vessel and a metre of air over the crests is plenty; at a kilometre a crest
 * crossing the lens would be a wall across the whole frame.
 */
export function waterClearance(distance: number): number {
  return clamp(0.12 * distance, 0.9, 2.5);
}

/**
 * An asymmetric follower: quick to rise, slow to fall.
 *
 * A symmetric low-pass on a wave train returns its *mean*, which is the wrong
 * statistic for anything that has to stay above the water. The camera needs to
 * clear the crests, and a floor at the mean is under water half the time — so
 * it gets shoved up at every crest and drops back in every trough, which is
 * precisely the bobbing the filter was put there to remove.
 *
 * Rising fast and falling slowly tracks the crest envelope instead: the floor
 * settles just under the highest water the camera has seen lately and stays
 * there, so the clamp either bites steadily or not at all.
 */
export function attackRelease(
  current: number,
  target: number,
  attackTau: number,
  releaseTau: number,
  dt: number,
): number {
  return approach(
    current,
    target,
    target > current ? attackTau : releaseTau,
    dt,
  );
}

// --- embodied look ----------------------------------------------------------

/**
 * Pitch limits for the embodied camera.
 *
 * The upper limit is one degree short of the zenith: at a 62 degree vertical
 * field the zenith is still a twentieth of the frame from centre, so it is
 * comfortably in view, and stopping short of exactly vertical means the look
 * basis never degenerates. The orientation is composed from quaternions rather
 * than a look-at with an up vector, so there is no yaw inversion or NaN even at
 * the limit — the clamp is a comfort choice, not a numerical rescue.
 */
export const EMBODIED_PITCH_MAX = 89 * DEG;
export const EMBODIED_PITCH_MIN = -85 * DEG;

/**
 * Where the horizon sits in the default embodied view, as a fraction of frame
 * height from the top.
 *
 * Two thirds down, so two thirds of the frame is sky. Sitting on a vessel, the
 * water within a few metres is most of what a downward-tilted view actually
 * shows, and it is the least interesting thing in the scene; the sky is where
 * the weather, the light and — at night — the entire reason to look up live.
 * Tilting the default gaze up trades deck for sky, which is the right trade for
 * a view whose job is to say "I am out here".
 *
 * Authored as a *fraction* rather than as an angle, for the same reason the
 * cinematic camera's is: the embodied field of view is clamped at both ends of
 * the aspect range, so a fixed pitch puts the horizon somewhere different on a
 * phone than on a desktop. Deriving the angle from the fraction holds the
 * composition instead.
 */
const EMBODIED_HORIZON_FROM_TOP = 2 / 3;

/**
 * Default embodied look pitch, radians, positive up.
 *
 * Inverts the composition equation at the horizon's own depression of zero:
 * `F = 0.5 (1 + tan(pitch) / tan(f/2))`.
 */
export function embodiedDefaultPitch(aspect: number): number {
  const tanHalf = Math.tan(embodiedFov(aspect) / 2);
  return Math.atan((2 * EMBODIED_HORIZON_FROM_TOP - 1) * tanHalf);
}

// --- transition -------------------------------------------------------------

/**
 * How long the mode change takes, seconds.
 *
 * Scaled with the distance travelled so that stepping onto the vessel from eight
 * metres does not take as long as diving 900 m, but bounded at both ends: below
 * 0.7 s the move reads as a cut, and above about 1.4 s the player has time to
 * wonder whether the control worked.
 */
export function transitionSeconds(
  distanceMetres: number,
  base = 0.7,
  span = 0.55,
  max = 1.4,
): number {
  return clamp(
    base + span * Math.log10(1 + Math.max(distanceMetres, 0) / 25),
    base,
    max,
  );
}

/** Smootherstep: zero velocity and zero acceleration at both ends. */
export function smootherstep(u: number): number {
  const t = clamp01(u);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * The mode transition's easing: leaves quickly, arrives slowly.
 *
 * Smootherstep is symmetric, so its fastest moment is the exact middle of the
 * move — and since the path is steepest at the *end*, where it drops down the
 * shaft onto the eye, symmetric timing spends the fastest part of the clock on
 * the steepest part of the curve. The result reads as a lob: out, over, and
 * then a plunge into the deck.
 *
 * A move that is quick to leave and slow to land reads better, and it is also
 * closer to how approaching anything actually looks: the apparent rate of a
 * thing you are flying towards goes as speed over distance, so holding that
 * roughly steady means shedding speed as the distance closes.
 *
 * This is the integral of `60 u^2 (1 - u)^3`, normalised — a speed profile that
 * is zero at both ends, zero in its *slope* at both ends, and peaks at two
 * fifths rather than one half:
 *
 *     e(u)  = 20u^3 - 45u^4 + 36u^5 - 10u^6
 *     e'(u) = 60 u^2 (1 - u)^3
 *
 * Two thirds of the way there by half time, against a half for smootherstep.
 * The first draft used `105 u^2 (1 - u)^4`, which puts it 77% of the way there
 * by half time — measured in the browser, that spent the last 38% of a
 * nine-hundred-millisecond move covering the final metre, which reads as a
 * rush followed by a hover rather than as an arrival. Two fifths is the skew
 * that is clearly asymmetric without becoming a stall.
 *
 * C2 at both ends, so there is no jerk leaving and none landing.
 */
export function easeArrival(u: number): number {
  const t = clamp01(u);
  const t3 = t * t * t;
  return t3 * (20 + t * (-45 + t * (36 - t * 10)));
}

/**
 * `easeArrival` run backwards, to within a ten-thousandth.
 *
 * Needed only when a transition is reversed in flight. A symmetric ease can be
 * turned around by reflecting the clock, because `s(1 - u) = 1 - s(u)`; an
 * asymmetric one cannot, and reflecting it anyway would jump the camera.
 * Solving `e(u\') = 1 - e(u)` instead puts the clock exactly where the other
 * direction would have to be to be at the position the camera is already at, so
 * the reversal is continuous in position and merely changes sign in velocity.
 *
 * Bisection rather than a closed form: `e` is a sextic, strictly increasing on
 * [0, 1], and this runs once per reversal.
 */
export function easeArrivalInverse(value: number): number {
  const target = clamp01(value);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (easeArrival(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Frame-rate-independent exponential approach.
 *
 * `current += (1 - exp(-dt/tau)) * (target - current)` rather than
 * `current += k * (target - current)`: the second form settles at a rate that
 * depends on how fast the machine happens to be running, so the same camera
 * damps differently at 30 and 144 Hz.
 */
export function approach(
  current: number,
  target: number,
  tau: number,
  dt: number,
): number {
  if (tau <= 0) return target;
  return current + (1 - Math.exp(-dt / tau)) * (target - current);
}
