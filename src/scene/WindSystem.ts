import * as THREE from 'three';

/**
 * Presentation state for a fixed wind and binary sail.
 *
 * Physical speed and travel live exclusively in PlanetaryWorld. This class
 * retains the old target speed for the diagnostic raft and animates the cloth;
 * the production schooner does not treat that target as a sail force. It never
 * integrates a position or keeps a second velocity.
 *
 * WHO STILL OWNS THE SAIL, AFTER A CENSUS THAT EXPECTED TO DELETE IT
 * ------------------------------------------------------------------
 * `sail`, `sailRaised`, `toggleSail`, `targetDriftSpeedMps` and the two
 * `driftSpeed*` constants read as raft-era debt, and they are — but they are
 * live debt, not dead code, so nothing here was removed:
 *
 * - `sail`, the animated 0..1 float, is read by `Raft.ts` alone, where it
 *   furls the canvas and lifts the yard.
 * - `targetDriftSpeedMps` is the speed source for every vessel that is NOT
 *   force-integrated. The raft, the buoyancy lab and the schooner viewer all
 *   reach it through `VesselSpeedTarget`, so raising the sail on
 *   `?debug=schooner` really does change how fast she is towed past the
 *   camera. The raft is a supported diagnostic vessel, and this is its engine.
 * - `sailRaised` is read in exactly one further place: one word in the
 *   `?debug` World panel.
 *
 * What WAS retired is the production advertisement. R is bound only on a
 * drift-speed vessel (`InputCallbacks.onToggleSail` is optional). The physical
 * mast tap is narrower still: only the raft publishes that object target and
 * receives `onTapSail`. The opening hint follows the control available on its
 * platform. On the production schooner the sails are trimmed by the crew, and
 * a key that moved nothing but a debug string was teaching the player
 * something untrue.
 */

const DEG = Math.PI / 180;

export class WindSystem {
  /**
   * Heading the wind blows *towards*, degrees clockwise from north.
   *
   * Zero is a PLACEHOLDER, not a wind. It was 68° until WX2, which is neither
   * the production sea's 144° nor anything else in the project — a third
   * hardcoded wind, live from construction until the first `setOceanWind`, and
   * plausible enough that it would have stood in for a wind that failed to
   * arrive without anybody noticing. `VesselRuntime` publishes the present wind
   * every frame, so this value's whole life is one construction.
   */
  headingDeg = 0;
  /**
   * Nominal wind strength, m/s — feeds wave slope statistics in the shader.
   * Zero for the reason above: a sea with no wind on it is a visible fault, and
   * 6 m/s was not.
   */
  strength = 0;

  /** Unit vector in the XZ plane, in the direction the wind blows. */
  readonly direction = new THREE.Vector2();

  /**
   * Direction the vessel is actually travelling, in render axes.
   *
   * Kept separate from the wind because they are different things and this
   * round made them separable: the sea state owns the wind, the world owns the
   * course. Before, one vector did both jobs and a wind change could not be
   * expressed at all.
   */
  readonly courseDirection = new THREE.Vector2(0, -1);

  /** 0 = fully furled, 1 = fully raised. Animated, not instantaneous. */
  sail = 0;
  /** What the sail is heading towards. */
  private sailTarget = 0;
  /** Seconds for a full raise or lower. */
  readonly sailTransition = 1.25;

  driftSpeedSailUp = 0.55;
  driftSpeedSailDown = 0.09;

  constructor() {
    this.applyHeading();
  }

  applyHeading(): void {
    const a = this.headingDeg * DEG;
    this.direction.set(Math.sin(a), -Math.cos(a));
  }

  get headingRad(): number {
    let headingRad = Math.atan2(this.direction.x, -this.direction.y);
    if (headingRad < 0) headingRad += 2 * Math.PI;
    return headingRad;
  }

  get sailRaised(): boolean {
    return this.sailTarget > 0.5;
  }

  toggleSail(): void {
    this.sailTarget = this.sailTarget > 0.5 ? 0 : 1;
  }

  /** Legacy diagnostic target; not aerodynamic propulsion. */
  get targetDriftSpeedMps(): number {
    return this.sailRaised
      ? this.driftSpeedSailUp
      : this.driftSpeedSailDown;
  }

  /**
   * Map the canonical ECEF velocity back into the transported render frame.
   * This affects visual vessel orientation but is not another authority.
   */
  setRenderDirection(x: number, z: number): void {
    const length = Math.hypot(x, z);
    if (length > 1e-12) this.courseDirection.set(x / length, z / length);
  }

  /**
   * Adopt the sea state's wind, already rotated into render axes.
   *
   * The sea state is the authority for what the wind is doing; this class only
   * presents it. Everything downstream — wave directions, surface roughness
   * orientation, foam streaks, foam drift, spray, and the raft's heading —
   * reads it from here, so there is one place a wind change has to be applied.
   */
  setOceanWind(headingRad: number, speedMps: number): void {
    this.headingDeg = ((headingRad * 180) / Math.PI + 360) % 360;
    this.strength = speedMps;
    this.direction.set(Math.sin(headingRad), -Math.cos(headingRad));
  }

  updatePresentation(presentationDtSeconds: number): void {
    const step = presentationDtSeconds / this.sailTransition;
    if (this.sail < this.sailTarget) {
      this.sail = Math.min(this.sailTarget, this.sail + step);
    } else if (this.sail > this.sailTarget) {
      this.sail = Math.max(this.sailTarget, this.sail - step);
    }
  }
}
