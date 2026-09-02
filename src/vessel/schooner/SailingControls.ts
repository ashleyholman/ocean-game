import { DEFAULT_WORLD_SECONDS_PER_REAL_SECOND } from '../../world/clock';
import type { RudderAngleProvider } from './SchoonerHorizontalDynamics';
import {
  SHEET_FISHERMAN,
  SHEET_FLYING_JIB,
  SHEET_FORE,
  SHEET_JIB,
  SHEET_MAIN,
  SHEET_STAYSAIL,
  AUTHORED_BRACE_ANGLE,
  RIG_TRIM_LIMITS,
  type SailName,
} from './rig';
import {
  SAIL_AERO_COEFFICIENTS,
  VALID_SET_STATES,
  type SailSetState,
} from './sailAero';

/**
 * The sailing control state — S4's full control surface (design §5).
 *
 * Design §5: controls are commands, never forces. The player (or later the
 * crew tiers) sets a target; the target is clamped to the mechanical range
 * and the *current* value walks toward it at a finite crewed rate on
 * ordinary physics seconds — the fixed 240 Hz substep grid, which is what
 * makes command traces exactly caller-rate invariant. Nothing is instant.
 *
 * Physics and renderer read the same three numbers per sail — a set-state
 * label, a hoist fraction, a trim angle — so the cloth the eye sees and the
 * cloth the wind pushes on are one state (the aero re-derives geometry from
 * these every substep; the renderer re-lofts when they move).
 *
 * SET STATES AS A CONTINUOUS HOIST
 * --------------------------------
 * Each discrete set state (design §5.1) is a fixed point on a [0, 1] hoist
 * fraction: furled 0, reef2/reef1 at the aero's `reefHoistFraction`
 * complements, set 1. Commanding a new state walks the fraction linearly at
 * a rate fixed at command time from the §5.2 duration table — a sail half
 * struck when the order changes just walks from where it is, no history
 * kept (§5.3). Mid-transition cloth is honestly partial: the aero shrinks
 * the same corner geometry the renderer lofts, so a sail coming down spills
 * wind progressively instead of vanishing.
 *
 * TRIM SIGNS
 * ----------
 * Positive trim swings the controlled edge toward **+x/port** — the authored
 * rig (starboard tack, booms and clews to port) carries positive trims, and
 * the port-tack mirror of any setting is its negation. Headsail sheets are
 * signed the same way: the sign says which side the clew is hauled to, and a
 * tack swings the value through zero. The square topsail's brace follows the
 * yaw sense: positive braces the port yardarm aft. The gaff topsail has no
 * trim of its own — it is slaved to the mainsail sheet (§5.1). The fisherman
 * has a side, not a trim: its magnitude is fixed and only the sign is
 * commanded (dipping it around the springstay is a set-piece, §5.1).
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Hard-over rudder limit, degrees — design §5.1's ±35° rudder equivalent. */
export const RUDDER_LIMIT_DEG = 35;

/**
 * How long the crew takes over each sail evolution — in **world** seconds.
 *
 * These are design §5.2's numbers, and they are statements about a real
 * crew's working day: ninety seconds to hand a gaff mainsail, four minutes to
 * tie in a reef. They are deliberately *not* the numbers the simulation
 * counts down, because this world runs two clocks (see `CREW_TIME_SCALE`).
 *
 * Provisional and tunable. If an evolution reads too fast on screen, the
 * honest lever is here — "this crew is shorthanded and takes longer" — not a
 * fudge factor downstream.
 */
export const CREW_EVOLUTION_WORLD_SECONDS = Object.freeze({
  /** Set or strike a stayed headsail. */
  headsailSet: 45,
  /** Hoist or lower a gaff sail (throat + peak together). */
  gaffHoist: 90,
  /** Tie in or shake out one reef band. */
  reef: 240,
  /** Set or clew up the square topsail. */
  squareSet: 150,
  /** Set or strike the light kites (gaff topsail, fisherman). */
  lightSailSet: 60,
  /** Dip the fisherman around the springstay to the other side. */
  fishermanDip: 60,
} as const);

