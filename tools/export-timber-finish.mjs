/**
 * Roughness derivation for one ship surface, against the sky it actually
 * reflects.
 *
 *   node tools/export-timber-finish.mjs --region deck --stand Waist --look 140,-40
 *   node tools/export-timber-finish.mjs --region inboardBulwark --sun 30 --sun 12
 *
 * WHY THIS EXISTS
 * ---------------
 * `Schooner.ts`'s `FINISH` table carries a note that is the whole reason for
 * this round: the hull's roughnesses were fitted in the M1 round against a
 * hand-authored sky probe at `ENV_INTENSITY = 0.3`, the world lighting round
 * then retired that probe for a scene-wide one at full strength, and the finish
 * was never re-derived. `dba7041` re-derived the *painted exterior* by hand,
 * measuring "the 95th percentile of topsides luminance" off the term views at
 * one frozen instant, and wrote the table it produced into the comment:
 *
 *     roughness   0.52    0.62    0.72    0.82    0.92
 *     p95         99.7    94.1    87.0    80.3    77.5
 *
 * It also recorded, in the same comment, the four regions it deliberately did
 * not touch — "Deck, inboard bulwark, bottom and glazing are untouched — they
 * were never in the reflection complaint". Two of those are the timber Ash has
 * since complained about. This tool is that hand measurement, written down so
 * the next person does not have to reproduce it from a comment.
 *
 * WHAT IT MEASURES, AND WHAT THE NUMBERS MEAN
 * -------------------------------------------
 * For one named region, at one frozen scene, it reports across a roughness
 * sweep:
 *
 *   specular p50/p95/max   the PMREM reflection term (`indirect-specular`),
 *                          through the real tone curve, in display levels
 *   diffuse  p50/p95       the SH probe on the paint (`indirect-diffuse`) —
 *                          roughness-independent, so it is the yardstick the
 *                          specular numbers are read against
 *   beauty   p50/p95       the finished picture
 *
 * All three are measured over the SAME mask: the pixels the region actually
 * covers, found by photographing the frame with the region hidden and taking
 * the pixels that changed. A percentile and not a mean, for the reason
 * `dba7041` gives — "a mean cannot see a hot-spot and the mean is what said
 * 'roughness does nothing' for an afternoon".
 *
 * WHAT IT DOES NOT MEASURE
 * ------------------------
 * Cost. Nothing here is a benchmark and the machine this round ran on was
 * thermally throttled; see the round write-up for what a cold pass owes.
 *
 * OPTIONS
 *   --region <name>     ship region: deck, inboardBulwark, topsides, ...
 *                       (mesh `ship:<name>`), or any mesh name in the vessel
 *   --roughness <list>  comma-separated sweep (default 0.55,0.65,...,0.95)
 *   --sun <deg>         sun elevation; repeatable, one block per elevation
 *   --stand <station>   where the eye stands (default Waist)
 *   --look <yaw,pitch>  ship-relative (default 140,-40 — down at the deck)
 *   --sea <preset>      sea state (default CURRENT_MODERATE)
 *   --width/--height    capture size (default 640x360 — statistics, not a look)
 *   --out <dir>         output directory (default evidence/timber/<stamp>)
 *   --server <url>      attach to a running dev server
 *   --chrome <path>     Chrome executable
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CHROME,
  PROJECT_ROOT,
  launchHeadlessPage,
  startViteServer,
} from './headless.mjs';

const DEFAULT_ROUGHNESS = [0.55, 0.65, 0.75, 0.85, 0.95];

function parseArguments(argv) {
  const options = {
    regions: [],
    roughness: DEFAULT_ROUGHNESS,
    suns: [],
    stand: 'Waist',
    look: [140, -40],
    sea: 'CURRENT_MODERATE',
    width: 640,
    height: 360,
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
    if (argument === '--region') options.regions.push(next());
    else if (argument === '--roughness') {
      options.roughness = next().split(',').map(Number);
    } else if (argument === '--sun') options.suns.push(Number(next()));
    else if (argument === '--stand') options.stand = next();
    else if (argument === '--look') options.look = next().split(',').map(Number);
    else if (argument === '--sea') options.sea = next();
    else if (argument === '--width') options.width = Number(next());
    else if (argument === '--height') options.height = Number(next());
    else if (argument === '--out') options.out = path.resolve(next());
    else if (argument === '--server') options.server = next();
    else if (argument === '--chrome') options.chrome = path.resolve(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.regions.length === 0) options.regions = ['deck'];
  if (options.suns.length === 0) options.suns = [30];
  return options;
}

/**
 * The page-side half: mask a region, sweep its roughness, reduce each frame to
 * percentiles before anything crosses the CDP boundary.
 *
 * Installed as one function rather than evaluated piecemeal because the mask
 * has to outlive the sweep — recomputing it per roughness would let a hot
 * highlight grow the region it is being measured over.
 */
