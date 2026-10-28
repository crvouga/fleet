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
import { mountAdminAccess } from './routes/admin-access';
import { mountAdminEvents } from './routes/admin-events';
import { mountAdminNodes } from './routes/admin-nodes';
import { mountAdminOperations } from './routes/admin-operations';
import { mountAdminAudit } from './routes/admin-audit';
import { mountOwnershipStatus } from './routes/ownership-status';
import { mountAdminIssues } from './routes/admin-issues';
import { internalError } from './issues/error-response';
import { mountAdminSettings } from './routes/admin-settings';
import { mountHealth } from './routes/health';
import { controllerError, rateLimitGuard } from './routes/http';
import { mountMetrics } from './routes/metrics';
import { mountNodeRoutes } from './routes/node-routes';
import { mountGithub } from './routes/github-routes';

export const MAX_BODY_BYTES = 64 * 1024;
const REQUEST_FAILED = 'The Fleet controller could not complete the request.';

export interface RateLimitSetting {
  readonly limit: number;
  readonly windowMs: number;
}

export interface ControllerAppOptions {
  readonly log?: Logger;
  /** Per remote address. Defaults: register 20 per minute, login 10 per 5 minutes. */
  readonly registerLimit?: RateLimitSetting;
  readonly loginLimit?: RateLimitSetting;
  /** How long /health waits for the database before answering 503. Default 3 s. */
  readonly healthTimeoutMs?: number;
  /**
   * False while this process may not serve requests (another instance owns
   * the replica, or ownership is being handed over). Default: always.
   */
  readonly writable?: () => boolean;
}

/** Served even while not the writer: liveness and immutable static files. */
const ALWAYS_SERVED = (path: string) =>
  path === '/health' || path.startsWith('/assets/');

/**
 * Answers 503 + Retry-After while this instance is not the writer. Reads are
 * gated too: some (sign-in callbacks, enrollment polls) write as a side effect.
 */
function mountWriteGate(app: Hono, writable: () => boolean): void {
  app.use('*', async (c, next) => {
    if (ALWAYS_SERVED(c.req.path) || writable()) return next();
    c.header('Retry-After', '5');
    return controllerError(
      c,
      503,
      'not_writer',
      'This instance is handing over or no longer owns the database; retry shortly.'
    );
  });
}

/** One structured log entry per request, through the shared observability contract. */
function mountObservability(app: Hono, log: Logger): void {
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
}

const REGISTER_LIMIT: RateLimitSetting = { limit: 20, windowMs: 60_000 };
const LOGIN_LIMIT: RateLimitSetting = { limit: 10, windowMs: 5 * 60_000 };

/** Every authenticated administration route, in one place so the composition stays small. */
function mountAdminApi(app: Hono, deps: AppDeps): void {
  mountAdminNodes(app, deps);
  mountAdminAccess(app, deps);
  mountAdminOperations(app, deps);
  mountAdminAudit(app, deps);
  mountOwnershipStatus(app, deps);
  mountAdminIssues(app, deps);
  mountGithub(app, deps);
  mountAdminEvents(app, deps);
  mountAdminSettings(app, deps);
  mountMetrics(app, deps);
}

/**
 * The fleet controller: node endpoints, admin endpoints, /health and /metrics. The
 * dashboard is mounted on the same app by `mountUi`. A rate limit on
 * `POST /login` is registered here so it runs before the dashboard's handler.
 */
export function createController(
  deps: AppDeps,
  options: ControllerAppOptions = {}
): Hono {
  const log = options.log ?? createLogger({ name: 'fleet-controller' });
  const clock = () => deps.now().getTime();
  const limiter = (setting: RateLimitSetting) =>
    new RateLimiter({ ...setting, now: clock });
  const app = new Hono();
  mountObservability(app, log);
  if (options.writable) mountWriteGate(app, options.writable);
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        controllerError(
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
  mountAdminApi(app, deps);
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
  app.all('/v1/*', (c) =>
    controllerError(c, 404, 'not_found', 'No such endpoint.')
  );

  app.onError((err, c) => {
    log.error('unhandled error', {
      route: c.req.routePath,
      error: errorDetails(err),
    });
    return internalError(c, deps, err, REQUEST_FAILED);
  });
  return app;
}
