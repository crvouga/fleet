import { describe, expect, test } from 'bun:test';

import { parseSchemaHcl, type HclColumn } from './support/hcl';
import {
  read,
  sourceFiles,
  sqlStatements,
  PACKAGE_ROOT,
} from './support/sql-source';

const SCHEMA = parseSchemaHcl();
const DB_FILES = sourceFiles(`${PACKAGE_ROOT}/src/db`);
const STATEMENTS = DB_FILES.flatMap((file) => sqlStatements(file, read(file)));

/** The row reader each mapper uses, by the Postgres types it can read. */
const READERS: Readonly<Record<string, readonly string[]>> = {
  text: ['text'],
  textOrNull: ['text'],
  oneOf: ['text'],
  numberOf: ['integer', 'bigint', 'real'],
  numberOrNull: ['integer', 'bigint', 'real'],
  dateOf: ['timestamptz'],
  dateOrNull: ['timestamptz'],
  textList: ['text[]'],
  jsonObject: ['jsonb'],
  telemetryOrNull: ['jsonb'],
};

/** SQL casts, by the column types that accept them. */
const CASTS: Readonly<Record<string, readonly string[]>> = {
  text: ['text'],
  int: ['integer'],
  jsonb: ['jsonb'],
  bigint: ['bigint', 'integer'],
  real: ['real'],
  timestamptz: ['timestamptz'],
  'text[]': ['text[]'],
};

const MAPPERS: Readonly<Record<string, string>> = {
  toNodeRow: 'nodes',
  toHeartbeatPoint: 'heartbeats',
  toEventRow: 'events',
  toSettingsRow: 'settings',
  toSettingsHistoryRow: 'settings_history',
};

function column(table: string, name: string): HclColumn | undefined {
  return SCHEMA[table]?.[name];
}

