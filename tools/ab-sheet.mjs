/**
 * Paired A/B contact sheets, from the command line, at an asserted render tier.
 *
 *   node tools/ab-sheet.mjs --list
 *   node tools/ab-sheet.mjs --switch oceanTaa --scene sunElevationDeg=38
 *   node tools/ab-sheet.mjs --switch shoulder --arm 0.8 --arm 0.7 --verify
 *
 * WHAT IT GUARANTEES
 * ------------------
 * Both arms are photographed at the same tier, the same framebuffer size, the
 * same exposure and the same simulation state, and the capture FAILS rather
 * than producing a picture when any of that is untrue. See
 * `src/render/renderTier.ts` for the contract and `src/debug/captureHost.ts`
 * for why a capture read outside its own render task comes back black.
 *
 * TWO SHAPES OF SWITCH
 * --------------------
 * A `live` switch moves a uniform or a cache key, so both arms are flipped
 * between two renders of ONE frozen state in ONE page: literally the same
 * water, the same instant, the same eye.
 *
 * A `reload` switch changes shader source text, which three's program cache is
 * not keyed on — flipping it in place would leave compiled programs running
 * the old code. Those get one page per arm, loaded concurrently, staged to the
 * identical scene, and interleaved SHOT BY SHOT across the pages rather than
 * photographed as two sequential blocks. Same doctrine as the perf harness's
 * alternating pairs, and for the same reason: a machine that drifts between
 * two long blocks puts its drift in the answer.
 *
 * OPTIONS
 *   --list                 print the switch registry and exit
 *   --switch <name>        the switch to photograph
 *   --arm <value>          an arm; repeatable; defaults to the switch's own
 *   --scene <k=v,k=v>      a scene; repeatable; keys are CaptureSceneSpec fields
 *   --tier desktop|mobile  render tier to demand (default desktop)
 *   --width/--height       capture size in CSS pixels (default 1280x720)
 *   --dpr <n>              device pixel ratio (default 2)
 *   --repeats <n>          alternating passes over the arms (default 1)
 *   --terrain on|off       mount the synthetic land (default off, so an
 *                          open-water look question is not answering a
 *                          terrain question by accident)
 *   --param <k=v>          any other URL parameter, repeatable — e.g.
 *                          `--param fixture=mountain --param range=3000` to
 *                          put a real landmass in frame. Rejected if it would
 *                          overwrite one the capture contract owns.
 *   --diff <gain>          add an amplified difference panel per scene, so a
 *                          change that is real but small is visible at all
 *                          (8 is a good start; two arms and one pass only)
 *   --verify               re-shoot arm 1 and measure the drift; for a page-load
 *                          switch, also open a third page at the same arm to
 *                          measure the cross-page floor the A/B must clear
 *   --out <dir>            output directory (default evidence/ab/<switch>-<stamp>)
 *   --server <url>         attach to a running dev server instead of spawning
 *   --chrome <path>        Chrome executable
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CHROME,
  PROJECT_ROOT,
  launchHeadlessPage,
  startViteServer,
} from './headless.mjs';

/** Scene fields that are numbers; everything else is passed through as text. */
const NUMERIC_SCENE_KEYS = new Set([
  'waveTimeSeconds',
  'sunElevationDeg',
  'lookYawDeg',
  'lookBearingDeg',
  'lookPitchDeg',
  'cinematicScale',
  'originX',
  'originZ',
  'cloudWarmFrames',
  'trueWindAngleDeg',
  'dayOfYear',
]);

