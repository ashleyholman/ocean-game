#!/usr/bin/env node

/**
 * TERR-135's canonical terrain review run.
 *
 * `--plan` is browser-free and deliberately contains no clock or machine
 * fields, so its JSON can be diffed byte-for-byte. `--capture` is the separate
 * evidence action: it opens each still recipe through the established capture
 * host, records that host's actual camera/tier readback, and writes PNGs plus a
 * run manifest. Motion rows remain named manual eye checks; a still-capture
 * tool cannot honestly automate their verdict.
 *
 *   node tools/terrain-canonical-captures.mjs --plan
 *   node tools/terrain-canonical-captures.mjs --list
 *   node tools/terrain-canonical-captures.mjs --plan --view maximum-cinematic-far-ocean
 *   node tools/terrain-canonical-captures.mjs --capture --cold-machine \
 *     --out evidence/terrain/r1-renderer/terr-135-canonical-cold
 */

import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

import {
  DEFAULT_CHROME,
  PROJECT_ROOT,
  launchHeadlessPage,
  startViteServer,
} from './headless.mjs';

/**
 * Keep the typed browser/test module as the one table without requiring a Node
 * release whose ESM loader understands `.ts`. The project already requires
 * TypeScript for every tool run; this erases types in memory and imports the
 * result without writing generated JavaScript beside the source.
 */
async function loadCanonicalPlanModule() {
  const sourceUrl = new URL(
    '../src/debug/terrainCanonicalViews.ts',
    import.meta.url,
  );
  const source = await readFile(sourceUrl, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: 'terrainCanonicalViews.ts',
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  return import(moduleUrl);
}

const { buildTerrainCanonicalPlan } = await loadCanonicalPlanModule();

const USAGE = `
Usage:
  node tools/terrain-canonical-captures.mjs --plan [--view <id> ...]
  node tools/terrain-canonical-captures.mjs --list [--view <id> ...]
  node tools/terrain-canonical-captures.mjs --capture --cold-machine \\
    --out <new-directory> [--view <id> ...] [--server <url>] [--chrome <path>]

Policy:
  --plan is the default and performs no browser or filesystem write.
  --capture requires an explicit cold-machine attestation and a new output
  directory. It refuses any open table gate before starting Chrome.
`;

function parseArguments(argv) {
  const options = {
    mode: null,
    coldMachine: false,
    selectedIds: [],
    out: null,
    server: null,
    chrome: DEFAULT_CHROME,
  };
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) {
        throw new Error(`${argument} needs a value`);
      }
      return argv[++index];
    };
    if (argument === '--plan') setMode(options, 'plan');
    else if (argument === '--list') setMode(options, 'list');
    else if (argument === '--capture') setMode(options, 'capture');
    else if (argument === '--cold-machine') options.coldMachine = true;
    else if (argument === '--view') options.selectedIds.push(next());
    else if (argument === '--out') options.out = path.resolve(next());
    else if (argument === '--server') options.server = next();
    else if (argument === '--chrome') options.chrome = path.resolve(next());
    else if (argument === '--help' || argument === '-h') setMode(options, 'help');
    else throw new Error(`unknown argument: ${argument}`);
  }
  options.mode ??= 'plan';
  return options;
}

function setMode(options, mode) {
  if (options.mode !== null && options.mode !== mode) {
    throw new Error(`choose exactly one of --plan, --list, or --capture`);
  }
  options.mode = mode;
}

function printList(plan) {
  for (const row of plan.rows) {
    const frames = row.kind === 'still' ? `still ×${row.expectedFrames}` : 'motion eye check';
    const risk = row.highRiskPairing ? ` · risk ${row.highRiskPairing}` : '';
    console.log(`${row.id.padEnd(38)} ${frames}${risk}`);
  }
  console.log(`\n${plan.rows.length} rows · ${plan.stillFrames} atomic still frames`);
}

function gitFact(args, fallback) {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

async function assertNewOutputDirectory(outDir) {
  try {
    await access(outDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await mkdir(outDir, { recursive: true });
      return;
    }
    throw error;
  }
  throw new Error(`refusing to overwrite existing output directory: ${outDir}`);
}

function pngBytes(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('capture host returned a non-PNG data URL');
  }
  return Buffer.from(dataUrl.slice(prefix.length), 'base64');
}

