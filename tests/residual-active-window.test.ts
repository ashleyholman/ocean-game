import { describe, expect, it } from 'vitest';
import { SEA_STATES } from '../src/ocean/presets';
import { blendSeaState } from '../src/ocean/seaState';
import {
  evaluateResidualActive,
  evaluateResidualBrute,
} from '../src/ocean/residualActiveWindow';
import { OCEAN_QUALITY_DESKTOP } from '../src/scene/Ocean';
import { MAX_WAVES, WaveField } from '../src/scene/Waves';

const RESIDUAL_MAX_K =
  (Math.PI * 2) / OCEAN_QUALITY_DESKTOP.residualMinWavelength;

function close(actual: number, expected: number, tolerance = 2e-6): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
    tolerance * Math.max(1, Math.abs(expected)),
  );
}

describe('residual active window', () => {
  it('keeps a wavelength-ordered render-only table without changing canonical slots', () => {
    for (const state of SEA_STATES) {
      const waves = new WaveField(state);
      waves.setLodSpacing(0.033);
      let previousK = 0;
      for (let sorted = 0; sorted < waves.residualActiveCount; sorted++) {
        const offset = sorted * 4;
        expect(waves.residualWaveA[offset + 2]).toBeGreaterThan(0);
        expect(waves.residualWaveA[offset + 3]).toBeGreaterThanOrEqual(previousK);
        expect(waves.residualWaveB[offset]).toBeGreaterThanOrEqual(0);
        previousK = waves.residualWaveA[offset + 3];
      }
      for (let sorted = waves.residualActiveCount; sorted < MAX_WAVES; sorted++) {
        expect(waves.residualWaveA[sorted * 4 + 2]).toBe(0);
      }
    }
  });

  it('matches the brute residual semantics over presets, morphs, and scale inputs', () => {
    let randomState = 0x5f3759df;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 0x100000000;
    };
    const states = [
      ...SEA_STATES,
      blendSeaState(SEA_STATES[5], SEA_STATES[9], 0.37),
      blendSeaState(SEA_STATES[1], SEA_STATES[7], 0.61),
    ];

    for (const state of states) {
      const waves = new WaveField(state);
      waves.setLodSpacing(0.033);
      waves.setTime(137.25);
      for (let sample = 0; sample < 80; sample++) {
        const pX = (random() - 0.5) * 40_000;
        const pZ = (random() - 0.5) * 40_000;
        const lodRadius = Math.pow(random(), 2) * 20_000;
        const footprint = Math.pow(10, -3 + random() * 5);
        const brute = evaluateResidualBrute(
          waves.waveA,
          waves.waveB,
          waves.amplitude,
          RESIDUAL_MAX_K,
          pX,
          pZ,
          lodRadius,
          footprint,
        );
        const active = evaluateResidualActive(
          waves.residualWaveA,
          waves.residualWaveB,
          waves.residualActiveCount,
          waves.residualTotalSlopeEnergy,
          waves.amplitude,
          RESIDUAL_MAX_K,
          pX,
          pZ,
          lodRadius,
          footprint,
        );
        close(active.gradientX, brute.gradientX);
        close(active.gradientZ, brute.gradientZ);
        close(active.lostVariance, brute.lostVariance);
        expect(active.individualCount).toBeLessThanOrEqual(waves.residualActiveCount);
      }
    }
  });
});
