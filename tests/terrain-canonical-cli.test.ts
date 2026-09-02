import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const NODE_EXECUTABLE = (
  globalThis as unknown as { process: { execPath: string } }
).process.execPath;
const TOOL = 'tools/terrain-canonical-captures.mjs';

function run(...args: string[]) {
  return spawnSync(NODE_EXECUTABLE, [TOOL, ...args], {
    encoding: 'utf8',
  });
}

describe('TERR-135 canonical capture CLI', () => {
  it('emits byte-stable browser-free plan metadata and filters named views', () => {
    const first = run('--plan');
    const second = run('--plan');
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const selected = run('--plan', '--view', 'maximum-cinematic-far-ocean');
    expect(selected.status).toBe(0);
    const plan = JSON.parse(selected.stdout) as {
      rows: Array<{ id: string }>;
      stillFrames: number;
    };
    expect(plan.rows.map((row) => row.id)).toEqual([
      'maximum-cinematic-far-ocean',
    ]);
    expect(plan.stillFrames).toBe(1);
  });

  it('refuses pixels before Chrome without explicit cold-machine and output policy', () => {
    const noColdAttestation = run('--capture');
    expect(noColdAttestation.status).toBe(1);
    expect(noColdAttestation.stderr).toContain(
      '--capture requires --cold-machine',
    );

    const noOutput = run('--capture', '--cold-machine');
    expect(noOutput.status).toBe(1);
    expect(noOutput.stderr).toContain(
      '--capture requires --out <new-directory>',
    );
  });
});
