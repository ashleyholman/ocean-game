/**
 * The sea's memory of the wind — the whole of WX2, in one formula.
 *
 * Read `docs/weather/WEATHER_CONCEPT.md` §4 L2 and §6 WX2 before changing a
 * number here.
 *
 * WHAT THIS EXISTS TO SAY
 * -----------------------
 * Before this file the project had one wind number, and it was the sea's. The
 * wind could not freshen without the sea being instantly rough, and it could
 * not drop without the sea instantly lying down, because "the wind" and "the
 * wind that grew this sea" were the same float. `WeatherState` now owns the
 * present wind and is the only thing `WorldWind` is fed; this file owns the
 * lag between the two, and writes it into the sea state's `generatingWind`.
 *
 * THE ONE FORMULA, WITH THE WIND SPEED APPEARING ONCE
 * ---------------------------------------------------
 * The memory is a single scalar, `developedWindMps` — call it `U_dev`. It is
 * the wind whose fully-authored sea this water currently *is*. Against the
 * present wind `U_now`, the sea state written each step is
 *
 *     U*  = max(U_now, U_dev)        the wind now working on this sea
 *     r   = U_dev / U*               ∈ (0, 1]; exactly 1 unless it is freshening
 *     m*  = m_base · r^1.6           the sea's development under that wind
 *     Hs  = Hs(U*, m*) ≡ Hs(U_dev, m_base)
 *
 * The last line is an identity, not an approximation, and it is the reason the
 * exponent is 1.6 rather than a taste. `spectrum.ts` gives
 * `Hs = 4(U²/g)·√ε` with `ε = EPSILON_FULL · m^2.5`, so `Hs ∝ U² · m^1.25`;
 * holding `Hs` fixed while `U` rises by `1/r` therefore needs `m` scaled by
 * `r^(2/1.25) = r^1.6`. **The wind speed enters the sea's height exactly
 * once, as `U_dev`.** Nothing double-counts a freshening: the height is the
 * memory's alone, and `U*` only changes the *character* of the water.
 *
 * That character is where "windy before big" comes from, and it comes out of
 * the same substitution rather than being painted on:
 *
 * - the peak period goes as `r^0.32` — a freshening sea shortens;
 * - `windSeaGamma(m*)` peaks up and `windSeaSpreadExponent` broadens — young
 *   chop is peaky in frequency and confused in direction;
 * - `windSeaSteepnessFor(m*)` steepens, and the state's authored steepness is
 *   carried with it by the same difference;
 * - `whitecapCoverage(U*)` — the far-field statistic, read from the sea's own
 *   record — jumps with the wind, because whitecaps are what a fresh wind does
 *   to water immediately.
 *
 * And on a dying wind `U_now < U_dev`, so `U* = U_dev`, `r = 1`, `m* = m_base`:
 * the sea is exactly the sea it was, and only `U_dev` decays. The water stays
 * up after the wind has gone.
 *
 * THE 24 m/s KNEE — the one place the identity is only nearly true
 * ----------------------------------------------------------------
 * `resolveSeaState` does not hand the raw wind to the growth laws; it hands
 * `effectiveGrowthWind(U)`, which is the identity below 24 m/s and then
 * saturates smoothly onto `WIND_VALIDITY_CEILING = 32`
 * (`spectrum.ts`). Above the knee the saturation is not linear, so
 * `Hs(U*, m*)` drifts *below* `Hs(U_dev, m_base)` during a build in storm
 * winds — the sea is capped, which is the saturation doing its job, not the
 * memory failing. It is stated here because a reader who trusts the identity
 * blindly at 28 m/s would be wrong by a few per cent, and because a later
 * round that raises the ceiling must re-read this paragraph. Below 24 m/s —
 * which is every shipping preset except `EXTREME_DEBUG` — it is exact.
 *
 * TWO CLOCKS, AND THEY ARE NOT THE SAME CLOCK
 * -------------------------------------------
 * The *memory* relaxes on **weather seconds** — the astronomical calendar
 * (30×) times the weather panel's rate — because how long a sea takes to
 * build is a physical duration and must move with the weather that drives it.
 * The *command* handed to `SeaStateController.set(next, seconds)` is in
 * **presentation seconds**, because that is the clock the controller is
 * advanced on and the duration there is only the smoothing between two
 * commands, never the memory.
 */

