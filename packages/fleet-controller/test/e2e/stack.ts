/**
 * The real fleet controller for end-to-end tests, started as its own process.
 *
 *   bun test/e2e/stack.ts
 *
 * Starts a real test worker with temporary SQLite state and fake credentials.
 * Production always starts through the Litestream supervisor.
 * Prints address/credentials after /health answers and cleans up on termination.
 * Environment: FLEET_E2E_ENROLLMENT_TOKEN (default generated; the older
 * FLEET_E2E_ROLE_TOKEN is still read). It approves and assigns ci.
 */
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { freePort } from '../support/port';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const READY_TIMEOUT_MS = 60_000;
const GITHUB_PASSTHROUGH = [
  'FLEET_GITHUB_API_URL',
  'FLEET_GITHUB_APP_PRIVATE_KEY',
] as const;
const POLL_MS = 200;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function waitHealthy(base: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(POLL_MS);
  }
  throw new Error('the fleet controller did not become healthy');
}

function serverEnv(
  databaseUrl: string,
  port: number,
  enrollmentToken: string,
  secrets: { admin: string; session: string }
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    FLEET_REPLICATION_MANAGED: '1',
    FLEET_S3_BUCKET: 'test-bucket',
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    FLEET_DATABASE_PATH: databaseUrl,
    PORT: String(port),
    FLEET_ADMIN_TOKEN: secrets.admin,
    FLEET_SESSION_SECRET: secrets.session,
    FLEET_ENROLLMENT_TOKENS: JSON.stringify([
      { sha256: sha256(enrollmentToken), role: 'ci' },
    ]),
  };
  // Optional GitHub App wiring for tests that run the controller against a
  // loopback fake of api.github.com. Nothing is passed unless the caller sets it.
  for (const name of GITHUB_PASSTHROUGH) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return env;
}

function spawnProcess(env: Record<string, string>): { stop(): Promise<void> } {
  const child = Bun.spawn([process.execPath, 'src/controller.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return {
    async stop() {
      child.kill('SIGTERM');
      await child.exited;
    },
  };
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const database = join(directory, 'fleet.db');
  const port = await freePort();
  const enrollmentToken =
    process.env['FLEET_E2E_ENROLLMENT_TOKEN'] ??
    process.env['FLEET_E2E_ROLE_TOKEN'] ??
    randomBytes(24).toString('hex');
  const secrets = {
    admin: randomBytes(24).toString('hex'),
    session: randomBytes(24).toString('hex'),
  };
  const env = serverEnv(database, port, enrollmentToken, secrets);
  const controller = spawnProcess(env);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await controller.stop();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(base);
  } catch (err: unknown) {
    await controller.stop();
    rmSync(directory, { recursive: true, force: true });
    throw err;
  }
  process.stdout.write(
    JSON.stringify({
      controllerUrl: base,
      adminToken: secrets.admin,
      enrollmentToken,
      // Older harnesses read this name; it is the same enrollment token.
      roleToken: enrollmentToken,
      databaseUrl: database,
      mode: 'process',
    }) + '\n'
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
