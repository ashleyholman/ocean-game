#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CdpClient, reservePort, waitForHttp, waitForPageTarget } from './cdp.mjs';
import { hostSnapshot, printPreflight } from './preflight.mjs';
import { buildSuiteConfig, SUITES } from './suites.mjs';
import { CAMPAIGNS } from './campaigns.mjs';
import {
  startPowermetricsCapture,
  startThermalTimeline,
  summarizeThermalSamples,
} from './thermal.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASELINE_REVISION = '513fe5a';

function usage() {
  return `Cross-revision, GPU-fenced Drift benchmark

Usage:
  npm run perf:revisions -- 513fe5a HEAD
  npm run perf:revisions -- --revision 513fe5a --revision HEAD --suite representative
  npm run perf:revisions -- --range 513fe5a..HEAD --suite historical --rounds 2
  npm run perf:revisions -- --first-parent-range 38440b5..master --suite smoke --rounds 2

Options:
  --revision <rev>          Add one revision (repeatable)
  --range <start..end>      Expand an ancestry-path commit range, including start
  --first-parent-range <start..end>
                            Expand masterline commits only, including start
  --campaign <name>        Named unattended campaign: ${Object.keys(CAMPAIGNS).join(', ')}
  --dataset <id>           Dashboard dataset label (default: campaign name or timestamp)
  --suite <name>            ${Object.keys(SUITES).join(', ')} (default: representative)
  --rounds <n>              Repeat revisions in alternating order (default: 1)
  --output <dir>            Result directory (default: perf-results)
  --chrome <path>           Chrome executable
  --fence <pixel|full-frame>
  --warm-frames <n>
  --total-batches <n>
  --frames-per-batch <n>
  --attribution-pairs <n>
  --attribution-frames <n>
  --powermetrics            Capture privileged thermal/frequency/power sidecar
  --require-nominal-thermal Stop when thermal pressure or Low Power Mode appears
  --settle-seconds <n>      Quiet delay before each run preflight
  --strict-preflight        Refuse to start if likely GPU competitors are found
  --keep-workspaces         Keep temporary archived revisions for inspection
  --dry-run                 Resolve commits and print the run matrix only
  --help                    Show this help

The runner requires dependencies in the current worktree. Run npm ci once
before the first benchmark. It does not check out or modify measured commits.`;
}

