import type { NodePatch } from '../../store';

export const MAX_LABELS = 16;
export const MAX_NAME = 80;
export const MAX_NOTE = 500;

const LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,50}$/;

export type EditResult =
  | { readonly ok: true; readonly patch: NodePatch }
  | { readonly ok: false; readonly error: string };

function field(body: Readonly<Record<string, unknown>>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

/** Validates the edit form. Empty name or note clears it. */
export function parseEdit(body: Readonly<Record<string, unknown>>): EditResult {
  const displayName = field(body, 'displayName').trim();
  const note = field(body, 'note').trim();
  const labels = [
    ...new Set(
      field(body, 'labels')
        .split(/[\s,]+/)
        .filter((l) => l !== '')
    ),
  ];
  if (displayName.length > MAX_NAME)
    return {
      ok: false,
      error: `The name may be at most ${MAX_NAME} characters.`,
    };
  if (note.length > MAX_NOTE)
    return {
      ok: false,
      error: `The note may be at most ${MAX_NOTE} characters.`,
    };
  if (labels.length > MAX_LABELS)
    return { ok: false, error: `Use at most ${MAX_LABELS} labels.` };
  const bad = labels.find((label) => !LABEL_PATTERN.test(label));
  if (bad !== undefined) {
    return {
      ok: false,
      error: `The label "${bad.slice(0, 20)}" is not allowed: use letters, digits, dot, dash, colon or underscore.`,
    };
  }
  return {
    ok: true,
    patch: {
      displayName: displayName === '' ? null : displayName,
      note: note === '' ? null : note,
      labels,
    },
  };
}
