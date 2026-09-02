/**
 * Compare the production passive horizontal release to the committed 4 m/s
 * captive response over the same eight CURRENT_MODERATE headings.
 *
 *   npm run ship:dynamics:response
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const baselinePath = resolve(
  'evidence/ship-response/prescribed-speed-baseline.json',
);
const outputPath = resolve(
  'evidence/ship-dynamics/wave-response-comparison.json',
);

function round(value, digits = 6) {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function relativePercent(dynamic, captive) {
  return round(
    ((dynamic - captive) / Math.max(Math.abs(captive), 1e-9)) * 100,
  );
}

function validateCaptiveConfiguration(evidence, baseline) {
  const free = evidence.configuration;
  const captive = baseline.configuration;
  const sameHeadings =
    JSON.stringify(captive?.headingsDeg) === JSON.stringify(free.headingsDeg);
  const sameSeaState =
    captive?.seaStates?.length === 1 &&
    captive.seaStates[0] === free.seaStateName;
  const sameScalarConfiguration =
    captive?.speedThroughWaterMps === free.initialSpeedMps &&
    captive?.warmupSeconds === free.warmupSeconds &&
    captive?.measurementSeconds === free.measurementSeconds &&
    captive?.callerHz === free.callerHz &&
    captive?.physicsHz === free.physicsHz;
  if (!sameHeadings || !sameSeaState || !sameScalarConfiguration) {
    throw new Error(
      'captive baseline configuration no longer matches the free-release comparison',
    );
  }
}

const metrics = {
  heaveRms: (result) => result.motion.heaveDisplacementMetres.rms,
  rollRms: (result) => result.motion.rollDeg.rms,
  rollPeak: (result) => result.motion.rollDeg.peakAbsolute,
  pitchRms: (result) => result.motion.pitchDeg.rms,
  pitchPeak: (result) => result.motion.pitchDeg.peakAbsolute,
  verticalAccelerationPeak: (result) =>
    result.motion.verticalAccelerationMps2.peakAbsolute,
};

function compareToCaptive(evidence, baseline) {
  const baselineByHeading = new Map(
    baseline.cases.map((result) => [result.presentationHeadingDeg, result]),
  );
  const cases = evidence.cases.map((dynamic) => {
    const captive = baselineByHeading.get(dynamic.presentationHeadingDeg);
    if (!captive || captive.seaState !== dynamic.seaState) {
      throw new Error(
        `missing captive baseline for ${dynamic.seaState} heading ` +
          `${dynamic.presentationHeadingDeg}`,
      );
    }
    const selectedMetrics = {};
    for (const [name, read] of Object.entries(metrics)) {
      const freeRelease = read(dynamic);
      const captiveValue = read(captive);
      selectedMetrics[name] = {
        captive: captiveValue,
        freeRelease,
        changePercent: relativePercent(freeRelease, captiveValue),
      };
    }
    return {
      seaState: dynamic.seaState,
      presentationHeadingDeg: dynamic.presentationHeadingDeg,
      selectedMetrics,
    };
  });
  const largestAbsoluteChangePercent = {};
  for (const name of Object.keys(metrics)) {
    let selected = cases[0];
    for (const candidate of cases.slice(1)) {
      if (
        Math.abs(candidate.selectedMetrics[name].changePercent) >
        Math.abs(selected.selectedMetrics[name].changePercent)
      ) {
        selected = candidate;
      }
    }
    largestAbsoluteChangePercent[name] = {
      seaState: selected.seaState,
      presentationHeadingDeg: selected.presentationHeadingDeg,
      changePercent: selected.selectedMetrics[name].changePercent,
    };
  }
  return {
    source: 'evidence/ship-response/prescribed-speed-baseline.json',
    sourceFormatVersion: baseline.formatVersion,
    meaning:
      'Captive prescribes 4 m/s and heading. Free release begins at the same condition, then integrates passive surge, sway and yaw without propulsion or steering.',
    largestAbsoluteChangePercent,
    cases,
  };
}

function horizontalSummary(evidence) {
  const select = (read, mode) => {
    let chosen = evidence.cases[0];
    for (const candidate of evidence.cases.slice(1)) {
      if (
        (mode === 'min' && read(candidate) < read(chosen)) ||
        (mode === 'max' && read(candidate) > read(chosen))
      ) {
        chosen = candidate;
      }
    }
    return {
      presentationHeadingDeg: chosen.presentationHeadingDeg,
      value: round(read(chosen)),
    };
  };
  return {
    lowestEndSpeedMps: select(
      (result) => result.horizontal.endSpeedMps,
      'min',
    ),
    largestPeakPortSpeedMps: select(
      (result) => result.horizontal.portSpeedMps.peakAbsolute,
      'max',
    ),
    largestPeakYawChangeDeg: select(
      (result) => result.horizontal.yawChangeDeg.peakAbsolute,
      'max',
    ),
    largestPeakYawRateDegPerSecond: select(
      (result) => result.horizontal.yawRateDegPerSecond.peakAbsolute,
      'max',
    ),
  };
}

function validate(evidence, comparison) {
  const config = evidence.configuration;
  if (
    evidence.cases.length !== config.headingsDeg.length ||
    comparison.cases.length !== config.headingsDeg.length
  ) {
    throw new Error('free-release comparison is incomplete');
  }
  for (const result of evidence.cases) {
    if (!(result.horizontal.endSpeedMps < config.initialSpeedMps)) {
      throw new Error(
        `heading ${result.presentationHeadingDeg} did not coast below release speed`,
      );
    }
    if (result.contact.touchedSafetyLimiter) {
      throw new Error(
        `heading ${result.presentationHeadingDeg} touched a safety limiter`,
      );
    }
    if (result.maxWaveInverseSolveResidualMetres > 1e-6) {
      throw new Error(
        `heading ${result.presentationHeadingDeg} inverse residual exceeded 1e-6 m`,
      );
    }
    const values = [
      result.horizontal.endSpeedMps,
      result.horizontal.endForwardSpeedMps,
      result.horizontal.endPortSpeedMps,
      result.horizontal.endYawChangeDeg,
      result.horizontal.endYawRateDegPerSecond,
      ...Object.values(result.motion).flatMap(Object.values),
      ...Object.values(result.horizontal)
        .filter((value) => typeof value === 'object' && 'rms' in value)
        .flatMap(Object.values),
    ];
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(
        `heading ${result.presentationHeadingDeg} contains a non-finite metric`,
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
  const response = await server.ssrLoadModule(
    '/src/vessel/schooner/SchoonerHorizontalResponseEvidence.ts',
  );
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const started = Date.now();
  const evidence = response.buildSchoonerHorizontalResponseEvidence({
    onCaseComplete(completed, total, result) {
      const elapsedSeconds = (Date.now() - started) / 1000;
      const remainingMinutes =
        ((elapsedSeconds / completed) * (total - completed)) / 60;
      process.stdout.write(
        `[${completed}/${total}] heading ` +
          `${String(result.presentationHeadingDeg).padStart(3)} degrees, ` +
          `end speed ${result.horizontal.endSpeedMps.toFixed(3)} m/s, ` +
          `yaw change ${result.horizontal.endYawChangeDeg.toFixed(2)} degrees, ` +
          `~${remainingMinutes.toFixed(1)} min left\n`,
      );
    },
  });
  validateCaptiveConfiguration(evidence, baseline);
  const comparison = compareToCaptive(evidence, baseline);
  const summary = horizontalSummary(evidence);
  validate(evidence, comparison);
  const output = {
    ...evidence,
    horizontalSummary: summary,
    comparisonToPrescribedBaseline: comparison,
  };
  writeJsonAtomically(outputPath, output);

  process.stdout.write(
    `wrote ${outputPath} (${evidence.cases.length} free-release cases, ` +
      `${((Date.now() - started) / 60_000).toFixed(1)} min)\n`,
  );
  for (const [name, extreme] of Object.entries(
    comparison.largestAbsoluteChangePercent,
  )) {
    process.stdout.write(
      `${name}: ${extreme.changePercent >= 0 ? '+' : ''}` +
        `${extreme.changePercent.toFixed(2)}% at ` +
        `${extreme.presentationHeadingDeg} degrees\n`,
    );
  }
} finally {
  await server.close();
}
