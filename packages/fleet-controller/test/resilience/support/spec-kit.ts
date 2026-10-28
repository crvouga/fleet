import { nodeIdOf } from '../../support/fixtures';

import { send, type World } from './world';

/** What a route is for, which decides who may call it (see PROTOCOL.md and docs/*.md). */
export type Kind =
  | 'public' //        anyone, no credential
  | 'node' //          the node's own credential only
  | 'read' //          any signed-in person or the admin token
  | 'admin-read' //    administrators only, read-only
  | 'write' //         administrators only, changes state (JSON API)
  | 'webhook' //       authenticated by signature, not by identity
  | 'page' //          dashboard page: a session, else 303 to /login
  | 'page-admin' //    dashboard page for administrators
  | 'ui-action' //     dashboard form: session + same origin + administrator
  | 'asset' //         static file
  | 'auth-flow'; //    login, logout, callbacks: covered by test/auth

export interface Spec {
  /** The Hono pattern, `METHOD /path`. */
  readonly key: string;
  readonly kind: Kind;
  readonly path: (w: World) => string | Promise<string>;
  readonly json?: (w: World) => unknown;
  readonly form?: (w: World) => Record<string, string>;
  /** Statuses an authorised caller may get; default 2xx for the API, 303 for forms. */
  readonly ok?: readonly number[];
  /** `row`: a successful call must add an audit row. A string: why it need not. */
  readonly audit?: 'row' | string;
  /** Runs after the authorised call, to remember ids for later specs. */
  readonly after?: (w: World, status: number, json: unknown) => Promise<void>;
}

export const id = (n: number) => nodeIdOf(n);
export const name = (n: number) => `ci-${id(n).slice(0, 4)}`;
export const at = (n: number, tail: string) => () =>
  `/v1/nodes/${id(n)}${tail}`;
export const ui = (n: number, tail: string) => () => `/nodes/${id(n)}${tail}`;
export const fixed = (path: string) => () => path;
export const confirm = (n: number) => () => ({ confirm: name(n) });

export async function operationOf(w: World, n: number): Promise<string> {
  const listed = await send(w, 'GET', `/v1/operations?node=${id(n)}&active=1`, {
    identity: 'adminToken',
  });
  const first = (listed.json as { operations: { id: string }[] }).operations[0];
  if (first === undefined) throw new Error(`no active operation for node ${n}`);
  return first.id;
}

export const EXEMPT_NODE =
  'node-originated and authenticated by its own credential: recorded as node events, not admin audit';
