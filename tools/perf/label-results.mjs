#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = { results: 'perf-results' };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      return value;
    };
    if (argument === '--results') options.results = next();
    else if (argument === '--dataset') options.dataset = next();
    else if (argument === '--from') options.from = next();
    else if (argument === '--before') options.before = next();
    else throw new Error(`Unknown option ${argument}`);
  }
  if (!options.dataset || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(options.dataset)) {
    throw new Error('--dataset must use 1–80 letters, digits, dots, underscores, or hyphens');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const directory = path.resolve(options.results);
const names = (await readdir(directory)).filter((name) =>
  name.endsWith('.json') &&
  (!options.from || name >= options.from) &&
  (!options.before || name < options.before)
);

for (const name of names) {
  const target = path.join(directory, name);
  const result = JSON.parse(await readFile(target, 'utf8'));
  result.runner ??= {};
  result.runner.dataset = options.dataset;
  await writeFile(target, `${JSON.stringify(result, null, 2)}\n`);
}

process.stdout.write(`labelled ${names.length} result files as ${options.dataset}\n`);
