import type { EventRow, Severity } from '../types';

/**
 * Incidents are derived, never stored: a pure function of the event stream.
 * An opening event starts an incident for (node, rule, subject); the matching
 * closing event ends it. A repeated opening event while one is open only
 * escalates its severity, and a closing event with nothing open is ignored, so
 * deriving the same events again (or after a retried duplicate) gives the same
 * answer and incidents of one kind never overlap on one node.
 */
export type IncidentRuleId =
  | 'offline'
  | 'units'
  | 'disk'
  | 'rollback'
  | 'reconcile'
  | 'disk_health'
  | 'gpu_hot'
  | 'throttling'
  | 'memory_pressure'
  | 'runner_queue'
  | 'runners_offline'
  | 'runner_registration';

interface Rule {
  readonly id: IncidentRuleId;
  readonly title: string;
  readonly open: string;
  readonly close: string;
  /** Events may carry no node: the incident is about the whole fleet (runners, queue). */
  readonly fleet?: boolean;
}

export const INCIDENT_RULES: readonly Rule[] = [
  { id: 'offline', title: 'Node offline', open: 'offline', close: 'recovered' },
  {
    id: 'units',
    title: 'Failed services',
    open: 'units_failed',
    close: 'units_recovered',
  },
  {
    id: 'disk',
    title: 'Disk nearly full',
    open: 'disk_high',
    close: 'disk_ok',
  },
  {
    id: 'rollback',
    title: 'Rolled back',
    open: 'rollback',
    close: 'rollback_cleared',
  },
  {
    id: 'reconcile',
    title: 'Cannot converge',
    open: 'reconcile_blocked',
    close: 'role_converged',
  },
  {
    id: 'disk_health',
    title: 'Disk health degraded',
    open: 'disk_health_degraded',
    close: 'disk_health_ok',
  },
  { id: 'gpu_hot', title: 'GPU too hot', open: 'gpu_hot', close: 'gpu_ok' },
  {
    id: 'throttling',
    title: 'CPU throttling',
    open: 'throttling',
    close: 'throttling_ok',
  },
  {
    id: 'memory_pressure',
    title: 'Memory pressure',
    open: 'memory_pressure_high',
    close: 'memory_pressure_ok',
  },
  {
    id: 'runner_queue',
    title: 'CI job queue stalled',
    open: 'runner_queue_stalled',
    close: 'runner_queue_ok',
    fleet: true,
  },
  {
    id: 'runners_offline',
    title: 'No CI runners online',
    open: 'runners_offline',
    close: 'runners_ok',
    fleet: true,
  },
  {
    id: 'runner_registration',
    title: 'Runner registration failing',
    open: 'runner_registration_failing',
    close: 'runner_registration_ok',
  },
];

/** Every event kind that can open or close an incident, for narrowing a store query. */
export const INCIDENT_EVENT_KINDS: readonly string[] = INCIDENT_RULES.flatMap(
  (rule) => [rule.open, rule.close]
);

export interface Incident {
  /** Stable: node, rule, subject and the opening event. */
  readonly id: string;
  /** Null for a fleet-wide incident (queue stalled, no runners online). */
  readonly nodeId: string | null;
  readonly nodeLabel: string | null;
  readonly rule: IncidentRuleId;
  readonly title: string;
  /** What the rule distinguishes on one node, such as a mount point. */
  readonly subject: string | null;
  readonly severity: Severity;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  /** Seconds from start to end, or to `now` while the incident is open. */
  readonly durationSeconds: number;
  readonly open: boolean;
  readonly openEventId: number;
  readonly closeEventId: number | null;
  readonly message: string;
  /** Agent C's report form, pre-filled from the opening event. */
  readonly reportHref: string;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warn: 1, error: 2 };
/** Placeholder for failed units recorded before events carried unit names. */
const LEGACY_UNITS = '*';

interface Live {
  readonly rule: Rule;
  readonly nodeId: string | null;
  readonly subject: string;
  readonly units: Set<string>;
  nodeLabel: string | null;
  severity: Severity;
  message: string;
  readonly opener: EventRow;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : null;
}

/** The mount an event is about: its data, else the first word of older messages. */
function mountOf(event: EventRow): string {
  const mount = event.data['mount'];
  if (typeof mount === 'string') return mount;
  const first = event.message.split(' ')[0] ?? '';
  return first.startsWith('/') ? first : '';
}

function subjectOf(rule: Rule, event: EventRow): string {
  return rule.id === 'disk' ? mountOf(event) : '';
}

function begin(rule: Rule, event: EventRow, nodeId: string | null): Live {
  const units = new Set<string>();
  if (rule.id === 'units')
    for (const unit of strings(event.data['units']) ?? [LEGACY_UNITS])
      units.add(unit);
  return {
    rule,
    nodeId,
    subject: subjectOf(rule, event),
    units,
    nodeLabel: event.nodeLabel,
    severity: event.severity,
    message: event.message,
    opener: event,
  };
}

