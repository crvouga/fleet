import {
  effectiveConfig,
  offlineAfterSeconds,
} from '../domain/effective-config';
import { statusOf } from '../domain/status';
import type { Store } from '../store';
import type { NodeRow } from '../types';

import type { GithubClient } from './client';
import { GithubError } from './errors';
import {
  orphanReason,
  removable,
  type NodeState,
  type OrphanReason,
} from './orphans';
import { nodeForRunner, parseRunnerName } from './runner-names';
import type { Integration, RunnerRecord, RunnerTarget } from './types';

export const SYSTEM_ACTOR = 'system:github-sync';

export interface ReconcileContext {
  readonly store: Store;
  readonly client: GithubClient;
  readonly integration: Integration;
  readonly now: Date;
}

export interface ReconcileResult {
  readonly records: readonly RunnerRecord[];
  readonly orphans: number;
}

export interface NodeContext {
  readonly nodes: readonly NodeRow[];
  readonly states: ReadonlyMap<string, NodeState>;
  readonly cordoned: ReadonlySet<string>;
}

export async function loadNodeContext(
  store: Store,
  now: Date
): Promise<NodeContext> {
  const [nodes, rows] = await Promise.all([
    store.listNodes(),
    store.listSettings(),
  ]);
  const states = new Map<string, NodeState>();
  const cordoned = new Set<string>();
  for (const node of nodes) {
    const config = effectiveConfig(rows, node);
    const status = statusOf(node, now, offlineAfterSeconds(config));
    states.set(node.id, { node, status });
    const runners = config.runners;
    if (runners?.cordoned === true || runners?.enabled === false)
      cordoned.add(node.id);
  }
  return { nodes, states, cordoned };
}

function carry(
  runner: RunnerRecord,
  before: RunnerRecord | undefined,
  reason: OrphanReason | null,
  now: Date
): RunnerRecord {
  const identity = parseRunnerName(runner.name);
  const offline = runner.status === 'offline';
  return {
    ...runner,
    slot: identity?.slot ?? null,
    offlineSince: offline ? (before?.offlineSince ?? now) : null,
    orphanSince: reason === null ? null : (before?.orphanSince ?? now),
  };
}

export function targetOf(
  runner: RunnerRecord,
  integration: Integration
): RunnerTarget {
  return runner.repository === null
    ? { scope: 'organization', name: integration.organization }
    : { scope: 'repository', name: runner.repository };
}

async function removeOrphan(
  ctx: ReconcileContext,
  runner: RunnerRecord,
  reason: OrphanReason
): Promise<boolean> {
  try {
    await ctx.client.deleteRunner(targetOf(runner, ctx.integration), runner.id);
  } catch (error) {
    if (error instanceof GithubError && !error.temporary) {
      await ctx.store.audit({
        actor: SYSTEM_ACTOR,
        action: 'runner.orphan.remove',
        targetKind: 'github-runner',
        targetId: String(runner.id),
        outcome: 'failed',
        detail: { runner: runner.name, reason, code: error.code },
      });
      return false;
    }
    throw error;
  }
  await ctx.store.audit({
    actor: SYSTEM_ACTOR,
    action: 'runner.orphan.remove',
    targetKind: 'github-runner',
    targetId: String(runner.id),
    detail: { runner: runner.name, reason, repository: runner.repository },
  });
  await ctx.store.addEvent({
    nodeId: runner.nodeId,
    nodeLabel: null,
    kind: 'runner-removed',
    severity: 'info',
    message: `Removed orphan runner ${runner.name} from GitHub (${reason})`,
    data: { runner: runner.name, reason },
  });
  return true;
}

async function flagOrphan(
  ctx: ReconcileContext,
  runner: RunnerRecord,
  reason: OrphanReason
): Promise<void> {
  await ctx.store.addEvent({
    nodeId: runner.nodeId,
    nodeLabel: null,
    kind: 'runner-orphan',
    severity: 'warn',
    message: `GitHub runner ${runner.name} has no usable node (${reason})`,
    data: {
      runner: runner.name,
      reason,
      graceSeconds: ctx.integration.policy.orphanGraceSeconds,
    },
  });
}

/** Removes routing labels from a runner of a cordoned node so no new job lands on it. */
async function hold(
  ctx: ReconcileContext,
  runner: RunnerRecord
): Promise<boolean> {
  const removed = await ctx.client.removeCustomLabels(
    targetOf(runner, ctx.integration),
    runner.id,
    runner.labels
  );
  if (removed === 0) return false;
  await ctx.store.audit({
    actor: SYSTEM_ACTOR,
    action: 'runner.hold',
    targetKind: 'github-runner',
    targetId: String(runner.id),
    detail: { runner: runner.name, labelsRemoved: removed },
  });
  return true;
}

function resolve(
  runner: RunnerRecord,
  nodes: NodeContext,
  before: RunnerRecord | undefined,
  now: Date
) {
  const reason = orphanReason(runner, nodes.states, nodes.nodes);
  const identity = parseRunnerName(runner.name);
  const node = identity === null ? null : nodeForRunner(identity, nodes.nodes);
  const record = carry(
    { ...runner, nodeId: node?.id ?? null },
    before,
    reason,
    now
  );
  const fresh = (before?.orphanSince ?? null) === null;
  return { record, reason, fresh };
}

/**
 * Correlate runners to nodes and flag orphans. Records are returned for storage
 * before any deletion, so an interrupted pass repeats the same decisions.
 */
export async function reconcileRunners(
  ctx: ReconcileContext,
  nodes: NodeContext,
  listed: readonly RunnerRecord[],
  previous: readonly RunnerRecord[]
): Promise<ReconcileResult> {
  const before = new Map(previous.map((r) => [r.id, r]));
  const records: RunnerRecord[] = [];
  let orphans = 0;
  for (const runner of listed) {
    const found = resolve(runner, nodes, before.get(runner.id), ctx.now);
    records.push(found.record);
    if (found.reason === null) continue;
    orphans += 1;
    if (found.fresh) await flagOrphan(ctx, found.record, found.reason);
  }
  return { records, orphans };
}

/** The GitHub writes of a pass, after the records are stored. */
export async function actOnRunners(
  ctx: ReconcileContext,
  nodes: NodeContext,
  records: readonly RunnerRecord[]
): Promise<{ removed: number; held: number }> {
  let removed = 0;
  let held = 0;
  for (const runner of records) {
    const reason = orphanReason(runner, nodes.states, nodes.nodes);
    if (
      removable(runner, reason, ctx.integration.policy, ctx.now) &&
      reason !== null
    ) {
      if (await removeOrphan(ctx, runner, reason)) {
        removed += 1;
      }
      continue;
    }
    if (
      runner.nodeId !== null &&
      nodes.cordoned.has(runner.nodeId) &&
      (await hold(ctx, runner))
    )
      held += 1;
  }
  return { removed, held };
}
