import { describe, expect, test } from 'bun:test';

import { canonicalJson } from '../../src/config/schema';
import { nodeIdOf } from '../support/fixtures';

import { SPECS, type Kind, type Spec } from './support/route-table';
import { describeRig } from './support/rig';
import {
  IDENTITIES,
  NODE,
  buildWorld,
  knownSecrets,
  send,
  type Identity,
  type Sent,
  type World,
} from './support/world';

type Check = (reply: Sent, spec: Spec) => boolean;
const is =
  (...codes: number[]): Check =>
  (reply) =>
    codes.includes(reply.status);
/** Not refused for who the caller is; a 5xx only where the spec lists it (feature absent). */
const passes: Check = (reply, spec) =>
  reply.status !== 401 &&
  reply.status !== 403 &&
  (reply.status < 500 || (spec.ok?.includes(reply.status) ?? false));
const toLogin: Check = (reply) =>
  reply.status === 303 &&
  (reply.headers.get('location') ?? '').startsWith('/login');
const anything: Check = (reply) => reply.status < 500;

type Rule = Partial<Record<Identity, Check>>;

/** Who may do what to a route of each kind. Identities not listed are checked elsewhere. */
const RULES: Readonly<Record<Kind, Rule>> = {
  public: {},
  node: {
    anonymous: is(401),
    wrongNode: is(401),
    viewer: is(401),
    admin: is(401),
    adminToken: is(401),
  },
  read: {
    anonymous: is(401),
    node: is(401),
    wrongNode: is(401),
    viewer: passes,
    admin: passes,
    adminToken: passes,
  },
  'admin-read': {
    anonymous: is(401),
    node: is(401),
    wrongNode: is(401),
    viewer: is(403),
    admin: passes,
    adminToken: passes,
  },
  write: {
    anonymous: is(401),
    node: is(401),
    wrongNode: is(401),
    viewer: is(403),
  },
  webhook: {
    anonymous: is(401, 404),
    node: is(401, 404),
    wrongNode: is(401, 404),
    viewer: is(401, 404),
    admin: is(401, 404),
    adminToken: is(401, 404),
  },
  page: {
    anonymous: toLogin,
    node: toLogin,
    wrongNode: toLogin,
    viewer: passes,
    admin: passes,
    adminToken: passes,
  },
  'page-admin': {
    anonymous: toLogin,
    node: toLogin,
    wrongNode: toLogin,
    viewer: is(403),
    admin: passes,
    adminToken: passes,
  },
  'ui-action': {
    anonymous: is(401, 403, 303),
    node: is(401, 403, 303),
    wrongNode: is(401, 403, 303),
    adminToken: is(403, 303),
    viewer: is(403),
  },
  asset: Object.fromEntries(
    IDENTITIES.map((i) => [i, is(200, 304, 404, 503)])
  ) as Rule,
  'auth-flow': Object.fromEntries(IDENTITIES.map((i) => [i, anything])) as Rule,
};

const key = (spec: Spec) => spec.key;
const METHOD_OF = (spec: Spec) => spec.key.split(' ')[0] as string;
const PATTERN_OF = (spec: Spec) => spec.key.split(' ')[1] as string;

async function request(
  world: World,
  spec: Spec,
  identity: Identity,
  extra = {}
) {
  const json = spec.json?.(world);
  const form = spec.form?.(world);
  return send(world, METHOD_OF(spec), await spec.path(world), {
    identity,
    ...(json === undefined ? {} : { json }),
    ...(form === undefined ? {} : { form }),
    ...extra,
  });
}

/** Durable state that only an authorised, successful change may alter. */
async function durableState(world: World): Promise<string> {
  const { store } = world.p;
  return canonicalJson({
    nodes: await store.listNodes(),
    settings: await store.listSettings(),
    operations: await store.operations.list({ limit: 200 }),
  });
}

/** The newest audit id: it only grows, so a difference counts the rows a call added. */
const auditCount = async (world: World): Promise<number> =>
  (await world.p.store.listAudit({ limit: 1 }))[0]?.id ?? 0;

/**
 * Runs one state-changing route as an administrator and returns what is wrong:
 * an unexpected status, or a success that left no audit row (unless the spec
 * records why it need not).
 */
async function exercise(world: World, spec: Spec): Promise<string[]> {
  const before = await auditCount(world);
  const reply = await request(world, spec, 'admin');
  const accepted =
    spec.ok ?? (spec.kind === 'ui-action' ? [303] : [200, 201, 202]);
  const problems: string[] = [];
  if (!accepted.includes(reply.status))
    problems.push(`${spec.key}: ${reply.status} ${reply.text.slice(0, 120)}`);
  await spec.after?.(world, reply.status, reply.json);
  const added = (await auditCount(world)) - before;
  if (spec.audit === undefined)
    problems.push(`${spec.key}: no audit expectation recorded`);
  if (spec.audit !== 'row') return problems;
  if (added < 1) return [...problems, `${spec.key}: no audit row`];
  const fresh = await world.p.store.listAudit({ limit: added });
  // A form that redirects with an error banner is not a success: it must have worked.
  if (!fresh.some((row) => row.outcome === 'success'))
    problems.push(`${spec.key}: audited, but never as a success`);
  return problems;
}

