/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// This file runs under Node, but the project tsconfig is browser-only; typing
// the one Node global used here beats pulling in @types/node for it.
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  base: './',
  // Agent worktrees may reuse a read-only dependency install from the primary
  // checkout. Keep Vite's disposable optimizer state in this checkout's
  // already-ignored build tree rather than trying to mutate node_modules.
  cacheDir: 'dist/.vite-cache',
  server: {
    host: '127.0.0.1',
    // The launch harness assigns a free port through PORT so parallel
    // worktree sessions don't collide; 5173 is only the bare-`npm run dev`
    // fallback.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    tags: [
      {
        name: 'slow',
        description:
          'Long-running evidence builds, physical simulations and exhaustive sweeps excluded from npm test.',
      },
      {
        name: 'sailing',
        description: 'Long-running sailing force, polar, steering and rudder coverage.',
      },
      {
        name: 'ship-physics',
        description: 'Long-running hydrostatics, horizontal dynamics and wave-response coverage.',
      },
      {
        name: 'rig-geometry',
        description: 'Long-running rig-clearance and deck-walkability sweeps.',
      },
    ],
    // This suite runs real physics: multi-minute simulated decays and full
    // evidence builders that take seconds of CPU each, in parallel workers,
    // on a machine that often carries another AI session's load. Under that
    // contention the vitest 5 s default flakes green tests red by the dozen
    // (measured 2026-08-06: 3-6x wall-clock inflation at load average 25).
    // Sixty seconds is headroom, not a target; the heaviest evidence tests
    // carry explicit 120 s budgets on top.
    testTimeout: 60_000,
    // Agent worktrees are checked out *inside* the repository. Without this,
    // vitest walks into them and runs every nested checkout's suite as well,
    // reporting another branch's results as if they were this one's.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**',
      '**/.codex/worktrees/**',
    ],
  },
});
