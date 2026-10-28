import type { Hono } from 'hono';

import { mountUi } from '../../../src/routes/ui';
import {
  ADMIN_TOKEN,
  CI_ENROLLMENT_TOKEN,
  PLAIN_ENROLLMENT_TOKEN,
  createHarness,
} from '../../support/controller';
import type { ControllerContext } from '../../support/describe-controller';
import {
  heartbeatBody,
  nodeIdOf,
  secretOf,
  sha256,
} from '../../support/fixtures';
import { signInAs, type SignedIn } from '../../support/session';

import type { ControllerProcess, Rig } from './rig';

export const ORIGIN = 'http://localhost';

export const IDENTITIES = [
  'anonymous',
  'node',
  'wrongNode',
  'viewer',
  'admin',
  'adminToken',
] as const;
export type Identity = (typeof IDENTITIES)[number];

/** Node numbers by purpose, so each state-changing route has its own target. */
export const NODE = {
  patch: 1,
  approve: 2,
  replacement: 3,
  reject: 4,
  retire: 5,
  remove: 6,
  restart: 7,
  replace: 8,
  decommission: 9,
  revoke: 10,
  drain: 11,
  uiApprove: 13,
  uiReject: 14,
  uiRetire: 15,
  uiRemove: 16,
  uiDrain: 17,
  uiRotate: 18,
  uiRevoke: 19,
  caller: 20,
  stranger: 21,
} as const;

const APPROVED = [1, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 18, 19, 20];
const PENDING = [2, 3, 4, 13, 14];

export interface World {
  readonly p: ControllerProcess;
  readonly app: Hono;
  readonly admin: SignedIn;
  readonly viewer: SignedIn;
  /** Every response text and header seen, for the credential-leak scan. */
  readonly seen: string[];
  /** Values captured by earlier steps (an operation id, a history id). */
  readonly memo: Map<string, string>;
}

export interface Sent {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: unknown;
}

export interface SendOptions {
  readonly identity: Identity;
  readonly json?: unknown;
  readonly form?: Readonly<Record<string, string>>;
  /** Overrides the browser Origin a session identity sends; `null` sends none. */
  readonly origin?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export function credentialHeaders(
  world: World,
  identity: Identity
): Record<string, string> {
  switch (identity) {
    case 'anonymous':
      return {};
    case 'node':
      return {
        Authorization: `Bearer ${nodeIdOf(NODE.caller)}.${secretOf(NODE.caller)}`,
      };
    case 'wrongNode':
      return {
        Authorization: `Bearer ${nodeIdOf(NODE.caller)}.${secretOf(NODE.stranger)}`,
      };
    case 'viewer':
      return { Cookie: world.viewer.cookie };
    case 'admin':
      return { Cookie: world.admin.cookie };
    case 'adminToken':
      return { Authorization: `Bearer ${ADMIN_TOKEN}` };
  }
}

function requestBody(options: SendOptions): {
  body?: string;
  type?: string;
} {
  if (options.json !== undefined)
    return { body: JSON.stringify(options.json), type: 'application/json' };
  if (options.form === undefined) return {};
  return {
    body: new URLSearchParams(options.form).toString(),
    type: 'application/x-www-form-urlencoded',
  };
}

function requestHeaders(
  world: World,
  options: SendOptions,
  type: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    ...credentialHeaders(world, options.identity),
    ...options.headers,
  };
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const session = options.identity === 'viewer' || options.identity === 'admin';
  if (session && origin !== null) headers['Origin'] = origin;
  if (type !== undefined) headers['Content-Type'] = type;
  return headers;
}

function describeResponse(label: string, res: Response, text: string): string {
  const lines: string[] = [];
  res.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return `${label}\n${lines.join('\n')}\n${text}`;
}

export async function send(
  world: World,
  method: string,
  path: string,
  options: SendOptions
): Promise<Sent> {
  const { body, type } = requestBody(options);
  const res = await world.app.request(path, {
    method: method === 'HEAD' ? 'GET' : method,
    headers: requestHeaders(world, options, type),
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  world.seen.push(describeResponse(`${method} ${path}`, res, text));
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Every secret value the scenario knows: none may appear in any response. */
export function knownSecrets(): string[] {
  const nodes = [...APPROVED, ...PENDING, NODE.stranger].map(secretOf);
  const raw = [
    ...nodes,
    ADMIN_TOKEN,
    CI_ENROLLMENT_TOKEN,
    PLAIN_ENROLLMENT_TOKEN,
    's'.repeat(43),
    'v'.repeat(43),
    'a'.repeat(43),
  ];
  return [...raw, ...raw.map(sha256)];
}

/** An approved or pending node, registered the way an installer does. */
async function enrol(p: ControllerProcess, n: number, approved: boolean) {
  await p.h.register(
    n,
    approved ? { enrollmentToken: CI_ENROLLMENT_TOKEN } : {}
  );
  if (approved) await p.h.asNode(n, 'POST', '/v1/heartbeat', heartbeatBody(n));
}

/** A running controller with the dashboard mounted, a viewer, an admin and many nodes. */
export async function buildWorld(rig: Rig): Promise<World> {
  const p = await rig.boot();
  const ctx: ControllerContext = {
    h: p.h,
    store: p.store,
    db: rig.db,
    harness: (extra = {}) =>
      createHarness(p.store, { ...extra, clock: rig.clock }),
  };
  const viewer = await signInAs(ctx, 'viewer@example.test', 'viewer', 'v');
  const admin = await signInAs(ctx, 'admin@example.test', 'admin', 'a');
  mountUi(admin.h.app, admin.h.deps);
  for (const n of APPROVED) await enrol(p, n, true);
  for (const n of PENDING) await enrol(p, n, false);
  return { p, app: admin.h.app, admin, viewer, seen: [], memo: new Map() };
}