import {
  cloneSeaState,
  windSeaSteepnessFor,
  type SeaState,
} from './seaState';
import type { SeaStateController } from './SeaStateController';

const G = 9.81;

/** The present wind, in the shape `WeatherSystem.wind` already publishes. */
export interface PresentWind {
  readonly speedMps: number;
  readonly directionDeg: number;
  readonly gustiness: number;
}

export const WIND_SEA_MEMORY = Object.freeze({
  /**
   * Nondimensional duration to a fully developed sea, `g·t/U₁₀`.
   *
   * The engineering figure, and openly a *chosen* one: the literature spans
   * roughly a factor of two for the same wind depending on whether the
   * regression is quoted against U₁₀ or against an adjusted wind-stress
   * factor. 3.5e4 puts a 10 m/s sea at about ten world hours to full
   * development, which is the middle of that spread and the number a
   * mariner's table gives. It is the tempo dial for the whole of this file:
   * raise it and the sea answers more slowly.
   */
  fullDevelopmentNondim: 3.5e4,
  /**
   * An exponential relaxation is 95 % of the way there in three time
   * constants, so the *time constant* is the full-development time divided by
   * this. Splitting the two out means the constant above stays a quotable
   * physical figure instead of being quietly pre-divided.
   */
  eFoldingsToDeveloped: 3,
  /**
   * How much longer a sea takes to lie down than to get up.
   *
   * Not symmetry, and not a fudge. A building sea is limited by how fast the
   * air can put energy into it; a dying one loses energy only to breaking,
   * viscosity and dispersal, and mostly it does not lose it at all — it turns
   * into swell and walks away over a day. 2.5 is the stated choice, and it is
   * the half of this file Ash's accept-when is about: drop the wind and the
   * water stays up.
   */
  decayToBuildRatio: 2.5,
  /**
   * Floor on the response, world seconds. Without it the time constant goes
   * to zero with the wind and a cat's paw over glassy water would snap the sea
   * into existence. Fifteen world minutes is half a real minute at the 30×
   * calendar.
   */
  minimumResponseSeconds: 900,
  /**
   * `2 / 1.25` — see the header. Written as the quotient it is, so that anyone
   * who changes `spectrum.ts`'s `m^2.5` sees immediately that this must move
   * with it.
   */
  maturityExponent: 2 / 1.25,
});

/**
 * The time constant of the sea's answer to the wind, in **world** seconds.
 *
 * `workingWindMps` is `U*` — the larger of the present and developed winds,
 * because the timescale belongs to the sea being built or held, not to the
 * lull that is failing to hold it.
 */
export function windSeaResponseSeconds(
  workingWindMps: number,
  dying: boolean,
): number {
  const {
    fullDevelopmentNondim,
    eFoldingsToDeveloped,
    decayToBuildRatio,
    minimumResponseSeconds,
  } = WIND_SEA_MEMORY;
  const build =
    (fullDevelopmentNondim * Math.max(workingWindMps, 0)) /
    (G * eFoldingsToDeveloped);
  return Math.max(
    minimumResponseSeconds,
    dying ? build * decayToBuildRatio : build,
  );
}

/** Shortest signed arc from `fromDeg` to `toDeg`, in (−180, 180]. */
function arcDeg(fromDeg: number, toDeg: number): number {
  const delta = (((toDeg - fromDeg) % 360) + 540) % 360 - 180;
  return delta === -180 ? 180 : delta;
}

