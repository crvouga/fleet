import { SettingsConflictError } from '../../domain/settings-conflict';
import type { Hono } from 'hono';

import type { FleetConfig } from '../../config/schema';
import { validateConfig } from '../../config/schema';
import type { AppDeps } from '../../deps';
import { recorder } from './action-support';
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
  'rotate-age-key': {
    section: 'secrets',
    key: 'rotateAgeKeyAfter',
    done: 'The node generates a next age identity and reports its recipient. Re-encrypt its role secrets for the next recipient and merge; the node switches once it can decrypt them.',
  },
} as const;

type Operation = keyof typeof OPERATIONS;

type Applied =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'invalid_settings' | 'conflict';
      readonly text: string;
    };

/**
 * Sets the operation's key to now on the node's own settings. Read-modify-write
 * with the revision that was read, so a concurrent edit is never overwritten.
 */
async function applyOperation(
  deps: AppDeps,
  nodeId: string,
  operation: (typeof OPERATIONS)[Operation],
  actor: string
): Promise<Applied> {
  const scope = `node:${nodeId}` as const;
  const stored = await deps.store.getSettings(scope);
  const current = (stored?.value ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const now = Math.floor(deps.now().getTime() / 1000);
  const result = validateConfig({
    ...current,
    [operation.section]: {
      ...(current[operation.section] ?? {}),
      [operation.key]: now,
    },
  });
  if (!result.ok)
    return {
      ok: false,
      reason: 'invalid_settings',
      text: result.errors.join(' '),
    };
  try {
    await deps.store.putSettings(
      scope,
      result.value as FleetConfig,
      actor,
      stored?.revision ?? 0
    );
    return { ok: true };
  } catch (error: unknown) {
    if (!(error instanceof SettingsConflictError)) throw error;
    return {
      ok: false,
      reason: 'conflict',
      text: 'The node’s settings changed while you were acting. Reload the page and try again.',
    };
  }
}

function operate(deps: AppDeps, name: Operation): Handler {
  const operation = OPERATIONS[name];
  return action(deps, async (c, actor) => {
    const audit = recorder(deps, actor);
    const verb = `recovery.${name}`;
    const id = c.req.param('id') ?? '';
    const node = NODE_ID.test(id) ? await deps.store.findNode(id) : null;
    if (node === null) {
      await audit(
        verb,
        { id: null, outcome: 'failed' },
        { reason: 'not_found' }
      );
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    }
    const here = `/nodes/${node.id}`;
    const applied = await applyOperation(deps, node.id, operation, actor);
    if (!applied.ok) {
      await audit(
        verb,
        { id: node.id, outcome: 'failed' },
        { reason: applied.reason }
      );
      return back(c, here, { kind: 'error', text: applied.text });
    }
    await audit(
      verb,
      { id: node.id },
      { setting: `${operation.section}.${operation.key}` }
    );
    return back(c, here, { kind: 'success', text: operation.done });
  });
}

export function registerRecoveryActions(app: Hono, deps: AppDeps): void {
  app.post('/nodes/:id/recovery/retry-update', operate(deps, 'retry-update'));
  app.post(
    '/nodes/:id/recovery/reopen-admission',
    operate(deps, 'reopen-admission')
  );
  app.post(
    '/nodes/:id/recovery/rotate-age-key',
    operate(deps, 'rotate-age-key')
  );
}
