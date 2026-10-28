import type { FleetConfig, Scope } from '../config/schema';
import type { NodeRow, SettingsRow } from '../types';

import { desiredFor, type DesiredState } from './desired-state';
import { effectiveConfig } from './effective-config';

/** The part of a node that decides what it is told. */
export type ImpactSubject = Pick<
  NodeRow,
  'id' | 'role' | 'approval' | 'hardware' | 'hostname' | 'displayName'
>;

/**
 * A reason a change deserves a second look. A `blocking` issue destabilises the
 * fleet and is refused unless the request acknowledges its `code`; the rest
 * are information for the person reviewing the dry run.
 */
export interface SettingsIssue {
  readonly code: string;
  readonly message: string;
  readonly blocking: boolean;
}

export interface NodeImpact {
  readonly nodeId: string;
  readonly label: string;
  readonly before: DesiredState;
  readonly after: DesiredState;
}

export interface SettingsImpact {
  readonly scope: Scope;
  /** Nodes whose desired revision would change, with both documents. */
  readonly changes: readonly NodeImpact[];
  /** Nodes that receive a desired document at all (not rejected, not retired). */
  readonly totalNodes: number;
  readonly issues: readonly SettingsIssue[];
}

/** A reboot stagger longer than this keeps a node on its old kernel for hours. */
export const SANE_REBOOT_DELAY_SECONDS = 3600;

const labelOf = (node: ImpactSubject): string =>
  node.displayName ?? node.hostname;

function replaced(
  rows: readonly SettingsRow[],
  scope: Scope,
  proposed: FleetConfig
): SettingsRow[] {
  const stand: SettingsRow = {
    scope,
    value: proposed as Readonly<Record<string, unknown>>,
    updatedAt: new Date(0),
    updatedBy: null,
    revision: 0,
  };
  return [...rows.filter((row) => row.scope !== scope), stand];
}

interface Pair {
  readonly node: ImpactSubject;
  readonly before: FleetConfig;
  readonly after: FleetConfig;
}

type Rule = (pairs: readonly Pair[]) => SettingsIssue | null;

/** Flags a rule that holds for every subject now but did not hold for every subject before. */
function everywhere(
  subset: (node: ImpactSubject) => boolean,
  holds: (config: FleetConfig) => boolean,
  issue: Omit<SettingsIssue, 'blocking'>
): Rule {
  return (pairs) => {
    const group = pairs.filter((pair) => subset(pair.node));
    if (group.length === 0) return null;
    const now = group.every((pair) => holds(pair.after));
    const was = group.every((pair) => holds(pair.before));
    return now && !was ? { ...issue, blocking: true } : null;
  };
}

const approved = (node: ImpactSubject) => node.approval === 'approved';
const ciNode = (node: ImpactSubject) =>
  node.approval === 'approved' && node.role === 'ci';

/** Flags any single node that crosses a bound it did not cross before. */
function anywhere(
  over: (config: FleetConfig) => boolean,
  issue: Omit<SettingsIssue, 'blocking'>
): Rule {
  return (pairs) => {
    const hit = pairs.filter(
      (pair) => over(pair.after) && !over(pair.before)
    ).length;
    return hit > 0
      ? {
          ...issue,
          message: `${issue.message} (${hit} node${hit === 1 ? '' : 's'})`,
          blocking: true,
        }
      : null;
  };
}

const RULES: readonly Rule[] = [
  everywhere(approved, (c) => c.sync?.paused === true, {
    code: 'fleet_sync_paused',
    message:
      'Software updates would be paused on every approved node: nothing would receive fixes until someone resumes them.',
  }),
  everywhere(ciNode, (c) => c.runners?.cordoned === true, {
    code: 'ci_runners_cordoned',
    message:
      'Every CI node would stop accepting new jobs (runners cordoned): CI would stall.',
  }),
  everywhere(ciNode, (c) => c.runners?.enabled === false, {
    code: 'ci_runners_disabled',
    message:
      'Runners would be disabled on every CI node: no job could run anywhere.',
  }),
  everywhere(ciNode, (c) => (c.capacity?.slotMax ?? 1) <= 0, {
    code: 'ci_capacity_zero',
    message: 'Every CI node would have zero runner slots.',
  }),
  everywhere(ciNode, (c) => c.capacity?.slotMax === 1, {
    code: 'ci_capacity_throttled',
    message:
      'Every CI node would be limited to a single runner slot: CI capacity would drop sharply.',
  }),
  everywhere(approved, (c) => c.reboot?.enabled === false, {
    code: 'fleet_reboot_disabled',
    message:
      'Reboots would be disabled on every approved node: kernel updates and role changes would never apply.',
  }),
  anywhere(
    (c) => (c.reboot?.delayMaxSeconds ?? 0) > SANE_REBOOT_DELAY_SECONDS,
    {
      code: 'reboot_delay_excessive',
      message: `The reboot delay would exceed ${SANE_REBOOT_DELAY_SECONDS} seconds: updates would wait hours before a node reboots`,
    }
  ),
];

/**
 * What writing `proposed` to `scope` would do: which nodes get a different
 * desired document, and whether the result is one that needs acknowledging.
 * Pure: the caller supplies the current settings rows and the nodes.
 */
export function analyzeSettingsChange(input: {
  readonly scope: Scope;
  readonly proposed: FleetConfig;
  readonly rows: readonly SettingsRow[];
  readonly nodes: readonly ImpactSubject[];
}): SettingsImpact {
  const after = replaced(input.rows, input.scope, input.proposed);
  const subjects = input.nodes.filter(
    (node) => node.approval !== 'rejected' && node.approval !== 'retired'
  );
  const pairs: Pair[] = subjects.map((node) => ({
    node,
    before: effectiveConfig(input.rows, node),
    after: effectiveConfig(after, node),
  }));
  const changes: NodeImpact[] = [];
  for (const pair of pairs) {
    const before = desiredFor(pair.node, pair.before);
    const next = desiredFor(pair.node, pair.after);
    if (before.revision !== next.revision)
      changes.push({
        nodeId: pair.node.id,
        label: labelOf(pair.node),
        before,
        after: next,
      });
  }
  const issues: SettingsIssue[] = [];
  for (const rule of RULES) {
    const issue = rule(pairs);
    if (issue !== null) issues.push(issue);
  }
  if (changes.length > 1 && changes.length === subjects.length)
    issues.push({
      code: 'fleet_wide_change',
      message: `Every one of the ${changes.length} nodes will receive a new desired document on its next heartbeat.`,
      blocking: false,
    });
  return {
    scope: input.scope,
    changes,
    totalNodes: subjects.length,
    issues,
  };
}

/** The blocking issues the request did not acknowledge by code. */
export function unacknowledged(
  issues: readonly SettingsIssue[],
  acknowledged: readonly string[]
): SettingsIssue[] {
  return issues.filter(
    (issue) => issue.blocking && !acknowledged.includes(issue.code)
  );
}
