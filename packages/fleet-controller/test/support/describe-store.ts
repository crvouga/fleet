import { beforeAll, beforeEach, describe } from 'bun:test';
import type { SqliteStore } from '../../src/db/sqlite-store';
import { useDatabase, type TestDatabase } from './database';

export interface StoreContext {
  readonly store: SqliteStore;
  readonly db: TestDatabase;
}

export function describeStore(
  title: string,
  body: (ctx: () => StoreContext) => void
): void {
  describe(title, () => {
    const database = useDatabase();
    let store: SqliteStore;
    beforeAll(async () => {
      store = (await database().newStore()).store;
    });
    beforeEach(async () => {
      await database().reset();
    });
    body(() => ({ store, db: database() }));
  });
}
