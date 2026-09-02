import type { SeaState } from './seaState';
import { blendSeaState, cloneSeaState } from './seaState';

/**
 * Owns the sea state and moves it between conditions.
 *
 * WHY TRANSITIONS ARE THE HARD PART
 * ---------------------------------
 * Replacing a spectrum outright pops, because every component's frequency,
 * direction and amplitude changes at once and the phase each one had
 * accumulated is thrown away. The fix has two halves and both live outside this
 * class, which is why this one is so small:
 *
 *  - `spectrum.ts` parameterises each slot by its *spectral quantile* rather
 *    than by an absolute frequency. Slot 7 of the primary swell is always the
 *    7th m₁-quantile of whatever spectrum the parameters describe, so when the
 *    peak period changes every slot moves together and continuously instead of
 *    the set being rebuilt.
 *  - `WaveField.applySeaState(state, continuous)` re-seeds each slot's phase
 *    offset so its total phase is exactly what it was an instant before. A
 *    component that changes frequency keeps the phase it had; only its rate
 *    changes.
 *
 * So all this has to do is interpolate the parameters smoothly and hand them
 * over every frame. There is no crossfade, no second spectrum, no phase reset,
 * and no partition is ever created or destroyed — a system that switches on
 * ramps up from zero height, which is continuous everywhere.
 *
 * RATE MATTERS, AND THE DEFAULT IS DELIBERATELY SLOW
 * --------------------------------------------------
 * Changing a component's wavenumber by Δk shifts its phase at distance R by
 * Δk·R radians, so a fast morph tears the far field even though it is smooth at
 * the origin. Holding that below about 0.05 rad/s out to the ~200 m where
 * individual crests are still distinguishable means a swell halving its
 * wavelength needs a couple of minutes. Real sea states take tens of minutes to
 * change, so the physically honest rate is also the visually safe one.
 */
export class SeaStateController {
  private from: SeaState;
  private to: SeaState;
  private elapsed = 0;
  private duration = 0;
  private current: SeaState;

  constructor(initial: SeaState) {
    this.from = cloneSeaState(initial);
    this.to = cloneSeaState(initial);
    this.current = cloneSeaState(initial);
  }

  /** The interpolated state as of the last `advance()`. */
  get state(): SeaState {
    return this.current;
  }

  /** The state being moved towards. Equal to `state` when settled. */
  get target(): SeaState {
    return this.to;
  }

  get transitioning(): boolean {
    return this.duration > 0 && this.elapsed < this.duration;
  }

  /** 0..1 progress through the current transition. */
  get progress(): number {
    return this.duration > 0 ? Math.min(this.elapsed / this.duration, 1) : 1;
  }

  /**
   * Move towards a new sea state.
   *
   * `seconds <= 0` snaps, which is what a preset button and every deterministic
   * capture want: a reproducible state with no history in it.
   */
  set(next: SeaState, seconds: number): void {
    if (seconds <= 0) {
      this.from = cloneSeaState(next);
      this.to = cloneSeaState(next);
      this.current = cloneSeaState(next);
      this.elapsed = 0;
      this.duration = 0;
      return;
    }
    // Start from wherever the interpolation currently is, so redirecting a
    // transition part-way through does not jump back to its origin.
    this.from = cloneSeaState(this.current);
    this.to = cloneSeaState(next);
    this.elapsed = 0;
    this.duration = seconds;
  }

  /** Edit the live state directly, as the ocean lab's sliders do. */
  replaceImmediate(next: SeaState): void {
    this.set(next, 0);
  }

  /**
   * @returns true when the interpolated state changed and must be re-applied.
   */
  advance(dt: number): boolean {
    if (!this.transitioning) return false;
    this.elapsed += dt;
    const t = Math.min(this.elapsed / this.duration, 1);
    // Smoothstep rather than linear, so the transition has no discontinuity in
    // rate at either end — a corner in dk/dt is visible as a lurch in the far
    // field even when the value itself is continuous.
    const eased = t * t * (3 - 2 * t);
    this.current = blendSeaState(this.from, this.to, eased);
    return true;
  }
}
