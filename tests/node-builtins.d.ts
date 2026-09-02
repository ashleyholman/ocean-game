/**
 * The tests run under Node, but the project tsconfig is browser-only — and it
 * should stay that way, because `src` compiling without Node globals is a real
 * property worth keeping (see the same reasoning in vite.config.ts). Declaring
 * the narrow builtin surface the suite actually reads beats adding @types/node, which
 * would put `process`, `Buffer`, and Node's `setTimeout` return type in scope
 * for every file in `src` as well. Keep this list to the few test-only calls
 * the suite actually uses.
 */
declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readdirSync(
    path: string,
    options: { recursive: true },
  ): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(
    path: string,
    options?: { recursive?: boolean },
  ): void;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
}

declare module 'node:child_process' {
  export interface SpawnSyncTextResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }

  export function spawnSync(
    command: string,
    args: readonly string[],
    options: { encoding: 'utf8' },
  ): SpawnSyncTextResult;
}
