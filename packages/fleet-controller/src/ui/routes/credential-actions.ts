import type { Context, Hono } from 'hono';

import type { AppDeps } from '../../deps';
import {
  confirmedRevocation,
  requestRotation,
  revokeCredential,
} from '../../routes/credential-service';
import type { NodeRow } from '../../types';
import { action, back, type Handler } from './guard';

const NODE_ID = /^[0-9a-f]{64}$/;
const MAX_REASON = 200;

async function find(deps: AppDeps, c: Context): Promise<NodeRow | null> {
  const id = c.req.param('id') ?? '';
  return NODE_ID.test(id) ? deps.store.findNode(id) : null;
}

const label = (node: NodeRow) => node.displayName ?? node.hostname;

function rotate(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const node = await find(deps, c);
    if (node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    const here = `/nodes/${node.id}`;
    const result = await requestRotation(deps, node, actor);
    if (!result.ok)
      return back(c, here, {
        kind: 'error',
        text: 'This node’s credential is revoked: it must register again and be approved before it can rotate.',
      });
    return back(c, here, {
      kind: 'success',
      text: `${label(node)} will rotate its credential on its next heartbeat.`,
    });
  });
}

function revoke(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const node = await find(deps, c);
    if (node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    const here = `/nodes/${node.id}`;
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    if (!(await confirmedRevocation(deps, node, actor, form['confirm'])))
      return back(c, here, {
        kind: 'error',
        text: `To revoke ${label(node)}, type its name (${label(node)}) in the confirmation box.`,
      });
    const reason =
      typeof form['reason'] === 'string' ? form['reason'].trim() : '';
    await revokeCredential(
      deps,
      node,
      actor,
      reason === '' ? null : reason.slice(0, MAX_REASON)
    );
    return back(c, here, {
      kind: 'success',
      text: `${label(node)} credential revoked. The node is locked out; if it registers again it waits for approval.`,
    });
  });
}

export function registerCredentialActions(app: Hono, deps: AppDeps): void {
  app.post('/nodes/:id/credential/rotate', rotate(deps));
  app.post('/nodes/:id/credential/revoke', revoke(deps));
}
