import { resolveConfig, type FleetConfig, type Scope } from '../config/schema';
import { DEFAULT_OFFLINE_AFTER_SECONDS } from './status';
import type { Role, SettingsRow } from '../types';

/** The three documents that apply to a node, in the order they merge. */
export function scopesFor(node: { id: string; role: Role }): readonly Scope[] {
  return ['fleet', `role:${node.role}`, `node:${node.id}`];
}

function documentOf(rows: readonly SettingsRow[], scope: Scope): FleetConfig {
  const row = rows.find((candidate) => candidate.scope === scope);
  return (row?.value ?? {}) as FleetConfig;
}

/** Fleet, then the node's role, then the node itself: the later one wins. */
export function effectiveConfig(
  rows: readonly SettingsRow[],
  node: { id: string; role: Role }
): FleetConfig {
  return resolveConfig({
    fleet: documentOf(rows, 'fleet'),
    role: documentOf(rows, `role:${node.role}`),
    node: documentOf(rows, `node:${node.id}`),
  });
}

export function offlineAfterSeconds(config: FleetConfig): number {
  return config.alerts?.offlineAfterSeconds ?? DEFAULT_OFFLINE_AFTER_SECONDS;
}
