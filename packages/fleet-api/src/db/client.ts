import { SQL } from 'bun';

/** A connection pool or a transaction on one. Both run the same queries. */
export type Db = SQL;

export interface DbOptions {
  readonly url: string;
  /** Named prepared statements. Disable behind a transaction-mode pooler. */
  readonly prepare?: boolean;
  readonly max?: number;
}

const POOL_SIZE = 5;
const IDLE_SECONDS = 30;
const CONNECT_SECONDS = 10;
const MAX_LIFETIME_SECONDS = 30 * 60;

/**
 * A small pool for a small service. `sslmode=require` in the URL is honored
 * by the driver (the connection fails rather than falling back to plaintext).
 * Nothing here sets search_path: every statement names its schema.
 */
export function createDb(options: DbOptions): Db {
  if (!Bun.semver.satisfies(Bun.version, '>=1.4.0')) {
    throw new Error(
      `FLEET_DATABASE_RUNTIME_UNSUPPORTED: Bun ${Bun.version} is below the supported SQL runtime; use the repository-pinned Bun 1.4.4 or newer.`
    );
  }
  return new SQL({
    url: options.url,
    max: options.max ?? POOL_SIZE,
    idleTimeout: IDLE_SECONDS,
    connectionTimeout: CONNECT_SECONDS,
    maxLifetime: MAX_LIFETIME_SECONDS,
    prepare: options.prepare ?? true,
  });
}
