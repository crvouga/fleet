import type { NodeRow } from '../types';

export interface RunnerIdentity {
  /** The node's hostname part, e.g. `ci-ab12` or `ci-gpu-ab12`. */
  readonly host: string;
  /** First 32 hex digits of the node id, when the name carries them. */
  readonly machine: string | null;
  /** `slot-N`. */
  readonly slot: string;
}

/**
 * Runner names are `<hostname>-<node id prefix>-slot-N` (cattle.py runner_prefix
 * and runners.nix); older nodes registered `<hostname>-slot-N`. Anything else is
 * not a Fleet runner and the controller never touches it.
 */
const NAME =
  /^(?<host>[a-z][a-z0-9-]*?)(?:-(?<machine>[0-9a-f]{32}))?-(?<slot>slot-[1-9][0-9]?)$/;
const SHORT_ID_SUFFIX = /-[0-9a-f]{4}$/;

export function parseRunnerName(name: string): RunnerIdentity | null {
  const groups = NAME.exec(name)?.groups;
  if (groups === undefined) return null;
  const host = groups['host'] ?? '';
  const machine = groups['machine'] ?? null;
  if (machine === null && !SHORT_ID_SUFFIX.test(host)) return null;
  return { host, machine, slot: groups['slot'] ?? '' };
}

/** The node a runner belongs to, or null when no known node matches. */
export function nodeForRunner(
  identity: RunnerIdentity,
  nodes: readonly NodeRow[]
): NodeRow | null {
  const { machine } = identity;
  if (machine !== null) {
    return nodes.find((node) => node.id.startsWith(machine)) ?? null;
  }
  const same = nodes.filter((node) => node.hostname === identity.host);
  return same.length === 1 ? (same[0] ?? null) : null;
}
