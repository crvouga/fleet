import { expect, test } from 'bun:test';

import { canonicalJson, type FleetConfig } from '../../src/config/schema';
import { desiredRevision } from '../../src/domain/desired-state';
import type { Role } from '../../src/types';
import { ADMIN_TOKEN } from '../support/controller';
import type { Harness, Json } from '../support/controller';
import { nodeIdOf } from '../support/fixtures';

import { prng, type Prng } from './support/prng';
import { describeRig, type ControllerProcess } from './support/rig';
import { enrollCi, simNode, type SimNode } from './support/sim-node';

const PENDING = 3;
const NODES = [1, 2, 3];
const SCOPES = [
  'fleet',
  'role:ci',
  'role:devbox',
  ...NODES.map((n) => `node:${nodeIdOf(n)}`),
];

interface Expected {
  readonly revision: string;
  readonly closure: string | null;
  readonly values: Record<string, unknown>;
}

/** The merge, written independently of src: sections merge key by key, later scopes win, `alerts` stays home. */
function merged(documents: readonly FleetConfig[]): Record<string, unknown> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const document of documents) {
    for (const [section, entries] of Object.entries(document)) {
      out[section] = { ...out[section], ...(entries as object) };
    }
  }
  return out;
}

/** What the protocol says node n must be told, computed from stored settings alone. */
async function expectedFor(p: ControllerProcess, n: number): Promise<Expected> {
  const node = await p.store.findNode(nodeIdOf(n));
  if (node === null) throw new Error('missing node');
  const rows = await p.store.listSettings();
  const doc = (scope: string): FleetConfig =>
    (rows.find((row) => row.scope === scope)?.value ?? {}) as FleetConfig;
  const layers = [doc('fleet')];
  if (node.role !== null) layers.push(doc(`role:${node.role}`));
  layers.push(doc(`node:${node.id}`));
  const { alerts: _alerts, ...values } = merged(layers);
  if (node.approval !== 'approved') {
    const interval = (
      values['heartbeat'] as { intervalSeconds?: number } | undefined
    )?.intervalSeconds;
    const pendingValues = { heartbeat: { intervalSeconds: interval ?? 60 } };
    const state = { role: null, closure: null, values: pendingValues };
    return { ...state, revision: desiredRevision(state) };
  }
  const closure = node.role ?? 'base';
  const state = { role: node.role, closure, values } as const;
  return { revision: desiredRevision(state), closure, values };
}

function expectedConvergence(view: Json, want: Expected): string {
  if (view.observedClosure === null) return 'unknown';
  const phase = view.reconcile?.phase ?? null;
  const closureOk =
    want.closure === null || view.observedClosure === want.closure;
  if (
    closureOk &&
    view.appliedRevision === want.revision &&
    phase === 'converged'
  )
    return 'converged';
  return phase === 'blocked' ? 'blocked' : 'progressing';
}

/** The invariants that must hold after every single step. */
async function checkInvariants(
  p: ControllerProcess,
  label: string
): Promise<void> {
  for (const n of NODES) {
    const want = await expectedFor(p, n);
    const view = (await p.h.admin('GET', `/v1/nodes/${nodeIdOf(n)}`)).body.node;
    expect([label, n, view.desiredRevision]).toEqual([label, n, want.revision]);
    if (view.approval === 'approved')
      expect([label, n, view.convergence]).toEqual([
        label,
        n,
        expectedConvergence(view, want),
      ]);
  }
}

function randomSection(rng: Prng): [string, Record<string, unknown>] {
  const options: [string, Record<string, unknown>][] = [
    ['heartbeat', { intervalSeconds: 15 + rng.int(3000) }],
    ['reboot', { enabled: rng.chance(0.9), delayMaxSeconds: rng.int(3000) }],
    ['disk', { alertPercent: 50 + rng.int(49) }],
    ['capacity', { slotMax: 2 + rng.int(60), reserveGiB: rng.int(200) }],
    [
      'runners',
      {
        enabled: rng.chance(0.9),
        repositories: rng.chance(0.5) ? ['acme/app'] : [],
      },
    ],
    ['alerts', { offlineAfterSeconds: 60 + rng.int(9000) }],
    ['sync', { retryBootAfter: rng.int(1_000_000) }],
  ];
  return rng.pick(options);
}

