import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../src/db/client';
import { SqliteStore } from '../../src/db/sqlite-store';
import { heartbeatBody, nodeIdOf, sha256 } from '../support/fixtures';

const V1_SCHEMA = readFileSync(
  new URL('./fixtures/schema-v1.sql', import.meta.url),
  'utf8'
);

/** A version 1 database with nodes, history, events and settings, as v1 wrote them. */
function writeV1(path: string): void {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(V1_SCHEMA);
  sqlite.exec('PRAGMA user_version = 1');
  const insert = sqlite.prepare(
    `insert into nodes (id, role, hostname, approval, secret_hash, labels, facts,
       revision, agent_version, config_revision, enrolled_via, last_seen_at, approved_by)
     values ($id, $role, $hostname, $approval, $secret, '["rack-2"]', '{"bootId":"b1"}',
       'abc123', '1', '0123456789abcdef', $via, '2026-10-14T12:00:00.000Z', $by)`
  );
  insert.run({
    id: nodeIdOf(1),
    role: 'ci',
    hostname: 'ci-0001',
    approval: 'approved',
    secret: sha256('s1'),
    via: 'role-token',
    by: 'role-token',
  });
  insert.run({
    id: nodeIdOf(2),
    role: 'devbox',
    hostname: 'devbox-0002',
    approval: 'pending',
    secret: sha256('s2'),
    via: 'hello',
    by: null,
  });
  sqlite.exec(`
    insert into heartbeats (node_id, at, load1) values ('${nodeIdOf(1)}', '2026-10-14T12:00:00.000Z', 0.5);
    insert into events (node_id, node_label, kind, message) values ('${nodeIdOf(1)}', 'ci-0001', 'boot', 'node started');
    insert into settings (scope, value) values ('role:ci', '{"sync":{"paused":true}}');
  `);
  sqlite.close();
}

function columns(path: string): string[] {
  const sqlite = new Database(path, { readonly: true });
  try {
    return sqlite
      .query<{ name: string; type: string; notnull: number }, []>(
        'PRAGMA table_info(nodes)'
      )
      .all()
      .map((c) => `${c.name} ${c.type} ${c.notnull}`);
  } finally {
    sqlite.close();
  }
}

function userVersion(path: string): number {
  const sqlite = new Database(path, { readonly: true });
  try {
    return (
      sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()
        ?.user_version ?? 0
    );
  } finally {
    sqlite.close();
  }
}

describe('schema migration v1 to v2', () => {
  test('keeps every row, copies the role into assigned and observed, and matches a fresh v2 schema', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-migrate-'));
    const old = join(directory, 'old.db');
    const fresh = join(directory, 'fresh.db');
    try {
      writeV1(old);
      const db = await createDb({ path: old });
      const store = new SqliteStore(db);
      expect(await store.findNode(nodeIdOf(1))).toMatchObject({
        role: 'ci',
        observedRole: 'ci',
        observedClosure: null,
        appliedRevision: '0123456789abcdef',
        enrolledVia: 'enrollment-token',
        approvedBy: 'role-token',
        approval: 'approved',
        labels: ['rack-2'],
        facts: { bootId: 'b1' },
        revision: 'abc123',
        hardware: null,
        reconcile: null,
        ageRecipient: null,
      });
      expect(await store.findNode(nodeIdOf(2))).toMatchObject({
        role: 'devbox',
        observedRole: 'devbox',
        approval: 'pending',
        enrolledVia: 'hello',
      });
      expect(await store.listHeartbeats(nodeIdOf(1), new Date(0))).toHaveLength(
        1
      );
      expect((await store.listEvents({ limit: 5 }))[0]).toMatchObject({
        kind: 'boot',
        nodeId: nodeIdOf(1),
      });
      expect((await store.getSettings('role:ci'))?.value).toEqual({
        sync: { paused: true },
      });
      await store.health();

      // A heartbeat on the migrated node stores observed state and keeps the role.
      await store.recordHeartbeat(
        nodeIdOf(1),
        { ...heartbeatBody(1), role: 'base', closure: 'base' },
        null,
        new Date('2026-10-14T12:01:00.000Z')
      );
      expect(await store.findNode(nodeIdOf(1))).toMatchObject({
        role: 'ci',
        observedRole: 'base',
      });
      // Foreign keys still cascade after the table rebuild.
      await store.deleteNode(nodeIdOf(1), 'owner');
      expect(await store.listHeartbeats(nodeIdOf(1), new Date(0))).toEqual([]);
      expect(
        (await store.listEvents({ limit: 10 })).every((e) => e.nodeId === null)
      ).toBe(true);
      await db.close();

      expect(userVersion(old)).toBe(2);
      await (await createDb({ path: fresh })).close();
      expect(columns(old)).toEqual(columns(fresh));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('roles are validated in code: the database accepts no role and any registry name', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-migrate-'));
    try {
      writeV1(join(directory, 'fleet.db'));
      const db = await createDb({ path: join(directory, 'fleet.db') });
      await db`update nodes set role = null where id = ${nodeIdOf(2)}`;
      const store = new SqliteStore(db);
      expect((await store.findNode(nodeIdOf(2)))?.role).toBeNull();
      const sql = await db`select sql from sqlite_master where name = 'nodes'`;
      expect(String(sql[0]?.['sql'])).not.toContain('nodes_role_known');
      await db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a failed migration leaves the version 1 database untouched', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-migrate-'));
    const path = join(directory, 'fleet.db');
    try {
      writeV1(path);
      // An existing nodes_v2 makes the first statement of the migration fail.
      const sqlite = new Database(path);
      sqlite.exec('create table nodes_v2 (x integer)');
      sqlite.close();
      await expect(createDb({ path })).rejects.toThrow();
      expect(userVersion(path)).toBe(1);
      expect(columns(path)).toContain('config_revision TEXT 0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
