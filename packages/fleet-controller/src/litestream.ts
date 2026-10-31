import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { litestreamCredentials, type StorageConfig } from './storage';

/** Generated without credentials; env expansion is disabled to preserve literal paths. */
export function litestreamConfig(
  storage: StorageConfig,
  metricsPort?: number,
  metadataPath?: string
): string {
  return stringify({
    // Loopback only: Litestream's Prometheus endpoint feeds the sync monitor.
    ...(metricsPort === undefined ? {} : { addr: `127.0.0.1:${metricsPort}` }),
    dbs: [
      {
        path: storage.path,
        ...(metadataPath === undefined ? {} : { 'meta-path': metadataPath }),
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

/** Writes a private config file and returns the common Litestream arguments for it. */
export function configArgs(
  directory: string,
  name: string,
  storage: StorageConfig,
  metricsPort?: number
): string[] {
  const config = join(directory, `${name}.yml`);
  // A new remote generation needs a full snapshot, not an old generation's
  // local LTX index (whose historical files may already have been compacted).
  const replica = createHash('sha256').update(storage.prefix).digest('hex');
  const metadata = join(directory, `${name}-${replica}.meta`);
  writeFileSync(config, litestreamConfig(storage, metricsPort, metadata), {
    mode: 0o600,
  });
  return ['-config', config, '-no-expand-env'];
}

export type LitestreamProcess = ReturnType<typeof Bun.spawn>;

export function spawnLitestream(
  binary: string,
  args: string[],
  storage: StorageConfig,
  extraEnv: Record<string, string> = {}
): LitestreamProcess {
  return Bun.spawn([binary, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...litestreamCredentials(process.env),
      FLEET_REPLICATION_MANAGED: '1',
      FLEET_DATABASE_PATH: storage.path,
      ...extraEnv,
    },
  });
}

/**
 * A bounded operation. The startup deadline always applies; at startup
 * (restore, initial sync) shutdown signals interrupt it too, and an interrupted
 * run never counts as success. The final sync is not interruptible: it is what
 * a shutdown is waiting for.
 */
export async function runBounded(
  binary: string,
  args: string[],
  storage: StorageConfig,
  interruptible = true
): Promise<number> {
  const child = spawnLitestream(binary, args, storage);
  let interrupted = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    interrupted = true;
    child.kill('SIGTERM');
  };
  const timer = setTimeout(() => {
    stop();
    force = setTimeout(() => child.kill('SIGKILL'), 1000);
  }, storage.startupTimeoutMs);
  if (interruptible) {
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }
  try {
    const code = await child.exited;
    return interrupted ? 1 : code;
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

/** Asks a process to stop, then kills it if it outlives the grace period. */
export async function stopWithin(
  child: LitestreamProcess,
  graceMs: number
): Promise<number> {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), graceMs);
  try {
    return await child.exited;
  } finally {
    clearTimeout(force);
  }
}
