import { afterEach, beforeEach, describe } from 'bun:test';

import type { SqliteStore } from '../../../src/db/sqlite-store';
import {
  Clock,
  createHarness,
  type Harness,
  type HarnessOptions,
} from '../../support/controller';
import { useDatabase, type TestDatabase } from '../../support/database';
import { T0 } from '../../support/fixtures';

/** One controller process: its own database connection, app and in-memory state. */
export interface ControllerProcess {
  readonly store: SqliteStore;
  readonly h: Harness;
  /** Closes the database connection without any graceful step, as a crash would. */
  crash(): Promise<void>;
}

export interface Rig {
  readonly clock: Clock;
  readonly db: TestDatabase;
  /** Starts a controller process on the shared database file and clock. */
  boot(options?: HarnessOptions): Promise<ControllerProcess>;
}

/**
 * Resilience tests restart the controller mid-scenario, so every boot opens a
 * fresh connection to the same SQLite file (WAL) and builds a new app, while the
 * test's clock keeps running. Each test starts from empty tables.
 */
export function describeRig(
  title: string,
  body: (rig: () => Rig) => void
): void {
  describe(title, () => {
    const database = useDatabase();
    let current: Rig | null = null;
    let open: ControllerProcess[] = [];
    beforeEach(async () => {
      await database().reset();
      const clock = new Clock(T0);
      open = [];
      current = {
        clock,
        db: database(),
        async boot(options = {}) {
          const { store, close } = await database().newStore();
          const process: ControllerProcess = {
            store,
            h: createHarness(store, { ...options, clock }),
            crash: close,
          };
          open.push(process);
          return process;
        },
      };
    });
    afterEach(async () => {
      for (const process of open) await process.crash();
    });
    body(() => {
      if (current === null) throw new Error('rig is not ready');
      return current;
    });
  });
}
