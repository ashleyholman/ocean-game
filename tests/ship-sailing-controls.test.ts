import { describe, expect, it } from 'vitest';
import {
  ACTUATION_RATES,
  AUTHORED_TRIM_DEG,
  CREW_EVOLUTION_WORLD_SECONDS,
  RUDDER_RATE_DEG_PER_S,
  SET_STATE_HOIST_FRACTION,
  SailingControls,
  createSailControlReadout,
  setStateEvolutionSeconds,
} from '../src/vessel/schooner/SailingControls';
import { RIG_TRIM_LIMITS, type SailName } from '../src/vessel/schooner/rig';
import { DEFAULT_WORLD_SECONDS_PER_REAL_SECOND } from '../src/world/clock';
import { VALID_SET_STATES } from '../src/vessel/schooner/sailAero';

/**
 * S4 control-surface contract (design §5): every control walks toward its
 * command at a finite crewed rate on the substep grid, set states are fixed
 * points on a continuous hoist fraction, and the whole surface is exactly
 * caller-rate invariant — a command trace produces one state trace no matter
 * how the caller chops time.
 */

const SUBSTEP = 1 / 240;

function advanceSeconds(controls: SailingControls, seconds: number): void {
  const steps = Math.round(seconds / SUBSTEP);
  for (let i = 0; i < steps; i++) controls.advanceSubstep(SUBSTEP);
}

/** Substep until `done`, and report how long it took. */
function advanceUntil(
  controls: SailingControls,
  done: () => boolean,
  limitSeconds: number,
): number {
  let elapsed = 0;
  while (!done() && elapsed < limitSeconds) {
    controls.advanceSubstep(SUBSTEP);
    elapsed += SUBSTEP;
  }
  return elapsed;
}

/**
 * A fresh control surface with the gaff topsail already handed.
 *
 * Nothing the mainsail does can start while the kite is up (see the interlock
 * suite), so a test measuring *mainsail* evolution timing takes it off first
 * and measures the hand alone.
 */
function controlsWithTopsailStruck(): SailingControls {
  const controls = new SailingControls();
  controls.commandSetState('mainGaffTopsail', 'furled');
  advanceSeconds(controls, ACTUATION_RATES.lightSailSetSeconds + 1);
  return controls;
}

const ALL_SAILS = Object.keys(AUTHORED_TRIM_DEG) as SailName[];

/**
 * Sail handling is charged to the world's clock, the helm and the sheets to
 * the boat's.
 *
 * The voyage advances the calendar *and the distance made good* at 30x, so a
 * ninety-second hand of the mainsail counted in keyboard seconds cost
 * forty-five minutes of daylight and thirty times the sea room — a day spent
 * tacking made almost no progress across the chart. Which clock each control
 * belongs to is decided by what it costs, and it is arithmetic, not taste,
 * so it is asserted rather than remembered.
 */
describe('sailing controls — which clock each control is charged to', () => {
  it('runs the crew\u2019s evolutions on the world clock', () => {
    const scale = 1 / DEFAULT_WORLD_SECONDS_PER_REAL_SECOND;
    const pairs = [
      [ACTUATION_RATES.headsailSetSeconds, CREW_EVOLUTION_WORLD_SECONDS.headsailSet],
      [ACTUATION_RATES.gaffHoistSeconds, CREW_EVOLUTION_WORLD_SECONDS.gaffHoist],
      [ACTUATION_RATES.reefSeconds, CREW_EVOLUTION_WORLD_SECONDS.reef],
      [ACTUATION_RATES.squareSetSeconds, CREW_EVOLUTION_WORLD_SECONDS.squareSet],
      [ACTUATION_RATES.lightSailSetSeconds, CREW_EVOLUTION_WORLD_SECONDS.lightSailSet],
      [ACTUATION_RATES.fishermanDipSeconds, CREW_EVOLUTION_WORLD_SECONDS.fishermanDip],
    ] as const;
    for (const [physics, world] of pairs) {
      expect(physics).toBeCloseTo(world * scale, 12);
    }
    // And the numbers that fall out: a gaff mainsail is handed in about three
    // seconds at the keyboard, which is ninety seconds of the ship's day.
    expect(ACTUATION_RATES.gaffHoistSeconds).toBeCloseTo(3, 6);
    expect(ACTUATION_RATES.reefSeconds).toBeCloseTo(8, 6);
  });

  it('leaves the helm and the sheets in the boat\u2019s own frame', () => {
    // Not errands: continuous controls worked against her live response, and
    // S3/S4 pinned turning circles and a tack against exactly these numbers.
    expect(ACTUATION_RATES.rudderHardOverSeconds).toBe(3.5);
    expect(ACTUATION_RATES.sheetFullSwingSeconds).toBe(15);
    expect(ACTUATION_RATES.braceFullSwingSeconds).toBe(15);
  });
});

