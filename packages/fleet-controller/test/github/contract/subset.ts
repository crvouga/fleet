import { EXTRA_COMPONENTS, METHODS, OPERATIONS, WEBHOOKS } from './selection';

/** A JSON value from the OpenAPI description; deliberately loose, it is data. */
type Json = ReturnType<typeof JSON.parse>;
type Obj = Record<string, Json>;

const REF = /^#\/components\/(schemas|parameters|responses|headers)\/(.+)$/;
/** Keys that only document. Not stripped inside a `properties` map: a property may be called `description`. */
const DOCUMENTATION = new Set([
  'description',
  'summary',
  'example',
  'examples',
  'externalDocs',
  'x-github',
  'x-github-breaking-changes',
  'deprecated',
  'title',
]);
/** Maps whose keys are names the API defines, not OpenAPI keywords. */
const NAME_MAPS = new Set(['properties', 'patternProperties']);

const isObject = (value: Json): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Drops documentation, keeps every keyword that changes what is valid. */
export function trim(value: Json, namesOnly = false): Json {
  if (Array.isArray(value)) return value.map((item) => trim(item));
  if (!isObject(value)) return value;
  const out: Obj = {};
  for (const [key, child] of Object.entries(value)) {
    if (!namesOnly && DOCUMENTATION.has(key)) continue;
    out[key] = trim(child, NAME_MAPS.has(key) && !namesOnly);
  }
  return out;
}

function refsIn(value: Json, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (isObject(value)) {
    const ref = value['$ref'];
    if (typeof ref === 'string') found.add(ref);
    for (const child of Object.values(value)) refsIn(child, found);
  }
}

function pointer(components: Obj, ref: string): [string, string, Json] {
  const match = REF.exec(ref);
  const kind = match?.[1];
  const name = match?.[2];
  const target =
    kind === undefined ? undefined : components[kind]?.[name ?? ''];
  if (kind === undefined || name === undefined || target === undefined)
    throw new Error(`unresolvable reference ${ref}`);
  return [kind, name, trim(target)];
}

/** Every component the kept operations reach, transitively. */
function closure(components: Obj, roots: Json[]): Obj {
  const kept: Obj = { schemas: {}, parameters: {}, responses: {}, headers: {} };
  const pending = new Set<string>();
  for (const root of roots) refsIn(root, pending);
  const done = new Set<string>();
  for (const ref of pending) {
    if (done.has(ref)) continue;
    done.add(ref);
    const [kind, name, target] = pointer(components, ref);
    kept[kind][name] = target;
    refsIn(target, pending);
  }
  const sorted: Obj = {};
  for (const [kind, entries] of Object.entries(kept))
    sorted[kind] = Object.fromEntries(
      Object.entries(entries as Obj).sort(([a], [b]) => a.localeCompare(b))
    );
  return sorted;
}

function operationOf(upstream: Json): Json {
  const { operationId, parameters, requestBody, responses } = upstream;
  return trim({ operationId, parameters, requestBody, responses });
}

function webhookOf(upstream: Json): Json {
  const content = upstream.post?.requestBody?.content?.['application/json'];
  return trim({
    post: { requestBody: { content: { 'application/json': content } } },
  });
}

export interface Source {
  readonly repository: string;
  readonly commit: string;
  readonly file: string;
  readonly sha256: string;
}

/**
 * The subset of the description Fleet uses, as a self-contained OpenAPI
 * document (`paths`, `x-webhooks`, and only the components they reference).
 */
export function buildSubset(upstream: Json, source: Source): Json {
  const paths: Obj = {};
  for (const [path, methods] of Object.entries(OPERATIONS)) {
    const item = upstream.paths?.[path];
    if (item === undefined) throw new Error(`upstream has no path ${path}`);
    paths[path] = {};
    for (const method of METHODS.filter((m) => methods.includes(m))) {
      if (item[method] === undefined)
        throw new Error(`upstream has no ${method.toUpperCase()} ${path}`);
      paths[path][method] = operationOf(item[method]);
    }
  }
  const webhooks: Obj = {};
  for (const name of WEBHOOKS) {
    const hook = upstream['x-webhooks']?.[name];
    if (hook === undefined) throw new Error(`upstream has no webhook ${name}`);
    webhooks[name] = webhookOf(hook);
  }
  const components = closure(upstream.components, [
    paths,
    webhooks,
    EXTRA_COMPONENTS.map(($ref) => ({ $ref })),
  ]);
  return {
    openapi: upstream.openapi,
    info: {
      title: 'GitHub REST API (Fleet subset)',
      version: upstream.info?.version,
    },
    'x-fleet-source': source,
    paths,
    'x-webhooks': webhooks,
    components,
  };
}
