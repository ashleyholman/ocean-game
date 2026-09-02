/**
 * Regenerate the committed weather-series evidence.
 *
 *   npm run weather:series
 *
 * Seventy-two world hours of weather at the opening voyage's position and
 * instant, on the shared default seed. The record proves the generator is
 * reproducible, bounded, continuous through north, and — the gate this round
 * turns on — that a falling glass brings wind.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const outputPath = resolve('evidence/weather/series-baseline.json');

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
  const module = await server.ssrLoadModule('/src/weather/WeatherEvidence.ts');
  const evidence = module.buildWeatherEvidence();
  module.validateWeatherEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);

  const { anchor, stats } = evidence;
  process.stdout.write(`wrote ${outputPath}\n`);
  process.stdout.write(
    `  glass       ${stats.minPressureHpa.toFixed(1)}–${stats.maxPressureHpa.toFixed(1)} hPa, ` +
      `tendency ${stats.minTrendHpaPer3h.toFixed(2)} to ${stats.maxTrendHpaPer3h.toFixed(2)} hPa/3h\n`,
  );
  process.stdout.write(
    `  wind        ${stats.minWindSpeedMps.toFixed(2)}–${stats.maxWindSpeedMps.toFixed(2)} m/s ` +
      `(mean ${stats.meanWindSpeedMps.toFixed(2)}), worst veer ` +
      `${stats.maxAbsDirectionStepDeg.toFixed(1)}° per six minutes\n`,
  );
  process.stdout.write(
    `  glass↔wind  r = ${stats.glassWindCorrelation.toFixed(3)} ` +
      '(negative: a falling glass brings wind)\n',
  );
  process.stdout.write(
    `  neutral     derived wind matches the base exactly: ${anchor.derivedWindMatchesBaseExactly}\n`,
  );
} finally {
  await server.close();
}