describe('the authored default state', () => {
  it('starts every sail set at the authored starboard-tack trim', () => {
    const controls = new SailingControls();
    const readout = createSailControlReadout();
    for (const sail of ALL_SAILS) {
      controls.readSail(sail, readout);
      expect(readout.settledState).toBe('set');
      expect(readout.changing).toBe(false);
      expect(readout.hoistFraction).toBe(1);
      expect(readout.trimDeg).toBeCloseTo(AUTHORED_TRIM_DEG[sail], 12);
      expect(readout.trimDeg).toBeGreaterThan(0); // positive = toward port
    }
  });

  it('reset restores the authored state bit-exactly after arbitrary work', () => {
    const controls = new SailingControls();
    controls.commandRudderDeg(-20);
    controls.commandSetState('mainsail', 'reef1');
    controls.commandTrimDeg('jib', -15);
    controls.commandFishermanSide('starboard');
    advanceSeconds(controls, 30);
    controls.reset();
    const readout = createSailControlReadout();
    for (const sail of ALL_SAILS) {
      controls.readSail(sail, readout);
      expect(readout.settledState).toBe('set');
      expect(readout.hoistFraction).toBe(1);
      expect(readout.trimDeg).toBe(AUTHORED_TRIM_DEG[sail]);
    }
    expect(controls.rudderAngleDeg).toBe(0);
    expect(controls.rudderTargetDeg).toBe(0);
  });
});

describe('trim channels', () => {
  it('walks a sheet at the §5.2 full-swing rate and stops on target', () => {
    const controls = new SailingControls();
    const limits = RIG_TRIM_LIMITS.mainsail;
    const range = limits.maxDeg - limits.minDeg;
    const rate = range / ACTUATION_RATES.sheetFullSwingSeconds;
    const start = AUTHORED_TRIM_DEG.mainsail;
    const target = start - 20;
    controls.commandTrimDeg('mainsail', target);
    advanceSeconds(controls, 1);
    expect(controls.trimDeg('mainsail')).toBeCloseTo(start - rate, 6);
    advanceSeconds(controls, 30);
    expect(controls.trimDeg('mainsail')).toBe(target);
  });

  it('clamps commands to the rig limits', () => {
    const controls = new SailingControls();
    controls.commandTrimDeg('foresail', 500);
    advanceSeconds(controls, 120);
    expect(controls.trimDeg('foresail')).toBe(RIG_TRIM_LIMITS.foresail.maxDeg);
    controls.commandTrimDeg('foresail', -500);
    advanceSeconds(controls, 120);
    expect(controls.trimDeg('foresail')).toBe(RIG_TRIM_LIMITS.foresail.minDeg);
  });

  it('lets a headsail sheet swing through zero to the other side', () => {
    const controls = new SailingControls();
    controls.commandTrimDeg('jib', -AUTHORED_TRIM_DEG.jib);
    advanceSeconds(controls, ACTUATION_RATES.sheetFullSwingSeconds * 2);
    expect(controls.trimDeg('jib')).toBe(-AUTHORED_TRIM_DEG.jib);
  });

  it('slaves the gaff topsail trim to the mainsail sheet', () => {
    const controls = new SailingControls();
    expect(controls.trimDeg('mainGaffTopsail')).toBe(controls.trimDeg('mainsail'));
    controls.commandTrimDeg('mainsail', AUTHORED_TRIM_DEG.mainsail + 10);
    advanceSeconds(controls, 5);
    expect(controls.trimDeg('mainGaffTopsail')).toBe(controls.trimDeg('mainsail'));
    expect(() => controls.commandTrimDeg('mainGaffTopsail', 0)).toThrow(/slaved/);
  });

  it('gives the fisherman a side, not a trim', () => {
    const controls = new SailingControls();
    expect(() => controls.commandTrimDeg('mainTopmastStaysail', 10)).toThrow(
      /side/,
    );
    controls.commandFishermanSide('starboard');
    advanceSeconds(controls, ACTUATION_RATES.fishermanDipSeconds * 1.5);
    expect(controls.trimDeg('mainTopmastStaysail')).toBe(
      -AUTHORED_TRIM_DEG.mainTopmastStaysail,
    );
  });
});

