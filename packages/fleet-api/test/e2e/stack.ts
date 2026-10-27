/**
 * The real fleet API for end-to-end tests, started as its own process.
 *
 *   bun test/e2e/stack.ts
 *
 * Starts a throwaway Postgres (schema built by Atlas exactly as in
 * production), then the server: `bun src/server.ts`, or the built Docker image
 * when FLEET_E2E_IMAGE is set (Linux, host networking). Prints one JSON line
 * with the address and credentials once /health answers, then runs until it
 * receives SIGTERM or stdin closes, and cleans everything up.
 *
 * Environment: FLEET_E2E_ROLE_TOKEN (default generated), FLEET_E2E_IMAGE (optional).
 */
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { freePort, startCluster } from '../support/cluster';
import { findTooling } from '../support/tooling';

const READY_TIMEOUT_MS = 60_000;
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
  throw new Error('the fleet API did not become healthy');
}

function serverEnv(
  databaseUrl: string,
  port: number,
  roleToken: string,
  secrets: { admin: string; session: string }
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    FLEET_ADMIN_TOKEN: secrets.admin,
    FLEET_SESSION_SECRET: secrets.session,
    FLEET_ROLE_TOKEN_HASHES: JSON.stringify({ ci: sha256(roleToken) }),
    FLEET_GITHUB_REPO: 'crvouga/fleet',
  };
  return env;
}

function spawnProcess(env: Record<string, string>): { stop(): Promise<void> } {
  const child = Bun.spawn([process.execPath, 'src/server.ts'], {
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

function spawnImage(
  image: string,
  env: Record<string, string>
): { stop(): Promise<void> } {
  const name = `fleet-api-e2e-${randomBytes(4).toString('hex')}`;
  const flags = Object.entries(env)
    .filter(([key]) => key !== 'PATH')
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const child = Bun.spawn(
    [
      'docker',
      'run',
      '--rm',
      '--name',
      name,
      '--network',
      'host',
      ...flags,
      image,
    ],
    { stdout: 'inherit', stderr: 'inherit' }
  );
  return {
    async stop() {
      Bun.spawnSync(['docker', 'stop', '--time', '10', name]);
      await child.exited;
    },
  };
}

async function main(): Promise<void> {
  const tooling = findTooling();
  if (tooling === null) {
    console.error('postgres or atlas is missing; cannot start the stack');
    process.exit(3);
  }
  const cluster = await startCluster(tooling);
  const database = await cluster.createDatabase();
  const port = await freePort();
  const roleToken =
    process.env['FLEET_E2E_ROLE_TOKEN'] ?? randomBytes(24).toString('hex');
  const secrets = {
    admin: randomBytes(24).toString('hex'),
    session: randomBytes(24).toString('hex'),
  };
  const env = serverEnv(cluster.url(database), port, roleToken, secrets);
  const image = process.env['FLEET_E2E_IMAGE'];
  const server =
    image === undefined || image === ''
      ? spawnProcess(env)
      : spawnImage(image, env);

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    cluster.destroy();
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
    await server.stop();
    cluster.destroy();
    throw err;
  }
  process.stdout.write(
    JSON.stringify({
      apiUrl: base,
      adminToken: secrets.admin,
      roleToken,
      databaseUrl: cluster.url(database),
      mode: image === undefined || image === '' ? 'process' : 'image',
    }) + '\n'
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
