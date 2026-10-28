import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

import type { AccessRole } from '../auth/roles';
import type { AdminAuth } from '../deps';

const COOKIE = 'fleet_session';

export interface FakeAuthOptions {
  /** Every request is treated as this person; used by the design demo. */
  readonly alwaysSignedInAs?: string;
}

/** Cookie `fleet_session=ok:<name>` signs in an admin; `viewer:<name>` signs in a read-only viewer. */
export function createFakeAuth(options: FakeAuthOptions = {}): AdminAuth {
  return {
    async actor(c: Context): Promise<string | null> {
      if (options.alwaysSignedInAs !== undefined)
        return options.alwaysSignedInAs;
      const cookie = getCookie(c, COOKIE);
      if (cookie?.startsWith('ok:') === true) return cookie.slice(3);
      return cookie?.startsWith('viewer:') === true ? cookie.slice(7) : null;
    },
    async role(c: Context): Promise<AccessRole | null> {
      if (options.alwaysSignedInAs !== undefined) return 'admin';
      const cookie = getCookie(c, COOKIE);
      if (cookie?.startsWith('ok:') === true) return 'admin';
      return cookie?.startsWith('viewer:') === true ? 'viewer' : null;
    },
    logoutCookie(): string {
      return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
    },
    sameOrigin(c: Context): boolean {
      const origin = c.req.header('origin');
      if (origin === undefined) return false;
      try {
        return new URL(origin).host === new URL(c.req.url).host;
      } catch {
        return false;
      }
    },
  };
}