describe('set-state evolutions', () => {
  it('rejects states a sail does not have', () => {
    const controls = new SailingControls();
    expect(() => controls.commandSetState('jib', 'reef1')).toThrow(/cannot/);
    expect(() => controls.commandSetState('foresail', 'reef2')).toThrow(/cannot/);
  });

  it('strikes a headsail in the §5.2 set/strike time', () => {
    const controls = new SailingControls();
    controls.commandSetState('flyingJib', 'furled');
    const seconds = ACTUATION_RATES.headsailSetSeconds;
    advanceSeconds(controls, seconds / 2);
    expect(controls.hoistFraction('flyingJib')).toBeCloseTo(0.5, 6);
    expect(controls.settledSetState('flyingJib')).toBe('set');
    const readout = controls.readSail('flyingJib', createSailControlReadout());
    expect(readout.changing).toBe(true);
    advanceSeconds(controls, seconds / 2 + 1);
    expect(controls.hoistFraction('flyingJib')).toBe(0);
    expect(controls.settledSetState('flyingJib')).toBe('furled');
  });

  it('reefs the mainsail in reef time, not hoist time', () => {
    const controls = controlsWithTopsailStruck();
    controls.commandSetState('mainsail', 'reef1');
    const target = SET_STATE_HOIST_FRACTION.reef1;
    const seconds = ACTUATION_RATES.reefSeconds;
    advanceSeconds(controls, seconds / 2);
    expect(controls.hoistFraction('mainsail')).toBeCloseTo(
      1 - (1 - target) / 2,
      6,
    );
    advanceSeconds(controls, seconds / 2 + 1);
    expect(controls.hoistFraction('mainsail')).toBe(target);
    expect(controls.settledSetState('mainsail')).toBe('reef1');
  });

  it('prorates an interrupted evolution from where the cloth is', () => {
    const controls = new SailingControls();
    controls.commandSetState('foresail', 'furled');
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 2);
    expect(controls.hoistFraction('foresail')).toBeCloseTo(0.5, 6);
    // Belay that — set it again. Full span takes a full hoist; from half
    // way it takes half the time.
    controls.commandSetState('foresail', 'set');
    // Sampled on the way back up, not just at the end: a reversal used to be
    // priced as a zero-second `set → set` evolution, which is an infinite
    // rate, and the cloth teleported home in one substep. Landing on 1 proved
    // nothing — an instant jump lands there too.
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 4);
    expect(controls.hoistFraction('foresail')).toBeCloseTo(0.75, 6);
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 4 + 1);
    expect(controls.hoistFraction('foresail')).toBe(1);
    expect(controls.settledSetState('foresail')).toBe('set');
  });

  it('keeps the rate when the evolution already running is re-commanded', () => {
    const controls = new SailingControls();
    controls.commandSetState('foresail', 'furled');
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 2);
    expect(controls.hoistFraction('foresail')).toBeCloseTo(0.5, 6);
    // Same order twice is not a reversal: it must not re-price the trip from
    // where the cloth happens to be, and must not stall or hurry it.
    controls.commandSetState('foresail', 'furled');
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 4);
    expect(controls.hoistFraction('foresail')).toBeCloseTo(0.25, 6);
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 4 + 1);
    expect(controls.hoistFraction('foresail')).toBe(0);
    expect(controls.settledSetState('foresail')).toBe('furled');
  });

  it('prices a reversal into a reef as reef work, from where it was headed', () => {
    const controls = controlsWithTopsailStruck();
    controls.commandSetState('mainsail', 'furled');
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds / 2);
    // Belay the hand — tie in a reef instead. That evolution is furled →
    // reef1, so it is priced as reef work over reef1's full span.
    controls.commandSetState('mainsail', 'reef1');
    const target = SET_STATE_HOIST_FRACTION.reef1;
    const rate = target / ACTUATION_RATES.reefSeconds;
    advanceSeconds(controls, ACTUATION_RATES.reefSeconds / 8);
    expect(controls.hoistFraction('mainsail')).toBeCloseTo(
      0.5 + (rate * ACTUATION_RATES.reefSeconds) / 8,
      6,
    );
  });

  it('walks the mainsail down the whole ladder monotonically', () => {
    const controls = controlsWithTopsailStruck();
    const fractions: number[] = [];
    for (const state of VALID_SET_STATES.mainsail) {
      fractions.push(SET_STATE_HOIST_FRACTION[state]);
    }
    // set(1) → reef1 → reef2 → furled(0), strictly descending.
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeLessThan(fractions[i - 1]);
    }
    controls.commandSetState('mainsail', 'furled');
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds + 1);
    expect(controls.hoistFraction('mainsail')).toBe(0);
  });

  it('prices every evolution pair from the one table', () => {
    expect(setStateEvolutionSeconds('mainsail', 'set', 'reef1')).toBe(
      ACTUATION_RATES.reefSeconds,
    );
    expect(setStateEvolutionSeconds('mainsail', 'reef2', 'furled')).toBe(
      ACTUATION_RATES.reefSeconds,
    );
    expect(setStateEvolutionSeconds('mainsail', 'set', 'furled')).toBe(
      ACTUATION_RATES.gaffHoistSeconds,
    );
    expect(setStateEvolutionSeconds('foreTopsail', 'set', 'furled')).toBe(
      ACTUATION_RATES.squareSetSeconds,
    );
    expect(setStateEvolutionSeconds('jib', 'furled', 'set')).toBe(
      ACTUATION_RATES.headsailSetSeconds,
    );
    expect(setStateEvolutionSeconds('jib', 'set', 'set')).toBe(0);
  });
});

