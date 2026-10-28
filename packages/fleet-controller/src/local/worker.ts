import { writeFile } from 'node:fs/promises';
import { createLogger } from '@pkgs/logger';
import { startController } from '../controller';
import { readControllerEnv } from '../env';
import { createDb } from '../db/client';
import { SqliteAccessStore } from '../db/access-store';
import { FleetAdminAuth } from '../auth/admin-auth';
import { FleetBrowserAuth } from '../auth/browser-auth';
import { createOidcClient } from '../auth/oidc-client';
import type { AuthContext } from '../auth/contracts';
import { localClientId } from './emulators';
import { loopback } from './paths';

const issuer = loopback(process.env['FLEET_LOCAL_OIDC_ISSUER']!).origin;
if (process.env['FLEET_REPLICATION_MANAGED'] !== '1')
  throw new Error(
    'Start local Fleet through bun run local so Litestream supervises storage'
  );
const env = readControllerEnv();
const origin = `http://127.0.0.1:${env.port}`;
const oidc = { issuer, clientId: localClientId, origin };
const transport: AuthContext['fetch'] = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== issuer)
    throw new Error('Local emulation blocked an external request');
  return fetch(input, { ...init, redirect: 'error' });
};
// Explicit local owner, never a first-user grant; managed startup never calls this.
const db = await createDb(env.storage);
try {
  await new SqliteAccessStore(db).allow(
    process.env['FLEET_LOCAL_OWNER_EMAIL']!,
    'local-owner'
  );
} finally {
  await db.close();
}
const running = await startController(
  { ...env, oidc },
  createLogger({ name: 'fleet-local', level: 'info' }),
  {
    local: 'emulated',
    fetch: transport,
    authFactory(context) {
      const browserAuth = new FleetBrowserAuth(
        context.access,
        oidc,
        createOidcClient(oidc, context.fetch, true),
        context.now
      );
      return {
        browserAuth,
        auth: new FleetAdminAuth({
          env,
          browser: browserAuth,
          publicOrigin: origin,
        }),
      };
    },
  }
);
await writeFile(
  process.env['FLEET_LOCAL_READY_FILE']!,
  JSON.stringify({
    url: origin,
    dependencies: { oidc: issuer, s3: env.storage.endpoint },
  }),
  { mode: 0o600 }
);
process.stdout.write(
  `Fleet local (Mockingbird dependencies): ${origin}\nSign in as ${process.env['FLEET_LOCAL_OWNER_EMAIL']}. Fleet starts empty; changes persist in this checkout.\n`
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(() => process.exit(0));
  });
