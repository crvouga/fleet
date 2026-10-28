import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import type { NodeRow } from '../types';
import {
  isOperationKind,
  isOperationStatus,
  type Operation,
} from '../domain/operations';
import { requestOperation, type RequestOutcome } from '../operations/request';
import { cancelOperation, undrainNode } from '../operations/withdraw';

import { adminRoute } from './guards';
import { requireConfirmation, readOptionalJson } from './confirmation';
import { controllerError, invalidBody } from './http';
import {
  idempotencyKeyOf,
  parseActionBody,
  type ActionBody,
  type ActionName,
} from './operation-body';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function limitOf(raw: string | undefined): number {
  const value = Number(raw ?? DEFAULT_LIMIT);
  return Number.isInteger(value) && value >= 1
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT;
}

/** `<epoch ms>:<id>`: where the previous page ended. */
function cursorOf(raw: string | undefined) {
  const match = /^(\d{1,15}):([A-Za-z0-9-]{1,64})$/.exec(raw ?? '');
  return match === null
    ? undefined
    : { requestedAt: new Date(Number(match[1])), id: match[2]! };
}

const cursorFor = (op: Operation): string =>
  `${op.requestedAt.getTime()}:${op.id}`;

function filtersOf(c: Context) {
  const { node, kind, status, active } = c.req.query();
  const errors: string[] = [];
  if (node !== undefined && !NODE_ID_PATTERN.test(node))
    errors.push('node must be a 64-character node id');
  if (kind !== undefined && !isOperationKind(kind))
    errors.push('kind must be drain, restart, replace or decommission');
  if (status !== undefined && !isOperationStatus(status))
    errors.push(
      'status must be pending, in_progress, succeeded, failed or cancelled'
    );
  return {
    errors,
    node,
    kind: isOperationKind(kind) ? kind : undefined,
    status: isOperationStatus(status) ? status : undefined,
    activeOnly: active === '1' || active === 'true',
  };
}

function listOperations(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const filters = filtersOf(c);
    if (filters.errors.length > 0)
      return invalidBody(c, 'invalid_request', filters.errors);
    const limit = limitOf(c.req.query('limit'));
    const before = cursorOf(c.req.query('cursor'));
    const rows = await deps.store.operations.list({
      limit: limit + 1,
      activeOnly: filters.activeOnly,
      ...(filters.node === undefined ? {} : { nodeId: filters.node }),
      ...(filters.kind === undefined ? {} : { kind: filters.kind }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(before === undefined ? {} : { before }),
    });
    const page = rows.slice(0, limit);
    return c.json({
      operations: page,
      nextCursor: rows.length > limit ? cursorFor(page[limit - 1]!) : null,
    });
  });
}

function showOperation(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const op = await deps.store.operations.get(c.req.param('id') ?? '');
    if (op === null)
      return controllerError(c, 404, 'not_found', 'No such operation.');
    return c.json({ operation: op });
  });
}

function cancel(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const done = await cancelOperation(deps, c.req.param('id') ?? '', actor);
    return done.ok
      ? c.json({ operation: done.operation })
      : controllerError(c, done.status, done.code, done.message);
  });
}

function outcomeResponse(c: Context, outcome: RequestOutcome): Response {
  if (outcome.ok)
    return c.json(
      { operation: outcome.operation, replayed: outcome.replayed },
      outcome.replayed ? 200 : 202
    );
  return c.json(
    {
      error: outcome.code,
      message: outcome.message,
      ...(outcome.operationId === undefined
        ? {}
        : { operationId: outcome.operationId }),
    },
    outcome.status
  );
}

const CONFIRMED: Readonly<Partial<Record<ActionName, string>>> = {
  restart: 'restart',
  replace: 'replace',
  decommission: 'decommission',
};

/** The node, the validated body and the idempotency key, or the response that refuses them. */
async function readStart(
  deps: AppDeps,
  c: Context,
  action: Exclude<ActionName, 'undrain'>
): Promise<
  | {
      readonly node: NodeRow;
      readonly body: ActionBody;
      readonly key: string | null;
    }
  | { readonly response: Response }
> {
  const id = c.req.param('id') ?? '';
  const node = NODE_ID_PATTERN.test(id) ? await deps.store.findNode(id) : null;
  if (node === null)
    return { response: controllerError(c, 404, 'not_found', 'No such node.') };
  const raw = await readOptionalJson(c);
  if (!raw.ok) return raw;
  const parsed = parseActionBody(action, raw.value);
  if (!parsed.ok)
    return { response: invalidBody(c, 'invalid_request', parsed.errors) };
  const key = idempotencyKeyOf(c.req.header('idempotency-key'));
  if (key === 'invalid')
    return {
      response: controllerError(
        c,
        400,
        'invalid_request',
        'Idempotency-Key must be 1-120 characters of letters, digits, dot, dash, colon or underscore.'
      ),
    };
  return { node, body: parsed.value, key };
}

function startOperation(deps: AppDeps, action: Exclude<ActionName, 'undrain'>) {
  return adminRoute(deps, async (c, actor) => {
    const read = await readStart(deps, c, action);
    if ('response' in read) return read.response;
    const { node, body, key } = read;
    const verb = CONFIRMED[action];
    const refused =
      verb === undefined
        ? null
        : await requireConfirmation(deps, c, {
            node,
            typed: body.confirm,
            action: verb,
            actor,
            auditAs: `node.${action}`,
          });
    if (refused !== null) return refused;
    return outcomeResponse(
      c,
      await requestOperation(deps, {
        kind: action,
        nodeId: node.id,
        actor,
        ...(key === null ? {} : { idempotencyKey: key }),
        ...(body.force === undefined ? {} : { force: body.force }),
        ...(body.replacement === undefined
          ? {}
          : { replacement: body.replacement }),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(body.timeoutSeconds === undefined
          ? {}
          : { timeoutSeconds: body.timeoutSeconds }),
      })
    );
  });
}

function undrain(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const id = c.req.param('id') ?? '';
    if (!NODE_ID_PATTERN.test(id))
      return controllerError(c, 404, 'not_found', 'No such node.');
    const body = await readOptionalJson(c);
    if (!body.ok) return body.response;
    const parsed = parseActionBody('undrain', body.value);
    if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
    const done = await undrainNode(deps, id, actor);
    return done.ok
      ? c.json({
          ok: true,
          cancelled: done.cancelled,
          stillCordoned: done.stillCordoned,
        })
      : controllerError(c, done.status, done.code, done.message);
  });
}

export function mountAdminOperations(app: Hono, deps: AppDeps): void {
  app.get('/v1/operations', listOperations(deps));
  app.get('/v1/operations/:id', showOperation(deps));
  app.post('/v1/operations/:id/cancel', cancel(deps));
  for (const action of ['drain', 'restart', 'replace', 'decommission'] as const)
    app.post(`/v1/nodes/:id/${action}`, startOperation(deps, action));
  app.post('/v1/nodes/:id/undrain', undrain(deps));
}
