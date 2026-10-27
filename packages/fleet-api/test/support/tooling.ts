import { existsSync, globSync } from 'node:fs';
import { join } from 'node:path';

export interface Tooling {
  readonly initdb: string;
  readonly pgCtl: string;
  readonly atlas: string;
}

const SEARCH_GLOBS = [
  '/usr/lib/postgresql/*/bin',
  '/opt/homebrew/opt/postgresql@*/bin',
  '/usr/local/opt/postgresql@*/bin',
];

function findBinary(name: string): string | null {
  const onPath = Bun.which(name);
  if (onPath !== null) return onPath;
  for (const pattern of SEARCH_GLOBS) {
    for (const dir of globSync(pattern).sort().reverse()) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let cached: Tooling | null | undefined;

/**
 * Postgres and Atlas binaries, or null when absent. In CI a missing tool is a
 * failure, not a skip: a green run must mean the database tests ran.
 */
export function findTooling(): Tooling | null {
  if (cached !== undefined) return cached;
  const initdb = findBinary('initdb');
  const pgCtl = findBinary('pg_ctl');
  const atlas = Bun.which('atlas');
  if (initdb !== null && pgCtl !== null && atlas !== null) {
    cached = { initdb, pgCtl, atlas };
    return cached;
  }
  const missing = [initdb, pgCtl].includes(null)
    ? 'postgres (initdb, pg_ctl)'
    : 'atlas';
  if (process.env['CI']) {
    throw new Error(
      `database tests need ${missing}, which was not found on PATH`
    );
  }
  process.stderr.write(`skipping database tests: ${missing} not found\n`);
  cached = null;
  return cached;
}
