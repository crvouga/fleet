import { describe, expect, test } from 'bun:test';

import { validateSchema, type Resolver } from './json-schema';
import {
  ContractError,
  OpenApi,
  assertRequestConforms,
  assertResponseConforms,
  github,
} from './openapi';
import { EXTRA_COMPONENTS, OPERATIONS, UPSTREAM, WEBHOOKS } from './selection';
import { buildSubset, trim } from './subset';

const none: Resolver = {
  resolve: (ref) => {
    throw new Error(`no ${ref}`);
  },
};
const check = (schema: object, value: unknown) =>
  validateSchema(schema as Record<string, never>, value, none);

describe('schema validator', () => {
  test('types, integers and nullable (OpenAPI 3.0 style)', () => {
    expect(check({ type: 'integer' }, 3)).toEqual([]);
    expect(check({ type: 'integer' }, 3.5)[0]).toContain('expected integer');
    expect(check({ type: 'string' }, null)[0]).toContain('got null');
    expect(check({ type: 'string', nullable: true }, null)).toEqual([]);
    expect(
      check({ type: 'array', items: { type: 'string' } }, ['a', 1])[0]
    ).toContain('$[1]');
    expect(check({ type: 'boolean' }, 'true')[0]).toContain('expected boolean');
  });

  test('required, properties, additionalProperties', () => {
    const schema = {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(check(schema, { id: 1, extra: true })).toEqual([]);
    expect(check(schema, {})[0]).toContain('missing required property "id"');
    expect(check(schema, { id: '1' })[0]).toContain('$.id');
    expect(
      check({ ...schema, additionalProperties: false }, { id: 1, extra: 1 })[0]
    ).toContain('unexpected property "extra"');
    expect(
      check(
        { type: 'object', additionalProperties: { type: 'integer' } },
        { a: 1, b: 'x' }
      )[0]
    ).toContain('$.b');
  });

  test('enum, bounds, pattern, date-time', () => {
    expect(check({ enum: ['a', 'b'] }, 'c')[0]).toContain('is not one of');
    expect(
      check({ type: 'integer', minimum: 1, maximum: 100 }, 0)[0]
    ).toContain('below');
    expect(
      check({ type: 'integer', minimum: 1, maximum: 100 }, 101)[0]
    ).toContain('above');
    expect(check({ type: 'string', pattern: '^a+$' }, 'ab')[0]).toContain(
      'does not match'
    );
    expect(
      check({ type: 'string', format: 'date-time' }, '2026-01-02T03:04:05Z')
    ).toEqual([]);
    expect(
      check({ type: 'string', format: 'date-time' }, '2026-01-02')[0]
    ).toContain('date-time');
    expect(check({ type: 'string', format: 'uri' }, 'not a uri')).toEqual([]);
  });

  test('allOf, anyOf, oneOf', () => {
    const one = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(check(one, 1)).toEqual([]);
    expect(check(one, true)[0]).toContain('none of the oneOf');
    expect(
      check({ oneOf: [{ type: 'integer' }, { minimum: 0 }] }, 1)[0]
    ).toContain('exactly one');
    expect(check({ anyOf: [{ type: 'integer' }, { minimum: 0 }] }, 1)).toEqual(
      []
    );
    const all = {
      allOf: [
        { type: 'object', required: ['a'] },
        { type: 'object', required: ['b'] },
      ],
    };
    expect(check(all, { a: 1, b: 2 })).toEqual([]);
    expect(check(all, { a: 1 })[0]).toContain('"b"');
  });

  test('follows references and stops after a bounded number of errors', () => {
    const resolver: Resolver = {
      resolve: () => ({
        type: 'object',
        required: ['x'],
        properties: { next: { $ref: '#/n' } },
      }),
    };
    const errors = validateSchema(
      { $ref: '#/n' },
      { x: 1, next: { next: {} } },
      resolver
    );
    expect(errors[0]).toContain('$.next: missing required property "x"');
    expect(errors).toHaveLength(2);
    const many = validateSchema(
      { type: 'array', items: { type: 'string' } },
      Array.from({ length: 200 }, () => 1),
      none
    );
    expect(many.length).toBeLessThanOrEqual(20);
  });
});

describe('vendored description', () => {
  test('records where it came from and holds exactly the selected operations', () => {
    const source = github.doc['x-fleet-source'];
    expect(source.repository).toBe(UPSTREAM.repository);
    expect(source.file).toBe(UPSTREAM.file);
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    const wanted = Object.entries(OPERATIONS)
      .flatMap(([path, methods]) =>
        methods.map((m) => `${m.toUpperCase()} ${path}`)
      )
      .sort();
    expect(github.operations().sort()).toEqual(wanted);
    expect(Object.keys(github.doc['x-webhooks']).sort()).toEqual(
      [...WEBHOOKS].sort()
    );
    for (const ref of EXTRA_COMPONENTS)
      expect(github.resolver.resolve(ref)).toBeDefined();
  });

  test('SOURCE.md names the same commit and file', async () => {
    const note = await Bun.file(new URL('./SOURCE.md', import.meta.url)).text();
    const source = github.doc['x-fleet-source'];
    expect(note).toContain(source.commit);
    expect(note).toContain(source.sha256);
    expect(note).toContain(source.file);
  });

  test('stays small and holds no dangling reference', () => {
    const text = JSON.stringify(github.doc);
    expect(text.length).toBeLessThan(1_500_000);
    for (const ref of new Set(text.match(/#\/components\/[a-z]+\/[^"]+/g)))
      expect(github.resolver.resolve(ref)).toBeDefined();
  });
});

describe('subset builder', () => {
  test('trim drops documentation but keeps properties named like it', () => {
    const trimmed = trim({
      description: 'x',
      properties: {
        description: { type: 'string', description: 'a field' },
        example: { type: 'string' },
      },
      example: { a: 1 },
    });
    expect(trimmed).toEqual({
      properties: {
        description: { type: 'string' },
        example: { type: 'string' },
      },
    });
  });

  test('buildSubset fails loudly when upstream lost an operation', () => {
    const source = { repository: 'r', commit: 'c', file: 'f', sha256: 's' };
    expect(() => buildSubset({ paths: {}, components: {} }, source)).toThrow(
      'upstream has no path'
    );
  });
});

describe('request conformance', () => {
  const query = { per_page: '100', page: '1' };

  test('accepts a well-formed list request', () => {
    expect(() =>
      assertRequestConforms(
        'GET',
        '/repos/acme/app/actions/runners',
        query,
        null
      )
    ).not.toThrow();
  });

  test('rejects an operation that is not in the description', () => {
    expect(() =>
      assertRequestConforms('GET', '/repos/acme/app/hooks', {}, null)
    ).toThrow('not in the vendored GitHub description subset');
    expect(() =>
      assertRequestConforms('PUT', '/repos/acme/app/actions/runners', {}, null)
    ).toThrow(ContractError);
  });

  test('rejects an undeclared or ill-typed query parameter', () => {
    expect(() =>
      assertRequestConforms(
        'GET',
        '/repos/acme/app/actions/runners',
        { per_pages: '1' },
        null
      )
    ).toThrow('not a parameter');
    expect(() =>
      assertRequestConforms(
        'GET',
        '/repos/acme/app/actions/runners',
        { per_page: 'many' },
        null
      )
    ).toThrow('query per_page');
    expect(() =>
      assertRequestConforms(
        'GET',
        '/repos/acme/app/actions/runs',
        { status: 'sleeping' },
        null
      )
    ).toThrow('query status');
  });

  test('checks path parameters and request bodies', () => {
    expect(() =>
      assertRequestConforms(
        'DELETE',
        '/repos/acme/app/actions/runners/abc',
        {},
        null
      )
    ).toThrow('path {runner_id}');
    expect(() =>
      assertRequestConforms(
        'POST',
        '/repos/acme/app/issues',
        {},
        { title: 'x', labels: ['a'] }
      )
    ).not.toThrow();
    expect(() =>
      assertRequestConforms(
        'POST',
        '/repos/acme/app/issues',
        {},
        { body: 'no title' }
      )
    ).toThrow('missing required property "title"');
    expect(() =>
      assertRequestConforms('POST', '/repos/acme/app/issues', {}, null)
    ).toThrow('required but missing');
    expect(() =>
      assertRequestConforms(
        'POST',
        '/repos/acme/app/issues/3/comments',
        {},
        { body: 7 }
      )
    ).toThrow('body.body');
    expect(() =>
      assertRequestConforms(
        'GET',
        '/repos/acme/app/actions/runners',
        {},
        { surprise: 1 }
      )
    ).toThrow('takes no request body');
  });

  test('literal path segments win over parameters', () => {
    expect(github.find('GET', '/app/installations')?.template).toBe(
      '/app/installations'
    );
    expect(
      github.find('POST', '/orgs/acme/actions/runners/registration-token')
        ?.template
    ).toBe('/orgs/{org}/actions/runners/registration-token');
    expect(
      github.find('DELETE', '/orgs/acme/actions/runners/12')?.params
    ).toEqual({
      org: 'acme',
      runner_id: '12',
    });
  });
});

describe('response conformance', () => {
  test('a documented error status needs the documented body', () => {
    expect(() =>
      assertResponseConforms('POST', '/repos/acme/app/issues', 422, {
        message: 'Validation Failed',
        documentation_url: 'https://docs.github.com/rest',
      })
    ).not.toThrow();
    expect(() =>
      assertResponseConforms('POST', '/repos/acme/app/issues', 422, {
        message: 'x',
      })
    ).toThrow('documentation_url');
  });

  test('generic errors are checked against basic-error; unknown statuses are refused', () => {
    expect(() =>
      assertResponseConforms('GET', '/app', 429, { message: 'slow down' })
    ).not.toThrow();
    expect(() =>
      assertResponseConforms('GET', '/app', 429, { message: 4 })
    ).toThrow('response.message');
    expect(() =>
      assertResponseConforms('GET', '/app', 418, { message: 'teapot' })
    ).toThrow('not documented');
  });

  test('a response with no documented body must be empty', () => {
    expect(() =>
      assertResponseConforms(
        'DELETE',
        '/repos/acme/app/actions/runners/1',
        204,
        null
      )
    ).not.toThrow();
    expect(() =>
      assertResponseConforms(
        'DELETE',
        '/repos/acme/app/actions/runners/1',
        204,
        { a: 1 }
      )
    ).toThrow('documents no body');
  });

  test('rate-limit headers must be integers', () => {
    const ok = new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1700000000',
      'retry-after': '30',
    });
    expect(github.headerProblems(ok)).toEqual([]);
    expect(
      github.headerProblems(new Headers({ 'x-ratelimit-remaining': 'none' }))[0]
    ).toContain('x-ratelimit-remaining');
    expect(
      github.headerProblems(new Headers({ 'retry-after': 'Wed, 21 Oct' }))[0]
    ).toContain('retry-after');
  });

  test('an OpenApi built from another document uses that document', () => {
    const tiny = new OpenApi({
      paths: {
        '/ping': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', required: ['ok'] },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(tiny.responseProblems('GET', '/ping', 200, {})[0]).toContain('"ok"');
    expect(tiny.responseProblems('GET', '/ping', 200, { ok: true })).toEqual(
      []
    );
  });
});