function numberOption(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    revisions: [],
    ranges: [],
    firstParentRanges: [],
    campaign: undefined,
    dataset: undefined,
    suite: 'representative',
    rounds: 1,
    output: path.join(PROJECT_ROOT, 'perf-results'),
    chrome: DEFAULT_CHROME,
    strictPreflight: false,
    requireNominalThermal: false,
    settleSeconds: 0,
    powermetrics: false,
    keepWorkspaces: false,
    dryRun: false,
    measurement: {},
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--revision') options.revisions.push(next());
    else if (argument === '--range') options.ranges.push(next());
    else if (argument === '--first-parent-range') options.firstParentRanges.push(next());
    else if (argument === '--campaign') options.campaign = next();
    else if (argument === '--dataset') options.dataset = next();
    else if (argument === '--suite') options.suite = next();
    else if (argument === '--rounds') options.rounds = numberOption(next(), argument);
    else if (argument === '--output') options.output = path.resolve(PROJECT_ROOT, next());
    else if (argument === '--chrome') options.chrome = path.resolve(next());
    else if (argument === '--fence') options.measurement.fence = next();
    else if (argument === '--warm-frames') options.measurement.warmFrames = numberOption(next(), argument);
    else if (argument === '--total-batches') options.measurement.totalBatches = numberOption(next(), argument);
    else if (argument === '--frames-per-batch') options.measurement.framesPerBatch = numberOption(next(), argument);
    else if (argument === '--attribution-pairs') options.measurement.attributionPairs = numberOption(next(), argument);
    else if (argument === '--attribution-frames') options.measurement.attributionFrames = numberOption(next(), argument);
    else if (argument === '--powermetrics') options.powermetrics = true;
    else if (argument === '--require-nominal-thermal') options.requireNominalThermal = true;
    else if (argument === '--settle-seconds') options.settleSeconds = numberOption(next(), argument);
    else if (argument === '--strict-preflight') options.strictPreflight = true;
    else if (argument === '--keep-workspaces') options.keepWorkspaces = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`);
    else options.revisions.push(argument);
  }
  if (options.campaign) {
    const campaign = CAMPAIGNS[options.campaign];
    if (!campaign) {
      throw new Error(
        `Unknown campaign ${options.campaign}. Choose one of: ${Object.keys(CAMPAIGNS).join(', ')}`,
      );
    }
    if (
      options.revisions.length ||
      options.ranges.length ||
      options.firstParentRanges.length
    ) {
      throw new Error('--campaign cannot be combined with revisions or --range');
    }
    options.revisions = [...(campaign.revisions ?? [])];
    options.ranges = [...(campaign.ranges ?? [])];
    options.firstParentRanges = [...(campaign.firstParentRanges ?? [])];
    options.suite = campaign.suite;
    options.rounds = campaign.rounds;
    options.dataset ??= options.campaign;
  }
  if (options.dataset && !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(options.dataset)) {
    throw new Error('--dataset must use 1–80 letters, digits, dots, underscores, or hyphens');
  }
  if (!['pixel', 'full-frame'].includes(options.measurement.fence ?? 'pixel')) {
    throw new Error('--fence must be pixel or full-frame');
  }
  if (!options.help && !SUITES[options.suite]) {
    throw new Error(`Unknown suite ${options.suite}`);
  }
  return options;
}

async function git(args, options = {}) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: PROJECT_ROOT,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  return stdout.trim();
}

async function expandRange(specification) {
  const match = /^(.+)\.\.(.+)$/.exec(specification);
  if (!match) throw new Error(`Range must be start..end, got ${specification}`);
  const [, start, end] = match;
  const commits = await git(['rev-list', '--reverse', '--ancestry-path', `${start}..${end}`]);
  return [start, ...commits.split('\n').filter(Boolean)];
}

async function expandFirstParentRange(specification) {
  const match = /^(.+)\.\.(.+)$/.exec(specification);
  if (!match) {
    throw new Error(
      `First-parent range must be start..end, got ${specification}`,
    );
  }
  const [, start, end] = match;
  const commits = await git([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${start}..${end}`,
  ]);
  return [start, ...commits.split('\n').filter(Boolean)];
}

async function revisionMetadata(revision) {
  const format = ['%H', '%h', '%cI', '%s'].join('%x00');
  const output = await git(['show', '-s', `--format=${format}`, revision]);
  const [hash, shortHash, committedAt, subject] = output.split('\0');
  let ordinalFromBaseline;
  try {
    await git(['merge-base', '--is-ancestor', BASELINE_REVISION, hash]);
    ordinalFromBaseline = Number(await git(['rev-list', '--count', `${BASELINE_REVISION}..${hash}`]));
  } catch {
    ordinalFromBaseline = undefined;
  }
  return { requested: revision, hash, shortHash, committedAt, subject, ordinalFromBaseline };
}

async function resolveRevisions(options) {
  const requested = [...options.revisions];
  for (const range of options.ranges) requested.push(...(await expandRange(range)));
  for (const range of options.firstParentRanges) {
    requested.push(...(await expandFirstParentRange(range)));
  }
  if (requested.length === 0) requested.push(BASELINE_REVISION, 'HEAD');
  const resolved = [];
  const seen = new Set();
  for (const revision of requested) {
    const metadata = await revisionMetadata(revision);
    if (seen.has(metadata.hash)) continue;
    seen.add(metadata.hash);
    resolved.push(metadata);
  }
  return resolved;
}

function waitForExit(child, name) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    });
  });
}

