import type { FleetConfig, Scope } from '../config/schema';
import type { SettingsHistoryRow, SettingsRow } from '../types';

import type { Db } from './client';
import { toSettingsHistoryRow, toSettingsRow } from './rows';

export async function selectSettings(
  db: Db,
  scope: Scope
): Promise<SettingsRow | null> {
  const rows =
    await db`select * from fleet.settings where scope = ${scope}::text`;
  return rows[0] === undefined ? null : toSettingsRow(rows[0]);
}

/** The fleet, role and node documents for one node, whichever exist. */
export async function selectScopes(
  db: Db,
  scopes: readonly Scope[]
): Promise<SettingsRow[]> {
  const [a = '', b = '', c = ''] = scopes;
  const rows = await db`
    select * from fleet.settings
    where scope = ${a}::text or scope = ${b}::text or scope = ${c}::text`;
  return rows.map(toSettingsRow);
}

export async function selectAllSettings(db: Db): Promise<SettingsRow[]> {
  const rows = await db`select * from fleet.settings order by scope`;
  return rows.map(toSettingsRow);
}

export async function upsertSettings(
  db: Db,
  scope: Scope,
  value: FleetConfig,
  actor: string
): Promise<SettingsRow> {
  const json = JSON.stringify(value);
  const rows = await db`
    insert into fleet.settings (scope, value, updated_at, updated_by)
    values (${scope}::text, ${json}::text::jsonb, now(), ${actor}::text)
    on conflict (scope) do update
      set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
    returning *`;
  await db`
    insert into fleet.settings_history (scope, value, changed_at, changed_by)
    values (${scope}::text, ${json}::text::jsonb, now(), ${actor}::text)`;
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
    select * from fleet.settings_history
    where scope = ${scope}::text
    order by id desc
    limit ${limit}::int`;
  return rows.map(toSettingsHistoryRow);
}

export async function deleteScope(db: Db, scope: Scope): Promise<void> {
  await db`delete from fleet.settings where scope = ${scope}::text`;
}
