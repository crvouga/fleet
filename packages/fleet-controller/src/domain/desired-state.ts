import {
  canonicalJson,
  nodePayload,
  type FleetConfig,
} from '../config/schema';
import { createHash } from 'node:crypto';

import { CLOSURES, type Convergence, type NodeRow, type Role } from '../types';

import { DEFAULT_HEARTBEAT_SECONDS } from './status';

/**
 * The document a node converges to. The controller owns it; the node only
 * decides how to get there. `closure: null` means "keep the running system".
 */
export interface DesiredState {
  readonly revision: string;
  readonly role: Role | null;
  readonly closure: string | null;
  readonly values: Omit<FleetConfig, 'alerts'>;
}

const BASE_CLOSURE = 'base';
const REVISION_LENGTH = 16;

/**
 * The first registry closure `<role>-<cap>[-<cap>…]` whose every suffix part
 * the hardware has, in registry order; else the role's own closure.
 */
export function closureFor(
  role: Role,
  capabilities: readonly string[]
): string {
  const have = new Set(capabilities);
  const prefix = `${role}-`;
  const match = (CLOSURES as readonly string[]).find(
    (closure) =>
      closure.startsWith(prefix) &&
      closure
        .slice(prefix.length)
        .split('-')
        .every((part) => have.has(part))
  );
  return match ?? role;
}

/** First 16 hex of sha256 over the canonical `{ closure, role, values }`. */
export function desiredRevision(
  state: Omit<DesiredState, 'revision'>
): string {
  const content = {
    closure: state.closure,
    role: state.role,
    values: state.values,
  };
  return createHash('sha256')
    .update(canonicalJson(content))
    .digest('hex')
    .slice(0, REVISION_LENGTH);
}

export function intervalOf(config: FleetConfig): number {
  return config.heartbeat?.intervalSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
}

/**
 * What a node is told. A node that is not approved learns only how often to
 * report and keeps whatever it runs; an approved node without a role runs
 * base; otherwise the assigned role's closure for its hardware.
 * `config` is the node's effective settings, resolved against its ASSIGNED role.
 */
export function desiredFor(
  node: Pick<NodeRow, 'approval' | 'role' | 'hardware'>,
  config: FleetConfig
): DesiredState {
  if (node.approval !== 'approved') {
    const values = { heartbeat: { intervalSeconds: intervalOf(config) } };
    return withRevision({ role: null, closure: null, values });
  }
  const closure =
    node.role === null
      ? BASE_CLOSURE
      : closureFor(node.role, node.hardware?.capabilities ?? []);
  return withRevision({ role: node.role, closure, values: nodePayload(config) });
}

function withRevision(state: Omit<DesiredState, 'revision'>): DesiredState {
  return { revision: desiredRevision(state), ...state };
}

/**
 * Computed, never stored. Converged: the node runs the desired closure (any,
 * when the desired closure is null), acknowledged the current revision and
 * says its own loop converged. Unknown until the node reports protocol v2.
 */
export function convergenceOf(
  node: Pick<NodeRow, 'observedClosure' | 'appliedRevision' | 'reconcile'>,
  desired: Pick<DesiredState, 'revision' | 'closure'>
): Convergence {
  if (node.observedClosure === null) return 'unknown';
  const phase = node.reconcile?.phase ?? null;
  const closureMatches =
    desired.closure === null || node.observedClosure === desired.closure;
  if (
    closureMatches &&
    node.appliedRevision === desired.revision &&
    phase === 'converged'
  )
    return 'converged';
  return phase === 'blocked' ? 'blocked' : 'progressing';
}
