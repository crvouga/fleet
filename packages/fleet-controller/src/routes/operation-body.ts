import {
  IDEMPOTENCY_KEY,
  MAX_TIMEOUT_SECONDS,
  MIN_TIMEOUT_SECONDS,
} from '../domain/operations';
import { NODE_ID_PATTERN } from '../auth/node-credential';

export type ActionName =
  'drain' | 'undrain' | 'restart' | 'replace' | 'decommission';

export interface ActionBody {
  readonly confirm?: unknown;
  readonly force?: boolean;
  readonly replacement?: string;
  readonly reason?: string;
  readonly timeoutSeconds?: number;
}

export type ActionBodyResult =
  | { readonly ok: true; readonly value: ActionBody }
  | { readonly ok: false; readonly errors: readonly string[] };

const ALLOWED: Readonly<Record<ActionName, readonly string[]>> = {
  drain: ['reason', 'timeoutSeconds'],
  undrain: [],
  restart: ['confirm', 'timeoutSeconds'],
  replace: ['confirm', 'replacement', 'timeoutSeconds'],
  decommission: ['confirm', 'force', 'timeoutSeconds'],
};

const MAX_REASON = 200;
const CONTROL = /[\u0000-\u001f\u007f]/;

function unknownKeys(
  action: ActionName,
  body: Readonly<Record<string, unknown>>
): string[] {
  return Object.keys(body)
    .filter((key) => !ALLOWED[action].includes(key))
    .map((key) => `${key} is not accepted by ${action}`);
}

const checks: readonly [string, (value: unknown) => boolean, string][] = [
  ['force', (v) => typeof v === 'boolean', 'force must be true or false'],
  [
    'replacement',
    (v) => typeof v === 'string' && NODE_ID_PATTERN.test(v),
    'replacement must be a 64-character node id',
  ],
  [
    'reason',
    (v) => typeof v === 'string' && v.length <= MAX_REASON && !CONTROL.test(v),
    `reason must be plain text of at most ${MAX_REASON} characters`,
  ],
  [
    'timeoutSeconds',
    (v) =>
      typeof v === 'number' &&
      Number.isInteger(v) &&
      v >= MIN_TIMEOUT_SECONDS &&
      v <= MAX_TIMEOUT_SECONDS,
    `timeoutSeconds must be a whole number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`,
  ],
];

function fieldErrors(body: Readonly<Record<string, unknown>>): string[] {
  return checks
    .filter(([key, valid]) => body[key] !== undefined && !valid(body[key]))
    .map(([, , message]) => message);
}

/** Strict: an unknown key is an error, so a typo cannot silently do nothing. */
export function parseActionBody(
  action: ActionName,
  body: Readonly<Record<string, unknown>>
): ActionBodyResult {
  const errors = [...unknownKeys(action, body), ...fieldErrors(body)];
  if (action === 'replace' && body['replacement'] === undefined)
    errors.push('replacement is required: the id of the new machine');
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: body as ActionBody };
}

export function idempotencyKeyOf(
  header: string | undefined
): string | null | 'invalid' {
  if (header === undefined) return null;
  const trimmed = header.trim();
  return IDEMPOTENCY_KEY.test(trimmed) ? trimmed : 'invalid';
}
