import type { Context } from 'hono';

import { isRecord } from '../domain/heartbeat-fields';

import { controllerError, readJson } from './http';

/** What every settings write carries besides the document itself. */
export interface Preconditions {
  readonly expectedRevision: number | undefined;
  readonly acknowledge: readonly string[];
}

export interface WriteRequest extends Preconditions {
  /** The settings document itself. */
  readonly document: unknown;
}

type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

const ENVELOPE_KEYS = ['value', 'expectedRevision', 'acknowledge'];
const REVISION = /^(?:W\/)?"?(\d{1,15})"?$/;
const CODE = /^[a-z0-9_]{1,60}$/;

function refuse(
  c: Context,
  message: string
): { ok: false; response: Response } {
  return {
    ok: false,
    response: controllerError(c, 400, 'invalid_request', message),
  };
}

function wholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The revision named by `If-Match` (`3`, `"3"` or `W/"3"`): undefined when absent, null when malformed. */
function headerRevision(c: Context): number | undefined | null {
  const raw = c.req.header('if-match');
  if (raw === undefined) return undefined;
  const digits = REVISION.exec(raw.trim())?.[1];
  return digits === undefined ? null : Number(digits);
}

/** `If-Match` and/or the body's `expectedRevision`; both must agree when both are sent. */
function revisionOf(c: Context, inBody: unknown): Checked<number | undefined> {
  const header = headerRevision(c);
  if (header === null)
    return refuse(
      c,
      'If-Match must be the settings revision, e.g. If-Match: 3'
    );
  if (inBody !== undefined && !wholeNumber(inBody))
    return refuse(c, 'expectedRevision must be a whole number');
  if (header !== undefined && inBody !== undefined && header !== inBody)
    return refuse(c, 'If-Match and expectedRevision disagree');
  return { ok: true, value: header ?? (inBody as number | undefined) };
}

/** `X-Fleet-Acknowledge: a,b` and/or the body's `acknowledge` list of warning codes. */
function acknowledgeOf(
  c: Context,
  inBody: unknown
): Checked<readonly string[]> {
  const codes = (c.req.header('x-fleet-acknowledge') ?? '')
    .split(',')
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
  if (inBody !== undefined) {
    if (!Array.isArray(inBody) || !inBody.every((v) => typeof v === 'string'))
      return refuse(c, 'acknowledge must be a list of warning codes');
    codes.push(...(inBody as string[]));
  }
  return codes.every((code) => CODE.test(code))
    ? { ok: true, value: [...new Set(codes)] }
    : refuse(c, 'acknowledge must be a list of warning codes');
}

/** The precondition and acknowledgement from the headers and an optional body envelope. */
export function readPreconditions(
  c: Context,
  envelope: Record<string, unknown>
): Checked<Preconditions> {
  const revision = revisionOf(c, envelope['expectedRevision']);
  if (!revision.ok) return revision;
  const acknowledge = acknowledgeOf(c, envelope['acknowledge']);
  if (!acknowledge.ok) return acknowledge;
  return {
    ok: true,
    value: {
      expectedRevision: revision.value,
      acknowledge: acknowledge.value,
    },
  };
}

/**
 * A write is the bare settings document with the precondition in `If-Match`
 * and the acknowledgement in `X-Fleet-Acknowledge`, or an envelope
 * `{ value, expectedRevision?, acknowledge? }` carrying all three.
 */
export async function readWriteRequest(
  c: Context
): Promise<Checked<WriteRequest>> {
  const body = await readJson(c);
  if (!body.ok) return body;
  const record = isRecord(body.value) ? body.value : null;
  const envelope = record !== null && 'value' in record;
  const extra = envelope
    ? Object.keys(record).filter((key) => !ENVELOPE_KEYS.includes(key))
    : [];
  if (extra.length > 0)
    return refuse(c, `${extra.join(', ')} is not allowed next to value`);
  const checked = readPreconditions(c, envelope ? record : {});
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      ...checked.value,
      document: envelope ? record['value'] : body.value,
    },
  };
}

export function dryRunRequested(c: Context): boolean {
  const raw = c.req.query('dryRun');
  return raw === '1' || raw === 'true';
}
