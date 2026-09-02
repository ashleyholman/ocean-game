#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePowermetricsText, summarizePowermetricsSamples } from './thermal.mjs';

function usage() {
  return `Usage: node tools/perf/summarize-powermetrics.mjs <capture.txt> [options]

Options:
  --from <ISO time>   Include samples at or after this instant
  --to <ISO time>     Include samples at or before this instant
  --samples           Include parsed samples as well as the summary
  --output <file>     Write JSON to a file instead of stdout
  --help              Show this help`;
}

function parseArgs(argv) {
  const options = { samples: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--from') options.from = next();
    else if (argument === '--to') options.to = next();
    else if (argument === '--samples') options.samples = true;
    else if (argument === '--output') options.output = next();
    else if (argument.startsWith('-')) throw new Error(`Unknown option ${argument}`);
    else if (!options.input) options.input = argument;
    else throw new Error(`Unexpected argument ${argument}`);
  }
  return options;
}

function instant(value, option) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${option} must be a valid date/time`);
  return parsed;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (!options.input) throw new Error(`A powermetrics capture is required.\n\n${usage()}`);

const from = instant(options.from, '--from');
const to = instant(options.to, '--to');
const input = path.resolve(options.input);
const parsed = parsePowermetricsText(await readFile(input, 'utf8'));
const samples = parsed.filter((sample) => {
  const capturedAt = Date.parse(sample.capturedAt);
  return (!Number.isFinite(from) || capturedAt >= from) && (!Number.isFinite(to) || capturedAt <= to);
});
const payload = {
  source: path.relative(process.cwd(), input) || path.basename(input),
  generatedAt: new Date().toISOString(),
  filter: {
    from: options.from,
    to: options.to,
  },
  summary: summarizePowermetricsSamples(samples),
  ...(options.samples ? { samples } : {}),
};
const json = `${JSON.stringify(payload, null, 2)}\n`;
if (options.output) await writeFile(path.resolve(options.output), json);
else process.stdout.write(json);
