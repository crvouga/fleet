import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { killTree } from './support/process-tree';
import { freePort } from './support/port';
import { nodeIdOf, secretOf } from './support/fixtures';

const binary = process.env['FLEET_TEST_LITESTREAM_BIN'];
const bucket = process.env['FLEET_TEST_S3_BUCKET'];
const enabled = Boolean(binary && bucket);

async function waitHealthy(
  base: string,
  child: ReturnType<typeof Bun.spawn>
): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`controller exited ${child.exitCode}`);
    if (
      await fetch(`${base}/health`).then(
        (r) => r.ok,
        () => false
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error('controller did not become ready');
}

/** Uses an isolated random prefix in a disposable bucket. Objects are retained for inspection. */
test.skipIf(!enabled)(
  'Litestream S3: fresh host restores nodes, settings, history and owner access',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-replication-'));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const token = randomBytes(32).toString('hex');
    const env = {
      PATH: process.env['PATH'] ?? '',
      FLEET_ADMIN_TOKEN: token,
      FLEET_LITESTREAM_BIN: binary as string,
      FLEET_DATABASE_PATH: join(directory, 'data/fleet.db'),
      FLEET_S3_BUCKET: bucket as string,
      FLEET_S3_PREFIX: `fleet-test/${randomBytes(12).toString('hex')}`,
      FLEET_S3_ENDPOINT: process.env['FLEET_TEST_S3_ENDPOINT'] ?? '',
      AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
      AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
      AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
      PORT: String(port),
    };
    const spawn = () =>
      Bun.spawn([process.execPath, 'src/start.ts'], {
        cwd: join(import.meta.dir, '..'),
        env,
        stdout: 'ignore',
        stderr: 'inherit',
      });
    const stop = async (child: ReturnType<typeof spawn>) => {
      child.kill('SIGTERM');
      const code = await Promise.race([
        child.exited,
        Bun.sleep(15000).then(() => -999),
      ]);
      if (code === -999) killTree(child.pid);
      expect(code).toBe(0);
    };
    let child = spawn();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    try {
      await waitHealthy(base, child);
      const registered = await fetch(`${base}/v1/nodes/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          nodeId: nodeIdOf(1),
          hostname: 'portable-node',
          role: 'ci',
          secret: secretOf(1),
        }),
      });
      expect(registered.status).toBe(201);
      const settings = await fetch(`${base}/v1/settings/fleet`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ heartbeat: { intervalSeconds: 90 } }),
      });
      expect(settings.status).toBe(200);
      // The owner CLI would be a second writer beside the live owner: it refuses.
      const cli = Bun.spawn(
        [process.execPath, 'src/db/allow-email.ts', 'owner@example.org'],
        {
          cwd: join(import.meta.dir, '..'),
          env,
          stdout: 'ignore',
          stderr: 'ignore',
        }
      );
      expect(await cli.exited).toBe(1);
      // Authorization goes through the owner over HTTP instead.
      const owner = await fetch(`${base}/v1/access/owner@example.org`, {
        method: 'PUT',
        headers,
      });
      expect(owner.status).toBe(200);
      await Bun.sleep(2200);
      await stop(child);
      // Simulate loss of all local state; the bucket is the only surviving data source.
      rmSync(join(directory, 'data'), { recursive: true, force: true });
      child = spawn();
      await waitHealthy(base, child);
      const nodes = await fetch(`${base}/v1/nodes`, { headers });
      expect(await nodes.json()).toMatchObject({
        nodes: [
          expect.objectContaining({
            id: nodeIdOf(1),
            hostname: 'portable-node',
          }),
        ],
      });
      const restored = await fetch(`${base}/v1/settings/fleet`, { headers });
      expect(JSON.stringify(await restored.json())).toContain('90');
      const events = await fetch(`${base}/v1/events`, { headers });
      expect(JSON.stringify(await events.json())).toContain('registered');
      // Read restored authorization through the same storage implementation.
      const { createDb } = await import('../src/db/client');
      const db = await createDb({ path: env.FLEET_DATABASE_PATH });
      try {
        expect(await db`select email from allowed_emails`).toEqual(
          expect.arrayContaining([{ email: 'owner@example.org' }])
        );
      } finally {
        await db.close();
      }
    } finally {
      await stop(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60000
);

test.skipIf(!enabled || !process.env['FLEET_TEST_DENIED_BUCKET'])(
  'real Litestream refuses startup when S3 reads work but writes are denied',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-denied-write-'));
    const port = await freePort();
    const child = Bun.spawn([process.execPath, 'src/start.ts'], {
      cwd: join(import.meta.dir, '..'),
      env: {
        PATH: process.env['PATH'] ?? '',
        FLEET_ADMIN_TOKEN: randomBytes(32).toString('hex'),
        FLEET_LITESTREAM_BIN: binary as string,
        FLEET_DATABASE_PATH: join(directory, 'fleet.db'),
        FLEET_S3_BUCKET: process.env['FLEET_TEST_DENIED_BUCKET'] as string,
        FLEET_S3_PREFIX: `denied/${randomBytes(8).toString('hex')}`,
        FLEET_STARTUP_TIMEOUT_SECONDS: '2',
        FLEET_S3_ENDPOINT: process.env['FLEET_TEST_S3_ENDPOINT'] ?? '',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_REGION: 'us-east-1',
        PORT: String(port),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      expect(await child.exited).toBe(1);
      const output =
        (await new Response(child.stdout).text()) +
        (await new Response(child.stderr).text());
      // Writer ownership needs a conditional write, so denied writes stop startup there.
      expect(output).toContain(
        'Object storage refused or ignored a conditional write'
      );
      expect(output).toContain('Put/Get/Delete permissions');
      expect(
        await fetch(`http://127.0.0.1:${port}/health`).then(
          () => true,
          () => false
        )
      ).toBe(false);
    } finally {
      killTree(child.pid);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30000
);
