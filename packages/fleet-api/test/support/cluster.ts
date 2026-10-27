import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SQL } from 'bun';

import type { Tooling } from './tooling';

const SCHEMA_FILE = resolve(import.meta.dir, '../../schema.hcl');

export interface Cluster {
  readonly port: number;
  /** postgres:// URL for a database in this cluster, as the superuser. */
  url(database: string): string;
  /** A fresh database that already has the production schema applied. */
  createDatabase(): Promise<string>;
  /** Stops the server but keeps the data, so it can be started again. */
  stop(): void;
  start(): void;
  /** Stops the server and deletes everything. */
  destroy(): void;
}

function run(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {}
) {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

export interface ClusterOptions {
  /** Serve TLS with a throwaway self-signed certificate, as a managed Postgres does. */
  readonly ssl?: boolean;
}

function selfSignedCertificate(dir: string): { cert: string; key: string } {
  const cert = join(dir, 'server.crt');
  const key = join(dir, 'server.key');
  run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    '2',
    '-subj',
    '/CN=localhost',
  ]);
  chmodSync(key, 0o600);
  return { cert, key };
}

function serverOptions(
  port: number,
  tls: { cert: string; key: string } | null
): string {
  return [
    ...(tls === null
      ? []
      : [
          '-c ssl=on',
          `-c ssl_cert_file='${tls.cert}'`,
          `-c ssl_key_file='${tls.key}'`,
        ]),
    `-p ${port}`,
    '-c listen_addresses=127.0.0.1',
    '-c unix_socket_directories=',
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
    '-c max_connections=200',
  ].join(' ');
}

async function applySchema(
  tooling: Tooling,
  port: number,
  database: string
): Promise<void> {
  const admin = new SQL({
    url: `postgres://postgres@127.0.0.1:${port}/${database}?sslmode=disable`,
    max: 1,
  });
  // OpenTofu's PostgreSQL provider creates the schema in production.
  await admin.unsafe('create schema fleet');
  await admin.close();
  run(
    tooling.atlas,
    [
      'schema',
      'apply',
      '--url',
      `postgres://postgres@127.0.0.1:${port}/${database}?search_path=fleet&sslmode=disable`,
      '--to',
      `file://${SCHEMA_FILE}`,
      '--dev-url',
      `postgres://postgres@127.0.0.1:${port}/dev?sslmode=disable`,
      '--auto-approve',
    ],
    { ATLAS_NO_UPDATE_NOTIFIER: '1' }
  );
}

async function execute(port: number, statement: string): Promise<void> {
  const admin = new SQL({
    url: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    max: 1,
  });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.close();
  }
}

/**
 * A detached shell that stops the cluster and deletes its directory once this
 * process is gone, however it ended. `bun test` runs no exit hooks, and a
 * killed or crashed run would otherwise leave a postmaster behind.
 */
function startWatchdog(
  tooling: Tooling,
  data: string,
  dir: string
): { stop(): void } {
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 1; done; "$2" -D "$3" -m immediate stop >/dev/null 2>&1; rm -rf "$4"';
  const child = Bun.spawn(
    ['sh', '-c', script, 'sh', String(process.pid), tooling.pgCtl, data, dir],
    {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }
  );
  child.unref();
  return { stop: () => child.kill() };
}

/** A throwaway cluster in $TMPDIR with the schema built the way production builds it. */
export async function startCluster(
  tooling: Tooling,
  options: ClusterOptions = {}
): Promise<Cluster> {
  const dir = mkdtempSync(
    join(process.env['TMPDIR'] ?? tmpdir(), 'fleet-api-pg-')
  );
  const port = await freePort();
  const data = join(dir, 'data');
  const control = (action: string[]) =>
    run(tooling.pgCtl, [
      '-D',
      data,
      '-l',
      join(dir, 'server.log'),
      '-w',
      ...action,
    ]);
  const tls = options.ssl === true ? selfSignedCertificate(dir) : null;
  const start = () => control(['-o', serverOptions(port, tls), 'start']);
  const stop = () => control(['-m', 'immediate', 'stop']);
  let created = 0;
  let destroyed = false;
  const watchdog = startWatchdog(tooling, data, dir);
  try {
    run(tooling.initdb, [
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'postgres',
      '-E',
      'UTF8',
      '--no-sync',
    ]);
    start();
    await execute(port, 'create database dev');
    await execute(port, 'create database template_fleet');
    await applySchema(tooling, port, 'template_fleet');
  } catch (err: unknown) {
    spawnSync(tooling.pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    rmSync(dir, { recursive: true, force: true });
    watchdog.stop();
    throw err;
  }
  return {
    port,
    url: (database) =>
      `postgres://postgres@127.0.0.1:${port}/${database}?sslmode=disable`,
    async createDatabase() {
      created += 1;
      const name = `t${created}_${Date.now() % 100000}`;
      await execute(port, `create database ${name} template template_fleet`);
      return name;
    },
    start,
    stop,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      spawnSync(tooling.pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
      rmSync(dir, { recursive: true, force: true });
      watchdog.stop();
    },
  };
}
