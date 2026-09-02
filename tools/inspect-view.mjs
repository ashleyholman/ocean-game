/**
 * Deterministic view + analytical probe, from the command line.
 *
 * The agent-facing half of the graphics inspection tooling: name a viewing
 * condition, get back a screenshot and machine-readable lighting data with no
 * browser-driving, no clicking, no reading pixels by eye.
 *
 *   node tools/inspect-view.mjs --time 14 --stand cabin --look 180,0 --shot --grid 16x9
 *
 * Options
 *   --server <url>       attach to a running dev server instead of spawning one
 *   --time <hours>       local apparent solar time (decimal hours)
 *   --day <1..366>       day of year, preserving solar time
 *   --stand <station|x,z[,y]>   walker placement (see src/vessel/schooner/stations.ts)
 *   --look <yawDeg,pitchDeg>    0 = toward the bow, 180 = the stern; +pitch up
 *   --open <names>       hatches to open, comma separated: hatchwayBoards,
 *                        foreScuttleLid. Every closure not named is put back to
 *                        how she starts, so this states the whole configuration.
 *   --portal-mix <0..1>  interior lighting A/B
 *   --world-view <name>  term view (off|direct-diffuse|...|albedo|linear)
 *   --adaptation <mode>  exposure adaptation: room-lift (default) | metered | gaze | fixed
 *   --bath-gradient <0..1>      bath gradient A/B: 1 shaped (default), 0 flat
 *   --portal-sky <map|sh>       portal sky A/B: map integral (default) | L2 SH
 *   --lamps <auto|on|off>       lanterns-below A/B: auto (default) is each
 *                               room-driven latch; on/off force all four
 *   --lamps-shadow <0|1>        lantern occlusion-shadow A/B (all lamps)
 *   --shot               capture a PNG of the settled frame
 *   --grid <CxR>         semantic-screenshot ray grid, e.g. 16x9
 *   --probe <x,y>        full decomposition at one NDC point (repeatable)
 *   --point <x,y,z,nx,ny,nz>    full decomposition at a vessel-local point (repeatable)
 *   --out <dir>          output directory (default evidence/inspect/<stamp>)
 *   --width/--height     viewport (default 1280x720)
 *   --chrome <path>      Chrome executable
 *   --param <key=value>  any other page parameter, verbatim (repeatable):
 *                        e.g. --param weather=storm, --param chrome=1
 *
 * Output: PNG and/or JSON files under --out, and a terminal digest — the
 * grid as a luminance matrix with object initials, so "what is on screen and
 * how bright" is answerable without opening anything.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CdpClient,
  reservePort,
  waitForHttp,
  waitForPageTarget,
} from './perf/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const DEFAULT_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function parseArguments(argv) {
  const options = {
    server: null,
    time: null,
    day: null,
    stand: null,
    open: null,
    look: null,
    portalMix: null,
    worldView: null,
    adaptation: null,
    bathGradient: null,
    portalSky: null,
    lamps: null,
    lampsShadow: null,
    shot: false,
    grid: null,
    probes: [],
    points: [],
    out: null,
    width: 1280,
    height: 720,
    chrome: DEFAULT_CHROME,
    params: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const argument = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${argument} needs a value`);
      return argv[++i];
    };
    if (argument === '--server') options.server = next();
    else if (argument === '--time') options.time = Number(next());
    else if (argument === '--day') options.day = Number(next());
    else if (argument === '--stand') options.stand = next();
    else if (argument === '--open') options.open = next();
    else if (argument === '--look') options.look = next();
    else if (argument === '--portal-mix') options.portalMix = Number(next());
    else if (argument === '--world-view') options.worldView = next();
    else if (argument === '--adaptation') options.adaptation = next();
    else if (argument === '--bath-gradient') options.bathGradient = Number(next());
    else if (argument === '--portal-sky') options.portalSky = next();
    else if (argument === '--lamps' || argument === '--cabin-lamp') {
      options.lamps = next();
    } else if (argument === '--lamps-shadow' || argument === '--cabin-lamp-shadow') {
      options.lampsShadow = next();
    }
    else if (argument === '--shot') options.shot = true;
    else if (argument === '--grid') options.grid = next();
    else if (argument === '--probe') options.probes.push(next());
    else if (argument === '--point') options.points.push(next());
    else if (argument === '--out') options.out = path.resolve(next());
    else if (argument === '--width') options.width = Number(next());
    else if (argument === '--height') options.height = Number(next());
    else if (argument === '--chrome') options.chrome = path.resolve(next());
    else if (argument === '--param') options.params.push(next());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.shot && !options.grid && options.probes.length === 0 && options.points.length === 0) {
    // A run that captures nothing answers nothing; default to a shot + grid.
    options.shot = true;
    options.grid = '16x9';
  }
  return options;
}

function buildQuery(options) {
  const query = new URLSearchParams();
  query.set('inspect', '1');
  query.set('fixedDpr', '1');
  query.set('quality', 'desktop');
  if (options.time !== null) query.set('solarTime', String(options.time));
  if (options.day !== null) query.set('dayOfYear', String(options.day));
  if (options.stand) query.set('stand', options.stand);
  if (options.open) query.set('open', options.open);
  if (options.look) query.set('look', options.look);
  if (options.portalMix !== null) query.set('portalMix', String(options.portalMix));
  if (options.worldView) query.set('worldView', options.worldView);
  if (options.adaptation) query.set('adaptation', options.adaptation);
  if (options.bathGradient !== null) query.set('bathGradient', String(options.bathGradient));
  if (options.portalSky !== null) query.set('portalSky', options.portalSky);
  if (options.lamps !== null) query.set('lamps', options.lamps);
  if (options.lampsShadow !== null) query.set('lampsShadow', options.lampsShadow);
  for (const pair of options.params) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error(`--param wants key=value, got ${pair}`);
    query.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return query.toString();
}

/** Terminal digest: the grid as luminance digits with an object legend. */
function renderGridDigest(grid, columns, rows) {
  const legend = new Map();
  const lines = [];
  for (let j = 0; j < rows; j++) {
    let line = '';
    for (let i = 0; i < columns; i++) {
      const cell = grid[j * columns + i];
      if (!cell || cell.object === null) {
        line += ' . ';
        continue;
      }
      if (!legend.has(cell.object)) {
        const keys = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        legend.set(cell.object, keys[legend.size % keys.length]);
      }
      const key = legend.get(cell.object);
      const digit = Math.max(
        0,
        Math.min(9, Math.round((cell.displayLum ?? 0) * 9)),
      );
      line += `${key}${digit} `;
    }
    lines.push(line);
  }
  lines.push('');
  lines.push('legend (letter = object, digit = display luminance 0..9):');
  for (const [object, key] of legend) lines.push(`  ${key}  ${object}`);
  return lines.join('\n');
}

