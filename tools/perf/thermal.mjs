import { spawn, execFile } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SOURCE = path.join(HERE, 'thermal-monitor.swift');
const STATE_NAMES = ['nominal', 'fair', 'serious', 'critical'];
const POWERMETRICS_PRESSURE_RANKS = {
  Nominal: 0,
  Moderate: 1,
  Heavy: 2,
  Trapping: 3,
};

function numericSummary(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return undefined;
  const middle = Math.floor(finite.length / 2);
  return {
    count: finite.length,
    minimum: finite[0],
    maximum: finite.at(-1),
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median:
      finite.length % 2 === 1
        ? finite[middle]
        : (finite[middle - 1] + finite[middle]) / 2,
  };
}

function capturedAtIso(dateText) {
  const timestamp = Date.parse(dateText);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function firstNumber(block, pattern) {
  const match = block.match(pattern);
  return match ? Number(match[1]) : undefined;
}

export function parsePowermetricsText(text) {
  const starts = [...text.matchAll(/^\*\*\* Sampled system activity \((.+)\) \(([\d.]+)ms elapsed\) \*\*\*$/gm)];
  return starts.map((match, index) => {
    const start = match.index;
    const end = starts[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    const gpuPowerMatches = [...block.matchAll(/^GPU Power: ([\d.]+) mW$/gm)];
    return {
      capturedAt: capturedAtIso(match[1]),
      capturedAtLocal: match[1],
      sampleElapsedMs: Number(match[2]),
      pressure: block.match(/^Current pressure level: (.+)$/m)?.[1],
      eClusterFrequencyMHz: firstNumber(block, /^E-Cluster HW active frequency: ([\d.]+) MHz$/m),
      pClusterFrequencyMHz: firstNumber(block, /^P-Cluster HW active frequency: ([\d.]+) MHz$/m),
      cpuPowerMw: firstNumber(block, /^CPU Power: ([\d.]+) mW$/m),
      combinedPowerMw: firstNumber(
        block,
        /^Combined Power \(CPU \+ GPU \+ ANE\): ([\d.]+) mW$/m,
      ),
      gpuFrequencyMHz: firstNumber(block, /^GPU HW active frequency: ([\d.]+) MHz$/m),
      gpuActiveResidencyPercent: firstNumber(
        block,
        /^GPU HW active residency:\s+([\d.]+)%/m,
      ),
      gpuPowerMw: gpuPowerMatches.length
        ? Number(gpuPowerMatches.at(-1)[1])
        : undefined,
    };
  });
}

export function summarizePowermetricsSamples(samples) {
  if (!samples.length) return { sampleCount: 0 };
  const pressureCounts = {};
  const firstPressureAt = {};
  let maximumPressure = 'Unknown';
  let maximumPressureRank = -1;
  let pressureTransitionCount = 0;
  for (const [index, sample] of samples.entries()) {
    const pressure = sample.pressure ?? 'Unknown';
    pressureCounts[pressure] = (pressureCounts[pressure] ?? 0) + 1;
    firstPressureAt[pressure] ??= sample.capturedAt;
    const rank = POWERMETRICS_PRESSURE_RANKS[pressure] ?? -1;
    if (rank > maximumPressureRank) {
      maximumPressure = pressure;
      maximumPressureRank = rank;
    }
    if (index > 0 && pressure !== (samples[index - 1].pressure ?? 'Unknown')) {
      pressureTransitionCount++;
    }
  }
  const startMs = Date.parse(samples[0].capturedAt);
  const endMs = Date.parse(samples.at(-1).capturedAt);
  return {
    sampleCount: samples.length,
    startAt: samples[0].capturedAt,
    endAt: samples.at(-1).capturedAt,
    durationSeconds:
      Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1_000 : undefined,
    startPressure: samples[0].pressure,
    endPressure: samples.at(-1).pressure,
    maximumPressure,
    maximumPressureRank,
    pressureCounts,
    firstPressureAt,
    pressureTransitionCount,
    cpuPowerMw: numericSummary(samples.map((sample) => sample.cpuPowerMw)),
    gpuPowerMw: numericSummary(samples.map((sample) => sample.gpuPowerMw)),
    combinedPowerMw: numericSummary(samples.map((sample) => sample.combinedPowerMw)),
    gpuFrequencyMHz: numericSummary(samples.map((sample) => sample.gpuFrequencyMHz)),
    gpuActiveResidencyPercent: numericSummary(
      samples.map((sample) => sample.gpuActiveResidencyPercent),
    ),
    pClusterFrequencyMHz: numericSummary(
      samples.map((sample) => sample.pClusterFrequencyMHz),
    ),
  };
}

function unavailable(reason) {
  return {
    available: false,
    source: 'ProcessInfo.thermalState',
    reason,
  };
}

export async function readThermalState() {
  if (process.platform !== 'darwin') return unavailable('thermal state is only available on macOS');
  try {
    const script = [
      'ObjC.import("Foundation")',
      'const p = $.NSProcessInfo.processInfo',
      'String(Number(p.thermalState)) + "|" + String(Boolean(p.isLowPowerModeEnabled))',
    ].join('; ');
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', script],
      { timeout: 5_000 },
    );
    const [rawText, lowPowerText] = stdout.trim().split('|');
    const thermalStateRaw = Number(rawText);
    if (!Number.isInteger(thermalStateRaw)) throw new Error(`unexpected state ${stdout.trim()}`);
    return {
      available: true,
      source: 'ProcessInfo.thermalState',
      capturedAt: new Date().toISOString(),
      thermalState: STATE_NAMES[thermalStateRaw] ?? 'unknown',
      thermalStateRaw,
      lowPowerMode: lowPowerText === 'true',
    };
  } catch (error) {
    return unavailable(String(error));
  }
}

async function executableExists(target) {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function thermalMonitorExecutable() {
  const source = await readFile(SWIFT_SOURCE);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const cache = path.join(os.tmpdir(), 'drift-thermal-monitor');
  const executable = path.join(cache, `thermal-monitor-${digest}`);
  if (await executableExists(executable)) return executable;
  await mkdir(cache, { recursive: true });
  const moduleCache = path.join(cache, 'swift-module-cache');
  await mkdir(moduleCache, { recursive: true });
  await execFileAsync(
    'xcrun',
    ['swiftc', '-O', '-module-cache-path', moduleCache, SWIFT_SOURCE, '-o', executable],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return executable;
}

export function summarizeThermalSamples(samples) {
  if (!samples.length) return { sampleCount: 0 };
  const statesSeen = [...new Set(samples.map((sample) => sample.thermalState))];
  const maximumStateRaw = Math.max(...samples.map((sample) => sample.thermalStateRaw));
  let transitionCount = 0;
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].thermalStateRaw !== samples[index - 1].thermalStateRaw) {
      transitionCount++;
    }
  }
  return {
    sampleCount: samples.length,
    startState: samples[0].thermalState,
    endState: samples.at(-1).thermalState,
    maximumState: STATE_NAMES[maximumStateRaw] ?? 'unknown',
    maximumStateRaw,
    statesSeen,
    transitionCount,
    lowPowerModeSeen: samples.some((sample) => sample.lowPowerMode),
    minimumActiveProcessorCount: Math.min(
      ...samples.map((sample) => sample.activeProcessorCount),
    ),
  };
}