function parseArguments(argv) {
  const options = {
    list: false,
    switchName: null,
    arms: [],
    scenes: [],
    tier: 'desktop',
    width: 1280,
    height: 720,
    dpr: 2,
    repeats: 1,
    verify: false,
    diffGain: 0,
    terrain: 'off',
    params: {},
    out: null,
    server: null,
    chrome: DEFAULT_CHROME,
  };
  for (let i = 2; i < argv.length; i++) {
    const argument = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${argument} needs a value`);
      return argv[++i];
    };
    if (argument === '--list') options.list = true;
    else if (argument === '--switch') options.switchName = next();
    else if (argument === '--arm') options.arms.push(next());
    else if (argument === '--scene') options.scenes.push(parseScene(next()));
    else if (argument === '--tier') options.tier = next();
    else if (argument === '--width') options.width = Number(next());
    else if (argument === '--height') options.height = Number(next());
    else if (argument === '--dpr') options.dpr = Number(next());
    else if (argument === '--repeats') options.repeats = Number(next());
    else if (argument === '--verify') options.verify = true;
    else if (argument === '--diff') options.diffGain = Number(next());
    else if (argument === '--terrain') options.terrain = next();
    else if (argument === '--param') {
      const pair = next();
      const index = pair.indexOf('=');
      if (index < 0) throw new Error(`--param wants k=v, got '${pair}'`);
      options.params[pair.slice(0, index)] = pair.slice(index + 1);
    }
    else if (argument === '--out') options.out = path.resolve(next());
    else if (argument === '--server') options.server = next();
    else if (argument === '--chrome') options.chrome = path.resolve(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.tier !== 'desktop' && options.tier !== 'mobile') {
    throw new Error(`--tier wants desktop | mobile, got ${options.tier}`);
  }
  if (!options.list && !options.switchName) {
    throw new Error('--switch is required (or --list to see what exists)');
  }
  return options;
}

function parseScene(raw) {
  const scene = {};
  for (const pair of raw.split(',')) {
    const index = pair.indexOf('=');
    if (index < 0) throw new Error(`--scene wants k=v pairs, got '${pair}'`);
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    scene[key] = NUMERIC_SCENE_KEYS.has(key) ? Number(value) : value;
  }
  return scene;
}

/** The base query every capture page carries. */
/** Parameters the capture contract owns; `--param` may not touch them. */
const RESERVED_PARAMS = new Set(['capture', 'quality', 'fixedDpr', 'terrain']);

function captureQuery(tier, dpr, extra = {}, terrain = 'off', extraParams = {}) {
  const query = new URLSearchParams({
    capture: '1',
    quality: tier,
    // A fixed ratio is what actually disables the adaptive-resolution walk in
    // `BrowserFrameDriver`; the capture host also detaches the loop, but the
    // tier assertion wants both belts.
    fixedDpr: String(dpr),
    terrain: terrain === 'on' ? 'synthetic' : 'off',
  });
  for (const [key, value] of Object.entries(extraParams)) {
    if (RESERVED_PARAMS.has(key)) {
      throw new Error(
        `--param ${key}= would overwrite a parameter the capture contract ` +
          `owns; use the dedicated flag instead`,
      );
    }
    query.set(key, value);
  }
  // The arm last, so nothing can shadow it.
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

async function openCapturePage({ serverUrl, query, chrome, logs, tag }) {
  const page = await launchHeadlessPage({
    serverUrl,
    query,
    chromePath: chrome,
    logs,
    tag,
  });
  await page.waitFor('window.__driftCapture?.ready === true');
  return page;
}

const surfaceLiteral = (options) =>
  JSON.stringify({
    tier: options.tier,
    cssWidth: options.width,
    cssHeight: options.height,
    pixelRatio: options.dpr,
  });

async function main() {
  const options = parseArguments(process.argv);
  const logs = [];
  const servers = [];
  const pages = [];

  try {
    const vite = await startViteServer(options.server, logs);
    if (vite.process) servers.push(vite.process);

    // --- the registry --------------------------------------------------------
    // Read from the running app rather than reimplemented here: the switch
    // table has exactly one home, `src/debug/abSwitches.ts`.
    const probe = await openCapturePage({
      serverUrl: vite.url,
      query: captureQuery(options.tier, options.dpr, {}, options.terrain, options.params),
      chrome: options.chrome,
      logs,
      tag: 'probe',
    });
    pages.push(probe);
    const registry = await probe.evaluateJson('window.__driftCapture.switches()');

    if (options.list) {
      for (const entry of registry) {
        console.log(
          `${entry.name.padEnd(20)} ${entry.scope.padEnd(7)} ` +
            `arms [${entry.arms.join(' | ')}] default ${entry.defaultArm}\n` +
            `${' '.repeat(20)} ${entry.summary}`,
        );
      }
      return;
    }

    const entry = registry.find((item) => item.name === options.switchName);
    if (!entry) {
      throw new Error(
        `unknown switch '${options.switchName}' — known: ` +
          registry.map((item) => item.name).join(', '),
      );
    }
    const arms = options.arms.length > 0 ? options.arms : entry.arms;
    if (arms.length < 2) throw new Error('an A/B needs at least two arms');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir =
      options.out ??
      path.join(PROJECT_ROOT, 'evidence', 'ab', `${entry.name}-${stamp}`);
    await mkdir(outDir, { recursive: true });

    const scenes = options.scenes.length > 0 ? options.scenes : [{}];
    const surface = surfaceLiteral(options);
    let shots;
    let sheetPage = probe;
    let verification = null;
    let crossPageControl = null;
    let armDelta = null;
    let armDeltas = null;
    let nullControls = null;

    if (entry.scope === 'live') {
      // --- one page, arms flipped between two renders of one state ----------
      const result = await probe.evaluateJson(
        `window.__driftCapture.captureAb(${JSON.stringify({
          switchName: entry.name,
          arms,
          scenes,
          surface: JSON.parse(surface),
          repeats: options.repeats,
        })})`,
      );
      shots = result.shots;

      if (options.verify) {
        verification = await verifyDeterminism(probe, {
          scene: scenes[0],
          surface,
          switchName: entry.name,
          expected: { [entry.name]: arms[0] },
        });
        armDelta = await diffOnPage(probe, shots[0].dataUrl, shots[1].dataUrl);

        // --- THE NULL CONTROL, and the reason a live sheet needs one --------
        //
        // A page-load A/B has always had its floor measured: a third page at
        // the same arm, and the run FAILS if that floor is not clearly smaller
        // than the switch. The live path had nothing equivalent, and it turns
        // out to need it more, not less.
        //
        // `captureAb` settles THREE frames after applying each arm, so arm one
        // is photographed at settle-frame 3 and arm two at settle-frame 6. That
        // is not free. Several things in this renderer amortize over a fixed
        // cycle of frames — the solar disc's 16 samples at 4 per frame, the sky
        // probe's 256 directions at 16 per frame — and each is a cursor, so the
        // two arms are drawn through different partial sums. Measured on a
        // midday deck: a re-shot with NO settle between differs by a mean of
        // 0.0023 of 255, and the same arm shot twice THROUGH the settle differs
        // by 3.33. A thousandfold, and entirely the harness's own.
        //
        // Against that floor, `sunDomeMean` measured 3.34. The sheet was
        // photographing its own settle.
        //
        // Same arm, same scenes, same path, so the only thing this can measure
        // is what the harness does between two shots.
        const control = await probe.evaluateJson(
          `window.__driftCapture.captureAb(${JSON.stringify({
            switchName: entry.name,
            arms: [arms[0], arms[0]],
            scenes,
            surface: JSON.parse(surface),
            repeats: 1,
          })})`,
        );
        nullControls = [];
        for (let index = 0; index + 1 < control.shots.length; index += 2) {
          nullControls.push({
            scene: control.shots[index].label.replace(
              `${entry.name}=${arms[0]} · `,
              '',
            ),
            difference: await diffOnPage(
              probe,
              control.shots[index].dataUrl,
              control.shots[index + 1].dataUrl,
            ),
          });
        }
      }
    } else {
      // --- one page per arm, interleaved shot by shot -----------------------
      const armPages = [probe];
      // The probe page carries arm 0's URL only by accident; reopen it so the
      // arm is stated rather than inherited.
      await probe.close();
      pages.pop();
      armPages.length = 0;
      for (let index = 0; index < arms.length; index++) {
        const armQuery = captureQuery(
          options.tier,
          options.dpr,
          { [entry.name]: arms[index] },
          options.terrain,
          options.params,
        );
        const page = await openCapturePage({
          serverUrl: vite.url,
          query: armQuery,
          chrome: options.chrome,
          logs,
          tag: `arm${index}`,
        });
        pages.push(page);
        armPages.push(page);
      }
      sheetPage = armPages[0];
      shots = [];

      // One scene per page load, and `--verify` only measures the first.
      //
      // `stage` is not bit-reproducible (see `verifyDeterminism`): a page's
      // FIRST staging of a scene reproduces across pages to a mean of about
      // 0.04 of 255, but its second staging drifts by a couple of levels. Both
      // arm pages advance in lockstep so they stay comparable in principle,
      // but the measured floor covers scene one alone, and scene two is
      // resting on an unmeasured and larger one.
      if (scenes.length > 1) {
        console.warn(
          `note     ${scenes.length} scenes on a page-load switch: the ` +
            `cross-page control covers only the first. Prefer one --scene per ` +
            `run until re-stage determinism is fixed.`,
        );
      }

      for (const scene of scenes) {
        // Stage every page to the identical scene before any of them is shot.
        for (const page of armPages) {
          await page.evaluateJson(
            `window.__driftCapture.stage(${JSON.stringify(scene)}, ${surface})`,
          );
        }
        for (let repeat = 0; repeat < options.repeats; repeat++) {
          for (let index = 0; index < arms.length; index++) {
            const expected = { [entry.name]: arms[index] };
            const label =
              `${entry.name}=${arms[index]} · ${describeScene(scene)}` +
              (options.repeats > 1 ? ` · pass ${repeat + 1}` : '');
            shots.push(
              await armPages[index].evaluateJson(
                `window.__driftCapture.shot(${JSON.stringify(label)}, ` +
                  `${surface}, ${JSON.stringify(expected)})`,
              ),
            );
          }
        }
      }

      if (options.verify) {
        // The control FIRST, and against `shots[0]`, because both of those are
        // that page's FIRST staging of this scene. Staging is not
        // bit-reproducible (see `verifyDeterminism`), so comparing a fresh
        // page's first staging against another page's fourth measures the
        // re-stage drift as well as the cross-page floor and blames all of it
        // on the pages.
        //
        // What this pair is for: a page-load A/B stages its two arms on two
        // SEPARATE pages, so everything that is not the switch has to be
        // measured before the switch can be believed. A third page at the
        // SAME arm as the first gives exactly that floor. An A/B that does not
        // clear it has shown nothing.
        const controlQuery = captureQuery(
          options.tier,
          options.dpr,
          { [entry.name]: arms[0] },
          options.terrain,
          options.params,
        );
        const controlPage = await openCapturePage({
          serverUrl: vite.url,
          query: controlQuery,
          chrome: options.chrome,
          logs,
          tag: 'control',
        });
        pages.push(controlPage);
        await controlPage.evaluateJson(
          `window.__driftCapture.stage(${JSON.stringify(scenes[0])}, ${surface})`,
        );
        const controlShot = await controlPage.evaluateJson(
          `window.__driftCapture.shot('cross-page control', ${surface}, ` +
            `${JSON.stringify({ [entry.name]: arms[0] })})`,
        );
        crossPageControl = await diffOnPage(
          sheetPage,
          shots[0].dataUrl,
          controlShot.dataUrl,
        );
        armDelta = await diffOnPage(sheetPage, shots[0].dataUrl, shots[1].dataUrl);

        verification = await verifyDeterminism(armPages[0], {
          scene: scenes[0],
          surface,
          switchName: entry.name,
          expected: { [entry.name]: arms[0] },
        });
      }
    }

    // --- how far apart the arms are, IN EVERY SCENE ---------------------------
    //
    // `armDelta` above covers scene one, which is the scene `--verify` builds
    // its determinism claim on. But a sheet is usually multi-scene precisely
    // because the signal is condition-dependent — the whole point of shooting
    // the sun at 22, 26 and 30 degrees is that the switch may do nothing at two
    // of them. One global number cannot say which, and a sheet that shows
    // nothing in a scene should be caught by its own arithmetic rather than by
    // the reader's time.
    if (arms.length === 2 && options.repeats === 1) {
      armDeltas = [];
      for (let index = 0; index + 1 < shots.length; index += 2) {
        armDeltas.push({
          scene: shots[index].label.replace(`${entry.name}=${arms[0]} · `, ''),
          difference: await diffOnPage(
            sheetPage,
            shots[index].dataUrl,
            shots[index + 1].dataUrl,
          ),
        });
      }
    }

    // --- the sheet ------------------------------------------------------------
    const stampLine = shots[0].tier
      ? `${shots[0].tier.tier} · ${shots[0].tier.detailOctaves} octaves · ` +
        `${shots[0].tier.oceanRings}x${shots[0].tier.oceanSectors} rings · ` +
        `${shots[0].tier.cssWidth}x${shots[0].tier.cssHeight} @${shots[0].tier.pixelRatio}x ` +
        `(${shots[0].tier.backingWidth}x${shots[0].tier.backingHeight})`
      : 'tier unknown';
    const subtitle =
      `${entry.summary} — ships at ${entry.name}=${entry.defaultArm} · ${stampLine}`;

    // An amplified difference panel per scene. Two arms and one pass only:
    // with more of either, "the difference" is no longer one thing.
    let sheetFrames = shots.map(({ label, dataUrl }) => ({ label, dataUrl }));
    let columns = arms.length;
    if (options.diffGain > 0) {
      if (arms.length !== 2 || options.repeats !== 1) {
        throw new Error(
          '--diff needs exactly two arms and one pass; with more, "the ' +
            'difference" is not a single image',
        );
      }
      const withDiffs = [];
      for (let index = 0; index < sheetFrames.length; index += 2) {
        const [a, b] = [sheetFrames[index], sheetFrames[index + 1]];
        const image = await sheetPage.evaluateJson(
          `window.__driftCapture.diffImage(${JSON.stringify(a.dataUrl)}, ` +
            `${JSON.stringify(b.dataUrl)}, ${options.diffGain})`,
          { awaitPromise: true },
        );
        withDiffs.push(a, b, {
          label: `difference x${options.diffGain}`,
          dataUrl: image,
        });
      }
      sheetFrames = withDiffs;
      columns = 3;
    }

    const sheetDataUrl = await sheetPage.evaluateJson(
      `window.__driftCapture.compose(` +
        `${JSON.stringify(sheetFrames)}, ` +
        `${JSON.stringify({
          title: `A/B · ${entry.name}`,
          subtitle,
          columns,
          cellWidth: 640,
        })})`,
      { awaitPromise: true },
    );

    const sheetPath = path.join(outDir, `${entry.name}-sheet.png`);
    await writeFile(sheetPath, Buffer.from(sheetDataUrl.split(',')[1], 'base64'));
    for (const shot of shots) {
      const safe = shot.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      await writeFile(
        path.join(outDir, `${safe}.png`),
        Buffer.from(shot.dataUrl.split(',')[1], 'base64'),
      );
    }

    // The determinism baseline is a FRAME, so it goes where every other frame
    // goes — beside the sheet as a PNG, not inside the manifest as base64.
    // Left embedded it made each manifest 4.6 MB of entropy-coded image in a
    // file that is otherwise a page of numbers, and the manifest is the half
    // this project keeps in history. Same rule the `evidence/` allowlist
    // already states: the sheet and its numbers are worth their bytes, the
    // full-size frames beside them are regenerable and are not.
    if (verification?.baselineDataUrl) {
      await writeFile(
        path.join(outDir, 'determinism-baseline.png'),
        Buffer.from(verification.baselineDataUrl.split(',')[1], 'base64'),
      );
      delete verification.baselineDataUrl;
    }

    const manifest = {
      switch: entry,
      arms,
      scenes,
      surface: JSON.parse(surface),
      repeats: options.repeats,
      // What it took to get this picture, so the sheet can be re-shot from its
      // own manifest. The scene alone is not enough: the star-dome sheet is
      // only about anything because `--param fixture=` put a headland in it.
      diffGain: options.diffGain,
      terrain: options.terrain,
      params: options.params,
      capturedAt: new Date().toISOString(),
      determinism: verification,
      crossPageControl,
      nullControls,
      armDelta,
      armDeltas,
      shots: shots.map((shot) => ({
        label: shot.label,
        cameraMode: shot.cameraMode,
        cinematicScale: shot.cinematicScale,
        sunElevationDeg: shot.sunElevationDeg,
        moonElevationDeg: shot.moonElevationDeg,
        moonIlluminatedFraction: shot.moonIlluminatedFraction,
        moonPower: shot.moonPower,
        trueWindAngleDeg: shot.trueWindAngleDeg,
        tier: shot.tier,
      })),
    };
    const manifestPath = path.join(outDir, `${entry.name}-manifest.json`);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 1));

    // --- the digest -----------------------------------------------------------
    console.log(`switch   ${entry.name} (${entry.scope}) — ${entry.summary}`);
    console.log(`arms     ${arms.join(' vs ')} · ships at ${entry.defaultArm}`);
    console.log(
      `sign     signed luma is ${entry.name}=${arms[1]} minus ` +
        `${entry.name}=${arms[0]}, in sRGB code levels — positive means the ` +
        `second panel of each row is brighter`,
    );
    console.log(`tier     ${stampLine}`);
    for (const shot of shots) {
      const wind =
        shot.trueWindAngleDeg === null || shot.trueWindAngleDeg === undefined
          ? ''
          : ` · wind ${shot.trueWindAngleDeg}° off the bow`;
      // The moon only when there is one worth naming. A line reading "moon
      // power 0" on every daylight sheet in the archive is noise; a line
      // reading it on a MOONLIGHT sheet is the finding.
      const moon =
        shot.moonPower === undefined || shot.moonPower === 0
          ? ''
          : ` · moon ${shot.moonElevationDeg}° ` +
            `${(shot.moonIlluminatedFraction * 100).toFixed(0)}% lit, ` +
            `power ${shot.moonPower}`;
      console.log(
        `shot     ${shot.label}  [${Object.entries(shot.tier.switches)
          .filter(([name]) => name === entry.name)
          .map(([name, value]) => `${name}=${value}`)
          .join('')}] sun ${shot.sunElevationDeg}° drawn${moon}${wind}`,
      );
    }
    // A moonlight question photographed with no moon up is the exact shape of
    // silent substitution this tool exists to refuse, and it is invisible in
    // the picture: two black seas look like two black seas. Say so.
    if (
      /moon/i.test(entry.name) &&
      shots.every((shot) => shot.moonPower === 0)
    ) {
      console.error(
        'scene    FAILED: no shot on this sheet has any moon in it ' +
          '(moonPower 0 throughout). Both arms of a moonlight A/B are then ' +
          'identically zero. Give the scene a --scene dayOfYear=<n> that puts ' +
          'the moon up and lit.',
      );
      process.exitCode = 1;
    }
    // A scene asks for an elevation; the solar walk lands on the nearest
    // instant it can find, and on the wrong date "nearest" can be nowhere near.
    // Say so rather than letting a caption assert it.
    for (let index = 0; index < shots.length; index++) {
      const asked = scenes[Math.floor(index / (arms.length * options.repeats))];
      const requested = asked?.sunElevationDeg ?? 38;
      if (Math.abs(shots[index].sunElevationDeg - requested) > 0.5) {
        console.warn(
          `note     scene asked for sun ${requested}° and the day's nearest ` +
            `instant drew ${shots[index].sunElevationDeg}° — the caption is the ` +
            `request, the manifest is the truth`,
        );
      }
    }
    if (verification) {
      console.log(`verify   same stage, re-shot: ${formatDiff(verification.sameStage)}`);
      console.log(`verify   re-staged, re-shot: ${formatDiff(verification.restage)}`);
      // The contract is on the shot, not on the staging: an A/B is only ever
      // read across one staged scene.
      if (verification.sameStage.maxChannelDelta > 1) {
        console.error(
          'verify   FAILED: a re-shot of an already staged scene must be exact ' +
            'to within 8-bit quantisation',
        );
        process.exitCode = 1;
      }
    }
    if (armDelta) console.log(`delta    arms differ by ${formatDiff(armDelta)}`);
    for (let index = 0; index < (armDeltas ?? []).length; index++) {
      const row = armDeltas[index];
      console.log(`delta    ${row.scene}: ${formatDiff(row.difference)}`);
      const floor = nullControls?.[index];
      if (!floor) continue;
      const floorMean = floor.difference.meanChannelDelta;
      const ratio = floorMean === 0 ? Infinity : row.difference.meanChannelDelta / floorMean;
      console.log(
        `control  ${row.scene}: same arm twice ${formatDiff(floor.difference)}` +
          (floorMean === 0
            ? ' — bit-identical, so the whole delta is the switch'
            : ` — switch is ${ratio.toFixed(1)}x the floor`),
      );
      if (row.difference.meanChannelDelta === 0) {
        console.error(
          `control  FAILED in '${row.scene}': the two arms are bit-identical. ` +
            `Either the switch is inert in this scene or it did not take — and ` +
            `either is worth more than a sheet.`,
        );
        process.exitCode = 1;
        continue;
      }
      // A failure, not a warning, exactly as for the page-load floor: a sheet
      // that cannot support a verdict must not quietly invite one.
      //
      // The bar is 2x rather than "bigger at all". At 1.01x the reviewer is
      // being shown a picture that is half harness, and "the arms differ, just
      // barely" is not something a look verdict can be taken from. For scale,
      // the `shoulder` sheet clears its own floor by about fifty.
      if (ratio < 2) {
        console.error(
          `control  FAILED in '${row.scene}': the same arm photographed twice ` +
            `differs by ${(100 / ratio).toFixed(0)}% of what the two arms differ ` +
            `by, so that row is mostly the harness. The frames are written for ` +
            `diagnosis; do not put that row in front of anyone as an A/B.`,
        );
        process.exitCode = 1;
      }
    }
    if (crossPageControl) {
      console.log(`control  two pages at the same arm differ by ${formatDiff(crossPageControl)}`);
      // A failure, not a warning. The whole point of this tool is that a sheet
      // which cannot support a verdict must not quietly invite one.
      if (crossPageControl.meanChannelDelta >= (armDelta?.meanChannelDelta ?? Infinity)) {
        console.error(
          'control  FAILED: the cross-page floor is at least as large as the ' +
            'switch, so nothing on this sheet is attributable to the switch. ' +
            'The frames are written for diagnosis; do not put them in front of ' +
            'anyone as an A/B.',
        );
        process.exitCode = 1;
      }
    }
    console.log(`wrote    ${sheetPath}`);
    console.log(`wrote    ${manifestPath}`);
  } catch (error) {
    console.error(error.message ?? error);
    if (logs.length > 0) console.error(logs.slice(-25).join('\n'));
    process.exitCode = 1;
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    for (const server of servers) server.kill('SIGTERM');
  }
}