function safeArm(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function assertCameraReadback(row, shot) {
  if (shot.cameraMode !== row.requestedCamera.cameraMode) {
    throw new Error(
      `${row.id} requested camera ${row.requestedCamera.cameraMode}, ` +
        `host reported ${shot.cameraMode}`,
    );
  }
  const requestedScale = row.requestedCamera.cinematicScale;
  if (requestedScale === null) {
    if (shot.cinematicScale !== null) {
      throw new Error(`${row.id} embodied shot reported a cinematic scale`);
    }
    return;
  }
  if (
    !Number.isFinite(shot.cinematicScale) ||
    shot.cinematicScale < 0 ||
    shot.cinematicScale > 1
  ) {
    throw new Error(`${row.id} reported invalid cinematic scale ${shot.cinematicScale}`);
  }
  if (
    requestedScale !== 'authored-default' &&
    Math.abs(shot.cinematicScale - requestedScale) > 1e-9
  ) {
    throw new Error(
      `${row.id} requested cinematic scale ${requestedScale}, ` +
        `host reported ${shot.cinematicScale}`,
    );
  }
}

async function captureStillRow(page, row) {
  if (row.capture.kind === 'single') {
    await page.evaluateJson(
      `window.__driftCapture.stage(${JSON.stringify(row.scene)}, ` +
        `${JSON.stringify(row.surface)})`,
    );
    const shot = await page.evaluateJson(
      `window.__driftCapture.shot(${JSON.stringify(`${row.id} · ${row.title}`)}, ` +
        `${JSON.stringify(row.surface)}, ` +
        `${JSON.stringify(row.capture.expectedSwitches)})`,
    );
    return [shot];
  }
  const result = await page.evaluateJson(
    `window.__driftCapture.captureAb(${JSON.stringify({
      switchName: row.capture.switchName,
      arms: row.capture.arms,
      scenes: [row.scene],
      surface: row.surface,
      repeats: 1,
    })})`,
  );
  if (result.scope !== 'live') {
    throw new Error(`${row.id} requires a live A/B switch, got ${result.scope}`);
  }
  return result.shots;
}

async function capturePlan(plan, options) {
  if (!options.coldMachine) {
    throw new Error(
      '--capture requires --cold-machine: do not label a busy or thermally ' +
        'unknown run canonical evidence',
    );
  }
  if (options.out === null) {
    throw new Error('--capture requires --out <new-directory>');
  }
  const openGates = plan.pixelGates.filter((gate) => gate.status === 'open');
  if (openGates.length > 0) {
    throw new Error(
      `canonical pixel run blocked by ${openGates.map((gate) => gate.id).join(', ')}`,
    );
  }
  const stillRows = plan.rows.filter((row) => row.kind === 'still');
  if (stillRows.length === 0) {
    throw new Error('--capture selection contains no still rows');
  }

  await assertNewOutputDirectory(options.out);
  const logs = [];
  const servers = [];
  const pages = [];
  const results = [];
  try {
    const vite = await startViteServer(options.server, logs);
    if (vite.process) servers.push(vite.process);

    for (let rowIndex = 0; rowIndex < stillRows.length; rowIndex++) {
      const row = stillRows[rowIndex];
      const page = await launchHeadlessPage({
        serverUrl: vite.url,
        query: row.pageQuery,
        chromePath: options.chrome,
        logs,
        tag: `terrain-${rowIndex + 1}`,
      });
      pages.push(page);
      await page.waitFor('window.__driftCapture?.ready === true');
      const shots = await captureStillRow(page, row);
      if (shots.length !== row.expectedFrames) {
        throw new Error(
          `${row.id} expected ${row.expectedFrames} frame(s), got ${shots.length}`,
        );
      }

      const shotMetadata = [];
      for (let shotIndex = 0; shotIndex < shots.length; shotIndex++) {
        const shot = shots[shotIndex];
        assertCameraReadback(row, shot);
        const arm =
          row.capture.kind === 'ab'
            ? `-${safeArm(row.capture.arms[shotIndex])}`
            : '';
        const fileName = `${String(rowIndex + 1).padStart(2, '0')}-${row.id}${arm}.png`;
        await writeFile(path.join(options.out, fileName), pngBytes(shot.dataUrl));
        const { dataUrl: _dataUrl, ...metadata } = shot;
        shotMetadata.push({ file: fileName, ...metadata });
      }
      results.push({
        id: row.id,
        pageQuery: row.pageQuery,
        requestedCamera: row.requestedCamera,
        shots: shotMetadata,
      });
      await page.close();
      pages.splice(pages.indexOf(page), 1);
      console.log(`captured ${row.id} (${shots.length} frame${shots.length === 1 ? '' : 's'})`);
    }

    const revision = gitFact(['rev-parse', 'HEAD'], 'unknown');
    const status = gitFact(['status', '--porcelain'], null);
    const manifest = {
      schemaVersion: plan.schemaVersion,
      tableId: plan.tableId,
      generatedAtUtc: new Date().toISOString(),
      source: {
        revision,
        dirty: status === null ? null : status !== '',
      },
      policy: {
        coldMachineAttested: true,
        captureHostAtomicReadback: true,
        sequentialFreshPagePerStillRow: true,
        motionVerdictsAutomated: false,
      },
      deterministicPlan: plan,
      results,
      motionReviews: plan.rows.filter((row) => row.kind === 'motion'),
    };
    const manifestPath = path.join(options.out, 'terrain-canonical-manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${manifestPath}`);
  } catch (error) {
    if (logs.length > 0) console.error(logs.slice(-25).join('\n'));
    throw error;
  } finally {
    for (const page of pages) await page.close().catch(() => {});
    for (const server of servers) server.kill('SIGTERM');
  }
}

async function main() {
  const options = parseArguments(process.argv);
  if (options.mode === 'help') {
    console.log(USAGE.trim());
    return;
  }
  const plan = buildTerrainCanonicalPlan(options.selectedIds);
  if (options.mode === 'list') {
    printList(plan);
    return;
  }
  if (options.mode === 'plan') {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await capturePlan(plan, options);
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
