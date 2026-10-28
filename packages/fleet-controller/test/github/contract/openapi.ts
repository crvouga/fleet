import { ContractError } from './contract-error';
import { validateSchema, type Resolver } from './json-schema';
import subset from './openapi.subset.json';

/** The OpenAPI document and its parts are data from a file, so deliberately loose. */
type Json = ReturnType<typeof JSON.parse>;
type Obj = Record<string, Json>;

export interface Operation {
  /** The path template of the description, e.g. `/repos/{owner}/{repo}/issues`. */
  readonly template: string;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  readonly spec: Obj;
}

/** Statuses GitHub can answer on any endpoint without listing them; body is `basic-error`. */
export const GENERIC_ERROR_STATUSES: readonly number[] = [
  401, 403, 404, 408, 429, 500, 502, 503, 504,
];

export { ContractError };

export class OpenApi {
  constructor(readonly doc: Obj) {}

  readonly resolver: Resolver = {
    resolve: (ref) => {
      const target = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce<Json>((node, key) => node?.[key], this.doc);
      if (target === undefined)
        throw new ContractError(`unresolvable reference ${ref}`);
      return target;
    },
  };

  private deref(value: Json): Obj {
    return typeof value?.['$ref'] === 'string'
      ? this.resolver.resolve(value['$ref'])
      : value;
  }

  templates(): string[] {
    return Object.keys(this.doc['paths'] ?? {});
  }

  /** Every `METHOD template` in the description. */
  operations(): string[] {
    return this.templates().flatMap((template) =>
      Object.keys(this.doc['paths'][template]).map(
        (m) => `${m.toUpperCase()} ${template}`
      )
    );
  }

