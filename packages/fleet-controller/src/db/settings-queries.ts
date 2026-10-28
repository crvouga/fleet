import type { FleetConfig, Scope } from '../config/schema';
import type { SettingsHistoryRow, SettingsRow } from '../types';

import type { Db } from './client';
import { SettingsConflictError } from '../domain/settings-conflict';
import { numberOf, toSettingsHistoryRow, toSettingsRow } from './rows';

export async function selectSettings(
  db: Db,
  scope: Scope
): Promise<SettingsRow | null> {
  const rows = await db`select * from settings where scope = ${scope}`;
  return rows[0] === undefined ? null : toSettingsRow(rows[0]);
}

/** The fleet, role and node documents for one node, whichever exist. */
export async function selectScopes(
  db: Db,
  scopes: readonly Scope[]
): Promise<SettingsRow[]> {
  const [a = '', b = '', c = ''] = scopes;
  const rows = await db`
    select * from settings
    where scope = ${a} or scope = ${b} or scope = ${c}`;
  return rows.map(toSettingsRow);
}

export async function selectAllSettings(db: Db): Promise<SettingsRow[]> {
  const rows = await db`select * from settings order by scope`;
  return rows.map(toSettingsRow);
}

export interface SettingsWrite {
  readonly actor: string;
  /** Write only if the stored revision is still this (0 for a scope never written). */
  readonly expectedRevision?: number | undefined;
}

export async function upsertSettings(
  db: Db,
  scope: Scope,
  value: FleetConfig,
  write: SettingsWrite
): Promise<SettingsRow> {
  const { actor, expectedRevision } = write;
  const json = JSON.stringify(value);
  if (expectedRevision !== undefined) {
    // The caller runs inside a write transaction, so this read cannot go stale.
    const found =
      await db`select revision from settings where scope = ${scope}`;
    const current = found[0] === undefined ? 0 : numberOf(found[0], 'revision');
    if (current !== expectedRevision)
      throw new SettingsConflictError(current, expectedRevision);
  }
  const rows = await db`
    insert into settings (scope, value, updated_at, updated_by, revision)
    values (${scope}, ${json}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${actor}, 1)
    on conflict (scope) do update
      set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
          revision = settings.revision + 1
    returning *`;
  await db`
    insert into settings_history (scope, value, changed_at, changed_by)
    values (${scope}, ${json}, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ${actor})`;
  const row = rows[0];
  if (row === undefined) throw new Error('settings upsert returned no row');
  return toSettingsRow(row);
}

export async function selectHistory(
  db: Db,
  scope: Scope,
  limit: number
): Promise<SettingsHistoryRow[]> {
  const rows = await db`
    select * from settings_history
    where scope = ${scope}
    order by id desc
    limit ${limit}`;
  return rows.map(toSettingsHistoryRow);
}

export async function deleteScope(db: Db, scope: Scope): Promise<void> {
  await db`delete from settings where scope = ${scope}`;
}
