import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from 'hono/bun';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { RateLimiter } from '../domain/rate-limit';

/** `{ error, message }`: a stable code to branch on and a sentence to read. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string
): Response {
  return c.json({ error: code, message }, status);
}

/** A 400 that lists every problem found, as well as saying them in one sentence. */
export function invalidBody(
  c: Context,
  code: 'invalid_request' | 'invalid_settings',
  errors: readonly string[]
): Response {
  return c.json({ error: code, message: errors.join('; '), errors }, 400);
}

export type JsonBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

export async function readJson(c: Context): Promise<JsonBody> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: apiError(
        c,
        400,
        'invalid_request',
        'The body must be valid JSON.'
      ),
    };
  }
}

const ADDRESS = /^[0-9A-Fa-f:.]{2,45}$/;

function plausible(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && ADDRESS.test(trimmed) ? trimmed : null;
}

/**
 * The caller's address. The service sits behind Cloudflare and Railway, so
 * the socket address is the proxy: prefer `cf-connecting-ip` (set by
 * Cloudflare, not by the client), then the first `x-forwarded-for` entry,
 * then the socket. Used for rate limiting and for the node list, not for
 * authorization.
 */
export function clientAddress(c: Context): string | null {
  const cloudflare = plausible(c.req.header('cf-connecting-ip'));
  if (cloudflare !== null) return cloudflare;
  const forwarded = plausible(c.req.header('x-forwarded-for')?.split(',')[0]);
  if (forwarded !== null) return forwarded;
  try {
    return plausible(getConnInfo(c).remote.address);
  } catch {
    return null;
  }
}

/** Rejects with 429 and Retry-After once a caller exceeds the limiter. */
export function rateLimitGuard(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const decision = limiter.hit(clientAddress(c) ?? 'unknown');
    if (decision.allowed) return next();
    c.header('Retry-After', String(decision.retryAfterSeconds));
    return c.json(
      {
        error: 'rate_limited',
        message: 'Too many attempts. Wait a little and try again.',
        retryAfterSeconds: decision.retryAfterSeconds,
      },
      429
    );
  };
}
