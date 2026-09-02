import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findSeaState } from '../src/ocean/presets';
import { SeaStateController } from '../src/ocean/SeaStateController';
import { cloneSeaState, type SeaState } from '../src/ocean/seaState';
import {
  effectiveGrowthWind,
  windSeaFromWind,
} from '../src/ocean/spectrum';
import {
  WIND_SEA_COMMAND_SECONDS,
  WIND_SEA_MEMORY,
  WindSeaCoupling,
  WindSeaMemory,
  windSeaResponseSeconds,
  type PresentWind,
} from '../src/ocean/WindSeaMemory';
import {
  buildWindSeaEvidence,
  validateWindSeaEvidence,
  type WindSeaEvidence,
} from '../src/ocean/WindSeaEvidence';

const MODERATE = findSeaState('CURRENT_MODERATE');

function wind(speedMps: number, directionDeg = 144): PresentWind {
  return { speedMps, directionDeg, gustiness: 0 };
}

/** Significant height of the wind-sea partition a state describes. */
function windSeaHs(state: SeaState): number {
  return windSeaFromWind(
    effectiveGrowthWind(state.generatingWind.speedMps),
    state.generatingWind.maturity,
  ).significantHeight;
}

// ---------------------------------------------------------------------------
// The formula. House rule 7: anything new gets a pinned test the day it is
// born, and the identity below is the one every other claim in the round rests
// on. If it breaks, "the wind speed appears once" is no longer true and the sea
// double-counts a freshening.
// ---------------------------------------------------------------------------

describe('the wind-sea identity', () => {
  it('leaves a steady wind alone, exactly', () => {
    const memory = new WindSeaMemory(MODERATE);
    const target = memory.target(
      wind(MODERATE.generatingWind.speedMps, MODERATE.generatingWind.directionDeg),
    );
    expect(target.generatingWind.speedMps).toBe(
      MODERATE.generatingWind.speedMps,
    );
    expect(target.generatingWind.directionDeg).toBe(
      MODERATE.generatingWind.directionDeg,
    );
    expect(target.generatingWind.maturity).toBe(
      MODERATE.generatingWind.maturity,
    );
    expect(target.windSeaSteepness).toBe(MODERATE.windSeaSteepness);
  });

  it('keeps the wind sea at exactly the height its memory implies', () => {
    // The whole point: `Hs(U*, m*) ≡ Hs(U_dev, m_base)`, so the height is a
    // function of the memory alone and the present wind changes only the
    // character. Checked across a freshening from a standstill to a gale.
    const memory = new WindSeaMemory(MODERATE);
    const developedHs = windSeaHs(MODERATE);
    for (const present of [6, 7.5, 9, 12, 16, 20, 24]) {
      const target = memory.target(wind(present));
      expect(windSeaHs(target)).toBeCloseTo(developedHs, 9);
    }
  });

  it('shortens and steepens the sea the moment the wind freshens', () => {
    const memory = new WindSeaMemory(MODERATE);
    const settled = memory.target(wind(6));
    const freshening = memory.target(wind(16));
    const settledSea = windSeaFromWind(
      effectiveGrowthWind(settled.generatingWind.speedMps),
      settled.generatingWind.maturity,
    );
    const fresheningSea = windSeaFromWind(
      effectiveGrowthWind(freshening.generatingWind.speedMps),
      freshening.generatingWind.maturity,
    );
    expect(fresheningSea.peakPeriod).toBeLessThan(settledSea.peakPeriod);
    expect(freshening.windSeaSteepness).toBeGreaterThan(settled.windSeaSteepness);
    // And the whitecap statistic, which reads the sea's own record, has
    // already gone to the new wind — windy before big.
    expect(freshening.generatingWind.speedMps).toBe(16);
  });

  it('holds the old sea when the wind drops, at the old maturity', () => {
    const memory = new WindSeaMemory(MODERATE);
    const target = memory.target(wind(1));
    expect(target.generatingWind.speedMps).toBe(
      MODERATE.generatingWind.speedMps,
    );
    expect(target.generatingWind.maturity).toBe(
      MODERATE.generatingWind.maturity,
    );
  });

  it('never writes the remote swell, the seed or the whitewater', () => {
    const memory = new WindSeaMemory(MODERATE);
    for (const present of [1, 6, 18]) {
      const target = memory.target(wind(present));
      expect(target.primary).toEqual(MODERATE.primary);
      expect(target.secondary).toEqual(MODERATE.secondary);
      expect(target.whitewater).toEqual(MODERATE.whitewater);
      expect(target.roughness).toEqual(MODERATE.roughness);
      expect(target.seed).toBe(MODERATE.seed);
    }
  });

  it('leaves gustiness to the ocean laboratory', () => {
    // Gustiness is a present-wind property that nothing in weather yet moves,
    // and the lab has a live slider for it that drives foam and spray. WX3
    // owns the gust field; until then writing it here would silently overrule
    // that control.
    const edited = cloneSeaState(MODERATE);
    edited.generatingWind.gustiness = 0.9;
    const memory = new WindSeaMemory(edited);
    const target = memory.target({ speedMps: 18, directionDeg: 90, gustiness: 0 });
    expect(target.generatingWind.gustiness).toBe(0.9);
  });
});

