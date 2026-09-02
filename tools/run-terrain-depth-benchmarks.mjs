#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const appUrl = process.env.DRIFT_BENCH_URL ?? 'http://127.0.0.1:5203/';
const outputRoot = resolve(
  process.env.DRIFT_BENCH_OUTPUT ??
    join(root, 'evidence/terrain/depth-candidates'),
);
const rawRoot = join(outputRoot, 'raw');
const timeoutMs = 240_000;
const schedule = [
  ['a', 'conventional'],
  ['a', 'log'],
  ['a', 'reversed'],
  ['b', 'reversed'],
  ['b', 'log'],
  ['b', 'conventional'],
];

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function waitForFile(path, child, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`${label}: Chrome exited ${child.exitCode} before evidence arrived`);
    }
    try {
      const info = await stat(path);
      if (info.size > 0) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await sleep(1_000);
  }
  throw new Error(`${label}: timed out after ${timeoutMs / 1000}s`);
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`capture server exited ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/alive`);
      if (response.ok) return;
    } catch {
      // Server is still binding.
    }
    await sleep(100);
  }
  throw new Error(`capture server did not bind port ${port}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveClose) => child.once('close', resolveClose)),
    sleep(3_000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function runOne({ kind, repeat, mode, port, index }) {
  const label = `${kind}-${repeat}-${mode}`;
  const output = join(rawRoot, label);
  await mkdir(output, { recursive: true });
  const capture = spawn(
    process.execPath,
    [join(root, 'tools/capture-server.mjs'), output, String(port)],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  capture.stdout.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  capture.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  await waitForServer(port, capture);

  const profile = await mkdtemp(join(tmpdir(), `drift-terrain-${index}-`));
  const query = new URLSearchParams({
    perf: kind === 'baseline' ? 'terrain-baseline' : 'terrain-depth',
    capturePort: String(port),
    fixedDpr: '1',
    depth: mode,
  });
  let expected = 'performance.json';
  if (kind === 'occlusion') {
    query.set('terrain', 'synthetic');
    query.set('fixture', 'peak');
    query.set('range', '21');
    query.set('bearing', '-48');
    query.set('haze', '500');
    expected = 'paired-terrain-cost.json';
  }
  const url = new URL(appUrl);
  url.search = query.toString();
  process.stdout.write(`\n[${label}] ${url}\n`);
  const browser = spawn(
    chrome,
    [
      '--headless=new',
      '--enable-gpu',
      '--use-angle=metal',
      `--user-data-dir=${profile}`,
      '--window-size=1600,1000',
      '--disable-background-networking',
      '--no-first-run',
      url.toString(),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let chromeErrors = '';
  browser.stderr.on('data', (chunk) => {
    chromeErrors += String(chunk);
    if (chromeErrors.length > 16_000) chromeErrors = chromeErrors.slice(-16_000);
  });

  try {
    await waitForFile(join(output, expected), browser, label);
    const failure = join(output, `${kind === 'baseline' ? 'terrain-baseline' : 'terrain-depth'}-FAILED.txt`);
    try {
      throw new Error(await readFile(failure, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    throw new Error(`${error.message}\nChrome tail:\n${chromeErrors}`);
  } finally {
    await stop(browser);
    await stop(capture);
  }
  process.stdout.write(`[${label}] complete\n`);
  return { label, kind, repeat, mode, output, expected };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function poolSampleSummaries(summaries) {
  const count = summaries.reduce((sum, item) => sum + item.count, 0);
  const mean =
    summaries.reduce((sum, item) => sum + item.mean * item.count, 0) / count;
  const squaredError = summaries.reduce(
    (sum, item) =>
      sum +
      (item.count - 1) * item.standardDeviation ** 2 +
      item.count * (item.mean - mean) ** 2,
    0,
  );
  const standardDeviation = Math.sqrt(squaredError / Math.max(count - 1, 1));
  const standardError = standardDeviation / Math.sqrt(count);
  return {
    count,
    mean,
    standardDeviation,
    standardError,
    approximate95PercentInterval: [
      mean - 2 * standardError,
      mean + 2 * standardError,
    ],
  };
}

async function buildSummary(runs) {
  const raw = [];
  for (const run of runs) {
    const path = join(run.output, run.expected);
    const bytes = await readFile(path);
    const report = JSON.parse(bytes);
    if (run.kind === 'baseline') {
      const geometry = JSON.parse(
        await readFile(join(run.output, 'camera-geometry.json'), 'utf8'),
      );
      const buffer = geometry.views[0].drawingBuffer;
      if (buffer.width !== 1600 || buffer.height !== 913 || buffer.pixelRatio !== 1) {
        throw new Error(`${run.label}: rejected drawing buffer ${JSON.stringify(buffer)}`);
      }
    } else {
      const buffer = report.drawingBuffer;
      if (buffer.width !== 1600 || buffer.height !== 913 || buffer.pixelRatio !== 1) {
        throw new Error(`${run.label}: rejected drawing buffer ${JSON.stringify(buffer)}`);
      }
      if (report.depth.requested !== run.mode) {
        throw new Error(`${run.label}: report says depth=${report.depth.requested}`);
      }
    }
    raw.push({
      ...run,
      path: path.slice(outputRoot.length + 1),
      sha256: sha256(bytes),
      report,
    });
  }

  const baseline = {};
  for (const mode of ['conventional', 'log', 'reversed']) {
    const reports = raw.filter((run) => run.kind === 'baseline' && run.mode === mode);
    baseline[mode] = Object.fromEntries(
      reports[0].report.views.map((view, index) => [
        view.id,
        {
          label: view.label,
          runs: reports.map((run) => ({
            repeat: run.repeat,
            frameMedianMs: run.report.views[index].gpuMs.frame.median,
            frameStandardDeviationMs:
              run.report.views[index].gpuMs.frame.standardDeviation,
            oceanMedianMs: run.report.views[index].gpuMs.ocean.median,
            presentedFrameMedianMs:
              run.report.views[index].presentedFrameMs.median,
          })),
          frameMedianAcrossRunsMs: average(
            reports.map((run) => run.report.views[index].gpuMs.frame.median),
          ),
          oceanMedianAcrossRunsMs: average(
            reports.map((run) => run.report.views[index].gpuMs.ocean.median),
          ),
        },
      ]),
    );
  }

  const viewIds = Object.keys(baseline.conventional);
  const comparisons = Object.fromEntries(
    viewIds.map((id) => [
      id,
      {
        logMinusConventionalFrameMs:
          baseline.log[id].frameMedianAcrossRunsMs -
          baseline.conventional[id].frameMedianAcrossRunsMs,
        reversedMinusConventionalFrameMs:
          baseline.reversed[id].frameMedianAcrossRunsMs -
          baseline.conventional[id].frameMedianAcrossRunsMs,
        logMinusConventionalOceanMs:
          baseline.log[id].oceanMedianAcrossRunsMs -
          baseline.conventional[id].oceanMedianAcrossRunsMs,
        reversedMinusConventionalOceanMs:
          baseline.reversed[id].oceanMedianAcrossRunsMs -
          baseline.conventional[id].oceanMedianAcrossRunsMs,
      },
    ]),
  );

  const occlusion = {};
  for (const mode of ['conventional', 'log', 'reversed']) {
    const reports = raw.filter((run) => run.kind === 'occlusion' && run.mode === mode);
    const reportTiming = (report, key) =>
      key === 'terrainAndOceanPrefix'
        ? report.timings.terrainAndOceanPrefix ?? report.timings.ocean
        : report.timings[key];
    const summarizeKey = (key) => ({
      runs: reports.map((run) => ({
        repeat: run.repeat,
        pairedMeanMs: reportTiming(run.report, key).pairedOnMinusOffMs.mean,
        pairedMedianMs: reportTiming(run.report, key).pairedOnMinusOffMs.median,
        standardErrorMs: reportTiming(run.report, key).standardErrorMs,
      })),
      pooledPairedOnMinusOffMs: poolSampleSummaries(
        reports.map((run) => reportTiming(run.report, key).pairedOnMinusOffMs),
      ),
    });
    // `terrain`, `ocean` and `vessel` exist only in reports taken after
    // TERR-134 split the buckets; older ones carry the combined prefix alone,
    // which is why that key keeps its fallback above.
    const optionalKey = (key) =>
      reports.every((run) => run.report.timings[key]) ? summarizeKey(key) : undefined;
    occlusion[mode] = {
      depth: reports[0].report.depth,
      frame: summarizeKey('frame'),
      terrainAndOceanPrefix: summarizeKey('terrainAndOceanPrefix'),
      terrain: optionalKey('terrain'),
      ocean: optionalKey('ocean'),
      vessel: optionalKey('vessel'),
      sceneAndStars: summarizeKey('sceneAndStars'),
    };
  }

  const first = raw[0].report;
  return {
    generatedAtIso: new Date().toISOString(),
    purpose: 'TERR-111/112/113 quiet-GPU depth-strategy comparison',
    revision: process.env.DRIFT_BENCH_REVISION ?? 'working tree',
    device: first.device,
    userAgent: first.userAgent,
    drawingBuffer: { width: 1600, height: 913, pixelRatio: 1 },
    protocol: {
      baseline:
        'Two symmetric-order runs per mode; six R0 views; 24 retained six-frame rotations per view.',
      occlusion:
        'Two runs per mode; peak fixture at 21 km; 16 alternating hidden/visible pairs; 8 rotations per leg (rotation length is recorded per run as protocol.framesPerRotation); terrain submitted before the ocean via ?terrainOrder=before.',
      contention: 'All competing game/browser renderers stopped for the run.',
    },
    rawRuns: raw.map(({ label, kind, repeat, mode, path, sha256: hash }) => ({
      label,
      kind,
      repeat,
      mode,
      path,
      sha256: hash,
    })),
    baseline,
    comparisons,
    occlusion,
  };
}

await mkdir(rawRoot, { recursive: true });
const runs = [];
let index = 0;
for (const kind of ['baseline', 'occlusion']) {
  for (const [repeat, mode] of schedule) {
    const label = `${kind}-${repeat}-${mode}`;
    if (process.argv.includes('--summarize-only')) {
      runs.push({
        label,
        kind,
        repeat,
        mode,
        output: join(rawRoot, label),
        expected:
          kind === 'baseline' ? 'performance.json' : 'paired-terrain-cost.json',
      });
    } else {
      runs.push(
        await runOne({
          kind,
          repeat,
          mode,
          port: 5430 + index,
          index,
        }),
      );
    }
    index += 1;
  }
}
const summary = await buildSummary(runs);
await writeFile(
  join(outputRoot, 'performance.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`\nWrote ${join(outputRoot, 'performance.json')}\n`);
