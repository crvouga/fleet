import type { Context, Handler } from 'hono';

import { matchesAdminToken } from '../auth/admin-token';
import {
  isReadMethod,
  mayWrite,
  VIEWER_DENIED_MESSAGE,
  type AccessRole,
} from '../auth/roles';
import type { AppDeps } from '../deps';

import { controllerError } from './http';

export type AdminHandler = (
  c: Context,
  actor: string
) => Response | Promise<Response>;

export interface AdminRouteOptions {
  /**
   * `write` (the default for POST, PUT, PATCH and DELETE) needs an admin;
   * `read` lets a viewer through. A route that is read-only despite its method
   * may say `access: 'read'`; nothing else should.
   */
  readonly access?: 'read' | 'write';
}

/** True only when the request itself carries the admin token, as scripts and CI do. */
function presentsAdminToken(c: Context, deps: AppDeps): boolean {
  const header = c.req.header('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  return matchesAdminToken(header.slice('Bearer '.length).trim(), deps.env);
}

/** The caller's role. Auth adapters that predate roles make every actor an admin. */
export async function roleOf(deps: AppDeps, c: Context): Promise<AccessRole> {
  if (deps.auth.role === undefined) return 'admin';
  return (await deps.auth.role(c)) ?? 'viewer';
}

/** Records a refused request. A failing audit write never hides the refusal. */
export async function auditDenied(
  deps: AppDeps,
  c: Context,
  who: { readonly actor: string; readonly role: AccessRole },
  action = 'auth.denied'
): Promise<void> {
  try {
    await deps.store.audit({
      actor: who.actor,
      actorRole: who.role,
      action,
      targetKind: 'http',
      targetId: `${c.req.method} ${c.req.path}`.slice(0, 200),
      outcome: 'denied',
      detail: { reason: 'viewer cannot change state', method: c.req.method },
    });
  } catch {
    // The 403 below is the contract; the audit row is best effort.
  }
}

/**
 * Null when the actor may change state; otherwise the 403 `forbidden`
 * response, already audited as denied. Handlers that decide for themselves
 * whether a request writes (for example a POST that may only preview) call
 * this directly.
 */
export async function requireAdmin(
  deps: AppDeps,
  c: Context,
  actor: string,
  action?: string
): Promise<Response | null> {
  const role = await roleOf(deps, c);
  if (mayWrite(role)) return null;
  await auditDenied(deps, c, { actor, role }, action);
  return controllerError(c, 403, 'forbidden', VIEWER_DENIED_MESSAGE);
}

/**
 * Wraps a handler so only a signed-in actor reaches it, and only an administrator
 * reaches it with a state-changing method. A Bearer admin token is an admin and
 * needs no further check. A session cookie is ambient, so a state-changing
 * request made with one must come from this site (CSRF). Viewers may call
 * every GET.
 */
export function adminRoute(
  deps: AppDeps,
  handler: AdminHandler,
  options: AdminRouteOptions = {}
): Handler {
  return async (c) => {
    const actor = await deps.auth.actor(c);
    if (actor === null) {
      return controllerError(
        c,
        401,
        'unauthorized',
        'Sign in or send the admin token as a Bearer credential.'
      );
    }
    const writes = options.access
      ? options.access === 'write'
      : !isReadMethod(c.req.method);
    if (writes && !presentsAdminToken(c, deps) && !deps.auth.sameOrigin(c)) {
      return controllerError(
        c,
        403,
        'cross_origin',
        'State-changing requests must come from this site.'
      );
    }
    if (writes) {
      const denied = await requireAdmin(deps, c, actor);
      if (denied !== null) return denied;
    }
    return handler(c, actor);
  };
}
