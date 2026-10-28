import { createLogger } from '@pkgs/logger';

import { describeError } from '../../src/issues/errors';
import { createGithubRuntime } from '../../src/github/runtime';
import { MemoryGithubStore } from '../../src/github/memory-store';
import type { CiJob } from '../../src/github/types';

import { IDS, type IssueHarness } from './support';

export const REQUEST_ID = '6f1c7a8e-1111-4222-8333-944455556666';

/** A rollback, a blocked reconcile and installer trouble on seeded nodes. Returns the event ids. */
export async function seedEvents(h: IssueHarness): Promise<{
  rollback: number;
  blocked: number;
  installer: number;
  info: number;
}> {
  const add = (
    nodeId: string,
    kind: string,
    severity: 'info' | 'warn' | 'error',
    message: string
  ) =>
    h.deps.store.addEvent({ nodeId, nodeLabel: 'n', kind, severity, message });
  await add(
    IDS.rolledBack,
    'revision',
    'info',
    'updated from 7a1b3c4 to 9f3c2a1'
  );
  await add(
    IDS.rolledBack,
    'rollback',
    'error',
    'rolled back to the previous system: runner never became healthy'
  );
  await add(
    IDS.online,
    'reconcile_blocked',
    'warn',
    'FLEET_SECRETS_RECIPIENT_MISSING: age1qqqq is not a recipient of secrets/fleet.yaml at 9f3c2a1'
  );
  await add(
    IDS.pending,
    'install',
    'error',
    'bootstrap step "write image" failed: checksum mismatch for image'
  );
  const events = await h.deps.store.listEvents({ limit: 20 });
  const id = (kind: string) => events.find((e) => e.kind === kind)!.id;
  return {
    rollback: id('rollback'),
    blocked: id('reconcile_blocked'),
    installer: id('install'),
    info: id('revision'),
  };
}

export function withJob(
  h: IssueHarness,
  overrides: Partial<CiJob> = {}
): CiJob {
  const store = new MemoryGithubStore();
  const job: CiJob = {
    id: 77,
    repository: 'acme/app',
    runId: 9,
    name: 'unit tests',
    status: 'completed',
    conclusion: 'failure',
    labels: ['ci'],
    runnerId: null,
    runnerName: `fleet-${IDS.online.slice(0, 4)}-1`,
    nodeId: IDS.online,
    htmlUrl: 'https://github.com/acme/app/actions/runs/9/job/77',
    createdAt: new Date(h.now().getTime() - 300_000),
    startedAt: new Date(h.now().getTime() - 240_000),
    completedAt: new Date(h.now().getTime() - 60_000),
    updatedAt: h.now(),
    source: 'poll',
    ...overrides,
  };
  void store.upsertJobs([job]);
  Object.assign(h.deps, {
    github: createGithubRuntime({
      env: undefined,
      store,
      now: h.now,
      fetch: async () => new Response('unused', { status: 500 }),
      log: createLogger({ name: 'test', level: 'silent' }),
    }),
  });
  return job;
}

export function recordControllerError(
  h: IssueHarness,
  error: Error,
  requestId = REQUEST_ID
): void {
  h.deps.issues!.errors.record(
    describeError(error, {
      requestId,
      at: h.now(),
      method: 'GET',
      route: '/v1/nodes',
      status: 500,
    })
  );
}