async function main() {
  const options = parseArguments(process.argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = options.out ?? path.join(PROJECT_ROOT, 'evidence', 'inspect', stamp);
  await mkdir(outDir, { recursive: true });

  let vite = null;
  let chrome = null;
  let cdp = null;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'drift-inspect-chrome-'));
  const logs = [];

  try {
    // --- the server ---------------------------------------------------------
    let serverUrl = options.server;
    if (!serverUrl) {
      const port = await reservePort();
      const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
      vite = spawn(
        viteBin,
        ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        {
          cwd: PROJECT_ROOT,
          env: { ...process.env, PORT: String(port) },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      vite.stdout.on('data', (chunk) => logs.push(`[vite] ${chunk.toString().trim()}`));
      vite.stderr.on('data', (chunk) => logs.push(`[vite:err] ${chunk.toString().trim()}`));
      serverUrl = `http://127.0.0.1:${port}`;
      await waitForHttp(`${serverUrl}/`, 60_000);
    }

    // --- the browser ---------------------------------------------------------
    const debugPort = await reservePort();
    const appUrl = `${serverUrl}/?${buildQuery(options)}`;
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
        `--window-size=${options.width},${options.height}`,
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profile}`,
        appUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    chrome.stdout.on('data', (chunk) => logs.push(`[chrome] ${chunk.toString().trim()}`));
    chrome.stderr.on('data', (chunk) => logs.push(`[chrome:err] ${chunk.toString().trim()}`));

    const target = await waitForPageTarget(debugPort, serverUrl, 60_000);
    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    cdp.on('Runtime.consoleAPICalled', (event) => {
      const text = (event.args ?? [])
        .map((argument) => argument.value ?? argument.description ?? '')
        .join(' ');
      logs.push(`[browser:${event.type}] ${text}`);
    });
    await cdp.call('Runtime.enable');
    await cdp.call('Page.enable');

    // --- wait for the sentinel ------------------------------------------------
    const deadline = Date.now() + 90_000;
    for (;;) {
      const { result } = await cdp.call('Runtime.evaluate', {
        expression: 'window.__driftInspect?.ready === true',
        returnByValue: true,
      });
      if (result.value === true) break;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for __driftInspect.ready at ${appUrl}\n${logs.slice(-20).join('\n')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const evaluateJson = async (expression) => {
      const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', {
        expression: `JSON.stringify(${expression})`,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(`evaluate failed: ${exceptionDetails.text} in ${expression}`);
      }
      return JSON.parse(result.value);
    };

    const written = [];

    // --- captures ---------------------------------------------------------------
    const applied = await evaluateJson('window.__driftInspect.applied');
    const conditions = await evaluateJson('window.__driftInspect.conditions()');

    if (options.shot) {
      const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(outDir, 'view.png');
      await writeFile(shotPath, Buffer.from(data, 'base64'));
      written.push(shotPath);
    }

    let gridDigest = null;
    if (options.grid) {
      const match = /^(\d+)x(\d+)$/.exec(options.grid);
      if (!match) throw new Error(`--grid wants CxR, got ${options.grid}`);
      const columns = Number(match[1]);
      const rows = Number(match[2]);
      const grid = await evaluateJson(
        `window.__driftInspect.probeGrid(${columns}, ${rows})`,
      );
      const gridPath = path.join(outDir, 'grid.json');
      await writeFile(
        gridPath,
        JSON.stringify({ applied, conditions, columns, rows, grid }, null, 1),
      );
      written.push(gridPath);
      gridDigest = renderGridDigest(grid, columns, rows);
    }

    const probeReports = [];
    for (const probe of options.probes) {
      const [x, y] = probe.split(',').map(Number);
      probeReports.push(
        await evaluateJson(`window.__driftInspect.probeNdc(${x}, ${y})`),
      );
    }
    for (const point of options.points) {
      const numbers = point.split(',').map(Number);
      if (numbers.length !== 6 || numbers.some((n) => !Number.isFinite(n))) {
        throw new Error(`--point wants x,y,z,nx,ny,nz — got ${point}`);
      }
      probeReports.push(
        await evaluateJson(
          `window.__driftInspect.probePoint(${numbers.join(',')})`,
        ),
      );
    }
    if (probeReports.length > 0) {
      const probesPath = path.join(outDir, 'probes.json');
      await writeFile(
        probesPath,
        JSON.stringify({ applied, conditions, probes: probeReports }, null, 1),
      );
      written.push(probesPath);
    }

    // --- digest -------------------------------------------------------------------
    console.log(`applied: ${JSON.stringify(applied)}`);
    console.log(
      `sun: intensity ${conditions.sunIntensity} dir [${conditions.sunDirWorld.x}, ${conditions.sunDirWorld.y}, ${conditions.sunDirWorld.z}] exposure ${conditions.exposure} portalMix ${conditions.portalMix}`,
    );
    for (let p = 0; p < conditions.channels.length; p++) {
      const channel = conditions.channels[p];
      console.log(
        `channel ${p}: E ${channel.irradiance.lum}  bounce ${channel.bounce.lum}`,
      );
    }
    const lampsDebug = await evaluateJson(
      'window.__drift && window.__drift.lampsDebug ? window.__drift.lampsDebug() : null',
    ).catch(() => null);
    if (lampsDebug) {
      for (const [room, lamp] of Object.entries(lampsDebug)) {
        console.log(
          `lamp ${room}: mode ${lamp.mode} lit ${lamp.litLevel} emission ${lamp.renderEmission} signal ${lamp.roomDaylightLuminance} shadow ${lamp.shadow}`,
        );
      }
    }
    if (gridDigest) {
      console.log('');
      console.log(gridDigest);
    }
    for (const report of probeReports) {
      console.log('');
      console.log(JSON.stringify(report, null, 1));
    }
    console.log('');
    for (const file of written) console.log(`wrote ${file}`);
  } finally {
    cdp?.close();
    if (chrome) chrome.kill('SIGTERM');
    if (vite) vite.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
