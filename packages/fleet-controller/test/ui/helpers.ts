import { Hono } from 'hono';

import type { HeartbeatPoint } from '../../src/types';

import { mountUi } from '../../src/routes/ui';
import {
  historyPoints,
  nodeId,
  nodeRow,
  type NodeOptions,
} from '../../src/testing/fixtures';
import {
  FIXED_NOW,
  LATEST_REVISION,
  createTestDeps,
  type TestDeps,
  type TestDepsOptions,
} from '../../src/testing/test-deps';

export const COOKIE = 'fleet_session=ok:tester';
export const ORIGIN = 'http://localhost';
export const OLD_REVISION = '7a1b3c4d5e6f708192a3b4c5d6e7f80910213243';

export interface Harness {
  readonly app: Hono;
  readonly deps: TestDeps;
}

export function setup(options: TestDepsOptions = {}): Harness {
  const deps = createTestDeps(options);
  const app = new Hono();
  mountUi(app, deps);
  return { app, deps };
}

export async function get(
  app: Hono,
  path: string,
  cookie: string | null = COOKIE
): Promise<Response> {
  return app.request(path, {
    headers: cookie === null ? {} : { cookie },
  });
}

export async function html(
  app: Hono,
  path: string,
  cookie: string | null = COOKIE
): Promise<string> {
  const res = await get(app, path, cookie);
  return res.text();
}

export interface PostOptions {
  readonly cookie?: string | null;
  readonly origin?: string | null;
}

export async function post(
  app: Hono,
  path: string,
  fields: Readonly<Record<string, string>> = {},
  options: PostOptions = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  const cookie = options.cookie === undefined ? COOKIE : options.cookie;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  if (cookie !== null) headers['cookie'] = cookie;
  if (origin !== null) headers['origin'] = origin;
  return app.request(path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

/** Cookie header that replays Set-Cookie values from a response (the flash). */
export function cookiesFrom(res: Response, base: string = COOKIE): string {
  const jar = res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => !pair.endsWith('='));
  return [base, ...jar].join('; ');
}

const seconds = (n: number) => new Date(FIXED_NOW.getTime() - n * 1000);

export const IDS = {
  online: nodeId('a3f9'),
  stale: nodeId('b21c'),
  offline: nodeId('c7d2'),
  rolledBack: nodeId('e5a0'),
  units: nodeId('3e4f'),
  disk: nodeId('2c3d'),
  pending: nodeId('f001'),
  retired: nodeId('dead'),
  rejected: nodeId('ba11'),
  cache: nodeId('7f10'),
};

const base = { firstSeenAt: seconds(5 * 86400) };

export function seedFleet(deps: TestDeps): void {
  const add = adder(deps);
  seedCi(add);
  seedOthers(add);
}

type Add = (options: NodeOptions, points?: readonly HeartbeatPoint[]) => void;

function adder(deps: TestDeps): Add {
  return (options, points = []) =>
    deps.store.seedNode(nodeRow({ ...base, ...options }), points);
}

function seedCi(add: Add): void {
  add(
    {
      short: 'a3f9',
      role: 'ci',
      lastSeenAt: seconds(20),
      labels: ['high-mem', 'rack-2'],
      displayName: 'Build 1',
      body: {
        revision: LATEST_REVISION,
        runners: { slots: 6, busy: 4 },
        capabilities: ['high-mem'],
      },
    },
    historyPoints(FIXED_NOW, 24, 300, (progress) => ({
      uptimeSeconds: Math.round(progress * 86400),
      load1: 2 + progress * 3,
      memUsedPercent: 40 + progress * 10,
      diskPercent: 55,
      slots: 6,
      busySlots: Math.round(progress * 4),
    }))
  );
  add({
    short: 'b21c',
    role: 'ci',
    lastSeenAt: seconds(240),
    body: { revision: OLD_REVISION, runners: { slots: 3, busy: 3 } },
  });
  add({
    short: 'c7d2',
    role: 'ci',
    lastSeenAt: seconds(3 * 3600),
    body: { revision: OLD_REVISION },
  });
  add({
    short: 'e5a0',
    role: 'ci',
    lastSeenAt: seconds(30),
    body: {
      revision: LATEST_REVISION,
      sync: { rolledBack: true, healthFailure: 'runner never became healthy' },
      runners: { slots: 4, busy: 0 },
    },
  });
}

function seedOthers(add: Add): void {
  add({
    short: '3e4f',
    role: 'web',
    lastSeenAt: seconds(30),
    body: {
      revision: LATEST_REVISION,
      failedUnits: ['caddy.service', 'backup.service'],
    },
  });
  add({
    short: '2c3d',
    role: 'web',
    lastSeenAt: seconds(30),
    body: { revision: LATEST_REVISION, disk: { nixUsedPercent: 94 } },
  });
  add({
    short: '7f10',
    role: 'cache',
    lastSeenAt: seconds(30),
    body: { revision: LATEST_REVISION },
  });
  add({
    short: 'f001',
    role: 'netboot',
    approval: 'pending',
    lastSeenAt: seconds(600),
    enrolledVia: 'hello',
  });
  add({
    short: 'dead',
    role: 'devbox',
    approval: 'retired',
    lastSeenAt: seconds(9e5),
  });
  add({
    short: 'ba11',
    role: 'devbox',
    approval: 'rejected',
    lastSeenAt: seconds(9e4),
  });
}

export interface Parsed {
  readonly tags: readonly string[];
  /** Every attribute name that appears on any element. */
  readonly attributes: readonly string[];
  /** id attribute values. */
  readonly ids: readonly string[];
}

/** A real HTML parse (not regexes), so escaped text cannot be mistaken for markup. */
export async function parseHtml(page: string): Promise<Parsed> {
  const tags: string[] = [];
  const attributes: string[] = [];
  const ids: string[] = [];
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      tags.push(element.tagName);
      for (const [name, value] of element.attributes) {
        attributes.push(name);
        if (name === 'id') ids.push(value);
      }
    },
  });
  await rewriter.transform(new Response(page)).text();
  return { tags, attributes, ids };
}