function escalate(live: Live, event: EventRow): void {
  if (SEVERITY_RANK[event.severity] > SEVERITY_RANK[live.severity]) {
    live.severity = event.severity;
    live.message = event.message;
  }
  if (live.rule.id === 'units')
    for (const unit of strings(event.data['units']) ?? []) live.units.add(unit);
  live.nodeLabel = event.nodeLabel ?? live.nodeLabel;
}

/** True when this closing event ends the incident (a failed-service set closes when empty). */
function closes(live: Live, event: EventRow): boolean {
  if (live.rule.id !== 'units') return true;
  const cleared = strings(event.data['units']);
  live.units.delete(LEGACY_UNITS);
  if (cleared === null) return true;
  for (const unit of cleared) live.units.delete(unit);
  return live.units.size === 0;
}

function finish(live: Live, close: EventRow | null, now: Date): Incident {
  const { opener, rule } = live;
  const end = close?.at ?? null;
  const seconds = Math.max(
    0,
    Math.round(((end ?? now).getTime() - opener.at.getTime()) / 1000)
  );
  return {
    id: `${live.nodeId ?? 'fleet'}:${rule.id}:${live.subject}:${opener.id}`,
    nodeId: live.nodeId,
    nodeLabel: live.nodeLabel,
    rule: rule.id,
    title: rule.title,
    subject: live.subject === '' ? null : live.subject,
    severity: live.severity,
    startedAt: opener.at,
    endedAt: end,
    durationSeconds: seconds,
    open: close === null,
    openEventId: opener.id,
    closeEventId: close?.id ?? null,
    message: live.message,
    reportHref: `/report-issue?kind=${live.nodeId === null ? 'workload' : 'node'}&event=${opener.id}`,
  };
}

function ordered(events: readonly EventRow[]): EventRow[] {
  const byId = new Map<number, EventRow>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id
  );
}

/**
 * Open/close pairs from events, newest first. `now` only measures the duration
 * of incidents still open.
 */
export function deriveIncidents(
  events: readonly EventRow[],
  now: Date
): Incident[] {
  const opens = new Map(INCIDENT_RULES.map((rule) => [rule.open, rule]));
  const closers = new Map(INCIDENT_RULES.map((rule) => [rule.close, rule]));
  const live = new Map<string, Live>();
  const done: Incident[] = [];
  for (const event of ordered(events)) {
    const opening = opens.get(event.kind);
    const rule = opening ?? closers.get(event.kind);
    if (rule === undefined || !aboutAnIncident(rule, event)) continue;
    const key = `${event.nodeId ?? ''}\u0000${rule.id}\u0000${subjectOf(rule, event)}`;
    const current = live.get(key);
    if (opening !== undefined) {
      if (current === undefined)
        live.set(key, begin(opening, event, event.nodeId));
      else escalate(current, event);
    } else if (current !== undefined && closes(current, event)) {
      live.delete(key);
      done.push(finish(current, event, now));
    }
  }
  const open = [...live.values()].map((item) => finish(item, null, now));
  return [...done, ...open].sort((a, b) => b.openEventId - a.openEventId);
}

/** A node event, or a fleet-wide one for the rules that have no node. */
function aboutAnIncident(rule: Rule, event: EventRow): boolean {
  return event.nodeId !== null || rule.fleet === true;
}

export interface IncidentFilter {
  readonly open?: boolean;
  readonly nodeId?: string;
  /** Only incidents whose opening event id is below this, for paging. */
  readonly before?: number;
  readonly limit: number;
}

export function filterIncidents(
  incidents: readonly Incident[],
  filter: IncidentFilter
): { readonly incidents: Incident[]; readonly nextBefore: number | null } {
  const matching = incidents.filter(
    (incident) =>
      (filter.open === undefined || incident.open === filter.open) &&
      (filter.nodeId === undefined || incident.nodeId === filter.nodeId) &&
      (filter.before === undefined || incident.openEventId < filter.before)
  );
  const shown = matching.slice(0, filter.limit);
  const last = shown.at(-1);
  return {
    incidents: shown,
    nextBefore:
      matching.length > filter.limit && last !== undefined
        ? last.openEventId
        : null,
  };
}

export interface IncidentSummary {
  readonly open: number;
  readonly total: number;
  readonly openBySeverity: Readonly<Record<Severity, number>>;
}

export function summarizeIncidents(
  incidents: readonly Incident[]
): IncidentSummary {
  const openBySeverity: Record<Severity, number> = {
    info: 0,
    warn: 0,
    error: 0,
  };
  for (const incident of incidents)
    if (incident.open) openBySeverity[incident.severity] += 1;
  return {
    open: incidents.filter((incident) => incident.open).length,
    total: incidents.length,
    openBySeverity,
  };
}
