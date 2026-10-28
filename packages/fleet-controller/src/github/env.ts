import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { KeyObject } from 'node:crypto';

import { parsePrivateKey } from './app-jwt';

/**
 * Operator-supplied GitHub settings. The private key exists only here, parsed
 * once at boot: it is never stored in the database, rendered or logged.
 */
export interface GithubEnv {
  /** Absent: the controller cannot talk to GitHub and nothing is simulated. */
  readonly privateKey?: KeyObject;
  /** Absent: `POST /v1/github/webhook` answers 404; polling stays the baseline. */
  readonly webhookSecret?: string;
  /** https://api.github.com unless a GitHub Enterprise Server (or a test) says otherwise. */
  readonly apiUrl: string;
}

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const MIN_WEBHOOK_SECRET = 16;
const MAX_KEY_FILE_BYTES = 16 * 1024;
type Source = Readonly<Record<string, string | undefined>>;

function value(source: Source, key: string): string | null {
  const raw = source[key]?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

function loadPem(source: Source, problems: string[]): string | null {
  const inline = value(source, 'FLEET_GITHUB_APP_PRIVATE_KEY');
  const file = value(source, 'FLEET_GITHUB_APP_PRIVATE_KEY_FILE');
  if (inline !== null && file !== null) {
    problems.push(
      'set only one of FLEET_GITHUB_APP_PRIVATE_KEY and FLEET_GITHUB_APP_PRIVATE_KEY_FILE'
    );
    return null;
  }
  if (inline !== null) return inline.replace(/\\n/g, '\n');
  if (file === null) return null;
  if (!isAbsolute(file)) {
    problems.push('FLEET_GITHUB_APP_PRIVATE_KEY_FILE must be an absolute path');
    return null;
  }
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length <= MAX_KEY_FILE_BYTES) return text;
    problems.push('FLEET_GITHUB_APP_PRIVATE_KEY_FILE is too large for a key');
  } catch {
    problems.push('FLEET_GITHUB_APP_PRIVATE_KEY_FILE could not be read');
  }
  return null;
}

function readKey(source: Source, problems: string[]): KeyObject | undefined {
  const pem = loadPem(source, problems);
  if (pem === null) return undefined;
  try {
    return parsePrivateKey(pem);
  } catch {
    problems.push(
      'the GitHub App private key (FLEET_GITHUB_APP_PRIVATE_KEY or _FILE) is not a usable RSA private key in PEM form'
    );
    return undefined;
  }
}

function readApiUrl(source: Source, problems: string[]): string {
  const raw = value(source, 'FLEET_GITHUB_API_URL');
  if (raw === null) return DEFAULT_GITHUB_API_URL;
  try {
    const url = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    const allowed =
      url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
    if (allowed && url.username === '' && url.password === '') {
      return raw.replace(/\/+$/, '');
    }
  } catch {
    // Reported below without echoing the value.
  }
  problems.push(
    'FLEET_GITHUB_API_URL must be an https URL without credentials (http only for loopback)'
  );
  return DEFAULT_GITHUB_API_URL;
}

/** Parses the optional GitHub variables; problems name variables, never values. */
export function readGithubEnv(source: Source, problems: string[]): GithubEnv {
  const privateKey = readKey(source, problems);
  const secret = value(source, 'FLEET_GITHUB_WEBHOOK_SECRET');
  if (secret !== null && secret.length < MIN_WEBHOOK_SECRET) {
    problems.push(
      `FLEET_GITHUB_WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET} characters`
    );
  }
  return {
    apiUrl: readApiUrl(source, problems),
    ...(privateKey === undefined ? {} : { privateKey }),
    ...(secret === null ? {} : { webhookSecret: secret }),
  };
}
