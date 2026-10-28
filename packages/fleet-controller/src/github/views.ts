import { readFacts } from '../ui/lib/facts';
import type { AppDeps } from '../deps';
import type { NodeRow } from '../types';

import { orphanReason, type OrphanReason } from './orphans';
import { placementFor, RUNNER_ROLE } from './runner-defaults';
import type { GithubRuntime } from './runtime';
import { loadNodeContext, type NodeContext } from './sync-actions';
import {
  FAILED_CONCLUSIONS,
  type CiJob,
  type Integration,
  type RunnerRecord,
} from './types';

export interface RunnerRow {
  readonly id: number;
  readonly name: string;
  readonly repository: string | null;
  readonly status: 'online' | 'offline';
  readonly busy: boolean;
  readonly labels: readonly string[];
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly slot: string | null;
  readonly offlineSince: Date | null;
  /** Null when healthy. `removalAt` is when auto-removal may act (policy permitting). */
  readonly orphan: {
    readonly reason: OrphanReason;
    readonly since: Date | null;
    readonly removalAt: Date | null;
  } | null;
  readonly unhealthy: boolean;
}

export interface JobRow extends CiJob {
  readonly nodeLabel: string | null;
  readonly queuedSeconds: number | null;
  readonly runSeconds: number | null;
  readonly failed: boolean;
  /** Where a person can report a failed or orphaned job (issue reporting). */
  readonly reportUrl: string | null;
}

export interface RunnersView {
  readonly available: true;
  readonly integration: Omit<Integration, never>;
  readonly connection: {
    readonly keyConfigured: boolean;
    readonly webhookEnabled: boolean;
    readonly configured: boolean;
    readonly circuit: {
      readonly state: string;
      readonly openUntil: Date | null;
    } | null;
  };
  readonly capacity: {
    readonly nodes: number;
    readonly slotsTotal: number;
    readonly slotsBusy: number;
    readonly slotsFree: number;
    readonly queued: number;
    readonly inProgress: number;
    /** Queued jobs that no free slot can take right now. */
    readonly waiting: number;
  };
  readonly runners: readonly RunnerRow[];
  readonly placements: readonly {
    readonly nodeId: string;
    readonly label: string;
    readonly eligible: boolean;
    readonly repositories: readonly string[];
  }[];
  readonly unplaced: readonly string[];
}

const failed = (job: CiJob): boolean =>
  job.status === 'completed' &&
  FAILED_CONCLUSIONS.some((c) => c === job.conclusion);

function seconds(from: Date | null, to: Date | null): number | null {
  return from === null || to === null
    ? null
    : Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

export function jobRows(
  jobs: readonly CiJob[],
  nodes: readonly NodeRow[],
  now: Date
): JobRow[] {
  const labels = new Map(nodes.map((n) => [n.id, n.displayName ?? n.hostname]));
  return jobs.map((job) => {
    const bad = failed(job);
    return {
      ...job,
      nodeLabel: job.nodeId === null ? null : (labels.get(job.nodeId) ?? null),
      queuedSeconds: seconds(
        job.createdAt,
        job.startedAt ?? (job.status === 'queued' ? now : null)
      ),
      runSeconds: seconds(
        job.startedAt,
        job.completedAt ?? (job.status === 'in_progress' ? now : null)
      ),
      failed: bad,
      reportUrl: bad ? `/report-issue?kind=workload&job=${job.id}` : null,
    };
  });
}

function labelOf(node: NodeRow): string {
  return node.displayName ?? node.hostname;
}

function rowOf(
  runner: RunnerRecord,
  context: NodeContext,
  graceMs: number
): RunnerRow {
  const reason = orphanReason(runner, context.states, context.nodes);
  const node = context.nodes.find((n) => n.id === runner.nodeId) ?? null;
  const status = node === null ? null : context.states.get(node.id)?.status;
  const since = runner.orphanSince;
  const slow = status === 'stale' || status === 'offline';
  return {
    id: runner.id,
    name: runner.name,
    repository: runner.repository,
    status: runner.status,
    busy: runner.busy,
    labels: runner.labels,
    nodeId: runner.nodeId,
    nodeLabel: node === null ? null : labelOf(node),
    slot: runner.slot,
    offlineSince: runner.offlineSince,
    orphan:
      reason === null
        ? null
        : {
            reason,
            since,
            removalAt:
              since === null ? null : new Date(since.getTime() + graceMs),
          },
    unhealthy: reason !== null || runner.status === 'offline' || slow,
  };
}

function runnerRows(
  records: readonly RunnerRecord[],
  context: NodeContext,
  integration: Integration
): RunnerRow[] {
  const graceMs = integration.policy.orphanGraceSeconds * 1000;
  return records.map((runner) => rowOf(runner, context, graceMs));
}

/** Slots from the nodes' own reports: online or stale CI nodes only, as the overview counts. */
function capacityOf(context: NodeContext, queued: number, inProgress: number) {
  let slotsTotal = 0;
  let slotsBusy = 0;
  let counted = 0;
  for (const { node, status } of context.states.values()) {
    const usable = status === 'online' || status === 'stale';
    if (!usable || node.role !== RUNNER_ROLE) continue;
    const facts = readFacts(node);
    counted += 1;
    slotsTotal += facts.slots ?? 0;
    slotsBusy += facts.busySlots ?? 0;
  }
  const slotsFree = Math.max(0, slotsTotal - slotsBusy);
  return {
    nodes: counted,
    slotsTotal,
    slotsBusy,
    slotsFree,
    queued,
    inProgress,
    waiting: Math.max(0, queued - slotsFree),
  };
}

/** Everything the runners page and `GET /v1/runners` show. Real data only. */
export async function runnersView(
  runtime: GithubRuntime,
  deps: AppDeps
): Promise<RunnersView> {
  const integration = await runtime.store.getIntegration();
  const [records, context, placement, counts] = await Promise.all([
    runtime.store.listRunners(),
    loadNodeContext(deps.store, deps.now()),
    placementFor(deps.store, runtime.store),
    runtime.store.jobCounts(),
  ]);
  const circuit = runtime.circuit();
  return {
    available: true,
    integration,
    connection: {
      keyConfigured: runtime.keyConfigured(),
      webhookEnabled: runtime.webhookEnabled(),
      configured: integration.status !== 'unconfigured',
      circuit:
        circuit === null
          ? null
          : { state: circuit.state, openUntil: circuit.openUntil },
    },
    capacity: capacityOf(context, counts.queued, counts.inProgress),
    runners: runnerRows(records, context, integration),
    placements: placement.runnerNodes.map((node) => ({
      nodeId: node.id,
      label: node.displayName ?? node.hostname,
      eligible: placement.eligible.some((e) => e.id === node.id),
      repositories: placement.plan.byNode.get(node.id) ?? [],
    })),
    unplaced: placement.plan.unplaced,
  };
}
