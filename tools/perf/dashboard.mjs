#!/usr/bin/env node

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LAST_BENCHMARKED_MASTER } from './campaigns.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const execFileAsync = promisify(execFile);
let cachedMasterFirstParentOrder;

async function loadMasterFirstParentOrder() {
  if (cachedMasterFirstParentOrder) return cachedMasterFirstParentOrder;
  try {
    const [{ stdout }, { stdout: priorEndpoint }] = await Promise.all([
      execFileAsync(
        'git',
        ['rev-list', '--first-parent', '--reverse', `${LAST_BENCHMARKED_MASTER}..master`],
        { cwd: PROJECT_ROOT, maxBuffer: 16 * 1024 * 1024 },
      ),
      execFileAsync('git', ['rev-parse', LAST_BENCHMARKED_MASTER], {
        cwd: PROJECT_ROOT,
      }),
    ]);
    const hashes = [priorEndpoint.trim(), ...stdout.trim().split('\n').filter(Boolean)];
    cachedMasterFirstParentOrder = new Map(
      hashes.map((hash, index) => [hash, index]),
    );
    return cachedMasterFirstParentOrder;
  } catch {
    // A copied result directory remains viewable outside the source repository.
    cachedMasterFirstParentOrder = new Map();
    return cachedMasterFirstParentOrder;
  }
}

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 4180,
    results: path.join(PROJECT_ROOT, 'perf-results'),
    check: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === '--host') options.host = next();
    else if (argument === '--port') options.port = Number(next());
    else if (argument === '--results') options.results = path.resolve(PROJECT_ROOT, next());
    else if (argument === '--check') options.check = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be between 1 and 65535');
  }
  return options;
}

