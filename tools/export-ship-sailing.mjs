/**
 * Regenerate the committed S2a sail-force evidence.
 *
 *   npm run ship:sailing
 *
 * The record validates the straight-line sail-force contract: derived sail
 * geometry, captive per-sail force sweeps with a dead no-go zone and an exact
 * tack mirror, the generalised energy gate through gust transients, and
 * caller-rate / voyage-compression invariance with sails drawing.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

// The packaged GeographicLib build is a browser-shaped UMD bundle even when
// Vite evaluates it for this headless evidence runner.
globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/straight-line-baseline.json');

function validateEvidence(evidence) {
  const gates = evidence.captiveSweep.gates;
  if (!(gates.driveDeadAheadN < 0)) {
    throw new Error(
      `head to wind she must be pushed astern, got ${gates.driveDeadAheadN} N`,
    );
  }
  if (!(gates.bestDriveAngleDeg > -140 && gates.bestDriveAngleDeg < -50)) {
    throw new Error(
      `best drive should sit in the drawing tack's reach sector, got ${gates.bestDriveAngleDeg}°`,
    );
  }
  if (!(gates.bestDriveN > 3000)) {
    throw new Error(`best drive ${gates.bestDriveN} N is implausibly weak`);
  }
  if (!(gates.tackMirrorRelativeError < 1e-3)) {
    throw new Error(
      `tack mirror error ${gates.tackMirrorRelativeError} exceeds the ` +
        'centre-of-mass asymmetry allowance',
    );
  }
  if (!gates.heelAlwaysToLeewardWhileDrawing) {
    throw new Error('a drawing entry heeled her to windward');
  }
  const deadAhead = evidence.captiveSweep.entries.find(
    (entry) => entry.windAngleOffBowDeg === 0,
  );
  if (deadAhead.luffingCount !== 8) {
    throw new Error(
      `head to wind ${deadAhead.luffingCount}/8 sails luffed; all must`,
    );
  }

  const gust = evidence.freeRuns.gustEnergy;
  if (gust.maxEnergyOverWorkJ > 1e-6) {
    throw new Error(
      `kinetic energy beat wind work by ${gust.maxEnergyOverWorkJ} J`,
    );
  }
  if (!(gust.finalSpeedMps < gust.hullSpeedBoundMps)) {
    throw new Error(
      `gust run reached ${gust.finalSpeedMps} m/s past the hull-speed bound`,
    );
  }
  if (!(gust.finalSpeedMps > 1)) {
    throw new Error(
      `gust run only reached ${gust.finalSpeedMps} m/s; sails are not driving`,
    );
  }
  const becalmed = evidence.freeRuns.zeroWindBarePoles;
  if (becalmed.finalSpeedMps !== 0 || becalmed.externalWorkJ !== 0) {
    throw new Error('becalmed bare poles moved the ship or did work');
  }

  const caller = evidence.invariance.callerRate;
  if (
    Math.max(caller.velocityErrorMps, caller.yawErrorRad) > 1e-9 ||
    caller.externalWorkErrorJ > 1e-6
  ) {
    throw new Error('48/240 Hz callers diverged with sails drawing');
  }
  const voyage = evidence.invariance.voyageCompression;
  if (Math.max(voyage.localVelocityErrorMps, voyage.localYawErrorRad) > 1e-9) {
    throw new Error('voyage compression leaked into sailing dynamics');
  }
  if (
    Math.abs(voyage.globalDistanceRatio - voyage.expectedGlobalDistanceRatio) >
    1e-6
  ) {
    throw new Error(
      `global distance ratio ${voyage.globalDistanceRatio} did not match ` +
        `${voyage.expectedGlobalDistanceRatio}`,
    );
  }

  const values = [
    evidence.sailPlan.totalClothAreaM2,
    evidence.sailPlan.windage.areaM2,
  ];
  for (const sail of evidence.sailPlan.sails) {
    values.push(sail.areaM2, sail.coeM.x, sail.coeM.y, sail.coeM.z);
  }
  for (const entry of evidence.captiveSweep.entries) {
    values.push(
      entry.totals.driveForwardN,
      entry.totals.sideForceN,
      entry.totals.heelTorqueNm,
      entry.totals.yawMomentNm,
      entry.steadyHeelDeg,
    );
    for (const sail of entry.perSail) {
      values.push(sail.aoaDeg, sail.forceModelN.x, sail.forceModelN.y, sail.forceModelN.z);
    }
  }
  for (const sample of gust.samples) {
    values.push(sample.speedMps, sample.kineticEnergyJ, sample.externalWorkJ);
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('sailing evidence contains a non-finite value');
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
  const sailing = await server.ssrLoadModule(
    '/src/vessel/schooner/SailingForceEvidence.ts',
  );
  const evidence = sailing.buildSailingForceEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  const gates = evidence.captiveSweep.gates;
  process.stdout.write(
    `validated best drive ${gates.bestDriveN.toFixed(0)} N at ${gates.bestDriveAngleDeg}°, ` +
      `dead ahead ${gates.driveDeadAheadN.toFixed(0)} N, ` +
      `gust run ${evidence.freeRuns.gustEnergy.finalSpeedMps.toFixed(2)} m/s, ` +
      `energy excess ${evidence.freeRuns.gustEnergy.maxEnergyOverWorkJ} J\n`,
  );
} finally {
  await server.close();
}