/**
 * The gaff topsail sets above the mainsail and hangs off gear the mainsail's
 * hoist moves — its clew is hauled out along the main gaff. So the two cannot
 * be worked at once, and a real crew hands the topsail first, every time.
 *
 * These pin the *order of work*, not the geometry. The geometry was always
 * right; carrying a topsail over a lowered gaff was the impossible state, and
 * it showed as a triangle stretching down to the boom while the aero quietly
 * grew the sail by a third.
 */
describe('gaff topsail / mainsail interlock', () => {
  it('strikes the topsail first, then hands the main', () => {
    const controls = new SailingControls();
    controls.commandSetState('mainsail', 'furled');
    // One order, two evolutions — and only one of them is being worked.
    expect(controls.targetSetState('mainGaffTopsail')).toBe('furled');
    expect(controls.waitingOn('mainsail')).toBe('mainGaffTopsail');

    const kiteIn = advanceUntil(
      controls,
      () => controls.hoistFraction('mainGaffTopsail') === 0,
      60,
    );
    expect(kiteIn).toBeCloseTo(ACTUATION_RATES.lightSailSetSeconds, 1);
    // The gaff never moved while the crew was aloft on the topsail.
    expect(controls.hoistFraction('mainsail')).toBe(1);
    expect(controls.waitingOn('mainsail')).toBe(null);

    // Only now does the ninety-second hand start counting — the wait is
    // charged on top of it, not taken out of it.
    const mainIn = advanceUntil(
      controls,
      () => controls.hoistFraction('mainsail') === 0,
      60,
    );
    expect(mainIn).toBeCloseTo(ACTUATION_RATES.gaffHoistSeconds, 1);
    expect(controls.settledSetState('mainsail')).toBe('furled');
  });

  it('takes the topsail in before a reef too', () => {
    const controls = new SailingControls();
    controls.commandSetState('mainsail', 'reef1');
    expect(controls.targetSetState('mainGaffTopsail')).toBe('furled');
    advanceUntil(controls, () => controls.hoistFraction('mainGaffTopsail') === 0, 60);
    expect(controls.hoistFraction('mainsail')).toBe(1);
    const reef = advanceUntil(
      controls,
      () => controls.hoistFraction('mainsail') === SET_STATE_HOIST_FRACTION.reef1,
      120,
    );
    expect(reef).toBeCloseTo(ACTUATION_RATES.reefSeconds, 1);
  });

  it('leaves the topsail alone when the main is ordered up', () => {
    const controls = new SailingControls();
    controls.commandSetState('mainsail', 'furled');
    advanceUntil(controls, () => controls.hoistFraction('mainsail') === 0, 60);
    // Making sail again is not an order to re-set a light-air kite.
    controls.commandSetState('mainsail', 'set');
    expect(controls.targetSetState('mainGaffTopsail')).toBe('furled');
    expect(controls.waitingOn('mainsail')).toBe(null);
    advanceSeconds(controls, ACTUATION_RATES.gaffHoistSeconds + 1);
    expect(controls.hoistFraction('mainsail')).toBe(1);
    expect(controls.hoistFraction('mainGaffTopsail')).toBe(0);
  });

  it('holds a topsail ordered set until the gaff is all the way up', () => {
    const controls = new SailingControls();
    controls.commandSetState('mainsail', 'furled');
    advanceUntil(controls, () => controls.hoistFraction('mainsail') === 0, 60);

    // Order the kite back up over a handed mainsail: nothing to hang it on.
    controls.commandSetState('mainGaffTopsail', 'set');
    expect(controls.waitingOn('mainGaffTopsail')).toBe('mainsail');
    advanceSeconds(controls, ACTUATION_RATES.lightSailSetSeconds * 4);
    expect(controls.hoistFraction('mainGaffTopsail')).toBe(0);

    // Set the main; the topsail's own evolution starts when the gaff arrives,
    // and costs its own full light-sail time from there.
    controls.commandSetState('mainsail', 'set');
    const gaffUp = advanceUntil(
      controls,
      () => controls.hoistFraction('mainsail') === 1,
      60,
    );
    expect(gaffUp).toBeCloseTo(ACTUATION_RATES.gaffHoistSeconds, 1);
    expect(controls.hoistFraction('mainGaffTopsail')).toBeLessThan(0.01);
    const kiteUp = advanceUntil(
      controls,
      () => controls.hoistFraction('mainGaffTopsail') === 1,
      60,
    );
    expect(kiteUp).toBeCloseTo(ACTUATION_RATES.lightSailSetSeconds, 1);
  });

  it('never lets the topsail carry cloth over a lowered gaff', () => {
    const controls = new SailingControls();
    const step = 1 / 240;
    const orders: Array<[number, () => void]> = [
      [0, () => controls.commandSetState('mainsail', 'reef1')],
      [1, () => controls.commandSetState('mainGaffTopsail', 'set')],
      [2.5, () => controls.commandSetState('mainsail', 'furled')],
      [4, () => controls.commandSetState('mainsail', 'set')],
      [5, () => controls.commandSetState('mainGaffTopsail', 'set')],
      [9, () => controls.commandSetState('mainsail', 'reef2')],
    ];
    let next = 0;
    for (let t = 0; t < 20; t += step) {
      while (next < orders.length && orders[next][0] <= t) orders[next++][1]();
      controls.advanceSubstep(step);
      // The invariant, checked every substep of a deliberately contrary
      // order sequence: cloth aloft implies the gaff is fully up.
      if (controls.hoistFraction('mainGaffTopsail') > 0) {
        expect(controls.hoistFraction('mainsail')).toBe(1);
      }
    }
  });
});

