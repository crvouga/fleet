import { isAbsolute } from 'node:path';
import { readStorage, type StorageConfig } from './storage';
import { readOidc } from './auth/oidc-config';
import type { OidcConfig } from './auth/browser-contract';
import { readEnrollmentTokens } from './auth/enrollment-config';
import type { AppEnv } from './deps';
import { readGithubEnv } from './github/env';
import { readIssuesEnv } from './issues/env';
import { readHeartbeatRetentionDays } from './jobs/retention';
import type { OwnershipTiming } from './ownership/acquire';
import { readOwnershipTiming } from './ownership/timing';

/** Everything the process reads from its environment, parsed once at boot. */
export interface ControllerEnv extends AppEnv {
  readonly oidc?: OidcConfig;
  readonly storage: StorageConfig;
  readonly ownership: OwnershipTiming;
  readonly port: number;
  /** Heartbeat history retention, whole days 1-365; absent means the default 30. */
  readonly heartbeatRetentionDays?: number;
}

/** The environment is wrong. The message names variables, never values. */
export class ConfigurationError extends Error {
  constructor(problems: readonly string[]) {
    super(`fleet-controller is misconfigured:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigurationError';
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 8080;
const MIN_SECRET_LENGTH = 32;
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
    problems.push(
      `${key} is required; set a random secret in deployment.env (generate with openssl rand -hex 32)`
    );
    return '';
  }
  if (value.length < MIN_SECRET_LENGTH) {
    problems.push(`${key} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  if (/\s/.test(value))
    problems.push(
      `${key} must not contain whitespace; generate a new random bearer secret with openssl rand -hex 32`
    );
  return value;
}

/** FLEET_ADMIN_TOKEN_NEXT is optional: set only while rotating the admin token. */
function readAdminTokenNext(
  source: EnvSource,
  problems: string[]
): { adminTokenNext?: string } {
  if (read(source, 'FLEET_ADMIN_TOKEN_NEXT') === null) return {};
  const next = readSecret(source, 'FLEET_ADMIN_TOKEN_NEXT', problems);
  if (next === read(source, 'FLEET_ADMIN_TOKEN'))
    problems.push(
      'FLEET_ADMIN_TOKEN_NEXT must differ from FLEET_ADMIN_TOKEN; generate a new secret with openssl rand -hex 32'
    );
  return { adminTokenNext: next };
}

/** Optional operator-supplied revision and installer directory. */
function readDeploymentPaths(source: EnvSource): {
  targetRevision?: string;
  installerDir?: string;
} {
  const targetRevision = read(source, 'FLEET_TARGET_REVISION');
  const installerDir = read(source, 'FLEET_INSTALLER_DIR');
  return {
    ...(targetRevision ? { targetRevision } : {}),
    ...(installerDir ? { installerDir } : {}),
  };
}

function parsePort(source: EnvSource, problems: string[]): number {
  const raw = read(source, 'PORT');
  if (raw === null) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    problems.push(
      'PORT must be an integer TCP port number from 1 to 65535; choose an unused unprivileged port such as 8080'
    );
    return DEFAULT_PORT;
  }
  return port;
}

/** Parses and validates the environment, failing once with every problem. */
export function readControllerEnv(
  source: EnvSource = process.env
): ControllerEnv {
  const problems: string[] = [];
  const oidc = readOidc(source, problems);
  const issues = readIssuesEnv(source, problems);
  const env: ControllerEnv = {
    ...(oidc ? { oidc } : {}),
    storage: readStorage(source, problems),
    ownership: readOwnershipTiming(source, problems),
    port: parsePort(source, problems),
    ...readHeartbeatRetentionDays(source, problems),

    adminToken: readSecret(source, 'FLEET_ADMIN_TOKEN', problems),
    ...readAdminTokenNext(source, problems),
    enrollmentTokens: readEnrollmentTokens(source, problems),
    github: readGithubEnv(source, problems),
    ...(issues === undefined ? {} : { issues }),
    ...readDeploymentPaths(source),
  };
  if (env.targetRevision && !/^[a-f0-9]{40}$/i.test(env.targetRevision))
    problems.push(
      'FLEET_TARGET_REVISION must be a full 40-character Git revision'
    );
  if (env.installerDir && !isAbsolute(env.installerDir))
    problems.push('FLEET_INSTALLER_DIR must be an absolute path');
  if (problems.length > 0) throw new ConfigurationError(problems);
  return env;
}