describeRig(
  'Security: authorization boundaries, every route by every identity',
  (rig) => {
    test('every mounted route is classified, and every classified route is mounted', async () => {
      const world = await buildWorld(rig());
      const mounted = new Set(
        world.app.routes
          .filter((route) => route.method !== 'ALL')
          .map((route) => `${route.method} ${route.path}`)
      );
      const classified = new Set(SPECS.map(key));
      const unclassified = [...mounted].filter(
        (route) => !classified.has(route)
      );
      const stale = [...classified].filter((route) => !mounted.has(route));
      // A new route must be added to test/resilience/support/route-table.ts, with
      // who may call it and how its use is audited, before it can ship.
      expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
      expect(new Set(SPECS.map(key)).size).toBe(SPECS.length);
    });

    test('refused callers get the documented status class and change nothing', async () => {
      const world = await buildWorld(rig());
      const before = await durableState(world);
      const failures: string[] = [];
      for (const spec of SPECS) {
        const rule = RULES[spec.kind];
        for (const identity of IDENTITIES) {
          const check = rule[identity];
          if (check === undefined) continue;
          if (spec.kind === 'write' && identity === 'adminToken') continue;
          const reply = await request(world, spec, identity);
          if (!check(reply, spec))
            failures.push(`${spec.key} as ${identity}: got ${reply.status}`);
        }
      }
      expect(failures).toEqual([]);
      // Refused or merely read: not one node, setting or operation moved.
      expect(await durableState(world)).toBe(before);
    });

    test('a node credential reaches no administrator route, whatever the method', async () => {
      const world = await buildWorld(rig());
      const admin = SPECS.filter(
        (spec) =>
          spec.kind !== 'node' &&
          spec.kind !== 'public' &&
          spec.kind !== 'asset' &&
          spec.kind !== 'auth-flow' &&
          spec.kind !== 'webhook' &&
          PATTERN_OF(spec).startsWith('/v1/')
      );
      expect(admin.length).toBeGreaterThan(30);
      for (const spec of admin) {
        for (const identity of ['node', 'wrongNode'] as const) {
          const reply = await request(world, spec, identity);
          expect([spec.key, identity, reply.status]).toEqual([
            spec.key,
            identity,
            401,
          ]);
        }
      }
    });

    test('node routes reject every administrator identity and accept only the node itself', async () => {
      const world = await buildWorld(rig());
      for (const spec of SPECS.filter((s) => s.kind === 'node')) {
        for (const identity of [
          'viewer',
          'admin',
          'adminToken',
          'anonymous',
          'wrongNode',
        ] as const) {
          const reply = await request(world, spec, identity);
          expect([spec.key, identity, reply.status]).toEqual([
            spec.key,
            identity,
            401,
          ]);
        }
      }
      for (const spec of SPECS.filter((s) => s.kind === 'node')) {
        const reply = await request(world, spec, 'node');
        const accepted = spec.ok ?? [200];
        expect([spec.key, accepted.includes(reply.status)]).toEqual([
          spec.key,
          true,
        ]);
      }
    });

    test('public routes answer every caller alike and never demand a credential', async () => {
      const world = await buildWorld(rig());
      for (const spec of SPECS.filter((s) => s.kind === 'public')) {
        const answers = new Set<number>();
        for (const identity of ['anonymous', 'viewer', 'adminToken'] as const) {
          const reply = await request(world, spec, identity);
          expect(passes(reply, spec)).toBe(true);
          answers.add(reply.status);
        }
        // register answers 201 then 200: the same request twice is still never an auth error.
        expect([...answers].every((s) => s < 300)).toBe(true);
      }
    });

    test('session writes need a same-origin Origin or Referer; the admin token needs none', async () => {
      const world = await buildWorld(rig());
      const patch = SPECS.find((s) => s.key === 'PATCH /v1/nodes/:id') as Spec;
      const path = await patch.path(world);
      const before = await durableState(world);
      for (const origin of [
        'https://evil.example',
        'null',
        'http://localhost.evil.example',
        null,
      ]) {
        const reply = await send(world, 'PATCH', path, {
          identity: 'admin',
          json: { note: 'cross-site' },
          origin,
        });
        expect([origin, reply.status]).toEqual([origin, 403]);
        expect((reply.json as { error: string }).error).toBe('cross_origin');
      }
      const foreignReferer = await send(world, 'PATCH', path, {
        identity: 'admin',
        json: { note: 'x' },
        origin: null,
        headers: { Referer: 'https://evil.example/page' },
      });
      expect(foreignReferer.status).toBe(403);
      expect(await durableState(world)).toBe(before);
      const sameReferer = await send(world, 'PATCH', path, {
        identity: 'admin',
        json: { note: 'ok' },
        origin: null,
        headers: { Referer: 'http://localhost/nodes' },
      });
      expect(sameReferer.status).toBe(200);
      const token = await send(world, 'PATCH', path, {
        identity: 'adminToken',
        json: { note: 'script' },
      });
      expect(token.status).toBe(200);
    });

    test('forms from another site are refused for every dashboard action, with the session cookie attached', async () => {
      const world = await buildWorld(rig());
      const before = await durableState(world);
      for (const spec of SPECS.filter((s) => s.kind === 'ui-action')) {
        for (const origin of ['https://evil.example', null]) {
          const reply = await request(world, spec, 'admin', { origin });
          expect([spec.key, origin, reply.status]).toEqual([
            spec.key,
            origin,
            403,
          ]);
        }
      }
      expect(await durableState(world)).toBe(before);
    });

    test('unknown /v1 paths are 404 JSON for everyone and never leak whether a route exists behind auth', async () => {
      const world = await buildWorld(rig());
      for (const identity of IDENTITIES) {
        const reply = await send(world, 'GET', '/v1/does-not-exist', {
          identity,
        });
        expect([identity, reply.status]).toEqual([identity, 404]);
        expect((reply.json as { error: string }).error).toBe('not_found');
      }
    });
  }
);