const PAGE_HARNESS = String.raw`
window.__timberProbe = (() => {
  const capture = window.__driftCapture;
  const drift = window.__drift;
  if (!capture || !drift) throw new Error('needs ?capture=1 on a dev build');

  const decode = async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  };

  const luminance = (data, i) =>
    0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

  const shipMeshes = () => {
    const found = [];
    drift.scene.traverse((object) => {
      if (object.isMesh && typeof object.name === 'string' && object.name.includes(':')) {
        found.push(object);
      }
    });
    return found;
  };

  const percentile = (sorted, q) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

  const statsOver = (image, mask) => {
    const values = [];
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p]) continue;
      values.push(luminance(image.data, p * 4));
    }
    values.sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = values.length ? sum / values.length : 0;
    const variance = values.length
      ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length
      : 0;
    const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
    return {
      pixels: values.length,
      mean: values.length ? round1(mean) : null,
      // The spread IS the question this round is about: a surface whose p05
      // and p95 are four levels apart is flat whatever its hue, and no
      // roughness fixes that. Reported beside the percentiles so a sweep can
      // answer "did anything vary" as well as "how bright".
      sd: values.length ? round1(Math.sqrt(variance)) : null,
      p05: round1(percentile(values, 0.05)),
      p50: round1(percentile(values, 0.5)),
      p95: round1(percentile(values, 0.95)),
      max: values.length ? round1(values[values.length - 1]) : null,
    };
  };

  return {
    /**
     * Pixels the named mesh covers: one frame with it, one without, the
     * difference. Independent of roughness, so it is taken once and reused
     * for the whole sweep.
     */
    async mask(meshName, surface) {
      const mesh = shipMeshes().find((m) => m.name === meshName);
      if (!mesh) {
        throw new Error(
          'no mesh named ' + meshName + ' — have: ' +
            shipMeshes().map((m) => m.name).join(', '),
        );
      }
      drift.setWorldDebugView('albedo');
      const withIt = await decode(capture.shot('mask-with', surface).dataUrl);
      mesh.visible = false;
      const without = await decode(capture.shot('mask-without', surface).dataUrl);
      mesh.visible = true;
      drift.setWorldDebugView('off');
      const mask = new Uint8Array(withIt.data.length / 4);
      let covered = 0;
      for (let p = 0; p < mask.length; p++) {
        const i = p * 4;
        const delta = Math.max(
          Math.abs(withIt.data[i] - without.data[i]),
          Math.abs(withIt.data[i + 1] - without.data[i + 1]),
          Math.abs(withIt.data[i + 2] - without.data[i + 2]),
        );
        if (delta > 3) {
          mask[p] = 1;
          covered++;
        }
      }
      this._mask = mask;
      this._mesh = mesh;
      this._roughness = mesh.material.roughness;
      return { meshName, covered, ofPixels: mask.length };
    },

    /** One term view's percentiles over the held mask. */
    async term(view, surface) {
      drift.setWorldDebugView(view);
      const image = await decode(capture.shot('term-' + view, surface).dataUrl);
      drift.setWorldDebugView('off');
      return statsOver(image, this._mask);
    },

    /** The finished picture's percentiles over the held mask. */
    async beauty(surface) {
      const image = await decode(capture.shot('beauty', surface).dataUrl);
      return statsOver(image, this._mask);
    },

    setRoughness(value) {
      this._mesh.material.roughness = value;
    },

    restore() {
      if (this._mesh) this._mesh.material.roughness = this._roughness;
    },

    shippedRoughness() {
      return this._roughness;
    },
  };
})();
`;