function wrap360(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

const clamp01 = (value: number): number =>
  value < 0 ? 0 : value > 1 ? 1 : value;

/**
 * The sea's memory: one wind speed and one bearing, relaxed toward the wind
 * now, plus the base sea state they are a departure from.
 *
 * `baseState` is the sea somebody *chose* — a preset, or the ocean lab's
 * sliders. Its swell, roughness, whitewater and seed are copied through
 * untouched and bit-for-bit; only `generatingWind` and `windSeaSteepness` are
 * written. **Remote swell is never written by weather**, and that is enforced
 * here by construction rather than by care: `target()` starts from a clone of
 * the base and touches two fields.
 */
export class WindSeaMemory {
  private base: SeaState;
  private developedWindMps: number;
  private developedDirectionDeg: number;

  constructor(base: SeaState) {
    this.base = cloneSeaState(base);
    this.developedWindMps = this.base.generatingWind.speedMps;
    this.developedDirectionDeg = this.base.generatingWind.directionDeg;
  }

  /**
   * Adopt a newly chosen sea, and forget the wind that made the last one.
   *
   * The memory snaps to the new state's own generating wind, so a preset
   * button gives you exactly that preset. The caller is responsible for
   * telling the weather system that the present wind is now this too
   * (`WeatherSystem.recalibrateTo`), or the sea will start being dragged off
   * the preset on the very next step.
   */
  rebase(base: SeaState): void {
    this.base = cloneSeaState(base);
    this.developedWindMps = this.base.generatingWind.speedMps;
    this.developedDirectionDeg = this.base.generatingWind.directionDeg;
  }

  get baseState(): SeaState {
    return this.base;
  }

  /** The wind this sea is the fully-authored sea of. */
  get developedWind(): { speedMps: number; directionDeg: number } {
    return {
      speedMps: this.developedWindMps,
      directionDeg: this.developedDirectionDeg,
    };
  }

  /**
   * Relax the memory toward the present wind by `weatherDeltaSeconds` of
   * **weather** time. A pure exponential step, so it is exactly invariant to
   * how the caller chops the interval up.
   */
  advance(weatherDeltaSeconds: number, present: PresentWind): void {
    if (!(weatherDeltaSeconds > 0)) return;
    const working = Math.max(present.speedMps, this.developedWindMps);
    const dying = present.speedMps < this.developedWindMps;
    const tau = windSeaResponseSeconds(working, dying);
    const alpha = 1 - Math.exp(-weatherDeltaSeconds / tau);
    this.developedWindMps +=
      (present.speedMps - this.developedWindMps) * alpha;
    this.developedDirectionDeg = wrap360(
      this.developedDirectionDeg +
        arcDeg(this.developedDirectionDeg, present.directionDeg) * alpha,
    );
  }

  /**
   * The sea state this memory implies under the present wind.
   *
   * Allocates one state; called only when a command is actually issued, never
   * per frame.
   */
  target(present: PresentWind): SeaState {
    const next = cloneSeaState(this.base);
    const developed = this.developedWindMps;
    const working = Math.max(present.speedMps, developed);
    // `r` is 1 whenever the wind is not freshening, and the whole block below
    // then reduces to the base state's own numbers exactly.
    const ratio = working > 0 ? Math.min(1, developed / working) : 1;
    const baseMaturity = this.base.generatingWind.maturity;
    const maturity = clamp01(
      baseMaturity * Math.pow(ratio, WIND_SEA_MEMORY.maturityExponent),
    );

    next.generatingWind.speedMps = working;
    next.generatingWind.directionDeg = this.developedDirectionDeg;
    next.generatingWind.maturity = maturity;
    // Gustiness is deliberately NOT written. It is a present-wind property
    // that nothing in weather yet moves (WX1 passes the prevailing value
    // through untouched and WX3 owns the gust field), and the ocean lab has a
    // live slider for it that drives foam and spray. Writing it here would
    // silently overrule that control for no gain this round.

    // The authored crest sharpness, carried by the same difference the derived
    // one would have moved: exactly the base value at r = 1, steeper as the
    // sea is caught young. `windSeaSteepnessFor` is 0.95 − 0.25·m, so this is
    // `+0.25·m_base·(1 − r^1.6)` and is bounded by a quarter of the base
    // maturity.
    (next as { windSeaSteepness: number }).windSeaSteepness = clamp01(
      this.base.windSeaSteepness +
        (windSeaSteepnessFor(maturity) - windSeaSteepnessFor(baseMaturity)),
    );
    return next;
  }
}

/**
 * How different a target has to be before it is worth re-commanding the sea.
 *
 * Below these the command is skipped entirely, which is what keeps a settled
 * spell free: no transition is running, `SeaStateController.advance` returns
 * false, and `WaveField.applySeaState` is not called — exactly the frame the
 * game had before this round existed. That is also what earns the claim that
 * the opening instant is unchanged.
 */
export const WIND_SEA_COMMAND_DEADBAND = Object.freeze({
  speedMps: 0.01,
  directionDeg: 0.1,
  maturity: 0.002,
});

/**
 * Presentation seconds each command eases over.
 *
 * It is the *cadence*, not the memory, and the two must not be confused. The
 * controller's ease is a smoothstep whose rate is zero at both ends, so a
 * command that is restarted long before it finishes barely moves the sea at
 * all — the movement per restart goes as the square of the fraction elapsed.
 * Making the command duration equal the interval between commands is what
 * avoids that: each ramp lands exactly as the next is issued, so the sea
 * tracks the memory with no suppression and no discontinuity in value. The
 * duration is re-estimated from the interval actually observed, clamped into
 * this band.
 */
export const WIND_SEA_COMMAND_SECONDS = Object.freeze({ min: 1, max: 20 });

/**
 * What a panel needs of the coupling: decision D5's switch, and the number
 * that makes the switch legible. Both the Weather panel and the ocean
 * laboratory take this.
 */
export interface SeaCouplingControl {
  readonly coupled: boolean;
  setCoupled(coupled: boolean): void;
  readonly developedWind: { speedMps: number; directionDeg: number };
}

/**
 * Drives the sea state from the present wind, through the transition path the
 * controller already has.
 *
 * `coupled` is decision D5: coupled in play, `Independent` in the lab. When it
 * is off this object does nothing whatever — no command, no memory advance —
 * so the ocean laboratory keeps a sea that stays exactly where it was put
 * while the weather does whatever it likes to the wind. That mismatch is the
 * point of the switch.
 */
export class WindSeaCoupling {
  private readonly memory: WindSeaMemory;
  private coupledValue: boolean;
  private lastCommanded: SeaState | undefined;
  private lastWeatherSeconds: number | undefined;
  private secondsSinceCommand = 0;
  private commandCount = 0;

  constructor(
    private readonly seaStates: SeaStateController,
    base: SeaState,
    coupled = true,
  ) {
    this.memory = new WindSeaMemory(base);
    this.coupledValue = coupled;
  }

  get coupled(): boolean {
    return this.coupledValue;
  }

  /**
   * Turn the coupling on or off. Switching back on re-bases on whatever the
   * sea is now, so the lab's hand-built sea becomes the new equilibrium rather
   * than being yanked back to the one weather last commanded.
   */
  setCoupled(coupled: boolean, presentWeatherSeconds?: number): void {
    if (coupled === this.coupledValue) return;
    this.coupledValue = coupled;
    if (coupled) {
      this.memory.rebase(this.seaStates.target);
      this.lastCommanded = undefined;
      this.lastWeatherSeconds = presentWeatherSeconds;
      this.secondsSinceCommand = 0;
    }
  }

  /** Somebody chose a sea. Forget the wind that made the last one. */
  rebase(base: SeaState, presentWeatherSeconds?: number): void {
    this.memory.rebase(base);
    this.lastCommanded = undefined;
    this.lastWeatherSeconds = presentWeatherSeconds;
    this.secondsSinceCommand = 0;
  }

  get developedWind(): { speedMps: number; directionDeg: number } {
    return this.memory.developedWind;
  }

  /** Commands issued since construction. Diagnostic readout and tests. */
  get commandsIssued(): number {
    return this.commandCount;
  }

  /**
   * One frame.
   *
   * @param presentationDeltaSeconds the frame's presentation delta — the clock
   *        `SeaStateController.advance` is on, and therefore the clock the
   *        command duration is quoted in.
   * @param weatherElapsedSeconds the weather clock's absolute reading, read
   *        rather than differenced by the caller so there is no second
   *        accumulator that could disagree with the first.
   */
  update(
    presentationDeltaSeconds: number,
    weatherElapsedSeconds: number,
    present: PresentWind,
  ): void {
    if (!this.coupledValue || !drivable(this.memory.baseState)) {
      this.lastWeatherSeconds = weatherElapsedSeconds;
      return;
    }
    const previous = this.lastWeatherSeconds;
    this.lastWeatherSeconds = weatherElapsedSeconds;
    this.secondsSinceCommand += Math.max(0, presentationDeltaSeconds);
    if (previous === undefined) return;

    this.memory.advance(weatherElapsedSeconds - previous, present);

    const next = this.memory.target(present);
    const reference = this.lastCommanded ?? this.seaStates.target;
    if (!exceedsDeadband(reference, next)) return;

    const seconds = Math.min(
      WIND_SEA_COMMAND_SECONDS.max,
      Math.max(WIND_SEA_COMMAND_SECONDS.min, this.secondsSinceCommand),
    );
    this.seaStates.set(next, seconds);
    this.lastCommanded = next;
    this.secondsSinceCommand = 0;
    this.commandCount += 1;
  }
}

/**
 * Whether weather is allowed to drive this sea at all.
 *
 * A diagnostic fixture is not weather, and there are two separate reasons not
 * to touch one. The obvious one is intent: `FROZEN_SINGLE` and the parity
 * probes exist to be looked at with time stopped and an exactly known number
 * of components, and a wind that quietly rebuilt them would ruin the very
 * measurements they are for.
 *
 * The second is a real fault this guard walks around rather than fixes, and it
 * is reported rather than patched because it belongs to `blendSeaState`'s
 * contract and not to this round: **`blendSeaState` does not carry `frozen` or
 * `slotOverride`.** Both are dropped from any interpolated state. That was
 * harmless while transitions only happened when somebody pressed a preset
 * button, because a preset button snaps; it is not harmless now that the sea is
 * in transition whenever the weather is moving. Driving a frozen single-wave
 * fixture would have silently thawed it into a forty-eight-component sea on the
 * first command.
 */
function drivable(state: SeaState): boolean {
  return (
    state.purpose !== 'DIAGNOSTIC' &&
    state.frozen !== true &&
    // AND a sea authored with no wind at all is a fixture whatever its
    // `purpose` says. `FLAT` is marked PLAYABLE but its own note calls it what
    // it is — "exists so the buoyancy harness has a zero against which any
    // residual motion is unambiguously a bug". A weather round that quietly
    // grew a wind sea on it would take that zero away, in the browser lab
    // where the harness is actually watched. If the author wrote no wind,
    // there is nothing here to remember.
    state.generatingWind.speedMps > 0
  );
}

function exceedsDeadband(reference: SeaState, next: SeaState): boolean {
  const a = reference.generatingWind;
  const b = next.generatingWind;
  return (
    Math.abs(b.speedMps - a.speedMps) >= WIND_SEA_COMMAND_DEADBAND.speedMps ||
    Math.abs(arcDeg(a.directionDeg, b.directionDeg)) >=
      WIND_SEA_COMMAND_DEADBAND.directionDeg ||
    Math.abs(b.maturity - a.maturity) >= WIND_SEA_COMMAND_DEADBAND.maturity
  );
}