/**
 * Physics seconds per world second for work the crew goes away and does.
 *
 * THE SHIP KEEPS TWO CLOCKS, AND SAIL HANDLING BELONGS TO THE OTHER ONE
 * ---------------------------------------------------------------------
 * Waves, hull motion and sail forces run on plain elapsed seconds — you watch
 * her roll in real time. But the voyage does not: `PlanetaryWorld` advances
 * the calendar *and the distance made good* at `DEFAULT_WORLD_SECONDS_PER_REAL_SECOND`,
 * so one second at the keyboard is thirty seconds of the day and thirty
 * seconds' worth of ocean crossed.
 *
 * Which clock an action belongs to is decided by what it costs. A sail
 * evolution costs a slice of the **day** — that is the whole point of the
 * §5.2 table, and it is why a real skipper thinks twice before shaking out a
 * reef. Counting it in keyboard seconds charged the voyage thirty times over:
 * a ninety-second hand of the mainsail burned forty-five minutes of daylight
 * and thirty times the sea room, so a day spent tacking made almost no
 * progress across the chart. That is the fault Ash found, and it is an
 * arithmetic fault, not a taste one.
 *
 * The helm and the sheets are the exception, and stay in the boat's frame
 * below. They are not errands; they are controls worked continuously against
 * her live response, and S3/S4 tuned and pinned them against real-time
 * turning circles and a real-time tack.
 */
const CREW_TIME_SCALE = 1 / DEFAULT_WORLD_SECONDS_PER_REAL_SECOND;

function crewSeconds(worldSeconds: number): number {
  return worldSeconds * CREW_TIME_SCALE;
}

/**
 * The one place actuation rates live, in the physics seconds the substep grid
 * counts. The helm and the sheets are authored here directly; the sail
 * evolutions are the crew's own table above, converted.
 */
export const ACTUATION_RATES = Object.freeze({
  /** Hard-over to hard-over (70° of rudder), seconds. */
  rudderHardOverSeconds: 3.5,
  /** Full ease-to-haul of a boom sheet or headsail sheet, seconds. */
  sheetFullSwingSeconds: 15,
  /** Full port-limit-to-starboard-limit swing of the topsail yard, seconds. */
  braceFullSwingSeconds: 15,
  /** Set or strike a stayed headsail, seconds. */
  headsailSetSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.headsailSet),
  /** Hoist or lower a gaff sail (throat + peak together), seconds. */
  gaffHoistSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.gaffHoist),
  /** Tie in or shake out one reef band, seconds. */
  reefSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.reef),
  /** Set or clew up the square topsail, seconds. */
  squareSetSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.squareSet),
  /** Set or strike the light kites (gaff topsail, fisherman), seconds. */
  lightSailSetSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.lightSailSet),
  /** Dip the fisherman around the springstay to the other side, seconds. */
  fishermanDipSeconds: crewSeconds(CREW_EVOLUTION_WORLD_SECONDS.fishermanDip),
} as const);

/**
 * Helm slew rate, degrees of rudder per second — kept as a named export
 * because S3 pinned tests and evidence against it.
 */
export const RUDDER_RATE_DEG_PER_S =
  (2 * RUDDER_LIMIT_DEG) / ACTUATION_RATES.rudderHardOverSeconds;

/** Hoist-fraction fixed points per set state — one truth with the aero. */
export const SET_STATE_HOIST_FRACTION: Readonly<Record<SailSetState, number>> =
  Object.freeze({
    set: 1,
    reef1: 1 - SAIL_AERO_COEFFICIENTS.reefHoistFraction.reef1,
    reef2: 1 - SAIL_AERO_COEFFICIENTS.reefHoistFraction.reef2,
    furled: 0,
  });

/** Which §5.2 evolution a sail's plain set/strike is. */
const SET_STRIKE_SECONDS: Readonly<Record<SailName, number>> = Object.freeze({
  mainsail: ACTUATION_RATES.gaffHoistSeconds,
  foresail: ACTUATION_RATES.gaffHoistSeconds,
  foreStaysail: ACTUATION_RATES.headsailSetSeconds,
  jib: ACTUATION_RATES.headsailSetSeconds,
  flyingJib: ACTUATION_RATES.headsailSetSeconds,
  foreTopsail: ACTUATION_RATES.squareSetSeconds,
  mainTopmastStaysail: ACTUATION_RATES.lightSailSetSeconds,
  mainGaffTopsail: ACTUATION_RATES.lightSailSetSeconds,
});

/**
 * Duration of one set-state evolution. Reef work (either endpoint a reef)
 * is tie/shake time; anything else is the sail's plain set/strike time.
 */
export function setStateEvolutionSeconds(
  sail: SailName,
  from: SailSetState,
  to: SailSetState,
): number {
  if (from === to) return 0;
  const reefInvolved =
    from === 'reef1' || from === 'reef2' || to === 'reef1' || to === 'reef2';
  return reefInvolved ? ACTUATION_RATES.reefSeconds : SET_STRIKE_SECONDS[sail];
}

