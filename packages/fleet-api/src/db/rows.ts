import type {
  Approval,
  EnrolledVia,
  EventRow,
  HeartbeatPoint,
  NodeRow,
  Severity,
  SettingsHistoryRow,
  SettingsRow,
} from '../types';
import { isRole } from '../types';
import type { Telemetry } from '../telemetry';
import { telemetryOf } from '../domain/telemetry-validation';
import { compactTelemetry } from '../domain/heartbeat-history';

/** One result row as the driver returns it. Converted before leaving src/db. */
export type Row = Readonly<Record<string, unknown>>;

const APPROVALS: readonly Approval[] = [
  'pending',
  'approved',
  'rejected',
  'retired',
];
const SEVERITIES: readonly Severity[] = ['info', 'warn', 'error'];
const ENROLLED: readonly EnrolledVia[] = ['role-token', 'hello', 'dashboard'];

function bad(key: string, expected: string): never {
  throw new TypeError(`database column ${key} was not ${expected}`);
}

export function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : bad(key, 'text');
}

export function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : bad(key, 'text');
}

/** int, real and bigint columns. The driver returns bigint as a string. */
export function numberOf(row: Row, key: string): number {
  const value = row[key];
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed)
    ? parsed
    : bad(key, 'a number');
}

export function numberOrNull(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined
    ? null
    : numberOf(row, key);
}

export function dateOf(row: Row, key: string): Date {
  const value = row[key];
  return value instanceof Date ? value : bad(key, 'a timestamp');
}

export function dateOrNull(row: Row, key: string): Date | null {
  return row[key] === null || row[key] === undefined ? null : dateOf(row, key);
}

export function textList(row: Row, key: string): string[] {
  const value = row[key];
  if (!Array.isArray(value)) return bad(key, 'a text[]');
  return value.map((item) =>
    typeof item === 'string' ? item : bad(key, 'a text[]')
  );
}

export function jsonObject(row: Row, key: string): Record<string, unknown> {
  const value = row[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return bad(key, 'a jsonb object');
}

function oneOf<T extends string>(
  row: Row,
  key: string,
  allowed: readonly T[]
): T {
  const value = text(row, key);
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : bad(key, 'a known value');
}

export function toNodeRow(row: Row): NodeRow {
  const role = text(row, 'role');
  if (!isRole(role)) bad('role', 'a known role');
  return {
    id: text(row, 'id'),
    role: role as NodeRow['role'],
    hostname: text(row, 'hostname'),
    approval: oneOf(row, 'approval', APPROVALS),
    displayName: textOrNull(row, 'display_name'),
    note: textOrNull(row, 'note'),
    labels: textList(row, 'labels'),
    facts: jsonObject(row, 'facts'),
    revision: textOrNull(row, 'revision'),
    agentVersion: textOrNull(row, 'agent_version'),
    configRevision: textOrNull(row, 'config_revision'),
    heartbeatIntervalSeconds: numberOf(row, 'heartbeat_interval_seconds'),
    remoteAddr: textOrNull(row, 'remote_addr'),
    enrolledVia: oneOf(row, 'enrolled_via', ENROLLED),
    firstSeenAt: dateOf(row, 'first_seen_at'),
    lastSeenAt: dateOrNull(row, 'last_seen_at'),
    approvedAt: dateOrNull(row, 'approved_at'),
    approvedBy: textOrNull(row, 'approved_by'),
    retiredAt: dateOrNull(row, 'retired_at'),
    offlineNotifiedAt: dateOrNull(row, 'offline_notified_at'),
  };
}

export function toHeartbeatPoint(row: Row): HeartbeatPoint {
  return {
    at: dateOf(row, 'at'),
    uptimeSeconds: numberOrNull(row, 'uptime_seconds'),
    load1: numberOrNull(row, 'load1'),
    memUsedPercent: numberOrNull(row, 'mem_used_percent'),
    diskPercent: numberOrNull(row, 'disk_percent'),
    slots: numberOrNull(row, 'slots'),
    busySlots: numberOrNull(row, 'busy_slots'),
    ...(row['telemetry'] === null || row['telemetry'] === undefined
      ? {}
      : { telemetry: telemetryOrNull(row, 'telemetry') }),
  };
}

export function toEventRow(row: Row): EventRow {
  return {
    id: numberOf(row, 'id'),
    at: dateOf(row, 'at'),
    nodeId: textOrNull(row, 'node_id'),
    nodeLabel: textOrNull(row, 'node_label'),
    kind: text(row, 'kind'),
    severity: oneOf(row, 'severity', SEVERITIES),
    message: text(row, 'message'),
    data: jsonObject(row, 'data'),
  };
}

export function toSettingsRow(row: Row): SettingsRow {
  return {
    scope: text(row, 'scope'),
    value: jsonObject(row, 'value'),
    updatedAt: dateOf(row, 'updated_at'),
    updatedBy: textOrNull(row, 'updated_by'),
  };
}

export function toSettingsHistoryRow(row: Row): SettingsHistoryRow {
  return {
    id: numberOf(row, 'id'),
    scope: text(row, 'scope'),
    value: jsonObject(row, 'value'),
    changedAt: dateOf(row, 'changed_at'),
    changedBy: textOrNull(row, 'changed_by'),
  };
}

export function telemetryOrNull(row: Row, key: string): Telemetry | null {
  const sample = telemetryOf(row[key]);
  return sample ? compactTelemetry(sample) : null;
}
