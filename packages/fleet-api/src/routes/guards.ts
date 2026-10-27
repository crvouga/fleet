import type { Context, Handler } from 'hono';

import { safeEqual } from '../auth/hash';
import type { AppDeps } from '../deps';

import { apiError } from './http';

export type AdminHandler = (
  c: Context,
  actor: string
) => Response | Promise<Response>;

/** True only when the request itself carries the admin token, as scripts and CI do. */
function presentsAdminToken(c: Context, deps: AppDeps): boolean {
  const header = c.req.header('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  return safeEqual(header.slice('Bearer '.length).trim(), deps.env.adminToken);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Wraps a handler so only an administrator reaches it. A Bearer token needs
 * no further check. A session cookie is ambient, so a state-changing request
 * made with one must come from this site (CSRF).
 */
export function adminRoute(deps: AppDeps, handler: AdminHandler): Handler {
  return async (c) => {
    const actor = await deps.auth.actor(c);
    if (actor === null) {
      return apiError(
        c,
        401,
        'unauthorized',
        'Sign in or send the admin token as a Bearer credential.'
      );
    }
    if (
      !SAFE_METHODS.has(c.req.method) &&
      !presentsAdminToken(c, deps) &&
      !deps.auth.sameOrigin(c)
    ) {
      return apiError(
        c,
        403,
        'cross_origin',
        'State-changing requests must come from this site.'
      );
    }
    return handler(c, actor);
  };
}
