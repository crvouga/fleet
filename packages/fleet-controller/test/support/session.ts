import { FleetBrowserAuth } from '../../src/auth/browser-auth';
import { sha256Hex } from '../../src/auth/hash';
import type { AccessRole } from '../../src/auth/roles';
import { SqliteAccessStore } from '../../src/db/access-store';
import type { ControllerContext } from './describe-controller';
import type { Harness } from './controller';

const ISSUER = 'https://provider.example/realms/test';

export interface SignedIn {
  readonly h: Harness;
  readonly cookie: string;
  readonly access: SqliteAccessStore;
  readonly headers: Record<string, string>;
}

/** Allowlists `email` with `role`, opens a session for it and returns a harness that sees it. */
export async function signInAs(
  ctx: ControllerContext,
  email: string,
  role: AccessRole,
  tokenChar = 's'
): Promise<SignedIn> {
  const access = new SqliteAccessStore(ctx.db.sql);
  await access.allow(email, 'test-owner', role);
  const token = tokenChar.repeat(43);
  const context = sha256Hex(
    JSON.stringify([ISSUER, 'fleet', 'http://localhost'])
  );
  await access.createSession(
    sha256Hex(token),
    { issuer: ISSUER, subject: `subject-${email}`, email },
    new Date(Date.now() + 43200000),
    context
  );
  const browser = new FleetBrowserAuth(
    access,
    { origin: 'http://localhost', issuer: ISSUER, clientId: 'fleet' },
    {
      async authorize() {
        throw new Error('not used');
      },
      async exchange() {
        throw new Error('not used');
      },
    },
    () => new Date()
  );
  const cookie = `fleet_${sha256Hex('http://localhost').slice(0, 16)}_session=${token}`;
  return {
    h: ctx.harness({ browser }),
    cookie,
    access,
    headers: { Cookie: cookie, Origin: 'http://localhost' },
  };
}
