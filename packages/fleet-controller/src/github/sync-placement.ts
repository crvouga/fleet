import { createHash } from 'node:crypto';

import type { Store } from '../store';

import { placementFor, type PlacementView } from './runner-defaults';
import type { GithubStore } from './store';
import { SYSTEM_ACTOR } from './sync-actions';

function fingerprint(repositories: readonly string[]): string {
  return createHash('sha256')
    .update(repositories.join('\n'))
    .digest('hex')
    .slice(0, 12);
}

async function lastPlacement(
  store: Store,
  nodeId: string | null
): Promise<string | null> {
  const events = await store.listEvents({
    limit: 40,
    ...(nodeId === null ? {} : { nodeId }),
  });
  const found = events.find(
    (e) => e.kind === 'placement' && (nodeId !== null || e.nodeId === null)
  );
  const hash = found?.data['hash'];
  return typeof hash === 'string' ? hash : null;
}

async function recordNode(
  store: Store,
  view: PlacementView,
  node: PlacementView['eligible'][number]
): Promise<boolean> {
  const repositories = view.plan.byNode.get(node.id) ?? [];
  const hash = fingerprint(repositories);
  const previous = await lastPlacement(store, node.id);
  if (previous === hash || (previous === null && repositories.length === 0))
    return false;
  const label = node.displayName ?? node.hostname;
  const message =
    repositories.length === 0
      ? `${label} serves no repository`
      : `${label} serves ${repositories.join(', ')}`;
  await store.addEvent({
    nodeId: node.id,
    nodeLabel: label,
    kind: 'placement',
    severity: 'info',
    message,
    data: {
      hash,
      repositories: repositories.join(','),
      count: repositories.length,
    },
  });
  await store.audit({
    actor: SYSTEM_ACTOR,
    action: 'runner.placement',
    targetKind: 'node',
    targetId: node.id,
    detail: { hash, repositories: [...repositories] },
  });
  return true;
}

async function recordUnplaced(
  store: Store,
  view: PlacementView
): Promise<void> {
  const hash = fingerprint(view.plan.unplaced);
  const previous = await lastPlacement(store, null);
  if (
    previous === hash ||
    (previous === null && view.plan.unplaced.length === 0)
  )
    return;
  const unplaced = view.plan.unplaced;
  await store.addEvent({
    nodeId: null,
    nodeLabel: null,
    kind: 'placement',
    severity: unplaced.length === 0 ? 'info' : 'warn',
    message:
      unplaced.length === 0
        ? 'Every repository has an eligible node'
        : `No eligible node (capability or free slot) for ${unplaced.join(', ')}`,
    data: { hash, unplaced: unplaced.join(',') },
  });
}

/** One `placement` event (and audit entry) per node whose repositories changed. */
export async function recordPlacements(
  store: Store,
  github: GithubStore
): Promise<number> {
  const view = await placementFor(store, github);
  let changed = 0;
  for (const node of view.eligible) {
    if (await recordNode(store, view, node)) changed += 1;
  }
  await recordUnplaced(store, view);
  return changed;
}
