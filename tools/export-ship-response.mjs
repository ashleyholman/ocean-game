/**
 * Regenerate the committed stationary ship-response baseline.
 *
 *   npm run ship:response
 *
 * The output path is stable on purpose. Git is the history: after a deliberate
 * physics change, regenerate, inspect the ordinary diff, and commit the new
 * evidence with the change that caused it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const outputPath = resolve('evidence/ship-response/zero-speed-baseline.json');
const temporaryPath = `${outputPath}.tmp`;

function relativeDifference(a, b) {
  return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
}

/** Reject a run that is complete and finite but no longer physically reciprocal. */
function validateMatrix(matrix, tolerances) {
  const expectedCases =
    matrix.configuration.seaStates.length * matrix.configuration.headingsDeg.length;
  if (matrix.cases.length !== expectedCases || matrix.summary.caseCount !== expectedCases) {
    throw new Error(`incomplete response matrix: expected ${expectedCases} cases`);
  }
  if (matrix.cases.some((result) => !result.finite)) {
    throw new Error('response matrix contains a non-finite case');
  }

  const metrics = [
    {
      name: 'roll RMS',
      tolerance: tolerances.rmsRelativeDifference,
      value: (c) => c.motion.rollDeg.rms,
    },
    {
      name: 'pitch RMS',
      tolerance: tolerances.rmsRelativeDifference,
      value: (c) => c.motion.pitchDeg.rms,
    },
    {
      name: 'roll peak',
      tolerance: tolerances.peakRelativeDifference,
      value: (c) => c.motion.rollDeg.peakAbsolute,
    },
    {
      name: 'pitch peak',
      tolerance: tolerances.peakRelativeDifference,
      value: (c) => c.motion.pitchDeg.peakAbsolute,
    },
  ];
  const worst = Object.fromEntries(metrics.map((metric) => [metric.name, 0]));
  const byCase = new Map(
    matrix.cases.map((result) => [
      `${result.seaState}:${result.presentationHeadingDeg}`,
      result,
    ]),
  );

  for (const result of matrix.cases) {
    if (result.presentationHeadingDeg >= 180) continue;
    const opposite = byCase.get(
      `${result.seaState}:${result.presentationHeadingDeg + 180}`,
    );
    if (!opposite) {
      throw new Error(
        `missing opposite heading for ${result.seaState} ${result.presentationHeadingDeg} degrees`,
      );
    }
    for (const metric of metrics) {
      const difference = relativeDifference(metric.value(result), metric.value(opposite));
      worst[metric.name] = Math.max(worst[metric.name], difference);
      if (difference > metric.tolerance) {
        throw new Error(
          `${metric.name} opposite-heading difference ${(difference * 100).toFixed(2)}% ` +
            `exceeds ${(metric.tolerance * 100).toFixed(0)}% at ` +
            `${result.seaState} ${result.presentationHeadingDeg}/${opposite.presentationHeadingDeg}`,
        );
      }
    }
  }

  const maximumResidual = Math.max(
    ...matrix.cases.map((result) => result.maxWaveInverseSolveResidualMetres),
  );
  if (maximumResidual > 1e-6) {
    throw new Error(`wave inverse-solve residual ${maximumResidual} m exceeds 1e-6 m`);
  }
  return { worst, maximumResidual };
}

const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, ws: false },
});

try {
  const response = await server.ssrLoadModule(
    '/src/vessel/schooner/SchoonerResponse.ts',
  );
  const started = Date.now();
  const matrix = response.buildShipResponseMatrix({
    onCaseComplete(completed, total, result) {
      const elapsedSeconds = (Date.now() - started) / 1000;
      const averageSeconds = elapsedSeconds / completed;
      const remainingMinutes = (averageSeconds * (total - completed)) / 60;
      const roll = result.motion.rollDeg.peakAbsolute.toFixed(2);
      const pitch = result.motion.pitchDeg.peakAbsolute.toFixed(2);
      process.stdout.write(
        `[${String(completed).padStart(String(total).length)}/${total}] ` +
          `${result.seaState.padEnd(25)} heading ${String(result.presentationHeadingDeg).padStart(3)}° ` +
          `roll ${roll.padStart(5)}° pitch ${pitch.padStart(5)}° ` +
          `~${remainingMinutes.toFixed(1)} min left\n`,
      );
    },
  });
  const validation = validateMatrix(
    matrix,
    response.SHIP_RESPONSE_OPPOSITE_HEADING_TOLERANCES,
  );

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(matrix, null, 2)}\n`);
  renameSync(temporaryPath, outputPath);
  const elapsedMinutes = (Date.now() - started) / 60_000;
  process.stdout.write(
    `wrote ${outputPath} (${matrix.summary.caseCount} cases, ${elapsedMinutes.toFixed(1)} min)\n`,
  );
  process.stdout.write(
    `validated opposite-heading differences: ` +
      `roll RMS ${(validation.worst['roll RMS'] * 100).toFixed(2)}%, ` +
      `pitch RMS ${(validation.worst['pitch RMS'] * 100).toFixed(2)}%, ` +
      `roll peak ${(validation.worst['roll peak'] * 100).toFixed(2)}%, ` +
      `pitch peak ${(validation.worst['pitch peak'] * 100).toFixed(2)}%\n`,
  );
} finally {
  await server.close();
}