function mapperReads(
  source: string,
  mapper: string
): { reader: string; key: string }[] {
  const start = source.indexOf(`export function ${mapper}(`);
  const next = source.indexOf('export function', start + 10);
  const body = source.slice(start, next < 0 ? undefined : next);
  return [...body.matchAll(/\b(\w+)\(row, '(\w+)'/g)].map((m) => ({
    reader: m[1] ?? '',
    key: m[2] ?? '',
  }));
}

describe('schema.hcl', () => {
  test('is parsed into the fleet and browser authorization tables', () => {
    expect(Object.keys(SCHEMA).sort()).toEqual([
      'access_audit',
      'allowed_emails',
      'browser_sessions',
      'events',
      'heartbeats',
      'login_transactions',
      'nodes',
      'settings',
      'settings_history',
    ]);
    expect(column('nodes', 'labels')).toMatchObject({
      type: 'text[]',
      nullable: false,
      hasDefault: true,
    });
    expect(column('events', 'id')).toMatchObject({
      type: 'bigint',
      identity: true,
    });
    expect(column('nodes', 'display_name')).toMatchObject({
      type: 'text',
      nullable: true,
    });
  });
});

describe('what PgStore reads', () => {
  const rows = read('src/db/rows.ts');
  for (const [mapper, table] of Object.entries(MAPPERS)) {
    test(`${mapper} reads only columns of ${table}, with types its readers accept`, () => {
      const reads = mapperReads(rows, mapper).filter(
        ({ reader }) => reader in READERS
      );
      expect(reads.length).toBeGreaterThan(3);
      for (const { reader, key } of reads) {
        const found = column(table, key);
        expect(found, `${table}.${key} must exist in schema.hcl`).toBeDefined();
        expect(
          READERS[reader],
          `${table}.${key} is ${found?.type}, read by ${reader}`
        ).toContain(found?.type);
      }
    });
  }

  test('every NOT NULL column is read with a reader that rejects null', () => {
    for (const [mapper, table] of Object.entries(MAPPERS)) {
      for (const { reader, key } of mapperReads(rows, mapper)) {
        const found = column(table, key);
        if (found?.nullable === false)
          expect(reader.endsWith('OrNull')).toBe(false);
        if (found?.nullable === true)
          expect([
            'textOrNull',
            'numberOrNull',
            'dateOrNull',
            'telemetryOrNull',
          ]).toContain(reader);
      }
    }
  });

  test('each mapper reads every column of its table, so nothing is silently dropped', () => {
    // secret_hash never leaves the database; a point is addressed by its node and carries no revision.
    const deliberately: Record<string, string[]> = {
      nodes: ['secret_hash'],
      heartbeats: ['node_id', 'revision'],
    };
    for (const [mapper, table] of Object.entries(MAPPERS)) {
      const seen = new Set(mapperReads(rows, mapper).map((r) => r.key));
      const missing = Object.keys(SCHEMA[table] ?? {}).filter(
        (name) => !seen.has(name) && !deliberately[table]?.includes(name)
      );
      expect(missing, `${table} columns no mapper reads`).toEqual([]);
    }
  });
});

describe('what PgStore writes', () => {
  const inserts = STATEMENTS.flatMap(({ sql }) =>
    [
      ...sql.matchAll(
        /insert into fleet\.(\w+)(?:\s+as\s+\w+)?\s*\(([^)]*)\)/gi
      ),
    ].map((m) => ({
      table: m[1] ?? '',
      columns: (m[2] ?? '').split(',').map((c) => c.trim()),
    }))
  );

  test('finds the inserts', () => {
    expect(new Set(inserts.map((i) => i.table))).toEqual(
      new Set([
        'nodes',
        'heartbeats',
        'events',
        'settings',
        'settings_history',
        'allowed_emails',
        'access_audit',
        'login_transactions',
        'browser_sessions',
      ])
    );
  });

  test('every inserted column exists', () => {
    for (const { table, columns } of inserts) {
      for (const name of columns)
        expect(column(table, name), `${table}.${name}`).toBeDefined();
    }
  });

  test('every required column (NOT NULL, no default, not identity) is inserted', () => {
    for (const { table, columns } of inserts) {
      const required = Object.entries(SCHEMA[table] ?? {})
        .filter(([, c]) => !c.nullable && !c.hasDefault && !c.identity)
        .map(([name]) => name);
      expect(columns, `insert into ${table}`).toEqual(
        expect.arrayContaining(required)
      );
    }
  });

  test('every column assigned by an update exists and takes the cast it is given', () => {
    const updates = STATEMENTS.flatMap(({ sql }) =>
      [
        ...sql.matchAll(
          /update fleet\.(\w+)\s+set([\s\S]*?)(?:\bwhere\b|\breturning\b|$)/gi
        ),
      ].map((m) => ({
        table: m[1] ?? '',
        assignments: [
          ...(m[2] ?? '').matchAll(
            /(?:^|,)\s*(\w+)\s*=\s*(?!excluded|case|coalesce)\?((?:::[a-z]+(?:\[\])?)+)/g
          ),
        ],
      }))
    );
    expect(updates.length).toBeGreaterThan(3);
    let typed = 0;
    for (const { table, assignments } of updates) {
      for (const match of assignments) {
        const name = match[1] ?? '';
        const cast = (match[2] ?? '').split('::').pop() ?? '';
        const found = column(table, name);
        expect(found, `${table}.${name}`).toBeDefined();
        expect(
          CASTS[cast],
          `${table}.${name} is ${found?.type} but is assigned ::${cast}`
        ).toContain(found?.type);
        typed += 1;
      }
    }
    expect(typed).toBeGreaterThan(8);
  });

  test('every snake_case identifier in the SQL is a column, a table or a known function', () => {
    const known = new Set<string>([
      'jsonb_array_elements',
      'jsonb_array_elements_text',
      'pg_advisory_xact_lock',
      'row_number',
      ...Object.keys(SCHEMA),
    ]);
    for (const columns of Object.values(SCHEMA))
      for (const name of Object.keys(columns)) known.add(name);
    const unknown = STATEMENTS.flatMap(({ file, sql }) =>
      [...sql.replace(/'[^']*'/g, '').matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b/g)]
        .map((m) => m[0])
        .filter((word) => !known.has(word) && !['do_nothing'].includes(word))
        .map((word) => `${file}: ${word}`)
    );
    expect(unknown).toEqual([]);
  });
});
