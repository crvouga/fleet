import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { createLogger, type Logger } from '@pkgs/logger';

import { ConfigurationError, readControllerEnv } from './env';
import { preflight } from './preflight';
import { StartupError, databaseFailure } from './startup-error';
import { createDb } from './db/client';
import type { StorageConfig } from './storage';

/** Generated without credentials; env expansion is disabled to preserve literal paths. */
export function litestreamConfig(storage: StorageConfig): string {
  return stringify({
    dbs: [
      {
        path: storage.path,
        replica: {
          type: 's3',
          bucket: storage.bucket,
          path: storage.prefix,
          region: storage.region,
          ...(storage.endpoint
            ? { endpoint: storage.endpoint, 'force-path-style': true }
            : {}),
          'sync-interval': '1s',
        },
      },
    ],
  });
}

async function run(
  binary: string,
  args: string[],
  storage: StorageConfig
): Promise<number> {
  const child = Bun.spawn([binary, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      FLEET_REPLICATION_MANAGED: '1',
      FLEET_DATABASE_PATH: storage.path,
    },
  });
  const cleanup = supervise(
    child,
    args.includes('-exec') ? undefined : storage.startupTimeoutMs
  );
  try {
    const code = await child.exited;
    if (!args.includes('-exec') && cleanup.interrupted()) return 1;
    if (args.includes('-exec') && code === 0 && !cleanup.interrupted())
      return 1;
    return code;
  } finally {
    cleanup.release();
  }
}

/** Bound restore/initial-sync retries; the long-running controller has no runtime deadline. */
function supervise(
  child: ReturnType<typeof Bun.spawn>,
  timeoutMs?: number
): { release(): void; interrupted(): boolean } {
  let interrupted = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          stop();
          force = setTimeout(() => child.kill('SIGKILL'), 1000);
        }, timeoutMs);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return {
    interrupted: () => interrupted,
    release: () => {
      clearTimeout(timer);
      clearTimeout(force);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    },
  };
}

async function initialize(storage: StorageConfig): Promise<void> {
  try {
    await (await createDb(storage)).close();
  } catch (error) {
    throw databaseFailure(error);
  }
}

async function replicate(
  binary: string,
  storage: StorageConfig,
  log: Logger
): Promise<void> {
  const temporary = mkdtempSync(join(tmpdir(), 'fleet-litestream-'));
  const config = join(temporary, 'litestream.yml');
  writeFileSync(config, litestreamConfig(storage), { mode: 0o600 });
  const common = ['-config', config, '-no-expand-env'];
  try {
    log.info('checking replica and restoring missing SQLite working state');
    if (
      (await run(
        binary,
        [
          'restore',
          ...common,
          '-if-db-not-exists',
          '-if-replica-exists',
          storage.path,
        ],
        storage
      )) !== 0
    ) {
      throw new StartupError(
        'restore',
        'Litestream restore failed. Fix FLEET_S3_BUCKET, FLEET_S3_PREFIX, FLEET_S3_ENDPOINT, AWS_REGION or AWS credentials; verify bucket List/Get permissions and connectivity. Check the Litestream error above. If the operation timed out, increase FLEET_STARTUP_TIMEOUT_SECONDS for a large restore. The Fleet controller did not start listening.'
      );
    }
    await initialize(storage);
    log.info('verifying S3 replication before accepting traffic');
    if ((await run(binary, ['replicate', ...common, '-once'], storage)) !== 0) {
      throw new StartupError(
        'replica-write',
        'Initial Litestream replication failed. Verify S3 List/Get/Put/Delete permissions for the configured bucket/prefix, endpoint, region and credentials. Retain the local database and retry after fixing the error above. Increase FLEET_STARTUP_TIMEOUT_SECONDS if a slow initial sync exceeded its deadline. The Fleet controller did not start listening.'
      );
    }
    const worker = `"${process.execPath}" "${join(import.meta.dir, 'controller.ts')}"`;
    const code = await run(
      binary,
      ['replicate', ...common, '-exec', worker],
      storage
    );
    if (code !== 0) {
      log.error('Fleet controller or Litestream exited unsuccessfully', {
        stage: 'serve',
        exitCode: code,
        fix: 'Read the startup/runtime error above. Fix database permissions, PORT conflicts, assets or replica access before restarting. See CONFIGURATION.md.',
      });
    }
    process.exitCode = code;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function start(checkOnly = false): Promise<void> {
  const log = createLogger({ name: 'fleet-controller', level: 'info' });
  try {
    const env = readControllerEnv();
    const binary = await preflight(env);
    if (checkOnly) {
      log.info(
        'configuration and local prerequisites are valid; S3 access is verified during startup'
      );
      return;
    }
    await replicate(binary, env.storage, log);
  } catch (error) {
    const known =
      error instanceof ConfigurationError || error instanceof StartupError;
    log.error('fleet controller startup failed', {
      stage: error instanceof StartupError ? error.stage : 'configuration',
      error: known
        ? error.message
        : 'Startup prerequisite failed. Check local directory permissions, available disk space and FLEET_LITESTREAM_BIN. See CONFIGURATION.md.',
      fix: 'Edit deployment.env using deployment.env.example; rerun bun run check:config, then bun run start. See CONFIGURATION.md.',
    });
    process.exitCode = 1;
  }
}

if (import.meta.main) void start(process.argv.includes('--check'));
