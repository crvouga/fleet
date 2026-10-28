import { ENROLLMENT_TOKEN_PATTERN } from '../auth/enrollment-token';
import { NODE_ID_PATTERN, NODE_SECRET_PATTERN } from '../auth/node-credential';
import {
  isRecord,
  readString,
  requireString,
  type Problems,
} from '../domain/heartbeat-fields';

/**
 * `POST /v1/nodes/register`. A node does not name a role: `role` and
 * `roleToken` from older agents are ignored, never stored.
 */
export interface RegisterBody {
  readonly nodeId: string;
  readonly hostname: string;
  readonly secret: string;
  readonly enrollmentToken: string | undefined;
}

export type RegisterResult =
  | { readonly ok: true; readonly value: RegisterBody }
  | { readonly ok: false; readonly errors: readonly string[] };

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const MAX_ENROLLMENT_TOKEN = 512;

export function validateRegister(input: unknown): RegisterResult {
  if (!isRecord(input))
    return { ok: false, errors: ['body must be a JSON object'] };
  const problems: Problems = { list: [] };
  const nodeId = requireString(problems, 'nodeId', input['nodeId'], {
    max: 64,
    pattern: NODE_ID_PATTERN,
  });
  const hostname = requireString(problems, 'hostname', input['hostname'], {
    max: 63,
    pattern: HOSTNAME,
  });
  const secret = requireString(problems, 'secret', input['secret'], {
    max: 64,
    pattern: NODE_SECRET_PATTERN,
  });
  const enrollmentToken = readString(
    problems,
    'enrollmentToken',
    input['enrollmentToken'],
    { max: MAX_ENROLLMENT_TOKEN, pattern: ENROLLMENT_TOKEN_PATTERN }
  );
  if (problems.list.length > 0) return { ok: false, errors: problems.list };
  return {
    ok: true,
    value: {
      nodeId,
      hostname,
      secret,
      enrollmentToken: enrollmentToken ?? undefined,
    },
  };
}
