/**
 * Regenerate the deterministic S5 compass-course crew checkpoint evidence.
 *
 *   npm run ship:crew
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/crew-baseline.json');

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
  ssr: { noExternal: ['geographiclib-geodesic'] },
  server: { middlewareMode: true, ws: false },
});

try {
  const crew = await server.ssrLoadModule(
    '/src/vessel/schooner/SailingCrewEvidence.ts',
  );
  const evidence = crew.buildSailingCrewEvidence();
  process.stdout.write(
    `compass step settle ${evidence.compass.step.settleTimeSeconds}s, ` +
      `overshoot ${evidence.compass.step.maximumOvershootDeg.toFixed(2)}°\n`,
  );
  for (const run of [evidence.helm.calm, evidence.helm.currentModerate]) {
    process.stdout.write(
      `${run.name}: RMS ${run.rmsCourseErrorDeg.toFixed(2)}°, ` +
        `settled signed mean ${run.settledSignedMeanErrorDeg.toFixed(2)}°, ` +
        `${run.interventionsPerMinute.toFixed(1)} interventions/min, ` +
        `longest unchanged target ${run.maximumUnchangedTargetSeconds.toFixed(1)}s\n`,
    );
  }
  crew.validateSailingCrewEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
} finally {
  await server.close();
}