async function extractRevision(hash, target) {
  await mkdir(target, { recursive: true });
  const archive = spawn('git', ['archive', '--format=tar', hash], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extractor = spawn('tar', ['-x', '-C', target], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  archive.stdout.pipe(extractor.stdin);
  let archiveError = '';
  let extractorError = '';
  archive.stderr.on('data', (chunk) => (archiveError += chunk));
  extractor.stderr.on('data', (chunk) => (extractorError += chunk));
  await Promise.all([
    waitForExit(archive, 'git archive'),
    waitForExit(extractor, 'tar'),
  ]).catch((error) => {
    throw new Error(`${error.message}\n${archiveError}${extractorError}`);
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function consoleText(entry) {
  return (entry?.args ?? [])
    .map((argument) => argument.value ?? argument.description ?? '')
    .join(' ');
}

function validateBrowserResult(result, config) {
  const buffer = result.environment?.drawingBuffer;
  if (
    buffer?.width !== config.renderSurface.backingWidth ||
    buffer?.height !== config.renderSurface.backingHeight
  ) {
    throw new Error(
      `Rejected result with ${buffer?.width}×${buffer?.height} drawing buffer`,
    );
  }
  const oceanTriangles = result.environment?.oceanGeometry?.triangles;
  // The historical desktop preset uses a 288×288 ocean grid (165,888
  // triangles). A headless 1280×720 outer window has only ~633 CSS px of
  // content height, which made older revisions silently select the 160×160
  // mobile grid (51,200 triangles) before the harness resized the backing
  // store. Reject that class of cross-revision mismatch explicitly.
  if (!Number.isFinite(oceanTriangles) || oceanTriangles < 100_000) {
    throw new Error(
      `Rejected non-desktop ocean geometry (${oceanTriangles ?? 'unknown'} triangles); ` +
      'bootstrap viewport did not select the historical desktop tier',
    );
  }
  for (const scenario of result.scenarios ?? []) {
    const summary = scenario.total?.summary;
    // At 3.69 million pixels this scene cannot plausibly render in under a
    // millisecond on the M2. Such a value means the synchronous readback was
    // redirected or otherwise failed to fence queued GPU work.
    if (!Number.isFinite(summary?.median) || summary.median < 1) {
      throw new Error(
        `Rejected implausible ${scenario.id} median ${summary?.median} ms; GPU fence did not hold`,
      );
    }
  }
}

async function runOne(
  metadata,
  config,
  options,
  round,
  runPreflight,
  thermalTimeline,
  thermalMark,
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `drift-perf-${metadata.shortHash}-`));
  // Keep Chrome's constantly changing profile outside the Vite root. Putting
  // it below the archived source makes Vite's watcher consume CPU and can even
  // trigger reload work in the page being measured.
  const profile = await mkdtemp(path.join(os.tmpdir(), `drift-perf-chrome-${metadata.shortHash}-`));
  const appUrlPrefix = 'http://127.0.0.1:';
  let vite;
  let chrome;
  let cdp;
  const logs = [];
  try {
    await extractRevision(metadata.hash, workspace);
    await mkdir(path.join(workspace, 'tools', 'perf'), { recursive: true });
    await copyFile(path.join(HERE, 'browser-harness.js'), path.join(workspace, 'tools', 'perf', 'browser-harness.js'));
    await symlink(path.join(PROJECT_ROOT, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
    const vitePort = await reservePort();
    const debugPort = await reservePort();
    const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
    vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(vitePort), '--strictPort', '--force'], {
      cwd: workspace,
      env: { ...process.env, PORT: String(vitePort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout.on('data', (chunk) => logs.push(`[vite] ${chunk.toString().trim()}`));
    vite.stderr.on('data', (chunk) => logs.push(`[vite:err] ${chunk.toString().trim()}`));
    await waitForHttp(`http://127.0.0.1:${vitePort}/`, 60_000);

    const appUrl = `${appUrlPrefix}${vitePort}/?fixedDpr=2&quality=desktop&revisionPerf=1`;
    chrome = spawn(
      options.chrome,
      [
        '--headless=new',
        '--enable-gpu',
        '--use-angle=metal',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--no-first-run',
        '--no-default-browser-check',
        '--force-device-scale-factor=1',
        // Match the documented Metal benchmark launch. The harness later sets
        // the renderer to 1280×720 at DPR 2, producing the exact 2560×1440
        // measured backing store. This larger bootstrap viewport is required
        // for revisions predating the explicit quality=desktop override.
        '--window-size=1600,1000',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        appUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    chrome.stdout.on('data', (chunk) => logs.push(`[chrome] ${chunk.toString().trim()}`));
    chrome.stderr.on('data', (chunk) => logs.push(`[chrome:err] ${chunk.toString().trim()}`));

    const target = await waitForPageTarget(debugPort, `${appUrlPrefix}${vitePort}/`, 60_000);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.consoleAPICalled', (event) => logs.push(`[browser:${event.type}] ${consoleText(event)}`));
    cdp.on('Runtime.exceptionThrown', (event) => logs.push(`[browser:exception] ${event.exceptionDetails?.text ?? 'unknown'}`));
    await cdp.call('Runtime.enable');

    const expression = `(async () => {
      const module = await import('/tools/perf/browser-harness.js?run=${Date.now()}');
      return await module.run(${JSON.stringify(config)});
    })()`;
    const evaluated = await cdp.call(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: false },
      20 * 60_000,
    );
    if (evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text;
      throw new Error(`Browser benchmark failed: ${detail}`);
    }
    const browserResult = evaluated.result?.value;
    if (!browserResult?.scenarios) throw new Error('Browser benchmark returned no scenario data');
    validateBrowserResult(browserResult, config);

    const thermalSamples = thermalTimeline.samplesSince(thermalMark);
    const thermal = thermalTimeline.available
      ? {
          available: true,
          source: thermalTimeline.source,
          intervalMs: thermalTimeline.intervalMs,
          samples: thermalSamples,
          summary: summarizeThermalSamples(thermalSamples),
          monitorError: thermalTimeline.error?.(),
        }
      : {
          available: false,
          source: thermalTimeline.source,
          reason: thermalTimeline.reason,
        };

    const result = {
      schemaVersion: 1,
      revision: metadata,
      round,
      host: runPreflight,
      thermal,
      browser: browserResult,
      runner: {
        dataset: options.dataset,
        node: process.version,
        chromeExecutable: options.chrome,
        chromeFlags: [
          '--headless=new',
          '--enable-gpu',
          '--use-angle=metal',
          '--window-size=1600,1000',
        ],
        sourceHarnessSha256: createHash('sha256')
          .update(await readFile(path.join(HERE, 'browser-harness.js')))
          .digest('hex'),
        powermetrics: options.powermetricsMetadata,
        requireNominalThermal: options.requireNominalThermal,
        settleSeconds: options.settleSeconds,
      },
    };
    await mkdir(options.output, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${stamp}_${metadata.shortHash}_${config.suite}_r${round}.json`;
    const targetPath = path.join(options.output, filename);
    await writeFile(targetPath, `${JSON.stringify(result, null, 2)}\n`);
    return { targetPath, result };
  } catch (error) {
    if (logs.length) process.stderr.write(`${logs.join('\n')}\n`);
    throw error;
  } finally {
    cdp?.close();
    await terminate(chrome);
    await terminate(vite);
    if (options.keepWorkspaces) process.stdout.write(`kept workspace ${workspace}\n`);
    else if (path.basename(workspace).startsWith(`drift-perf-${metadata.shortHash}-`)) {
      await rm(workspace, { recursive: true, force: true });
    }
    if (!options.keepWorkspaces && path.basename(profile).startsWith(`drift-perf-chrome-${metadata.shortHash}-`)) {
      await rm(profile, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  options.dataset ??= `adhoc-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const revisions = await resolveRevisions(options);
  const config = buildSuiteConfig(options.suite, options.measurement);
  const sequence = [];
  for (let round = 1; round <= options.rounds; round++) {
    const ordered = round % 2 === 1 ? revisions : [...revisions].reverse();
    for (const revision of ordered) sequence.push({ revision, round });
  }

  process.stdout.write(
    `suite ${config.suite}: ${config.scenarios.length} scenarios · ` +
      `${config.renderSurface.backingWidth}×${config.renderSurface.backingHeight} · ` +
      `${config.measurement.fence} readPixels fence\n`,
  );
  for (const { revision, round } of sequence) {
    process.stdout.write(`  round ${round}: ${revision.shortHash} ${revision.subject}\n`);
  }
  if (options.dryRun) return;

  const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
  if (!existsSync(viteBin)) {
    throw new Error(`Dependencies are missing. Run “npm ci” in ${PROJECT_ROOT} before benchmarking.`);
  }
  if (!existsSync(options.chrome)) throw new Error(`Chrome executable not found: ${options.chrome}`);

  if (options.settleSeconds > 0) {
    process.stdout.write(`settling ${options.settleSeconds} seconds before initial preflight…\n`);
    await new Promise((resolve) => setTimeout(resolve, options.settleSeconds * 1_000));
  }
  const preflight = await hostSnapshot();
  printPreflight(preflight);
  if (
    options.strictPreflight &&
    (preflight.inventoryError || preflight.competitors.length > 0)
  ) {
    throw new Error(
      'Strict preflight requires a successful, empty GPU process inventory.',
    );
  }
  if (
    options.requireNominalThermal &&
    (!preflight.thermal?.available ||
      preflight.thermal.thermalStateRaw !== 0 ||
      preflight.thermal.lowPowerMode)
  ) {
    throw new Error(
      `Nominal thermal policy requires an available nominal state with Low Power Mode off; ` +
        `preflight reported ${preflight.thermal?.thermalState ?? 'unavailable'}` +
        `${preflight.thermal?.lowPowerMode ? ' with Low Power Mode on' : ''}.`,
    );
  }

  await mkdir(options.output, { recursive: true });
  const powermetrics = await startPowermetricsCapture({
    enabled: options.powermetrics,
    outputDirectory: options.output,
    dataset: options.dataset,
  });
  options.powermetricsMetadata = powermetrics.metadata;
  if (options.powermetrics) {
    process.stdout.write(
      powermetrics.metadata.available
        ? `powermetrics active → ${powermetrics.metadata.sidecar}\n`
        : `powermetrics unavailable: ${powermetrics.metadata.reason}\n`,
    );
  }
  const thermalTimeline = await startThermalTimeline();
  process.stdout.write(
    thermalTimeline.available
      ? `thermal timeline active · ${thermalTimeline.intervalMs} ms ProcessInfo samples\n`
      : `thermal timeline unavailable: ${thermalTimeline.reason}\n`,
  );
  try {
    for (let index = 0; index < sequence.length; index++) {
      const { revision, round } = sequence[index];
      if (index > 0 && options.settleSeconds > 0) {
        process.stdout.write(`settling ${options.settleSeconds} seconds before next preflight…\n`);
        await new Promise((resolve) => setTimeout(resolve, options.settleSeconds * 1_000));
      }
      const runPreflight = await hostSnapshot();
      if (
        options.strictPreflight &&
        (runPreflight.inventoryError || runPreflight.competitors.length > 0)
      ) {
        printPreflight(runPreflight);
        throw new Error(
          `Strict preflight requires a successful, empty GPU process inventory before ${revision.shortHash}.`,
        );
      }
      if (
        options.requireNominalThermal &&
        (!runPreflight.thermal?.available ||
          runPreflight.thermal.thermalStateRaw !== 0 ||
          runPreflight.thermal.lowPowerMode)
      ) {
        throw new Error(
          `Nominal thermal policy stopped before ${revision.shortHash} round ${round}: ` +
            `${runPreflight.thermal?.thermalState ?? 'unavailable'} thermal state` +
            `${runPreflight.thermal?.lowPowerMode ? ' with Low Power Mode on' : ''}.`,
        );
      }
      const thermalMark = thermalTimeline.mark();
      process.stdout.write(
        `[${index + 1}/${sequence.length}] ${revision.shortHash} round ${round} starting` +
          `${runPreflight.thermal?.available ? ` · thermal ${runPreflight.thermal.thermalState}` : ''}…\n`,
      );
      const { targetPath, result } = await runOne(
        revision,
        config,
        options,
        round,
        runPreflight,
        thermalTimeline,
        thermalMark,
      );
      const primary = result.browser.scenarios[0];
      const thermalSummary = result.thermal.summary;
      process.stdout.write(
        `[${index + 1}/${sequence.length}] ${revision.shortHash} ` +
          `${primary.id} median ${primary.total.summary.median.toFixed(2)} ms` +
          `${thermalSummary?.maximumState ? ` · thermal ${thermalSummary.maximumState}` : ''}` +
          ` → ${targetPath}\n`,
      );
      if (
        options.requireNominalThermal &&
        (!thermalSummary ||
          thermalSummary.maximumStateRaw !== 0 ||
          thermalSummary.lowPowerModeSeen)
      ) {
        throw new Error(
          `Nominal thermal policy stopped after saving ${revision.shortHash} round ${round}: ` +
            `${thermalSummary?.maximumState ?? 'unavailable'} maximum thermal state` +
            `${thermalSummary?.lowPowerModeSeen ? ' with Low Power Mode on' : ''}.`,
        );
      }
    }
  } finally {
    await thermalTimeline.stop();
    await powermetrics.stop();
  }
  process.stdout.write(`Done. Start “npm run perf:dashboard” to inspect ${options.output}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
