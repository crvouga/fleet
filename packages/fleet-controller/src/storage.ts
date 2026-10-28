import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Source = Readonly<Record<string, string | undefined>>;
const DEFAULT_PATH = fileURLToPath(
  new URL('../data/fleet.db', import.meta.url)
);
export interface StorageConfig {
  readonly path: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly replicated: true;
  readonly startupTimeoutMs: number;
}
const read = (source: Source, key: string) => source[key]?.trim() || undefined;

/**
 * Generic S3 names many hosting platforms already supply. Each is used only
 * when Fleet's own name is unset; conflicting values refuse startup.
 */
export const S3_ALIASES = {
  FLEET_S3_BUCKET: 'S3_BUCKET',
  FLEET_S3_ENDPOINT: 'S3_ENDPOINT',
  AWS_REGION: 'S3_REGION',
  AWS_ACCESS_KEY_ID: 'S3_ACCESS_KEY_ID',
  AWS_SECRET_ACCESS_KEY: 'S3_SECRET_ACCESS_KEY',
} as const;
type Aliased = keyof typeof S3_ALIASES;

function setting(
  source: Source,
  key: Aliased,
  problems: string[]
): string | undefined {
  const own = read(source, key);
  const alias = read(source, S3_ALIASES[key]);
  if (own && alias && own !== alias)
    problems.push(
      `${key} and ${S3_ALIASES[key]} are both set to different values; unset one of them`
    );
  return own ?? alias;
}

function required(source: Source, key: Aliased, problems: string[]): string {
  const value = setting(source, key, problems);
  if (!value)
    problems.push(
      `${key} is required (or ${S3_ALIASES[key]}); set it in deployment.env (see deployment.env.example)`
    );
  else if (/[\r\n\0]/.test(value))
    problems.push(
      `${key} must be a single-line value without control characters`
    );
  return value ?? '';
}

function endpointOf(source: Source, problems: string[]): string | undefined {
  const value = setting(source, 'FLEET_S3_ENDPOINT', problems);
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      throw new Error();
    if (
      ![url.username, url.password, url.search, url.hash].every(
        (part) => part === ''
      ) ||
      url.pathname !== '/'
    )
      throw new Error();
  } catch {
    problems.push(
      'FLEET_S3_ENDPOINT must be an HTTPS origin without a path, credentials or query (loopback HTTP is allowed for testing)'
    );
  }
  return value;
}

function rejectRemoved(source: Source, problems: string[]): void {
  for (const key of [
    'DATABASE_URL',
    'FLEET_DB_PREPARE',
    'FLEET_DATABASE_URL',
    'FLEET_DATABASE_AUTH_TOKEN',
    'FLEET_STORAGE_MODE',
  ]) {
    if (source[key] !== undefined)
      problems.push(
        `${key} was removed; unset it. Fleet uses local SQLite with mandatory Litestream; configure FLEET_DATABASE_PATH and S3 credentials`
      );
  }
}

function bucketOf(source: Source, problems: string[]): string {
  const value = required(source, 'FLEET_S3_BUCKET', problems);
  if (
    value &&
    (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) ||
      value.includes('..') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(value))
  ) {
    problems.push(
      'FLEET_S3_BUCKET must be a bucket name of 3–63 lowercase letters, digits, dots or hyphens; supply the name, not an s3:// URL'
    );
  }
  return value;
}

function pathOf(source: Source, problems: string[]): string {
  const path = read(source, 'FLEET_DATABASE_PATH') ?? DEFAULT_PATH;
  if (
    /[\0\r\n]/.test(path) ||
    path.includes('://') ||
    path.startsWith('file:') ||
    path === ':memory:'
  ) {
    problems.push(
      'FLEET_DATABASE_PATH must be a local filesystem path to a SQLite file, not a URL or an in-memory database'
    );
  }
  return resolve(path);
}

function timeoutOf(source: Source, problems: string[]): number {
  const value = Number(read(source, 'FLEET_STARTUP_TIMEOUT_SECONDS') ?? '60');
  if (!Number.isInteger(value) || value < 1 || value > 3600) {
    problems.push(
      'FLEET_STARTUP_TIMEOUT_SECONDS must be an integer from 1 to 3600; default 60. Increase it for large restores or slow S3 connections.'
    );
  }
  return value * 1000;
}

/** The S3 credentials Litestream reads from its environment, after alias resolution. */
export function litestreamCredentials(
  source: Source
): Record<'AWS_ACCESS_KEY_ID' | 'AWS_SECRET_ACCESS_KEY', string> {
  const ignored: string[] = [];
  return {
    AWS_ACCESS_KEY_ID: setting(source, 'AWS_ACCESS_KEY_ID', ignored) ?? '',
    AWS_SECRET_ACCESS_KEY:
      setting(source, 'AWS_SECRET_ACCESS_KEY', ignored) ?? '',
  };
}

/** Production has one storage choice: local SQLite replicated through Litestream. */
export function readStorage(source: Source, problems: string[]): StorageConfig {
  rejectRemoved(source, problems);
  const bucket = bucketOf(source, problems);
  required(source, 'AWS_ACCESS_KEY_ID', problems);
  required(source, 'AWS_SECRET_ACCESS_KEY', problems);
  const endpoint = endpointOf(source, problems);
  const prefix = read(source, 'FLEET_S3_PREFIX') ?? 'fleet';
  if (
    prefix.startsWith('/') ||
    prefix.endsWith('/') ||
    /[\r\n\0]/.test(prefix) ||
    prefix.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    problems.push(
      'FLEET_S3_PREFIX must be a non-empty object prefix with no leading/trailing slash, empty segments or dot segments (example: fleet/production)'
    );
  }
  const region = setting(source, 'AWS_REGION', problems) ?? 'us-east-1';
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(region))
    problems.push(
      'AWS_REGION must be a region identifier such as us-east-1 or auto for providers that require it'
    );
  return {
    path: pathOf(source, problems),
    bucket,
    prefix,
    region,
    replicated: true,
    startupTimeoutMs: timeoutOf(source, problems),
    ...(endpoint ? { endpoint } : {}),
  };
}
