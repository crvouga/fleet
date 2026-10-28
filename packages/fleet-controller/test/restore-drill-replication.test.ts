import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SCHEMA_VERSION } from '../src/db/migrations';
import { killTree } from './support/process-tree';
import { freePort } from './support/port';

/**
 * `bun run restore:drill` with the real Litestream against disposable S3
 * storage (scripts/check-replication.py): it restores a replica into a
 * temporary directory, and never runs against the prefix of a live owner.
 */
const binary = process.env['FLEET_TEST_LITESTREAM_BIN'];
const bucket = process.env['FLEET_TEST_S3_BUCKET'];
const enabled = Boolean(binary && bucket);

const token = randomBytes(32).toString('hex');
const auth = { Authorization: `Bearer ${token}` };
const directories: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];

function environment(prefix: string, database: string, port?: number) {
  return {
    PATH: process.env['PATH'] ?? '',
    FLEET_ADMIN_TOKEN: token,
    FLEET_LITESTREAM_BIN: binary as string,
    FLEET_DATABASE_PATH: database,
    FLEET_S3_BUCKET: bucket as string,
    FLEET_S3_PREFIX: prefix,
    FLEET_S3_ENDPOINT: process.env['FLEET_TEST_S3_ENDPOINT'] ?? '',
    AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
    FLEET_OWNERSHIP_RENEW_SECONDS: '1',
    FLEET_OWNERSHIP_EXPIRE_SECONDS: '15',
    ...(port === undefined ? {} : { PORT: String(port) }),
  };
}

interface Writer {
  readonly base: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  output(): string;
}

async function startWriter(prefix: string): Promise<Writer> {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-drill-writer-'));
  directories.push(directory);
  const port = await freePort();
  let text = '';
  const child = Bun.spawn([process.execPath, 'src/start.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: environment(prefix, join(directory, 'fleet.db'), port),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr])
    void (async () => {
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        text += decoder.decode(value);
      }
    })();
  const writer = {
    base: `http://127.0.0.1:${port}`,
    child,
    output: () => text,
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`exited: ${text}`);
    if (Date.now() > deadline) throw new Error(`not healthy: ${text}`);
    const ok = await fetch(`${writer.base}/health`).then(
      (r) => r.ok,
      () => false
    );
    if (ok) return writer;
    await Bun.sleep(100);
  }
}

async function seed(writer: Writer): Promise<void> {
  const allow = await fetch(
    `${writer.base}/v1/access/drill-owner@example.test`,
    {
      method: 'PUT',
      headers: auth,
    }
  );
  expect(allow.status).toBe(200);
  const put = (revision?: number) =>
    fetch(`${writer.base}/v1/settings/fleet`, {
      method: 'PUT',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        ...(revision === undefined ? {} : { 'If-Match': String(revision) }),
      },
      body: JSON.stringify({ heartbeat: { intervalSeconds: 31 } }),
    });
  let response = await put();
  if (response.status === 428)
    response = await put(
      ((await response.json()) as { currentRevision: number }).currentRevision
    );
  expect(response.status).toBe(200);
  await Bun.sleep(2_500); // Past the 1 s replication interval.
}

async function stopWriter(writer: Writer): Promise<void> {
  writer.child.kill('SIGTERM');
  expect(await writer.child.exited).toBe(0);
}

async function drill(prefix: string, database: string, args: string[] = []) {
  const child = Bun.spawn(
    [process.execPath, 'src/ownership/restore-drill.ts', ...args],
    {
      cwd: join(import.meta.dir, '..'),
      env: environment(prefix, database),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stdout, stderr };
}

const newPrefix = () => `drill-test/${randomBytes(8).toString('hex')}`;
const unusedDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-drill-env-'));
  directories.push(directory);
  return join(directory, 'never-created.db');
};

afterEach(() => {
  for (const child of children.splice(0)) killTree(child.pid);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!enabled)('restore drill with real Litestream', () => {
  test('restores a released replica and reports versions and counts only', async () => {
    const prefix = newPrefix();
    const writer = await startWriter(prefix);
    await seed(writer);
    await stopWriter(writer);
    const result = await drill(prefix, unusedDatabase());
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}');
    expect(report).toMatchObject({
      prefix,
      userVersion: SCHEMA_VERSION,
      integrity: 'ok',
      nodes: 0,
      settings: 1,
    });
    expect(Object.keys(report).sort()).toEqual([
      'generation',
      'integrity',
      'nodes',
      'prefix',
      'settings',
      'userVersion',
    ]);
    // Only counts leave the drill: no token, address or row content.
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain('drill-owner');
  }, 180_000);

  test('refuses the prefix of a live owner and runs no restore', async () => {
    const prefix = newPrefix();
    const writer = await startWriter(prefix);
    await seed(writer);
    const result = await drill(prefix, unusedDatabase());
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('live owner');
    expect(result.stdout + result.stderr).not.toContain('"integrity"');
    // Naming the live prefix explicitly is refused just the same.
    const explicit = await drill(newPrefix(), unusedDatabase(), [
      '--prefix',
      prefix,
    ]);
    expect(explicit.code).toBe(1);
    expect(explicit.stdout + explicit.stderr).toContain('live owner');
    expect(writer.child.exitCode).toBeNull();
    await stopWriter(writer);
  }, 180_000);

  test('--prefix names another prefix that holds a released copy, while the live one keeps running', async () => {
    const copy = newPrefix();
    const archived = await startWriter(copy);
    await seed(archived);
    await stopWriter(archived);
    const livePrefix = newPrefix();
    const live = await startWriter(livePrefix);
    const result = await drill(livePrefix, unusedDatabase(), [
      `--prefix=${copy}`,
    ]);
    expect(result.code).toBe(0);
    expect(
      JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}')
    ).toMatchObject({ prefix: copy, integrity: 'ok', settings: 1 });
    expect(live.child.exitCode).toBeNull();
    await stopWriter(live);
  }, 180_000);

  test('an empty prefix fails with the restore error instead of reporting success', async () => {
    const result = await drill(newPrefix(), unusedDatabase());
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain('"integrity"');
  }, 120_000);
});
