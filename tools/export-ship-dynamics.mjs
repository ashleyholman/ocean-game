/**
 * Regenerate the committed passive horizontal-dynamics evidence.
 *
 *   npm run ship:dynamics
 *
 * The record validates force-integrated decay, the retained captive tow, fixed
 * 240 Hz caller invariance and separation of local encounter from the 30x
 * compressed global voyage.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

// The packaged GeographicLib build is a browser-shaped UMD bundle even when
// Vite evaluates it for this headless evidence runner.
globalThis.window = globalThis;

const outputPath = resolve(
  'evidence/ship-dynamics/passive-horizontal-baseline.json',
);

function validateEvidence(evidence) {
  const { coastDown, sideslipDecay, yawDecay, captiveTow } = evidence.cases;
  for (const result of [coastDown, sideslipDecay, yawDecay]) {
    if (result.summary.maximumPositiveEnergyStepJ > 1e-5) {
      throw new Error(
        `${result.name} added ${result.summary.maximumPositiveEnergyStepJ} J`,
      );
    }
    if (
      !(result.summary.finalKineticEnergyJ < result.summary.initialKineticEnergyJ)
    ) {
      throw new Error(`${result.name} did not dissipate kinetic energy`);
    }
  }
  if (!coastDown.summary.speedMonotonicNonIncreasing) {
    throw new Error('straight coast-down speed was not monotonic');
  }
  if (!(coastDown.summary.finalSpeedMps < coastDown.summary.initialSpeedMps)) {
    throw new Error('straight coast-down did not slow the vessel');
  }
  if (
    sideslipDecay.summary.finalAbsolutePortSpeedMps >=
    sideslipDecay.summary.initialAbsolutePortSpeedMps * 0.2
  ) {
    throw new Error('sideslip did not decay below 20% of release value');
  }
  if (
    yawDecay.summary.finalAbsoluteYawRateRadPerSecond >=
    yawDecay.summary.initialAbsoluteYawRateRadPerSecond * 0.1
  ) {
    throw new Error('yaw rate did not decay below 10% of release value');
  }

  const towSpeed = captiveTow.summary.finalSpeedMps;
  if (Math.abs(towSpeed - 4) > 1e-8) {
    throw new Error(`captive tow drifted to ${towSpeed} m/s`);
  }
  if (Math.abs(captiveTow.samples.at(-1).yawRad - 0.4) > 1e-8) {
    throw new Error('captive tow did not retain commanded yaw');
  }

  const caller = evidence.invariance.callerRate;
  if (
    Math.max(
      caller.velocityErrorMps,
      caller.yawErrorRad,
      caller.yawRateErrorRadPerSecond,
      caller.encounterDisplacementErrorM,
    ) > 1e-9
  ) {
    throw new Error('60/120 Hz callers diverged at the fixed-step checkpoint');
  }
  const voyage = evidence.invariance.voyageCompression;
  if (
    Math.max(
      voyage.localVelocityErrorMps,
      voyage.localYawErrorRad,
      voyage.encounterDisplacementErrorM,
    ) > 1e-10
  ) {
    throw new Error('voyage compression leaked into local dynamics');
  }
  if (
    Math.abs(
      voyage.globalDistanceRatio - voyage.expectedGlobalDistanceRatio,
    ) > 1e-8
  ) {
    throw new Error(
      `global distance ratio ${voyage.globalDistanceRatio} did not match ` +
        `${voyage.expectedGlobalDistanceRatio}`,
    );
  }

  const values = [];
  for (const result of Object.values(evidence.cases)) {
    values.push(
      ...Object.values(result.summary).filter(
        (value) => typeof value === 'number',
      ),
      result.finalResistance.forceBodyN.x,
      result.finalResistance.forceBodyN.z,
      result.finalResistance.yawMomentNm,
    );
    for (const sample of result.samples) {
      values.push(
        sample.timeSeconds,
        sample.velocityWorldMps.x,
        sample.velocityWorldMps.z,
        sample.speedMps,
        sample.forwardSpeedMps,
        sample.portSpeedMps,
        sample.yawRad,
        sample.yawRateRadPerSecond,
        sample.kineticEnergyJ,
      );
    }
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('horizontal-dynamics evidence contains a non-finite value');
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
  const dynamics = await server.ssrLoadModule(
    '/src/vessel/schooner/SchoonerHorizontalDynamicsEvidence.ts',
  );
  const evidence = dynamics.buildSchoonerHorizontalDynamicsEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  process.stdout.write(
    `validated coast-down ${evidence.cases.coastDown.summary.initialSpeedMps.toFixed(2)} -> ` +
      `${evidence.cases.coastDown.summary.finalSpeedMps.toFixed(2)} m/s, ` +
      `sideslip ${evidence.cases.sideslipDecay.summary.finalAbsolutePortSpeedMps
        .toFixed(3)} m/s, ` +
      `yaw rate ${evidence.cases.yawDecay.summary.finalAbsoluteYawRateRadPerSecond
        .toFixed(5)} rad/s\n`,
  );
} finally {
  await server.close();
}