describe('the response time', () => {
  it('makes a sea take longer to leave than to arrive', () => {
    for (const speed of [4, 8, 14, 22]) {
      expect(windSeaResponseSeconds(speed, true)).toBeCloseTo(
        windSeaResponseSeconds(speed, false) * WIND_SEA_MEMORY.decayToBuildRatio,
        6,
      );
    }
  });

  it('scales with the wind and never falls below its floor', () => {
    expect(windSeaResponseSeconds(0, false)).toBe(
      WIND_SEA_MEMORY.minimumResponseSeconds,
    );
    expect(windSeaResponseSeconds(16, false)).toBeGreaterThan(
      windSeaResponseSeconds(8, false),
    );
  });

  it('relaxes at exactly the same rate however the interval is chopped up', () => {
    // The same guarantee `WorldWind` makes about its gust series, and for the
    // same reason: a frame-rate-dependent sea is not reproducible evidence.
    const coarse = new WindSeaMemory(MODERATE);
    const fine = new WindSeaMemory(MODERATE);
    const present = wind(16, 200);
    for (let i = 0; i < 8; i++) coarse.advance(600, present);
    for (let i = 0; i < 96; i++) fine.advance(50, present);
    expect(coarse.developedWind.speedMps).toBeCloseTo(
      fine.developedWind.speedMps,
      6,
    );
    expect(coarse.developedWind.directionDeg).toBeCloseTo(
      fine.developedWind.directionDeg,
      6,
    );
  });

  it('takes the shortest arc when the wind veers through north', () => {
    const base = cloneSeaState(MODERATE);
    base.generatingWind.directionDeg = 350;
    const memory = new WindSeaMemory(base);
    memory.advance(3600, wind(base.generatingWind.speedMps, 10));
    const heading = memory.developedWind.directionDeg;
    // Forward through north, never the long way round.
    expect(heading >= 350 || heading <= 10).toBe(true);
  });
});

describe('the coupling, and decision D5', () => {
  function drive(coupled: boolean, presentWind: PresentWind, steps = 400) {
    const seaStates = new SeaStateController(MODERATE);
    const coupling = new WindSeaCoupling(seaStates, MODERATE, coupled);
    let weatherSeconds = 0;
    for (let i = 0; i < steps; i++) {
      weatherSeconds += 0.05 * 30;
      coupling.update(0.05, weatherSeconds, presentWind);
      seaStates.advance(0.05);
    }
    return { seaStates, coupling };
  }

  it('does nothing at all while the wind is steady', () => {
    const { seaStates, coupling } = drive(
      true,
      wind(MODERATE.generatingWind.speedMps, MODERATE.generatingWind.directionDeg),
    );
    expect(coupling.commandsIssued).toBe(0);
    expect(seaStates.transitioning).toBe(false);
    expect(seaStates.state.generatingWind.speedMps).toBe(
      MODERATE.generatingWind.speedMps,
    );
  });

  it('does nothing at all when it is Independent, whatever the wind does', () => {
    const { seaStates, coupling } = drive(false, wind(24, 300));
    expect(coupling.commandsIssued).toBe(0);
    expect(seaStates.state.generatingWind.speedMps).toBe(
      MODERATE.generatingWind.speedMps,
    );
  });

  it('builds the sea behind a freshening wind, and never snaps it', () => {
    const seaStates = new SeaStateController(MODERATE);
    const coupling = new WindSeaCoupling(seaStates, MODERATE, true);
    const durations: number[] = [];
    const nativeSet = seaStates.set.bind(seaStates);
    seaStates.set = (next, seconds) => {
      durations.push(seconds);
      nativeSet(next, seconds);
    };

    let weatherSeconds = 0;
    for (let i = 0; i < 20000; i++) {
      weatherSeconds += 0.05 * 30;
      coupling.update(0.05, weatherSeconds, wind(16, 200));
      seaStates.advance(0.05);
    }
    expect(coupling.commandsIssued).toBeGreaterThan(10);
    // A snapped command would leave `SeaStateController` untransitioning, so
    // the runtime would stop re-applying the state to `WaveField` and the
    // persistent foam field would be stranded on a sea that no longer exists.
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(
      WIND_SEA_COMMAND_SECONDS.min,
    );
    expect(coupling.developedWind.speedMps).toBeGreaterThan(
      MODERATE.generatingWind.speedMps,
    );
    expect(coupling.developedWind.speedMps).toBeLessThan(16);
    expect(seaStates.state.primary).toEqual(MODERATE.primary);
  });

  it('adopts a chosen sea and forgets what grew the last one', () => {
    const seaStates = new SeaStateController(MODERATE);
    const coupling = new WindSeaCoupling(seaStates, MODERATE, true);
    let weatherSeconds = 0;
    for (let i = 0; i < 4000; i++) {
      weatherSeconds += 0.05 * 30;
      coupling.update(0.05, weatherSeconds, wind(18, 200));
      seaStates.advance(0.05);
    }
    expect(coupling.developedWind.speedMps).toBeGreaterThan(6.5);

    const rough = findSeaState('SOUTHERN_OCEAN_ROUGH');
    coupling.rebase(rough, weatherSeconds);
    expect(coupling.developedWind.speedMps).toBe(rough.generatingWind.speedMps);
    expect(coupling.developedWind.directionDeg).toBe(
      rough.generatingWind.directionDeg,
    );
  });
});

