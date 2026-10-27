import type { Context } from 'hono';

import type { AppDeps } from '../../deps';
import { setFlash, type Flash } from '../lib/flash';

export type Handler = (c: Context) => Promise<Response>;
export type ActorHandler = (c: Context, actor: string) => Promise<Response>;

/** Only same-site paths: `//host`, `/\host` and absolute URLs are refused. */
export function safeNext(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback;
  if (
    value.startsWith('//') ||
    value.includes('\\') ||
    /[\u0000-\u001f]/.test(value)
  )
    return fallback;
  return value;
}

function currentPath(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

/** Pages: no signed-in person means 303 to the sign-in page, remembering where they were going. */
export function page(deps: AppDeps, run: ActorHandler): Handler {
  return async (c) => {
    const actor = await deps.auth.actor(c);
    if (actor === null && (await deps.browserAuth?.identity(c)))
      return c.redirect('/not-allowed', 303);
    if (actor === null)
      return c.redirect(
        `/login?next=${encodeURIComponent(currentPath(c))}`,
        303
      );
    c.header('Cache-Control', 'no-store');
    return run(c, actor);
  };
}

/** State changes: same-origin first (403), then a signed-in person (303). */
export function action(deps: AppDeps, run: ActorHandler): Handler {
  return async (c) => {
    if (!deps.auth.sameOrigin(c))
      return c.text('Forbidden: cross-site request refused.', 403);
    const actor = await deps.auth.actor(c);
    if (actor === null)
      return c.redirect(
        (await deps.browserAuth?.identity(c)) ? '/not-allowed' : '/login',
        303
      );
    return run(c, actor);
  };
}

/** Remember a message and send the browser back. A POST is never rendered directly. */
export function back(c: Context, to: string, flash: Flash): Response {
  if (c.req.header('accept')?.includes('application/json'))
    return c.json({ redirect: to, flash });
  setFlash(c, flash);
  return c.redirect(to, 303);
}
