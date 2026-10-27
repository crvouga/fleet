import { main } from './server';

const issuer = process.env['FLEET_LOCAL_OIDC_ISSUER'];
const client = process.env['FLEET_LOCAL_OIDC_CLIENT_ID'];
for (const key of [
  'FLEET_OIDC_ISSUER',
  'FLEET_OIDC_CLIENT_ID',
  'FLEET_PUBLIC_ORIGIN',
])
  delete process.env[key];
if (issuer || client) {
  process.env['FLEET_OIDC_ISSUER'] = issuer;
  process.env['FLEET_OIDC_CLIENT_ID'] = client;
  process.env['FLEET_PUBLIC_ORIGIN'] =
    `http://localhost:${process.env['PORT'] ?? '8082'}`;
}
process.stdout.write(
  'LIVE FLEET DATA: managed database; authenticated edits affect the live fleet. Local background jobs are disabled.\n'
);
await main({ local: true });
