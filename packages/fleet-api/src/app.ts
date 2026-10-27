import {
  createLogger,
  errorDetails,
  observeHttp,
  type Logger,
} from '@pkgs/logger';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { AppDeps } from './deps';
import { RateLimiter } from './domain/rate-limit';
import { mountAdminEvents } from './routes/admin-events';
import { mountAdminNodes } from './routes/admin-nodes';
import { mountAdminSettings } from './routes/admin-settings';
import { mountHealth } from './routes/health';
import { apiError, rateLimitGuard } from './routes/http';
import { mountMetrics } from './routes/metrics';
import { mountNodeRoutes } from './routes/node-routes';

export const MAX_BODY_BYTES = 64 * 1024;

export interface RateLimitSetting {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ApiOptions {
  readonly log?: Logger;
  /** Per remote address. Defaults: register 20 per minute, login 10 per 5 minutes. */
  readonly registerLimit?: RateLimitSetting;
  readonly loginLimit?: RateLimitSetting;
  /** How long /health waits for the database before answering 503. Default 3 s. */
  readonly healthTimeoutMs?: number;
}

const REGISTER_LIMIT: RateLimitSetting = { limit: 20, windowMs: 60_000 };
const LOGIN_LIMIT: RateLimitSetting = { limit: 10, windowMs: 5 * 60_000 };

/**
 * The JSON API: node endpoints, admin endpoints, /health and /metrics. The
 * dashboard is mounted on the same app by `mountUi`. A rate limit on
 * `POST /login` is registered here so it runs before the dashboard's handler.
 */
export function createApi(deps: AppDeps, options: ApiOptions = {}): Hono {
  const log = options.log ?? createLogger({ name: 'fleet-api' });
  const clock = () => deps.now().getTime();
  const limiter = (setting: RateLimitSetting) =>
    new RateLimiter({ ...setting, now: clock });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.res = await observeHttp(
      log,
      c.req.raw,
      async () => {
        await next();
        return c.res;
      },
      () => c.req.routePath
    );
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        apiError(
          c,
          413,
          'payload_too_large',
          'The body may be at most 64 KiB.'
        ),
    })
  );
  app.use('/v1/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  mountHealth(app, deps.store, log, options.healthTimeoutMs);
  mountNodeRoutes(app, deps, {
    registerLimiter: limiter(options.registerLimit ?? REGISTER_LIMIT),
    log,
  });
  mountAdminNodes(app, deps);
  mountAdminEvents(app, deps);
  mountAdminSettings(app, deps);
  mountMetrics(app, deps);
  app.on(
    'POST',
    '/login',
    rateLimitGuard(limiter(options.loginLimit ?? LOGIN_LIMIT))
  );
  app.on(
    'GET',
    '/auth/login',
    rateLimitGuard(limiter(options.loginLimit ?? LOGIN_LIMIT))
  );
  app.all('/v1/*', (c) => apiError(c, 404, 'not_found', 'No such endpoint.'));

  app.onError((err, c) => {
    log.error('unhandled error', {
      route: c.req.routePath,
      error: errorDetails(err),
    });
    return apiError(c, 500, 'internal', 'Something went wrong on the server.');
  });
  return app;
}
