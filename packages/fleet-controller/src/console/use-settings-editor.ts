import { useEffect, useMemo, useState } from 'react';

import type { FleetConfig } from '../config/fields';
import type { Scope } from '../config/schema';
import { useAction } from './action';
import type { ConsoleState } from './model';
import { useUnsavedChanges } from './unsaved';

/** The form's text fields for a stored document; the webhook is never shown, only replaced. */
export function initialFields(config: FleetConfig): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [section, entries] of Object.entries(config))
    for (const [key, value] of Object.entries(
      entries as Record<string, unknown>
    ))
      values[`${section}.${key}`] = Array.isArray(value)
        ? value.join('\n')
        : String(value ?? '');
  values['alerts.webhookUrl'] = '';
  return values;
}

/**
 * The editing state of one settings scope. `base` is the revision the edits
 * are based on: it follows the stored settings only while nothing is being
 * edited, so someone else's save is refused (conflict) instead of overwritten.
 */
export function useSettingsEditor(input: {
  scope: Scope;
  state: ConsoleState;
  reload: () => void;
}) {
  const { scope, state, reload } = input;
  const stored = useMemo(
    () => state.fleet.documents.get(scope) ?? {},
    [state.fleet.documents, scope]
  );
  const [values, setValues] = useState(() => initialFields(stored));
  const [raw, setRaw] = useState(() => JSON.stringify(stored, null, 2));
  const [dirty, setDirty] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [lastMode, setLastMode] = useState('form');
  const action = useAction(reload);
  const navigation = useUnsavedChanges(dirty || action.busy);
  const latest = String(state.revisions?.[scope] ?? 0);
  const [base, setBase] = useState(latest);
  useEffect(() => {
    if (dirty) return;
    setValues(initialFields(stored));
    setRaw(JSON.stringify(stored, null, 2));
    setBase(latest);
  }, [stored, dirty, latest]);
  async function save(mode: string, extra: Record<string, string> = {}) {
    const preview = extra['intent'] === 'preview';
    setLastMode(mode);
    setPreviewed(preview);
    const fields = mode === 'raw' ? { mode, raw } : { mode, ...values };
    const saved = await action.run(`/settings/${scope}`, {
      ...fields,
      expectedRevision: base,
      ...extra,
    });
    if (saved && !preview) setDirty(false);
  }
  return {
    stored,
    values,
    raw,
    dirty,
    previewed,
    action,
    navigation,
    readOnly: state.role === 'viewer',
    save,
    update: (path: string, value: string) => {
      setValues((old) => ({ ...old, [path]: value }));
      setDirty(true);
    },
    setRaw: (value: string) => {
      setRaw(value);
      setDirty(true);
    },
    /** Drop the edits and load the latest stored settings. */
    discard: () => {
      setDirty(false);
      reload();
    },
    /** Save again acknowledging exactly these warning codes. */
    confirm: (codes: string[]) =>
      void save(lastMode, { acknowledge: codes.join(',') }),
  };
}
