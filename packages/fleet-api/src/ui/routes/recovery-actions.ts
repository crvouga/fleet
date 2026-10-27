import type { Hono } from 'hono';

import type { FleetConfig } from '../../config/schema';
import { validateConfig } from '../../config/schema';
import type { AppDeps } from '../../deps';
import { action, back, type Handler } from './guard';

const NODE_ID = /^[0-9a-f]{64}$/;

/**
 * Recovery operations are settings, not commands: "data, never code". Each
 * sets a time on the node's own settings document, the node acts on it at its
 * next report, and settings history records who pressed it and when. The node
 * page shows the outcome from the node's next report.
 */
const OPERATIONS = {
  'retry-update': {
    section: 'sync',
    key: 'retryBootAfter',
    done: 'The node retries the quarantined kernel at its next update check: it drains, reboots into it, and quarantines it again if it still does not come up healthy.',
  },
  'reopen-admission': {
    section: 'runners',
    key: 'reopenAfter',
    done: 'The node lifts the manual drain at its next report. Low disk space or an update in progress still keep admission closed.',
  },
} as const;

type Operation = keyof typeof OPERATIONS;

function operate(deps: AppDeps, name: Operation): Handler {
  const operation = OPERATIONS[name];
  return action(deps, async (c, actor) => {
    const id = c.req.param('id') ?? '';
    const node = NODE_ID.test(id) ? await deps.store.findNode(id) : null;
    if (node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    const here = `/nodes/${node.id}`;
    const scope = `node:${node.id}` as const;
    const current = ((await deps.store.getSettings(scope))?.value ??
      {}) as Record<string, Record<string, unknown> | undefined>;
    const now = Math.floor(deps.now().getTime() / 1000);
    const next = {
      ...current,
      [operation.section]: {
        ...(current[operation.section] ?? {}),
        [operation.key]: now,
      },
    };
    const result = validateConfig(next);
    if (!result.ok)
      return back(c, here, { kind: 'error', text: result.errors.join(' ') });
    await deps.store.putSettings(scope, result.value as FleetConfig, actor);
    return back(c, here, { kind: 'success', text: operation.done });
  });
}

export function registerRecoveryActions(app: Hono, deps: AppDeps): void {
  app.post('/nodes/:id/recovery/retry-update', operate(deps, 'retry-update'));
  app.post(
    '/nodes/:id/recovery/reopen-admission',
    operate(deps, 'reopen-admission')
  );
}
