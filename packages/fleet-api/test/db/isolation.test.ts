import { describe, expect, test } from 'bun:test';

import { PgStore } from '../../src/db/pg-store';
import { createDb } from '../../src/db/client';
import { runOfflineSweep } from '../../src/jobs/offline-notifier';
import { runPrune } from '../../src/jobs/prune';
import {
  CI_ROLE_TOKEN,
  createHarness,
  silent,
  type Harness,
} from '../support/api';
import {
  databaseAvailable,
  useDatabase,
  type TestDatabase,
} from '../support/database';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

const DECOY_TABLES = [
  'nodes',
  'events',
  'settings',
  'settings_history',
  'heartbeats',
  'nodes_archive',
  'fleet_nodes',
];

async function dropDecoys(db: TestDatabase): Promise<void> {
  await db.sql.unsafe(
    `alter role postgres in database ${db.name} reset search_path`
  );
  await db.sql.unsafe('drop schema if exists decoy cascade');
  for (const table of DECOY_TABLES)
    await db.sql.unsafe(`drop table if exists public.${table}`);
  await db.sql.unsafe('drop function if exists public.fleet_decoy_guard()');
}

async function createDecoys(db: TestDatabase): Promise<void> {
  const { sql } = db;
  await dropDecoys(db);
  await sql.unsafe('create schema decoy');
  await sql.unsafe(`
    create function public.fleet_decoy_guard() returns trigger language plpgsql as
    $$ begin raise exception 'a decoy table was written: %', tg_table_schema || '.' || tg_table_name; end $$`);
  for (const schema of ['public', 'decoy']) {
    for (const table of DECOY_TABLES) {
      const template = ['nodes_archive', 'fleet_nodes'].includes(table)
        ? 'nodes'
        : table;
      await sql.unsafe(
        `create table ${schema}.${table} (like fleet.${template} including defaults including identity)`
      );
    }
  }
  await sql.unsafe(`
    insert into public.nodes (id, role, hostname, secret_hash) values (repeat('d', 64), 'ci', 'decoy-public', 'x');
    insert into decoy.nodes (id, role, hostname, secret_hash) values (repeat('e', 64), 'web', 'decoy-schema', 'x');
    insert into public.settings (scope, value) values ('fleet', '{"sync":{"paused":true}}');
    insert into decoy.settings (scope, value) values ('fleet', '{"sync":{"paused":true}}');
    insert into public.events (kind, message) values ('sentinel', 'public sentinel');
    insert into decoy.events (kind, message) values ('sentinel', 'decoy sentinel');
    insert into public.settings_history (scope, value) values ('fleet', '{}');
    insert into public.nodes_archive (id, role, hostname, secret_hash) values (repeat('f', 64), 'ci', 'archive', 'x');`);
  for (const schema of ['public', 'decoy']) {
    for (const table of DECOY_TABLES) {
      await sql.unsafe(
        `create trigger decoy_guard before insert or update or delete on ${schema}.${table}
         for each statement execute function public.fleet_decoy_guard()`
      );
      await sql.unsafe(
        `create trigger decoy_guard_truncate before truncate on ${schema}.${table}
         for each statement execute function public.fleet_decoy_guard()`
      );
    }
  }
}

/** Every row of every decoy, with its physical address and transaction id. */
async function decoyContents(db: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const schema of ['public', 'decoy']) {
    for (const table of DECOY_TABLES) {
      const rows = await db.sql.unsafe(
        `select ctid::text as ctid, xmin::text as xmin, t::text as row from ${schema}.${table} t order by 3`
      );
      parts.push(`${schema}.${table}: ${JSON.stringify(rows)}`);
    }
  }
  return parts.join('\n');
}

/** Every relation, function, schema and extension outside the system catalogs. */
async function catalog(db: TestDatabase): Promise<string> {
  const relations = await db.sql`
    select n.nspname || '.' || c.relname || ':' || c.relkind::text as item
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
    order by 1`;
  const functions = await db.sql`
    select n.nspname || '.' || p.proname as item from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') order by 1`;
  const schemas =
    await db.sql`select nspname as item from pg_namespace where nspname not like 'pg_%' order by 1`;
  const extensions =
    await db.sql`select extname as item from pg_extension order by 1`;
  const types = await db.sql`
    select n.nspname || '.' || t.typname as item from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' order by 1`;
  return JSON.stringify([relations, functions, schemas, extensions, types]);
}

