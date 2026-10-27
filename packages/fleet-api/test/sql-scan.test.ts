import { describe, expect, test } from 'bun:test';

import {
  PACKAGE_ROOT,
  ddlIn,
  read,
  sourceFiles,
  sqlStatements,
  unqualifiedTables,
} from './support/sql-source';

const DB_FILES = sourceFiles(`${PACKAGE_ROOT}/src/db`);
const ALL_SOURCE = sourceFiles(`${PACKAGE_ROOT}/src`);
const TABLES = new Set([
  'nodes',
  'heartbeats',
  'events',
  'settings',
  'settings_history',
  'allowed_emails',
  'access_audit',
  'login_transactions',
  'browser_sessions',
]);

describe('the scanner itself', () => {
  test('flags a table that is not schema qualified', () => {
    expect(unqualifiedTables('select * from nodes where id = ?')).toEqual([
      'from nodes',
    ]);
    expect(unqualifiedTables('insert into events (kind) values (?)')).toEqual([
      'into events',
    ]);
    expect(unqualifiedTables('update settings set value = ?')).toEqual([
      'update settings',
    ]);
    expect(unqualifiedTables('delete from public.nodes')).toEqual([
      'from public.nodes',
    ]);
    expect(
      unqualifiedTables('select * from fleet.nodes n join settings s on true')
    ).toEqual(['join settings']);
    expect(unqualifiedTables('truncate nodes')).toEqual(['truncate nodes']);
    expect(unqualifiedTables('select * from other.fleet.nodes')).toEqual([
      'from other.fleet.nodes',
    ]);
  });

  test('accepts qualified tables, functions, subqueries and update clauses', () => {
    expect(
      unqualifiedTables('select * from fleet.nodes where id = ? for update')
    ).toEqual([]);
    expect(
      unqualifiedTables(
        'insert into fleet.nodes as n (id) values (?) on conflict (id) do update set a = 1'
      )
    ).toEqual([]);
    expect(
      unqualifiedTables(
        'select x from jsonb_array_elements(?) with ordinality as e(item, ord)'
      )
    ).toEqual([]);
    expect(unqualifiedTables('select extract(epoch from now())')).toEqual([]);
    expect(unqualifiedTables('select * from (select 1) t')).toEqual([]);
  });

  test('flags DDL in code and in comments', () => {
    expect(ddlIn('await db`create table x (a int)`')).toHaveLength(1);
    expect(ddlIn('// then ALTER TABLE nodes add column')).toHaveLength(1);
    expect(ddlIn('drop schema fleet cascade')).toHaveLength(1);
    expect(ddlIn('TRUNCATE TABLE fleet.nodes')).toHaveLength(1);
    expect(ddlIn('creates a new session and drops the cookie')).toEqual([]);
  });
});

describe('src/db', () => {
  const statements = DB_FILES.flatMap((file) =>
    sqlStatements(file, read(file))
  );

  test('finds the SQL it is supposed to check', () => {
    expect(DB_FILES.length).toBeGreaterThan(5);
    expect(statements.length).toBeGreaterThan(20);
  });

  test('every table reference is fleet.<table>', () => {
    const offenders = statements.flatMap(({ file, sql }) =>
      unqualifiedTables(sql).map((ref) => `${file}: ${ref}`)
    );
    expect(offenders).toEqual([]);
  });

  test('every fleet.<name> is one of the Atlas-owned fleet tables', () => {
    const named = statements.flatMap(({ sql }) =>
      [...sql.matchAll(/\bfleet\.(\w+)/g)].map((m) => m[1] ?? '')
    );
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((name) => !TABLES.has(name))).toEqual([]);
  });

  test('no statement sets search_path or switches schema', () => {
    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).not.toMatch(/search_path/i);
    expect(sql).not.toMatch(
      /\bset\s+(?:session\s+|local\s+)?(?:role|session authorization)\s+(?!=)/i
    );
    const options = read('src/db/client.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(options).not.toMatch(/search_path/i);
  });

  test('statements go through tagged templates, never string-built SQL', () => {
    const joined = ALL_SOURCE.filter((f) => f.startsWith('src/db/'))
      .map(read)
      .join('\n');
    expect(joined).not.toMatch(/\.unsafe\(/);
    expect(joined).not.toMatch(/sql\.file\(|\.raw\(/);
  });
});

describe('src as a whole', () => {
  test('contains no DDL: the service never creates, alters, drops or truncates anything', () => {
    const offenders = ALL_SOURCE.flatMap((file) =>
      ddlIn(read(file)).map((hit) => `${file}:${hit}`)
    );
    expect(offenders).toEqual([]);
  });

  test('only src/db imports the database driver', () => {
    const importers = ALL_SOURCE.filter((file) =>
      /from ['"]bun['"]/.test(read(file))
    );
    expect(importers).toEqual(['src/db/client.ts']);
  });

  test('no file outside src/db contains SQL', () => {
    const outside = ALL_SOURCE.filter((file) => !file.startsWith('src/db/'));
    const hits = outside.flatMap((file) =>
      sqlStatements(file, read(file))
        .filter(({ sql }) => /\bfleet\.\w+/.test(sql))
        .map(() => file)
    );
    expect(hits).toEqual([]);
  });
});
