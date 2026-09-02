/**
 * Regenerate the committed wake contact/source and WK1–WK3 policy baselines.
 *
 *   npm run ship:wake
 *
 * This is deliberately CPU/headless evidence only. It does not run the WK0 GPU
 * baseline: that measurement waits for an explicitly uncontended window and
 * uses the repository's GPU-enabled headless Chrome process.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-wake/contact-baseline.json');
/**
 * WK3's event record, deliberately a second file.
 *
 * The plan required the spray sizing to arrive as an intentional extension
 * *beside* the contact baseline rather than as a silent change to it, because
 * the baseline is what every earlier round's numbers were read from. Both are
 * regenerated together because both are solved against the same live polar.
 */
const sprayOutputPath = resolve('evidence/ship-wake/spray-events.json');

function visitNumbers(value, path = 'evidence') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} contains non-finite ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitNumbers(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      visitNumbers(entry, `${path}.${key}`);
    }
  }
}

function validateEvidence(evidence) {
  if (evidence.formatVersion !== 6) {
    throw new Error(`unexpected wake evidence version ${evidence.formatVersion}`);
  }
  if (evidence.cases.length !== 4 || evidence.polarReferences.length !== 3) {
    throw new Error('wake evidence must contain one anchor and three polar cases');
  }
  const anchor = evidence.cases.find((entry) => entry.name.endsWith('_ANCHOR'));
  if (!anchor || anchor.prescribedMotion.speedMps !== 0) {
    throw new Error('wake evidence is missing its exact zero-speed control');
  }
  for (const sample of anchor.sourceSeries) {
    const injection = sample.trailInjection;
    if (
      injection.sourceEnabled ||
      injection.activeFoamRatePerSecond !== 0 ||
      injection.residualFoamRatePerSecond !== 0 ||
      injection.turbulenceRatePerSecond !== 0
    ) {
      throw new Error('zero-speed control produced WK1 stern injection');
    }
    const bow = sample.bowInjection;
    if (
      bow.sourceEnabled ||
      bow.collarDrive !== 0 ||
      bow.activeFoamRatePerSecond !== 0 ||
      bow.residualFoamRatePerSecond !== 0 ||
      bow.turbulenceRatePerSecond !== 0
    ) {
      throw new Error('zero-speed control produced WK2 bow injection');
    }
    if (sample.wetHullBand.profileSampleCount < 2) {
      throw new Error('zero-speed control lost the resolved wet-hull profile');
    }
  }
  if (
    evidence.bowCollarStrengthCurve.length < 6 ||
    evidence.bowCollarStrengthCurve[0].collarDrive !== 0 ||
    evidence.bowCollarStrengthCurve.at(-1).collarDrive !== 1
  ) {
    throw new Error('WK2 bow collar strength curve lacks onset/saturation controls');
  }
  for (const reference of evidence.polarReferences) {
    if (!(reference.speedMps > 0)) {
      throw new Error(`${reference.seaStateName} polar did not make way`);
    }
  }
  for (const entry of evidence.cases) {
    if (entry.sourceSeries.length < 2) {
      throw new Error(`${entry.name} did not record a source time series`);
    }
    for (const sample of entry.sourceSeries) {
      if (sample.bowWaterline.pointCount > 78) {
        throw new Error(`${entry.name} exceeded the contact-side capacity`);
      }
      if (sample.bowInjection.waterlineStationCount > 13) {
        throw new Error(`${entry.name} exceeded the waterline polyline budget`);
      }
    }
    if (
      entry.prescribedMotion.speedMps > 0 &&
      !entry.sourceSeries.some((sample) => sample.trailInjection.sourceEnabled)
    ) {
      throw new Error(`${entry.name} never produced a complete WK1 stern source`);
    }
    if (
      entry.prescribedMotion.speedMps > 0.8 &&
      !entry.sourceSeries.some((sample) => sample.bowInjection.sourceEnabled)
    ) {
      throw new Error(`${entry.name} never produced a live WK2 bow collar source`);
    }
    if (
      entry.prescribedMotion.speedMps > 0.8 &&
      !entry.sourceSeries.every(
        (sample) => sample.bowInjection.waterlineStationCount === 13,
      )
    ) {
      throw new Error(`${entry.name} lost the 13-station hull-side polylines`);
    }
  }
  visitNumbers(evidence);
}