async function realisticFlow(h: Harness, store: PgStore): Promise<void> {
  const { clock } = h;
  expect((await h.register(1, { roleToken: CI_ROLE_TOKEN })).status).toBe(201);
  expect((await h.register(2)).status).toBe(201);
  expect((await h.register(3)).status).toBe(201);
  expect((await h.register(2)).status).toBe(200);
  for (const n of [1, 2, 3]) {
    expect(
      (await h.asNode(n, 'POST', '/v1/heartbeat', heartbeatBody(n))).status
    ).toBe(200);
  }
  expect(
    (
      await h.admin('PUT', '/v1/settings/fleet', {
        heartbeat: { intervalSeconds: 30 },
        alerts: { offlineAfterSeconds: 120 },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await h.admin('PUT', '/v1/settings/role:ci', {
        disk: { alertPercent: 80 },
      })
    ).status
  ).toBe(200);
  expect(
    (
      await h.admin('PUT', `/v1/settings/node:${nodeIdOf(1)}`, {
        sync: { paused: true },
      })
    ).status
  ).toBe(200);
  const settings = await h.admin('GET', '/v1/settings');
  expect(
    settings.body.settings.map((row: { scope: string }) => row.scope)
  ).toEqual(['fleet', `node:${nodeIdOf(1)}`, 'role:ci']);
  expect(settings.body.settings[0].value).toEqual({
    heartbeat: { intervalSeconds: 30 },
    alerts: { offlineAfterSeconds: 120 },
  });
  const listed = await h.admin('GET', '/v1/nodes');
  expect(
    listed.body.nodes.map((n: { hostname: string }) => n.hostname).sort()
  ).toEqual([1, 2, 3].map((n) => `ci-${nodeIdOf(n).slice(0, 4)}`).sort());
  const events = await h.admin('GET', '/v1/events?limit=200');
  expect(
    events.body.events.some((e: { kind: string }) => e.kind === 'sentinel')
  ).toBe(false);
  expect(
    (await h.admin('POST', `/v1/nodes/${nodeIdOf(2)}/approve`)).status
  ).toBe(200);
  expect(
    (
      await h.admin('PATCH', `/v1/nodes/${nodeIdOf(1)}`, {
        displayName: 'Rack 1',
        labels: ['a'],
      })
    ).status
  ).toBe(200);
  expect(
    (await h.admin('POST', `/v1/nodes/${nodeIdOf(3)}/reject`)).status
  ).toBe(200);
  clock.advance(60);
  for (const n of [1, 2]) {
    await h.asNode(
      n,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(n, { bootId: 'boot-2', failedUnits: ['x.service'] })
    );
  }
  expect((await h.asNode(2, 'POST', '/v1/retire')).status).toBe(200);
  clock.advance(10_000);
  const jobs = {
    store,
    now: clock.now,
    fetch: (async () => new Response('ok')) as unknown as typeof fetch,
    log: silent,
  };
  expect(await runOfflineSweep(jobs)).toBe(1);
  expect(await runPrune(jobs)).toBe(0);
  clock.advance(8 * 24 * 3600);
  expect(await runPrune(jobs)).toBeGreaterThan(0);
  for (const path of [
    '/v1/nodes',
    '/v1/summary',
    '/v1/events',
    '/v1/settings',
    '/metrics',
    `/v1/nodes/${nodeIdOf(1)}`,
    '/v1/settings/fleet/history',
  ]) {
    expect((await h.admin('GET', path)).status).toBe(200);
  }
  expect((await h.admin('DELETE', `/v1/nodes/${nodeIdOf(3)}`)).status).toBe(
    200
  );
  expect((await h.admin('DELETE', `/v1/nodes/${nodeIdOf(1)}`)).status).toBe(
    200
  );
}

describe.skipIf(!databaseAvailable)(
  'the fleet schema is the only thing the service touches',
  () => {
    const database = useDatabase();

    for (const searchPath of [
      'the default search_path',
      'a search_path that puts decoys first',
    ]) {
      test(`a full realistic flow leaves every decoy and the catalog untouched, with ${searchPath}`, async () => {
        const db = database();
        await db.reset();
        await createDecoys(db);
        if (searchPath !== 'the default search_path') {
          await db.sql.unsafe(
            `alter role postgres in database ${db.name} set search_path = decoy, public`
          );
        }
        const decoysBefore = await decoyContents(db);
        const catalogBefore = await catalog(db);

        const { store, close } = db.newStore();
        try {
          const probe = createDb({ url: db.url, max: 1 });
          const seen = await probe`show search_path`;
          await probe.close();
          expect(String(seen[0].search_path)).toContain(
            searchPath === 'the default search_path' ? 'public' : 'decoy'
          );
          await realisticFlow(createHarness(store), store);
        } finally {
          const closing = close();
          expect(close()).toBe(closing);
          await closing;
        }

        try {
          expect(await decoyContents(db)).toBe(decoysBefore);
          expect(await catalog(db)).toBe(catalogBefore);
          const leftover =
            await db.sql`select count(*)::int as n from fleet.nodes`;
          expect(leftover[0].n).toBe(1);
        } finally {
          await dropDecoys(db);
        }
      });
    }

    test('every statement runs with an empty search_path', async () => {
      const db = database();
      await db.reset();
      await db.sql.unsafe(
        `alter role postgres in database ${db.name} set search_path = ''`
      );
      const handle = createDb({ url: db.url });
      try {
        const seen = await handle`show search_path`;
        expect(seen[0].search_path).toBe('""');
        await realisticFlow(
          createHarness(new PgStore(handle)),
          new PgStore(handle)
        );
      } finally {
        await handle.close();
        await db.sql.unsafe(
          `alter role postgres in database ${db.name} reset search_path`
        );
      }
    });
  }
);
