import { afterAll, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb, type Db } from '../../src/db/client';
import { SqliteStore } from '../../src/db/sqlite-store';

export const databaseAvailable = true;
export interface TestDatabase {
  readonly path: string;
  readonly sql: Db;
  newStore(): Promise<{ store: SqliteStore; close(): Promise<void> }>;
  reset(): Promise<void>;
}

/** Every test suite uses a real, temporary on-disk database, with no external tooling. */
export function useDatabase(): () => TestDatabase {
  let current: TestDatabase | null = null;
  const closers: (() => Promise<void>)[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'fleet-test-'));
  beforeAll(async () => {
    const path = join(directory, 'fleet.db');
    const sql = await createDb({ path });
    closers.push(() => sql.close());
    current = {
      path,
      sql,
      async newStore() {
        const db = await createDb({ path });
        let closing: Promise<void> | undefined;
        const close = () => (closing ??= db.close());
        closers.push(close);
        return { store: new SqliteStore(db), close };
      },
      async reset() {
        await sql.begin(async (tx) => {
          for (const table of [
            'login_transactions',
            'browser_sessions',
            'access_audit',
            'allowed_emails',
            'events',
            'heartbeats',
            'settings_history',
            'settings',
            'nodes',
          ]) {
            await tx.unsafe(`delete from ${table}`);
          }
        });
      },
    };
  });
  afterAll(async () => {
    for (const close of closers.splice(0)) await close();
    rmSync(directory, { recursive: true, force: true });
    current = null;
  });
  return () => {
    if (!current) throw new Error('database is not ready');
    return current;
  };
}
