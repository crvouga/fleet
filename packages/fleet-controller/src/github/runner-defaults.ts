import type { Scope } from '../config/schema';
import { effectiveConfig } from '../domain/effective-config';
import { readFacts } from '../ui/lib/facts';
import type { Store } from '../store';
import type { NodeRow, SettingsRow } from '../types';

import { planPlacement, type PlacementPlan } from './placement';
import type { GithubStore } from './store';
import type { Integration } from './types';

/** The role whose nodes run GitHub Actions runners. */
export const RUNNER_ROLE = 'ci';
export const PLACEMENT_PREFIX = 'placement:';

export interface PlacementView {
  readonly integration: Integration;
  readonly plan: PlacementPlan;
  /** Approved CI nodes that take repositories (not cordoned, not disabled). */
  readonly eligible: readonly NodeRow[];
  readonly runnerNodes: readonly NodeRow[];
}

function isRunnerNode(node: NodeRow): boolean {
  return node.approval === 'approved' && node.role === RUNNER_ROLE;
}

function capabilitiesOf(node: NodeRow): string[] {
  return [...(node.hardware?.capabilities ?? []), ...node.labels];
}

/**
 * Where the integration's repositories go, from the nodes and the settings that
 * are in force. Level-triggered: computed from current state on every call.
 */
export async function placementFor(
  store: Store,
  github: GithubStore
): Promise<PlacementView> {
  const [integration, nodes, rows] = await Promise.all([
    github.getIntegration(),
    store.listNodes(),
    store.listSettings(),
  ]);
  const runnerNodes = nodes.filter(isRunnerNode);
  const eligible = runnerNodes.filter((node) => {
    const runners = effectiveConfig(rows, node).runners;
    return runners?.cordoned !== true && runners?.enabled !== false;
  });
  const placed =
    integration.scope === 'repository' ? integration.repositories : [];
  const plan = planPlacement(
    placed,
    integration.policy,
    eligible.map((node) => ({
      id: node.id,
      capabilities: capabilitiesOf(node),
      slots: readFacts(node).slots,
    }))
  );
  return { integration, plan, eligible, runnerNodes };
}

function documentOf(view: PlacementView, node: NodeRow): SettingsRow | null {
  const repositories = view.plan.byNode.get(node.id) ?? [];
  const labels = view.integration.policy.extraLabels;
  const runners = {
    ...(repositories.length > 0 ? { repositories: [...repositories] } : {}),
    ...(labels.length > 0 ? { extraLabels: [...labels] } : {}),
  };
  if (Object.keys(runners).length === 0) return null;
  return {
    scope: `${PLACEMENT_PREFIX}${node.id}`,
    value: { runners },
    updatedAt: view.integration.updatedAt ?? new Date(0),
    updatedBy: 'github-integration',
    revision: 0,
  };
}

async function documents(
  store: Store,
  github: GithubStore
): Promise<SettingsRow[]> {
  const integration = await github.getIntegration();
  const nothing =
    integration.repositories.length === 0 &&
    integration.policy.extraLabels.length === 0;
  if (nothing) return [];
  const view = await placementFor(store, github);
  return view.runnerNodes
    .map((node) => documentOf(view, node))
    .filter((row): row is SettingsRow => row !== null);
}

/**
 * The store with one extra, lowest-priority layer per CI node: the GitHub
 * integration's repositories (placed across nodes) and labels. A fleet, role or
 * node setting for the same key wins, so nothing configured per machine is
 * overridden. With no integration repositories or labels it adds nothing, so
 * every desired revision stays what it was.
 */
export function withRunnerDefaults(store: Store, github: GithubStore): Store {
  const overrides: Record<string | symbol, unknown> = {
    async listSettings() {
      return [
        ...(await store.listSettings()),
        ...(await documents(store, github)),
      ];
    },
    async getSettings(scope: string) {
      if (!scope.startsWith(PLACEMENT_PREFIX))
        return store.getSettings(scope as Scope);
      const found = (await documents(store, github)).find(
        (r) => r.scope === scope
      );
      return found ?? null;
    },
  };
  return new Proxy(store, {
    get(target, property) {
      if (property in overrides) return overrides[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