async function main() {
  const options = parseArguments(process.argv);
  const logs = [];
  const servers = [];
  const pages = [];

  try {
    const vite = await startViteServer(options.server, logs);
    if (vite.process) servers.push(vite.process);

    const query = new URLSearchParams({
      capture: '1',
      quality: 'desktop',
      fixedDpr: '1',
      terrain: 'off',
    }).toString();
    const page = await launchHeadlessPage({
      serverUrl: vite.url,
      query,
      chromePath: options.chrome,
      logs,
      tag: 'timber',
    });
    pages.push(page);
    await page.waitFor('window.__driftCapture?.ready === true');
    await page.evaluateVoid(PAGE_HARNESS);

    const surface = JSON.stringify({
      tier: 'desktop',
      cssWidth: options.width,
      cssHeight: options.height,
      pixelRatio: 1,
    });

    const blocks = [];
    for (const sun of options.suns) {
      const scene = {
        seaState: options.sea,
        sunElevationDeg: sun,
        stand: options.stand,
        lookYawDeg: options.look[0],
        lookPitchDeg: options.look[1],
      };
      await page.evaluateJson(
        `window.__driftCapture.stage(${JSON.stringify(scene)}, ${surface})`,
      );

      for (const region of options.regions) {
        const meshName = region.includes(':') ? region : `ship:${region}`;
        const coverage = await page.evaluateJson(
          `window.__timberProbe.mask(${JSON.stringify(meshName)}, ${surface})`,
          { awaitPromise: true },
        );
        if (coverage.covered < 200) {
          throw new Error(
            `${meshName} covers only ${coverage.covered} pixels at this view — ` +
              `aim the camera at it before measuring it`,
          );
        }
        const shipped = await page.evaluateJson(
          'window.__timberProbe.shippedRoughness()',
        );
        const diffuse = await page.evaluateJson(
          `window.__timberProbe.term('indirect-diffuse', ${surface})`,
          { awaitPromise: true },
        );
        const rows = [];
        for (const roughness of options.roughness) {
          await page.evaluateVoid(
            `window.__timberProbe.setRoughness(${roughness})`,
          );
          const specular = await page.evaluateJson(
            `window.__timberProbe.term('indirect-specular', ${surface})`,
            { awaitPromise: true },
          );
          // Below decks the portal path scales the environment reflection by a
          // baked sky visibility of zero, so `indirect-specular` is identically
          // black there and the only lobe left is the sun's and the lantern's.
          // Measuring only the first would report "roughness does nothing" in
          // exactly the room whose 0.72 was chosen for a lantern to glance off.
          const directSpecular = await page.evaluateJson(
            `window.__timberProbe.term('direct-specular', ${surface})`,
            { awaitPromise: true },
          );
          const beauty = await page.evaluateJson(
            `window.__timberProbe.beauty(${surface})`,
            { awaitPromise: true },
          );
          rows.push({ roughness, specular, directSpecular, beauty });
        }
        await page.evaluateVoid('window.__timberProbe.restore()');

        blocks.push({ sun, region: meshName, shipped, coverage, diffuse, rows });

        console.log(
          `\n${meshName} · sun ${sun}° · ${coverage.covered} px · ships at roughness ${shipped}`,
        );
        console.log(
          `  indirect diffuse (roughness-independent)  p50 ${diffuse.p50}  p95 ${diffuse.p95}`,
        );
        console.log(
          '  roughness   env p95   lamp p95   lamp max   beauty p05   beauty p50   beauty p95   beauty sd',
        );
        for (const row of rows) {
          console.log(
            `  ${String(row.roughness).padEnd(11)} ` +
              `${String(row.specular.p95).padEnd(9)} ` +
              `${String(row.directSpecular.p95).padEnd(10)} ` +
              `${String(row.directSpecular.max).padEnd(10)} ` +
              `${String(row.beauty.p05).padEnd(12)} ` +
              `${String(row.beauty.p50).padEnd(12)} ` +
              `${String(row.beauty.p95).padEnd(12)} ` +
              `${String(row.beauty.sd)}`,
          );
        }
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outDir =
      options.out ?? path.join(PROJECT_ROOT, 'evidence', 'timber', stamp);
    await mkdir(outDir, { recursive: true });
    const file = path.join(outDir, 'timber-finish.json');
    await writeFile(
      file,
      JSON.stringify(
        { options: { ...options, chrome: undefined }, blocks },
        null,
        1,
      ),
    );
    console.log(`\nwrote    ${file}`);
  } catch (error) {
    console.error(error.message ?? error);
    if (logs.length > 0) console.error(logs.slice(-25).join('\n'));
    process.exitCode = 1;
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    for (const server of servers) server.kill('SIGTERM');
  }
}

main();
