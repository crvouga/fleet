import type { Context, Hono } from 'hono';

import type { AppDeps } from '../../deps';
import { confirmationMatches } from '../../domain/operations';
import {
  requestOperation,
  type OperationRequest,
} from '../../operations/request';
import { cancelOperation, undrainNode } from '../../operations/withdraw';
import { NODE_ID_PATTERN } from '../../auth/node-credential';
import type { NodeRow } from '../../types';
import { recorder, typedPrompt } from './action-support';
import { action, back, safeNext, type Handler } from './guard';

type Kind = 'drain' | 'undrain' | 'restart' | 'replace' | 'decommission';
const KINDS: readonly Kind[] = [
  'drain',
  'undrain',
  'restart',
  'replace',
  'decommission',
];
const CONFIRMED: readonly Kind[] = ['restart', 'replace', 'decommission'];

async function form(c: Context): Promise<Record<string, unknown>> {
  return (await c.req.parseBody()) as Record<string, unknown>;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const checked = (value: unknown): boolean =>
  value === 'on' || value === 'true' || value === '1';

function requestOf(
  kind: Exclude<Kind, 'undrain'>,
  node: NodeRow,
  actor: string,
  fields: Record<string, unknown>
): OperationRequest {
  const replacement = text(fields['replacement']);
  const reason = text(fields['reason']);
  return {
    kind,
    nodeId: node.id,
    actor,
    ...(checked(fields['force']) ? { force: true } : {}),
    ...(replacement === undefined ? {} : { replacement }),
    ...(reason === undefined ? {} : { reason: reason.slice(0, 200) }),
  };
}

const STARTED: Readonly<Record<Exclude<Kind, 'undrain'>, string>> = {
  drain:
    'Drain requested. The node finishes its running jobs and takes no new ones.',
  restart:
    'Restart requested. The node drains, waits until it is idle and reboots once.',
  replace:
    'Replace requested. The old node is cordoned while the replacement is approved and converges.',
  decommission:
    'Decommission requested. The node drains first, then it is retired.',
};

async function start(
  deps: AppDeps,
  c: Context,
  kind: Exclude<Kind, 'undrain'>,
  node: NodeRow
): Promise<Response> {
  const actor = (await deps.auth.actor(c)) ?? 'unknown';
  const fields = await form(c);
  const here = safeNext(fields['next'], `/nodes/${node.id}`);
  if (
    CONFIRMED.includes(kind) &&
    !confirmationMatches(fields['confirm'], node)
  ) {
    await recorder(deps, actor)(
      kind,
      { id: node.id, outcome: 'denied' },
      {
        reason: 'confirmation_required',
      }
    );
    return back(c, here, { kind: 'error', text: typedPrompt(node, kind) });
  }
  const outcome = await requestOperation(
    deps,
    requestOf(kind, node, actor, fields)
  );
  return outcome.ok
    ? back(c, here, { kind: 'success', text: STARTED[kind] })
    : back(c, here, { kind: 'error', text: outcome.message });
}

function operate(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const kind = KINDS.find((candidate) => candidate === c.req.param('kind'));
    const id = c.req.param('id') ?? '';
    const node = NODE_ID_PATTERN.test(id)
      ? await deps.store.findNode(id)
      : null;
    if (kind === undefined || node === null)
      return back(c, '/nodes', {
        kind: 'error',
        text: 'That node no longer exists.',
      });
    if (kind !== 'undrain') return start(deps, c, kind, node);
    const done = await undrainNode(deps, node.id, actor);
    return back(
      c,
      `/nodes/${node.id}`,
      done.ok
        ? {
            kind: 'success',
            text: done.stillCordoned
              ? 'The node’s own cordon is lifted, but a role or fleet setting still cordons it.'
              : 'Undrained. The node accepts new jobs again.',
          }
        : { kind: 'error', text: done.message }
    );
  });
}

function cancel(deps: AppDeps): Handler {
  return action(deps, async (c, actor) => {
    const done = await cancelOperation(deps, c.req.param('id') ?? '', actor);
    const fields = await form(c);
    const next = safeNext(fields['next'], '/operations');
    return back(
      c,
      next,
      done.ok
        ? {
            kind: 'success',
            text: 'Cancelled. The node is back to its previous settings.',
          }
        : { kind: 'error', text: done.message }
    );
  });
}

export function registerOperationActions(app: Hono, deps: AppDeps): void {
  app.post('/nodes/:id/operations/:kind', operate(deps));
  app.post('/operations/:id/cancel', cancel(deps));
}
