import type { Context } from 'hono';
import {
  ENROLLMENT_TOKEN_PATTERN,
  matchEnrollmentToken,
} from '../auth/enrollment-token';
import type { AppDeps } from '../deps';
import { isRecord } from '../domain/heartbeat-fields';
import { parseBinding } from '../enrollment/binding';
import { looksLikeGrant } from '../enrollment/grants';
import { checkGrant, type GrantCheck } from '../enrollment/service';
import { controllerError, readJson } from './http';

const GRANT_MESSAGES: Record<string, string> = {
  enrollment_not_ready:
    'The enrollment token cannot automatically approve this node. Check FLEET_ENROLLMENT_TOKENS or approve the node manually in Fleet.',
  enrollment_grant_expired:
    'This installer grant has expired. Create a new one under Add node and download a fresh fleet-bind.json.',
  enrollment_grant_revoked:
    'This installer grant was revoked. Create a new one under Add node.',
  enrollment_binding_invalid:
    'This installer binding was not issued by this controller or was modified. Download a new one from Add node.',
};

function grantReply(c: Context, result: GrantCheck): Response {
  if (!result.ok)
    return controllerError(
      c,
      401,
      result.code,
      GRANT_MESSAGES[result.code] ?? GRANT_MESSAGES['enrollment_not_ready']!
    );
  const { grant } = result;
  // Read-only and credential-free: state and role, never the token or its hash.
  return c.json({
    ok: true,
    kind: 'grant',
    role: grant.role,
    state: grant.state,
    approval: result.approval,
    expiresAt: grant.expiresAt.toISOString(),
  });
}

async function grantCheck(
  deps: AppDeps,
  token: string,
  body: unknown
): Promise<GrantCheck> {
  const raw = isRecord(body) ? body['binding'] : undefined;
  const binding = raw === undefined ? null : parseBinding(raw);
  if (raw !== undefined && binding === null)
    return { ok: false, code: 'enrollment_binding_invalid' };
  return checkGrant(deps, token, binding);
}

/** Prove that an enrollment token can auto-approve, without registering a
 * node or changing any state. Never echo tokens or their hashes. The role is
 * informational: the controller assigns it, the installer never compares it.
 * A single-use installer grant (with an optional signed binding) is validated
 * without being consumed. */
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
    if (entry !== null) return c.json({ ok: true, role: entry.role });
    if (looksLikeGrant(token))
      return grantReply(c, await grantCheck(deps, token, value));
    return controllerError(
      c,
      401,
      'enrollment_not_ready',
      'The enrollment token cannot automatically approve this node. Check FLEET_ENROLLMENT_TOKENS or approve the node manually in Fleet.'
    );
  };
}