// ---------------------------------------------------------------------------
// The committed traces. Rebuilt from scratch and required to be identical, so
// the file and the code that claims to produce it cannot drift apart.
// ---------------------------------------------------------------------------

describe('committed wind-sea evidence', () => {
  const committed = JSON.parse(
    readFileSync('evidence/weather/wind-sea-baseline.json', 'utf8'),
  ) as WindSeaEvidence;

  it('is reproduced exactly by a fresh computation, and passes every gate', () => {
    const rebuilt = buildWindSeaEvidence();
    expect(rebuilt).toEqual(committed);
    expect(() => validateWindSeaEvidence(committed)).not.toThrow();
  });

  it('records a freshening the sea answers late, and windily', () => {
    const freshening = committed.runs.find((run) => run.name === 'freshening');
    expect(freshening).toBeDefined();
    const response = freshening!.response;
    // The wind arrives; the sea is a third of the size that wind implies.
    expect(response.hsMultipleOfEquilibriumAtWindArrival).toBeLessThan(0.5);
    // But the whitecaps are already all the way there. Windy before big.
    expect(response.whitecapFractionAtWindArrival).toBeGreaterThan(0.9);
    expect(response.hsFractionAtWindArrival).toBeLessThan(0.3);
    expect(freshening!.gates.remoteSwellIdentical).toBe(true);
    expect(freshening!.gates.foamHistoryPreserved).toBe(true);
  });

  it('records a sea that outlives the wind that made it', () => {
    const dying = committed.runs.find((run) => run.name === 'dying');
    expect(dying).toBeDefined();
    expect(dying!.response.hsMultipleOfEquilibriumAtWindArrival).toBeGreaterThan(2);
    expect(dying!.gates.remoteSwellIdentical).toBe(true);
    expect(dying!.gates.foamHistoryPreserved).toBe(true);
  });

  it('never moves the water more than an uncoupled sea already does', () => {
    for (const [index, run] of committed.runs.entries()) {
      const control = committed.controls[index];
      expect(control.gates.commandsIssued).toBe(0);
      expect(run.gates.maxProbeStepPerCeiling).toBeLessThanOrEqual(
        control.gates.maxProbeStepPerCeiling * 1.25 + 0.02,
      );
    }
  });
});

describe('the diagnostic fixtures, which weather must not touch', () => {
  it('never drives a DIAGNOSTIC or frozen sea', () => {
    // FLAT is marked PLAYABLE, but it is the buoyancy harness's zero and its
    // authored wind is exactly nothing, so weather has to leave it alone too.
    for (const name of ['FROZEN_SINGLE', 'EXTREME_DEBUG', 'FLAT']) {
      const fixture = findSeaState(name);
      const seaStates = new SeaStateController(fixture);
      const coupling = new WindSeaCoupling(seaStates, fixture, true);
      let weatherSeconds = 0;
      for (let i = 0; i < 4000; i++) {
        weatherSeconds += 0.05 * 30;
        coupling.update(0.05, weatherSeconds, wind(22, 300));
        seaStates.advance(0.05);
      }
      expect(coupling.commandsIssued).toBe(0);
      expect(seaStates.state).toEqual(fixture);
    }
  });
});
