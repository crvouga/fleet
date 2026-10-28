import type { Hono } from 'hono';

import { RateLimiter } from '../domain/rate-limit';
import type { AppDeps } from '../deps';
import {
  handleWebhook,
  validDelivery,
  validSignature,
} from '../github/webhook';

import { controllerError, rateLimitGuard } from './http';

const WEBHOOK_LIMIT = { limit: 600, windowMs: 60_000 } as const;
/** GitHub's `workflow_job` events are a few KiB; the app-wide body limit (64 KiB) applies too. */
const MAX_WEBHOOK_BYTES = 60 * 1024;

/**
 * `POST /v1/github/webhook`: only when FLEET_GITHUB_WEBHOOK_SECRET is set.
 * Unauthenticated, protected by the HMAC signature alone; a repeated delivery id
 * is acknowledged and not handled twice.
 */
export function mountGithubWebhook(app: Hono, deps: AppDeps): void {
  const { github } = deps;
  const limiter = new RateLimiter({
    ...WEBHOOK_LIMIT,
    now: () => deps.now().getTime(),
  });
  app.post('/v1/github/webhook', rateLimitGuard(limiter), async (c) => {
    const secret = github?.webhookSecret();
    if (github === undefined || secret === undefined)
      return controllerError(c, 404, 'not_found', 'No such endpoint.');
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_WEBHOOK_BYTES)
      return controllerError(
        c,
        413,
        'payload_too_large',
        'The body is too large.'
      );
    const raw = await c.req.text();
    if (!validSignature(secret, raw, c.req.header('x-hub-signature-256'))) {
      await deps.store.audit({
        actor: 'github:webhook',
        action: 'github.webhook',
        targetKind: 'github-integration',
        targetId: '1',
        outcome: 'denied',
        detail: { reason: 'bad signature' },
      });
      return controllerError(
        c,
        401,
        'invalid_signature',
        'The signature does not match.'
      );
    }
    const delivery = c.req.header('x-github-delivery');
    if (!validDelivery(delivery))
      return controllerError(
        c,
        400,
        'invalid_request',
        'X-GitHub-Delivery is required.'
      );
    if (github.deliveries.seen(delivery))
      return c.json({ ok: true, result: 'duplicate' });
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return controllerError(
        c,
        400,
        'invalid_request',
        'The body must be valid JSON.'
      );
    }
    const result = await handleWebhook(
      github,
      deps.store,
      c.req.header('x-github-event'),
      payload
    );
    github.deliveries.remember(delivery);
    return c.json({ ok: true, result });
  });
}
