import type { Context, Hono } from 'hono';

import { RateLimiter } from '../domain/rate-limit';
import type { AppDeps } from '../deps';
import {
  registerRunner,
  type RegistrationRequest,
} from '../github/registration';

import { controllerError, invalidBody, readJson } from './http';
import { authenticate } from './node-routes';

const LIMIT = { limit: 30, windowMs: 60_000 } as const;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLOT = /^slot-([1-9][0-9]?)$/;
const MAX_SLOT = 64;
const KNOWN = ['slot', 'repository', 'idempotencyKey'];

type Parsed =
  | { readonly ok: true; readonly value: RegistrationRequest }
  | { readonly ok: false; readonly errors: string[] };

function slotOf(raw: unknown): number | null {
  const value = typeof raw === 'string' ? Number(SLOT.exec(raw)?.[1]) : raw;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_SLOT
    ? value
    : null;
}

function problemsOf(body: Record<string, unknown>): string[] {
  const errors = Object.keys(body)
    .filter((key) => !KNOWN.includes(key))
    .map((key) => `${key} is not a field`);
  if (slotOf(body['slot']) === null)
    errors.push(`slot must be slot-N or a number from 1 to ${MAX_SLOT}`);
  const repository = body['repository'];
  if (
    repository !== undefined &&
    !(typeof repository === 'string' && REPOSITORY.test(repository))
  )
    errors.push('repository must be owner/name');
  const key = body['idempotencyKey'];
  if (key !== undefined && !(typeof key === 'string' && KEY.test(key)))
    errors.push('idempotencyKey must be 8 to 64 characters of A-Z a-z 0-9 _ -');
  return errors;
}

/** `{ slot: 3 | "slot-3", repository?: "owner/name", idempotencyKey?: string }`. */
export function parseRegistration(input: unknown): Parsed {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, errors: ['the body must be an object'] };
  const body = input as Record<string, unknown>;
  const errors = problemsOf(body);
  const slot = slotOf(body['slot']);
  if (errors.length > 0 || slot === null) return { ok: false, errors };
  const { repository, idempotencyKey } = body;
  return {
    ok: true,
    value: {
      slot,
      ...(typeof repository === 'string' ? { repository } : {}),
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    },
  };
}

/**
 * `POST /v1/runner-registration`: the node proves itself with its own
 * credential and receives a one-hour GitHub registration token. The GitHub App
 * key never leaves the controller.
 */
export function mountRunnerRegistration(app: Hono, deps: AppDeps): void {
  const limiter = new RateLimiter({
    ...LIMIT,
    now: () => deps.now().getTime(),
  });
  app.post('/v1/runner-registration', async (c: Context) => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) return auth.response;
    const decision = limiter.hit(auth.node.id);
    if (!decision.allowed) {
      c.header('Retry-After', String(decision.retryAfterSeconds));
      return controllerError(
        c,
        429,
        'rate_limited',
        'Too many registration requests. Wait a little and try again.'
      );
    }
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = parseRegistration(body.value);
    if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
    if (deps.github === undefined)
      return controllerError(
        c,
        422,
        'github_refused',
        'The GitHub integration is not available.'
      );
    const outcome = await registerRunner(
      deps,
      deps.github,
      auth.node,
      parsed.value
    );
    if (outcome.ok) return c.json(outcome.grant);
    if (outcome.retryAfterSeconds !== undefined)
      c.header('Retry-After', String(outcome.retryAfterSeconds));
    return c.json(
      {
        error: outcome.error,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: outcome.retryAfterSeconds }),
      },
      outcome.status
    );
  });
}