/** Sails whose trim is a boom or clew sheet the player works directly. */
export const SHEET_TRIMMED_SAILS = Object.freeze([
  'mainsail',
  'foresail',
  'foreStaysail',
  'jib',
  'flyingJib',
] as const);
export type SheetTrimmedSail = (typeof SHEET_TRIMMED_SAILS)[number];

/** Authored (starboard-tack) trims, degrees, in the positive-to-port sign. */
export const AUTHORED_TRIM_DEG: Readonly<Record<SailName, number>> =
  Object.freeze({
    mainsail: SHEET_MAIN * RAD_TO_DEG,
    foresail: SHEET_FORE * RAD_TO_DEG,
    foreStaysail: SHEET_STAYSAIL * RAD_TO_DEG,
    jib: SHEET_JIB * RAD_TO_DEG,
    flyingJib: SHEET_FLYING_JIB * RAD_TO_DEG,
    foreTopsail: AUTHORED_BRACE_ANGLE * RAD_TO_DEG,
    mainTopmastStaysail: SHEET_FISHERMAN * RAD_TO_DEG,
    mainGaffTopsail: SHEET_MAIN * RAD_TO_DEG,
  });

/**
 * The flattest she is ever sheeted, per sail, degrees of magnitude.
 *
 * These are S4's measured maneuvering trims — the "haul taut" of a tack, and
 * the numbers that made the tack complete from every entry (see
 * `SailingSteeringEvidence.ts`, which is where they were derived and which now
 * imports them from here). A sail hauled flatter than this is being sheeted
 * for an evolution, not for sailing, so it is also the floor a standing
 * trimmer works to: he hardens up to it and no further.
 */
export const HARD_TRIM_DEG: Readonly<Partial<Record<SailName, number>>> =
  Object.freeze({
    mainsail: 12,
    foresail: 14,
    foreStaysail: 10,
    jib: 11,
    flyingJib: 12,
    foreTopsail: AUTHORED_BRACE_ANGLE * RAD_TO_DEG,
  });

/**
 * The steady close-hauled sheet she is eased to once an evolution is over,
 * degrees of magnitude — the polar schedule's working floor.
 *
 * `HARD_TRIM_DEG` above is the flat haul of a maneuver; this is where the
 * sheets go back to when the maneuver is finished and she is sailing again.
 * One number, shared by the S3/S4 tack script and S6's trimmers, so a tack
 * sailed by the evidence harness and a tack sailed by the crew end on the
 * same rig.
 */
