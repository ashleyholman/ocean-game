/**
 * Regenerate the committed S3 weather-helm evidence.
 *
 *   npm run ship:helm
 *
 * The rudder angle that zeroes the net yaw moment on a captive zero-leeway
 * heading at the solved captive speed, per canvas balance. Slow by design —
 * hundreds of captive settles.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/helm-baseline.json');

function validateEvidence(evidence) {
  const gates = evidence.gates;
  if (!gates.helmFollowsCanvasBalance) {
    throw new Error(
      'balance rudder does not follow canvas CoE ordering at the beam',
    );
  }
  // "A few degrees, not tens" (design §9) over the full-sail reach band.
  if (!(gates.fullSailMaxAbsBalanceDeg > 0.2)) {
    throw new Error(
      `full-sail helm suspiciously dead: ${gates.fullSailMaxAbsBalanceDeg}°`,
    );
  }
  if (!(gates.fullSailMaxAbsBalanceDeg <= 10)) {
    throw new Error(
      `full-sail helm outside the few-degrees band: ` +
        `${gates.fullSailMaxAbsBalanceDeg}°`,
    );
  }
  if (!gates.fullSailReachWeatherHelm) {
    throw new Error(
      'full sail does not carry weather helm on the reach band; the S2 ' +
        'wander finding says she must',
    );
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
  const evidence = steering.buildShipHelmEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const sheet of evidence.sheets) {
    const beam = sheet.points.find((p) => p.windAngleOffBowDeg === 90);
    process.stdout.write(
      `${sheet.canvas} (CoE z ${sheet.canvasCoeZM} m): beam balance ` +
        `${beam?.balanceRudderDeg ?? 'null'}°\n`,
    );
  }
} finally {
  await server.close();
}
