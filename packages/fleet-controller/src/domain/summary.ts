import { readFacts } from '../ui/lib/facts';
import {
  ROLES,
  isActiveRole,
  type FleetSummary,
  type NodeStatus,
  type NodeView,
  type Role,
} from '../types';

const STATUSES: readonly NodeStatus[] = [
  'online',
  'stale',
  'offline',
  'pending',
  'rejected',
  'retired',
];

function emptyByStatus(): Record<NodeStatus, number> {
  return Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    NodeStatus,
    number
  >;
}

function emptyByRole(): Record<Role, { total: number; online: number }> {
  return Object.fromEntries(
    ROLES.map((role) => [role, { total: 0, online: 0 }])
  ) as Record<Role, { total: number; online: number }>;
}

/** Active roles, plus a retired role only while approved nodes still carry it. */
export function visibleRoles(byRole: FleetSummary['byRole']): Role[] {
  return ROLES.filter((role) => isActiveRole(role) || byRole[role].total > 0);
}

function revisionCounts(views: readonly NodeView[]): FleetSummary['revisions'] {
  const counts = new Map<string, number>();
  for (const view of views) {
    if (view.approval === 'retired' || view.revision === null) continue;
    counts.set(view.revision, (counts.get(view.revision) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([revision, count]) => ({ revision, count }))
    .sort((a, b) => b.count - a.count || a.revision.localeCompare(b.revision));
}

/**
 * Counts for the overview and `GET /v1/summary`.
 *
 * - `byRole` counts approved nodes only: a pending machine does not serve its
 *   role yet. `online` counts those that are reporting on time.
 * - `runnerSlots` adds up nodes that are online or stale; an offline node's
 *   last report says nothing about capacity you can use now.
 * - `withFailedUnits` and `rolledBack` look at approved nodes, because their
 *   last report is what an operator would act on.
 */
export function summarize(views: readonly NodeView[]): FleetSummary {
  const byStatus = emptyByStatus();
  const byRole = emptyByRole();
  const runnerSlots = { total: 0, busy: 0 };
  let withFailedUnits = 0;
  let rolledBack = 0;
  for (const view of views) {
    byStatus[view.status] += 1;
    if (view.approval !== 'approved') continue;
    byRole[view.role].total += 1;
    const facts = readFacts(view);
    if (view.status === 'online') byRole[view.role].online += 1;
    if (facts.failedUnits.length > 0) withFailedUnits += 1;
    if (facts.rolledBack) rolledBack += 1;
    if (
      (view.status === 'online' || view.status === 'stale') &&
      facts.slots !== null
    ) {
      runnerSlots.total += facts.slots;
      runnerSlots.busy += Math.min(facts.busySlots ?? 0, facts.slots);
    }
  }
  return {
    total: views.length,
    byStatus,
    byRole,
    revisions: revisionCounts(views),
    runnerSlots,
    withFailedUnits,
    rolledBack,
  };
}
