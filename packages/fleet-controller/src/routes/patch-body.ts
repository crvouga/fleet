import { isRecord } from '../domain/heartbeat-fields';
import type { NodePatch } from '../store';

export type PatchResult =
  | { readonly ok: true; readonly value: NodePatch }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_NAME = 80;
const MAX_NOTE = 1000;
const MAX_LABELS = 16;
const LABEL = /^[A-Za-z0-9_.:-]{1,50}$/;
const KEYS = new Set(['displayName', 'note', 'labels']);

function textOrNull(
  value: unknown,
  path: string,
  max: number,
  errors: string[]
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    errors.push(`${path} must be text of at most ${max} characters, or null`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function labelList(value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  const valid =
    Array.isArray(value) &&
    value.length <= MAX_LABELS &&
    value.every((item) => typeof item === 'string' && LABEL.test(item)) &&
    new Set(value).size === value.length;
  if (!valid) {
    errors.push(
      `labels must be up to ${MAX_LABELS} distinct labels of letters, digits and _.:-`
    );
    return undefined;
  }
  return value as string[];
}

/** `{ displayName?, note?, labels? }`. Absent keys are left alone; null clears a text field. */
export function validatePatch(input: unknown): PatchResult {
  if (!isRecord(input))
    return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key)) errors.push(`${key} cannot be changed`);
  }
  const displayName = textOrNull(
    input['displayName'],
    'displayName',
    MAX_NAME,
    errors
  );
  const note = textOrNull(input['note'], 'note', MAX_NOTE, errors);
  const labels = labelList(input['labels'], errors);
  const value: NodePatch = {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
  if (errors.length === 0 && Object.keys(value).length === 0) {
    errors.push('send at least one of displayName, note, labels');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}
