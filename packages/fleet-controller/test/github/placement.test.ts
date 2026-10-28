import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { DEFAULT_POLICY } from '../../src/github/policy';
import { planPlacement, type PlacementNode } from '../../src/github/placement';
import { runGithubSync } from '../../src/github/sync';
import { desiredFor } from '../../src/domain/desired-state';
import { loadConfig } from '../../src/routes/node-config';
import { heartbeatBody, nodeIdOf } from '../support/fixtures';

import { createGithubHarness, type GithubHarness } from './testing/harness';

const node = (n: number, over: Partial<PlacementNode> = {}): PlacementNode => ({
  id: nodeIdOf(n),
  capabilities: [],
  slots: 16,
  ...over,
});
const repos = ['acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e', 'acme/f'];

describe('planPlacement', () => {
  test('is deterministic and independent of input order', () => {
    const nodes = [1, 2, 3, 4].map((n) => node(n));
    const one = planPlacement(repos, DEFAULT_POLICY, nodes);
    const two = planPlacement(
      [...repos].reverse(),
      DEFAULT_POLICY,
      [...nodes].reverse()
    );
    expect(Object.fromEntries(one.byNode)).toEqual(
      Object.fromEntries(two.byNode)
    );
  });

  test('puts different repositories first on different nodes', () => {
    const nodes = [1, 2, 3, 4, 5, 6].map((n) => node(n));
    const plan = planPlacement(repos, DEFAULT_POLICY, nodes);
    const firsts = new Set([...plan.byNode.values()].map((list) => list[0]));
    expect(firsts.size).toBeGreaterThan(2);
    for (const list of plan.byNode.values())
      expect(list).toHaveLength(repos.length);
  });

  test('maxNodesPerRepository spreads each repository over that many nodes', () => {
    const nodes = [1, 2, 3, 4, 5, 6].map((n) => node(n));
    const plan = planPlacement(
      repos,
      { ...DEFAULT_POLICY, maxNodesPerRepository: 2 },
      nodes
    );
    for (const repository of repos) {
      const hosts = [...plan.byNode].filter(([, list]) =>
        list.includes(repository)
      );
      expect(hosts).toHaveLength(2);
    }
  });

  test('removing one node moves only the repositories that node served', () => {
    const policy = { ...DEFAULT_POLICY, maxNodesPerRepository: 1 };
    const nodes = [1, 2, 3, 4, 5].map((n) => node(n));
    const before = planPlacement(repos, policy, nodes);
    const after = planPlacement(
      repos,
      policy,
      nodes.filter((n) => n.id !== nodeIdOf(3))
    );
    for (const other of [1, 2, 4, 5]) {
      const kept = before.byNode.get(nodeIdOf(other)) ?? [];
      const now = after.byNode.get(nodeIdOf(other)) ?? [];
      for (const repository of kept) expect(now).toContain(repository);
    }
  });

  test('a repository that needs gpu goes only to gpu nodes, and is unplaced without one', () => {
    const policy = {
      ...DEFAULT_POLICY,
      repositoryRequirements: { 'acme/a': ['gpu'] },
    };
    const withGpu = planPlacement(repos, policy, [
      node(1),
      node(2, { capabilities: ['gpu'] }),
    ]);
    expect(withGpu.byNode.get(nodeIdOf(1))).not.toContain('acme/a');
    expect(withGpu.byNode.get(nodeIdOf(2))).toContain('acme/a');
    const without = planPlacement(repos, policy, [node(1)]);
    expect(without.unplaced).toEqual(['acme/a']);
  });

  test('never assigns a node more repositories than it has slots', () => {
    const plan = planPlacement(repos, DEFAULT_POLICY, [
      node(1, { slots: 2 }),
      node(2, { slots: 2 }),
    ]);
    for (const list of plan.byNode.values()) expect(list.length).toBe(2);
    expect(plan.unplaced).toHaveLength(2);
  });

  test('under capacity pressure repositories share the slots instead of the first ones taking all', () => {
    const nodes = [1, 2, 3].map((n) => node(n, { slots: 2 }));
    const plan = planPlacement(repos, DEFAULT_POLICY, nodes);
    const covered = new Set([...plan.byNode.values()].flat());
    expect(covered.size).toBe(6);
    expect(plan.unplaced).toEqual([]);
  });

  test('no eligible node means every repository is unplaced', () => {
    expect(planPlacement(repos, DEFAULT_POLICY, []).unplaced).toHaveLength(
      repos.length
    );
  });
});

