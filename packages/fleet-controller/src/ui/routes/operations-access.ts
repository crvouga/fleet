import type { Context } from 'hono';

import { mayWrite, VIEWER_DENIED_MESSAGE } from '../../auth/roles';
import type { AppDeps } from '../../deps';
import { auditDenied, roleOf } from '../../routes/guards';

/** The audit log is for administrators: a viewer gets 403 (audited), an admin null. */
export async function requireAdminPage(
  deps: AppDeps,
  c: Context,
  actor: string
): Promise<Response | null> {
  const role = await roleOf(deps, c);
  if (mayWrite(role)) return null;
  await auditDenied(deps, c, { actor, role }, 'audit.read');
  return c.text(`Forbidden: ${VIEWER_DENIED_MESSAGE}`, 403);
}