describe('determinism (the S4 gate)', () => {
  /**
   * The invariance the production dynamics provides (S3): controls advance
   * on the fixed 240 Hz substep grid inside the accumulator loop, so a
   * caller's frame rate changes only how many substeps run per call — never
   * `h`. The gate is therefore: one command trace applied on substep-time
   * boundaries produces ONE state trace, bit-exactly, no matter how the
   * substep sequence is chopped into frames.
   */
  function runTrace(substepsPerFrame: number): number[] {
    const controls = new SailingControls();
    const commands: Array<[number, (c: SailingControls) => void]> = [
      [0, (c) => c.commandRudderDeg(20)],
      [2, (c) => c.commandTrimDeg('mainsail', -30)],
      [3, (c) => c.commandSetState('flyingJib', 'furled')],
      [10, (c) => c.commandTrimDeg('jib', -12)],
      [15, (c) => c.commandSetState('mainsail', 'reef1')],
      [20, (c) => c.commandRudderDeg(-5)],
      [40, (c) => c.commandSetState('flyingJib', 'set')],
      [50, (c) => c.commandTrimDeg('foresail', 8)],
    ];
    let next = 0;
    const totalSubsteps = 90 * 240;
    let substep = 0;
    while (substep < totalSubsteps) {
      const inFrame = Math.min(substepsPerFrame, totalSubsteps - substep);
      for (let i = 0; i < inFrame; i++) {
        const t = substep * SUBSTEP;
        while (next < commands.length && commands[next][0] <= t + 1e-12) {
          commands[next][1](controls);
          next++;
        }
        controls.advanceSubstep(SUBSTEP);
        substep++;
      }
    }
    const out: number[] = [controls.rudderAngleDeg];
    for (const sail of ALL_SAILS) {
      out.push(controls.trimDeg(sail), controls.hoistFraction(sail));
    }
    return out;
  }

  it('produces one bit-exact state trace no matter the frame chop', () => {
    const oneByOne = runTrace(1);
    const fives = runTrace(5);
    const ragged = runTrace(7);
    expect(fives).toEqual(oneByOne);
    expect(ragged).toEqual(oneByOne);
  });
});

describe('the rudder (S3 API preserved)', () => {
  it('keeps the S3 slew rate and range', () => {
    expect(RUDDER_RATE_DEG_PER_S).toBeCloseTo(20, 6);
    const controls = new SailingControls();
    controls.commandRudderDeg(100);
    expect(controls.rudderTargetDeg).toBe(35);
    advanceSeconds(controls, 1);
    expect(controls.rudderAngleDeg).toBeCloseTo(20, 6);
    advanceSeconds(controls, 1);
    expect(controls.rudderAngleDeg).toBe(35);
  });
});
