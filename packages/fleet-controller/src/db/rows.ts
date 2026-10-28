import type {
  Approval,
  Capability,
  EnrolledVia,
  EventRow,
  HeartbeatPoint,
  NodeRow,
  ReconcilePhase,
  ReconcileReport,
  Severity,
  SettingsHistoryRow,
  SettingsRow,
} from '../types';
import { isCapability, isObservedRole, isRole } from '../types';
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
const ENROLLED: readonly EnrolledVia[] = [
  'enrollment-token',
  'hello',
  'dashboard',
];
const PHASES: readonly ReconcilePhase[] = [
  'converged',
  'progressing',
  'blocked',
];

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

/** Finite SQLite numeric columns. */
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
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : bad(key, 'a timestamp');
}

export function dateOrNull(row: Row, key: string): Date | null {
  return row[key] === null || row[key] === undefined ? null : dateOf(row, key);
}

export function textList(row: Row, key: string): string[] {
  const raw = row[key];
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(value)) return bad(key, 'a JSON string array');
  return value.map((item) =>
    typeof item === 'string' ? item : bad(key, 'a JSON string array')
  );
}

export function jsonObject(row: Row, key: string): Record<string, unknown> {
  const raw = row[key];
  const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return bad(key, 'a JSON object');
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

function jsonOrNull(row: Row, key: string): Record<string, unknown> | null {
  return row[key] === null || row[key] === undefined
    ? null
    : jsonObject(row, key);
}

function assignedRole(row: Row): NodeRow['role'] {
  const role = textOrNull(row, 'role');
  if (role !== null && !isRole(role)) bad('role', 'a known role');
  return role as NodeRow['role'];
}

function observedRole(row: Row): NodeRow['observedRole'] {
  const role = textOrNull(row, 'observed_role');
  if (role !== null && !isObservedRole(role))
    bad('observed_role', 'a known role');
  return role as NodeRow['observedRole'];
}

/** Stored as validated; unknown capabilities are dropped, never an error. */
function hardwareOf(row: Row): NodeRow['hardware'] {
  const raw = jsonOrNull(row, 'hardware');
  if (raw === null) return null;
  const list = Array.isArray(raw['capabilities']) ? raw['capabilities'] : [];
  return {
    capabilities: list.filter((item): item is Capability =>
      isCapability(item)
    ),
  };
}

function reconcileOf(row: Row): ReconcileReport | null {
  const raw = jsonOrNull(row, 'reconcile');
  if (raw === null) return null;
  const phase = raw['phase'];
  if (!PHASES.includes(phase as ReconcilePhase))
    return bad('reconcile', 'a reconcile report');
  const issues = Array.isArray(raw['issues']) ? raw['issues'] : [];
  return {
    phase: phase as ReconcilePhase,
    issues: issues.filter((item): item is string => typeof item === 'string'),
  };
}

export function toNodeRow(row: Row): NodeRow {
  return {
    id: text(row, 'id'),
    role: assignedRole(row),
    observedRole: observedRole(row),
    observedClosure: textOrNull(row, 'observed_closure'),
    ageRecipient: textOrNull(row, 'age_recipient'),
    hardware: hardwareOf(row),
    reconcile: reconcileOf(row),
    hostname: text(row, 'hostname'),
    approval: oneOf(row, 'approval', APPROVALS),
    displayName: textOrNull(row, 'display_name'),
    note: textOrNull(row, 'note'),
    labels: textList(row, 'labels'),
    facts: jsonObject(row, 'facts'),
    revision: textOrNull(row, 'revision'),
    agentVersion: textOrNull(row, 'agent_version'),
    appliedRevision: textOrNull(row, 'applied_revision'),
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
  const raw = row[key];
  const sample = telemetryOf(typeof raw === 'string' ? JSON.parse(raw) : raw);
  return sample ? compactTelemetry(sample) : null;
}
