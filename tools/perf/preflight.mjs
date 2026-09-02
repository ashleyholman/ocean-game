import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readThermalState } from './thermal.mjs';

const execFileAsync = promisify(execFile);
const COMPETITOR_PATTERN =
  /--type=gpu-process|com\.apple\.WebKit\.GPU|Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$)|Safari\.app\/Contents\/MacOS\/Safari(?:\s|$)|Firefox\.app\/Contents\/MacOS\/firefox(?:\s|$)/i;
const BENIGN_PATTERN = /Codex Helper|SafariWidgetExtension|run-revisions\.mjs|preflight\.mjs/i;

export async function collectGpuProcessInventory() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,%cpu=,%mem=,command='], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => COMPETITOR_PATTERN.test(line) && !BENIGN_PATTERN.test(line))
    .map((line) => line.length > 240 ? `${line.slice(0, 237)}…` : line);
}

export async function hostSnapshot() {
  let competitors = [];
  let inventoryError;
  const [inventory, thermal] = await Promise.allSettled([
    collectGpuProcessInventory(),
    readThermalState(),
  ]);
  if (inventory.status === 'fulfilled') competitors = inventory.value;
  else inventoryError = String(inventory.reason);
  return {
    capturedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    loadAverage: os.loadavg(),
    thermal:
      thermal.status === 'fulfilled'
        ? thermal.value
        : { available: false, reason: String(thermal.reason) },
    competitors,
    inventoryError,
  };
}

export function printPreflight(snapshot) {
  process.stdout.write(
    [
      `host ${snapshot.hostname} · ${snapshot.cpu ?? 'unknown CPU'}`,
      `load ${snapshot.loadAverage.map((value) => value.toFixed(2)).join(' / ')}`,
      snapshot.thermal?.available
        ? `thermal ${snapshot.thermal.thermalState} · Low Power Mode ${snapshot.thermal.lowPowerMode ? 'on' : 'off'}`
        : `thermal unavailable${snapshot.thermal?.reason ? `: ${snapshot.thermal.reason}` : ''}`,
      snapshot.inventoryError
        ? 'GPU process inventory unavailable.'
        : snapshot.competitors.length === 0
        ? 'No likely competing browser/game/Vite processes found.'
        : `Likely competing processes (${snapshot.competitors.length}):`,
      ...snapshot.competitors.map((line) => `  ${line}`),
      snapshot.inventoryError ? `Process inventory failed: ${snapshot.inventoryError}` : undefined,
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
  const snapshot = await hostSnapshot();
  printPreflight(snapshot);
  process.exitCode = snapshot.inventoryError
    ? 3
    : snapshot.competitors.length === 0
      ? 0
      : 2;
}
