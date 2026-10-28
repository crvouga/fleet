import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import type { ActiveRole, Approval } from '../types';

import { adminRoute } from './guards';
import { controllerError, invalidBody, readJson } from './http';
import { loadConfig } from './node-config';
import { loadView, loadViews } from './node-views';
import { readAssignedRole, validatePatch } from './patch-body';
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

function patchNode(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const id = nodeId(c);
    if (id === null) return notFound(c);
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const parsed = validatePatch(body.value);
    if (!parsed.ok) return invalidBody(c, 'invalid_request', parsed.errors);
    const { patch, role } = parsed.value;
    let node = await deps.store.findNode(id);
    if (node !== null && Object.keys(patch).length > 0)
      node = await deps.store.patchNode(id, patch, actor);
    if (node !== null && role !== undefined)
      node = await deps.store.assignRole(id, role, actor);
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
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
    if ('errors' in body) return invalidBody(c, 'invalid_request', body.errors);
    let node = await deps.store.setApproval(id, 'approved', actor);
    if (node !== null && body.role !== undefined)
      node = await deps.store.assignRole(id, body.role, actor);
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

function changeApproval(deps: AppDeps, approval: Approval) {
  return adminRoute(deps, async (c, actor) => {
    const id = nodeId(c);
    const node =
      id === null ? null : await deps.store.setApproval(id, approval, actor);
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
  });
}

function deleteNode(deps: AppDeps) {
  return adminRoute(deps, async (c, actor) => {
    const id = nodeId(c);
    const removed =
      id === null ? false : await deps.store.deleteNode(id, actor);
    return removed ? c.json({ ok: true }) : notFound(c);
  });
}

export function mountAdminNodes(app: Hono, deps: AppDeps): void {
  app.get('/v1/nodes', listNodes(deps));
  app.get('/v1/nodes/:id', showNode(deps));
  app.patch('/v1/nodes/:id', patchNode(deps));
  app.post('/v1/nodes/:id/approve', approve(deps));
  app.post('/v1/nodes/:id/reject', changeApproval(deps, 'rejected'));
  app.post('/v1/nodes/:id/retire', changeApproval(deps, 'retired'));
  app.delete('/v1/nodes/:id', deleteNode(deps));
  app.get('/v1/recipients', recipients(deps));
}
