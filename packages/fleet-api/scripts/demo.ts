/**
 * Boots the dashboard on a local port with an in-memory store full of
 * realistic nodes. No database, no login. `bun run demo`, then open the URL.
 */
import { Hono } from 'hono';

import { mountUi } from '../src/routes/ui';
import { DEMO_LATEST, seedDemo } from '../src/testing/demo-data';
import { createFakeAuth } from '../src/testing/fake-auth';
import { MemoryStore } from '../src/testing/memory-store';
import type { AppDeps } from '../src/deps';

const port = Number(process.env['PORT'] ?? 4300);
let clock = new Date();
const store = new MemoryStore(() => clock);

const deps: AppDeps = {
  store,
  auth: createFakeAuth({ alwaysSignedInAs: 'chris' }),
  revisions: { latest: async () => DEMO_LATEST },
  env: {
    adminToken: 'demo',

    roleTokenHashes: {},
    githubRepo: 'crvouga/fleet',
  },
  now: () => new Date(),
};

const empty = process.argv.includes('--empty');
if (!empty) seedDemo(store, new Date(), (at) => (clock = at));

const app = new Hono();
app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.get('content-type')?.includes('text/html')) return;
  const html = await c.res.text();
  c.res = new Response(
    html.replace(
      '<head>',
      '<head><meta name="fleet-data-source" content="fixtures">'
    ),
    {
      status: c.res.status,
      headers: c.res.headers,
    }
  );
});
mountUi(app, deps);
Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch });
process.stdout.write(
  `LOCAL DEMO: synthetic fleet data, in-memory storage, no live fleet or Vault access.\nFleet dashboard demo: http://localhost:${port}${empty ? ' (empty)' : ''}\n`
);