function randomDocument(rng: Prng): FleetConfig {
  const document: Record<string, unknown> = {};
  const count = rng.int(4);
  for (let i = 0; i < count; i += 1) {
    const [section, entries] = randomSection(rng);
    document[section] = entries;
  }
  return document as FleetConfig;
}

const INVALID: readonly unknown[] = [
  { nope: { x: 1 } },
  { disk: { alertPercent: 10 } },
  { heartbeat: { intervalSeconds: 1.5 } },
  { reboot: { enabled: 'yes' } },
  { runners: { repositories: ['not a repo'] } },
  { sync: { unknownKey: true } },
  { alerts: { webhookUrl: 'http://insecure.example' } },
  [],
  'text',
];

interface World {
  readonly p: ControllerProcess;
  readonly sims: Map<number, SimNode>;
  readonly rng: Prng;
}

async function revisionsOf(world: World): Promise<string[]> {
  return Promise.all(
    NODES.map(async (n) => (await expectedFor(world.p, n)).revision)
  );
}

async function writeSettings(world: World, label: string): Promise<void> {
  const scope = world.rng.pick(SCOPES);
  const before = (await world.p.h.admin('GET', `/v1/settings/${scope}`)).body
    .revision;
  const reply = await world.p.h.admin(
    'PUT',
    `/v1/settings/${scope}`,
    randomDocument(world.rng)
  );
  expect([label, scope, reply.status]).toEqual([label, scope, 200]);
  expect(reply.body.revision).toBe(before + 1);
}

async function writeInvalid(world: World, label: string): Promise<void> {
  const scope = world.rng.pick(SCOPES);
  const rowsBefore = canonicalJson(await world.p.store.listSettings());
  const revisions = await revisionsOf(world);
  const reply = await world.p.h.admin(
    'PUT',
    `/v1/settings/${scope}`,
    world.rng.pick(INVALID)
  );
  expect([label, reply.status]).toEqual([label, 400]);
  expect(canonicalJson(await world.p.store.listSettings())).toBe(rowsBefore);
  expect(await revisionsOf(world)).toEqual(revisions);
}

async function restoreSettings(world: World, label: string): Promise<void> {
  const { h } = world.p;
  const scope = world.rng.pick(SCOPES);
  const read = (await h.admin('GET', `/v1/settings/${scope}`)).body;
  const history: Json[] = (
    await h.admin('GET', `/v1/settings/${scope}/history`)
  ).body.history;
  if (history.length === 0) return;
  const target = world.rng.pick(history);
  const url = `/v1/settings/${scope}/restore`;
  const body = { historyId: target.id, expectedRevision: read.revision };
  const dry = await h.admin('POST', `${url}?dryRun=1`, body);
  const acknowledge: string[] = dry.body.acknowledgementRequired ?? [];
  const reply = await h.admin('POST', url, { ...body, acknowledge });
  expect([label, scope, reply.status]).toEqual([label, scope, 200]);
  expect(canonicalJson(reply.body.value)).toBe(canonicalJson(target.value));
}

async function changeRole(world: World, label: string): Promise<void> {
  const n = world.rng.pick([1, 2]);
  const role: Role | null = world.rng.pick(['ci', 'devbox', null] as const);
  const reply = await world.p.h.admin('PATCH', `/v1/nodes/${nodeIdOf(n)}`, {
    role,
  });
  expect([label, reply.status]).toEqual([label, 200]);
}

/** One heartbeat from a random node; the agent contract decides whether `desired` comes back. */
async function heartbeat(world: World, label: string): Promise<void> {
  const n = world.rng.pick(NODES);
  const sim = world.sims.get(n) as SimNode;
  const want = await expectedFor(world.p, n);
  const node = await world.p.store.findNode(nodeIdOf(n));
  if (world.rng.chance(0.4)) sim.applied = want.revision; // the node already runs it
  const reported = sim.applied;
  const phase = world.rng.pick([
    'converged',
    'progressing',
    'blocked',
  ] as const);
  const reply = await sim.beat(world.p.h, {
    role: node?.role ?? 'base',
    closure: want.closure ?? 'base',
    reconcile: { phase, issues: phase === 'blocked' ? ['cannot build'] : [] },
  });
  expect([label, reply.status]).toEqual([label, 200]);
  if (reported === want.revision) {
    expect([label, n, reply.body.desired]).toEqual([label, n, undefined]);
    return;
  }
  expect([label, n, reply.body.desired?.revision]).toEqual([
    label,
    n,
    want.revision,
  ]);
  expect(desiredRevision(reply.body.desired)).toBe(reply.body.desired.revision);
}

