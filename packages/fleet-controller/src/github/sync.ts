import type { Store } from '../store';
import type { NodeRow } from '../types';

import { GithubError } from './errors';
import { nodeForRunner, parseRunnerName } from './runner-names';
import type { GithubRuntime } from './runtime';
import {
  actOnRunners,
  loadNodeContext,
  reconcileRunners,
  SYSTEM_ACTOR,
  type NodeContext,
  type ReconcileContext,
} from './sync-actions';
import {
  collectJobs,
  collectRunners,
  type Collected,
  type RunRef,
} from './sync-collect';
import { recordPlacements } from './sync-placement';
import type { CiJob, IntegrationStatus } from './types';

export interface SyncOutcome {
  readonly ran: boolean;
  readonly skipped?: 'unconfigured' | 'not-due' | 'backoff';
  readonly status?: IntegrationStatus;
  readonly runners?: number;
  readonly jobs?: number;
  readonly orphans?: number;
  readonly removed?: number;
  readonly held?: number;
  readonly error?: string;
}

const PERMANENT_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 3600_000;
const JOB_RETENTION_MS = 30 * 86_400_000;
const PRUNE_BATCH = 500;

/** Remember when to try again; `GithubRuntime.backoff` lives as long as the process. */
const backoffs = new WeakMap<GithubRuntime, number>();
const wanted = new WeakSet<GithubRuntime>();

/**
 * Run the next tick now, ignoring the interval and any backoff: the settings
 * changed, or a webhook says something happened. Polling stays the baseline.
 */
export function requestSync(runtime: GithubRuntime): void {
  backoffs.delete(runtime);
  wanted.add(runtime);
}

async function trackedRuns(runtime: GithubRuntime): Promise<RunRef[]> {
  const active = await runtime.store.listJobs({ status: 'active', limit: 100 });
  return active.map((job) => ({ id: job.runId, repository: job.repository }));
}

function publicError(error: GithubError): string {
  return `${error.code}: ${error.message}`;
}

function withNodes(job: CiJob, nodes: readonly NodeRow[]): CiJob {
  if (job.runnerName === null) return job;
  const identity = parseRunnerName(job.runnerName);
  const node = identity === null ? null : nodeForRunner(identity, nodes);
  return node === null ? job : { ...job, nodeId: node.id };
}

async function transition(
  store: Store,
  from: IntegrationStatus,
  to: IntegrationStatus,
  message: string | null
): Promise<void> {
  if (from === to) return;
  const bad = to === 'error' || to === 'degraded';
  await store.addEvent({
    nodeId: null,
    nodeLabel: null,
    kind: 'github-sync',
    severity: to === 'error' ? 'error' : bad ? 'warn' : 'info',
    message: bad
      ? `GitHub sync ${to}: ${message ?? ''}`
      : 'GitHub sync is healthy again',
    data: { from, to },
  });
  await store.audit({
    actor: SYSTEM_ACTOR,
    action: 'github.sync.status',
    targetKind: 'github-integration',
    targetId: '1',
    outcome: to === 'ok' ? 'success' : 'failed',
    detail: { from, to },
  });
}

function refusedMessage(
  ...lists: Collected<unknown>['refused'][]
): string | null {
  const first = lists.flat()[0];
  return first === undefined
    ? null
    : `${first.target}: ${publicError(first.error)}`;
}

/** The GitHub reads and the stored result of one pass. */
async function pass(
  runtime: GithubRuntime,
  store: Store,
  ctx: ReconcileContext
): Promise<{ outcome: SyncOutcome; problem: string | null }> {
  const { client, integration, now } = ctx;
  const nodes: NodeContext = await loadNodeContext(store, now);
  const previous = await runtime.store.listRunners();
  const [runners, jobs] = [
    await collectRunners(client, integration, now),
    await collectJobs(client, integration, {
      since: integration.lastSyncAt,
      now,
      tracked: await trackedRuns(runtime),
    }),
  ];
  const failed = new Set(runners.refused.map((r) => r.target));
  const kept = previous.filter(
    (r) => r.repository !== null && failed.has(r.repository)
  );
  const result = await reconcileRunners(ctx, nodes, runners.items, previous);
  await runtime.store.replaceRunners([...result.records, ...kept]);
  await runtime.store.upsertJobs(
    jobs.items.map((job) => withNodes(job, nodes.nodes))
  );
  const acted = await actOnRunners(ctx, nodes, result.records);
  await recordPlacements(store, runtime.store);
  await runtime.store.pruneJobs(
    new Date(now.getTime() - JOB_RETENTION_MS),
    PRUNE_BATCH
  );
  return {
    problem: refusedMessage(runners.refused, jobs.refused),
    outcome: {
      ran: true,
      runners: result.records.length,
      jobs: jobs.items.length,
      orphans: result.orphans,
      ...acted,
    },
  };
}

async function failed(
  runtime: GithubRuntime,
  store: Store,
  before: IntegrationStatus,
  error: unknown
): Promise<SyncOutcome> {
  if (!(error instanceof GithubError)) throw error;
  const status: IntegrationStatus = error.temporary ? 'degraded' : 'error';
  const retry = error.temporary
    ? Math.min(error.retryAfterMs ?? 60_000, MAX_BACKOFF_MS)
    : PERMANENT_RETRY_MS;
  backoffs.set(runtime, runtime.now().getTime() + retry);
  await runtime.store.setStatus(status, publicError(error), null);
  await transition(store, before, status, publicError(error));
  return { ran: true, status, error: publicError(error) };
}

function due(
  runtime: GithubRuntime,
  lastSyncAt: Date | null,
  intervalSeconds: number,
  status: IntegrationStatus
): 'backoff' | 'not-due' | null {
  if (wanted.delete(runtime)) return null;
  const at = runtime.now().getTime();
  if (at < (backoffs.get(runtime) ?? 0)) return 'backoff';
  const fresh =
    lastSyncAt !== null && at - lastSyncAt.getTime() < intervalSeconds * 1000;
  return fresh && status === 'ok' ? 'not-due' : null;
}

/**
 * One level-triggered, idempotent pass: pull runners and jobs from GitHub, upsert
 * them, flag and (if the policy allows) remove orphans, hold cordoned nodes'
 * runners and record placement changes. Skips without calling GitHub when the
 * integration is unconfigured, while backing off, or inside the interval.
 */
export async function runGithubSync(
  runtime: GithubRuntime,
  store: Store
): Promise<SyncOutcome> {
  const connection = await runtime.connect();
  const { integration } = connection;
  if (!connection.ok) {
    if (
      integration.status !== 'unconfigured' ||
      integration.lastError !== connection.message
    ) {
      await runtime.store.setStatus('unconfigured', connection.message, null);
    }
    return { ran: false, skipped: 'unconfigured', status: 'unconfigured' };
  }
  const wait = due(
    runtime,
    integration.lastSyncAt,
    integration.policy.syncIntervalSeconds,
    integration.status
  );
  if (wait !== null)
    return { ran: false, skipped: wait, status: integration.status };
  const now = runtime.now();
  try {
    const { outcome, problem } = await pass(runtime, store, {
      store,
      client: connection.client,
      integration,
      now,
    });
    const status: IntegrationStatus = problem === null ? 'ok' : 'error';
    await runtime.store.setStatus(status, problem, now);
    if (problem !== null)
      backoffs.set(runtime, now.getTime() + PERMANENT_RETRY_MS);
    await transition(store, integration.status, status, problem);
    return {
      ...outcome,
      status,
      ...(problem === null ? {} : { error: problem }),
    };
  } catch (error) {
    return failed(runtime, store, integration.status, error);
  }
}
