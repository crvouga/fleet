import type { Context } from 'hono';

import { confirmationFor, confirmationMatches } from '../domain/operations';
import { auditAction, type OpsDeps } from '../operations/context';
import type { NodeRow } from '../types';

import { controllerError } from './http';

/** A body that may be empty: actions without parameters send none. */
export async function readOptionalJson(
  c: Context
): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  const text = await c.req.text();
  if (text.trim().length === 0) return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return { ok: true, value: value as Record<string, unknown> };
  } catch {
    // fall through to the 400 below
  }
  return {
    ok: false,
    response: controllerError(
      c,
      400,
      'invalid_request',
      'The body must be a JSON object.'
    ),
  };
}

/** What the person is told to type; also the 400 body's `message`. */
export function confirmationMessage(node: NodeRow, action: string): string {
  return `This will ${action} ${confirmationFor(node)}. Send "confirm": "${confirmationFor(node)}" (the node's name) to proceed.`;
}

/**
 * Server-side destructive confirmation: `typed` must name the node. Returns
 * the 400 `confirmation_required` response (and records the refusal in the
 * audit trail) when it does not, else null. The UI enforces the same rule.
 */
export async function requireConfirmation(
  deps: OpsDeps,
  c: Context,
  request: {
    readonly node: NodeRow;
    readonly typed: unknown;
    readonly action: string;
    readonly actor: string;
    readonly auditAs: string;
  }
): Promise<Response | null> {
  if (confirmationMatches(request.typed, request.node)) return null;
  await auditAction(deps, {
    actor: request.actor,
    action: request.auditAs,
    targetId: request.node.id,
    outcome: 'denied',
    detail: { reason: 'confirmation_required' },
  });
  return c.json(
    {
      error: 'confirmation_required',
      message: confirmationMessage(request.node, request.action),
      expected: confirmationFor(request.node),
    },
    400
  );
}
