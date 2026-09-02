/**
 * Regenerate the committed wind-sea memory evidence (WX2).
 *
 *   npm run weather:seatrace
 *
 * Two scripted runs of the production coupling path — a freshening wind and a
 * dying one — into `evidence/weather/wind-sea-baseline.json`.
 * `tests/wind-sea-memory.test.ts` rebuilds both from scratch and requires deep
 * equality, so the file cannot drift from the code that claims to produce it.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/weather/wind-sea-baseline.json');

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
  const module = await server.ssrLoadModule('/src/ocean/WindSeaEvidence.ts');
  const evidence = module.buildWindSeaEvidence();
  module.validateWindSeaEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const run of evidence.runs) {
    const response = run.response;
    process.stdout.write(
      `${run.name}: tau ${(response.tauWorldSeconds / 3600).toFixed(2)} world h ` +
        `(${(response.tauRealSeconds / 60).toFixed(1)} real min), ` +
        `Hs ${response.startWindSeaHsM} -> ${response.endWindSeaHsM} m ` +
        `(equilibrium ${response.equilibriumWindSeaHsM}), ` +
        `half-response ${response.windSeaHsLagSeconds} s after the wind arrived, ` +
        `at which instant the sea stood at ` +
        `${response.hsMultipleOfEquilibriumAtWindArrival}x the height the wind implied\n`,
    );
    process.stdout.write(
      `  at the wind's arrival: height ` +
        `${(response.hsFractionAtWindArrival * 100).toFixed(1)}% there, ` +
        `whitecaps ${(response.whitecapFractionAtWindArrival * 100).toFixed(1)}%; ` +
        `${run.gates.commandsIssued} commands, ` +
        `worst probe step ${run.gates.maxProbeElevationStepM} m ` +
        `(${run.gates.maxProbeStepPerCeiling} of its own vertical-rate scale, ` +
        `control ${evidence.controls[evidence.runs.indexOf(run)].gates.maxProbeStepPerCeiling})\n`,
    );
  }
} finally {
  await server.close();
}
