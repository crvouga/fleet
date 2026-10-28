import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { freePort } from './support/port';

/**
 * Rolling-deploy drills with real Litestream against disposable S3 storage
 * (scripts/check-replication.py). Every instance has its own disk and port,
 * like separate containers, and shares only the bucket prefix.
 */
const binary = process.env['FLEET_TEST_LITESTREAM_BIN'];
const bucket = process.env['FLEET_TEST_S3_BUCKET'];
const enabled = Boolean(binary && bucket);

interface Instance {
  readonly base: string;
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly directory: string;
  output(): string;
}

const token = randomBytes(32).toString('hex');
const spawned: Instance[] = [];

function startInstance(prefix: string, port: number): Instance {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-owner-'));
  let text = '';
  const child = Bun.spawn([process.execPath, 'src/start.ts'], {
    cwd: join(import.meta.dir, '..'),
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
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
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
  const instance = {
    base: `http://127.0.0.1:${port}`,
    child,
    directory,
    output: () => text,
  };
  spawned.push(instance);
  return instance;
}

async function healthy(instance: Instance, timeoutMs = 30_000): Promise<void> {
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

const auth = { Authorization: `Bearer ${token}` };

/** Writes the fleet heartbeat interval; returns the HTTP status (0 when unreachable). */
async function write(instance: Instance, value: number): Promise<number> {
  return fetch(`${instance.base}/v1/settings/fleet`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ heartbeat: { intervalSeconds: value } }),
  }).then(
    (r) => r.status,
    () => 0
  );
}

async function read(instance: Instance): Promise<number | undefined> {
  const response = await fetch(`${instance.base}/v1/settings/fleet`, {
    headers: auth,
  });
  const body = (await response.json()) as {
    value: { heartbeat?: { intervalSeconds?: number } };
  };
  return body.value.heartbeat?.intervalSeconds;
}

async function stop(instance: Instance): Promise<number> {
  instance.child.kill('SIGTERM');
  const code = await Promise.race([
    instance.child.exited,
    Bun.sleep(60_000).then(() => -1),
  ]);
  return code;
}

/** A replacement host restores what the prefix holds and SQLite agrees it is intact. */
async function freshRestoreHas(prefix: string, value: number): Promise<void> {
  const fresh = startInstance(prefix, await freePort());
  await healthy(fresh);
  expect(await read(fresh)).toBe(value);
  expect(await stop(fresh)).toBe(0);
  const db = new Database(join(fresh.directory, 'fleet.db'), {
    readonly: true,
  });
  try {
    expect(db.query('pragma integrity_check').get()).toEqual({
      integrity_check: 'ok',
    });
  } finally {
    db.close();
  }
}

const newPrefix = () => `ownership-test/${randomBytes(8).toString('hex')}`;

afterEach(() => {
  for (const instance of spawned.splice(0)) {
    instance.child.kill('SIGKILL');
    rmSync(instance.directory, { recursive: true, force: true });
  }
});

