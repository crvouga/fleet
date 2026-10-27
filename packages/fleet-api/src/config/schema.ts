import { createHash } from 'node:crypto';
import { isRole, type Role } from '../types';
import {
  RULES,
  MAX_URL_LENGTH,
  type FleetConfig,
  type Section,
  type IntRule,
  type ListRule,
  type Rule,
} from './fields';
export * from './fields';

export type ValidationResult =
  | { readonly ok: true; readonly value: FleetConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkInt(path: string, value: unknown, rule: IntRule): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${path} must be a whole number`;
  }
  if (value < rule.min || value > rule.max) {
    return `${path} must be between ${rule.min} and ${rule.max}`;
  }
  return null;
}

function checkListItems(
  path: string,
  items: unknown[],
  rule: ListRule
): string | null {
  for (const item of items) {
    if (typeof item !== 'string' || !rule.pattern.test(item)) {
      return `${path} has an invalid entry ${JSON.stringify(item)}`;
    }
    if (rule.forbidden?.includes(item.toLowerCase())) {
      return `${path} may not contain ${item}: the image already sets it`;
    }
  }
  return new Set(items).size === items.length ? null : `${path} has duplicates`;
}

function checkList(
  path: string,
  value: unknown,
  rule: ListRule
): string | null {
  if (!Array.isArray(value)) return `${path} must be a list`;
  if (value.length > rule.max)
    return `${path} may have at most ${rule.max} entries`;
  return checkListItems(path, value, rule);
}

function checkUrl(path: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) {
    return `${path} must be an https URL or null`;
  }
  try {
    return new URL(value).protocol === 'https:'
      ? null
      : `${path} must be https`;
  } catch {
    return `${path} must be an https URL or null`;
  }
}

function checkValue(path: string, value: unknown, rule: Rule): string | null {
  switch (rule.kind) {
    case 'int':
      return checkInt(path, value, rule);
    case 'bool':
      return typeof value === 'boolean'
        ? null
        : `${path} must be true or false`;
    case 'list':
      return checkList(path, value, rule);
    case 'url-or-null':
      return checkUrl(path, value);
  }
}

function checkSection(name: string, value: unknown): string[] {
  const rules = RULES[name as Section];
  if (!isRecord(value)) return [`${name} must be an object`];
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const rule = rules[key];
    if (rule === undefined) {
      errors.push(`${name}.${key} is not a setting`);
      continue;
    }
    const problem = checkValue(`${name}.${key}`, entry, rule);
    if (problem !== null) errors.push(problem);
  }
  return errors;
}

/** Strict: an unknown key is an error, so a typo cannot silently do nothing. */
export function validateConfig(input: unknown): ValidationResult {
  if (!isRecord(input))
    return { ok: false, errors: ['settings must be an object'] };
  const errors: string[] = [];
  for (const [name, value] of Object.entries(input)) {
    if (!(name in RULES)) {
      errors.push(`${name} is not a settings section`);
      continue;
    }
    errors.push(...checkSection(name, value));
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as FleetConfig };
}

/** Objects merge key by key; lists and scalars from the later layer replace. */
export function mergeConfig(...layers: readonly FleetConfig[]): FleetConfig {
  const out: Record<string, Record<string, unknown>> = {};
  for (const layer of layers) {
    for (const [section, entries] of Object.entries(layer)) {
      out[section] = {
        ...out[section],
        ...(entries as Record<string, unknown>),
      };
    }
  }
  return out as FleetConfig;
}

export type Scope = 'fleet' | `role:${Role}` | `node:${string}`;

const NODE_SCOPE = /^node:[0-9a-f]{64}$/;

export function isScope(value: string): value is Scope {
  if (value === 'fleet') return true;
  if (value.startsWith('role:')) return isRole(value.slice('role:'.length));
  return NODE_SCOPE.test(value);
}

export interface ScopeDocuments {
  readonly fleet: FleetConfig;
  readonly role: FleetConfig;
  readonly node: FleetConfig;
}

/** Fleet, then the node's role, then the node itself. The later one wins. */
export function resolveConfig(documents: ScopeDocuments): FleetConfig {
  return mergeConfig(documents.fleet, documents.role, documents.node);
}

/** What a node is sent: everything except the server-only section. */
export function nodePayload(
  resolved: FleetConfig
): Omit<FleetConfig, 'alerts'> {
  const { alerts: _alerts, ...rest } = resolved;
  return rest;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A short fingerprint of a node's configuration. Equal content, equal revision. */
export function configRevision(payload: Omit<FleetConfig, 'alerts'>): string {
  return createHash('sha256')
    .update(canonical(payload))
    .digest('hex')
    .slice(0, 16);
}
