/**
 * Shared headless-Chrome scaffolding for the agent-facing capture tools.
 *
 * `inspect-view.mjs` grew this first; `ab-sheet.mjs` needs the same thing and
 * needs it TWICE at once (a page-load A/B runs one page per arm), so it lives
 * here rather than being copied. The GPU flags are the ones the perf harness
 * established — Metal ANGLE, real GPU, no renderer backgrounding — and they
 * are not negotiable per tool: a visible window costs about 3x a headless one
 * and no comparison may mix the two.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
export const PROJECT_ROOT = path.resolve(HERE, '..');
export const DEFAULT_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Start a Vite dev server on a free port, or reuse one that is already up. */
export async function startViteServer(existingUrl, logs) {
  if (existingUrl) return { url: existingUrl, process: null };
  const port = await reservePort();
  const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
  const child = spawn(
    viteBin,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk) => logs.push(`[vite] ${chunk.toString().trim()}`));
  child.stderr.on('data', (chunk) => logs.push(`[vite:err] ${chunk.toString().trim()}`));
  const url = `http://127.0.0.1:${port}`;
  await waitForHttp(`${url}/`, 60_000);
  return { url, process: child };
}

/**
 * Launch one headless Chrome and attach CDP to its page.
 *
 * The window size is a bootstrap detail, not the capture size. A
 * `--window-size=1280,720` Chrome has only about 633 CSS pixels of content
 * height, which is under the 640 threshold that selects the mobile ocean tier
 * — see `RuntimeOptions.ts`. Captures state their tier on the URL and assert
 * it afterwards rather than trying to find a window that guesses right.
 */
export async function launchHeadlessPage({
  serverUrl,
  query,
  windowWidth = 1600,
  windowHeight = 1000,
  chromePath = DEFAULT_CHROME,
  logs,
  tag = 'chrome',
}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'drift-headless-'));
  const debugPort = await reservePort();
  const appUrl = `${serverUrl}/?${query}`;
  const child = spawn(
    chromePath,
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
      `--window-size=${windowWidth},${windowHeight}`,
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      appUrl,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => logs.push(`[${tag}] ${chunk.toString().trim()}`));
  child.stderr.on('data', (chunk) => logs.push(`[${tag}:err] ${chunk.toString().trim()}`));

  const target = await waitForPageTarget(debugPort, serverUrl, 60_000);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  cdp.on('Runtime.consoleAPICalled', (event) => {
    const text = (event.args ?? [])
      .map((argument) => argument.value ?? argument.description ?? '')
      .join(' ');
    logs.push(`[${tag}:${event.type}] ${text}`);
  });
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');

  /**
   * Evaluate an expression and return its value, JSON round-tripped.
   *
   * `awaitPromise` must resolve the value BEFORE stringifying it: CDP's own
   * flag awaits whatever the expression evaluates to, and
   * `JSON.stringify(promise)` evaluates to the string "{}" immediately, so the
   * flag alone silently returns an empty object for every async page call.
   */
  const evaluateJson = async (expression, { awaitPromise = false } = {}) => {
    const wrapped = awaitPromise
      ? `Promise.resolve(${expression}).then((value) => JSON.stringify(value))`
      : `JSON.stringify(${expression})`;
    const { result, exceptionDetails } = await cdp.call('Runtime.evaluate', {
      expression: wrapped,
      returnByValue: true,
      awaitPromise,
    });
    if (exceptionDetails) {
      const detail =
        exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`[${tag}] evaluate failed: ${detail}`);
    }
    return result.value === undefined ? undefined : JSON.parse(result.value);
  };

  /** Evaluate for its side effect, surfacing a page-side throw as a throw. */
  const evaluateVoid = async (expression, { awaitPromise = false } = {}) => {
    const { exceptionDetails } = await cdp.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (exceptionDetails) {
      const detail =
        exceptionDetails.exception?.description ?? exceptionDetails.text;
      throw new Error(`[${tag}] evaluate failed: ${detail}`);
    }
  };

  /** Poll a boolean expression until it is true, or give up loudly. */
  const waitFor = async (expression, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { result } = await cdp.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      if (result.value === true) return;
      if (Date.now() > deadline) {
        throw new Error(
          `[${tag}] timed out waiting for ${expression} at ${appUrl}\n` +
            logs.slice(-25).join('\n'),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  return {
    appUrl,
    cdp,
    evaluateJson,
    evaluateVoid,
    waitFor,
    async close() {
      cdp.close();
      child.kill('SIGTERM');
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    },
  };
}