describe.skipIf(!enabled)('single writer across overlapping instances', () => {
  test('rolling deploy: the old writer hands over and no acknowledged write is lost', async () => {
    const prefix = newPrefix();
    const a = startInstance(prefix, await freePort());
    await healthy(a);
    expect(await write(a, 30)).toBe(200);

    const b = startInstance(prefix, await freePort());
    let acknowledged = 30;
    let value = 31;
    let refused = 0;
    // Keep writing to the old instance until the new one is serving.
    while (
      !(await fetch(`${b.base}/health`).then(
        (r) => r.ok,
        () => false
      ))
    ) {
      const status = await write(a, value);
      if (status === 200) acknowledged = value;
      else refused += 1;
      value += 1;
      if (b.child.exitCode !== null) throw new Error(b.output());
      await Bun.sleep(50);
    }
    if (process.env['FLEET_TEST_DUMP'])
      await Bun.write(
        process.env['FLEET_TEST_DUMP'],
        `A:\n${a.output()}\nB:\n${b.output()}\nacknowledged ${acknowledged}`
      );
    expect(refused).toBeGreaterThan(0); // The old writer stopped acknowledging during hand-over.
    expect(await read(b)).toBe(acknowledged);
    expect(await write(b, 500)).toBe(200);
    // The old instance is a standby now: alive, not serving writes, and stops cleanly.
    expect(a.child.exitCode).toBeNull();
    expect(await write(a, 999)).not.toBe(200);
    expect(await stop(a)).toBe(0);
    expect(await stop(b)).toBe(0);
    expect(a.output()).toContain('handing over; final replica sync');
    await freshRestoreHas(prefix, 500);
  }, 180_000);

  test('a killed writer is replaced after expiry, from its replicated state', async () => {
    const prefix = newPrefix();
    const a = startInstance(prefix, await freePort());
    await healthy(a);
    expect(await write(a, 41)).toBe(200);
    await Bun.sleep(2_500); // Past the 1 s replication interval.
    a.child.kill('SIGKILL');
    await a.child.exited;
    const b = startInstance(prefix, await freePort());
    await healthy(b, 60_000);
    expect(b.output()).toContain(
      'taking over from a writer that stopped renewing'
    );
    expect(await read(b)).toBe(41);
    expect(await stop(b)).toBe(0);
    await freshRestoreHas(prefix, 41);
  }, 180_000);

  test('a paused writer that resumes after a takeover refuses writes and steps down', async () => {
    const prefix = newPrefix();
    const a = startInstance(prefix, await freePort());
    await healthy(a);
    expect(await write(a, 51)).toBe(200);
    await Bun.sleep(2_500);
    // Freeze the whole old instance (supervisor, Litestream and worker), as a hung host would.
    const pids = [a.child.pid];
    const listing = Bun.spawnSync(['pgrep', '-P', String(a.child.pid)]);
    pids.push(
      ...listing.stdout.toString().split('\n').filter(Boolean).map(Number)
    );
    for (const pid of [...pids])
      pids.push(
        ...Bun.spawnSync(['pgrep', '-P', String(pid)])
          .stdout.toString()
          .split('\n')
          .filter(Boolean)
          .map(Number)
      );
    for (const pid of pids) process.kill(pid, 'SIGSTOP');
    const b = startInstance(prefix, await freePort());
    await healthy(b, 60_000);
    expect(await write(b, 52)).toBe(200);
    for (const pid of pids) process.kill(pid, 'SIGCONT');
    // Immediately after resuming, the old worker must not acknowledge a write.
    expect(await write(a, 666)).not.toBe(200);
    await Bun.sleep(4_000);
    expect(a.output()).toContain('writer ownership lost');
    expect(await read(b)).toBe(52);
    expect(await stop(a)).toBe(0);
    expect(await stop(b)).toBe(0);
    await freshRestoreHas(prefix, 52);
  }, 180_000);

  test('simultaneous cold starts: exactly one serves, the other waits', async () => {
    const prefix = newPrefix();
    const a = startInstance(prefix, await freePort());
    const b = startInstance(prefix, await freePort());
    await Promise.any([healthy(a), healthy(b)]);
    const probe = () =>
      Promise.all(
        [a, b].map((i) =>
          fetch(`${i.base}/health`).then(
            (r) => r.ok,
            () => false
          )
        )
      );
    // The first claimant may hand over to the second; never are both serving.
    let up = await probe();
    let stableSince = Date.now();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && Date.now() - stableSince < 5_000) {
      expect(up.filter(Boolean).length).toBeLessThanOrEqual(1);
      await Bun.sleep(200);
      const next = await probe();
      if (next.join() !== up.join() || !next.some(Boolean))
        stableSince = Date.now();
      up = next;
    }
    expect(up.filter(Boolean)).toHaveLength(1);
    const serving = up[0] ? a : b;
    expect(await write(serving, 61)).toBe(200);
    expect(await stop(a)).toBe(0);
    expect(await stop(b)).toBe(0);
    await freshRestoreHas(prefix, 61);
  }, 180_000);
});
