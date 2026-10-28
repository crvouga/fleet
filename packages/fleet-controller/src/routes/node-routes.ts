import type { Logger } from '@pkgs/logger';
import type { Context, Hono } from 'hono';

import { sha256Hex } from '../auth/hash';
import { parseNodeCredential } from '../auth/node-credential';
import { matchEnrollmentToken } from '../auth/enrollment-token';
import type { AppDeps } from '../deps';
import {
  protocolVersionOf,
  validateHeartbeat,
} from '../domain/heartbeat-validation';
import type { RateLimiter } from '../domain/rate-limit';
import type { HeartbeatBody, NodeRow } from '../types';

import {
  controllerError,
  clientAddress,
  invalidBody,
  rateLimitGuard,
  readJson,
} from './http';
import { desiredFor, intervalOf, loadConfig } from './node-config';
import { validateRegister } from './register-body';
import { enrollmentCheck } from './enrollment-check';
import { mountEnrollmentGrants } from './enrollment-grants';
import { registerEnrolled } from '../enrollment/service';
import { settleOperations } from '../operations/reconcile';
import { credentialHint, recordDesiredBestEffort } from './credential-hint';

export interface NodeRouteOptions {
  readonly registerLimiter: RateLimiter;
  readonly log: Logger;
}

export type Authenticated =
  | { readonly node: NodeRow }
  | {
      readonly response: Response;
      /** Set when the caller proved it holds the secret of a refused node. */
      readonly refused: 'rejected' | 'retired' | null;
    };

/** 401 for an unknown id or wrong secret; 403 only to a caller that holds the secret. */
export async function authenticate(
  c: Context,
  deps: AppDeps
): Promise<Authenticated> {
  const credential = parseNodeCredential(c.req.header('authorization'));
  if (credential === null) {
    return {
      response: controllerError(
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
      response: controllerError(
        c,
        403,
        known.approval,
        `This node is ${known.approval}. Back off and ask a person.`
      ),
      refused: known.approval,
    };
  }
  return {
    response: controllerError(
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
    const { nodeId, hostname, secret, enrollmentToken } = parsed.value;
    const entry = matchEnrollmentToken(
      deps.env.enrollmentTokens,
      enrollmentToken
    );
    if (enrollmentToken !== undefined && entry === null) {
      log.warn(
        'registration presented an enrollment token that did not match',
        {
          node: nodeId,
        }
      );
    }
    const { node, created } = await registerEnrolled(deps, enrollmentToken, {
      id: nodeId,
      hostname,
      secretHash: sha256Hex(secret),
      approval: entry === null ? 'pending' : 'approved',
      tokenRole: entry?.role ?? null,
      enrolledVia: entry === null ? 'hello' : 'enrollment-token',
      remoteAddr: clientAddress(c),
    });
    log.info('node registered', {
      node: nodeId,
      role: node.role,
      status: node.approval,
      created,
    });
    const config = await loadConfig(deps.store, node);
    return c.json(
      {
        status: node.approval,
        heartbeatIntervalSeconds: intervalOf(config),
        role: node.role,
      },
      created ? 201 : 200
    );
  };
}

/** The validated v2 report of the authenticated node, or the 400 to answer. */
async function readReport(
  c: Context,
  nodeId: string
): Promise<
  { readonly report: HeartbeatBody } | { readonly response: Response }
> {
  const body = await readJson(c);
  if (!body.ok) return body;
  const version = protocolVersionOf(body.value);
  if (typeof version === 'number' && version !== 2)
    return {
      response: controllerError(
        c,
        400,
        'unsupported_version',
        'This controller speaks heartbeat protocol v2. Update the node agent from Git.'
      ),
    };
  const parsed = validateHeartbeat(body.value);
  if (!parsed.ok)
    return { response: invalidBody(c, 'invalid_request', parsed.errors) };
  if (parsed.value.nodeId !== nodeId)
    return {
      response: controllerError(
        c,
        400,
        'invalid_request',
        'nodeId must equal the id in the credential.'
      ),
    };
  return { report: parsed.value };
}

function heartbeat(deps: AppDeps) {
  return async (c: Context): Promise<Response> => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) return auth.response;
    const read = await readReport(c, auth.node.id);
    if ('response' in read) return read.response;
    const now = deps.now();
    const node = await deps.store.recordHeartbeat(
      auth.node.id,
      read.report,
      clientAddress(c),
      now
    );
    if (node === null)
      return controllerError(
        c,
        401,
        'unauthorized',
        'Unknown node. Register again.'
      );
    if (node.approval !== 'approved' && node.approval !== 'pending') {
      return controllerError(
        c,
        403,
        node.approval,
        `This node is ${node.approval}. Back off and ask a person.`
      );
    }
    // Operations settle first, so intent recorded now reaches this response.
    const settled = await settleOperations(deps, node);
    const desired = desiredFor(settled, await loadConfig(deps.store, settled));
    const current = read.report.agent.desiredRevision === desired.revision;
    // Desired history and the credential flag are additive and best effort:
    // neither may make a heartbeat fail.
    await recordDesiredBestEffort(deps, node.id, desired);
    const credential = await credentialHint(deps, node.id);
    return c.json({
      ok: true,
      status: node.approval,
      serverTime: now.toISOString(),
      ...(current ? {} : { desired }),
      ...credential,
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
  mountEnrollmentGrants(app, deps);
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
  app.get('/v1/enrollment/status', async (c) => {
    const auth = await authenticate(c, deps);
    if ('response' in auth) return auth.response;
    return c.json({
      nodeId: auth.node.id,
      status: auth.node.approval,
      role: auth.node.role,
    });
  });
  app.post('/v1/heartbeat', heartbeat(deps));
  app.post('/v1/retire', retire(deps, options.log));
}