async function loadResults(directory) {
  const masterFirstParentOrder = await loadMasterFirstParentOrder();
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const results = [];
  const errors = [];
  for (const name of names) {
    try {
      const result = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      if (!result.revision?.hash || !result.browser?.scenarios) {
        throw new Error('missing revision or browser scenarios');
      }
      result.revision.masterFirstParentOrdinal =
        masterFirstParentOrder.get(result.revision.hash);
      results.push({ file: name, ...result });
    } catch (error) {
      errors.push({ file: name, error: String(error) });
    }
  }
  return { generatedAt: new Date().toISOString(), directory, results, errors };
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Drift GPU benchmark</title>
  <style>
    :root { color-scheme: light dark; --bg: light-dark(#f5f7f8, #101517); --fg: light-dark(#172126, #e6edef); --muted: light-dark(#5f6f76, #9eb0b6); --panel: light-dark(#ffffff, #182125); --border: light-dark(#d8e0e3, #344249); --accent: light-dark(#087f8c, #5bc7d1); --reference: light-dark(#b75d10, #f3a45e); --bad: light-dark(#b42318, #ff8178); }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px 20px 60px; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
    h1 { margin: 0; font: 600 24px/1.15 system-ui, sans-serif; }
    h2 { margin: 28px 0 10px; font: 600 17px/1.2 system-ui, sans-serif; }
    p { margin: 6px 0; }
    .muted { color: var(--muted); }
    .controls { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; }
    label { display: grid; gap: 5px; color: var(--muted); }
    select { min-width: 300px; padding: 7px 9px; color: var(--fg); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; }
    .selection { margin-top: 18px; padding: 14px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
    .selection-title { font: 600 15px/1.3 system-ui, sans-serif; }
    .selection-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 12px; }
    .selection-item { min-width: 0; }
    .selection-key { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .selection-value { margin-top: 3px; color: var(--fg); }
    .notice { margin-top: 18px; padding: 10px 12px; border-left: 3px solid var(--reference); background: var(--panel); }
    .notice.bad { border-color: var(--bad); }
    .chart { margin-top: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    svg { width: 100%; height: auto; min-height: 330px; display: block; }
    .axis, .grid { stroke: var(--border); stroke-width: 1; }
    .grid { opacity: .65; }
    .series { fill: none; stroke: var(--accent); stroke-width: 2.5; }
    .point { fill: var(--panel); stroke: var(--accent); stroke-width: 2.5; }
    .point.thermal-fair { stroke: var(--reference); }
    .point.thermal-serious, .point.thermal-critical { stroke: var(--bad); fill: var(--bad); }
    .error { stroke: var(--accent); stroke-width: 1.25; opacity: .7; }
    .reference { stroke: var(--reference); stroke-width: 1.5; stroke-dasharray: 6 5; }
    .svg-label { fill: var(--muted); font-size: 12px; }
    .svg-value { fill: var(--fg); font-size: 12px; font-weight: 600; }
    .legend { display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 14px; border-top: 1px solid var(--border); color: var(--muted); }
    .swatch { display: inline-block; width: 18px; height: 2px; margin: 0 7px 3px 0; background: var(--accent); }
    .swatch.reference { background: var(--reference); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; }
    th, td { padding: 9px 11px; text-align: right; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
    th { color: var(--muted); font-weight: 500; }
    th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; }
    tr:last-child td { border-bottom: 0; }
    .positive { color: var(--bad); }
    .negative { color: var(--accent); }
    code { color: var(--fg); }
    @media (max-width: 820px) { .selection-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 640px) { main { padding: 20px 12px 40px; } select { width: 100%; min-width: 0; } .controls { width: 100%; } label { width: 100%; } .selection-grid { grid-template-columns: 1fr; gap: 10px; } th, td { padding: 8px; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Drift cross-revision GPU benchmark</h1>
      <p id="status" class="muted">Waiting for results…</p>
    </div>
    <div class="controls">
      <label>Dataset<select id="dataset"></select></label>
      <label>Test case<select id="scenario"></select></label>
    </div>
  </header>
  <div id="warnings"></div>
  <div id="selection" class="selection"></div>
  <section>
    <h2>GPU-fenced frame time</h2>
    <div class="chart">
      <svg id="chart" viewBox="0 0 1080 390" role="img" aria-label="Frame time by revision"></svg>
      <div id="legend" class="legend"></div>
    </div>
  </section>
  <section>
    <h2>Measurements</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Revision</th><th>Round</th><th>Median</th><th>Mean ± SD</th><th>p05–p95</th><th>Δ first</th><th>Ocean Δ</th><th>Vessel Δ</th><th>Thermal</th><th>Buffer</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </section>
</main>
<script>
  const scenarioSelect = document.getElementById('scenario');
  const datasetSelect = document.getElementById('dataset');
  const status = document.getElementById('status');
  const warnings = document.getElementById('warnings');
  const selection = document.getElementById('selection');
  const chart = document.getElementById('chart');
  const rows = document.getElementById('rows');
  const legend = document.getElementById('legend');
  let lastPayload = null;

  function esc(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]; }); }
  function fmt(value, digits) { return Number.isFinite(value) ? value.toFixed(digits == null ? 2 : digits) : '—'; }
  function deltaClass(value) { return value > 0.05 ? 'positive' : value < -0.05 ? 'negative' : ''; }
  const thermalRanks = { nominal: 0, fair: 1, serious: 2, critical: 3 };

  function runThermal(run) {
    const summary = run.thermal && run.thermal.summary;
    if (summary && summary.sampleCount > 0) return summary;
    const snapshot = run.host && run.host.thermal;
    if (snapshot && snapshot.available) {
      return {
        sampleCount: 1,
        startState: snapshot.thermalState,
        endState: snapshot.thermalState,
        maximumState: snapshot.thermalState,
        maximumStateRaw: snapshot.thermalStateRaw,
        lowPowerModeSeen: snapshot.lowPowerMode
      };
    }
    return null;
  }

  function thermalText(run) {
    const thermal = runThermal(run);
    if (!thermal) return 'not recorded';
    const transition = thermal.startState === thermal.endState
      ? thermal.endState
      : thermal.startState + '→' + thermal.endState;
    return transition + (thermal.maximumState !== thermal.endState ? ' · max ' + thermal.maximumState : '') +
      (thermal.lowPowerModeSeen ? ' · low power' : '');
  }

  const suiteDescriptions = {
    smoke: {
      label: 'Commit history',
      detail: 'One fixed late-morning, production-sea, medium-camera test across selected revisions.'
    },
    historical: {
      label: 'Time-of-day checkpoints',
      detail: 'Late morning, sunset and night at production sea and medium camera across selected revisions.'
    },
    representative: {
      label: 'Baseline vs current',
      detail: 'Two repeated endpoint rounds across time of day, sea conditions and camera distance.'
    },
    'southern-afternoon': {
      label: 'Southern Ocean afternoon history',
      detail: 'One fixed mid-afternoon, Southern Ocean rough-sea, medium-camera test across feature-boundary revisions.'
    },
    full: {
      label: 'Full matrix',
      detail: 'Every time-of-day × sea-condition × camera combination.'
    }
  };

  function suiteName(name) {
    const spec = suiteDescriptions[name];
    return spec ? spec.label + ' (' + name + ')' : name;
  }

  function datasetId(run) {
    return run.runner && run.runner.dataset || run.browser.suite;
  }

  function datasetName(run) {
    return datasetId(run) + ' · ' + suiteName(run.browser.suite);
  }

  function timeName(scenario) {
    if (scenario.id.startsWith('afternoon-')) return 'Mid-afternoon';
    if (scenario.id.startsWith('day-')) return 'Late morning';
    if (scenario.id.startsWith('sunset-')) return 'Sunset';
    if (scenario.id.startsWith('night-')) return 'Night';
    return scenario.state && scenario.state.requested && scenario.state.requested.time || 'Unknown time';
  }

  function scenarioName(scenario) {
    const requested = scenario.state && scenario.state.requested || {};
    const sea = requested.seaLabel || requested.seaState || 'Unknown sea';
    const camera = requested.camera && requested.camera.label || 'Unknown camera';
    return 'Time: ' + timeName(scenario) + ' · Sea: ' + sea + ' · Camera: ' + camera;
  }

  function localWorldTime(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(seconds * 1000));
  }

  function renderSelection(items, suite) {
    if (!items.length) {
      selection.innerHTML = '<span class="muted">No measurements for this test case.</span>';
      return;
    }
    const scenario = items[0].scenario;
    const requested = scenario.state.requested || {};
    const actual = scenario.state.actual || {};
    const camera = requested.camera || {};
    const buffer = actual.drawingBuffer || items[0].run.browser.environment.drawingBuffer || {};
    const suiteSpec = suiteDescriptions[suite] || { label: suite, detail: '' };
    const revisionCount = new Set(items.map(function (item) { return item.run.revision.hash; })).size;
    const roundCount = new Set(items.map(function (item) { return item.run.round; })).size;
    const coverage = items.length + ' chart points = ' + revisionCount + ' revision' + (revisionCount === 1 ? '' : 's') +
      (roundCount > 1 ? ' × ' + roundCount + ' repeated rounds' : ' × 1 run each') + '.' +
      (suite === 'representative' ? ' Intermediate commits were not measured for this sea/camera combination.' : '');
    const solarValues = items.map(function (item) { return item.scenario.state.actual.solarElevationDeg; }).filter(Number.isFinite);
    const solarMin = solarValues.length ? Math.min.apply(Math, solarValues) : undefined;
    const solarMax = solarValues.length ? Math.max.apply(Math, solarValues) : undefined;
    const solar = Number.isFinite(solarMin)
      ? (Math.abs(solarMax - solarMin) < 0.05 ? fmt(solarMin, 1) + '° elevation' : fmt(solarMin, 1) + '–' + fmt(solarMax, 1) + '° elevation')
      : 'solar elevation unavailable';
    const thermalSummaries = items.map(function (item) { return runThermal(item.run); }).filter(Boolean);
    const maximumThermal = thermalSummaries.reduce(function (maximum, item) {
      return (item.maximumStateRaw ?? thermalRanks[item.maximumState] ?? -1) > (thermalRanks[maximum] ?? -1)
        ? item.maximumState
        : maximum;
    }, 'unknown');
    const thermalCoverage = thermalSummaries.length
      ? maximumThermal + ' maximum · ' + thermalSummaries.length + '/' + items.length + ' runs sampled'
      : 'not recorded for this dataset';
    selection.innerHTML =
      '<div class="selection-title">' + esc(suiteSpec.label) + '</div>' +
      '<p class="muted">' + esc(suiteSpec.detail) + ' The chart and table below show only the selected test case.<br><strong>' + esc(coverage) + '</strong></p>' +
      '<div class="selection-grid">' +
        '<div class="selection-item"><div class="selection-key">Time</div><div class="selection-value">' + esc(timeName(scenario)) + '<br><span class="muted">' + esc(localWorldTime(actual.worldInstantUtcSeconds)) + ' · sun ' + esc(solar) + '</span></div></div>' +
        '<div class="selection-item"><div class="selection-key">Sea</div><div class="selection-value">' + esc(requested.seaLabel || requested.seaState) + '<br><span class="muted">' + esc(requested.seaState) + '</span></div></div>' +
        '<div class="selection-item"><div class="selection-key">Camera</div><div class="selection-value">' + esc(camera.label) + '<br><span class="muted">requested ' + esc(camera.distanceM) + ' m distance · ' + esc(camera.altitudeM) + ' m altitude</span></div></div>' +
        '<div class="selection-item"><div class="selection-key">Render target</div><div class="selection-value">' + esc(buffer.width + '×' + buffer.height) + '<br><span class="muted">DPR ' + esc(actual.pixelRatio) + ' · GPU-fenced</span></div></div>' +
        '<div class="selection-item"><div class="selection-key">Thermal state</div><div class="selection-value">' + esc(thermalCoverage) + '<br><span class="muted">macOS ProcessInfo timeline</span></div></div>' +
      '</div>';
  }

  function flatten(payload, scenarioId, dataset) {
    return payload.results.map(function (run) {
      if (datasetId(run) !== dataset) return null;
      const scenario = run.browser.scenarios.find(function (item) { return item.id === scenarioId; });
      if (!scenario) return null;
      return { run: run, scenario: scenario };
    }).filter(Boolean).sort(function (a, b) {
      const am = a.run.revision.masterFirstParentOrdinal;
      const bm = b.run.revision.masterFirstParentOrdinal;
      if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am - bm;
      const ao = a.run.revision.ordinalFromBaseline;
      const bo = b.run.revision.ordinalFromBaseline;
      if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
      const date = String(a.run.revision.committedAt).localeCompare(String(b.run.revision.committedAt));
      return date || a.run.round - b.run.round;
    });
  }

  function renderChart(items) {
    if (!items.length) { chart.innerHTML = '<text x="540" y="195" text-anchor="middle" class="svg-label">No data for this scenario</text>'; return; }
    const width = 1080, height = 390, left = 72, right = 28, top = 34, bottom = 72;
    const plotW = width - left - right, plotH = height - top - bottom;
    const values = [];
    items.forEach(function (item) {
      const summary = item.scenario.total.summary;
      values.push(summary.p05, summary.p95, summary.median);
      if (Number.isFinite(item.scenario.historicalReferenceMs)) values.push(item.scenario.historicalReferenceMs);
    });
    let min = Math.min.apply(Math, values), max = Math.max.apply(Math, values);
    const pad = Math.max((max - min) * 0.18, 1);
    min = Math.max(0, min - pad); max += pad;
    const x = function (index) { return left + (items.length === 1 ? plotW / 2 : index * plotW / (items.length - 1)); };
    const y = function (value) { return top + (max - value) * plotH / (max - min); };
    let svg = '<title>GPU-fenced frame time by revision</title><desc>Median frame times with p05 to p95 error bars. Lower is faster.</desc>';
    for (let tick = 0; tick <= 5; tick++) {
      const value = min + (max - min) * tick / 5;
      const yy = y(value);
      svg += '<line class="grid" x1="' + left + '" x2="' + (width-right) + '" y1="' + yy + '" y2="' + yy + '"></line>';
      svg += '<text class="svg-label" x="' + (left-10) + '" y="' + (yy+4) + '" text-anchor="end">' + fmt(value, 1) + '</text>';
    }
    const reference = items.map(function (item) { return item.scenario.historicalReferenceMs; }).find(Number.isFinite);
    if (Number.isFinite(reference)) {
      svg += '<line class="reference" x1="' + left + '" x2="' + (width-right) + '" y1="' + y(reference) + '" y2="' + y(reference) + '"></line>';
      svg += '<text class="svg-label" x="' + (width-right) + '" y="' + (y(reference)-7) + '" text-anchor="end">historical ' + fmt(reference) + ' ms</text>';
    }
    const points = items.map(function (item, index) { return x(index) + ',' + y(item.scenario.total.summary.median); }).join(' ');
    if (items.length > 1) svg += '<polyline class="series" points="' + points + '"></polyline>';
    const labelStep = Math.max(1, Math.ceil(items.length / 12));
    items.forEach(function (item, index) {
      const xx = x(index), summary = item.scenario.total.summary, yy = y(summary.median);
      svg += '<line class="error" x1="' + xx + '" x2="' + xx + '" y1="' + y(summary.p05) + '" y2="' + y(summary.p95) + '"></line>';
      svg += '<line class="error" x1="' + (xx-5) + '" x2="' + (xx+5) + '" y1="' + y(summary.p05) + '" y2="' + y(summary.p05) + '"></line>';
      svg += '<line class="error" x1="' + (xx-5) + '" x2="' + (xx+5) + '" y1="' + y(summary.p95) + '" y2="' + y(summary.p95) + '"></line>';
      const thermal = runThermal(item.run);
      const thermalClass = thermal ? ' thermal-' + thermal.maximumState : '';
      svg += '<circle class="point' + thermalClass + '" cx="' + xx + '" cy="' + yy + '" r="5"><title>' + esc(item.run.revision.shortHash + ' · ' + fmt(summary.median) + ' ms · thermal ' + thermalText(item.run)) + '</title></circle>';
      if (items.length <= 15) svg += '<text class="svg-value" x="' + xx + '" y="' + (yy-11) + '" text-anchor="middle">' + fmt(summary.median) + '</text>';
      if (index % labelStep === 0 || index === items.length - 1) {
        svg += '<text class="svg-label" x="' + xx + '" y="' + (height-bottom+27) + '" text-anchor="middle">' + esc(item.run.revision.shortHash) + '</text>';
        if (item.run.round > 1) svg += '<text class="svg-label" x="' + xx + '" y="' + (height-bottom+45) + '" text-anchor="middle">r' + item.run.round + '</text>';
      }
    });
    svg += '<text class="svg-label" x="18" y="' + (top + plotH/2) + '" transform="rotate(-90 18 ' + (top + plotH/2) + ')" text-anchor="middle">ms / frame</text>';
    chart.innerHTML = svg;
    legend.innerHTML = '<span><i class="swatch"></i>median; whisker p05–p95</span>' + (Number.isFinite(reference) ? '<span><i class="swatch reference"></i>accepted 2026-08-03 baseline</span>' : '');
  }

  function renderTable(items) {
    const first = items[0] ? items[0].scenario.total.summary.median : undefined;
    rows.innerHTML = items.map(function (item) {
      const run = item.run, scenario = item.scenario, summary = scenario.total.summary;
      const ocean = scenario.attribution.ocean && scenario.attribution.ocean.pairedDelta;
      const vesselSource = scenario.attribution.vesselTarget && scenario.attribution.vesselTarget.activeInScene
        ? (scenario.attribution.vesselOnly || scenario.attribution.vesselIsolated || scenario.attribution.vessel)
        : null;
      const vessel = vesselSource && vesselSource.pairedDelta;
      const buffer = scenario.state.actual.drawingBuffer || run.browser.environment.drawingBuffer;
      const delta = summary.median - first;
      return '<tr>' +
        '<td><code>' + esc(run.revision.shortHash) + '</code> ' + esc(run.revision.subject) + '</td>' +
        '<td>' + esc(run.round) + '</td>' +
        '<td>' + fmt(summary.median) + ' ms</td>' +
        '<td>' + fmt(summary.mean) + ' ± ' + fmt(summary.sd) + '</td>' +
        '<td>' + fmt(summary.p05) + '–' + fmt(summary.p95) + '</td>' +
        '<td class="' + deltaClass(delta) + '">' + (delta >= 0 ? '+' : '') + fmt(delta) + '</td>' +
        '<td>' + (ocean ? fmt(ocean.median) + ' ± ' + fmt(ocean.sd) : '—') + '</td>' +
        '<td>' + (vessel ? fmt(vessel.median) + ' ± ' + fmt(vessel.sd) : '—') + '</td>' +
        '<td>' + esc(thermalText(run)) + '</td>' +
        '<td>' + esc(buffer.width + '×' + buffer.height) + '</td>' +
      '</tr>';
    }).join('');
  }

  function render(payload) {
    lastPayload = payload;
    const previousDataset = datasetSelect.value;
    const datasetRuns = new Map();
    payload.results.forEach(function (run) { if (!datasetRuns.has(datasetId(run))) datasetRuns.set(datasetId(run), run); });
    const datasets = Array.from(datasetRuns.keys()).sort();
    datasetSelect.innerHTML = datasets.map(function (dataset) { return '<option value="' + esc(dataset) + '">' + esc(datasetName(datasetRuns.get(dataset))) + '</option>'; }).join('');
    datasetSelect.value = datasets.includes(previousDataset)
      ? previousDataset
      : (datasets.includes('current-master-history') ? 'current-master-history' : (datasets[0] || ''));
    const suiteRuns = payload.results.filter(function (run) { return datasetId(run) === datasetSelect.value; });
    const selectedSuite = suiteRuns[0] ? suiteRuns[0].browser.suite : '';
    const scenarioMap = new Map();
    suiteRuns.forEach(function (run) { run.browser.scenarios.forEach(function (scenario) { scenarioMap.set(scenario.id, scenarioName(scenario)); }); });
    const previous = scenarioSelect.value;
    scenarioSelect.innerHTML = Array.from(scenarioMap).map(function (entry) { return '<option value="' + esc(entry[0]) + '">' + esc(entry[1]) + '</option>'; }).join('');
    scenarioSelect.value = scenarioMap.has(previous) ? previous : (scenarioMap.has('day-production-medium') ? 'day-production-medium' : (scenarioSelect.options[0] ? scenarioSelect.options[0].value : ''));
    const items = flatten(payload, scenarioSelect.value, datasetSelect.value);
    status.textContent = items.length + ' measurement' + (items.length === 1 ? '' : 's') + ' for this test case · ' + payload.results.length + ' total · refreshed ' + new Date(payload.generatedAt).toLocaleTimeString();
    const signatures = new Set(suiteRuns.map(function (run) {
      const env = run.browser.environment;
      return env.drawingBuffer.width + '×' + env.drawingBuffer.height + ' · ' + env.renderer.unmaskedRenderer + ' · ' + run.browser.method.gpuFence;
    }));
    let warningHtml = '';
    if (payload.results.length === 0) warningHtml += '<div class="notice">No result files yet. The page refreshes automatically while the runner writes them.</div>';
    if (signatures.size > 1) warningHtml += '<div class="notice bad">Environment mismatch: these results do not all share the same GPU, backing store, and fence method.</div>';
    if (payload.errors.length) warningHtml += '<div class="notice bad">' + payload.errors.length + ' result file(s) could not be parsed.</div>';
    const thermalSummaries = items.map(function (item) { return runThermal(item.run); }).filter(Boolean);
    const maximumThermalRaw = Math.max(-1, ...thermalSummaries.map(function (thermal) {
      return thermal.maximumStateRaw ?? thermalRanks[thermal.maximumState] ?? -1;
    }));
    if (maximumThermalRaw >= 1) {
      const state = ['nominal', 'fair', 'serious', 'critical'][maximumThermalRaw] || 'unknown';
      warningHtml += '<div class="notice' + (maximumThermalRaw >= 2 ? ' bad' : '') + '">Thermal pressure reached ' + esc(state) + ' in this dataset.</div>';
    }
    if (thermalSummaries.some(function (thermal) { return thermal.lowPowerModeSeen; })) {
      warningHtml += '<div class="notice bad">Low Power Mode was active during at least one run.</div>';
    }
    const roundsByRevision = new Map();
    items.forEach(function (item) {
      const values = roundsByRevision.get(item.run.revision.hash) || [];
      values.push(item.scenario.total.summary.median);
      roundsByRevision.set(item.run.revision.hash, values);
    });
    const largestRoundSpread = Math.max(0, ...Array.from(roundsByRevision.values()).map(function (values) {
      return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    }));
    if (largestRoundSpread >= 1) {
      const publicThermalStayedNominal = thermalSummaries.length > 0 && maximumThermalRaw === 0;
      warningHtml += '<div class="notice bad">Repeated-round spread reaches ' + fmt(largestRoundSpread) + ' ms.' +
        (publicThermalStayedNominal ? ' The public thermal state remained nominal, so this spread is not direct evidence of declared thermal pressure.' : ' Host thermals or load changed during this dataset.') +
        ' Use short alternating A/B brackets for commit attribution.</div>';
    }
    warnings.innerHTML = warningHtml;
    renderSelection(items, selectedSuite);
    renderChart(items);
    renderTable(items);
  }

  scenarioSelect.addEventListener('change', function () { if (lastPayload) render(lastPayload); });
  datasetSelect.addEventListener('change', function () {
    scenarioSelect.value = '';
    if (lastPayload) render(lastPayload);
  });
  async function refresh() {
    try { const response = await fetch('/api/results', { cache: 'no-store' }); render(await response.json()); }
    catch (error) { status.textContent = 'Dashboard refresh failed: ' + error; }
  }
  refresh(); setInterval(refresh, 2000);
</script>
</body>
</html>`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const payload = await loadResults(options.results);
    if (!HTML.includes('/api/results') || !HTML.includes('id="chart"')) {
      throw new Error('Dashboard HTML self-check failed');
    }
    process.stdout.write(`dashboard ok · ${payload.results.length} result files · ${payload.errors.length} errors\n`);
    return;
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${options.host}:${options.port}`);
    if (url.pathname === '/api/results') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(await loadResults(options.results)));
      return;
    }
    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(HTML);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  server.listen(options.port, options.host, () => {
    process.stdout.write(`Drift GPU dashboard: http://${options.host}:${options.port}/\nWatching ${options.results}\n`);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