  /** The operation a concrete request path belongs to, or null. Literal segments beat parameters. */
  find(method: string, path: string): Operation | null {
    const segments = path.split('/').filter(Boolean);
    let best: { op: Operation; literals: number } | null = null;
    for (const template of this.templates()) {
      const spec = this.doc['paths'][template][method.toLowerCase()];
      const parts = template.split('/').filter(Boolean);
      if (spec === undefined || parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let literals = 0;
      const matches = parts.every((part, index) => {
        const segment = segments[index] ?? '';
        if (!part.startsWith('{')) {
          literals += part === segment ? 1 : 0;
          return part === segment;
        }
        params[part.slice(1, -1)] = decodeURIComponent(segment);
        return segment !== '';
      });
      if (matches && (best === null || literals > best.literals))
        best = {
          op: { template, method: method.toUpperCase(), params, spec },
          literals,
        };
    }
    return best?.op ?? null;
  }

  private operation(method: string, path: string): Operation {
    const op = this.find(method, path);
    if (op === null)
      throw new ContractError(
        `${method} ${path} is not in the vendored GitHub description subset. If Fleet now calls it, add it to test/github/contract/selection.ts and refresh (see SOURCE.md).`
      );
    return op;
  }

  parametersOf(op: Operation): Obj[] {
    const list: Json[] = op.spec['parameters'] ?? [];
    return list.map((p) => this.deref(p));
  }

  /** Query and path values are strings on the wire: check them against the declared schema. */
  private checkParameter(parameter: Obj, raw: string, label: string): string[] {
    const schema: Obj = parameter['schema'] ?? {};
    const type = this.deref(schema)['type'];
    let value: Json = raw;
    if (type === 'integer' || type === 'number') {
      value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    } else if (type === 'boolean') {
      value = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
    return validateSchema(schema, value, this.resolver, label);
  }

  /** The problems with one request; empty when it conforms. `query` is what follows `?`. */
  requestProblems(
    method: string,
    path: string,
    query: URLSearchParams | Record<string, string>,
    body: unknown
  ): string[] {
    const op = this.operation(method, path);
    const search =
      query instanceof URLSearchParams ? query : new URLSearchParams(query);
    return [
      ...this.pathProblems(op),
      ...this.queryProblems(op, search),
      ...this.bodyProblems(op, body),
    ];
  }

  private pathProblems(op: Operation): string[] {
    return this.parametersOf(op)
      .filter((p) => p['in'] === 'path')
      .flatMap((p) => {
        const name = String(p['name']);
        return this.checkParameter(p, op.params[name] ?? '', `path {${name}}`);
      });
  }

  private queryProblems(op: Operation, search: URLSearchParams): string[] {
    const declared = this.parametersOf(op).filter((p) => p['in'] === 'query');
    const problems: string[] = [];
    for (const parameter of declared) {
      const name = String(parameter['name']);
      const values = search.getAll(name);
      if (values.length === 0 && parameter['required'] === true)
        problems.push(`query ${name}: required but missing`);
      for (const value of values)
        problems.push(
          ...this.checkParameter(parameter, value, `query ${name}`)
        );
    }
    const names = new Set(declared.map((p) => p['name']));
    for (const key of new Set(search.keys()))
      if (!names.has(key))
        problems.push(
          `query ${key}: not a parameter of ${op.method} ${op.template}`
        );
    return problems;
  }

  private bodyProblems(op: Operation, body: unknown): string[] {
    const spec = op.spec['requestBody'];
    const present = body !== undefined && body !== null;
    if (spec === undefined)
      return present
        ? [`${op.method} ${op.template} takes no request body`]
        : [];
    const schema =
      this.deref(spec)['content']?.['application/json']?.['schema'];
    if (!present)
      return spec['required'] === true
        ? ['request body: required but missing']
        : [];
    return validateSchema(schema, body, this.resolver, 'body');
  }

  /** The documented (or generic error) response for `status`, and whether GitHub lists it. */
  responseFor(
    op: Operation,
    status: number
  ): { response: Obj; documented: boolean } {
    const listed: Json = op.spec['responses']?.[String(status)];
    if (listed !== undefined)
      return { response: this.deref(listed), documented: true };
    if (GENERIC_ERROR_STATUSES.includes(status))
      return {
        response: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/basic-error' },
            },
          },
        },
        documented: false,
      };
    throw new ContractError(
      `${op.method} ${op.template}: status ${status} is not documented (documented: ${Object.keys(op.spec['responses'] ?? {}).join(', ')})`
    );
  }

  responseProblems(
    method: string,
    path: string,
    status: number,
    body: unknown
  ): string[] {
    const op = this.operation(method, path);
    const { response } = this.responseFor(op, status);
    const schema =
      this.deref(response)['content']?.['application/json']?.['schema'];
    if (schema === undefined)
      return body === null || body === undefined || body === ''
        ? []
        : [`status ${status} documents no body, got ${typeof body}`];
    return validateSchema(schema, body, this.resolver, 'response');
  }

  /** `workflow-job-completed` and the like: the payload GitHub POSTs to a webhook. */
  webhookProblems(name: string, payload: unknown): string[] {
    const schema =
      this.doc['x-webhooks']?.[name]?.['post']?.['requestBody']?.['content']?.[
        'application/json'
      ]?.['schema'];
    if (schema === undefined)
      throw new ContractError(`no webhook ${name} in the description subset`);
    return validateSchema(schema, payload, this.resolver, 'payload');
  }

  /** A component schema by name, for the shape checks the description documents once (errors). */
  schemaProblems(name: string, value: unknown): string[] {
    return validateSchema(
      { $ref: `#/components/schemas/${name}` },
      value,
      this.resolver,
      name
    );
  }

  /** The rate-limit headers: integers (GitHub's `x-rate-limit-*` components), Retry-After in seconds. */
  headerProblems(headers: Headers): string[] {
    const problems: string[] = [];
    for (const name of ['limit', 'remaining', 'reset']) {
      const value = headers.get(`x-ratelimit-${name}`);
      if (value === null) continue;
      const schema =
        this.doc['components']['headers'][`x-rate-limit-${name}`]['schema'];
      const number = /^\d+$/.test(value) ? Number(value) : value;
      problems.push(
        ...validateSchema(schema, number, this.resolver, `x-ratelimit-${name}`)
      );
    }
    const used = headers.get('x-ratelimit-used');
    if (used !== null && !/^\d+$/.test(used))
      problems.push('x-ratelimit-used: not an integer');
    const after = headers.get('retry-after');
    if (after !== null && !/^\d+$/.test(after))
      problems.push('retry-after: not whole seconds');
    return problems;
  }
}

export const github = new OpenApi(subset as Obj);

function fail(what: string, problems: string[]): void {
  if (problems.length > 0)
    throw new ContractError(`${what} breaks GitHub's contract`, problems);
}

/** Throws unless the request is one the description defines and its parameters and body conform. */
export function assertRequestConforms(
  method: string,
  path: string,
  query: URLSearchParams | Record<string, string>,
  body: unknown
): void {
  fail(
    `request ${method} ${path}`,
    github.requestProblems(method, path, query, body)
  );
}

/** Throws unless the status is documented (or a generic error) and the body matches its schema. */
export function assertResponseConforms(
  method: string,
  path: string,
  status: number,
  body: unknown
): void {
  fail(
    `response ${status} to ${method} ${path}`,
    github.responseProblems(method, path, status, body)
  );
}

/** Throws unless the rate-limit headers (`x-ratelimit-*`, `retry-after`) have the documented shape. */
export function assertHeadersConform(headers: Headers): void {
  fail('response headers', github.headerProblems(headers));
}
