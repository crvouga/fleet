import { describe, expect, test } from 'bun:test';
import { createConnection } from 'node:net';

import { readControllerEnv, type ControllerEnv } from '../src/env';
import { startController } from '../src/controller';

import {
  ADMIN_TOKEN,
  CI_ENROLLMENT_TOKEN,
  SESSION_SECRET,
} from './support/controller';
import { freePort } from './support/port';
import { databaseAvailable, useDatabase } from './support/database';
import { recordingLogger } from './support/recording-logger';
import {
  heartbeatBody,
  nodeIdOf,
  registerInput,
  secretOf,
  sha256,
} from './support/fixtures';

const envFor = (path: string): ControllerEnv => ({
  ...readControllerEnv({
    FLEET_S3_BUCKET: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    FLEET_DATABASE_PATH: path,
    FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
    FLEET_ENROLLMENT_TOKENS: JSON.stringify([
      { sha256: sha256(CI_ENROLLMENT_TOKEN), role: 'ci' },
    ]),
  }),
  port: 0,
});

const json = { 'Content-Type': 'application/json' };

/** A fresh TCP connection, which only succeeds while something is listening. */
function connect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

describe.skipIf(!databaseAvailable)('startController', () => {
  const database = useDatabase();

  test('serves node coordination endpoints and the dashboard over a real socket, then shuts down', async () => {
    const log = recordingLogger();
    const running = await startController(envFor(database().path), log);
    const base = `http://127.0.0.1:${running.port}`;
    try {
      expect((await fetch(`${base}/health`)).status).toBe(200);
      const anonymous = await fetch(`${base}/v1/nodes`);
      expect(anonymous.status).toBe(401);
      const login = await fetch(`${base}/login`);
      expect(login.status).toBe(200);
      expect(login.headers.get('content-type')).toContain('text/html');

      const registered = await fetch(`${base}/v1/nodes/register`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          nodeId: nodeIdOf(1),
          role: 'ci',
          hostname: 'ci-1234',
          secret: secretOf(1),
          enrollmentToken: CI_ENROLLMENT_TOKEN,
        }),
      });
      expect(registered.status).toBe(201);
      const beat = await fetch(`${base}/v1/heartbeat`, {
        method: 'POST',
        headers: {
          ...json,
          Authorization: `Bearer ${nodeIdOf(1)}.${secretOf(1)}`,
        },
        body: JSON.stringify(heartbeatBody(1)),
      });
      expect(beat.status).toBe(200);
      const nodes = await fetch(`${base}/v1/nodes`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      const listed = (await nodes.json()) as {
        nodes: { remoteAddr: string; status: string }[];
      };
      expect(listed.nodes[0]).toMatchObject({
        remoteAddr: '127.0.0.1',
        status: 'online',
      });
      const owner = await fetch(`${base}/v1/access/owner@example.org`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(owner.status).toBe(200);
      const access = await fetch(`${base}/v1/access`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(await access.json()).toEqual({ emails: ['owner@example.org'] });
    } finally {
      await running.stop();
    }
    await expect(connect(running.port)).rejects.toThrow();
    const logged = log.lines.join('\n');
    expect(logged).toContain('fleet controller listening');
    for (const secret of [
      ADMIN_TOKEN,
      SESSION_SECRET,
      CI_ENROLLMENT_TOKEN,
      secretOf(1),
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  test('local mode uses persisted data, keeps authentication and never prunes history', async () => {
    const fixture = database();
    const { store } = await fixture.newStore();
    await store.registerNode(registerInput(77, { approval: 'approved' }));
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await store.recordHeartbeat(nodeIdOf(77), heartbeatBody(77), null, old);
    const running = await startController(
      envFor(fixture.path),
      recordingLogger(),
      {
        local: true,
      }
    );
    const base = `http://127.0.0.1:${running.port}`;
    const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    try {
      expect((await fetch(`${base}/v1/nodes`)).status).toBe(401);
      const nodes = await fetch(`${base}/v1/nodes`, { headers });
      expect(nodes.headers.get('X-Fleet-Data-Source')).toBe('managed');
      expect(await nodes.json()).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: nodeIdOf(77) }),
        ]),
      });
      const page = await fetch(base, { headers });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('LIVE FLEET DATA');
      // Normal startup immediately launches history pruning. Local startup must
      // preserve old records while still reading the same persistent store.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        await store.listHeartbeats(nodeIdOf(77), new Date(0))
      ).toHaveLength(1);
    } finally {
      await running.stop();
    }
  });

  test('the login limit runs in front of the dashboard handler', async () => {
    const running = await startController(
      envFor(database().path),
      recordingLogger()
    );
    const base = `http://127.0.0.1:${running.port}`;
    try {
      const attempt = () =>
        fetch(`${base}/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: base,
          },
          body: 'username=nobody&password=wrong',
        });
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) statuses.push((await attempt()).status);
      expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(
        true
      );
      expect(statuses.slice(10)).toEqual([429, 429]);
    } finally {
      await running.stop();
    }
  });

  test('refuses an unusable SQLite path before listening', async () => {
    await expect(
      startController(envFor('/dev/null/fleet.db'), recordingLogger())
    ).rejects.toThrow();
  });

  describe('as a process', () => {
    const run = async (env: Record<string, string>) => {
      const child = Bun.spawn(['bun', 'src/controller.ts'], {
        cwd: `${import.meta.dir}/..`,
        env: {
          PATH: process.env['PATH'] ?? '',
          TMPDIR: process.env['TMPDIR'] ?? '/tmp',
          FLEET_REPLICATION_MANAGED: '1',
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return child;
    };

    test('refuses to start with a bad environment, naming the variables and none of the values', async () => {
      const child = await run({
        FLEET_S3_BUCKET: 'test-bucket',
        AWS_ACCESS_KEY_ID: 'test-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
        FLEET_ADMIN_TOKEN: 'short-secret-value',
        FLEET_SESSION_SECRET: 'x'.repeat(40),
        FLEET_ENROLLMENT_TOKENS: '[]',
      });
      const code = await child.exited;
      const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`;
      expect(code).toBe(1);
      expect(output).toContain('FLEET_ADMIN_TOKEN must be at least 32');
      expect(output).not.toContain('topsecretpw');
      expect(output).not.toContain('short-secret-value');
    });

    test('an occupied PORT fails nonzero with the corrective action', async () => {
      const occupied = Bun.serve({
        hostname: '0.0.0.0',
        port: 0,
        fetch: () => new Response('reserved'),
      });
      try {
        const child = await run({
          FLEET_S3_BUCKET: 'test-bucket',
          AWS_ACCESS_KEY_ID: 'test-key',
          AWS_SECRET_ACCESS_KEY: 'test-secret',
          FLEET_DATABASE_PATH: database().path,
          FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
          PORT: String(occupied.port),
        });
        expect(await child.exited).toBe(1);
        const output =
          (await new Response(child.stdout).text()) +
          (await new Response(child.stderr).text());
        expect(output).toContain('PORT is already in use');
        expect(output).toContain('Stop the other Fleet process');
        expect(output).not.toContain(ADMIN_TOKEN);
      } finally {
        await occupied.stop();
      }
    });

    test('starts from the environment, answers /health and exits 0 on SIGTERM', async () => {
      const port = await freePort();
      const child = await run({
        FLEET_S3_BUCKET: 'test-bucket',
        AWS_ACCESS_KEY_ID: 'test-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
        FLEET_DATABASE_PATH: database().path,
        PORT: String(port),
        FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
        FLEET_SESSION_SECRET: SESSION_SECRET,
        FLEET_ENROLLMENT_TOKENS: '[]',
      });
      try {
        let status = 0;
        const deadline = Date.now() + 15_000;
        while (status !== 200 && Date.now() < deadline) {
          status = await fetch(`http://127.0.0.1:${port}/health`).then(
            (r) => r.status,
            () => 0
          );
          if (status !== 200) await Bun.sleep(100);
        }
        expect(status).toBe(200);
        child.kill('SIGTERM');
        const code = await Promise.race([
          child.exited,
          Bun.sleep(8000).then(() => -1),
        ]);
        expect(code).toBe(0);
      } finally {
        child.kill('SIGKILL');
      }
    }, 30_000);
  });
});