async function approvePending(world: World, label: string): Promise<void> {
  const node = await world.p.store.findNode(nodeIdOf(PENDING));
  if (node?.approval !== 'pending') return;
  const reply = await world.p.h.admin(
    'POST',
    `/v1/nodes/${nodeIdOf(PENDING)}/approve`,
    {
      role: world.rng.pick(['ci', 'devbox'] as const),
    }
  );
  expect([label, reply.status]).toEqual([label, 200]);
}

const STEPS: readonly [number, (w: World, label: string) => Promise<void>][] = [
  [30, heartbeat],
  [25, writeSettings],
  [10, writeInvalid],
  [10, restoreSettings],
  [8, changeRole],
  [2, approvePending],
];

async function step(world: World, label: string): Promise<void> {
  let roll = world.rng.int(STEPS.reduce((sum, [weight]) => sum + weight, 0));
  for (const [weight, run] of STEPS) {
    if (roll < weight) return run(world, label);
    roll -= weight;
  }
}

describeRig(
  'Configuration (Req 6): desired state is a pure function, whatever the interleaving',
  (rig) => {
    const SEEDS = [1, 7, 42, 2026, 31337, 90210];
    const STEP_COUNT = 70;

    test.each(SEEDS)(
      'seed %d: random steps keep every invariant',
      async (seed) => {
        const p = await rig().boot();
        await enrollCi(p.h, 1);
        await enrollCi(p.h, 2);
        await p.h.register(PENDING);
        const sims = new Map(NODES.map((n) => [n, simNode(n)]));
        const world: World = { p, sims, rng: prng(seed) };
        for (const sim of sims.values()) await sim.beat(p.h);
        await checkInvariants(p, `seed ${seed} start`);
        for (let i = 0; i < STEP_COUNT; i += 1) {
          const label = `seed ${seed} step ${i}`;
          await step(world, label);
          await checkInvariants(p, label);
        }
      },
      60_000
    );

    test('re-applying the same document changes no desired revision and no desired history', async () => {
      const { h, store } = await rig().boot();
      await enrollCi(h, 1);
      await enrollCi(h, 2);
      const a = simNode(1);
      await a.settle(h);
      await h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 80 },
      });
      await a.settle(h);
      const fleet = (await h.admin('GET', '/v1/settings/fleet')).body;
      const history = (await store.desiredHistory(nodeIdOf(1), 100)).length;
      const settingsHistory = (await store.settingsHistory('fleet', 100))
        .length;
      const dry = await h.admin(
        'PUT',
        '/v1/settings/fleet?dryRun=1',
        fleet.value
      );
      expect(dry.body.changedNodes).toEqual([]);
      const again = await h.admin('PUT', '/v1/settings/fleet', fleet.value);
      expect(again.status).toBe(200);
      expect(again.body.changedNodes ?? []).toEqual([]);
      expect(await store.desiredHistory(nodeIdOf(1), 100)).toHaveLength(
        history
      );
      expect((await a.beat(h)).body.desired).toBeUndefined();
      // Documented behaviour: a write is a write. The revision and the history still count it.
      expect(again.body.revision).toBe(fleet.revision + 1);
      expect(await store.settingsHistory('fleet', 100)).toHaveLength(
        settingsHistory + 1
      );
    });

    test('alerts are controller-only: changing them never changes what a node is told', async () => {
      const { h } = await rig().boot();
      await enrollCi(h, 1);
      const a = simNode(1);
      await a.settle(h);
      await h.admin('PUT', '/v1/settings/fleet', {
        alerts: { offlineAfterSeconds: 900 },
      });
      expect((await a.beat(h)).body.desired).toBeUndefined();
      const view = (await h.admin('GET', `/v1/nodes/${nodeIdOf(1)}`)).body;
      expect(view.config.alerts.offlineAfterSeconds).toBe(900);
    });

    test('concurrent writers with one If-Match: exactly one wins, the rest get 409, and the audit says so', async () => {
      const { h, store } = await rig().boot();
      await enrollCi(h, 1);
      await h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 80 },
      });
      const writers = 6;
      const attempt = (i: number) =>
        h.call('PUT', '/v1/settings/fleet', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'If-Match': '1' },
          json: { disk: { alertPercent: 60 + i } },
        });
      const replies = await Promise.all(
        Array.from({ length: writers }, (_, i) => attempt(i))
      );
      const statuses = replies.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(writers - 1);
      const winner = statuses.indexOf(200);
      const stored = await store.getSettings('fleet');
      expect(stored?.revision).toBe(2);
      expect(stored?.value).toEqual({ disk: { alertPercent: 60 + winner } });
      const audit = await store.listAudit({
        targetKind: 'settings',
        targetId: 'fleet',
        limit: 50,
      });
      expect(audit.filter((e) => e.outcome === 'failed')).toHaveLength(
        writers - 1
      );
      // No lost update, no torn history: one history row per successful write.
      expect(await store.settingsHistory('fleet', 50)).toHaveLength(2);
    });

    test('concurrent writes to different scopes all succeed and the node sees their merge', async () => {
      const { h, store } = await rig().boot();
      await enrollCi(h, 1);
      const id = nodeIdOf(1);
      const replies = await Promise.all([
        h.admin('PUT', '/v1/settings/fleet', { disk: { alertPercent: 70 } }),
        h.admin('PUT', '/v1/settings/role:ci', { capacity: { slotMax: 5 } }),
        h.admin('PUT', `/v1/settings/node:${id}`, {
          heartbeat: { intervalSeconds: 30 },
        }),
      ]);
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
      const reply = await simNode(1).beat(h);
      expect(reply.body.desired.values).toEqual({
        disk: { alertPercent: 70 },
        capacity: { slotMax: 5 },
        heartbeat: { intervalSeconds: 30 },
      });
      expect((await store.settingsHistory('fleet', 5)).length).toBe(1);
    });

    test('a concurrent write racing a heartbeat never serves a document that is not a pure function of stored settings', async () => {
      const p = await rig().boot();
      await enrollCi(p.h, 1);
      const sim = simNode(1);
      await sim.beat(p.h);
      const racing = await Promise.all([
        sim.beat(p.h),
        p.h.admin('PUT', '/v1/settings/fleet', { disk: { alertPercent: 66 } }),
        sim.beat(p.h),
      ]);
      expect(racing[1]?.status).toBe(200);
      for (const reply of [racing[0], racing[2]]) {
        const desired = reply?.body.desired;
        if (desired !== undefined)
          expect(desiredRevision(desired)).toBe(desired.revision);
      }
      sim.applied = null;
      const final = await sim.beat(p.h);
      expect(final.body.desired.revision).toBe(
        (await expectedFor(p, 1)).revision
      );
      expect(final.body.desired.values).toEqual({ disk: { alertPercent: 66 } });
    });

    test('a restore racing a write with one expected revision: exactly one wins', async () => {
      const { h, store } = await rig().boot();
      await enrollCi(h, 1);
      await h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 80 },
      });
      await h.admin('PUT', '/v1/settings/fleet', {
        disk: { alertPercent: 70 },
      });
      const first = (await store.settingsHistory('fleet', 10)).at(-1);
      const [restore, write] = await Promise.all([
        h.call('POST', '/v1/settings/fleet/restore', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
          json: { historyId: first?.id, expectedRevision: 2 },
        }),
        h.call('PUT', '/v1/settings/fleet', {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'If-Match': '2' },
          json: { disk: { alertPercent: 60 } },
        }),
      ]);
      expect([restore.status, write.status].sort()).toEqual([200, 409]);
      expect((await store.getSettings('fleet'))?.revision).toBe(3);
      expect(await store.settingsHistory('fleet', 10)).toHaveLength(3);
    });
  }
);

void (undefined as unknown as Harness);
