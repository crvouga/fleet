import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import { SECRET_HASH_PATTERN } from '../domain/credential-rotation';
import { isRecord } from '../domain/heartbeat-fields';
import type { NodeRow } from '../types';

import { adminRoute } from './guards';
import { controllerError, invalidBody, readJson } from './http';
import {
  confirmationRequired,
  confirmedRevocation,
  requestRotation,
  revokeCredential,
} from './credential-service';
import { authenticate } from './node-routes';

const MAX_REASON = 200;

function nodeOf(deps: AppDeps, c: Context): Promise<NodeRow | null> {
  const id = c.req.param('id') ?? '';
  return NODE_ID_PATTERN.test(id)
    ? deps.store.findNode(id)
    : Promise.resolve(null);
}

const notFound = (c: Context) =>
  controllerError(c, 404, 'not_found', 'No such node.');

/** The revoke body: `confirm` names the node; `reason` is optional free text, never a credential. */
async function readRevocation(
  c: Context
): Promise<
  { confirm: unknown; reason: string | null } | { response: Response }
> {
  const text = await c.req.text();
  let value: unknown = {};
  if (text.trim().length > 0) {
    try {
      value = JSON.parse(text);
    } catch {
      return {
        response: controllerError(
          c,
          400,
          'invalid_request',
          'The body must be valid JSON.'
        ),
      };
    }
  }
  if (!isRecord(value))
    return {
      response: invalidBody(c, 'invalid_request', [
        'body must be an object with confirm and an optional reason string',
      ]),
    };
  const reason = value['reason'];
  if (reason !== undefined && typeof reason !== 'string')
    return {
      response: invalidBody(c, 'invalid_request', ['reason must be a string']),
    };
  const trimmed = (reason ?? '').trim();
  if (trimmed.length > MAX_REASON)
    return {
      response: invalidBody(c, 'invalid_request', [
        `reason may be at most ${MAX_REASON} characters`,
      ]),
    };
  return {
    confirm: value['confirm'],
    reason: trimmed.length > 0 ? trimmed : null,
  };
}

function showCredential(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const node = await nodeOf(deps, c);
    const credential =
      node === null ? null : await deps.store.credentialStatus(node.id);
    return credential === null
      ? notFound(c)
      : c.json({ nodeId: node?.id, credential });
  });
}

function requestRotationRoute(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const node = await nodeOf(deps, c);
    if (node === null) return notFound(c);
    const result = await requestRotation(deps, node, actor);
    if (result.ok) return c.json({ ok: true, credential: result.status }, 202);
    return result.reason === 'unknown_node'
      ? notFound(c)
      : controllerError(
          c,
          409,
          'credential_revoked',
          'This node’s credential is revoked. It must register again and be approved before its credential can rotate.'
        );
  });
}

function revokeCredentialRoute(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const node = await nodeOf(deps, c);
    if (node === null) return notFound(c);
    const body = await readRevocation(c);
    if ('response' in body) return body.response;
    if (!(await confirmedRevocation(deps, node, actor, body.confirm)))
      return c.json(confirmationRequired(node), 400);
    const result = await revokeCredential(deps, node, actor, body.reason);
    return result.ok
      ? c.json({ ok: true, credential: result.status })
      : notFound(c);
  });
}

const NOT_REQUESTED =
  'No rotation was requested for this node. Ask an administrator to request one first.';

type Offered = Awaited<ReturnType<AppDeps['store']['submitNextCredential']>>;

/** The node's answer for a refused offer. */
function refusedOffer(
  c: Context,
  reason: Extract<Offered, { ok: false }>['reason']
): Response {
  if (reason === 'not_requested')
    return controllerError(c, 409, 'rotation_not_requested', NOT_REQUESTED);
  if (reason === 'same_secret')
    return invalidBody(c, 'invalid_request', [
      'The next secret must differ from the current one',
    ]);
  return controllerError(
    c,
    401,
    'unauthorized',
    'Unknown node or wrong secret. Register again.'
  );
}

/** The sha256 the node offers, or the 400 to answer. */
async function readOffer(
  c: Context
): Promise<{ hash: string } | { response: Response }> {
  const body = await readJson(c);
  if (!body.ok) return { response: body.response };
  const hash = isRecord(body.value) ? body.value['nextSecretHash'] : undefined;
  if (typeof hash === 'string' && SECRET_HASH_PATTERN.test(hash))
    return { hash };
  return {
    response: invalidBody(c, 'invalid_request', [
      'nextSecretHash must be the 64 hex digit sha256 of the next secret',
    ]),
  };
}

/** Node side: `POST /v1/credential/rotate` with the CURRENT secret and `{ nextSecretHash }`. */
function submitNext(deps: AppDeps) {
  return async (c: Context): Promise<Response> => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) return auth.response;
    const offer = await readOffer(c);
    if ('response' in offer) return offer.response;
    const result = await deps.store.submitNextCredential(
      auth.node.id,
      offer.hash
    );
    await deps.store.audit({
      actor: `node:${auth.node.id.slice(0, 4)}`,
      action: 'credential.rotate_submit',
      targetKind: 'node',
      targetId: auth.node.id,
      outcome: result.ok ? 'success' : 'failed',
      detail: result.ok
        ? { changed: result.changed }
        : { reason: result.reason },
    });
    return result.ok
      ? c.json({ ok: true, rotationPending: result.status.rotationPending })
      : refusedOffer(c, result.reason);
  };
}

export function mountAdminCredentials(app: Hono, deps: AppDeps): void {
  app.get('/v1/nodes/:id/credential', showCredential(deps));
  app.post('/v1/nodes/:id/rotate-credential', requestRotationRoute(deps));
  app.post('/v1/nodes/:id/revoke-credential', revokeCredentialRoute(deps));
  app.post('/v1/credential/rotate', submitNext(deps));
}
