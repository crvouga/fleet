import type { NodeRow, NodeStatus, NodeView } from '../types';

/** Defaults used when no setting overrides them. */
export const DEFAULT_OFFLINE_AFTER_SECONDS = 300;
export const DEFAULT_HEARTBEAT_SECONDS = 60;
const ONLINE_FACTOR = 2.5;
const ONLINE_FLOOR_SECONDS = 90;

/**
 * How recently a node must have reported to count as online. It scales with
 * the node's own interval (a missed beat or two is not an outage) but never
 * exceeds the offline threshold.
 */
export function onlineWithinSeconds(
  intervalSeconds: number,
  offlineAfterSeconds: number
): number {
  return Math.min(
    Math.max(ONLINE_FACTOR * intervalSeconds, ONLINE_FLOOR_SECONDS),
    offlineAfterSeconds
  );
}

export function statusOf(
  row: Pick<NodeRow, 'approval' | 'lastSeenAt' | 'heartbeatIntervalSeconds'>,
  now: Date,
  offlineAfterSeconds: number
): NodeStatus {
  if (row.approval !== 'approved') return row.approval;
  if (row.lastSeenAt === null) return 'offline';
  const age = (now.getTime() - row.lastSeenAt.getTime()) / 1000;
  if (
    age <=
    onlineWithinSeconds(row.heartbeatIntervalSeconds, offlineAfterSeconds)
  ) {
    return 'online';
  }
  return age <= offlineAfterSeconds ? 'stale' : 'offline';
}

export function viewOf(
  row: NodeRow,
  now: Date,
  offlineAfterSeconds: number
): NodeView {
  return {
    ...row,
    status: statusOf(row, now, offlineAfterSeconds),
    shortId: row.id.slice(0, 4),
    label: row.displayName ?? row.hostname,
    ageSeconds:
      row.lastSeenAt === null
        ? null
        : Math.max(
            0,
            Math.round((now.getTime() - row.lastSeenAt.getTime()) / 1000)
          ),
  };
}
