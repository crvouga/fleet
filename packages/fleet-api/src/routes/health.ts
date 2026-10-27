import { errorDetails, type Logger } from '@pkgs/logger';
import type { Hono } from 'hono';

import type { Store } from '../store';

const HEALTH_TIMEOUT_MS = 3000;

async function databaseAnswers(
  store: Store,
  timeoutMs: number,
  log: Logger
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('database timed out'), {
            code: 'DATABASE_PROBE_TIMEOUT',
          })
        ),
      timeoutMs
    );
  });
  try {
    await Promise.race([store.health(), timeout]);
    return true;
  } catch (error) {
    log.error('health check failed: database unavailable', {
      error: errorDetails(error),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Public. 200 only while the database and required schema answer; Railway and `bun run health` use it. */
export function mountHealth(
  app: Hono,
  store: Store,
  log: Logger,
  timeoutMs: number = HEALTH_TIMEOUT_MS
): void {
  app.get('/health', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (await databaseAnswers(store, timeoutMs, log))
      return c.json({ ok: true });
    return c.json({ ok: false, error: 'database_unavailable' }, 503);
  });
}
