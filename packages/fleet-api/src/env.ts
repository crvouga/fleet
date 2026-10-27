import { readRelay } from './auth/relay-config';
import type { RelayConfig } from './auth/browser-contract';
import type { AppEnv } from './deps';
import { isRole, type Role } from './types';

/** Everything the process reads from its environment, parsed once at boot. */
export interface ServerEnv extends AppEnv {
  readonly relay?: RelayConfig;
  /** Postgres connection string. May carry `sslmode=require`. Never logged. */
  readonly databaseUrl: string;
  readonly port: number;
  /** Named prepared statements. Turn off behind a transaction-mode pooler. */
  readonly databasePrepare: boolean;
}

/** The environment is wrong. The message names variables, never values. */
export class ConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`fleet-api is misconfigured:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigurationError';
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 8080;
const DEFAULT_REPO = 'crvouga/fleet';
const MIN_SECRET_LENGTH = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PORT = 65_535;

function read(source: EnvSource, key: string): string | null {
  const raw = source[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readSecret(
  source: EnvSource,
  key: string,
  problems: string[]
): string {
  const value = read(source, key);
  if (value === null) {
    problems.push(`${key} is required`);
    return '';
  }
  if (value.length < MIN_SECRET_LENGTH) {
    problems.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return value;
}

function parseDatabaseUrl(source: EnvSource, problems: string[]): string {
  const value = read(source, 'DATABASE_URL');
  if (value === null) {
    problems.push('DATABASE_URL is required');
    return '';
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      problems.push('DATABASE_URL must be a postgres:// URL');
    }
  } catch {
    problems.push('DATABASE_URL must be a valid postgres:// URL');
  }
  return value;
}

function parsePort(source: EnvSource, problems: string[]): number {
  const raw = read(source, 'PORT');
  if (raw === null) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    problems.push('PORT must be a TCP port number');
    return DEFAULT_PORT;
  }
  return port;
}

function parseRoleHashes(
  source: EnvSource,
  problems: string[]
): Partial<Record<Role, string>> {
  const raw = read(source, 'FLEET_ROLE_TOKEN_HASHES');
  if (raw === null) {
    problems.push('FLEET_ROLE_TOKEN_HASHES is required (use {} for none)');
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('FLEET_ROLE_TOKEN_HASHES must be a JSON object');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('FLEET_ROLE_TOKEN_HASHES must be a JSON object');
    return {};
  }
  const out: Partial<Record<Role, string>> = {};
  for (const [role, hash] of Object.entries(parsed)) {
    if (!isRole(role)) {
      problems.push(`FLEET_ROLE_TOKEN_HASHES has an unknown role "${role}"`);
    } else if (
      typeof hash !== 'string' ||
      !SHA256_HEX.test(hash.toLowerCase())
    ) {
      problems.push(
        `FLEET_ROLE_TOKEN_HASHES.${role} must be 64 hex characters`
      );
    } else {
      out[role] = hash.toLowerCase();
    }
  }
  return out;
}

function parseRepo(source: EnvSource, problems: string[]): string {
  const raw = read(source, 'FLEET_GITHUB_REPO') ?? DEFAULT_REPO;
  if (!REPO_PATTERN.test(raw)) {
    problems.push('FLEET_GITHUB_REPO must look like owner/name');
  }
  return raw;
}

function parsePrepare(source: EnvSource, problems: string[]): boolean {
  const raw = read(source, 'FLEET_DB_PREPARE');
  if (raw === null || raw === 'true') return true;
  if (raw === 'false') return false;
  problems.push('FLEET_DB_PREPARE must be true or false');
  return true;
}

/** Parses and validates the environment, failing once with every problem. */
export function readServerEnv(source: EnvSource = process.env): ServerEnv {
  const problems: string[] = [];
  const relay = readRelay(source, problems);
  const env: ServerEnv = {
    ...(relay ? { relay } : {}),
    databaseUrl: parseDatabaseUrl(source, problems),
    port: parsePort(source, problems),
    databasePrepare: parsePrepare(source, problems),
    adminToken: readSecret(source, 'FLEET_ADMIN_TOKEN', problems),
    roleTokenHashes: parseRoleHashes(source, problems),
    githubRepo: parseRepo(source, problems),
  };
  if (problems.length > 0) throw new ConfigurationError(problems);
  return env;
}
