import type { Context } from 'hono';
import {
  ENROLLMENT_TOKEN_PATTERN,
  matchEnrollmentToken,
} from '../auth/enrollment-token';
import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import { controllerError, readJson } from './http';

/** Prove that an enrollment token can auto-approve, without registering a
 * node or changing any state. Never echo tokens or their hashes. The role is
 * informational: the controller assigns it, the installer never compares it. */
export function enrollmentCheck(deps: AppDeps) {
  return async (c: Context): Promise<Response> => {
    const body = await readJson(c);
    if (!body.ok) return body.response;
    const value = body.value;
    const token = isRecord(value) ? value['enrollmentToken'] : undefined;
    if (typeof token !== 'string' || !ENROLLMENT_TOKEN_PATTERN.test(token))
      return controllerError(
        c,
        400,
        'invalid_request',
        'Supply enrollmentToken: 8 to 512 letters, digits, dots, underscores or dashes.'
      );
    const entry = matchEnrollmentToken(deps.env.enrollmentTokens, token);
    if (entry === null)
      return controllerError(
        c,
        401,
        'enrollment_not_ready',
        'The enrollment token cannot automatically approve this node. Check FLEET_ENROLLMENT_TOKENS or approve the node manually in Fleet.'
      );
    return c.json({ ok: true, role: entry.role });
  };
}
