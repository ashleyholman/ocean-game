/**
 * Evidence sink for the buoyancy diagnostic harness.
 *
 * The harness runs inside the real application, in a real browser, driving the
 * real render loop. It cannot write to disk, so it POSTs finished artefacts
 * here: screenshots, contact sheets, WebM captures and machine-readable
 * measurement files. Nothing in the game talks to this server unless
 * `?debug=buoyancy` is present and a capture is explicitly requested.
 *
 *   node tools/capture-server.mjs [outputDir] [port]
 *
 * Default output directory is `evidence/`, default port 5199.
 */

import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

const outputRoot = resolve(process.argv[2] ?? 'evidence');
const port = Number(process.argv[3] ?? 5199);

const EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['video/webm', '.webm'],
  ['application/json', '.json'],
  ['text/csv', '.csv'],
  ['text/plain', '.txt'],
]);

/** Reject anything that would escape the output directory. */
function safeTarget(name) {
  const cleaned = normalize(name).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(outputRoot, cleaned);
  if (target !== outputRoot && !target.startsWith(outputRoot + sep)) return null;
  return target;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors);
    response.end();
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1');

  if (request.method === 'GET' && url.pathname === '/alive') {
    response.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }

  if (request.method !== 'POST' || url.pathname !== '/shot') {
    response.writeHead(404, cors);
    response.end();
    return;
  }

  const name = url.searchParams.get('name');
  if (!name) {
    response.writeHead(400, cors);
    response.end('missing name');
    return;
  }

  const type = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
  const suffix = /\.[a-z0-9]+$/i.test(name) ? '' : (EXTENSIONS.get(type) ?? '.bin');
  const target = safeTarget(name + suffix);
  if (!target) {
    response.writeHead(400, cors);
    response.end('bad name');
    return;
  }

  try {
    const body = await readBody(request);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    process.stdout.write(`${(body.length / 1024).toFixed(0).padStart(7)} kB  ${target.slice(outputRoot.length + 1)}\n`);
    response.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    response.end('ok');
  } catch (error) {
    process.stderr.write(`write failed: ${String(error)}\n`);
    response.writeHead(500, cors);
    response.end('write failed');
  }
});

await mkdir(outputRoot, { recursive: true });
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`capture server -> ${join(outputRoot)} on http://127.0.0.1:${port}\n`);
});
