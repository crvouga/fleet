import type { AppDeps } from '../../deps';
import { confirmationFor } from '../../domain/operations';
import { auditAction } from '../../operations/context';
import type { NodeRow } from '../../types';

/** What the person is told to type; the same rule the JSON API enforces. */
export function typedPrompt(node: NodeRow, verb: string): string {
  const name = confirmationFor(node);
  return `To ${verb} ${name}, type its name (${name}) in the confirmation box.`;
}

type Target = {
  readonly id: string | null;
  readonly outcome?: 'denied' | 'failed';
};

/** Who did what to which node, and how it ended. The returned function never throws. */
export function recorder(deps: AppDeps, actor: string) {
  return (
    verb: string,
    target: Target,
    detail: Record<string, unknown> = {}
  ): Promise<void> =>
    auditAction(deps, {
      actor,
      action: `node.${verb}`,
      targetId: target.id,
      ...(target.outcome === undefined ? {} : { outcome: target.outcome }),
      detail: { via: 'dashboard', ...detail },
    });
}
