/**
 * Regenerate the deterministic S6 voyage evidence.
 *
 *   npm run ship:voyage
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/voyage-baseline.json');

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
  const voyage = await server.ssrLoadModule(
    '/src/vessel/schooner/SailingVoyageEvidence.ts',
  );
  const started = Date.now();
  const evidence = voyage.buildSailingVoyageEvidence();
  for (const [key, run] of Object.entries(evidence.voyages)) {
    process.stdout.write(
      `${key}: ${run.arrivedAtSeconds === null ? 'DID NOT ARRIVE' : `arrived ${run.arrivedAtSeconds.toFixed(0)}s`}, ` +
        `${run.finalDistanceToGoM.toFixed(0)} m to go, ` +
        `${run.tackCount} tacks / ${run.gybeCount} gybes ` +
        `(${run.failedEvolutionCount} failed), ` +
        `track efficiency ${run.trackEfficiency.toFixed(3)}, ` +
        `canvas "${run.finalCanvasPlan}"\n`,
    );
  }
  const heel = evidence.heelRelief;
  process.stdout.write(
    `heel at ${heel.windSpeedMps} m/s (settled): sheets only ` +
      `${heel.easingOnlySettledRollDeg.toFixed(1)}°, canvas policy ` +
      `${heel.shortenedSettledRollDeg.toFixed(1)}° ("${heel.shortenedFinalPlan}") — ` +
      `${heel.reliefDeg.toFixed(1)}° of relief; peaks ` +
      `${heel.easingOnlyMaximumRollDeg.toFixed(1)}° vs ` +
      `${heel.shortenedMaximumRollDeg.toFixed(1)}°\n`,
  );
  process.stdout.write(
    `compression: control trace identical ${evidence.compression.identicalControlTrace}, ` +
      `ground ratio ${evidence.compression.groundRatio}\n`,
  );
  process.stdout.write(
    `cannot-draw response: ${evidence.gates.cannotDrawResponseSeconds ?? 'none'} s\n`,
  );
  process.stdout.write(`built in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  voyage.validateSailingVoyageEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
} finally {
  await server.close();
}
