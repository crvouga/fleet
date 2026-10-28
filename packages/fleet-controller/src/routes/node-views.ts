import {
  effectiveConfig,
  offlineAfterSeconds,
} from '../domain/effective-config';
import { viewOf } from '../domain/status';
import type { AppDeps } from '../deps';
import type { NodeRow, NodeView } from '../types';

/** Every node with its status, judged by the offline threshold that applies to it. */
export async function loadViews(deps: AppDeps): Promise<NodeView[]> {
  const [nodes, settings] = await Promise.all([
    deps.store.listNodes(),
    deps.store.listSettings(),
  ]);
  const now = deps.now();
  return nodes.map((node) =>
    viewOf(node, now, offlineAfterSeconds(effectiveConfig(settings, node)))
  );
}

export async function loadView(
  deps: AppDeps,
  node: NodeRow
): Promise<NodeView> {
  const settings = await deps.store.listSettings();
  return viewOf(
    node,
    deps.now(),
    offlineAfterSeconds(effectiveConfig(settings, node))
  );
}
