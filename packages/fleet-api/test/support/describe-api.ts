import { beforeAll, beforeEach, describe } from 'bun:test';

import type { PgStore } from '../../src/db/pg-store';

import { createHarness, type Harness, type HarnessOptions } from './api';
import { databaseAvailable, useDatabase, type TestDatabase } from './database';

export interface ApiContext {
  readonly h: Harness;
  readonly store: PgStore;
  readonly db: TestDatabase;
  /** A new harness on the same store, for tests that need other options. */
  harness(options?: HarnessOptions): Harness;
}

/** Runs API tests through `createApi` on a real Postgres store, from empty tables. */
export function describeApi(
  title: string,
  body: (ctx: () => ApiContext) => void,
  options: HarnessOptions = {}
): void {
  describe.skipIf(!databaseAvailable)(title, () => {
    const database = useDatabase();
    let handle: { store: PgStore; close(): Promise<void> } | null = null;
    let current: ApiContext | null = null;
    beforeAll(() => {
      handle = database().newStore();
    });
    beforeEach(async () => {
      await database().reset();
      if (handle === null) throw new Error('store is not ready');
      const { store } = handle;
      const db = database();
      current = {
        h: createHarness(store, options),
        store,
        db,
        harness: (extra = {}) => createHarness(store, { ...options, ...extra }),
      };
    });
    body(() => {
      if (current === null) throw new Error('api is not ready');
      return current;
    });
  });
}
