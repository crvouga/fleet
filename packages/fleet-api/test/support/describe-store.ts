import { beforeAll, beforeEach, describe } from 'bun:test';

import type { PgStore } from '../../src/db/pg-store';

import { databaseAvailable, useDatabase, type TestDatabase } from './database';

export interface StoreContext {
  readonly store: PgStore;
  readonly db: TestDatabase;
}

/**
 * Runs the same store tests against a real Postgres twice: with named
 * prepared statements (the default) and without (what a transaction-mode
 * pooler needs). Each run starts from empty tables.
 */
export function describeStore(
  title: string,
  body: (ctx: () => StoreContext) => void
): void {
  for (const prepare of [true, false]) {
    describe.skipIf(!databaseAvailable)(
      `${title} (prepare=${String(prepare)})`,
      () => {
        const database = useDatabase();
        let handle: { store: PgStore; close(): Promise<void> } | null = null;
        beforeAll(() => {
          handle = database().newStore({ prepare });
        });
        beforeEach(async () => {
          await database().reset();
        });
        body(() => {
          if (handle === null) throw new Error('store is not ready');
          return { store: handle.store, db: database() };
        });
      }
    );
  }
}
