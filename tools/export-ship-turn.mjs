/**
 * Regenerate the committed S3 turn-circle evidence.
 *
 *   npm run ship:turn
 *
 * Steady circles under commanded rudder with synthetic thrust standing in
 * for propulsion (no wind, so the port/starboard mirror is pure hull+rudder).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/turn-baseline.json');

function validateEvidence(evidence) {
  const gates = evidence.gates;
  if (!(gates.stoppedShipTurnRad < 1e-8)) {
    throw new Error(`a stopped ship turned: ${gates.stoppedShipTurnRad} rad`);
  }
  if (!gates.radiusMonotonicWithHelm) {
    throw new Error('turn radius is not monotone in rudder angle');
  }
  if (!(gates.mirrorMaxRelativeError < 5e-3)) {
    throw new Error(
      `port/starboard turn mirror broken: ${gates.mirrorMaxRelativeError}`,
    );
  }
  // Broad scale gates: catch a lost rho/area factor, not performance claims.
  if (!(gates.minRadiusM > 25 && gates.maxRadiusM < 400)) {
    throw new Error(
      `turn radii outside the sane band: ${gates.minRadiusM}–${gates.maxRadiusM} m`,
    );
  }
  if (!(gates.maxEnergyOverWorkJ <= 1e-6)) {
    throw new Error(`energy gate violated: ${gates.maxEnergyOverWorkJ} J`);
  }
  if (!(gates.maxYawRateUnsteadiness < 0.05)) {
    throw new Error(
      `turn circles did not settle: unsteadiness ${gates.maxYawRateUnsteadiness}`,
    );
  }
  for (const control of evidence.straightLineControls) {
    if (Math.abs(control.finalSpeedMps - control.targetSpeedMps) > 0.15) {
      throw new Error(
        `thrust calibration drifted: ${control.finalSpeedMps} vs ` +
          `${control.targetSpeedMps} m/s`,
      );
    }
  }
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
  ssr: { noExternal: ['geographiclib-geodesic'] },
  server: { middlewareMode: true, ws: false },
});

try {
  const steering = await server.ssrLoadModule(
    '/src/vessel/schooner/SailingSteeringEvidence.ts',
  );
  const evidence = steering.buildShipTurnEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const c of evidence.cases) {
    process.stdout.write(
      `${c.targetSpeedMps} m/s, rudder ${c.rudderCommandDeg}°: ` +
        `radius ${c.steadyRadiusM} m, drift ${c.steadyDriftAngleDeg}°\n`,
    );
  }
} finally {
  await server.close();
}
