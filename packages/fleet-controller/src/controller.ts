import { StartupError, databaseFailure } from './startup-error';
import { createLogger, errorDetails, type Logger } from '@pkgs/logger';

import { createController } from './app';
import { createDb } from './db/client';
import { SqliteStore } from './db/sqlite-store';
import { SqliteAccessStore } from './db/access-store';
import { createDefaultAuth, resolveAuth } from './auth/composition';
import type { AuthFactory, AuthServices, AuthContext } from './auth/contracts';
import type { Store } from './store';
import type { AppDeps } from './deps';
import type { AccessStore } from './auth/browser-contract';
import {
  ConfigurationError,
  readControllerEnv,
  type ControllerEnv,
} from './env';
import { startJobs } from './jobs/scheduler';
import { mountUi } from './routes/ui';
import { localResponse } from './local-response';
import { WRITE_GATE_ENV, fileWriteGate } from './ownership/write-gate';

const SHUTDOWN_GRACE_MS = 10_000;

export interface ControllerOptions {
  /** Bind loopback; true disables live jobs, 'emulated' runs jobs on isolated data. */
  readonly local?: boolean | 'emulated';
  /** Trusted server-side adapter; never selected by request or tenant data. */
  readonly authFactory?: AuthFactory;
  readonly fetch?: AuthContext['fetch'];
  /** Write gate; by default the supervisor's gate file when one is supplied. */
  readonly writable?: () => boolean;
}

/** The explicit gate, else the supervisor's gate file when one is supplied. */
function writeGate(options: ControllerOptions): { writable?: () => boolean } {
  if (options.writable) return { writable: options.writable };
  const path = process.env[WRITE_GATE_ENV];
  return path ? { writable: fileWriteGate(path) } : {};
}

export interface RunningController {
  readonly port: number;
  stop(): Promise<void>;
}

/** Business dependencies receive auth interfaces, not concrete provider classes. */
export function buildDeps(
  env: ControllerEnv,
  store: Store,
  auth: AuthServices & { readonly access?: AccessStore },
  now: () => Date
): AppDeps {
  return {
    store,
    ...auth,
    revisions: { latest: async () => env.targetRevision ?? null },
    env,
    now,
  };
}

/** Boots the controller HTTP listener and the background jobs. Names no secret in any log. */
export async function startController(
  env: ControllerEnv,
  log: Logger,
  options: ControllerOptions = {}
): Promise<RunningController> {
  const db = await createDb(env.storage);
  try {
    const store = new SqliteStore(db);
    const now = () => new Date();
    const access = new SqliteAccessStore(db);
    const auth = resolveAuth(options.authFactory ?? createDefaultAuth, {
      adminToken: env.adminToken,
      access,
      ...(env.oidc ? { oidc: env.oidc } : {}),
      fetch: options.fetch ?? fetch,
      now,
    });
    const deps = buildDeps(env, store, { ...auth, access }, now);
    const app = createController(deps, { log, ...writeGate(options) });
    mountUi(app, deps);
    await store.health();
    const listener = Bun.serve({
      hostname: options.local ? '127.0.0.1' : '0.0.0.0',
      port: env.port,
      fetch: async (request, bunServer) => {
        const response = await app.fetch(request, { server: bunServer });
        return options.local
          ? localResponse(
              response,
              request,
              options.local === 'emulated' ? 'emulated' : 'managed'
            )
          : response;
      },
    });
    const jobs =
      options.local === true
        ? undefined
        : startJobs({
            store,
            now: deps.now,
            fetch: options.fetch ?? fetch,
            log,
          });
    log.info('fleet controller listening', { port: listener.port });
    return {
      port: listener.port ?? env.port,
      stop: async () => {
        jobs?.stop();
        await listener.stop();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw databaseFailure(error);
  }
}

function shutdownOn(running: RunningController, log: Logger): void {
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

export async function main(options: ControllerOptions = {}): Promise<void> {
  const log = createLogger({ name: 'fleet-controller', level: 'info' });
  try {
    const env = readControllerEnv();
    if (process.env['FLEET_REPLICATION_MANAGED'] !== '1') {
      throw new ConfigurationError([
        'use bun run start so Litestream restores and replicates the database',
      ]);
    }
    const running = await startController(env, log, options);
    shutdownOn(running, log);
  } catch (err: unknown) {
    // Log only authored operator messages; database errors can contain SQL details.
    const message =
      err instanceof ConfigurationError || err instanceof StartupError
        ? err.message
        : databaseFailure(err).message;
    log.error('fleet controller failed to start', {
      error: message,
      stage:
        err instanceof StartupError ? err.stage : databaseFailure(err).stage,
    });
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
