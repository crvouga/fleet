import { createLogger } from '@pkgs/logger';
import type { Hono } from 'hono';

import { createController } from '../../src/app';
import type { AppDeps } from '../../src/deps';
import { withIssues } from '../../src/issues/compose';
import { MemoryIssueStore } from '../../src/issues/memory-store';
import type { IssueFetch, IssueTuning } from '../../src/issues/runtime';
import { mountUi } from '../../src/routes/ui';
import {
  createTestDeps,
  FIXED_NOW,
  type TestDeps,
} from '../../src/testing/test-deps';
import { IDS, seedFleet } from '../ui/helpers';

import { FakeIssuesApi } from './fake-issues-api';

export const ADMIN = 'fleet_session=ok:tester';
export const VIEWER = 'fleet_session=viewer:reader';
export const ORIGIN = 'http://localhost';
export { IDS };

const silent = createLogger({ name: 'test', level: 'silent' });

/** A fast, deterministic delivery tuning. Time is a hand-moved clock, never a sleep. */
export const FAST: Partial<IssueTuning> = {
  baseMs: 1_000,
  capMs: 60_000,
  maxAttempts: 4,
  timeoutMs: 400,
  leaseMs: 5_000,
  commentEveryMs: 24 * 3_600_000,
};

export interface IssueHarness {
  readonly app: Hono;
  readonly deps: AppDeps & { store: TestDeps['store'] };
  readonly api: FakeIssuesApi;
  readonly memory: MemoryIssueStore;
  /** Moves the clock the controller sees. */
  advance(ms: number): void;
  now(): Date;
}

export interface HarnessOptions {
  readonly configured?: boolean;
  readonly repositoryOnly?: boolean;
  readonly tuning?: Partial<IssueTuning>;
  readonly api?: FakeIssuesApi;
  readonly seed?: boolean;
  readonly random?: () => number;
  /** What the controller's GitHub issues client sends requests through (the contract tests record it). */
  readonly fetch?: IssueFetch;
}

export async function issueHarness(
  options: HarnessOptions = {}
): Promise<IssueHarness> {
  const api = options.api ?? new FakeIssuesApi();
  if (options.api === undefined) await api.start();
  let current = FIXED_NOW.getTime();
  const now = () => new Date(current);
  api.clock = () => now().toISOString();
  const base = createTestDeps({ now });
  if (options.seed !== false) seedFleet(base);
  const memory = new MemoryIssueStore();
  const issuesEnv =
    options.configured === false
      ? options.repositoryOnly === true
        ? {
            repository: api.repository,
            labels: ['fleet-report'],
            apiUrl: api.url,
          }
        : undefined
      : {
          token: api.token,
          repository: api.repository,
          labels: ['fleet-report'],
          apiUrl: api.url,
        };
  const deps = withIssues(
    {
      ...base,
      env: {
        ...base.env,
        ...(issuesEnv === undefined ? {} : { issues: issuesEnv }),
      },
    },
    {
      store: memory,
      log: silent,
      tuning: { ...FAST, ...options.tuning },
      random: options.random ?? (() => 0.5),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }
  ) as IssueHarness['deps'];
  const app = createController(deps, { log: silent });
  mountUi(app, deps);
  return {
    app,
    deps,
    api,
    memory,
    advance: (ms) => {
      current += ms;
    },
    now,
  };
}

export async function request(
  h: IssueHarness,
  method: string,
  path: string,
  init: {
    cookie?: string | null;
    json?: unknown;
    form?: Record<string, string>;
    origin?: string | null;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = init.cookie === undefined ? ADMIN : init.cookie;
  if (cookie !== null) headers['cookie'] = cookie;
  if (method !== 'GET')
    headers['origin'] =
      init.origin === undefined ? ORIGIN : (init.origin ?? '');
  let body: string | undefined;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  return h.app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}
