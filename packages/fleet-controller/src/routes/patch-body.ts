import { isRecord } from '../domain/heartbeat-fields';
import type { NodePatch } from '../store';
import { ACTIVE_ROLES, isActiveRole, type ActiveRole } from '../types';

/** The text fields, and the assigned role when `role` was sent (null unassigns). */
export interface NodeChange {
  readonly patch: NodePatch;
  readonly role?: ActiveRole | null;
}

export type PatchResult =
  | { readonly ok: true; readonly value: NodeChange }
  | { readonly ok: false; readonly errors: readonly string[] };

const MAX_NAME = 80;
const MAX_NOTE = 1000;
const MAX_LABELS = 16;
const LABEL = /^[A-Za-z0-9_.:-]{1,50}$/;
const KEYS = new Set(['displayName', 'note', 'labels', 'role']);

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

function definedOnly(
  fields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

/** Only an active role may be assigned; null unassigns. Absent leaves it alone. */
export function readAssignedRole(
  value: unknown,
  errors: string[]
): ActiveRole | null | undefined {
  if (value === undefined || value === null) return value;
  if (isActiveRole(value)) return value;
  errors.push(`role must be one of ${ACTIVE_ROLES.join(', ')}, or null`);
  return undefined;
}

/**
 * `{ displayName?, note?, labels?, role? }`. Absent keys are left alone; null
 * clears a text field or unassigns the role.
 */
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
  const role = readAssignedRole(input['role'], errors);
  const patch = definedOnly({ displayName, note, labels }) as NodePatch;
  if (errors.length > 0) return { ok: false, errors };
  if (Object.keys(patch).length === 0 && role === undefined)
    return {
      ok: false,
      errors: ['send at least one of displayName, note, labels, role'],
    };
  return { ok: true, value: role === undefined ? { patch } : { patch, role } };
}
