/**
 * Regenerate the committed passive calm-water resistance evidence.
 *
 *   npm run ship:resistance
 *
 * This is a captive tow/drift/yaw record. It validates the force surface before
 * surge, sway or yaw are allowed to alter production movement.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const outputPath = resolve('evidence/ship-resistance/calm-water-baseline.json');

function validateEvidence(evidence) {
  if (!evidence.summary.straightTowDragMonotonic) {
    throw new Error('straight-tow drag is not strictly monotonic');
  }
  if (evidence.summary.maximumPositiveMechanicalPowerW > 1e-8) {
    throw new Error(
      `passive model added ${evidence.summary.maximumPositiveMechanicalPowerW} W`,
    );
  }
  if (evidence.summary.maximumDriftMirrorRelativeError > 1e-10) {
    throw new Error('drift force surface is not reciprocal');
  }
  if (evidence.summary.maximumYawMirrorRelativeError > 1e-10) {
    throw new Error('yaw force surface is not reciprocal');
  }
  const cases = [...evidence.straightTow, ...evidence.drift, ...evidence.yaw];
  for (const result of cases) {
    const values = [
      ...Object.values(result.forceBodyN),
      result.yawMomentNm,
      result.mechanicalPowerW,
      result.reynoldsNumber,
      result.froudeNumber,
      result.frictionCoefficient,
      result.residuaryCoefficient,
      result.effectiveWettedSurfaceAreaM2,
      ...Object.values(result.components),
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error('resistance evidence contains a non-finite value');
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
  server: { middlewareMode: true, ws: false },
});

try {
  const resistance = await server.ssrLoadModule(
    '/src/vessel/schooner/SchoonerResistanceEvidence.ts',
  );
  const evidence = resistance.buildSchoonerResistanceEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(
    `wrote ${outputPath} (${evidence.straightTow.length} tow, ` +
      `${evidence.drift.length} drift, ${evidence.yaw.length} yaw cases)\n`,
  );
  process.stdout.write(
    `validated passive force surface; 4 m/s drag ` +
      `${evidence.summary.dragAtFourMpsN.toFixed(1)} N, effective power ` +
      `${(evidence.summary.effectivePowerAtFourMpsW / 1000).toFixed(2)} kW\n`,
  );
} finally {
  await server.close();
}
