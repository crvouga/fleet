import type { Logger } from '@pkgs/logger';
import type { Context, Hono } from 'hono';

import { sha256Hex } from '../auth/hash';
import { parseNodeCredential } from '../auth/node-credential';
import { roleTokenValid } from '../auth/role-token';
import type { AppDeps } from '../deps';
import { validateHeartbeat } from '../domain/heartbeat-validation';
import type { RateLimiter } from '../domain/rate-limit';
import type { NodeRow } from '../types';

import {
  apiError,
  clientAddress,
  invalidBody,
  rateLimitGuard,
  readJson,
} from './http';
import { envelopeFor, intervalOf, loadConfig } from './node-config';
import { validateRegister } from './register-body';
import { enrollmentCheck } from './enrollment-check';

export interface NodeRouteOptions {
  readonly registerLimiter: RateLimiter;
  readonly log: Logger;
}

type Authenticated =
  | { readonly node: NodeRow }
  | {
      readonly response: Response;
      /** Set when the caller proved it holds the secret of a refused node. */
      readonly refused: 'rejected' | 'retired' | null;
    };

/** 401 for an unknown id or wrong secret; 403 only to a caller that holds the secret. */
async function authenticate(c: Context, deps: AppDeps): Promise<Authenticated> {
  const credential = parseNodeCredential(c.req.header('authorization'));
  if (credential === null) {
    return {
      response: apiError(
        c,
        401,
        'unauthorized',
        'Send Authorization: Bearer <nodeId>.<secret>.'
      ),
      refused: null,
    };
  }
  const node = await deps.store.authenticateNode(
    credential.nodeId,
    credential.secretHash
  );
  if (node !== null) return { node };
  const known = await deps.store.verifyNodeSecret?.(
    credential.nodeId,
    credential.secretHash
  );
  if (known?.approval === 'rejected' || known?.approval === 'retired') {
    return {
      response: apiError(
        c,
        403,
        known.approval,
        `This node is ${known.approval}. Back off and ask a person.`
      ),
      refused: known.approval,
    };
  }
  return {
    response: apiError(
      c,
      401,
      'unauthorized',
      'Unknown node or wrong secret. Register again.'
    ),
    refused: null,
  };
}

function register(deps: AppDeps, log: Logger) {
  return async (c: Context): Promise<Response> => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = validateRegister(body.value);
    if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
    const { nodeId, role, hostname, secret, roleToken } = parsed.value;
    const proved = roleTokenValid(deps.env.roleTokenHashes, role, roleToken);
    if (roleToken !== undefined && !proved) {
      log.warn('registration presented a role token that did not match', {
        node: nodeId,
        role,
      });
    }
    const { node, created } = await deps.store.registerNode({
      id: nodeId,
      role,
      hostname,
      secretHash: sha256Hex(secret),
      approval: proved ? 'approved' : 'pending',
      enrolledVia: proved ? 'role-token' : 'hello',
      remoteAddr: clientAddress(c),
    });
    log.info('node registered', {
      node: nodeId,
      role,
      status: node.approval,
      created,
    });
    const config = await loadConfig(deps.store, node);
    return c.json(
      { status: node.approval, heartbeatIntervalSeconds: intervalOf(config) },
      created ? 201 : 200
    );
  };
}

function heartbeat(deps: AppDeps) {
  return async (c: Context): Promise<Response> => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) return auth.response;
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = validateHeartbeat(body.value);
    if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
    if (parsed.value.nodeId !== auth.node.id) {
      return apiError(
        c,
        400,
        'invalid_request',
        'nodeId must equal the id in the credential.'
      );
    }
    const now = deps.now();
    const node = await deps.store.recordHeartbeat(
      auth.node.id,
      parsed.value,
      clientAddress(c),
      now
    );
    if (node === null)
      return apiError(c, 401, 'unauthorized', 'Unknown node. Register again.');
    if (node.approval !== 'approved' && node.approval !== 'pending') {
      return apiError(
        c,
        403,
        node.approval,
        `This node is ${node.approval}. Back off and ask a person.`
      );
    }
    const envelope = envelopeFor(node, await loadConfig(deps.store, node));
    const current = parsed.value.agent.configRevision === envelope.revision;
    return c.json({
      ok: true,
      status: node.approval,
      serverTime: now.toISOString(),
      ...(current ? {} : { config: envelope }),
    });
  };
}

function retire(deps: AppDeps, log: Logger) {
  return async (c: Context): Promise<Response> => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) {
      // A node that already retired itself may ask again.
      return auth.refused === 'retired' ? c.json({ ok: true }) : auth.response;
    }
    await deps.store.setApproval(
      auth.node.id,
      'retired',
      `node:${auth.node.id.slice(0, 4)}`
    );
    log.info('node retired itself', { node: auth.node.id });
    return c.json({ ok: true });
  };
}

export function mountNodeRoutes(
  app: Hono,
  deps: AppDeps,
  options: NodeRouteOptions
): void {
  app.post(
    '/v1/enrollment/check',
    rateLimitGuard(options.registerLimiter),
    enrollmentCheck(deps)
  );
  app.post(
    '/v1/nodes/register',
    rateLimitGuard(options.registerLimiter),
    register(deps, options.log)
  );
  app.post('/v1/heartbeat', heartbeat(deps));
  app.post('/v1/retire', retire(deps, options.log));
}
