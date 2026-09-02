/**
 * The frame the foam breakup noise is drawn in, held PIECEWISE CONSTANT.
 *
 * WHY THIS EXISTS
 * ---------------
 * Foam has two halves and only one of them is stored. The *outline* — where a
 * hull or a breaking crest actually put foam — lives in `FoamField`: deposited
 * at a seed position, advected with the water, decayed on its own clock. The
 * *grain* inside that outline is not stored anywhere. It is a noise function
 * re-evaluated per pixel from `q = mod(vDetail, uDetailWrap) * uDetailFreq`.
 *
 * The grain is stretched along a direction, so old foam reads as windrows and
 * wake foam reads as sheared by the hull's passage. "Stretch along a direction"
 * is implemented the only way it can be: rotate `q` into that frame. And `q` is
 * measured from the noise lattice origin, which is up to a full 256-cell wrap
 * away — 614 m at the production detail scale.
 *
 * That makes the frame direction a lever with a 500 m arm. Rotating it by
 * `dtheta` slides the sampled pattern by `|x| * dtheta` metres, everywhere at
 * once, through foam whose outline is standing perfectly still. One degree at
 * 500 m is nine metres. Measured on the shipping wind model at CURRENT_MODERATE
 * (gustiness 0.25), the wind's own wander is a mere 3.4 degrees peak to peak —
 * invisible in the sails, invisible in the sea state — and it drags the grain
 * across stationary water at up to 1.8 m/s, on a sum of 40-240 s sinusoids, so
 * the slide accelerates, peaks, decelerates and reverses. That is the "foam
 * marquee": the reason a patch of foam would not hold its texture.
 *
 * WHY LATCHING, AND NOT SMOOTHING
 * -------------------------------
 * There is no rate of frame rotation that is safe, because the artifact is
 * proportional to the rotation itself and not to its speed. Low-pass filtering
 * the direction makes the marquee slower and permanent instead of faster and
 * oscillating; quantising without a hold makes it jump back and forth across a
 * bin edge. The only stable frame is a constant one.
 *
 * So the frame is HELD. It changes only when the live target has left it by a
 * release angle, and when it does the two frames are evaluated separately and
 * their RESULTS cross-faded — never their angles. Interpolating an angle is
 * exactly the `|q| * dtheta` slide this module exists to prevent, which WK-R10
 * already established for the wind/track blend and which this extends to the
 * frames themselves. A cross-fade dissolves; it does not travel.
 *
 * The anisotropy rides in the same frame for the same reason: it scales the
 * along-frame axis, so changing it also multiplies `q` and also slides the
 * pattern. Direction and stretch are released together or not at all.
 *
 * WHAT THIS DOES NOT FIX
 * ----------------------
 * `uDetailFreq` / `uDetailWrap` scale `q` too, so a sea-state change still
 * moves the grain radially. That is deliberately left live: those are the
 * sea's texture scale, shared with every other detail layer, and a sea-state
 * transition is a wholesale change of the surface in which the grain moving
 * with everything else is coherent rather than anomalous.
 *
 * Nor does this make the grain a property of the water. A single held frame
 * cannot represent a wake with a bend in it — the whole trail carries the
 * current latched course, which is the same accepted lie the live uniform told,
 * now merely told stably. Recording the laying direction per texel in the foam
 * field is the honest fix and is a `FoamField` round.
 */

/** Held and pending frame, plus the cross-fade between them. */
export interface FoamStreakFrame {
  /** Unit direction the grain is currently stretched along. */
  heldX: number;
  heldZ: number;
  /** Anisotropy in [0,1] the held frame was latched with. */
  heldStreak: number;
  /**
   * The frame being cross-faded to. Equal to the held frame while idle, and —
   * critically — CONSTANT for the whole duration of a release. Re-aiming it
   * mid-fade would restore the very sliding lever this removes.
   */
  nextX: number;
  nextZ: number;
  nextStreak: number;
  /** 0 while idle; ramps to 1 across a release, then retires `next` into held. */
  blend: number;
  /** False until the first target arrives, so the frame seeds rather than fades. */
  seeded: boolean;
}

export interface FoamStreakFrameConfig {
  /**
   * How far the live target must leave the held frame before a new one is
   * taken, in degrees.
   */
  releaseDeg: number;
  /** The same release test for the anisotropy, in absolute units. */
  releaseStreak: number;
  /** Seconds a release takes to cross-fade. */
  crossfadeSeconds: number;
}

/**
 * Ambient windrow grain.
 *
 * The release angle is deliberately wider than the wind's entire gust wander.
 * `WorldWind` swings direction by up to +-8 degrees at gustiness 1, so 25
 * degrees clears its full 16-degree peak-to-peak with margin and the ambient
 * grain simply never re-latches on gusts — which is also physically right, as
 * windrows are combed by the mean wind and not by every puff. What does move
 * it is a real, sustained shift of wind or of the vessel's transported frame.
 */
