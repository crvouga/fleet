import type { NodeEventInput, Severity } from '../types';

/** An event as stored: a node's key and its own timestamp move into data. */
export interface StoredEvent {
  readonly kind: string;
  readonly severity: Severity;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export function storedEvent(
  event: Pick<NodeEventInput, 'kind' | 'severity' | 'message'> &
    Partial<Pick<NodeEventInput, 'key' | 'at' | 'data'>>
): StoredEvent {
  return {
    kind: event.kind,
    severity: event.severity,
    message: event.message,
    data: {
      ...(event.data ?? {}),
      ...(event.key === undefined ? {} : { key: event.key }),
      ...(event.at === undefined ? {} : { occurredAt: event.at }),
    },
  };
}

/**
 * Drops events whose key this node already reported, and repeats within one
 * report. Nodes resend their outbox until a heartbeat is accepted, so a lost
 * response must not record an unclean shutdown or an interrupted job twice.
 * Events without a key (older agents, server-derived edges) always pass.
 */
export function unseen<
  T extends { readonly data: Readonly<Record<string, unknown>> },
>(events: readonly T[], seen: ReadonlySet<string>): T[] {
  const taken = new Set(seen);
  return events.filter((event) => {
    const key = event.data['key'];
    if (typeof key !== 'string') return true;
    if (taken.has(key)) return false;
    taken.add(key);
    return true;
  });
}
