/**
 * The part of OpenAPI 3.0 schema validation the vendored GitHub description
 * needs: types, nullable, enum, required, properties, additionalProperties,
 * items, allOf/anyOf/oneOf, bounds, pattern and the date-time format. Other
 * formats (uri, email, ...) are accepted leniently. Unknown keywords are
 * ignored, as OpenAPI requires. Written here, not pulled in, because the repo
 * has no JSON Schema validator for 3.0's `nullable` and a new dependency is
 * heavier than ~150 lines.
 */

/** A schema or any JSON value; both are data from a file, so deliberately loose. */
type Json = ReturnType<typeof JSON.parse>;
type Schema = Record<string, Json>;

export interface Resolver {
  /** The target of a `#/components/...` reference. */
  resolve(ref: string): Schema;
}

const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const MAX_ERRORS = 20;

const isObject = (value: Json): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(type: string, value: Json): boolean {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number')
    return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === type;
}

type Errors = string[];

/** What a walk carries: how to follow references, and where problems go. */
interface Ctx {
  readonly r: Resolver;
  readonly errors: Errors;
}

function checkScalar(
  schema: Schema,
  value: Json,
  at: string,
  errors: Errors
): void {
  if (typeof value === 'string') checkString(schema, value, at, errors);
  if (typeof value === 'number') {
    const { minimum, maximum } = schema;
    if (typeof minimum === 'number' && value < minimum)
      errors.push(`${at}: ${value} is below the minimum ${minimum}`);
    if (typeof maximum === 'number' && value > maximum)
      errors.push(`${at}: ${value} is above the maximum ${maximum}`);
  }
  const options = schema['enum'];
  if (Array.isArray(options) && !options.some((o) => o === value))
    errors.push(
      `${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(options)}`
    );
}

function checkString(
  schema: Schema,
  value: string,
  at: string,
  errors: Errors
): void {
  const { minLength, maxLength, pattern, format } = schema;
  if (typeof minLength === 'number' && value.length < minLength)
    errors.push(`${at}: shorter than ${minLength}`);
  if (typeof maxLength === 'number' && value.length > maxLength)
    errors.push(`${at}: longer than ${maxLength}`);
  if (typeof pattern === 'string' && !new RegExp(pattern, 'u').test(value))
    errors.push(`${at}: does not match ${pattern}`);
  if (
    format === 'date-time' &&
    !(DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)))
  )
    errors.push(`${at}: "${value}" is not an RFC 3339 date-time`);
}

function checkObject(
  schema: Schema,
  value: Record<string, Json>,
  at: string,
  ctx: Ctx
): void {
  const required: unknown = schema['required'];
  for (const key of Array.isArray(required) ? required : [])
    if (!(key in value))
      ctx.errors.push(`${at}: missing required property "${String(key)}"`);
  const properties: Schema = isObject(schema['properties'])
    ? schema['properties']
    : {};
  const extra = schema['additionalProperties'];
  for (const [key, child] of Object.entries(value)) {
    const known = properties[key];
    if (known !== undefined) walk(known, child, `${at}.${key}`, ctx);
    else if (extra === false)
      ctx.errors.push(`${at}: unexpected property "${key}"`);
    else if (isObject(extra)) walk(extra, child, `${at}.${key}`, ctx);
  }
}

function checkArray(schema: Schema, value: Json[], at: string, ctx: Ctx): void {
  const { minItems, maxItems, items } = schema;
  if (typeof minItems === 'number' && value.length < minItems)
    ctx.errors.push(`${at}: fewer than ${minItems} items`);
  if (typeof maxItems === 'number' && value.length > maxItems)
    ctx.errors.push(`${at}: more than ${maxItems} items`);
  if (isObject(items))
    value.forEach((item, index) => walk(items, item, `${at}[${index}]`, ctx));
}

function branchErrors(
  branch: Schema,
  value: Json,
  at: string,
  r: Resolver
): Errors {
  const ctx: Ctx = { r, errors: [] };
  walk(branch, value, at, ctx);
  return ctx.errors;
}

function checkCombinators(
  schema: Schema,
  value: Json,
  at: string,
  ctx: Ctx
): void {
  const all: Schema[] = Array.isArray(schema['allOf']) ? schema['allOf'] : [];
  for (const branch of all) walk(branch, value, at, ctx);
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches: Schema[] = Array.isArray(schema[keyword])
      ? schema[keyword]
      : [];
    if (branches.length === 0) continue;
    const results = branches.map((branch) =>
      branchErrors(branch, value, at, ctx.r)
    );
    const passing = results.filter((e) => e.length === 0).length;
    if (passing === 0)
      ctx.errors.push(
        `${at}: matches none of the ${keyword} branches (${results
          .map((e) => e[0])
          .join(' | ')})`
      );
    else if (keyword === 'oneOf' && passing > 1)
      ctx.errors.push(
        `${at}: matches ${passing} oneOf branches, exactly one allowed`
      );
  }
}

function walk(schema: Schema, value: Json, at: string, ctx: Ctx): void {
  if (ctx.errors.length >= MAX_ERRORS) return;
  const ref = schema['$ref'];
  if (typeof ref === 'string') return walk(ctx.r.resolve(ref), value, at, ctx);
  if (value === null && schema['nullable'] === true) return;
  const type = schema['type'];
  if (typeof type === 'string' && !typeMatches(type, value)) {
    ctx.errors.push(`${at}: expected ${type}, got ${typeOf(value)}`);
    return;
  }
  checkScalar(schema, value, at, ctx.errors);
  if (isObject(value)) checkObject(schema, value, at, ctx);
  if (Array.isArray(value)) checkArray(schema, value, at, ctx);
  checkCombinators(schema, value, at, ctx);
}

/** Every way `value` breaks `schema`, as readable lines; empty when it conforms. */
export function validateSchema(
  schema: Schema,
  value: Json,
  r: Resolver,
  root = '$'
): string[] {
  const ctx: Ctx = { r, errors: [] };
  walk(schema, value, root, ctx);
  return ctx.errors;
}
