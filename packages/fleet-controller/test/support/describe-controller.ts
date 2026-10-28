import { beforeAll, beforeEach, describe } from 'bun:test';

import type { SqliteStore } from '../../src/db/sqlite-store';

import { createHarness, type Harness, type HarnessOptions } from './controller';
import { databaseAvailable, useDatabase, type TestDatabase } from './database';

export interface ControllerContext {
  readonly h: Harness;
  readonly store: SqliteStore;
  readonly db: TestDatabase;
  /** A new harness on the same store, for tests that need other options. */
  harness(options?: HarnessOptions): Harness;
}

/** Runs controller tests through `createController` on a real SQLite store, from empty tables. */
export function describeController(
  title: string,
  body: (ctx: () => ControllerContext) => void,
  options: HarnessOptions = {}
): void {
  describe.skipIf(!databaseAvailable)(title, () => {
    const database = useDatabase();
    let handle: { store: SqliteStore; close(): Promise<void> } | null = null;
    let current: ControllerContext | null = null;
    beforeAll(async () => {
      handle = await database().newStore();
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
      if (current === null) throw new Error('controller is not ready');
      return current;
    });
  });
}
