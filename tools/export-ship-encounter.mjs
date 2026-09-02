/**
 * Regenerate the committed prescribed-motion evidence.
 *
 *   npm run ship:encounter
 *
 * One small file proves the wave timing against the analytic deep-water
 * relation. The other records the actual hull response at a representative
 * prescribed speed. Neither run claims propulsion, steering or dynamic surge.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const frequencyPath = resolve('evidence/ship-response/encounter-frequency.json');
const responsePath = resolve('evidence/ship-response/prescribed-speed-baseline.json');

function validateFrequencyEvidence(evidence) {
  const byAspect = new Map(evidence.cases.map((result) => [result.aspect, result]));
  for (const aspect of ['head', 'quartering-head', 'beam', 'following']) {
    const result = byAspect.get(aspect);
    if (!result) throw new Error(`missing ${aspect} encounter case`);
    if (result.measuredUpwardCrossings < 3) {
      throw new Error(`${aspect} encounter case has too few measured crossings`);
    }
    if (result.relativeFrequencyError > 0.002) {
      throw new Error(
        `${aspect} encounter frequency error ${(result.relativeFrequencyError * 100).toFixed(3)}%`,
      );
    }
  }

  const head = byAspect.get('head').measuredAngularFrequencyRadPerSecond;
  const quarter = byAspect.get('quartering-head').measuredAngularFrequencyRadPerSecond;
  const beam = byAspect.get('beam').measuredAngularFrequencyRadPerSecond;
  const following = byAspect.get('following').measuredAngularFrequencyRadPerSecond;
  if (!(head > quarter && quarter > beam && beam > following)) {
    throw new Error('encounter frequencies do not order head > quartering > beam > following');
  }
}

function validateMovingMatrix(matrix, config) {
  const expectedCases = config.seaStateNames.length * config.headingsDeg.length;
  if (matrix.cases.length !== expectedCases || matrix.summary.caseCount !== expectedCases) {
    throw new Error(`incomplete moving response matrix: expected ${expectedCases} cases`);
  }
  if (matrix.cases.some((result) => !result.finite)) {
    throw new Error('moving response matrix contains a non-finite case');
  }
  if (
    matrix.configuration.speedThroughWaterMps !== config.speedThroughWaterMps ||
    matrix.cases.some(
      (result) => result.speedThroughWaterMps !== config.speedThroughWaterMps,
    )
  ) {
    throw new Error('moving response matrix did not retain its prescribed speed');
  }
  const maximumResidual = Math.max(
    ...matrix.cases.map((result) => result.maxWaveInverseSolveResidualMetres),
  );
  if (maximumResidual > 1e-6) {
    throw new Error(`moving wave inverse-solve residual ${maximumResidual} m exceeds 1e-6 m`);
  }
  if (matrix.summary.limiterContactCaseCount > 0) {
    throw new Error('representative CURRENT_MODERATE moving run touched a safety limiter');
  }
  return { maximumResidual };
}

function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, ws: false },
});

try {
  const encounter = await server.ssrLoadModule(
    '/src/vessel/schooner/EncounterMotion.ts',
  );
  const response = await server.ssrLoadModule(
    '/src/vessel/schooner/SchoonerResponse.ts',
  );
  const config = response.SHIP_RESPONSE_ENCOUNTER_CONFIG;

  const frequencyEvidence = encounter.buildSingleWaveEncounterEvidence();
  validateFrequencyEvidence(frequencyEvidence);

  const started = Date.now();
  const matrix = response.buildShipResponseMatrix({
    seaStateNames: config.seaStateNames,
    headingsDeg: config.headingsDeg,
    referenceWaveHeadingDeg: config.referenceWaveHeadingDeg,
    speedThroughWaterMps: config.speedThroughWaterMps,
    warmupSeconds: config.warmupSeconds,
    measurementSeconds: config.measurementSeconds,
    callerHz: config.callerHz,
    onCaseComplete(completed, total, result) {
      const elapsedSeconds = (Date.now() - started) / 1000;
      const averageSeconds = elapsedSeconds / completed;
      const remainingMinutes = (averageSeconds * (total - completed)) / 60;
      process.stdout.write(
        `[${completed}/${total}] ${result.seaState} ` +
          `heading ${String(result.presentationHeadingDeg).padStart(3)} degrees at ` +
          `${result.speedThroughWaterMps.toFixed(1)} m/s, ` +
          `roll ${result.motion.rollDeg.peakAbsolute.toFixed(2)} degrees, ` +
          `pitch ${result.motion.pitchDeg.peakAbsolute.toFixed(2)} degrees, ` +
          `~${remainingMinutes.toFixed(1)} min left\n`,
      );
    },
  });
  const validation = validateMovingMatrix(matrix, config);

  // Do not replace either tracked run until both have been built and validated.
  writeJsonAtomically(frequencyPath, frequencyEvidence);
  writeJsonAtomically(responsePath, matrix);

  process.stdout.write(`wrote ${frequencyPath} (${frequencyEvidence.cases.length} cases)\n`);
  process.stdout.write(
    `wrote ${responsePath} (${matrix.summary.caseCount} cases, ` +
      `${((Date.now() - started) / 60_000).toFixed(1)} min)\n`,
  );
  process.stdout.write(
    `validated maximum frequency error ` +
      `${(Math.max(...frequencyEvidence.cases.map((c) => c.relativeFrequencyError)) * 100).toFixed(4)}% ` +
      `and inverse residual ${validation.maximumResidual} m\n`,
  );
} finally {
  await server.close();
}
