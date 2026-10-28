import {
  canonicalJson,
  validateConfig,
  type FleetConfig,
  type Scope,
} from '../config/schema';
import { SettingsConflictError } from '../domain/settings-conflict';

import type { OpsDeps } from './context';

type Doc = Record<string, Record<string, unknown>>;
const RETRIES = 3;

function copy(value: unknown): Doc {
  return JSON.parse(JSON.stringify(value ?? {})) as Doc;
}

/** One compare-and-set write. Returns whether it wrote; throws SettingsConflictError on a race. */
async function writeOnce(
  deps: OpsDeps,
  scope: Scope,
  actor: string,
  change: (doc: Doc) => void
): Promise<boolean> {
  const row = await deps.store.getSettings(scope);
  const next = copy(row?.value);
  change(next);
  if (canonicalJson(next) === canonicalJson(row?.value ?? {})) return false;
  const checked = validateConfig(next);
  if (!checked.ok) throw new Error(checked.errors.join('; '));
  await deps.store.putSettings(
    scope,
    checked.value as FleetConfig,
    actor,
    row?.revision ?? 0
  );
  return true;
}

/**
 * Edits one node's settings document through the validated store path. Intent
 * is DATA: the node reads it from its desired document and converges. Retries
 * when another writer changed the document first. Returns whether it wrote.
 */
async function editNodeSettings(
  deps: OpsDeps,
  nodeId: string,
  actor: string,
  change: (doc: Doc) => void
): Promise<boolean> {
  const scope = `node:${nodeId}` as Scope;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await writeOnce(deps, scope, actor, change);
    } catch (error) {
      if (!(error instanceof SettingsConflictError) || attempt >= RETRIES)
        throw error;
    }
  }
}

function section(doc: Doc, name: string): Record<string, unknown> {
  doc[name] = { ...(doc[name] ?? {}) };
  return doc[name]!;
}

function drop(doc: Doc, name: string, key: string): void {
  const entries = section(doc, name);
  delete entries[key];
  if (Object.keys(entries).length === 0) delete doc[name];
}

/** The node-scope `runners.cordoned = true`: the existing cordon mechanism drains the node. */
export const setCordon = (deps: OpsDeps, nodeId: string, actor: string) =>
  editNodeSettings(deps, nodeId, actor, (doc) => {
    section(doc, 'runners')['cordoned'] = true;
  });

/** Removes the node-scope cordon. Role or fleet scopes are never touched. */
export const clearCordon = (deps: OpsDeps, nodeId: string, actor: string) =>
  editNodeSettings(deps, nodeId, actor, (doc) =>
    drop(doc, 'runners', 'cordoned')
  );

/** `maintenance.restartAfter`: a node whose boot started before it drains and reboots once. */
export const setRestartAfter = (
  deps: OpsDeps,
  nodeId: string,
  actor: string,
  unixSeconds: number
) =>
  editNodeSettings(deps, nodeId, actor, (doc) => {
    section(doc, 'maintenance')['restartAfter'] = unixSeconds;
  });

export const clearRestartAfter = (
  deps: OpsDeps,
  nodeId: string,
  actor: string
) =>
  editNodeSettings(deps, nodeId, actor, (doc) =>
    drop(doc, 'maintenance', 'restartAfter')
  );
