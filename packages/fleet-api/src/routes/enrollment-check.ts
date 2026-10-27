import type { Context } from 'hono';
import { roleTokenValid } from '../auth/role-token';
import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import { isActiveRole } from '../types';
import { apiError, readJson } from './http';

/** Prove that the installed credential can auto-approve, without registering a
 * node or changing any state. Never echo credentials or approval hashes. */
export function enrollmentCheck(deps: AppDeps) {
  return async (c: Context): Promise<Response> => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const value = body.value;
    if (
      !isRecord(value) ||
      !isActiveRole(value['role']) ||
      typeof value['roleToken'] !== 'string' ||
      value['roleToken'].length > 512
    )
      return apiError(
        c,
        400,
        'invalid_request',
        'Supply the role and its enrollment credential.'
      );
    if (
      !roleTokenValid(
        deps.env.roleTokenHashes,
        value['role'],
        value['roleToken']
      )
    )
      return apiError(
        c,
        401,
        'enrollment_not_ready',
        'The role credential cannot automatically approve this node. Resolve Fleet/Vault credential configuration before installation.'
      );
    return c.json({ ok: true, role: value['role'] });
  };
}
