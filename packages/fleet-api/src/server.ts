import { createLogger, errorDetails, type Logger } from '@pkgs/logger';

import { createApi } from './app';
import { FleetAdminAuth } from './auth/admin-auth';
import { createDb } from './db/client';
import { PgStore } from './db/pg-store';
import { PgAccessStore } from './db/access-store';
import { FleetBrowserAuth } from './auth/browser-auth';
import type { AppDeps } from './deps';
import { ConfigurationError, readServerEnv, type ServerEnv } from './env';
import { startJobs } from './jobs/scheduler';
import { GithubRevisionSource } from './revisions/github';
import { mountUi } from './routes/ui';
import { localResponse } from './local-response';

const SHUTDOWN_GRACE_MS = 10_000;

export interface ServerOptions {
  /** Local development uses the live store without duplicating deployed jobs. */
  readonly local?: boolean;
}

export interface RunningServer {
  readonly port: number;
  stop(): Promise<void>;
}

/** Wires the real database, relay authentication, GitHub lookup and clock into AppDeps. */
export function buildDeps(
  env: ServerEnv,
  store: PgStore,
  log: Logger,
  browserAuth?: FleetBrowserAuth
): AppDeps {
  const now = () => new Date();
  return {
    store,
    ...(browserAuth ? { browserAuth } : {}),
    auth: new FleetAdminAuth({
      env,
      now,
      fetch,
      log,
      ...(browserAuth && env.relay
        ? { browser: browserAuth, publicOrigin: env.relay.origin }
        : {}),
    }),
    revisions: new GithubRevisionSource({
      repo: env.githubRepo,
      fetch,
      now,
      log,
    }),
    env,
    now,
  };
}

/** Boots the HTTP server and the background jobs. Names no secret in any log. */
export async function startServer(
  env: ServerEnv,
  log: Logger,
  options: ServerOptions = {}
): Promise<RunningServer> {
  const db = createDb({ url: env.databaseUrl, prepare: env.databasePrepare });
  const store = new PgStore(db);
  const browser = env.relay
    ? new FleetBrowserAuth(new PgAccessStore(db), env.relay)
    : undefined;
  const deps = buildDeps(env, store, log, browser);
  const app = createApi(deps, { log });
  mountUi(app, deps);
  try {
    await store.health();
  } catch {
    log.error(
      'database is not reachable yet; /health will answer 503 until it is'
    );
  }
  const jobs = options.local
    ? undefined
    : startJobs({ store, now: deps.now, fetch, log });
  const server = Bun.serve({
    hostname: options.local ? '127.0.0.1' : '0.0.0.0',
    port: env.port,
    fetch: async (request, bunServer) => {
      const response = await app.fetch(request, { server: bunServer });
      return options.local ? localResponse(response, request) : response;
    },
  });
  log.info('fleet api listening', { port: server.port });
  return {
    port: server.port ?? env.port,
    stop: async () => {
      jobs?.stop();
      await server.stop();
      await db.close();
    },
  };
}

function shutdownOn(running: RunningServer, log: Logger): void {
  let stopping = false;
  const handler = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    running
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error('shutdown failed', { error: errorDetails(err) });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}

export async function main(options: ServerOptions = {}): Promise<void> {
  const log = createLogger({ name: 'fleet-api', level: 'info' });
  try {
    const running = await startServer(readServerEnv(), log, options);
    shutdownOn(running, log);
  } catch (err: unknown) {
    // Only configuration errors are known to be free of secrets.
    const message =
      err instanceof ConfigurationError ? err.message : 'startup failed';
    log.error('fleet api failed to start', {
      error: message,
      kind: err instanceof Error ? err.name : 'unknown',
    });
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
