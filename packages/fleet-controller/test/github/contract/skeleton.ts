import { github } from './openapi';
import type { Resolver } from './json-schema';

/** Schemas and instances are data from a file, so deliberately loose. */
type Json = ReturnType<typeof JSON.parse>;

const DATE_TIME = '2026-01-01T00:00:00Z';
const MAX_DEPTH = 12;

function stringFor(schema: Record<string, Json>): string {
  if (schema['format'] === 'date-time') return DATE_TIME;
  if (schema['format'] === 'uri' || schema['format'] === 'uri-template')
    return 'https://api.github.com/placeholder';
  if (schema['format'] === 'email') return 'placeholder@example.test';
  return 'placeholder';
}

function objectFor(
  schema: Record<string, Json>,
  r: Resolver,
  depth: number
): Json {
  const out: Record<string, Json> = {};
  const properties: Record<string, Json> = schema['properties'] ?? {};
  const required: string[] = Array.isArray(schema['required'])
    ? schema['required']
    : [];
  for (const name of required)
    out[name] = minimal(properties[name] ?? {}, r, depth + 1);
  return out;
}

function typedValue(
  schema: Record<string, Json>,
  r: Resolver,
  depth: number
): Json {
  switch (schema['type']) {
    case undefined:
    case 'object':
      return objectFor(schema, r, depth);
    case 'string':
      return stringFor(schema);
    case 'integer':
    case 'number':
      return Math.max(1, Number(schema['minimum'] ?? 1));
    case 'boolean':
      return false;
    default:
      return [];
  }
}

/** The first branch of a oneOf/anyOf, or null when the schema has none. */
function firstBranch(schema: Record<string, Json>): Json {
  return schema['oneOf']?.[0] ?? schema['anyOf']?.[0] ?? null;
}

function minimal(
  schema: Record<string, Json>,
  r: Resolver,
  depth: number
): Json {
  if (depth > MAX_DEPTH) throw new Error('schema too deep for a skeleton');
  if (typeof schema['$ref'] === 'string')
    return minimal(r.resolve(schema['$ref']), r, depth);
  // A nested nullable property is null; the object a fake asks for is never.
  if (schema['nullable'] === true && depth > 0) return null;
  if (Array.isArray(schema['allOf']))
    return Object.assign(
      {},
      ...schema['allOf'].map((s: Json) => minimal(s, r, depth + 1))
    );
  const branch = firstBranch(schema);
  if (branch !== null) return minimal(branch, r, depth + 1);
  if (Array.isArray(schema['enum'])) return schema['enum'][0];
  return typedValue(schema, r, depth);
}

function merge(base: Json, over: Json): Json {
  const plain = (v: Json) =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!plain(base) || !plain(over)) return over;
  const out: Record<string, Json> = { ...base };
  for (const [key, value] of Object.entries(over))
    out[key] = merge(base[key], value);
  return out;
}

/**
 * A response object the fakes send: the smallest instance of the named
 * component schema of GitHub's description (every required property, nothing
 * else), with the fields the fake actually models laid over it. Hand-writing
 * the ~90 URL fields of a repository in each fake would drift; deriving them
 * from the vendored description cannot, and the contract tests still validate
 * the result against that same description.
 */
export function shaped(component: string, fields: Json = {}): Json {
  const base = minimal(
    { $ref: `#/components/schemas/${component}` },
    github.resolver,
    0
  );
  return merge(base, fields);
}
