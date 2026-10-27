import { StartupError } from '../startup-error';
import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Row } from './rows';

export type Rows = Row[] & { count: number };
export interface Db {
  (parts: TemplateStringsArray, ...values: unknown[]): Promise<Rows>;
  unsafe(sql: string, values?: SQLQueryBindings[]): Promise<Rows>;
  begin<T>(body: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface DbOptions {
  readonly path: string;
  readonly replicated?: boolean;
}

function parameter(value: unknown): SQLQueryBindings {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return Number(value);
  if (value === null || typeof value === 'string' || typeof value === 'number')
    return value;
  throw new TypeError('unsupported SQL parameter');
}

function connection(sqlite: Database): Db {
  const unsafe = async (
    sql: string,
    args: SQLQueryBindings[] = []
  ): Promise<Rows> => {
    const rows = sqlite.query<Row, SQLQueryBindings[]>(sql).all(...args);
    const changed = sqlite
      .query<{ count: number }, []>('select changes() as count')
      .get();
    return Object.assign(rows, { count: changed?.count ?? 0 });
  };
  return Object.assign(
    (parts: TemplateStringsArray, ...values: unknown[]) =>
      unsafe(parts.join('?'), values.map(parameter)),
    {
      unsafe,
      begin: async <T>(_body: (tx: Db) => Promise<T>): Promise<T> => {
        throw new Error('nested transactions are not supported');
      },
      close: async () => {
        sqlite.close();
      },
    }
  );
}

/** Serialize requests so a query cannot enter another request's write transaction. */
export async function createDb(options: DbOptions): Promise<Db> {
  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const sqlite = new Database(options.path, { create: true, strict: true });
  try {
    chmodSync(options.path, 0o600);
    sqlite.exec(
      'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;'
    );
    if (options.replicated) sqlite.exec('PRAGMA wal_autocheckpoint = 0');
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return serialized(sqlite);
}

function serialized(sqlite: Database): Db {
  const direct = connection(sqlite);
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = pending.then(run);
    pending = next.catch(() => undefined);
    return next;
  };
  return Object.assign(
    (parts: TemplateStringsArray, ...values: unknown[]) =>
      enqueue(() => direct(parts, ...values)),
    {
      unsafe: (sql: string, args?: SQLQueryBindings[]) =>
        enqueue(() => direct.unsafe(sql, args)),
      begin: <T>(body: (tx: Db) => Promise<T>) =>
        enqueue(async () => {
          sqlite.exec('BEGIN IMMEDIATE');
          try {
            const result = await body(direct);
            sqlite.exec('COMMIT');
            return result;
          } catch (error) {
            sqlite.exec('ROLLBACK');
            throw error;
          }
        }),
      close: () =>
        enqueue(async () => {
          sqlite.close();
        }),
    }
  );
}

function migrate(sqlite: Database): void {
  sqlite
    .transaction(() => {
      const result = sqlite
        .query<{ user_version: number }, []>('PRAGMA user_version')
        .get();
      const version = result?.user_version ?? 0;
      if (version > 1)
        throw new StartupError(
          'schema',
          'The database schema is newer than this controller. Deploy the matching or newer Fleet version; do not delete the working database or change its schema version.'
        );
      if (version === 0) {
        sqlite.exec(
          readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
        );
        sqlite.exec('PRAGMA user_version = 1');
      }
    })
    .immediate();
}