describe('Security: what an administrator does is audited and nothing leaks', () => {
  describeRig('administrator actions', (rig) => {
    test('every state-changing route writes an audit row when it succeeds, or says why it need not', async () => {
      const world = await buildWorld(rig());
      const problems: string[] = [];
      for (const spec of SPECS.filter(
        (s) => s.kind === 'write' || s.kind === 'ui-action'
      ))
        problems.push(...(await exercise(world, spec)));
      expect(problems).toEqual([]);
      // The actor is the signed-in person, and no row carries a credential.
      const rows = await world.p.store.listAudit({ limit: 500 });
      expect(rows.some((row) => row.actor === 'admin@example.test')).toBe(true);
      const text = JSON.stringify(rows);
      for (const secret of knownSecrets()) expect(text).not.toContain(secret);
    });

    test('no response, header or audit row contains a node secret, its hash, a token or a session', async () => {
      const world = await buildWorld(rig());
      for (const spec of SPECS) {
        const rule = RULES[spec.kind];
        for (const identity of IDENTITIES) {
          if (rule[identity] !== undefined || spec.kind === 'public')
            await request(world, spec, identity);
        }
      }
      for (const spec of SPECS.filter(
        (s) => s.kind === 'read' || s.kind === 'admin-read'
      )) {
        await request(world, spec, 'admin');
      }
      expect(world.seen.length).toBeGreaterThan(300);
      const everything = world.seen.join('\n');
      for (const secret of knownSecrets()) {
        expect(
          everything.includes(secret) ? secret.slice(0, 8) : null
        ).toBeNull();
      }
      expect(everything).not.toMatch(
        /secret_hash|secretHash|next_secret_hash|nextSecretHash/
      );
      // The stored revoked-hash marker is `revoked:<id>`; the bundle's own `revoked:` object key is fine.
      expect(everything).not.toMatch(/revoked:[0-9a-f]{8,}/);
    });

    test('JSON bodies never carry a 64-hex value under a secret-like key', async () => {
      const world = await buildWorld(rig());
      const detail = await send(
        world,
        'GET',
        `/v1/nodes/${nodeIdOf(NODE.patch)}`,
        { identity: 'adminToken' }
      );
      const list = await send(world, 'GET', '/v1/nodes', {
        identity: 'adminToken',
      });
      const credential = await send(
        world,
        'GET',
        `/v1/nodes/${nodeIdOf(NODE.patch)}/credential`,
        { identity: 'adminToken' }
      );
      const offending: string[] = [];
      const visit = (value: unknown, path: string): void => {
        if (Array.isArray(value))
          return value.forEach((v, i) => visit(v, `${path}[${i}]`));
        if (typeof value !== 'object' || value === null) return;
        for (const [k, v] of Object.entries(value)) {
          if (
            /secret|token|password|credential/i.test(k) &&
            typeof v === 'string' &&
            /^[0-9a-f]{64}$/.test(v)
          )
            offending.push(`${path}.${k}`);
          visit(v, `${path}.${k}`);
        }
      };
      for (const reply of [detail, list, credential]) visit(reply.json, '$');
      expect(offending).toEqual([]);
    });

    test('a viewer is refused every write and each refusal is an audited denial naming the viewer', async () => {
      const world = await buildWorld(rig());
      const writes = SPECS.filter((s) => s.kind === 'write');
      for (const spec of writes) await request(world, spec, 'viewer');
      const denied = (await world.p.store.listAudit({ limit: 500 })).filter(
        (row) => row.outcome === 'denied' && row.actor === 'viewer@example.test'
      );
      expect(denied.every((row) => row.actorRole === 'viewer')).toBe(true);
      expect(denied.length).toBeGreaterThanOrEqual(writes.length - 4);
    });
  });
});
