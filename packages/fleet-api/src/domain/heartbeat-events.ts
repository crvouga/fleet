import type { HeartbeatBody, NodeRow, Severity } from '../types';

/** An event the server concludes from comparing two consecutive reports. */
export interface DerivedEvent {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
}

export const DEFAULT_DISK_ALERT_PERCENT = 90;
const MAX_NAMED_UNITS = 5;
const SHORT_REVISION = 7;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function reportedKind(body: HeartbeatBody, kind: string): boolean {
  return body.events.some((event) => event.kind === kind);
}

function nameUnits(units: readonly string[]): string {
  const shown = units.slice(0, MAX_NAMED_UNITS).join(', ');
  const rest = units.length - MAX_NAMED_UNITS;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function bootEvents(prev: NodeRow, body: HeartbeatBody): DerivedEvent[] {
  const before = prev.facts['bootId'];
  if (
    typeof before !== 'string' ||
    body.bootId === null ||
    before === body.bootId
  )
    return [];
  if (reportedKind(body, 'boot')) return [];
  return [
    { kind: 'boot', severity: 'info', message: 'started again (new boot)' },
  ];
}

function revisionEvents(prev: NodeRow, body: HeartbeatBody): DerivedEvent[] {
  if (prev.revision === null || body.revision === null) return [];
  if (prev.revision === body.revision || reportedKind(body, 'revision'))
    return [];
  const from = prev.revision.slice(0, SHORT_REVISION);
  const to = body.revision.slice(0, SHORT_REVISION);
  return [
    {
      kind: 'revision',
      severity: 'info',
      message: `updated from ${from} to ${to}`,
    },
  ];
}

function rollbackEvents(prev: NodeRow, body: HeartbeatBody): DerivedEvent[] {
  const was = asRecord(prev.facts['sync'])['rolledBack'] === true;
  // The agent reports its own rollback event, with the reason; one is enough.
  if (!was && body.sync.rolledBack && !reportedKind(body, 'rollback')) {
    const why =
      body.sync.healthFailure === null ? '' : `: ${body.sync.healthFailure}`;
    return [
      {
        kind: 'rollback',
        severity: 'error',
        message: `rolled back to the previous system${why}`,
      },
    ];
  }
  if (was && !body.sync.rolledBack) {
    return [
      {
        kind: 'rollback_cleared',
        severity: 'info',
        message: 'no longer rolled back',
      },
    ];
  }
  return [];
}

function unitEvents(prev: NodeRow, body: HeartbeatBody): DerivedEvent[] {
  const before = new Set(asStrings(prev.facts['failedUnits']));
  const now = new Set(body.failedUnits);
  const appeared = [...now].filter((unit) => !before.has(unit));
  const cleared = [...before].filter((unit) => !now.has(unit));
  const out: DerivedEvent[] = [];
  if (appeared.length > 0) {
    out.push({
      kind: 'units_failed',
      severity: 'warn',
      message: `failed units: ${nameUnits(appeared)}`,
    });
  }
  if (cleared.length > 0) {
    out.push({
      kind: 'units_recovered',
      severity: 'info',
      message: `units recovered: ${nameUnits(cleared)}`,
    });
  }
  return out;
}

function diskEvent(
  mount: string,
  before: number | null,
  now: number | null,
  alertPercent: number
): DerivedEvent[] {
  const wasHigh = before !== null && before >= alertPercent;
  const isHigh = now !== null && now >= alertPercent;
  if (isHigh && !wasHigh) {
    return [
      {
        kind: 'disk_high',
        severity: 'warn',
        message: `${mount} is ${now}% full (alert at ${alertPercent}%)`,
      },
    ];
  }
  if (wasHigh && !isHigh && now !== null) {
    return [
      {
        kind: 'disk_ok',
        severity: 'info',
        message: `${mount} is down to ${now}% full`,
      },
    ];
  }
  return [];
}

function diskEvents(
  prev: NodeRow,
  body: HeartbeatBody,
  alertPercent: number
): DerivedEvent[] {
  const before = asRecord(prev.facts['disk']);
  return [
    ...diskEvent(
      '/nix',
      asNumber(before['nixUsedPercent']),
      body.disk.nixUsedPercent,
      alertPercent
    ),
    ...diskEvent(
      '/boot',
      asNumber(before['bootUsedPercent']),
      body.disk.bootUsedPercent,
      alertPercent
    ),
  ];
}

function recoveredEvents(prev: NodeRow): DerivedEvent[] {
  if (prev.offlineNotifiedAt === null) return [];
  return [
    {
      kind: 'recovered',
      severity: 'info',
      message: 'reporting again after being offline',
    },
  ];
}

/**
 * What changed between the stored report and this one. Only edges produce an
 * event, so a condition that holds across many reports is announced once.
 */
export function deriveReportEvents(
  prev: NodeRow,
  body: HeartbeatBody,
  alertPercent: number
): DerivedEvent[] {
  return [
    ...recoveredEvents(prev),
    ...bootEvents(prev, body),
    ...revisionEvents(prev, body),
    ...rollbackEvents(prev, body),
    ...unitEvents(prev, body),
    ...diskEvents(prev, body, alertPercent),
  ];
}
