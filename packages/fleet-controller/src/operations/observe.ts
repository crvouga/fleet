import { effectiveConfig, scopesFor } from '../domain/effective-config';
import { convergenceOf, desiredFor } from '../domain/desired-state';
import type {
  NodeObservation,
  ReplacementObservation,
} from '../domain/operations-reconcile';
import type { NodeRow, SettingsRow } from '../types';
import { readFacts } from '../ui/lib/facts';

import type { OpsDeps } from './context';

const GONE: NodeObservation = {
  exists: false,
  approval: 'retired',
  role: null,
  lastSeenAt: null,
  bootId: null,
  uptimeSeconds: null,
  busySlots: null,
  gateClosed: null,
  appliedRevision: null,
  desiredRevision: '',
  cordoned: false,
  rebootEnabled: true,
  converged: false,
  reconcileIssue: null,
};

function gateClosedOf(
  facts: Readonly<Record<string, unknown>>
): boolean | null {
  const recovery = facts['recovery'];
  if (typeof recovery !== 'object' || recovery === null) return null;
  const gate = (recovery as Record<string, unknown>)['gate'];
  if (typeof gate !== 'object' || gate === null) return null;
  const closed = (gate as Record<string, unknown>)['closed'];
  return typeof closed === 'boolean' ? closed : null;
}

/** Only the scopes that apply to the node are read, so this is cheap enough for a heartbeat. */
export async function settingsFor(
  deps: OpsDeps,
  node: NodeRow
): Promise<readonly SettingsRow[]> {
  const found = await Promise.all(
    scopesFor(node).map((scope) => deps.store.getSettings(scope))
  );
  return found.filter((row): row is SettingsRow => row !== null);
}

export async function observeNode(
  deps: OpsDeps,
  nodeId: string
): Promise<{ node: NodeRow | null; observation: NodeObservation }> {
  const node = await deps.store.findNode(nodeId);
  if (node === null) return { node, observation: GONE };
  const config = effectiveConfig(await settingsFor(deps, node), node);
  const desired = desiredFor(node, config);
  const facts = readFacts(node);
  return {
    node,
    observation: {
      exists: true,
      approval: node.approval,
      role: node.role,
      lastSeenAt: node.lastSeenAt,
      bootId: facts.bootId,
      uptimeSeconds: facts.uptimeSeconds,
      busySlots: facts.busySlots,
      gateClosed: gateClosedOf(node.facts),
      appliedRevision: node.appliedRevision,
      desiredRevision: desired.revision,
      cordoned: config.runners?.cordoned === true,
      rebootEnabled: config.reboot?.enabled !== false,
      converged: convergenceOf(node, desired) === 'converged',
      reconcileIssue: node.reconcile?.issues[0] ?? null,
    },
  };
}

export async function observeReplacement(
  deps: OpsDeps,
  id: unknown
): Promise<ReplacementObservation | null> {
  if (typeof id !== 'string') return null;
  const { node, observation } = await observeNode(deps, id);
  if (node === null)
    return {
      exists: false,
      approval: 'retired',
      role: null,
      converged: false,
      lastSeenAt: null,
      reconcileIssue: null,
    };
  return {
    exists: true,
    approval: observation.approval,
    role: observation.role,
    converged: observation.converged,
    lastSeenAt: observation.lastSeenAt,
    reconcileIssue: observation.reconcileIssue,
  };
}
