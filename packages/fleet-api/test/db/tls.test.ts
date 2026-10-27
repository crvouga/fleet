import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createDb } from '../../src/db/client';
import { PgStore } from '../../src/db/pg-store';
import { startCluster, type Cluster } from '../support/cluster';
import { databaseAvailable } from '../support/database';
import { nodeIdOf, registerInput } from '../support/fixtures';
import { findTooling } from '../support/tooling';

describe.skipIf(!databaseAvailable || Bun.which('openssl') === null)(
  'sslmode in DATABASE_URL',
  () => {
    let secure: Cluster;
    let plain: Cluster;
    let secureDb = '';
    let plainDb = '';

    beforeAll(async () => {
      const tooling = findTooling();
      if (tooling === null) throw new Error('postgres tooling is missing');
      secure = await startCluster(tooling, { ssl: true });
      plain = await startCluster(tooling);
      secureDb = await secure.createDatabase();
      plainDb = await plain.createDatabase();
    }, 120_000);

    afterAll(() => {
      secure?.destroy();
      plain?.destroy();
    });

    const url = (cluster: Cluster, database: string, mode: string) =>
      `postgres://postgres@127.0.0.1:${cluster.port}/${database}?sslmode=${mode}`;

    test('sslmode=require encrypts the connection, even to a self-signed server', async () => {
      const db = createDb({ url: url(secure, secureDb, 'require') });
      try {
        const seen =
          await db`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
        expect(seen[0].ssl).toBe(true);
      } finally {
        await db.close();
      }
    });

    test('the whole store works over that encrypted connection', async () => {
      const db = createDb({ url: url(secure, secureDb, 'require') });
      try {
        const store = new PgStore(db);
        await store.health();
        await store.registerNode(registerInput(1));
        expect((await store.findNode(nodeIdOf(1)))?.approval).toBe('pending');
        await store.deleteNode(nodeIdOf(1), 'test');
      } finally {
        await db.close();
      }
    });

    test('sslmode=disable stays plaintext', async () => {
      const db = createDb({ url: url(secure, secureDb, 'disable') });
      try {
        const seen =
          await db`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
        expect(seen[0].ssl).toBe(false);
      } finally {
        await db.close();
      }
    });

    test('sslmode=require never falls back to plaintext when the server has no TLS', async () => {
      const db = createDb({ url: url(plain, plainDb, 'require') });
      try {
        await expect(new PgStore(db).health()).rejects.toThrow(/SSL/i);
      } finally {
        await db.close().catch(() => undefined);
      }
    });
  }
);
