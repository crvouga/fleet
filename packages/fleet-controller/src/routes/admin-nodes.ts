import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import { auditAction } from '../operations/context';
import type { ActiveRole, NodeRow } from '../types';

import { readOptionalJson, requireConfirmation } from './confirmation';
import { adminRoute } from './guards';
import { controllerError, invalidBody, readJson } from './http';
import { loadConfig } from './node-config';
import { loadView, loadViews } from './node-views';
import { readAssignedRole, validatePatch, type NodeChange } from './patch-body';
import { recipientsOf } from './recipients';

const DAY_MS = 24 * 60 * 60 * 1000;

function nodeId(c: Context): string | null {
  const id = c.req.param('id') ?? '';
  return NODE_ID_PATTERN.test(id) ? id : null;
}

function notFound(c: Context): Response {
  return controllerError(c, 404, 'not_found', 'No such node.');
}

function listNodes(deps: AppDeps) {
  return adminRoute(deps, async (c) =>
    c.json({ nodes: await loadViews(deps) })
  );
}

function showNode(deps: AppDeps) {
  return adminRoute(deps, async (c) => {
    const id = nodeId(c);
    const node = id === null ? null : await deps.store.findNode(id);
    if (node === null) return notFound(c);
    const since = new Date(deps.now().getTime() - DAY_MS);
    const [view, heartbeats, config] = await Promise.all([
      loadView(deps, node),
      deps.store.listHeartbeats(node.id, since),
      loadConfig(deps.store, node),
    ]);
    return c.json({ node: view, heartbeats, config });
  });
}

async function applyChange(
  deps: AppDeps,
  id: string,
  change: NodeChange,
  actor: string
): Promise<NodeRow | null> {
  let node = await deps.store.findNode(id);
  if (node !== null && Object.keys(change.patch).length > 0)
    node = await deps.store.patchNode(id, change.patch, actor);
  if (node !== null && change.role !== undefined)
    node = await deps.store.assignRole(id, change.role, actor);
  return node;
}

function patchNode(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const id = nodeId(c);
    if (id === null) return notFound(c);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = validatePatch(body.value);
    const subject = { actor, action: 'node.patch', id };
    if (!parsed.ok) {
      await record(deps, subject, 'failed', { reason: 'invalid_request' });
      return invalidBody(c, 'invalid_request', parsed.errors);
    }
    const node = await applyChange(deps, id, parsed.value, actor);
    await record(deps, subject, node === null ? 'failed' : 'success', {
      changed: Object.keys(parsed.value.patch),
      ...(parsed.value.role === undefined ? {} : { role: parsed.value.role }),
    });
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
  });
}

interface Subject {
  readonly actor: string;
  readonly action: string;
  readonly id: string | null;
}

/** One audit entry per admin node action: who, what, which node, and how it ended. */
function record(
  deps: AppDeps,
  subject: Subject,
  outcome: 'success' | 'denied' | 'failed',
  detail: Record<string, unknown> = {}
): Promise<void> {
  return auditAction(deps, {
    actor: subject.actor,
    action: subject.action,
    targetId: subject.id,
    outcome,
    detail,
  });
}

/** Approve takes an optional JSON body `{ role }` that assigns the role too. */
async function approvalRole(
  c: Context
): Promise<{ role?: ActiveRole | null } | { errors: string[] }> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { errors: ['The body must be valid JSON.'] };
  }
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: ['body must be a JSON object'] };
  for (const key of Object.keys(value))
    if (key !== 'role') errors.push(`${key} cannot be set on approval`);
  const role = readAssignedRole(value['role'], errors);
  if (errors.length > 0) return { errors };
  return role === undefined ? {} : { role };
}

function approve(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const id = nodeId(c);
    if (id === null) return notFound(c);
    const body = await approvalRole(c);
    if ('errors' in body) {
      await record(deps, { actor, action: 'node.approve', id }, 'failed', {
        reason: 'invalid_request',
      });
      return invalidBody(c, 'invalid_request', body.errors);
    }
    let node = await deps.store.setApproval(id, 'approved', actor);
    if (node !== null && body.role !== undefined)
      node = await deps.store.assignRole(id, body.role, actor);
    await record(
      deps,
      { actor, action: 'node.approve', id },
      node === null ? 'failed' : 'success',
      {
        ...(body.role === undefined ? {} : { role: body.role }),
      }
    );
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
  });
}

function recipients(deps: AppDeps) {
  return adminRoute(deps, async (c) =>
    c.json(recipientsOf(await deps.store.listNodes()))
  );
}

/** The node and a confirmed body for a destructive action, else the response that refuses. */
async function confirmed(
  deps: AppDeps,
  c: Context,
  actor: string,
  action: 'reject' | 'retire' | 'delete'
): Promise<{ readonly node: NodeRow } | { readonly response: Response }> {
  const id = nodeId(c);
  const node = id === null ? null : await deps.store.findNode(id);
  if (node === null) {
    await record(deps, { actor, action: `node.${action}`, id }, 'failed', {
      reason: 'not_found',
    });
    return { response: notFound(c) };
  }
  const body = await readOptionalJson(c);
  if (!body.ok) return body;
  const refused = await requireConfirmation(deps, c, {
    node,
    typed: body.value['confirm'],
    action,
    actor,
    auditAs: `node.${action}`,
  });
  return refused === null ? { node } : { response: refused };
}

function changeApproval(deps: AppDeps, action: 'reject' | 'retire') {
  return adminRoute(deps, async (c, actor) => {
    const ready = await confirmed(deps, c, actor, action);
    if ('response' in ready) return ready.response;
    const to = action === 'reject' ? 'rejected' : 'retired';
    const node = await deps.store.setApproval(ready.node.id, to, actor);
    await record(
      deps,
      { actor, action: `node.${action}`, id: ready.node.id },
      node === null ? 'failed' : 'success',
      {
        from: ready.node.approval,
      }
    );
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
  });
}

function deleteNode(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const ready = await confirmed(deps, c, actor, 'delete');
    if ('response' in ready) return ready.response;
    const removed = await deps.store.deleteNode(ready.node.id, actor);
    await record(
      deps,
      { actor, action: 'node.delete', id: ready.node.id },
      removed ? 'success' : 'failed',
      {
        hostname: ready.node.hostname,
        approval: ready.node.approval,
      }
    );
    return removed ? c.json({ ok: true }) : notFound(c);
  });
}

export function mountAdminNodes(app: Hono, deps: AppDeps): void {
  app.get('/v1/nodes', listNodes(deps));
  app.get('/v1/nodes/:id', showNode(deps));
  app.patch('/v1/nodes/:id', patchNode(deps));
  app.post('/v1/nodes/:id/approve', approve(deps));
  app.post('/v1/nodes/:id/reject', changeApproval(deps, 'reject'));
  app.post('/v1/nodes/:id/retire', changeApproval(deps, 'retire'));
  app.delete('/v1/nodes/:id', deleteNode(deps));
  app.get('/v1/recipients', recipients(deps));
}
