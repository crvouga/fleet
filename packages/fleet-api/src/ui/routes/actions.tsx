import type { Context, Hono } from 'hono';

import type { AppDeps } from '../../deps';
import type { Approval, NodeRow } from '../../types';
import { parseEdit } from '../lib/node-edit';
import { action, back, safeNext, type Handler } from './guard';
import { registerRecoveryActions } from './recovery-actions';

interface Transition {
  readonly to: Approval;
  readonly from: readonly Approval[];
  readonly done: string;
  readonly confirm?: boolean;
}

const TRANSITIONS: Readonly<Record<string, Transition>> = {
  approve: { to: 'approved', from: ['pending', 'rejected'], done: 'approved' },
  reject: { to: 'rejected', from: ['pending'], done: 'rejected' },
  retire: { to: 'retired', from: ['approved'], done: 'retired', confirm: true },
};

const NODE_ID = /^[0-9a-f]{64}$/;

async function body(c: Context): Promise<Record<string, unknown>> {
  return (await c.req.parseBody()) as Record<string, unknown>;
}

async function findNode(deps: AppDeps, c: Context): Promise<NodeRow | null> {
  const id = c.req.param('id') ?? '';
  return NODE_ID.test(id) ? deps.store.findNode(id) : null;
}

function transition(deps: AppDeps, name: string): Handler {
  const rule = TRANSITIONS[name];
  return action(deps, async (c, actor) => {
    const form = await body(c);
    const node = await findNode(deps, c);
    if (rule === undefined || node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    const here = `/nodes/${node.id}`;
    const next = safeNext(form['next'], here);
    if (rule.confirm === true && form['confirm'] !== 'yes') {
      return back(c, here, {
        kind: 'error',
        text: 'Please confirm before changing this node.',
      });
    }
    if (!rule.from.includes(node.approval)) {
      return back(c, next, {
        kind: 'error',
        text: `${node.hostname} is ${node.approval}, so it cannot be ${rule.done}.`,
      });
    }
    await deps.store.setApproval(node.id, rule.to, actor);
    return back(c, next, {
      kind: 'success',
      text: `${node.displayName ?? node.hostname} ${rule.done}.`,
    });
  });
}

function remove(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const form = await body(c);
    const node = await findNode(deps, c);
    if (node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    if (form['confirm'] !== 'yes') {
      return back(c, `/nodes/${node.id}`, {
        kind: 'error',
        text: 'Please confirm before deleting a node.',
      });
    }
    await deps.store.deleteNode(node.id, actor);
    return back(c, '/nodes', {
      kind: 'success',
      text: `${node.displayName ?? node.hostname} deleted.`,
    });
  });
}

function edit(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const node = await findNode(deps, c);
    if (node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    const parsed = parseEdit(await body(c));
    const here = `/nodes/${node.id}`;
    if (!parsed.ok) return back(c, here, { kind: 'error', text: parsed.error });
    await deps.store.patchNode(node.id, parsed.patch, actor);
    return back(c, here, { kind: 'success', text: 'Saved.' });
  });
}

export function registerActions(app: Hono, deps: AppDeps): void {
  app.post('/nodes/:id/approve', transition(deps, 'approve'));
  app.post('/nodes/:id/reject', transition(deps, 'reject'));
  app.post('/nodes/:id/retire', transition(deps, 'retire'));
  app.post('/nodes/:id/delete', remove(deps));
  app.post('/nodes/:id/edit', edit(deps));
  registerRecoveryActions(app, deps);
}
