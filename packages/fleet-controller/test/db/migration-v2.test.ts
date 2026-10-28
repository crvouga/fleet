import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteAccessStore } from '../../src/db/access-store';
import { createDb } from '../../src/db/client';
import { SqliteStore } from '../../src/db/sqlite-store';
import { SettingsConflictError } from '../../src/domain/settings-conflict';
import { heartbeatBody, nodeIdOf, registerInput } from '../support/fixtures';
import {
  ADMINS,
  NEW_V3_TABLES,
  SESSION_CONTEXT,
  SESSION_TOKEN_HASH,
  V2_TABLES,
  columnNames,
  dumpRows,
  writeV2,
} from './migration-v2-fixture';
import { sha256 } from '../support/fixtures';

/** A populated version 2 database in its own directory, removed afterwards. */
async function withV2<T>(
  body: (paths: { old: string; fresh: string }) => Promise<T>
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-migrate-v2-'));
  try {
    const old = join(directory, 'old.db');
    writeV2(old);
    return await body({ old, fresh: join(directory, 'fresh.db') });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function read<T>(path: string, run: (sqlite: Database) => T): T {
  const sqlite = new Database(path, { readonly: true });
  try {
    return run(sqlite);
  } finally {
    sqlite.close();
  }
}

const userVersion = (path: string): number =>
  read(
    path,
    (s) =>
      s.query<{ user_version: number }, []>('PRAGMA user_version').get()
        ?.user_version ?? -1
  );

async function upgrade(path: string): Promise<void> {
  await (await createDb({ path })).close();
}

/** Whitespace and comma spacing are not schema: SQLite keeps the text it was given. */
function normalized(sql: string | null): string {
  return (sql ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

interface Shape {
  readonly objects: Record<string, string>;
  readonly columns: Record<string, string[]>;
  readonly foreignKeys: Record<string, string[]>;
  readonly indexes: Record<string, string[]>;
}

/** Tables, columns, defaults, keys, indexes (unique and partial) and their SQL, normalized. */
function shapeOf(path: string): Shape {
  return read(path, (sqlite) => {
    const objects = sqlite
      .query<{ type: string; name: string; sql: string | null }, []>(
        "select type, name, sql from sqlite_master where name not like 'sqlite_%' order by type, name"
      )
      .all();
    const tables = objects.filter((o) => o.type === 'table').map((o) => o.name);
    const columns: Shape['columns'] = {};
    const foreignKeys: Shape['foreignKeys'] = {};
    const indexes: Shape['indexes'] = {};
    for (const table of tables) {
      columns[table] = sqlite
        .query<Record<string, unknown>, []>(`PRAGMA table_xinfo(${table})`)
        .all()
        .map((c) =>
          [
            c['name'],
            c['type'],
            c['notnull'],
            c['dflt_value'],
            c['pk'],
            c['hidden'],
          ].join('|')
        );
      foreignKeys[table] = sqlite
        .query<Record<string, unknown>, []>(`PRAGMA foreign_key_list(${table})`)
        .all()
        .map((f) =>
          [f['from'], f['table'], f['to'], f['on_update'], f['on_delete']].join(
            '|'
          )
        )
        .sort();
      indexes[table] = sqlite
        .query<Record<string, unknown>, []>(`PRAGMA index_list(${table})`)
        .all()
        .map((i) => {
          const parts = sqlite
            .query<Record<string, unknown>, []>(
              `PRAGMA index_xinfo(${String(i['name'])})`
            )
            .all()
            .filter((c) => c['key'] === 1)
            .map(
              (c) => `${String(c['name'])} ${c['desc'] === 1 ? 'desc' : 'asc'}`
            );
          return [i['unique'], i['origin'], i['partial'], parts.join(',')].join(
            '|'
          );
        })
        .sort();
    }
    return {
      objects: Object.fromEntries(
        objects.map((o) => [`${o.type} ${o.name}`, normalized(o.sql)])
      ),
      columns,
      foreignKeys,
      indexes,
    };
  });
}

const V2_COLUMNS_ONLY = (path: string) => columnNames(path, V2_TABLES);

describe('schema migration v2 to v3 on a populated database', () => {
  test('keeps every existing row byte for byte and ends at version 3', async () => {
    await withV2(async ({ old }) => {
      const columns = V2_COLUMNS_ONLY(old);
      const before = dumpRows(old, V2_TABLES, columns);
      expect(before['nodes']).toHaveLength(8);
      expect(before['heartbeats']).toHaveLength(12);
      expect(before['events']).toHaveLength(4);
      expect(before['settings']).toHaveLength(3);
      expect(before['settings_history']).toHaveLength(6);
      expect(userVersion(old)).toBe(2);

      await upgrade(old);

      expect(userVersion(old)).toBe(3);
      expect(dumpRows(old, V2_TABLES, columns)).toEqual(before);
      read(old, (sqlite) => {
        expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(
          sqlite
            .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
            .get()?.integrity_check
        ).toBe('ok');
      });
    });
  });

  test('existing settings start at revision 0 and every allowlisted person stays an admin', async () => {
    await withV2(async ({ old }) => {
      await upgrade(old);
      read(old, (sqlite) => {
        const revisions = sqlite
          .query<{ revision: number }, []>('select revision from settings')
          .all();
        expect(revisions).toHaveLength(3);
        expect(revisions.every((row) => row.revision === 0)).toBe(true);
        const roles = sqlite
          .query<{ email: string; role: string }, []>(
            'select email, role from allowed_emails order by email'
          )
          .all();
        expect(roles).toEqual([
          { email: 'colleague@example.test', role: 'admin' },
          { email: 'ops@example.test', role: 'admin' },
          { email: 'owner@example.test', role: 'admin' },
        ]);
      });

      // Lockout regression: the signed-in owner still has an admin session after the upgrade.
      const db = await createDb({ path: old });
      const access = new SqliteAccessStore(db);
      expect(
        await access.session(SESSION_TOKEN_HASH, SESSION_CONTEXT)
      ).toMatchObject({
        email: 'owner@example.test',
        allowed: true,
        role: 'admin',
      });
      expect(
        await access.session(sha256('session-expired'), SESSION_CONTEXT)
      ).toBeNull();
      expect((await access.entries()).map((e) => e.role)).toEqual([
        'admin',
        'admin',
        'admin',
      ]);
      expect(await access.emails()).toEqual([
        'colleague@example.test',
        'ops@example.test',
        'owner@example.test',
      ]);
      await db.close();
    });
  });

  test('adds every new table, all of them empty', async () => {
    await withV2(async ({ old, fresh }) => {
      await upgrade(old);
      await upgrade(fresh);
      read(old, (sqlite) => {
        const names = sqlite
          .query<{ name: string }, []>(
            "select name from sqlite_master where type = 'table'"
          )
          .all()
          .map((t) => t.name);
        for (const table of NEW_V3_TABLES) {
          expect(names).toContain(table);
          expect(
            sqlite
              .query<{ n: number }, []>(`select count(*) as n from ${table}`)
              .get()?.n
          ).toBe(0);
        }
        expect(names.sort()).toEqual(
          read(fresh, (f) =>
            f
              .query<{ name: string }, []>(
                "select name from sqlite_master where type = 'table'"
              )
              .all()
              .map((t) => t.name)
              .sort()
          )
        );
      });
    });
  });

  test('the migrated schema equals a fresh version 3 schema, indexes and constraints included', async () => {
    await withV2(async ({ old, fresh }) => {
      await upgrade(old);
      await upgrade(fresh);
      const migrated = shapeOf(old);
      const created = shapeOf(fresh);
      // Compare object by object so a failure names the table or index.
      expect(Object.keys(migrated.objects)).toEqual(
        Object.keys(created.objects)
      );
      for (const [name, sql] of Object.entries(created.objects)) {
        expect([name, migrated.objects[name]]).toEqual([name, sql]);
      }
      expect(migrated.columns).toEqual(created.columns);
      expect(migrated.foreignKeys).toEqual(created.foreignKeys);
      expect(migrated.indexes).toEqual(created.indexes);
      // Guard against the comparison going vacuous.
      expect(
        Object.keys(created.objects).filter((k) => k.startsWith('index '))
      ).toContain('index operations_idempotency_idx');
      expect(
        created.objects['index issue_reports_open_fingerprint_idx']
      ).toContain('WHERE');
      expect(
        created.indexes['enrollment_grants']?.some((i) => i.startsWith('1|u|'))
      ).toBe(true);
    });
  });

  test('the controller store reads and writes the migrated database', async () => {
    await withV2(async ({ old }) => {
      const db = await createDb({ path: old });
      const store = new SqliteStore(db);
      await store.health();
      expect(await store.listNodes()).toHaveLength(8);
      expect(await store.findNode(nodeIdOf(1))).toMatchObject({
        role: 'ci',
        approval: 'approved',
        observedClosure: 'ci-gpu',
        labels: ['rack-2', 'gpu'],
        displayName: 'Rack 2 shelf A',
        hardware: { capabilities: ['gpu'] },
      });
      expect(await store.findNode(nodeIdOf(4))).toMatchObject({
        role: null,
        approval: 'pending',
      });

      // Registration and heartbeats work, and the history keeps the old rows.
      const registered = await store.registerNode(registerInput(20));
      expect(registered.created).toBe(true);
      await store.recordHeartbeat(
        nodeIdOf(1),
        heartbeatBody(1),
        null,
        new Date('2026-10-14T12:10:00.000Z')
      );
      expect(await store.listHeartbeats(nodeIdOf(1), new Date(0))).toHaveLength(
        4
      );

      // Settings written before the upgrade are at revision 0 and accept a revisioned write.
      expect((await store.getSettings('fleet'))?.revision).toBe(0);
      const written = await store.putSettings(
        'fleet',
        { sync: { paused: true } },
        'owner',
        0
      );
      expect(written.revision).toBe(1);
      await expect(
        store.putSettings('fleet', { sync: { paused: false } }, 'owner', 0)
      ).rejects.toBeInstanceOf(SettingsConflictError);
      expect((await store.settingsHistory('fleet', 20)).length).toBe(3);
      expect((await store.getSettings('role:ci'))?.value).toEqual({
        runners: { extraLabels: ['lab-a'] },
      });

      // The audit log is new: it starts empty and records from now on.
      expect(await store.listAudit({ limit: 10 })).toEqual([]);
      await store.audit({
        actor: 'owner',
        action: 'node.approve',
        targetKind: 'node',
        targetId: nodeIdOf(4),
      });
      expect(await store.listAudit({ limit: 10 })).toHaveLength(1);

      // The allowlist: roles are enforced for new entries and the last admin is protected.
      const access = new SqliteAccessStore(db);
      await access.allow('viewer@example.test', 'owner@example.test', 'viewer');
      expect(
        (await access.entries()).find((e) => e.email === 'viewer@example.test')
          ?.role
      ).toBe('viewer');
      expect(
        await access.revoke('colleague@example.test', 'owner@example.test')
      ).toBe(true);
      expect(await access.revoke(ADMINS[0], 'ops@example.test')).toBe(true);
      expect(await access.revoke(ADMINS[1], 'ops@example.test')).toBe(false);
      await db.close();
    });
  });

  test('upgrading again is a no-op', async () => {
    await withV2(async ({ old }) => {
      await upgrade(old);
      const tables = [...V2_TABLES, ...NEW_V3_TABLES];
      const columns = columnNames(old, tables);
      const first = dumpRows(old, tables, columns);
      const shape = shapeOf(old);
      await upgrade(old);
      await upgrade(old);
      expect(userVersion(old)).toBe(3);
      expect(dumpRows(old, tables, columns)).toEqual(first);
      expect(shapeOf(old)).toEqual(shape);
    });
  });

  test('a database from a newer release is refused and left untouched', async () => {
    await withV2(async ({ old }) => {
      const sqlite = new Database(old);
      sqlite.exec('PRAGMA user_version = 4');
      sqlite.close();
      const columns = V2_COLUMNS_ONLY(old);
      const before = dumpRows(old, V2_TABLES, columns);
      const shape = shapeOf(old);
      await expect(createDb({ path: old })).rejects.toThrow(
        /newer than this controller/
      );
      expect(userVersion(old)).toBe(4);
      expect(dumpRows(old, V2_TABLES, columns)).toEqual(before);
      expect(shapeOf(old)).toEqual(shape);
    });
  });

  test('a failure half way through the upgrade rolls everything back, and a retry succeeds', async () => {
    await withV2(async ({ old }) => {
      // `operations` already exists: the upgrade has altered settings and allowed_emails and
      // created audit_log by the time it hits this, so only a transaction can undo that.
      const sabotage = new Database(old);
      sabotage.exec('create table operations (x integer)');
      sabotage.close();
      const columns = V2_COLUMNS_ONLY(old);
      const before = dumpRows(old, V2_TABLES, columns);
      const shape = shapeOf(old);

      await expect(createDb({ path: old })).rejects.toThrow();

      expect(userVersion(old)).toBe(2);
      expect(dumpRows(old, V2_TABLES, columns)).toEqual(before);
      expect(shapeOf(old)).toEqual(shape);
      expect(
        shape.columns['settings']?.some((c) => c.startsWith('revision|'))
      ).toBe(false);
      expect(shape.objects['table audit_log']).toBeUndefined();

      // The operator removes the obstacle and starts again: the upgrade completes.
      const repair = new Database(old);
      repair.exec('drop table operations');
      repair.close();
      await upgrade(old);
      expect(userVersion(old)).toBe(3);
      expect(dumpRows(old, V2_TABLES, columns)).toEqual(before);
    });
  });

  test('a database with a broken reference is rolled back, not upgraded', async () => {
    await withV2(async ({ old }) => {
      // A heartbeat for a node that does not exist: foreign keys were off when it was written.
      const sqlite = new Database(old);
      sqlite.exec('PRAGMA foreign_keys = OFF');
      sqlite.exec(
        `insert into heartbeats (node_id, at) values ('${'ab'.repeat(32)}', '2026-10-14T12:30:00.000Z')`
      );
      sqlite.close();
      const columns = V2_COLUMNS_ONLY(old);
      const before = dumpRows(old, V2_TABLES, columns);
      await expect(createDb({ path: old })).rejects.toThrow(
        /broken references/
      );
      expect(userVersion(old)).toBe(2);
      expect(dumpRows(old, V2_TABLES, columns)).toEqual(before);
    });
  });
});
