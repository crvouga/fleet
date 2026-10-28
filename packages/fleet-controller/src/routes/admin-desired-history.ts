import type { Context, Hono } from 'hono';

import { NODE_ID_PATTERN } from '../auth/node-credential';
import type { AppDeps } from '../deps';
import { annotateHistory } from '../domain/desired-history';

import { adminRoute } from './guards';
import { controllerError } from './http';
import { desiredFor, loadConfig } from './node-config';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function limitOf(c: Context): number | null {
  const raw = c.req.query('limit');
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT
    ? value
    : null;
}

export function mountDesiredHistory(app: Hono, deps: AppDeps): void {
  app.get(
    '/v1/nodes/:id/desired-history',
    adminRoute(deps, async (c) => {
      const id = c.req.param('id') ?? '';
      const node = NODE_ID_PATTERN.test(id)
        ? await deps.store.findNode(id)
        : null;
      if (node === null)
        return controllerError(c, 404, 'not_found', 'No such node.');
      const limit = limitOf(c);
      if (limit === null)
        return controllerError(
          c,
          400,
          'invalid_request',
          `limit must be between 1 and ${MAX_LIMIT}`
        );
      const rows = await deps.store.desiredHistory(node.id, limit);
      return c.json({
        nodeId: node.id,
        current: desiredFor(node, await loadConfig(deps.store, node)),
        history: annotateHistory(rows),
      });
    })
  );
}
