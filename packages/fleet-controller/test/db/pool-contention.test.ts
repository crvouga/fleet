import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '../../src/db/client';
import { databaseAvailable, useDatabase } from '../support/database';

// Await the entire mixed workload so stalled writes cannot masquerade as success.
describe.skipIf(!databaseAvailable)('SQLite query contention', () => {
  const database = useDatabase();
  let pool: Db;
  beforeAll(async () => {
    pool = await createDb({ path: database().path });
  });
  afterAll(async () => {
    await pool.close();
  });

  test('mixed transactions and ordinary queries all drain', async () => {
    await Promise.all(
      Array.from({ length: 24 }, async (_, worker) => {
        for (let iteration = 0; iteration < 12; iteration += 1) {
          const id = worker * 12 + iteration;
          const rows =
            id % 2 === 0
              ? await pool.begin((tx) => tx`select ${id} as value`)
              : await pool`select ${id} as value`;
          expect(rows[0]?.['value']).toBe(id);
        }
      })
    );
  });
});