/**
 * WK3's gates, as assertions on the record rather than as prose in a handover.
 *
 * Every one of these is an inequality, which is exactly what the thirty-one
 * `toContain` checks on `Ocean.ts` could not see while an earlier round was
 * cutting the bow crest at its steepest point.
 */
function validateSprayEvidence(evidence) {
  if (evidence.formatVersion !== 1) {
    throw new Error(`unexpected spray evidence version ${evidence.formatVersion}`);
  }

  const anchor = evidence.cases.find((entry) => entry.name.endsWith('_ANCHOR'));
  if (!anchor) throw new Error('spray evidence is missing its anchored control');
  if (anchor.speedMps !== 0) {
    throw new Error('the anchored control made way');
  }
  if (anchor.sprayEvents.tears !== 0 || anchor.sprayEvents.dropletsShed !== 0) {
    throw new Error('WK0-F1 regression: the anchored bow threw spray');
  }
  // And it must be a real test rather than a becalmed one: the bow has to have
  // been working hard while nothing fired.
  if (!(anchor.sprayEvents.peakBowImmersionRateM3PerSec > 5)) {
    throw new Error('the anchored control did not exercise the bow at all');
  }

  const glassy = evidence.cases.find((entry) =>
    entry.name.startsWith('GLASSY_LONG_SWELL'),
  );
  if (!glassy || glassy.sprayEvents.tears !== 0) {
    throw new Error('a glassy long swell produced entry spray');
  }

  for (const entry of evidence.cases) {
    const spray = entry.sprayEvents;
    if (spray.tearsPerSecond > spray.ceilingPerSecond) {
      throw new Error(
        `${entry.name} exceeded its event ceiling: ${spray.tearsPerSecond}/s > ${spray.ceilingPerSecond}/s`,
      );
    }
    if (spray.dropletsPerSecond > spray.dropletCeilingPerSecond) {
      throw new Error(
        `${entry.name} exceeded the sustained droplet ceiling: ${spray.dropletsPerSecond}/s`,
      );
    }
  }

  // MONOTONICITY, IN THE TWO SENSES IT HAS
  // --------------------------------------
  // The rate *function* is monotone and that is checked densely, on the drive's
  // p95: 5 400 samples a case, and it moves smoothly with speed.
  //
  // The sampled event *rate* is a realisation of a stochastic process, and at
  // this sweep's rates a ninety-second window holds single figures. Requiring
  // it to be strictly non-decreasing is requiring a coin to come up heads in
  // order — the first run of this gate failed at 2.5 m/s with a count of 0
  // against 2.0 m/s's count of 1, which is noise and nothing else. So the
  // sampled rate is allowed to slip by one event, and the ends still have to
  // separate properly.
  const sweep = evidence.moderateSpeedSweep;
  const table = sweep
    .map(
      (point) =>
        `${point.speedMps}m/s=${point.tearsPerSecond.toFixed(3)}/s(p95 ${point.p95Drive.toFixed(3)})`,
    )
    .join('  ');
  const oneEventPerSecond = 1 / evidence.configuration.sweepMeasurementSeconds;

  let previousP95 = -Infinity;
  let highWaterRate = -Infinity;
  for (const point of sweep) {
    if (point.p95Drive < previousP95) {
      throw new Error(
        `the entry drive fell with speed at ${point.speedMps} m/s — the rate function is not monotone: ${table}`,
      );
    }
    previousP95 = point.p95Drive;

    if (point.tearsPerSecond < highWaterRate - oneEventPerSecond) {
      throw new Error(
        `spray rate fell by more than one event at ${point.speedMps} m/s: ${table}`,
      );
    }
    highWaterRate = Math.max(highWaterRate, point.tearsPerSecond);
  }

  // Below the way gate's onset nothing may fire at all, however the bow is
  // working — this is WK0-F1 again, at every speed rather than only at zero.
  for (const point of sweep) {
    if (point.speedMps <= evidence.policy.wayOnsetMps && point.tearsPerSecond !== 0) {
      throw new Error(
        `the speed sweep fired below the way onset at ${point.speedMps} m/s: ${table}`,
      );
    }
  }
  const fastest = sweep[sweep.length - 1];
  if (!(fastest.tearsPerSecond > 0)) {
    throw new Error(`the speed sweep never fires at all: ${table}`);
  }
  // And it must genuinely rise rather than merely being non-decreasing noise.
  const slowHalf = sweep.slice(0, Math.floor(sweep.length / 2));
  const slowestRate = Math.max(...slowHalf.map((point) => point.tearsPerSecond));
  if (!(fastest.tearsPerSecond > slowestRate)) {
    throw new Error(`the speed sweep does not rise with speed: ${table}`);
  }

  const sizing = evidence.cases.find((entry) => entry.name.endsWith('_SIZING'));
  if (!sizing) throw new Error('spray evidence is missing its overtop sizing case');
  if (!(sizing.overtopping.eventSamples > 0)) {
    throw new Error('the sizing case did not overtop, so it sizes nothing');
  }
  if (!(sizing.overtopping.cue.drawnSamples > 0)) {
    throw new Error('the sizing case overtopped but the cue drew nothing');
  }

  visitNumbers(evidence, 'sprayEvidence');
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
  // Keep disposable transform state in the checkout, not inside node_modules.
  // Agent worktrees may share a read-only dependency tree with the primary
  // checkout; evidence generation must not need to mutate that shared install.
  cacheDir: resolve('dist/.vite-ship-wake'),
  appType: 'custom',
  logLevel: 'error',
  ssr: { noExternal: ['geographiclib-geodesic'] },
  server: { middlewareMode: true, ws: false },
});

