/**
 * Regenerate the committed world-wind gust evidence.
 *
 *   npm run wind:baseline
 *
 * The record proves the gust process is deterministic for the fixed seed,
 * bounded by its stated amplitude fractions, mean-reverting on a 3-60 s
 * character, and exactly the mean wind wherever gustiness is zero.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const outputPath = resolve('evidence/world-wind/gust-baseline.json');

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
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, ws: false },
});

try {
  const module = await server.ssrLoadModule('/src/world/WorldWindEvidence.ts');
  const evidence = module.buildWorldWindEvidence();
  module.validateWorldWindEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const preset of evidence.presets) {
    process.stdout.write(
      `validated ${preset.name}: mean ${preset.meanSpeedMps.toFixed(2)} m/s, ` +
        `range ${preset.stats.minInstantaneousSpeedMps.toFixed(2)}-` +
        `${preset.stats.maxInstantaneousSpeedMps.toFixed(2)} m/s, ` +
        `crossing ${preset.stats.meanGustZeroCrossingIntervalSeconds.toFixed(1)} s\n`,
    );
  }
} finally {
  await server.close();
}
