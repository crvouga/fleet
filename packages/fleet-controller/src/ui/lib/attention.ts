import { formatDuration, formatPercent, pluralize } from './format';
import type { FleetEntry } from './fleet-data';

export type AttentionLevel = 'error' | 'warn' | 'info';
export type AttentionCode =
  | 'offline'
  | 'stale'
  | 'rollback'
  | 'units'
  | 'disk'
  | 'pending'
  | 'readiness'
  | 'update';

export interface AttentionItem {
  readonly entry: FleetEntry;
  readonly level: AttentionLevel;
  readonly code: AttentionCode;
  readonly message: string;
}

const LEVEL_ORDER: Record<AttentionLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
};
const MAX_UNITS_SHOWN = 3;

function item(
  entry: FleetEntry,
  level: AttentionLevel,
  code: AttentionCode,
  message: string
): AttentionItem {
  return { entry, level, code, message };
}

function connectivity(entry: FleetEntry): AttentionItem | null {
  const { view } = entry;
  const since =
    view.ageSeconds === null
      ? 'it has never reported'
      : `silent for ${formatDuration(view.ageSeconds)}`;
  if (view.status === 'offline')
    return item(entry, 'error', 'offline', `Offline: ${since}`);
  if (view.status === 'stale')
    return item(entry, 'warn', 'stale', `Missed check-ins: ${since}`);
  return null;
}

function updateProblems(entry: FleetEntry): AttentionItem[] {
  const { facts } = entry;
  const found: AttentionItem[] = [];
  for (const issue of facts.readinessIssues ?? []) {
    found.push(item(entry, 'error', 'readiness', issue));
  }
  if (facts.rolledBack) {
    const why = facts.healthFailure === null ? '' : `: ${facts.healthFailure}`;
    found.push(
      item(
        entry,
        'error',
        'rollback',
        `Rolled back to the previous system${why}`
      )
    );
  }
  if (facts.healthFailure && !facts.rolledBack) {
    found.push(
      item(
        entry,
        'error',
        'update',
        `Automatic update failed: ${facts.healthFailure}`
      )
    );
  }
  return found;
}

function problems(entry: FleetEntry): AttentionItem[] {
  const { facts } = entry;
  const found = updateProblems(entry);
  if (facts.failedUnits.length > 0) {
    const shown = facts.failedUnits.slice(0, MAX_UNITS_SHOWN).join(', ');
    const more = facts.failedUnits.length - MAX_UNITS_SHOWN;
    const tail = more > 0 ? ` and ${more} more` : '';
    found.push(
      item(
        entry,
        'error',
        'units',
        `${pluralize(facts.failedUnits.length, 'failed unit')}: ${shown}${tail}`
      )
    );
  }
  const disk = Math.max(facts.nixUsedPercent ?? 0, facts.bootUsedPercent ?? 0);
  if (disk >= entry.diskAlertPercent) {
    found.push(
      item(
        entry,
        'warn',
        'disk',
        `Disk ${formatPercent(disk)} full (alert at ${entry.diskAlertPercent}%)`
      )
    );
  }
  return found;
}

/** What is wrong with one node, most severe first. */
export function attentionFor(entry: FleetEntry): AttentionItem[] {
  const { status } = entry.view;
  if (status === 'pending')
    return [item(entry, 'info', 'pending', 'Waiting for approval')];
  if (status === 'rejected' || status === 'retired') return [];
  const down = connectivity(entry);
  // An offline node's last report is history; do not pile alarms on top of "offline".
  if (down?.code === 'offline') return [down];
  return [...(down === null ? [] : [down]), ...problems(entry)];
}

export function attentionList(entries: readonly FleetEntry[]): AttentionItem[] {
  return entries
    .flatMap(attentionFor)
    .sort(
      (a, b) =>
        LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
        a.entry.view.label.localeCompare(b.entry.view.label)
    );
}

export interface Health {
  readonly level: 'ok' | AttentionLevel;
  /** Distinct nodes with an error or warning. */
  readonly needAttention: number;
  readonly active: number;
}

export function fleetHealth(
  items: readonly AttentionItem[],
  entries: readonly FleetEntry[]
): Health {
  const flagged = new Set(
    items.filter((i) => i.level !== 'info').map((i) => i.entry.view.id)
  );
  const hasError = items.some((i) => i.level === 'error');
  const active = entries.filter((e) => e.view.approval === 'approved').length;
  return {
    level: hasError ? 'error' : flagged.size > 0 ? 'warn' : 'ok',
    needAttention: flagged.size,
    active,
  };
}
