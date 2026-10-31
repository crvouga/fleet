import { killTree } from './process-tree';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { litestreamConfig } from '../../src/litestream';
import {
  s3ConditionalStore,
  type ConditionalStore,
} from '../../src/ownership/object-store';
import type { StorageConfig } from '../../src/storage';

import { freePort } from './port';

/** Real Litestream against disposable S3 storage (scripts/check-replication.py); every instance has its own disk and port. */
export const binary = process.env['FLEET_TEST_LITESTREAM_BIN'];
export const bucket = process.env['FLEET_TEST_S3_BUCKET'];
export const enabled = Boolean(binary && bucket);

export const token = randomBytes(32).toString('hex');
export const auth = { Authorization: `Bearer ${token}` };
export const newPrefix = () =>
  `ownership-test/${randomBytes(8).toString('hex')}`;

export interface Instance {
  readonly base: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly directory: string;
  output(): string;
}

const spawned: Instance[] = [];

export interface StartOptions {
  /** Reuse a stopped instance's volume for persistent-host restart drills. */
  readonly directory?: string;
  /** Extra environment for the supervisor (and so the worker). */
  readonly env?: Record<string, string>;
  /** Make the supervisor's clock run ahead by this many ms (retention drills). */
  readonly clockSkewMs?: number;
}

function capture(instance: { child: Instance['child'] }): () => string {
  let text = '';
  for (const stream of [instance.child.stdout, instance.child.stderr])
    void (async () => {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })();
  return () => text;
}

export async function startInstance(
  prefix: string,
  options: StartOptions = {}
): Promise<Instance> {
  const port = await freePort();
  const directory =
    options.directory ?? mkdtempSync(join(tmpdir(), 'fleet-owner-'));
  const preload =
    options.clockSkewMs === undefined
      ? []
      : ['--preload', join(import.meta.dir, 'skew-clock.ts')];
  const child = Bun.spawn([process.execPath, ...preload, 'src/start.ts'], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      PATH: process.env['PATH'] ?? '',
      FLEET_ADMIN_TOKEN: token,
      FLEET_LITESTREAM_BIN: binary as string,
      FLEET_DATABASE_PATH: join(directory, 'fleet.db'),
      FLEET_S3_BUCKET: bucket as string,
      FLEET_S3_PREFIX: prefix,
      FLEET_S3_ENDPOINT: process.env['FLEET_TEST_S3_ENDPOINT'] ?? '',
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
      AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
      FLEET_OWNERSHIP_RENEW_SECONDS: '1',
      FLEET_OWNERSHIP_EXPIRE_SECONDS: '15',
      ...(options.clockSkewMs === undefined
        ? {}
        : { FLEET_TEST_CLOCK_SKEW_MS: String(options.clockSkewMs) }),
      ...options.env,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const instance = {
    base: `http://127.0.0.1:${port}`,
    child,
    directory,
    output: capture({ child }),
  };
  spawned.push(instance);
  return instance;
}

export function killAll(): void {
  const instances = spawned.splice(0);
  for (const instance of instances) killTree(instance.child.pid);
  for (const directory of new Set(
    instances.map((instance) => instance.directory)
  ))
    rmSync(directory, { recursive: true, force: true });
}

export async function healthy(
  instance: Instance,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null)
      throw new Error(
        `exited ${instance.child.exitCode}: ${instance.output()}`
      );
    const ok = await fetch(`${instance.base}/health`).then(
      (r) => r.ok,
      () => false
    );
    if (ok) return;
    await Bun.sleep(100);
  }
  throw new Error(`not healthy in time: ${instance.output()}`);
}

/** Writes the fleet heartbeat interval (reading the revision first); returns the HTTP status. */
export async function write(
  instance: Instance,
  value: number
): Promise<number> {
  const current = await fetch(`${instance.base}/v1/settings/fleet`, {
    headers: auth,
  }).then(
    (r) => r.json() as Promise<{ revision: number }>,
    () => null
  );
  if (current === null) return 0;
  return fetch(`${instance.base}/v1/settings/fleet`, {
    method: 'PUT',
    headers: {
      ...auth,
      'Content-Type': 'application/json',
      'If-Match': String(current.revision),
    },
    body: JSON.stringify({ heartbeat: { intervalSeconds: value } }),
  }).then(
    async (r) => {
      if (r.status !== 200 && process.env['FLEET_TEST_DUMP'])
        console.error(r.status, await r.text());
      return r.status;
    },
    () => 0
  );
}

export async function read(instance: Instance): Promise<number | undefined> {
  const response = await fetch(`${instance.base}/v1/settings/fleet`, {
    headers: auth,
  });
  const body = (await response.json()) as {
    value: { heartbeat?: { intervalSeconds?: number } };
  };
  return body.value.heartbeat?.intervalSeconds;
}

export async function stop(instance: Instance): Promise<number> {
  instance.child.kill('SIGTERM');
  return Promise.race([
    instance.child.exited,
    Bun.sleep(60_000).then(() => -1),
  ]);
}

/** SQLite's own verdict on a database file a stopped instance left behind. */
export function integrityOf(directory: string): unknown {
  const db = new Database(join(directory, 'fleet.db'), { readonly: true });
  try {
    return db.query('pragma integrity_check').get();
  } finally {
    db.close();
  }
}

export function storageFor(prefix: string, path = '/unused'): StorageConfig {
  const endpoint = process.env['FLEET_TEST_S3_ENDPOINT'];
  return {
    path,
    bucket: bucket as string,
    prefix,
    ...(endpoint ? { endpoint } : {}),
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    replicated: true,
    startupTimeoutMs: 30_000,
  };
}

/** The test's own view of the bucket, through the production object-storage client. */
export function bucketView(prefix: string): ConditionalStore {
  return s3ConditionalStore(storageFor(prefix), {
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
  });
}

/**
 * Writes a pre-ownership replica directly under the prefix with real
 * Litestream (generation 0), appending a marker to a `legacy` table.
 * A supplied directory retains its working database and metadata for restart drills.
 */
export function seedLegacyReplica(
  prefix: string,
  marker: number,
  retainedDirectory?: string
): void {
  const directory =
    retainedDirectory ?? mkdtempSync(join(tmpdir(), 'fleet-legacy-'));
  try {
    const path = join(directory, retainedDirectory ? 'fleet.db' : 'legacy.db');
    const db = new Database(path);
    db.run('pragma journal_mode = wal');
    db.run('create table if not exists legacy (v integer)');
    db.run('insert into legacy values (?)', [marker]);
    db.close();
    const config = join(directory, 'litestream.yml');
    writeFileSync(config, litestreamConfig(storageFor(prefix, path)));
    const result = Bun.spawnSync(
      [
        binary as string,
        'replicate',
        '-config',
        config,
        '-no-expand-env',
        '-once',
      ],
      {
        env: {
          PATH: process.env['PATH'] ?? '',
          AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
          AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
          AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
        },
      }
    );
    if (result.exitCode !== 0)
      throw new Error(`legacy seed failed: ${result.stderr.toString()}`);
  } finally {
    if (!retainedDirectory) rmSync(directory, { recursive: true, force: true });
  }
}
