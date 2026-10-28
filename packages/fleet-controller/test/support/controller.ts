import { createLogger, type Logger } from '@pkgs/logger';
import type { Hono } from 'hono';

import { createController, type ControllerAppOptions } from '../../src/app';
import { FleetAdminAuth } from '../../src/auth/admin-auth';
import type { AppDeps, AppEnv } from '../../src/deps';
import type { Store } from '../../src/store';
import type { BrowserAuth } from '../../src/auth/browser-contract';

import { T0, nodeIdOf, secretOf, sha256 } from './fixtures';

export const ADMIN_TOKEN = 'a-very-long-admin-token-for-tests-0123456789';
export const SESSION_SECRET = 'a-very-long-session-secret-for-tests-0123456789';
/** Approves and assigns ci. */
export const CI_ENROLLMENT_TOKEN = 'ci-enrollment-token-shared-secret';
/** Approves without assigning a role. */
export const PLAIN_ENROLLMENT_TOKEN = 'plain-enrollment-token-0123456789';

export const silent: Logger = createLogger({ name: 'test', level: 'silent' });

/** A clock tests move by hand. */
export class Clock {
  private current: Date;
  constructor(start: Date = T0) {
    this.current = start;
  }
  now = (): Date => new Date(this.current.getTime());
  set(date: Date): void {
    this.current = date;
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

/** A parsed response body. Tests assert on it directly, so it is deliberately loose. */
export type Json = ReturnType<typeof JSON.parse>;

export interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Json;
  readonly text: string;
}

export interface Harness {
  readonly app: Hono;
  readonly deps: AppDeps;
  readonly clock: Clock;
  call(method: string, path: string, init?: CallInit): Promise<Reply>;
  /** As the admin token holder. */
  admin(method: string, path: string, json?: unknown): Promise<Reply>;
  /** As node n, after it registered. */
  asNode(
    n: number,
    method: string,
    path: string,
    json?: unknown
  ): Promise<Reply>;
  register(n: number, extra?: Record<string, unknown>): Promise<Reply>;
}

export interface CallInit {
  readonly headers?: Record<string, string>;
  readonly json?: unknown;
  readonly body?: string;
}

export interface HarnessOptions {
  readonly browser?: BrowserAuth;
  readonly clock?: Clock;
  readonly env?: Partial<AppEnv>;
  readonly controller?: ControllerAppOptions;
}

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    adminToken: ADMIN_TOKEN,
    enrollmentTokens: [
      { sha256: sha256(CI_ENROLLMENT_TOKEN), role: 'ci' },
      { sha256: sha256(PLAIN_ENROLLMENT_TOKEN), role: null },
    ],
    ...overrides,
  };
}

/**
 * The admin token as a careful script: a settings write names the revision it
 * read (If-Match) and acknowledges exactly the warnings its dry run reported.
 * Tests of the safety rules themselves call `call` with explicit headers.
 */
async function adminWritesSettings(
  call: Harness['call'],
  path: string,
  json: unknown
): Promise<Reply> {
  const headers = { Authorization: `Bearer ${ADMIN_TOKEN}` };
  const read = await call('GET', path, { headers });
  const revision: unknown = read.body?.revision;
  const match =
    typeof revision === 'number' && revision > 0
      ? { 'If-Match': String(revision) }
      : {};
  const dry = await call('PUT', `${path}?dryRun=1`, {
    headers: { ...headers, ...match },
    json,
  });
  const codes: unknown = dry.body?.acknowledgementRequired;
  const acknowledge = Array.isArray(codes) ? codes.join(',') : '';
  return call('PUT', path, {
    headers: { ...headers, ...match, 'X-Fleet-Acknowledge': acknowledge },
    json,
  });
}

export function createHarness(
  store: Store,
  options: HarnessOptions = {}
): Harness {
  const clock = options.clock ?? new Clock();
  const env = testEnv(options.env);
  const deps: AppDeps = {
    store,
    auth: new FleetAdminAuth({
      env,
      ...(options.browser ? { browser: options.browser } : {}),
    }),
    revisions: { latest: async () => null },
    env,
    now: clock.now,
  };
  const app = createController(deps, { log: silent, ...options.controller });

  const call: Harness['call'] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    let body: string | undefined = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['Content-Type'] ??= 'application/json';
    }
    const res = await app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  };

  return {
    app,
    deps,
    clock,
    call,
    admin: (method, path, json) =>
      method === 'PUT' && /^\/v1\/settings\/[^/?]+$/.test(path)
        ? adminWritesSettings(call, path, json)
        : call(method, path, {
            headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
            ...(json !== undefined ? { json } : {}),
          }),
    asNode: (n, method, path, json) =>
      call(method, path, {
        headers: { Authorization: `Bearer ${nodeIdOf(n)}.${secretOf(n)}` },
        ...(json !== undefined ? { json } : {}),
      }),
    register: (n, extra = {}) =>
      call('POST', '/v1/nodes/register', {
        json: {
          nodeId: nodeIdOf(n),
          hostname: `ci-${nodeIdOf(n).slice(0, 4)}`,
          secret: secretOf(n),
          ...extra,
        },
      }),
  };
}
