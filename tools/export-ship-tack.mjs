/**
 * Regenerate the committed tack/gybe maneuver evidence.
 *
 *   npm run ship:tack
 *
 * S6c — THE COEFFICIENT ROUND REVERSED HALF THE GATES IN THIS FILE, and
 * every reversal below is written out with the measurement that forced it.
 * Two directions at once:
 *
 * - the IRONS gates flipped toward success. An aback sail carries lift now
 *   (FINDING S4-2, closed), so backing a headsail is a technique that
 *   works and all five escape cases free her. The S4 gates asserted the
 *   limitation and told whoever landed the branch to come here and say so
 *   deliberately. This is that.
 * - the TACK completion gates flipped toward failure. The scripted tack
 *   crosses the eye on every with-way entry and then hangs at 21–33° on
 *   the new bow — S3's ±34° attractor, back, because induced drag prices
 *   the hard-sheeted lift S4 got for free. The CREW still tack:
 *   `ship:voyage` beats to windward with three ordered and three
 *   completed. The stale instrument is this fixed-angle script.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer } from 'vite';

globalThis.window = globalThis;

const outputPath = resolve('evidence/ship-sailing/tack-baseline.json');

function validateEvidence(evidence) {
  const gates = evidence.gates;
  // --- the tack (S6c: the S4 success gate reversed) ---------------------
  // What survived: she carries way THROUGH the wind, on every entry. That
  // was the substance of S4's win and it is still true — but only because
  // the tacks now hand the square topsail first. With it set and aback,
  // measured, no entry reached the eye at all.
  if (!gates.everyWithWayEntryCrossesEye) {
    throw new Error(
      'a with-way entry failed to carry through the eye — the half of the ' +
        'S4 tack win that survived S6c has now gone too',
    );
  }
  const [eyeLow, eyeHigh] = gates.eyeCrossSpeedBandMps;
  if (!(eyeLow > 0.8 && eyeHigh < 2.5)) {
    throw new Error(
      `eye-crossing speed band ${eyeLow}-${eyeHigh} m/s left 0.8-2.5`,
    );
  }
  // What did NOT survive, gated in the direction that is now TRUE. If this
  // ever completes again, someone has changed the maneuver script or the
  // coefficients and must come here and say which.
  if (gates.classicTackCompletesAtAnyEntry !== false) {
    throw new Error(
      'the scripted tack completed again. Since S6c it is expected NOT to: ' +
        'induced drag means the flat maneuvering trims cannot drive her out ' +
        'to a close-hauled groove that moved to 55-60°. If this is a real ' +
        'improvement, say so here deliberately and update the gate',
    );
  }
  if (gates.everyWithWayEntryCompletes !== false) {
    throw new Error('every with-way entry completed — see the gate above');
  }
  // The attractor she hangs in, on the FAR side of the eye. S3 measured
  // 34.0-34.9° on the near side; S6c measures 21.0-32.6° on the far side.
  // Bounded so a drift in either direction is visible.
  if (gates.captureAngleBandDeg === null) {
    throw new Error(
      'no with-way entry was captured — either the tack completes again ' +
        '(see above) or the capture measurement has broken',
    );
  }
  const [captureLow, captureHigh] = gates.captureAngleBandDeg;
  if (!(captureLow > 10 && captureHigh < 42)) {
    throw new Error(
      `capture band ${captureLow}-${captureHigh}° left the 10-42° window: ` +
        'below 10° she never really came round, above 42° she completed',
    );
  }
  // She must still carry SOME way through the whole evolution — the bound
  // moved from S4's 0.5 m/s because she is genuinely slower everywhere now
  // (the beam entry touches 0.19 m/s), but zero would mean a dead stop.
  for (const t of evidence.tacks.slice(0, 3)) {
    if (!(t.minSpeedMps > 0.05)) {
      throw new Error(`she stopped dead in stays: ${t.minSpeedMps} m/s`);
    }
  }
  if (!gates.lowWayFailsBeforeEye) {
    throw new Error('the from-rest order reached the eye; it must not');
  }
  if (!(gates.maxEnergyOverWorkJ <= 1e-6)) {
    throw new Error(`energy gate violated: ${gates.maxEnergyOverWorkJ} J`);
  }
  // --- the gybe: unchanged, and it still works --------------------------
  if (!gates.gybeCompleted) {
    throw new Error('the gybe failed to complete');
  }
  if (!(gates.gybeMaxYawRateRadPerS < 0.15)) {
    throw new Error(`gybe yaw rate spiked: ${gates.gybeMaxYawRateRadPerS}`);
  }
  // --- caught in irons: FINDING S4-2 CLOSED, all five gates reversed ----
  if (gates.ironsSternBoardEscapes !== true) {
    throw new Error('she can no longer stern-board out of irons');
  }
  if (!(gates.ironsSternBoardPayOffS > 0 && gates.ironsSternBoardPayOffS < 150)) {
    throw new Error(
      `stern-board escape took ${gates.ironsSternBoardPayOffS}s (bound 150)`,
    );
  }
  // THE REVERSAL S4 ASKED FOR IN WRITING. Its gate read "if this ever
  // flips, someone has added the aback branch and must come here and say
  // so deliberately". The branch is added; backing a headsail frees her in
  // 48.4 s where she used to be pinned at -18.8° for the full timeout.
  if (gates.ironsBackedHeadsailAloneEscapes !== true) {
    throw new Error(
      'a backed headsail no longer frees her from irons — the S6c aback ' +
        'lift branch has regressed to the v1 carries-no-lift simplification',
    );
  }
  // Still negative, and still worth knowing: backing a sail AND putting the
  // helm over is not twice as good as either. The backed cloth's drag holds
  // her sternway down, and sternway is what makes the reversed blade bite.
  if (!(gates.ironsBackedHeadsailSecondsSaved < 5)) {
    throw new Error(
      `the backed headsail now dominates the helm ` +
        `(${gates.ironsBackedHeadsailSecondsSaved}s saved) — re-examine`,
    );
  }
  // She frees herself unaided in 44 s where S4 measured 229 s. That is no
  // longer "stuck", so the gate cannot assert stuck-ness; it asserts that
  // the unaided escape is not INSTANT, because a ship that falls off the
  // moment she is head to wind was never in irons.
  if (!(gates.ironsDriftPayOffS !== null && gates.ironsDriftPayOffS > 20)) {
    throw new Error(
      `she drifts out of irons in ${gates.ironsDriftPayOffS}s — that is not ` +
        'being caught at all',
    );
  }
  // The toward-sheets attractor S4 found at ~20° is GONE: falling off that
  // way is slower (64.1 s against 48.0 s) but no longer hopeless. Gated
  // null so its return is loud.
  if (gates.ironsTowardSheetsAttractorDeg !== null) {
    throw new Error(
      'the toward-sheets in-irons attractor is back at ' +
        `${gates.ironsTowardSheetsAttractorDeg}° — S6c measured it gone`,
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
  const evidence = steering.buildShipTackEvidence();
  validateEvidence(evidence);
  writeJsonAtomically(outputPath, evidence);
  process.stdout.write(`wrote ${outputPath}\n`);
  for (const t of evidence.tacks) {
    process.stdout.write(
      `tack ${t.windSpeedMps} m/s from ${t.entryAngleDeg}° at ` +
        `${t.entrySpeedMps} m/s: ` +
        (t.completed
          ? `completed in ${t.timeToCompleteS}s\n`
          : `captured at ${t.captureAngleDeg}°\n`),
    );
  }
  process.stdout.write(
    `gybe: completed in ${evidence.gybe.timeToCompleteS}s, ` +
      `transit ${evidence.gybe.transitSeconds}s\n`,
  );
  for (const escape of evidence.ironsEscapes) {
    process.stdout.write(
      `irons ${escape.method} (${escape.backedToward}): ` +
        (escape.escaped
          ? `free in ${escape.timeToPayOffS}s, fell off to ${escape.fellOffToward}\n`
          : `STUCK, pinned at ${escape.settledAngleDeg}°\n`),
    );
  }
} finally {
  await server.close();
}
