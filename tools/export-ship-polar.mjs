/**
 * Regenerate the committed polar evidence (S6c coefficient round).
 *
 *   npm run ship:polar
 *
 * Three-unknown captive balance per point — speed, leeway, rudder-to-hold-
 * course — with every probe trimmed to draw for its own apparent wind. Very
 * slow by design: thousands of captive settles.
 *
 * S4's equal-or-better gate against the frozen-trim file is GONE, and its
 * removal is the point of the round rather than a convenience. Induced drag,
 * aback lift and a live camber make her genuinely slower upwind, so a gate
 * that forbade any point from getting slower would have had to be either
 * disabled or lied to. What replaces it is a *printed* point-by-point
 * comparison against whatever is already committed, so the A/B table falls
 * out of the run and a human decides what it means.
 */
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

// The packaged GeographicLib build is a browser-shaped UMD bundle even when
// Vite evaluates it for this headless evidence runner.
globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/polar-baseline.json');

function validateEvidence(evidence) {
  const gates = evidence.gates;
  if (evidence.formatVersion !== 4) {
    throw new Error(`unexpected polar format version ${evidence.formatVersion}`);
  }
  if (!(gates.noGoMaxSpeedMps < 0.3)) {
    throw new Error(
      `the no-go zone is alive: ${gates.noGoMaxSpeedMps} m/s inside 30°`,
    );
  }
  // S6c: the pointing limit is now a property of the aerodynamics, so it is
  // gated in BOTH directions. Too high and she cannot beat at all; too low
  // and the induced-drag term has gone missing again and we are back to a
  // gaff schooner pointing like a modern sloop (FINDING S4-1).
  if (gates.closeHauledAngleDeg === null) {
    throw new Error('no sheet reached its sailing sector at any angle');
  }
  if (!(gates.closeHauledAngleDeg >= 45 && gates.closeHauledAngleDeg <= 75)) {
    throw new Error(
      `close-hauled angle ${gates.closeHauledAngleDeg}° is outside 45-75°: ` +
        'either she cannot beat, or the rig has lost its pointing limit',
    );
  }
  if (gates.sailingSectorLeewaySaturated) {
    throw new Error(
      'a point inside the sailing sector ran the leeway search to its ' +
        'bound — that is the solver reporting its box, not a drift angle',
    );
  }
  if (!gates.reachBeatsRunEverySheet) {
    throw new Error('a sheet ran fastest dead downwind; reaches must win');
  }
  if (!(gates.maxSpeedAnySheetMps <= gates.hullSpeedBoundMps)) {
    throw new Error(
      `${gates.maxSpeedAnySheetMps} m/s beats the hull-speed bound ` +
        `${gates.hullSpeedBoundMps}`,
    );
  }
  if (!(gates.mirrorMaxSpeedErrorMps < 0.02)) {
    throw new Error(
      `tack mirror speed error ${gates.mirrorMaxSpeedErrorMps} m/s exceeds ` +
        'the centre-of-mass asymmetry allowance',
    );
  }
  const [heelLow, heelHigh] = gates.heelBandDeg;
  if (
    !(gates.fullSailHeelAt12Deg >= heelLow && gates.fullSailHeelAt12Deg <= heelHigh)
  ) {
    throw new Error(
      `full-sail heel at 12 m/s is ${gates.fullSailHeelAt12Deg}°, outside ` +
        `the ${heelLow}-${heelHigh}° band`,
    );
  }
  if (!(gates.maxLeewayDeg <= 15)) {
    throw new Error(`leeway ${gates.maxLeewayDeg}° exceeds the sane bound`);
  }
  if (!(gates.maxAbsBalanceRudderDeg <= 12)) {
    throw new Error(
      `helm to hold course reached ${gates.maxAbsBalanceRudderDeg}°— ` +
        'tens, not the few degrees the design demands',
    );
  }
  for (const sheet of evidence.sheets) {
    for (const point of sheet.points) {
      const values = [
        point.steadySpeedMps,
        point.steadyHeelDeg,
        point.leewayDeg,
        point.residuals.surgeN,
        point.residuals.swayN,
        point.residuals.yawNm,
        point.driveAtRestN,
      ];
      if (values.some((value) => !Number.isFinite(value))) {
        throw new Error(
          `non-finite polar point at ${point.windAngleOffBowDeg}° ` +
            `(${sheet.windSpeedMps} m/s ${sheet.canvas})`,
        );
      }
      // Steady speed must never exceed the search ceiling minus resolution.
      if (point.steadySpeedMps > 6.4) {
        throw new Error('a polar solve saturated its search bound');
      }
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
  const polar = await server.ssrLoadModule(
    '/src/vessel/schooner/SailingPolarEvidence.ts',
  );
  // Whatever is committed, read BEFORE overwriting, purely so the run can
  // print what moved. Nothing is gated on it.
  const previous = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, 'utf8'))
    : null;
  const evidence = polar.buildSailingPolarEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const sheet of evidence.sheets) {
    process.stdout.write(
      `${sheet.windSpeedMps} m/s ${sheet.canvas}: best ${sheet.bestSpeedMps} m/s ` +
        `at ${sheet.bestAngleDeg}°, max heel ${sheet.maxHeelDeg}°, ` +
        `close-hauled ${sheet.closeHauledAngleDeg}°\n`,
    );
  }
  if (previous) {
    process.stdout.write(
      `\nspeed against the committed v${previous.formatVersion} file, m/s:\n`,
    );
    for (const sheet of evidence.sheets) {
      const before = previous.sheets.find(
        (s) => s.windSpeedMps === sheet.windSpeedMps && s.canvas === sheet.canvas,
      );
      if (!before) {
        process.stdout.write(
          `  ${sheet.windSpeedMps} ${sheet.canvas}: NEW SHEET\n`,
        );
        continue;
      }
      const row = sheet.points
        .map((point) => {
          const was = before.points.find(
            (p) => p.windAngleOffBowDeg === point.windAngleOffBowDeg,
          );
          if (!was) return `${point.windAngleOffBowDeg}:new`;
          const delta = point.steadySpeedMps - was.steadySpeedMps;
          return (
            `${point.windAngleOffBowDeg}:${was.steadySpeedMps.toFixed(2)}` +
            `->${point.steadySpeedMps.toFixed(2)}(${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`
          );
        })
        .join(' ');
      process.stdout.write(`  ${sheet.windSpeedMps} ${sheet.canvas}: ${row}\n`);
    }
  }
} finally {
  await server.close();
}
