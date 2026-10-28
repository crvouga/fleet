import type { AppDeps, AppEnv, RevisionSource } from '../deps';
import { createFakeAuth, type FakeAuthOptions } from './fake-auth';
import { MemoryStore } from './memory-store';

export const FIXED_NOW = new Date('2026-10-14T12:00:00.000Z');
export const LATEST_REVISION = '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283';

export interface TestDepsOptions {
  readonly auth?: FakeAuthOptions;
  readonly latest?: string | null;
  readonly now?: () => Date;
}

const ENV: AppEnv = {
  adminToken: 'test-admin-token',
  enrollmentTokens: [],
};

export interface TestDeps extends AppDeps {
  readonly store: MemoryStore;
}

/** Dependencies for rendering the dashboard without a database. */
export function createTestDeps(options: TestDepsOptions = {}): TestDeps {
  const now = options.now ?? (() => FIXED_NOW);
  const revisions: RevisionSource = {
    latest: async () =>
      options.latest === undefined ? LATEST_REVISION : options.latest,
  };
  return {
    store: new MemoryStore(now),
    auth: createFakeAuth(options.auth),
    revisions,
    env: ENV,
    now,
  };
}
