import type { Scope } from '../../../src/config/schema';
import type { Store } from '../../../src/store';

const PAGE = 500;

/** Event kinds for a node (or all events), oldest first. */
export async function eventKinds(
  store: Store,
  nodeId?: string
): Promise<string[]> {
  const rows = await store.listEvents({
    limit: PAGE,
    ...(nodeId === undefined ? {} : { nodeId }),
  });
  return rows.map((row) => row.kind).reverse();
}

export const countOf = (items: readonly string[], kind: string): number =>
  items.filter((item) => item === kind).length;

/**
 * Everything durable the controller knows, in a comparable shape. Two
 * snapshots taken before and after a restart must be equal.
 */
export async function snapshot(store: Store): Promise<unknown> {
  const settings = await store.listSettings();
  const histories = await Promise.all(
    settings.map((row) => store.settingsHistory(row.scope as Scope, PAGE))
  );
  return {
    nodes: await store.listNodes(),
    events: await store.listEvents({ limit: PAGE }),
    audit: await store.listAudit({ limit: PAGE }),
    settings,
    histories,
  };
}
