import type { NodeRow, NodeStatus } from '../types';

import { RUNNER_ROLE } from './runner-defaults';
import { nodeForRunner, parseRunnerName } from './runner-names';
import type { GithubPolicy, RunnerRecord } from './types';

export type OrphanReason =
  | 'unknown-node'
  | 'retired-node'
  | 'role-changed'
  | 'offline-node'
  | 'offline-runner';

export interface NodeState {
  readonly node: NodeRow;
  readonly status: NodeStatus;
}

/**
 * Why a Fleet runner has no owner that can use it, or null when it is healthy
 * (or not a Fleet runner at all). A busy runner can still be flagged so a person
 * sees it, but `removable` never allows deleting one.
 */
export function orphanReason(
  runner: RunnerRecord,
  states: ReadonlyMap<string, NodeState>,
  nodes: readonly NodeRow[]
): OrphanReason | null {
  const identity = parseRunnerName(runner.name);
  if (identity === null) return null;
  const node = nodeForRunner(identity, nodes);
  if (node === null) return 'unknown-node';
  if (node.approval === 'retired' || node.approval === 'rejected')
    return 'retired-node';
  if (node.role !== RUNNER_ROLE) return 'role-changed';
  if (states.get(node.id)?.status === 'offline') return 'offline-node';
  return runner.status === 'offline' && !runner.busy ? 'offline-runner' : null;
}

/** The only rule that lets the controller delete a runner. */
export function removable(
  runner: RunnerRecord,
  reason: OrphanReason | null,
  policy: GithubPolicy,
  now: Date
): boolean {
  if (reason === null || runner.busy) return false;
  if (!policy.orphanAutoRemoval || runner.orphanSince === null) return false;
  const waited = now.getTime() - runner.orphanSince.getTime();
  return waited >= policy.orphanGraceSeconds * 1000;
}
