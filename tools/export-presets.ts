/**
 * Emit the machine-readable sea-state preset matrix.
 *
 *   npx vite-node tools/export-presets.ts
 *
 * Every value under `resolved` is produced by the model from the declared wind
 * and swell parameters. None of it is authored, which is the point: the file
 * is a record of what the physics does with the preset, not a second copy of
 * the preset that could drift away from it.
 */
import { writeFileSync } from 'node:fs';
import { SEA_STATES } from '../src/ocean/presets';
import { SLOTS_DEFAULT, resolveSeaState } from '../src/ocean/seaState';
import { whitecapCoverage, windSeaFromWind } from '../src/ocean/spectrum';
import { WaveField } from '../src/scene/Waves';

const r = (x: number, n = 3): number => Number(x.toFixed(n));

const presets = SEA_STATES.map((s) => {
  const spec = resolveSeaState(s, SLOTS_DEFAULT);
  const ws = windSeaFromWind(s.generatingWind.speedMps, s.generatingWind.maturity);
  const field = new WaveField(s);
  return {
    name: s.name,
    label: s.label,
    seed: s.seed,
    purpose: s.purpose,
    wind: {
      speedMps: s.generatingWind.speedMps,
      directionDeg: s.generatingWind.directionDeg,
      maturity: s.generatingWind.maturity,
      gustiness: s.generatingWind.gustiness,
    },
    windSea: {
      significantHeightM: r(ws.significantHeight),
      peakPeriodS: r(ws.peakPeriod),
      peakWavelengthM: r(1.5613 * ws.peakPeriod ** 2, 1),
      steepnessHsOverL: r(ws.significantHeight / (1.5613 * ws.peakPeriod ** 2), 4),
    },
    primarySwell: s.primary.enabled
      ? {
          significantHeightM: s.primary.significantHeight,
          peakPeriodS: s.primary.peakPeriod,
          peakWavelengthM: r(1.5613 * s.primary.peakPeriod ** 2, 1),
          directionDeg: s.primary.directionDeg,
          spreadDeg: s.primary.spreadDeg,
          steepness: s.primary.steepness,
          groupiness: s.primary.groupiness,
          wavesPerSet: r(4.5 + 9 * s.primary.groupiness, 1),
        }
      : null,
    secondarySwell: s.secondary.enabled
      ? {
          significantHeightM: s.secondary.significantHeight,
          peakPeriodS: s.secondary.peakPeriod,
          peakWavelengthM: r(1.5613 * s.secondary.peakPeriod ** 2, 1),
          directionDeg: s.secondary.directionDeg,
          spreadDeg: s.secondary.spreadDeg,
          steepness: s.secondary.steepness,
          groupiness: s.secondary.groupiness,
          wavesPerSet: r(4.5 + 9 * s.secondary.groupiness, 1),
        }
      : null,
    resolved: {
      combinedSignificantHeightM: r(spec.significantHeight),
      approxMaxIndividualWaveM: r(1.86 * spec.significantHeight),
      theoreticalMaxCrestM: r(spec.amplitudeSum),
      dominantPeriodS: r(spec.dominantPeriod, 2),
      longestWavelengthM: r(field.longestWavelength, 1),
      activeComponents: field.count,
      meanSquareSlope: r(spec.meanSquareSlope, 5),
      globalQ: r(field.globalQ),
      sumQAk: r(field.steepnessSum),
      breakingThresholdTrace: r(field.breakingThreshold, 4),
      monahanWhitecapCoveragePct: r(100 * whitecapCoverage(s.generatingWind.speedMps), 3),
    },
    whitewater: s.whitewater,
    roughness: s.roughness,
    notes: s.notes,
  };
});

writeFileSync(
  'evidence/sea-state-presets.json',
  `${JSON.stringify(
    {
      note:
        'Machine-readable sea-state preset matrix. Everything under "resolved" ' +
        'is produced by the spectral model from the declared wind and swell ' +
        'parameters; none of it is authored.',
      slotBudget: SLOTS_DEFAULT,
      presets,
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote evidence/sea-state-presets.json (${presets.length} presets)`);
