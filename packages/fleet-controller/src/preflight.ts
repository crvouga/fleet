import {
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { ControllerEnv } from './env';
import { StartupError } from './startup-error';

export const LITESTREAM_VERSION = '0.5.17';

function writableDatabase(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      if (!statSync(path).isFile()) throw new Error();
      accessSync(path, constants.R_OK | constants.W_OK);
    }
    const probe = mkdtempSync(join(dirname(path), '.fleet-write-check-'));
    rmSync(probe, { recursive: true });
  } catch {
    throw new StartupError(
      'filesystem',
      'FLEET_DATABASE_PATH must name a writable SQLite file in a writable directory. Create the directory with ownership for the service user, fix permissions/free space, or set FLEET_DATABASE_PATH to another local path.'
    );
  }
}

function assetsReady(): void {
  for (const asset of [
    'app.css',
    'console.js',
    'console.css',
    'theme-init.js',
  ]) {
    try {
      const path = new URL(`../dist/${asset}`, import.meta.url);
      if (!statSync(path).isFile()) throw new Error();
      accessSync(path, constants.R_OK);
    } catch {
      throw new StartupError(
        'assets',
        'Dashboard assets are missing or unreadable. Run bun install --frozen-lockfile and bun run build from the repository root before starting Fleet.'
      );
    }
  }
}

async function litestreamBinary(): Promise<string> {
  const configured = process.env['FLEET_LITESTREAM_BIN'] ?? 'litestream';
  const binary = Bun.which(configured);
  if (!binary)
    throw new StartupError(
      'litestream',
      'Litestream is missing or not executable. Install Litestream 0.5.17 on PATH, or set FLEET_LITESTREAM_BIN to its executable path. See CONFIGURATION.md.'
    );
  const child = Bun.spawn([binary, 'version'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const output = (await new Response(child.stdout).text()).trim();
    if ((await child.exited) !== 0 || output !== LITESTREAM_VERSION) {
      throw new StartupError(
        'litestream',
        'Litestream version check failed. Install the supported version 0.5.17 and check FLEET_LITESTREAM_BIN; do not use an untested replica format.'
      );
    }
  } finally {
    clearTimeout(timer);
  }
  return binary;
}

/** No HTTP listener or replica changes until configuration and local prerequisites pass. */
export async function preflight(env: ControllerEnv): Promise<string> {
  if (!Bun.semver.satisfies(Bun.version, '>=1.4.4'))
    throw new StartupError(
      'runtime',
      'Bun 1.4.4 or newer is required. Install the repository-pinned Bun version and retry.'
    );
  assetsReady();
  writableDatabase(env.storage.path);
  return litestreamBinary();
}
