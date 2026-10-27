import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDb, type Db } from '../../src/db/client';
import { databaseAvailable, useDatabase } from '../support/database';

// Bun #32004: transactions and ordinary prepared queries can strand idle
// pooled connections on older runtimes. Await the entire workload so a stall
// cannot masquerade as success just because some queries made progress.
describe.skipIf(!databaseAvailable)('Postgres pool contention', () => {
  const database = useDatabase();
  let pool: Db;
  beforeAll(() => {
    pool = createDb({ url: database().url, max: 2, prepare: true });
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
              ? await pool.begin((tx) => tx`select ${id}::int as value`)
              : await pool`select ${id}::int as value`;
          expect(rows[0].value).toBe(id);
        }
      })
    );
  });
});
