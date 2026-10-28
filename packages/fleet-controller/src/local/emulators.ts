import { createRuntime as createIdentity } from '@crvouga/mockingbird-service-oauth';
import { createRuntime as createS3 } from '@crvouga/mockingbird-service-s3';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emailAddress } from '../auth/browser-contract';
import { stateDir } from './paths';
import { restoredS3, saveS3 } from './snapshots';

export const localClientId = 'fleet-local';

async function localToken() {
  const credentials = Bun.file(join(stateDir, 'credentials.json'));
  const token = (await credentials.exists())
    ? ((await credentials.json()) as { adminToken: string }).adminToken
    : randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error('Invalid local credentials file');
  await writeFile(credentials.name!, JSON.stringify({ adminToken: token }), {
    mode: 0o600,
  });
  return token;
}

/** Loopback-only external services. No Fleet nodes, telemetry or settings are seeded. */
export async function emulators(port: string) {
  const owner = emailAddress(
    process.env['FLEET_LOCAL_OWNER_EMAIL'] ?? 'owner@example.test'
  );
  if (!owner)
    throw new Error('FLEET_LOCAL_OWNER_EMAIL must be an email address');
  const origin = `http://127.0.0.1:${port}`;
  const token = await localToken();
  const identity = createIdentity({
    provider: 'oidc',
    accounts: [
      {
        id: 'local-owner',
        email: owner,
        name: 'Local owner',
        emailVerified: true,
      },
    ],
    clients: [
      {
        id: localClientId,
        name: 'Fleet local',
        redirectUris: [`${origin}/auth/callback`],
      },
    ],
  });
  const s3 = createS3({
    buckets: ['fleet-local'],
    credentials: { fixture: 'fixture' },
    adminControls: await restoredS3(join(stateDir, 's3.json')),
  });
  const authServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => identity.fetch(r),
  });
  const s3Server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => s3.fetch(r),
  });
  const endpoints = {
    oidc: `http://127.0.0.1:${authServer.port}`,
    s3: `http://127.0.0.1:${s3Server.port}`,
  };
  return {
    endpoints,
    env: {
      PORT: port,
      FLEET_ADMIN_TOKEN: token,
      FLEET_DATABASE_PATH: join(stateDir, 'data', 'fleet.db'),
      FLEET_S3_BUCKET: 'fleet-local',
      FLEET_S3_PREFIX: 'fleet',
      FLEET_S3_ENDPOINT: endpoints.s3,
      AWS_ACCESS_KEY_ID: 'fixture',
      AWS_SECRET_ACCESS_KEY: 'fixture',
      AWS_REGION: 'us-east-1',
      FLEET_LOCAL_OIDC_ISSUER: endpoints.oidc,
      FLEET_LOCAL_OWNER_EMAIL: owner,
    },
    async stop() {
      await Promise.all([authServer.stop(true), s3Server.stop(true)]);
      await saveS3(s3, join(stateDir, 's3.json'));
    },
  };
}