export const WORKING_TRIM_DEG = 20;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${value}`);
  }
}

/** One rate-limited continuous channel: a current walking toward a target. */
class Channel {
  current: number;
  target: number;
  /** Absolute travel per second; fixed when the target is commanded. */
  ratePerSecond: number;

  constructor(value: number, ratePerSecond: number) {
    this.current = value;
    this.target = value;
    this.ratePerSecond = ratePerSecond;
  }

  advance(stepSeconds: number): void {
    const maxTravel = this.ratePerSecond * stepSeconds;
    const shortfall = this.target - this.current;
    this.current += clamp(shortfall, -maxTravel, maxTravel);
  }

  settled(): boolean {
    return this.current === this.target;
  }
}

/** The full per-sail control state the physics and renderer read. */
export interface SailControlReadout {
  /** The commanded set state — where the evolution is headed. */
  targetState: SailSetState;
  /** The last settled state; equals `targetState` once the hoist arrives. */
  settledState: SailSetState;
  /** True while cloth is moving between set states. */
  changing: boolean;
  /**
   * The sail this one's ordered evolution is queued behind, if any — the crew
   * is aloft on that one first (`waitingOn`). Ordered but not yet started.
   */
  waitingOn: SailName | null;
  /** Continuous hoist fraction in [0, 1]; fixed points per state above. */
  hoistFraction: number;
  /** Trim angle, degrees, positive toward port. Slaved for the gaff topsail. */
  trimDeg: number;
  /** Where the trim is ordered to, degrees. */
  trimTargetDeg: number;
}

export class SailingControls implements RudderAngleProvider {
  private readonly rudder = new Channel(0, RUDDER_RATE_DEG_PER_S);

  private readonly hoists = new Map<SailName, Channel>();
  private readonly trims = new Map<SailName, Channel>();
  private readonly targetStates = new Map<SailName, SailSetState>();
  private readonly settledStates = new Map<SailName, SailSetState>();
  /** The clamped as-built trims, so `reset` restores the vessel constructed. */
  private readonly initialTrimDeg = new Map<SailName, number>();

  /**
   * @param initialTrimDeg Trims the ship is *already* carrying, overriding the
   *   authored ones per sail. This is an initial condition and nothing else:
   *   both the current angle and its target are set, so no crew work is
   *   implied and no sheet is seen walking on the first frames. Use it to open
   *   a session on a rig that suits the wind it opens in
   *   (`src/world/openingVoyage.ts`); every later change is a command.
   */
  constructor(initialTrimDeg: Partial<Record<SailName, number>> = {}) {
    for (const sail of Object.keys(AUTHORED_TRIM_DEG) as SailName[]) {
      this.hoists.set(sail, new Channel(SET_STATE_HOIST_FRACTION.set, 0));
      this.targetStates.set(sail, 'set');
      this.settledStates.set(sail, 'set');
      const limits = RIG_TRIM_LIMITS[sail];
      const requested = initialTrimDeg[sail] ?? AUTHORED_TRIM_DEG[sail];
      assertFinite(requested, `${sail} initial trim`);
      const resolved = clamp(requested, limits.minDeg, limits.maxDeg);
      this.initialTrimDeg.set(sail, resolved);
      const trim = new Channel(
        resolved,
        (limits.maxDeg - limits.minDeg) / this.trimSwingSeconds(sail),
      );
      this.trims.set(sail, trim);
    }
  }

  private trimSwingSeconds(sail: SailName): number {
    if (sail === 'foreTopsail') return ACTUATION_RATES.braceFullSwingSeconds;
    if (sail === 'mainTopmastStaysail') return ACTUATION_RATES.fishermanDipSeconds;
    return ACTUATION_RATES.sheetFullSwingSeconds;
  }

  // --- helm (S3 API, unchanged) ---------------------------------------------

  /** Command a rudder deflection; clamped to the mechanical ±35° range. */
  commandRudderDeg(targetDeg: number): void {
    assertFinite(targetDeg, 'rudder command');
    this.rudder.target = clamp(targetDeg, -RUDDER_LIMIT_DEG, RUDDER_LIMIT_DEG);
  }

  /** Where the blade actually is, degrees. */
  get rudderAngleDeg(): number {
    return this.rudder.current;
  }

  /** Where the helm is ordered to, degrees. */
  get rudderTargetDeg(): number {
    return this.rudder.target;
  }

  /** The angle the current substep integrates with, radians. */
  get currentRudderRad(): number {
    return this.rudder.current * DEG_TO_RAD;
  }

  // --- sails ----------------------------------------------------------------

  /**
   * Order a sail to a set state. The hoist walks there at the §5.2 rate for
   * this evolution, computed from wherever the cloth currently is.
   *
   * Ordering the mainsail down also orders the gaff topsail struck — see
   * `waitingOn` for why the two cannot be worked at once.
   */
  commandSetState(sail: SailName, state: SailSetState): void {
    if (!VALID_SET_STATES[sail].includes(state)) {
      throw new RangeError(`${sail} cannot be "${state}"`);
    }
    if (sail === 'mainsail' && SET_STATE_HOIST_FRACTION[state] < 1) {
      // The topsail comes in first. The player orders one thing — "hand the
      // main" — and gets the sequence a crew would actually work, rather than
      // having to know the running order or watch the kite tear.
      this.commandSetState('mainGaffTopsail', 'furled');
    }
    const hoist = this.hoists.get(sail)!;
    const previousTarget = this.targetStates.get(sail)!;
    const settled = this.settledStates.get(sail)!;
    // WHICH STATE THE CLOTH IS LEAVING
    // An evolution is priced from the *pair* of states it spans, so the
    // departure state has to be a real one. Cloth already in flight is leaving
    // the state it was last ordered to — belaying a half-done furl is the
    // return trip up, `furled → set`, not `set → set`. Reading the stale
    // settled state instead priced that reversal as a zero-second evolution,
    // and a zero-second evolution is an infinite rate: order Furl, change your
    // mind, and the sail snapped home in one substep.
    // Re-commanding the target already in flight is not a reversal — it keeps
    // the evolution it is already running, so that stays priced from `settled`.
    const from = state === previousTarget ? settled : previousTarget;
    this.targetStates.set(sail, state);
    hoist.target = SET_STATE_HOIST_FRACTION[state];
    const span = Math.abs(hoist.target - hoist.current);
    if (span === 0) {
      this.settledStates.set(sail, state);
      hoist.ratePerSecond = 0;
      return;
    }
    const seconds = setStateEvolutionSeconds(sail, from, state);
    const fullSpan = Math.abs(
      SET_STATE_HOIST_FRACTION[state] - SET_STATE_HOIST_FRACTION[from],
    );
    // Rate from the full evolution's span; a half-done hoist finishes in
    // proportion. A same-fraction pair (span 0 handled above) cannot reach
    // here with fullSpan 0 because distinct states have distinct fractions.
    const rate = (fullSpan > 0 ? fullSpan : span) / seconds;
    if (!Number.isFinite(rate) || rate <= 0) {
      // Only reachable if `from` collapsed onto `state` again. Nothing crewed
      // is instant, so fail loudly rather than teleport the cloth.
      throw new RangeError(
        `${sail}: "${from}" → "${state}" priced at ${seconds}s is not a crewable rate`,
      );
    }
    hoist.ratePerSecond = rate;
  }

  /**
   * Command a sheet or brace, degrees, positive toward port. Clamped to the
   * rig's mechanical limits. The gaff topsail refuses: it is slaved.
   */
  commandTrimDeg(sail: SailName, targetDeg: number): void {
    assertFinite(targetDeg, `${sail} trim command`);
    if (sail === 'mainGaffTopsail') {
      throw new RangeError('mainGaffTopsail trim is slaved to the mainsail sheet');
    }
    if (sail === 'mainTopmastStaysail') {
      throw new RangeError('the fisherman has a side, not a trim — command it');
    }
    const limits = RIG_TRIM_LIMITS[sail];
    this.trims.get(sail)!.target = clamp(targetDeg, limits.minDeg, limits.maxDeg);
  }

  /**
   * Re-set a sheet as an INITIAL CONDITION — current and target together.
   *
   * The same contract as the constructor's `initialTrimDeg` and nothing more:
   * no crew work is implied, no sheet is seen walking, and the very next frame
   * draws the rig this leaves behind. `commandTrimDeg` is the opposite and is
   * what play uses — an order, worked at the rig's own rate.
   *
   * It exists for the deterministic capture host, which stages a point of sail
   * from nothing in a handful of frames. Left to the ordinary path, a scene put
   * on the other tack would be photographed mid-haul with every sheet somewhere
   * between the two sides — the trimmers' own probe interval is 22-40 s and a
   * staging is 1.2. The alternative is worse than useless: leaving the authored
   * starboard-tack sheets on a port-tack heading photographs a rig with every
   * sail aback and calls it a broad reach.
   *
   * Same refusals as `commandTrimDeg`, for the same reasons.
   */
  setInitialTrimDeg(sail: SailName, degrees: number): void {
    assertFinite(degrees, `${sail} initial trim`);
    if (sail === 'mainGaffTopsail') {
      throw new RangeError('mainGaffTopsail trim is slaved to the mainsail sheet');
    }
    if (sail === 'mainTopmastStaysail') {
      throw new RangeError('the fisherman has a side, not a trim — command it');
    }
    const limits = RIG_TRIM_LIMITS[sail];
    const resolved = clamp(degrees, limits.minDeg, limits.maxDeg);
    const trim = this.trims.get(sail)!;
    trim.current = resolved;
    trim.target = resolved;
  }

  /** Dip the fisherman to the named side (design §5.1: fixed trim, ±side). */
  commandFishermanSide(side: 'port' | 'starboard'): void {
    const magnitude = AUTHORED_TRIM_DEG.mainTopmastStaysail;
    this.trims.get('mainTopmastStaysail')!.target =
      side === 'port' ? magnitude : -magnitude;
  }

  /**
   * The sail this one's ordered evolution is waiting on, or null to work now.
   *
   * THE GAFF TOPSAIL AND THE MAIN GAFF ARE ONE PIECE OF GEAR
   * --------------------------------------------------------
   * A gaff topsail sets *above* the mainsail, and every corner of it is on
   * something the mainsail's hoist moves: its clew is hauled out along the main
   * gaff (`rig.ts`, `MAIN_TOPSAIL_CLEW_ON_GAFF`), its tack down by the gaff
   * jaws. So there is no such thing as a gaff topsail carried over a lowered
   * gaff — a real crew hands the topsail *first*, always; it is the first sail
   * off the ship, and it is down before anyone touches the throat and peak
   * halyards.
   *
   * Without that rule the sim drew a state that cannot exist: the clew rode the
   * gaff down while the head stayed at the topmast, so the topsail stretched
   * longer the further the mainsail came in — and because the aero reads the
   * same corners, a mainsail handed in a squall *grew* the kite above it from
   * 15.5 m² to 21.4 m². The geometry was never wrong. The order of work was
   * missing.
   *
   * One rule, both directions, and it is just the physical statement that cloth
   * can only be on the topsail while the gaff is up:
   *
   * - the mainsail's hoist may not **fall** while the topsail has cloth set;
   * - the topsail's hoist may not **rise** while the mainsail is not fully set.
   *
   * A held evolution is ordered, not started: its rate was fixed when it was
   * commanded, so the hand still costs its full §5.2 ninety seconds once the
   * topsail is in. Waiting is charged on top, which is exactly the point.
   */
  waitingOn(sail: SailName): SailName | null {
    const hoist = this.hoists.get(sail)!;
    if (sail === 'mainsail') {
      const topsail = this.hoists.get('mainGaffTopsail')!.current;
      return hoist.target < hoist.current && topsail > 0 ? 'mainGaffTopsail' : null;
    }
    if (sail === 'mainGaffTopsail') {
      const main = this.hoists.get('mainsail')!.current;
      return hoist.target > hoist.current && main < 1 ? 'mainsail' : null;
    }
    return null;
  }

  /** Read one sail's full control state (allocation-free callers: see below). */
  readSail(sail: SailName, out: SailControlReadout): SailControlReadout {
    const hoist = this.hoists.get(sail)!;
    const trim =
      sail === 'mainGaffTopsail'
        ? this.trims.get('mainsail')!
        : this.trims.get(sail)!;
    out.targetState = this.targetStates.get(sail)!;
    out.settledState = this.settledStates.get(sail)!;
    out.changing = !hoist.settled();
    out.waitingOn = out.changing ? this.waitingOn(sail) : null;
    out.hoistFraction = hoist.current;
    out.trimDeg = trim.current;
    out.trimTargetDeg = trim.target;
    return out;
  }

  /** Current trim angle, degrees (slave-resolved). */
  trimDeg(sail: SailName): number {
    return sail === 'mainGaffTopsail'
      ? this.trims.get('mainsail')!.current
      : this.trims.get(sail)!.current;
  }

  /** Current hoist fraction in [0, 1]. */
  hoistFraction(sail: SailName): number {
    return this.hoists.get(sail)!.current;
  }

  /** The commanded set state. */
  targetSetState(sail: SailName): SailSetState {
    return this.targetStates.get(sail)!;
  }

  /** The last settled set state (equals the target once cloth stops). */
  settledSetState(sail: SailName): SailSetState {
    return this.settledStates.get(sail)!;
  }

  // --- stepping -------------------------------------------------------------

  /** Walk every channel toward its target across one fixed substep. */
  advanceSubstep(stepSeconds: number): void {
    assertFinite(stepSeconds, 'control substep');
    this.rudder.advance(stepSeconds);
    for (const [sail, hoist] of this.hoists) {
      if (!hoist.settled() && this.waitingOn(sail) === null) {
        hoist.advance(stepSeconds);
        if (hoist.settled()) {
          this.settledStates.set(sail, this.targetStates.get(sail)!);
        }
      }
    }
    for (const trim of this.trims.values()) {
      trim.advance(stepSeconds);
    }
  }

  /**
   * As-built defaults: helm amidships, all sails set at the trims the vessel
   * was constructed with — the authored starboard-tack rig unless the
   * constructor was given an opening trim (a vessel opened on the port tack
   * must not reset onto starboard sheets).
   */
  reset(): void {
    this.rudder.current = 0;
    this.rudder.target = 0;
    for (const [sail, hoist] of this.hoists) {
      hoist.current = SET_STATE_HOIST_FRACTION.set;
      hoist.target = hoist.current;
      hoist.ratePerSecond = 0;
      this.targetStates.set(sail, 'set');
      this.settledStates.set(sail, 'set');
      const trim = this.trims.get(sail)!;
      trim.current = this.initialTrimDeg.get(sail)!;
      trim.target = trim.current;
    }
  }
}

export function createSailControlReadout(): SailControlReadout {
  return {
    targetState: 'set',
    settledState: 'set',
    changing: false,
    waitingOn: null,
    hoistFraction: 1,
    trimDeg: 0,
    trimTargetDeg: 0,
  };
}
