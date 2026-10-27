import { RULES, SECTIONS, type FleetConfig } from '../../config/fields';
import type { Scope } from '../../config/schema';
import type { NodeView } from '../../types';
import type { ScopeDocuments } from './fleet-data';

export interface EffectiveSetting {
  readonly section: string;
  readonly key: string;
  readonly path: string;
  /** Null when no scope sets it: the node uses the value built into its image. */
  readonly value: unknown;
  readonly source: Scope | null;
}

function lookup(
  config: FleetConfig | undefined,
  section: string,
  key: string
): unknown {
  const entries = (
    config as Record<string, Record<string, unknown> | undefined> | undefined
  )?.[section];
  return entries === undefined ? undefined : entries[key];
}

/** For each setting, the value that applies to this node and the scope it came from. */
export function effectiveSettings(
  view: NodeView,
  documents: ScopeDocuments
): EffectiveSetting[] {
  const layers: readonly Scope[] = [
    'fleet',
    `role:${view.role}`,
    `node:${view.id}`,
  ];
  const out: EffectiveSetting[] = [];
  for (const section of SECTIONS) {
    for (const key of Object.keys(RULES[section])) {
      let value: unknown = null;
      let source: Scope | null = null;
      for (const scope of layers) {
        const found = lookup(documents.get(scope), section, key);
        if (found !== undefined) {
          value = found;
          source = scope;
        }
      }
      out.push({ section, key, path: `${section}.${key}`, value, source });
    }
  }
  return out;
}

/** What a scope would inherit from the scopes above it. */
export function inheritedSettings(
  scope: Scope,
  documents: ScopeDocuments,
  role: string | null
): Map<string, EffectiveSetting> {
  const layers: Scope[] = [];
  if (scope.startsWith('node:') && role !== null)
    layers.push('fleet', `role:${role}` as Scope);
  else if (scope.startsWith('role:')) layers.push('fleet');
  const inherited = new Map<string, EffectiveSetting>();
  for (const section of SECTIONS) {
    for (const key of Object.keys(RULES[section])) {
      for (const layer of layers) {
        const found = lookup(documents.get(layer), section, key);
        if (found !== undefined) {
          inherited.set(`${section}.${key}`, {
            section,
            key,
            path: `${section}.${key}`,
            value: found,
            source: layer,
          });
        }
      }
    }
  }
  return inherited;
}

export function scopeLabel(scope: Scope): string {
  if (scope === 'fleet') return 'Fleet';
  if (scope.startsWith('role:')) return `Role ${scope.slice('role:'.length)}`;
  return 'This node';
}

export function scopeHref(scope: Scope): string {
  return `/settings/${scope}`;
}

/** A short text form of a setting value for display. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'built-in default';
  if (Array.isArray(value))
    return value.length === 0 ? 'none' : value.join(', ');
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}
