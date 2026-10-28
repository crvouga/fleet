import { resolveConfig, type FleetConfig, type Scope } from '../config/schema';
import { DEFAULT_OFFLINE_AFTER_SECONDS } from './status';
import type { Role, SettingsRow } from '../types';

/** A node as settings see it: its id and its ASSIGNED role (null when unassigned). */
export interface SettingsSubject {
  readonly id: string;
  readonly role: Role | null;
}

/** The documents that apply to a node, in the order they merge. No role, no role scope. */
export function scopesFor(node: SettingsSubject): readonly Scope[] {
  if (node.role === null) return ['fleet', `node:${node.id}`];
  const scopes: Scope[] = ['fleet', `role:${node.role}`, `node:${node.id}`];
  // The GitHub integration's placement is a derived, lowest-priority layer for
  // runner nodes (src/github/runner-defaults.ts); it is last so it is never stored.
  return node.role === 'ci' ? [...scopes, `placement:${node.id}`] : scopes;
}

function documentOf(rows: readonly SettingsRow[], scope: Scope): FleetConfig {
  const row = rows.find((candidate) => candidate.scope === scope);
  return (row?.value ?? {}) as FleetConfig;
}

/** Fleet, then the node's role, then the node itself: the later one wins. */
export function effectiveConfig(
  rows: readonly SettingsRow[],
  node: SettingsSubject
): FleetConfig {
  return resolveConfig({
    defaults: documentOf(rows, `placement:${node.id}`),
    fleet: documentOf(rows, 'fleet'),
    role: node.role === null ? {} : documentOf(rows, `role:${node.role}`),
    node: documentOf(rows, `node:${node.id}`),
  });
}

export function offlineAfterSeconds(config: FleetConfig): number {
  return config.alerts?.offlineAfterSeconds ?? DEFAULT_OFFLINE_AFTER_SECONDS;
}