describe('the integration as the fleet default for runner settings', () => {
  let h: GithubHarness;
  beforeAll(async () => {
    h = await createGithubHarness();
    for (const n of [1, 2, 3]) await h.addNode(n, { slots: 8 });
    await h.addNode(4, { role: 'devbox' });
  });
  afterAll(() => h.close());

  const effective = async (n: number) => {
    const row = (await h.store.findNode(nodeIdOf(n)))!;
    return { row, config: await loadConfig(h.deps.store, row) };
  };

  test('changes nothing while the integration names no repository or label', async () => {
    for (const n of [1, 2, 3, 4]) {
      const { row, config } = await effective(n);
      const plain = await loadConfig(h.store, row);
      expect(config).toEqual(plain);
      expect(desiredFor(row, config).revision).toBe(
        desiredFor(row, plain).revision
      );
    }
  });

  test('gives every CI node repositories and labels, spread across the nodes', async () => {
    await h.configure({
      repositories: ['acme/app', 'acme/api', 'acme/web'],
      policy: { extraLabels: ['team-a'], maxNodesPerRepository: 2 },
    });
    const configs = await Promise.all([1, 2, 3].map((n) => effective(n)));
    const placed = configs.flatMap((c) => c.config.runners?.repositories ?? []);
    expect(placed.sort()).toEqual([
      'acme/api',
      'acme/api',
      'acme/app',
      'acme/app',
      'acme/web',
      'acme/web',
    ]);
    for (const { config } of configs)
      expect(config.runners?.extraLabels).toEqual(['team-a']);
    const devbox = await effective(4);
    expect(devbox.config.runners).toBeUndefined();
    const heartbeat = await h.asNode(
      1,
      'POST',
      '/v1/heartbeat',
      heartbeatBody(1)
    );
    expect(heartbeat.body.desired.values.runners.repositories).toEqual(
      configs[0]?.config.runners?.repositories
    );
  });

  test('the desired revision is stable between identical calls and changes with the placement', async () => {
    const first = desiredFor(...(await asArgs(1)));
    const second = desiredFor(...(await asArgs(1)));
    expect(second.revision).toBe(first.revision);
    await h.configure({
      repositories: ['acme/app'],
      policy: { extraLabels: ['team-a'] },
    });
    const third = desiredFor(...(await asArgs(1)));
    expect(third.revision).not.toBe(first.revision);
  });

  async function asArgs(n: number) {
    const { row, config } = await effective(n);
    return [row, config] as const;
  }

  test('a fleet, role or node setting for the same key wins over the default', async () => {
    await h.configure({
      repositories: ['acme/app', 'acme/api'],
      policy: { extraLabels: ['team-a'] },
    });
    await h.putSettings('fleet', {
      runners: { repositories: ['other/pinned'] },
    });
    const fleet = await effective(1);
    expect(fleet.config.runners?.repositories).toEqual(['other/pinned']);
    expect(fleet.config.runners?.extraLabels).toEqual(['team-a']);
    await h.putSettings('node:' + nodeIdOf(1), {
      runners: { extraLabels: ['mine'] },
    });
    expect((await effective(1)).config.runners?.extraLabels).toEqual(['mine']);
    await h.putSettings('fleet', {});
    await h.putSettings('node:' + nodeIdOf(1), {});
  });

  test('a cordoned node gets no repositories and the rest absorb its share', async () => {
    await h.configure({
      repositories: ['acme/app'],
      policy: { maxNodesPerRepository: 1 },
    });
    const holders = async () =>
      (await Promise.all([1, 2, 3].map((n) => effective(n)))).filter(
        (c) => (c.config.runners?.repositories ?? []).length > 0
      );
    const [holder] = await holders();
    await h.putSettings('node:' + holder!.row.id, {
      runners: { cordoned: true },
    });
    const after = await holders();
    expect(after).toHaveLength(1);
    expect(after[0]?.row.id).not.toBe(holder?.row.id);
    await h.putSettings('node:' + holder!.row.id, {});
  });

  test('records each placement decision once, as an event and an audit entry', async () => {
    await h.configure({ repositories: ['acme/app', 'acme/api'] });
    h.fake.runners.set('acme/app', []);
    h.fake.runners.set('acme/api', []);
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    const placements = async () =>
      (await h.store.listEvents({ limit: 100 })).filter(
        (e) => e.kind === 'placement'
      );
    const first = await placements();
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.every((e) => e.message.includes('acme/'))).toBe(true);
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    expect((await placements()).length).toBe(first.length);
    const audit = await h.store.listAudit({ limit: 100, targetKind: 'node' });
    expect(audit.filter((a) => a.action === 'runner.placement').length).toBe(
      first.length
    );
    await h.configure({ repositories: ['acme/app'] });
    h.clock.advance(61);
    await runGithubSync(h.github, h.deps.store);
    expect((await placements()).length).toBeGreaterThan(first.length);
  });

  test('is invisible to the settings API but listed with its source', async () => {
    const stored = await h.admin('GET', '/v1/settings/fleet');
    expect(stored.body.value).toEqual({});
    const view = await h.admin('GET', '/v1/runners');
    expect(
      view.body.placements.map((p: { label: string }) => p.label)
    ).toHaveLength(3);
    expect(
      view.body.placements.every((p: { eligible: boolean }) => p.eligible)
    ).toBe(true);
  });
});
