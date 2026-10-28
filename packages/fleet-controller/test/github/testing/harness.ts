import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createController } from '../../../src/app';
import { FleetAdminAuth } from '../../../src/auth/admin-auth';
import { createDb, type Db } from '../../../src/db/client';
import { SqliteStore } from '../../../src/db/sqlite-store';
import type { AppDeps, AppEnv } from '../../../src/deps';
import { withGithub } from '../../../src/github/compose';
import type { GithubRuntime } from '../../../src/github/runtime';
import type { FetchLike } from '../../../src/github/transport';
import { Clock, ADMIN_TOKEN, silent, testEnv } from '../../support/controller';
import {
  nodeIdOf,
  registerInput,
  secretOf,
  heartbeatBody,
} from '../../support/fixtures';
import { recordingLogger } from '../../support/recording-logger';

import { startFakeGithub, type FakeGithub } from './fake-github';

/** A parsed response body; tests assert on it directly, so it is deliberately loose. */
type Json = ReturnType<typeof JSON.parse>;

export const WEBHOOK_SECRET = 'webhook-secret-for-tests-0123456789';

export interface GithubHarness {
  readonly deps: AppDeps;
  readonly github: GithubRuntime;
  readonly fake: FakeGithub;
  readonly db: Db;
  readonly clock: Clock;
  readonly sleeps: number[];
  readonly store: SqliteStore;
  readonly logs: string[];
  call(
    method: string,
    path: string,
    init?: {
      headers?: Record<string, string>;
      json?: unknown;
      body?: string;
    }
  ): Promise<{ status: number; headers: Headers; body: Json; text: string }>;
  admin(
    method: string,
    path: string,
    json?: unknown
  ): ReturnType<GithubHarness['call']>;
  asNode(
    n: number,
    method: string,
    path: string,
    json?: unknown
  ): ReturnType<GithubHarness['call']>;
  /** An approved CI node that has reported `slots`. */
  addNode(
    n: number,
    options?: { role?: 'ci' | 'devbox' | null; slots?: number; gpu?: boolean }
  ): Promise<void>;
  /** Replaces a settings document, sending the current revision as If-Match. */
  putSettings(scope: string, value: unknown): Promise<void>;
  configure(overrides?: Record<string, unknown>): Promise<void>;
  /** A runner on the fake GitHub, named as a node's slot would be. */
  runnerName(n: number, slot?: number): string;
  /** A new runtime and app on the same database, as after a controller restart. */
  restart(): Promise<GithubHarness>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly key?: boolean;
  readonly webhook?: boolean;
  readonly path?: string;
  /** Reuse these (a restarted controller talks to the same GitHub, at the same time). */
  readonly fake?: FakeGithub;
  readonly clock?: Clock;
  /** What the controller's GitHub client sends requests through (the contract tests record it). */
  readonly fetch?: FetchLike;
}

/** The real SQLite store, the real routes and a loopback fake GitHub. */
export async function createGithubHarness(
  options: HarnessOptions = {}
): Promise<GithubHarness> {
  const directory =
    options.path === undefined
      ? mkdtempSync(join(tmpdir(), 'fleet-github-'))
      : null;
  const path = options.path ?? join(directory ?? '', 'fleet.db');
  const clock = options.clock ?? new Clock();
  const fake = options.fake ?? (await startFakeGithub({ now: clock.now }));
  const db = await createDb({ path });
  const sleeps: number[] = [];
  const logger = recordingLogger();
  const env: AppEnv = {
    ...testEnv(),
    github: {
      apiUrl: fake.url,
      ...(options.key === false ? {} : { privateKey: fake.privateKey }),
      ...(options.webhook === false ? {} : { webhookSecret: WEBHOOK_SECRET }),
    },
  };
  const base: AppDeps = {
    store: new SqliteStore(db),
    auth: new FleetAdminAuth({ env }),
    revisions: { latest: async () => null },
    env,
    now: clock.now,
  };
  const deps = withGithub(base, db, {
    log: logger,
    fetch: options.fetch ?? fetch,
    tuning: {
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms / 1000);
      },
      random: () => 0,
      retry: {
        maxAttempts: 3,
        baseMs: 100,
        maxMs: 1000,
        maxInlineWaitMs: 5000,
        timeoutMs: 5000,
      },
    },
  });
  const app = createController(deps, { log: silent });
  const store = base.store as SqliteStore;
  const github = deps.github as GithubRuntime;

  const call: GithubHarness['call'] = async (method, pathName, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers['Content-Type'] ??= 'application/json';
    }
    const response = await app.request(pathName, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      text,
    };
  };

  const harness: GithubHarness = {
    deps,
    github,
    fake,
    db,
    clock,
    sleeps,
    store,
    logs: logger.lines,
    call,
    admin: (method, pathName, json) =>
      call(method, pathName, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        ...(json === undefined ? {} : { json }),
      }),
    asNode: (n, method, pathName, json) =>
      call(method, pathName, {
        headers: { Authorization: `Bearer ${nodeIdOf(n)}.${secretOf(n)}` },
        ...(json === undefined ? {} : { json }),
      }),
    async addNode(n, nodeOptions = {}) {
      const role = nodeOptions.role === undefined ? 'ci' : nodeOptions.role;
      await store.registerNode(
        registerInput(n, {
          approval: 'approved',
          tokenRole: role,
          enrolledVia: 'enrollment-token',
        })
      );
      await store.recordHeartbeat(
        nodeIdOf(n),
        heartbeatBody(n, {
          runners: { slots: nodeOptions.slots ?? 4, busy: 0 },
          ...(nodeOptions.gpu
            ? { hardware: { capabilities: ['gpu' as const] } }
            : {}),
        }),
        null,
        clock.now()
      );
    },
    async putSettings(scope, value) {
      const current = await harness.admin('GET', `/v1/settings/${scope}`);
      const saved = await call('PUT', `/v1/settings/${scope}`, {
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'If-Match': String(current.body.revision),
        },
        json: value,
      });
      if (saved.status !== 200)
        throw new Error(`settings failed: ${saved.text}`);
    },
    async configure(overrides = {}) {
      const saved = await harness.admin('PUT', '/v1/github/integration', {
        scope: 'repository',
        repositories: ['acme/app'],
        appId: fake.appId,
        installationId: fake.installationId,
        ...overrides,
      });
      if (saved.status !== 200)
        throw new Error(`configure failed: ${saved.text}`);
    },
    runnerName: (n, slot = 1) =>
      `ci-${nodeIdOf(n).slice(0, 4)}-${nodeIdOf(n).slice(0, 32)}-slot-${slot}`,
    async restart() {
      await db.close();
      return createGithubHarness({ ...options, path, fake, clock });
    },
    async close() {
      if (options.fake === undefined) fake.stop();
      await db.close().catch(() => undefined);
      if (directory !== null)
        rmSync(directory, { recursive: true, force: true });
    },
  };
  return harness;
}