export async function startThermalTimeline({ intervalMs = 1_000 } = {}) {
  if (process.platform !== 'darwin') {
    return {
      ...unavailable('thermal timeline is only available on macOS'),
      mark: () => 0,
      samplesSince: () => [],
      stop: async () => {},
    };
  }
  try {
    const executable = await thermalMonitorExecutable();
    const child = spawn(executable, [String(intervalMs)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const samples = [];
    let pending = '';
    let stderr = '';
    let processError;
    let exited;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          samples.push(JSON.parse(line));
        } catch (error) {
          processError = `thermal sample parse failed: ${error}`;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => (processError = String(error)));
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      if (code !== 0 && code !== null) {
        processError = `thermal monitor exited ${code}: ${stderr.trim()}`;
      }
    });

    const deadline = Date.now() + 5_000;
    while (samples.length === 0 && !processError && !exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (samples.length === 0) {
      if (child.exitCode === null) child.kill('SIGTERM');
      throw new Error(processError ?? 'thermal monitor produced no sample');
    }

    return {
      available: true,
      source: 'ProcessInfo.thermalState',
      intervalMs,
      // Include the most recent pre-run sample so every slice has a start state.
      mark: () => Math.max(0, samples.length - 1),
      latest: () => samples.at(-1),
      samplesSince: (mark) => samples.slice(mark),
      error: () => processError,
      stop: async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000)),
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
      },
    };
  } catch (error) {
    return {
      ...unavailable(String(error)),
      mark: () => 0,
      latest: () => undefined,
      samplesSince: () => [],
      error: () => String(error),
      stop: async () => {},
    };
  }
}

export async function startPowermetricsCapture({
  enabled = false,
  outputDirectory,
  dataset,
  intervalMs = 1_000,
} = {}) {
  const disabled = {
    metadata: { requested: false, available: false },
    stop: async () => {},
  };
  if (!enabled) return disabled;
  const baseMetadata = {
    requested: true,
    available: false,
    samplers: ['thermal', 'sfi', 'cpu_power', 'gpu_power'],
    intervalMs,
  };
  if (process.platform !== 'darwin') {
    return {
      metadata: { ...baseMetadata, reason: 'powermetrics is only available on macOS' },
      stop: async () => {},
    };
  }
  try {
    await execFileAsync('sudo', ['-n', 'true'], { timeout: 5_000 });
  } catch {
    return {
      metadata: {
        ...baseMetadata,
        reason: 'sudo is not pre-authorized; run “sudo -v” before using --powermetrics',
      },
      stop: async () => {},
    };
  }

  await mkdir(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}_${dataset}_powermetrics.txt`;
  const target = path.join(outputDirectory, filename);
  const output = createWriteStream(target, { encoding: 'utf8' });
  const outputFinished = finished(output).catch(() => {});
  const child = spawn(
    'sudo',
    [
      '-n',
      '/usr/bin/powermetrics',
      '--samplers',
      baseMetadata.samplers.join(','),
      '--show-plimits',
      '--sample-rate',
      String(intervalMs),
      '--buffer-size',
      '1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let processError;
  child.stdout.pipe(output);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.once('error', (error) => (processError = String(error)));
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode !== null || processError) {
    output.end();
    await outputFinished;
    return {
      metadata: {
        ...baseMetadata,
        reason: processError ?? `powermetrics exited ${child.exitCode}: ${stderr.trim()}`,
      },
      stop: async () => {},
    };
  }

  return {
    metadata: {
      ...baseMetadata,
      available: true,
      sidecar: filename,
    },
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGINT');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      if (child.exitCode === null) child.kill('SIGTERM');
      output.end();
      await outputFinished;
    },
  };
}
