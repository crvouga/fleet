import type { EventRow } from '../types';

/** Events this history is derived from. */
export const RESTART_EVENT_KINDS: readonly string[] = [
  'boot',
  'unclean-shutdown',
];

const MAX_BOOTS = 20;
const DAY_MS = 24 * 3600 * 1000;

/**
 * `unclean`: the node reported an unclean-shutdown event for the boot before.
 * `clean`: no such event was reported (the agent reports one whenever it finds
 * the previous boot ended without a clean shutdown; an agent too old to do so
 * looks clean here). `unknown`: the oldest retained boot has no predecessor.
 */
export type PreviousShutdown = 'clean' | 'unclean' | 'unknown';

export interface BootRecord {
  readonly eventId: number;
  readonly bootId: string | null;
  readonly startedAt: Date;
  readonly previousShutdown: PreviousShutdown;
}

export interface RestartHistory {
  /** Newest first, at most 20. */
  readonly boots: readonly BootRecord[];
  /** Boots that followed another retained boot: the oldest one is where observation began. */
  readonly restarts: number;
  readonly uncleanShutdowns: number;
  readonly restartsLast24h: number;
  readonly restartsLast7d: number;
  readonly current: {
    readonly bootId: string | null;
    readonly uptimeSeconds: number | null;
    /** now minus the reported uptime; null when the node reports no uptime. */
    readonly bootedAt: Date | null;
  };
}

function bootIdOf(event: EventRow): string | null {
  const key = event.data['key'];
  return typeof key === 'string' && key.startsWith('boot:')
    ? key.slice('boot:'.length)
    : null;
}

/** The node's own timestamp when valid, else when the controller stored the event. */
function startedAt(event: EventRow, now: Date): Date {
  const stated = event.data['occurredAt'];
  if (typeof stated !== 'string') return event.at;
  const at = new Date(stated);
  const time = at.getTime();
  return Number.isFinite(time) && time <= now.getTime() + 300_000
    ? at
    : event.at;
}

function uncleanBootIds(events: readonly EventRow[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const id = event.data['bootId'];
    if (event.kind === 'unclean-shutdown' && typeof id === 'string')
      ids.add(id);
  }
  return ids;
}

function ascendingBoots(events: readonly EventRow[], now: Date) {
  const seen = new Set<string>();
  return events
    .filter((event) => event.kind === 'boot')
    .sort((a, b) => a.id - b.id)
    .flatMap((event) => {
      const bootId = bootIdOf(event);
      if (bootId !== null) {
        if (seen.has(bootId)) return [];
        seen.add(bootId);
      }
      return [{ event, bootId, at: startedAt(event, now) }];
    });
}

function shutdownBefore(
  previous: { readonly bootId: string | null } | undefined,
  unclean: ReadonlySet<string>
): PreviousShutdown {
  if (previous === undefined || previous.bootId === null) return 'unknown';
  return unclean.has(previous.bootId) ? 'unclean' : 'clean';
}

/** Recent boots, uptime and clean-versus-unclean shutdowns, from boot events alone. */
export function restartHistory(
  events: readonly EventRow[],
  node: { bootId: string | null; uptimeSeconds: number | null },
  now: Date
): RestartHistory {
  const unclean = uncleanBootIds(events);
  const boots = ascendingBoots(events, now).map((boot, index, all) => ({
    eventId: boot.event.id,
    bootId: boot.bootId,
    startedAt: boot.at,
    previousShutdown: shutdownBefore(all[index - 1], unclean),
  }));
  const restarts = boots.slice(1);
  const since = (ms: number) =>
    restarts.filter((boot) => now.getTime() - boot.startedAt.getTime() <= ms)
      .length;
  return {
    boots: boots.slice(-MAX_BOOTS).reverse(),
    restarts: restarts.length,
    uncleanShutdowns: boots.filter(
      (boot) => boot.previousShutdown === 'unclean'
    ).length,
    restartsLast24h: since(DAY_MS),
    restartsLast7d: since(7 * DAY_MS),
    current: {
      bootId: node.bootId,
      uptimeSeconds: node.uptimeSeconds,
      bootedAt:
        node.uptimeSeconds === null
          ? null
          : new Date(now.getTime() - node.uptimeSeconds * 1000),
    },
  };
}
