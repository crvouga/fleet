import type { Context, Hono } from 'hono';

import { emailAddress, type AccessStore } from '../auth/browser-contract';
import type { AppDeps } from '../deps';

import { adminRoute, requireAdmin } from './guards';
import { controllerError } from './http';

/** The list browser sign-in consults, so an injected auth adapter stays authoritative. */
function storeOf(deps: AppDeps): AccessStore | undefined {
  return deps.browserAuth?.access ?? deps.access;
}

function unavailable(c: Context): Response {
  return controllerError(
    c,
    404,
    'access_unavailable',
    'This controller has no browser access list.'
  );
}

/**
 * A change to who may sign in is audited by the access store in the same
 * transaction. A refused revoke changes nothing, so the store writes no row:
 * leave one here, because a failed attempt to remove access is worth seeing.
 */
async function recordRefusedRevoke(
  deps: AppDeps,
  actor: string,
  email: string
): Promise<void> {
  await deps.store.audit({
    actor,
    action: 'access.revoke',
    targetKind: 'access',
    targetId: email,
    outcome: 'failed',
  });
}

function badEmail(c: Context): Response {
  return controllerError(
    c,
    400,
    'invalid_email',
    'The path must end in a valid email address.'
  );
}

/**
 * The browser allowlist for the admin token holder: how the first owner is
 * authorized on a host where nobody can run `bun run access:allow` beside the
 * service. Signing in never adds an email; only these routes, the /access
 * page and the owner CLI do.
 */
export function mountAdminAccess(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/access',
    adminRoute(deps, async (c, actor) => {
      const denied = await requireAdmin(deps, c, actor, 'access.read');
      if (denied !== null) return denied;
      const store = storeOf(deps);
      if (!store) return unavailable(c);
      return c.json({ emails: await store.emails() });
    })
  );
  app.put(
    '/v1/access/:email',
    adminRoute(deps, async (c, actor) => {
      const store = storeOf(deps);
      if (!store) return unavailable(c);
      const email = emailAddress(c.req.param('email'));
      if (!email) return badEmail(c);
      await store.allow(email, actor);
      return c.json({ email, allowed: true });
    })
  );
  app.delete(
    '/v1/access/:email',
    adminRoute(deps, async (c, actor) => {
      const store = storeOf(deps);
      if (!store) return unavailable(c);
      const email = emailAddress(c.req.param('email'));
      if (!email) return badEmail(c);
      if (!(await store.revoke(email, actor))) {
        await recordRefusedRevoke(deps, actor, email);
        return controllerError(
          c,
          409,
          'cannot_revoke',
          'Cannot remove the final allowed account, or that email is not listed.'
        );
      }
      return c.json({ email, allowed: false });
    })
  );
}