/**
 * The caption half of a scene, matching `captureHost.describeCaptureScene`.
 *
 * Duplicated deliberately and minimally: this path never enters the page, so it
 * cannot call the host's copy, and a page-load sheet whose rows are all
 * captioned alike is unreadable in exactly the same way a live one is.
 */
function describeScene(scene) {
  return [
    scene.seaState ?? 'CURRENT_MODERATE',
    `sun ${scene.sunElevationDeg ?? 38}°`,
    scene.dayOfYear === undefined ? null : `day ${scene.dayOfYear}`,
    scene.trueWindAngleDeg === undefined
      ? null
      : `wind ${scene.trueWindAngleDeg}° off the bow`,
    scene.cameraMode === undefined ? null : `camera ${scene.cameraMode}`,
    scene.cinematicScale === undefined
      ? null
      : `cinematic scale ${scene.cinematicScale.toFixed(2)}`,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/** Pixel difference between two frames, computed in the page that has canvases. */
function diffOnPage(page, first, second) {
  return page.evaluateJson(
    `window.__driftCapture.diff(${JSON.stringify(first)}, ${JSON.stringify(second)})`,
    { awaitPromise: true },
  );
}

/**
 * Re-stage the scene from scratch and re-shoot the same arm.
 *
 * Two claims come out of this, and they are deliberately separate because they
 * turned out to have different answers. `shot` re-shot from an ALREADY staged
 * scene is exact to within 8-bit quantisation; `stage` run again was not, and
 * the residue was traced to three owners holding state `resetSimulation` could
 * not reach — the cloud tile cache's round-robin cursor above all.
 *
 * All three are fixed at source and guarded in node by
 * `tests/restage-determinism.test.ts`, but the PIXEL figure below has not been
 * re-measured since (the determinism round ran on a thermally throttled
 * machine and was forbidden to benchmark). So it is still reported rather than
 * asserted. Re-measure on a cold machine and, if it holds up, promote it.
 * Either way the live A/B path needs only the first claim: both arms come off
 * ONE staging.
 */
async function verifyDeterminism(page, { scene, surface, expected, switchName }) {
  // Put the switch back on the arm being rechecked FIRST.
  //
  // `captureAb` deliberately leaves a live switch on its shipping arm after
  // each scene, so a later scene cannot inherit whichever arm was photographed
  // last — which means the arm this recheck wants is no longer set. The tier
  // assertion caught that rather than letting the recheck compare two
  // different arms and report the switch as non-determinism.
  const arm = expected[switchName];
  await page.evaluateVoid(
    `window.__driftCapture.setSwitch(${JSON.stringify(switchName)}, ` +
      `${JSON.stringify(arm)})`,
  );
  const shoot = (label) =>
    page.evaluateJson(
      `window.__driftCapture.shot(${JSON.stringify(label)}, ${surface}, ` +
        `${JSON.stringify(expected)})`,
    );
  const restage = () =>
    page.evaluateJson(
      `window.__driftCapture.stage(${JSON.stringify(scene)}, ${surface})`,
    );

  // The baseline is taken HERE, from a fresh staging of this scene — not
  // borrowed from the sheet's own first shot. The page has photographed every
  // other scene since then, and comparing a moderate midday sea against the
  // rough dusk one that followed it reports 100% of pixels differing and calls
  // it non-determinism. That is a bug in the checker, and it wrote one.
  await restage();
  const baseline = await shoot('determinism baseline');
  const sameStage = await shoot('same-stage recheck');
  const sameStageDiff = await diffOnPage(page, baseline.dataUrl, sameStage.dataUrl);

  await restage();
  // Staging does not touch a live switch, but say so explicitly rather than
  // relying on it.
  await page.evaluateVoid(
    `window.__driftCapture.setSwitch(${JSON.stringify(switchName)}, ` +
      `${JSON.stringify(arm)})`,
  );
  const restaged = await shoot('re-stage recheck');
  const restageDiff = await diffOnPage(page, baseline.dataUrl, restaged.dataUrl);

  return {
    sameStage: sameStageDiff,
    restage: restageDiff,
    baselineDataUrl: baseline.dataUrl,
  };
}

/** One line of difference, for the terminal and the sheet. */
function formatDiff(diff) {
  const signed =
    diff.meanSignedLuma === undefined
      ? ''
      : `, signed luma ${diff.meanSignedLuma > 0 ? '+' : ''}${diff.meanSignedLuma}`;
  return (
    `${diff.differingPercent}% of pixels, max ${diff.maxChannelDelta}/255, ` +
    `mean ${diff.meanChannelDelta}${signed}`
  );
}

main();