try {
  const wake = await server.ssrLoadModule(
    '/src/vessel/schooner/WakeSourcesEvidence.ts',
  );
  const evidence = wake.buildWakeContactEvidence({
    onProgress(message) {
      process.stdout.write(`${message}\n`);
    },
  });
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const entry of evidence.cases) {
    process.stdout.write(
      `${entry.name}: ${entry.prescribedMotion.speedMps.toFixed(2)} m/s, ` +
        `bow p95 ${entry.entrySpeeds.bow.p95Mps?.toFixed(3) ?? 'n/a'} m/s, ` +
        `${entry.overtopping.eventSamples} overtop samples\n`,
    );
  }

  const sprayEvidence = wake.buildWakeSprayEvidence({
    onProgress(message) {
      process.stdout.write(`${message}\n`);
    },
  });
  validateSprayEvidence(sprayEvidence);
  writeJsonAtomically(sprayOutputPath, sprayEvidence);
  process.stdout.write(`wrote ${sprayOutputPath}\n`);
  for (const entry of sprayEvidence.cases) {
    const spray = entry.sprayEvents;
    process.stdout.write(
      `${entry.name}: ${entry.speedMps.toFixed(2)} m/s at ` +
        `${entry.windAngleOffBowDeg}deg, arm ${spray.armThreshold.toFixed(2)}, ` +
        `${spray.tears} tears (${spray.tearsPerSecond.toFixed(3)}/s of ` +
        `${spray.ceilingPerSecond.toFixed(3)}/s), ` +
        `${spray.dropletsPerSecond.toFixed(1)} droplets/s, ` +
        `overtop ${entry.overtopping.eventSamples} samples / ` +
        `${entry.overtopping.cue.drawnSamples} drawn\n`,
    );
  }
  process.stdout.write(
    `speed sweep (CURRENT_MODERATE): ${sprayEvidence.moderateSpeedSweep
      .map((point) => `${point.speedMps}=${point.tearsPerSecond.toFixed(3)}/s`)
      .join('  ')}\n`,
  );
} finally {
  await server.close();
}
