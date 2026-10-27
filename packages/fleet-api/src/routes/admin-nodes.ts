import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import type { Approval } from '../types';

import { adminRoute } from './guards';
import { apiError, invalidBody, readJson } from './http';
import { loadConfig } from './node-config';
import { loadView, loadViews } from './node-views';
import { validatePatch } from './patch-body';

const DAY_MS = 24 * 60 * 60 * 1000;

function nodeId(c: Context): string | null {
  const id = c.req.param('id') ?? '';
  return NODE_ID_PATTERN.test(id) ? id : null;
}

function notFound(c: Context): Response {
  return apiError(c, 404, 'not_found', 'No such node.');
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
    const node = await deps.store.patchNode(id, parsed.value, actor);
    return node === null
      ? notFound(c)
      : c.json({ node: await loadView(deps, node) });
  });
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
  app.post('/v1/nodes/:id/approve', changeApproval(deps, 'approved'));
  app.post('/v1/nodes/:id/reject', changeApproval(deps, 'rejected'));
  app.post('/v1/nodes/:id/retire', changeApproval(deps, 'retired'));
  app.delete('/v1/nodes/:id', deleteNode(deps));
}
