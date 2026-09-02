import assert from 'node:assert/strict';
import { summarize } from './browser-harness.js';
import { buildSuiteConfig, HISTORICAL_REFERENCES, RENDER_SURFACE, SUITES } from './suites.mjs';
import {
  CAMPAIGNS,
  FEATURE_BOUNDARY_REVISIONS,
  LAST_BENCHMARKED_MASTER,
} from './campaigns.mjs';
import {
  parsePowermetricsText,
  summarizePowermetricsSamples,
  summarizeThermalSamples,
} from './thermal.mjs';

const summary = summarize([10, 20, 30, 40]);
assert.equal(summary.count, 4);
assert.equal(summary.mean, 25);
assert.equal(summary.median, 25);
assert.ok(summary.p05 < summary.median);
assert.ok(summary.p95 > summary.median);

assert.deepEqual(
  Object.keys(SUITES),
  ['smoke', 'historical', 'representative', 'southern-afternoon', 'full'],
);
assert.equal(SUITES.historical.length, 3);
assert.equal(SUITES.representative.length, 7);
assert.equal(SUITES['southern-afternoon'].length, 1);
assert.equal(SUITES['southern-afternoon'][0].id, 'afternoon-rough-medium');
assert.equal(SUITES.full.length, 27);
assert.equal(SUITES.representative.filter((scenario) => scenario.attribution).length, 1);
assert.equal(RENDER_SURFACE.backingWidth, RENDER_SURFACE.cssWidth * RENDER_SURFACE.dpr);
assert.equal(RENDER_SURFACE.backingHeight, RENDER_SURFACE.cssHeight * RENDER_SURFACE.dpr);
assert.equal(HISTORICAL_REFERENCES['day-production-medium'], 24.675);
assert.equal(HISTORICAL_REFERENCES['afternoon-rough-medium'], 28.256);
assert.equal(CAMPAIGNS['southern-afternoon-history'].rounds, 2);
assert.equal(FEATURE_BOUNDARY_REVISIONS.length, 28);
assert.equal(LAST_BENCHMARKED_MASTER.length, 40);
assert.deepEqual(
  CAMPAIGNS['current-master-history'].firstParentRanges,
  [`${LAST_BENCHMARKED_MASTER}..master`],
);
assert.deepEqual(
  CAMPAIGNS['current-rebaseline'].revisions,
  ['513fe5a', LAST_BENCHMARKED_MASTER, 'master'],
);

const config = buildSuiteConfig('smoke', { warmFrames: 12, fence: 'full-frame' });
assert.equal(config.scenarios.length, 1);
assert.equal(config.measurement.warmFrames, 12);
assert.equal(config.measurement.fence, 'full-frame');
assert.notEqual(config.scenarios[0], SUITES.smoke[0]);

const thermal = summarizeThermalSamples([
  { thermalState: 'nominal', thermalStateRaw: 0, lowPowerMode: false, activeProcessorCount: 8 },
  { thermalState: 'fair', thermalStateRaw: 1, lowPowerMode: false, activeProcessorCount: 8 },
  { thermalState: 'nominal', thermalStateRaw: 0, lowPowerMode: true, activeProcessorCount: 6 },
]);
assert.equal(thermal.sampleCount, 3);
assert.equal(thermal.maximumState, 'fair');
assert.equal(thermal.transitionCount, 2);
assert.equal(thermal.lowPowerModeSeen, true);
assert.equal(thermal.minimumActiveProcessorCount, 6);

const powermetricsSamples = parsePowermetricsText(`*** Sampled system activity (Mon Aug 10 10:45:43 2026 +0930) (1013.03ms elapsed) ***
E-Cluster HW active frequency: 912 MHz
P-Cluster HW active frequency: 3324 MHz
CPU Power: 3142 mW
GPU Power: 8060 mW
Combined Power (CPU + GPU + ANE): 11202 mW
Current pressure level: Nominal
GPU HW active frequency: 1388 MHz
GPU HW active residency:  97.47% (444 MHz: 1.0%)
GPU Power: 8055 mW
*** Sampled system activity (Mon Aug 10 10:45:44 2026 +0930) (1014.09ms elapsed) ***
CPU Power: 3178 mW
GPU Power: 8044 mW
Combined Power (CPU + GPU + ANE): 11222 mW
Current pressure level: Moderate
GPU HW active frequency: 1388 MHz
GPU HW active residency:  97.53% (444 MHz: .97%)
GPU Power: 7979 mW
`);
assert.equal(powermetricsSamples.length, 2);
assert.equal(powermetricsSamples[0].gpuPowerMw, 8055);
assert.equal(powermetricsSamples[1].pressure, 'Moderate');
const powermetrics = summarizePowermetricsSamples(powermetricsSamples);
assert.equal(powermetrics.maximumPressure, 'Moderate');
assert.equal(powermetrics.pressureTransitionCount, 1);
assert.equal(powermetrics.gpuFrequencyMHz.median, 1388);

process.stdout.write('performance tooling self-test passed\n');