export const FOAM_WIND_STREAK_FRAME: FoamStreakFrameConfig = {
  releaseDeg: 25,
  releaseStreak: 0.05,
  crossfadeSeconds: 2.5,
};

/**
 * Hull-track grain inside the wake.
 *
 * Tighter than the wind's, because a course change genuinely should re-comb the
 * trail's grain and 25 degrees of stale track would read as wrong. It still
 * clears yaw in a seaway — she oscillates a couple of degrees, not twelve — and
 * it clears the wander of the through-water velocity vector under orbital
 * water motion, which is what made this frame the fastest of the two marquees.
 */
export const FOAM_WAKE_STREAK_FRAME: FoamStreakFrameConfig = {
  releaseDeg: 12,
  releaseStreak: 0.05,
  crossfadeSeconds: 1.5,
};

export function createFoamStreakFrame(): FoamStreakFrame {
  return {
    heldX: 1,
    heldZ: 0,
    heldStreak: 0,
    nextX: 1,
    nextZ: 0,
    nextStreak: 0,
    blend: 0,
    seeded: false,
  };
}

/** Cosine of the release angle, precomputed per config. */
function releaseCosine(config: Readonly<FoamStreakFrameConfig>): number {
  return Math.cos((config.releaseDeg * Math.PI) / 180);
}

/**
 * Advance one frame's latch.
 *
 * The target may be any non-zero vector; it is normalised here. A degenerate
 * target (a ship at rest, a calm with no wind axis) leaves the frame exactly
 * where it was, so the grain does not spin as way comes off her.
 *
 * @param dtSeconds presentation seconds. Clamped, so a diagnostic time jump
 *        completes at most one cross-fade rather than skipping the dissolve.
 */
export function advanceFoamStreakFrame(
  frame: FoamStreakFrame,
  config: Readonly<FoamStreakFrameConfig>,
  targetX: number,
  targetZ: number,
  targetStreak: number,
  dtSeconds: number,
): FoamStreakFrame {
  const length = Math.hypot(targetX, targetZ);
  const streak = Number.isFinite(targetStreak) ? targetStreak : frame.heldStreak;

  if (!frame.seeded) {
    if (length < 1e-6) return frame;
    frame.heldX = targetX / length;
    frame.heldZ = targetZ / length;
    frame.heldStreak = streak;
    frame.nextX = frame.heldX;
    frame.nextZ = frame.heldZ;
    frame.nextStreak = streak;
    frame.blend = 0;
    frame.seeded = true;
    return frame;
  }

  const dt = Math.min(Math.max(Number.isFinite(dtSeconds) ? dtSeconds : 0, 0), 0.25);

  // A release in flight runs to completion untouched. `next` is a snapshot, and
  // the whole point of the snapshot is that nothing re-aims it while it shows.
  if (frame.blend > 0) {
    const step = config.crossfadeSeconds > 1e-6 ? dt / config.crossfadeSeconds : 1;
    frame.blend += step;
    if (frame.blend >= 1) {
      frame.heldX = frame.nextX;
      frame.heldZ = frame.nextZ;
      frame.heldStreak = frame.nextStreak;
      frame.blend = 0;
    }
    return frame;
  }

  if (length < 1e-6) return frame;
  const unitX = targetX / length;
  const unitZ = targetZ / length;

  const alignment = unitX * frame.heldX + unitZ * frame.heldZ;
  const turned = alignment < releaseCosine(config);
  const stretched = Math.abs(streak - frame.heldStreak) > config.releaseStreak;
  if (!turned && !stretched) return frame;

  frame.nextX = unitX;
  frame.nextZ = unitZ;
  frame.nextStreak = streak;
  // Strictly positive so the shader's idle branch is an exact test, and small
  // enough that the dissolve starts from the held frame rather than jumping.
  frame.blend = 1e-6;
  return frame;
}

/** Anything with the memory layout of a vec3. Keeps this module free of three. */
export interface FoamStreakFrameSink {
  x: number;
  y: number;
  z: number;
}

/**
 * Write the two frames into their uniform vectors as (dirX, dirZ, streak).
 *
 * `b` is written even while idle, where it equals `a`. A stale `b` behind a
 * zero blend is invisible today and a trap tomorrow, and the write is free.
 */
export function publishFoamStreakFrame(
  frame: Readonly<FoamStreakFrame>,
  a: FoamStreakFrameSink,
  b: FoamStreakFrameSink,
): void {
  a.x = frame.heldX;
  a.y = frame.heldZ;
  a.z = frame.heldStreak;
  b.x = frame.nextX;
  b.y = frame.nextZ;
  b.z = frame.nextStreak;
}
