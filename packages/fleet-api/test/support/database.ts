import { afterAll, beforeAll } from 'bun:test';

import { SQL } from 'bun';

import { createDb } from '../../src/db/client';
import { PgStore } from '../../src/db/pg-store';

import { startCluster, type Cluster } from './cluster';
import { findTooling } from './tooling';

/** False when Postgres or Atlas is missing locally (CI throws instead). */
export const databaseAvailable = findTooling() !== null;

const STARTUP_TIMEOUT_MS = 120_000;

let cluster: Promise<Cluster> | null = null;
let running: Cluster | null = null;
let holders = 0;
let lingering: ReturnType<typeof setTimeout> | null = null;

/** Kept briefly after the last user so the next describe or file reuses it. */
const LINGER_MS = 2000;

function destroyNow(): void {
  const doomed = running;
  cluster = null;
  running = null;
  doomed?.destroy();
}

/**
 * One cluster shared by the describes (and files) that follow each other,
 * stopped shortly after the last one finishes. Every call gets its own database.
 */
async function acquire(): Promise<Cluster> {
  holders += 1;
  if (lingering !== null) clearTimeout(lingering);
  lingering = null;
  const tooling = findTooling();
  if (tooling === null) throw new Error('postgres tooling is missing');
  cluster ??= startCluster(tooling).then((started) => {
    running = started;
    return started;
  });
  return cluster;
}

function release(): void {
  holders -= 1;
  if (holders === 0) lingering = setTimeout(destroyNow, LINGER_MS);
}

export interface TestDatabase {
  readonly cluster: Cluster;
  readonly name: string;
  /** postgres:// URL as the superuser, without a search_path. */
  readonly url: string;
  /** A direct connection for assertions that bypass the store. */
  readonly sql: SQL;
  newStore(options?: { prepare?: boolean }): {
    store: PgStore;
    close(): Promise<void>;
  };
  /** Empties every fleet table. */
  reset(): Promise<void>;
}

/** Call at the top of a describe block. Fields are valid from the first test on. */
export function useDatabase(): () => TestDatabase {
  let current: TestDatabase | null = null;
  const closers: (() => Promise<void>)[] = [];
  beforeAll(async () => {
    const shared = await acquire();
    const name = await shared.createDatabase();
    const url = shared.url(name);
    const sql = new SQL({ url, max: 2 });
    closers.push(() => sql.close());
    current = {
      cluster: shared,
      name,
      url,
      sql,
      newStore(options = {}) {
        const db = createDb({ url, prepare: options.prepare ?? true });
        // Some tests release their store early; fixture cleanup must await
        // that same close, never ask the driver to close the pool twice.
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= db.close());
        closers.push(close);
        return { store: new PgStore(db), close };
      },
      async reset() {
        // One atomic statement: never leave a partial reset or depend on
        // multi-result protocol draining before the next test acquires a pool.
        await sql.unsafe(
          'truncate fleet.login_transactions, fleet.browser_sessions, fleet.access_audit, fleet.allowed_emails, fleet.events, fleet.heartbeats, fleet.settings_history, fleet.settings, fleet.nodes'
        );
      },
    };
  }, STARTUP_TIMEOUT_MS);
  afterAll(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    if (current !== null) release();
    current = null;
  });
  return () => {
    if (current === null) throw new Error('database is not ready');
    return current;
  };
}
