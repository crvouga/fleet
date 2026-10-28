import {
  observeRunnerHealth,
  onlineFleetRunners,
  queueFacts,
  thresholdsOf,
  type HealthJob,
  type HealthNode,
  type RawCondition,
  type RunnerHealthInput,
  type RunnerHealthThresholds,
} from '../domain/runner-health';
import type { Store } from '../store';
import { readFacts } from '../ui/lib/facts';

import { isConfigured } from './policy';
import type { GithubRuntime } from './runtime';
import { loadNodeContext } from './sync-actions';
import type { Integration } from './types';

const JOB_PAGE = 200;
const MAX_JOB_PAGES = 5;
const MIN_FRESH_SECONDS = 300;
const FRESH_INTERVALS = 5;

/**
 * Whether the mirrored GitHub data can be trusted as current: configured, and
 * synced within a few intervals. Health facts of a stale mirror are not shown
 * or exported (unknown is omitted, never zero).
 */
export function mirrorIsCurrent(integration: Integration, now: Date): boolean {
  if (integration.status === 'unconfigured' || !isConfigured(integration))
    return false;
  if (integration.lastSyncAt === null) return false;
  const limit = Math.max(
    MIN_FRESH_SECONDS,
    integration.policy.syncIntervalSeconds * FRESH_INTERVALS
  );
  return (now.getTime() - integration.lastSyncAt.getTime()) / 1000 <= limit;
}

async function queuedJobs(runtime: GithubRuntime): Promise<HealthJob[]> {
  const jobs: HealthJob[] = [];
  let beforeId: number | undefined;
  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    const rows = await runtime.store.listJobs({
      status: 'queued',
      limit: JOB_PAGE,
      ...(beforeId === undefined ? {} : { beforeId }),
    });
    jobs.push(...rows);
    const last = rows.at(-1);
    if (rows.length < JOB_PAGE || last === undefined) break;
    beforeId = last.id;
  }
  return jobs;
}

/** The mirrored jobs and runners and the nodes' reports, shaped for `domain/runner-health.ts`. */
export async function loadHealthInput(
  runtime: GithubRuntime,
  store: Store,
  integration: Integration,
  now: Date
): Promise<RunnerHealthInput> {
  const [jobs, runners, context] = await Promise.all([
    queuedJobs(runtime),
    runtime.store.listRunners(),
    loadNodeContext(store, now),
  ]);
  const nodes: HealthNode[] = [...context.states.values()].map(
    ({ node, status }) => ({
      id: node.id,
      label: node.displayName ?? node.hostname,
      role: node.role,
      approved: node.approval === 'approved',
      status,
      issues: readFacts(node).readinessIssues ?? [],
    })
  );
  return {
    now,
    active: mirrorIsCurrent(integration, now),
    jobs,
    runners,
    nodes,
  };
}

export interface RunnerHealthView {
  /** False when the integration is unconfigured or its mirror is stale: nothing below is shown. */
  readonly available: boolean;
  readonly thresholds: RunnerHealthThresholds;
  readonly runnersOnline: number;
  readonly queuedFleetJobs: number;
  readonly oldestQueuedSeconds: number;
  readonly queueStalled: boolean;
  /** Conditions that hold right now (an incident opens once they have held long enough). */
  readonly conditions: readonly {
    readonly rule: RawCondition['rule'];
    readonly nodeId: string | null;
    readonly nodeLabel: string | null;
    readonly severity: RawCondition['severity'];
    readonly message: string;
  }[];
}

/** The page and API view of runner health, computed from the same data as the incidents. */
export function runnerHealthView(
  input: RunnerHealthInput,
  integration: Integration
): RunnerHealthView {
  const thresholds = thresholdsOf(integration.policy);
  const facts = queueFacts(input, thresholds);
  const conditions = observeRunnerHealth(input, thresholds);
  return {
    available: input.active,
    thresholds,
    runnersOnline: onlineFleetRunners(input),
    queuedFleetJobs: facts.queued,
    oldestQueuedSeconds: facts.oldestQueuedSeconds,
    queueStalled: facts.stalled.length > 0,
    conditions: conditions.map((c) => ({
      rule: c.rule,
      nodeId: c.nodeId,
      nodeLabel: c.nodeLabel,
      severity: c.severity,
      message: c.message,
    })),
  };
}
