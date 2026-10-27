/**
 * How a node is recovering, from what it reports (`facts.recovery`, written by
 * packages/fleet/scripts/recovery.py) and its recent recovery events. Pure: the
 * node page renders it and tests check it without a database.
 *
 * Every line says what is known and nothing more. A node does not know why it
 * lost power, and an interrupted CI job is never re-run for anyone: whether
 * repeating it is safe is a person's call.
 */
import type { EventRow } from '../types';

export type RecoveryTone = 'ok' | 'warn' | 'error' | 'muted';
export type RecoveryAction = 'retry-update' | 'reopen-admission';

export interface RecoveryItem {
  readonly label: string;
  readonly detail: string;
  readonly tone: RecoveryTone;
  /** An operation a person may take from the node page. */
  readonly action?: RecoveryAction;
  readonly link?: string;
}

export interface RecoveryView {
  /** attention: a person should look; recovered: something happened and was handled. */
  readonly state: 'ok' | 'recovered' | 'attention' | 'unknown';
  readonly summary: string;
  readonly items: readonly RecoveryItem[];
}

/** Events a node reports about its own recovery (PROTOCOL.md). */
export const RECOVERY_KINDS = [
  'unclean-shutdown',
  'job-interrupted',
  'update-quarantined',
  'update-retry',
  'gate-reopened',
  'rollback',
  'update-failed',
] as const;

const RECENT_MS = 7 * 86400_000;

const REASONS: Readonly<Record<string, string>> = {
  update: 'an update is draining the node before it reboots',
  'low-disk':
    'free disk space is below the minimum; it reopens by itself once the cache cleanup frees space',
  config: 'runners are cordoned or disabled in Fleet settings',
  manual: 'someone drained it by hand on the node',
  unknown: 'the reason was not recorded',
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function bootItem(boot: Record<string, unknown>): RecoveryItem {
  const ratio = Array.isArray(boot['uncleanOfLast'])
    ? (boot['uncleanOfLast'] as unknown[])
    : [];
  const unclean = count(ratio[0]);
  const history =
    unclean > 0
      ? ` ${unclean} of the last ${count(ratio[1])} boots ended without a clean shutdown.`
      : '';
  if (boot['previousClean'] === true)
    return {
      label: 'Last shutdown',
      detail: `Clean.${history}`,
      tone: unclean > 0 ? 'warn' : 'ok',
    };
  if (boot['previousClean'] === false)
    return {
      label: 'Last shutdown',
      detail:
        'Not clean: power loss, a hard reset, a kernel panic or a watchdog reset. The node cannot tell which unless the kernel kept a crash record (see the unclean-shutdown event).' +
        history,
      tone: 'warn',
    };
  return {
    label: 'Last shutdown',
    detail: 'No earlier boot is recorded on this node yet.',
    tone: 'muted',
  };
}

function kernelItem(quarantine: unknown): RecoveryItem {
  if (quarantine === null || quarantine === undefined)
    return {
      label: 'Kernel update',
      detail: 'No quarantined kernel.',
      tone: 'ok',
    };
  const kernel = record(quarantine);
  const revision = text(kernel['revision']);
  return {
    label: 'Kernel update',
    detail: `Quarantined since ${text(kernel['at']) ?? 'an unknown time'}${
      revision ? ` (revision ${revision.slice(0, 8)})` : ''
    }. The node fell back to its previous kernel and keeps working on it; it will not reboot into this one again until a newer kernel is published or the update is retried. ${text(kernel['reason']) ?? ''}`.trim(),
    tone: 'error',
    action: 'retry-update',
  };
}

function admissionItem(gate: Record<string, unknown>): RecoveryItem {
  if (gate['closed'] !== true)
    return { label: 'Runner admission', detail: 'Open.', tone: 'ok' };
  const reasons = Array.isArray(gate['reasons'])
    ? (gate['reasons'] as unknown[]).filter(
        (item): item is string => typeof item === 'string'
      )
    : [];
  const why =
    reasons.length > 0
      ? `Held because ${reasons.map((reason) => REASONS[reason] ?? reason).join('; and because ')}.`
      : 'No reason is recorded; the node reopens admission by itself on its next report.';
  return {
    label: 'Runner admission',
    detail: `Closed: new jobs are not accepted; running jobs finish. ${why}`,
    tone: 'warn',
    ...(reasons.includes('manual')
      ? { action: 'reopen-admission' as const }
      : {}),
  };
}

function jobItems(recent: readonly EventRow[]): RecoveryItem[] {
  const jobs = recent.filter((event) => event.kind === 'job-interrupted');
  const items: RecoveryItem[] = jobs.slice(0, 5).map((job) => {
    const url = text(record(job.data)['url']);
    return {
      label: 'Interrupted job',
      detail: job.message,
      tone: 'warn',
      ...(url && url.startsWith('https://github.com/') ? { link: url } : {}),
    };
  });
  if (jobs.length > 5)
    items.push({
      label: 'Interrupted jobs',
      detail: `${jobs.length - 5} more in the last 7 days; see the timeline.`,
      tone: 'warn',
    });
  return items;
}

function outboxItems(outbox: number): RecoveryItem[] {
  if (outbox <= 0) return [];
  const one = outbox === 1;
  return [
    {
      label: 'Undelivered events',
      detail: `${outbox} recovery event${one ? '' : 's'} recorded on the node ${one ? 'has' : 'have'} not reached Fleet yet. They are kept on disk and sent with the next accepted report.`,
      tone: 'warn',
    },
  ];
}

function summarize(
  items: readonly RecoveryItem[],
  recent: readonly EventRow[]
): RecoveryView {
  const attention = items.some((item) => item.tone === 'error' || item.action);
  const happened =
    recent.length > 0 || items.some((item) => item.tone === 'warn');
  if (attention)
    return {
      state: 'attention',
      summary: 'This node needs a decision: see the marked line.',
      items,
    };
  if (happened)
    return {
      state: 'recovered',
      summary:
        'This node recovered from something recently. Nothing needs a decision.',
      items,
    };
  return { state: 'ok', summary: 'Nothing to recover from.', items };
}

export function recoveryView(
  facts: Readonly<Record<string, unknown>>,
  events: readonly EventRow[],
  now: Date,
  role: string
): RecoveryView {
  const raw = facts['recovery'];
  if (raw === undefined || raw === null)
    return {
      state: 'unknown',
      summary:
        'This node’s agent does not report recovery facts yet. It needs a newer Fleet image.',
      items: [],
    };
  const recovery = record(raw);
  const recent = events.filter(
    (event) =>
      (RECOVERY_KINDS as readonly string[]).includes(event.kind) &&
      now.getTime() - event.at.getTime() <= RECENT_MS
  );
  return summarize(
    [
      bootItem(record(recovery['boot'])),
      kernelItem(recovery['quarantine']),
      ...(role === 'ci' ? [admissionItem(record(recovery['gate']))] : []),
      ...jobItems(recent),
      ...outboxItems(count(recovery['outbox'])),
    ],
    recent
  );
}
