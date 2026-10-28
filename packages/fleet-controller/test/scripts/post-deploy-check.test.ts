import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { createController } from '../../src/app';
import {
  UsageError,
  parseConfig,
  runPostDeploy,
  type Config,
} from '../../scripts/post-deploy-check';
import {
  createGithubHarness,
  type GithubHarness,
} from '../github/testing/harness';
import { ADMIN_TOKEN, silent } from '../support/controller';
import { freePort } from '../support/port';

const SCRIPT = join(import.meta.dir, '../../scripts/post-deploy-check.ts');

type Handler = (request: Request) => Response | Promise<Response>;

interface Served {
  readonly url: string;
  readonly hits: string[];
  stop(): void;
}

/** A loopback HTTP server; `wrap` may answer instead of the real controller. */
function serve(
  real: Handler,
  wrap?: (request: Request, real: Handler) => Response | Promise<Response>
): Served {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request) => {
      hits.push(`${request.method} ${new URL(request.url).pathname}`);
      return wrap ? wrap(request, real) : real(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    hits,
    stop: () => void server.stop(true),
  };
}

function config(url: string, overrides: Partial<Config> = {}): Config {
  return {
    url,
    adminToken: ADMIN_TOKEN,
    expectSchema: 3,
    timeoutMs: 5000,
    retries: 2,
    backoffMs: 0,
    requireGithub: false,
    ...overrides,
  };
}

async function run(url: string, overrides: Partial<Config> = {}) {
  const lines: string[] = [];
  const code = await runPostDeploy(config(url, overrides), {
    write: (line) => lines.push(line),
    sleep: async () => undefined,
  });
  return { code, output: lines.join('\n') };
}

describe('post-deploy check against a real controller over HTTP', () => {
  let h: GithubHarness;
  let real: Handler;
  const servers: Served[] = [];

  beforeAll(async () => {
    h = await createGithubHarness();
    const app = createController(h.deps, { log: silent });
    real = (request) => app.fetch(request);
  });
  afterAll(async () => {
    for (const server of servers) server.stop();
    await h.close();
  });
  const start = (wrap?: Parameters<typeof serve>[1]): Served => {
    const server = serve(real, wrap);
    servers.push(server);
    return server;
  };

  test('passes on a healthy controller and reports GitHub as not configured', async () => {
    const { code, output } = await run(start().url);
    expect(output).toContain('ok    health: HTTP 200');
    expect(output).toContain(
      'ok    auth boundary: GET /v1/nodes with no credentials is 401'
    );
    expect(output).toContain(
      'ok    auth boundary: GET /v1/nodes with a wrong admin token is 401'
    );
    expect(output).toContain('ok    schema: schema 3 markers present');
    expect(output).toContain('ok    github: unconfigured');
    expect(output).toContain('PASSED');
    expect(code).toBe(0);
    expect(output).not.toContain(ADMIN_TOKEN);
  });

  test('--require-github turns "not configured" into a failure; a verified integration passes', async () => {
    const unconfigured = await run(start().url, { requireGithub: true });
    expect(unconfigured.code).toBe(1);
    expect(unconfigured.output).toContain(
      'FAIL  github: unconfigured, but --require-github was set'
    );

    await h.configure();
    const verify = await h.admin('POST', '/v1/github/verify');
    expect(verify.body.ok).toBe(true);
    const ready = await run(start().url, { requireGithub: true });
    expect(ready.output).toContain('ok    github: ready');
    expect(ready.code).toBe(0);
  });

  test('a configured integration that GitHub refuses is an error with the public code', async () => {
    h.fake.injectAlways(
      'POST /repos/acme/app/actions/runners/registration-token',
      { status: 403 }
    );
    const verify = await h.admin('POST', '/v1/github/verify');
    expect(verify.body.ok).toBe(false);
    const { code, output } = await run(start().url);
    h.fake.clearInjected();
    expect(code).toBe(1);
    expect(output).toContain('FAIL  github: error: ');
    expect(output).toContain('FLEET_GITHUB_SCOPE');
    await h.admin('POST', '/v1/github/verify');
  });

  test('a wrong admin token fails with an actionable message, stops there and never prints it', async () => {
    const secret = 'not-the-controller-admin-token-0123456789';
    const { code, output } = await run(start().url, { adminToken: secret });
    expect(code).toBe(1);
    expect(output).toContain('rejected FLEET_ADMIN_TOKEN (HTTP 401)');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('ok    summary');
  });

  test('a controller that is not listening is retried, then reported', async () => {
    const port = await freePort();
    const { code, output } = await run(`http://127.0.0.1:${port}`, {
      retries: 2,
    });
    expect(code).toBe(1);
    expect(output).toMatch(/FAIL {2}health: no answer after 3 attempts/);
    expect(output).toContain('check that the deploy finished');
    expect(output).not.toContain('auth boundary');
  });

  test('a controller still starting (503) is waited for', async () => {
    let health = 0;
    const server = start((request, next) =>
      new URL(request.url).pathname === '/health' && (health += 1) <= 2
        ? new Response('starting', { status: 503 })
        : next(request)
    );
    const { code } = await run(server.url, { retries: 3 });
    expect(code).toBe(0);
    expect(server.hits.filter((hit) => hit === 'GET /health')).toHaveLength(3);
  });

  test('a controller that stays at 503 fails after exactly retries + 1 attempts', async () => {
    const server = start(() => new Response('down', { status: 503 }));
    const { code, output } = await run(server.url, { retries: 2 });
    expect(code).toBe(1);
    expect(output).toContain('answered HTTP 503');
    expect(server.hits).toEqual(['GET /health', 'GET /health', 'GET /health']);
  });

  test('a 500 from the API is a failure, not retried', async () => {
    const server = start((request, next) =>
      new URL(request.url).pathname === '/v1/nodes' &&
      request.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}`
        ? new Response('boom', {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
          })
        : next(request)
    );
    const { code, output } = await run(server.url);
    expect(code).toBe(1);
    expect(output).toContain('FAIL  nodes: GET /v1/nodes: HTTP 500');
    expect(server.hits.filter((hit) => hit === 'GET /v1/nodes')).toHaveLength(
      3
    );
  });

  test('an API that can be read without the admin token fails the deploy', async () => {
    const server = start((request, next) =>
      new URL(request.url).pathname === '/v1/nodes'
        ? Response.json(
            { nodes: [] },
            { headers: { 'Cache-Control': 'no-store' } }
          )
        : next(request)
    );
    const { code, output } = await run(server.url);
    expect(code).toBe(1);
    expect(output).toContain(
      'with no credentials answered HTTP 200, expected 401'
    );
  });

  test('responses a proxy made cacheable are reported', async () => {
    const server = start(async (request, next) => {
      const answer = await next(request);
      const headers = new Headers(answer.headers);
      headers.set('Cache-Control', 'public, max-age=60');
      return new Response(await answer.text(), {
        status: answer.status,
        headers,
      });
    });
    const { code, output } = await run(server.url);
    expect(code).toBe(1);
    expect(output).toContain('lacks "Cache-Control: no-store"');
  });

  test('a release from before schema 3 is named as such', async () => {
    const server = start((request, next) => {
      const path = new URL(request.url).pathname;
      return path === '/v1/audit' || path === '/v1/operations'
        ? new Response('{"error":"not_found"}', {
            status: 404,
            headers: { 'Cache-Control': 'no-store' },
          })
        : next(request);
    });
    const { code, output } = await run(server.url);
    expect(code).toBe(1);
    expect(output).toContain('FAIL  audit: GET /v1/audit?limit=1: HTTP 404');
    expect(output).toContain('schema 3 markers are missing');
    expect(output).toContain('do not delete the database');
  });

  test('--expect-schema above what the script can probe is a failure, below is skipped', async () => {
    const server = start();
    expect((await run(server.url, { expectSchema: 4 })).output).toContain(
      'only knows how to probe up to schema 3'
    );
    expect((await run(server.url, { expectSchema: 2 })).code).toBe(0);
  });

  test('a redirect is never followed with the token', async () => {
    const elsewhere = serve(() => new Response('{}'));
    servers.push(elsewhere);
    const server = start((request, next) =>
      new URL(request.url).pathname === '/v1/nodes' &&
      request.headers.get('authorization') === `Bearer ${ADMIN_TOKEN}`
        ? new Response(null, {
            status: 302,
            headers: { Location: `${elsewhere.url}/stolen` },
          })
        : next(request)
    );
    const { code, output } = await run(server.url);
    expect(code).toBe(1);
    expect(output).toContain('HTTP 302');
    expect(elsewhere.hits).toEqual([]);
  });

  test('the command line: exit 0 on a healthy controller, 1 on a wrong token, 2 on bad usage', async () => {
    const server = start();
    const spawn = async (env: Record<string, string>, args: string[] = []) => {
      const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const code = await child.exited;
      return {
        code,
        text:
          (await new Response(child.stdout).text()) +
          (await new Response(child.stderr).text()),
      };
    };
    const healthy = await spawn({
      FLEET_URL: server.url,
      FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    expect(healthy.code).toBe(0);
    expect(healthy.text).toContain('post-deploy check PASSED');
    expect(healthy.text).not.toContain(ADMIN_TOKEN);

    const wrong = await spawn({
      FLEET_URL: server.url,
      FLEET_ADMIN_TOKEN: 'wrong-admin-token-for-the-cli-test-0123456789',
    });
    expect(wrong.code).toBe(1);
    expect(wrong.text).not.toContain('wrong-admin-token-for-the-cli-test');

    const down = await spawn(
      {
        FLEET_URL: `http://127.0.0.1:${await freePort()}`,
        FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      ['--retries', '1', '--backoff', '0']
    );
    expect(down.code).toBe(1);
    expect(down.text).toContain('no answer after 2 attempts');

    const noToken = await spawn({ FLEET_URL: server.url });
    expect(noToken.code).toBe(2);
    expect(noToken.text).toContain('FLEET_ADMIN_TOKEN is not set');
    const insecure = await spawn({
      FLEET_URL: 'http://fleet.example.com',
      FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    expect(insecure.code).toBe(2);
    expect(insecure.text).toContain('must be https');
    expect(insecure.text).not.toContain(ADMIN_TOKEN);
  });
});

describe('post-deploy check configuration', () => {
  const env = {
    FLEET_URL: 'https://fleet.example.com/',
    FLEET_ADMIN_TOKEN: 'secret-token',
  };

  test('reads the URL and token from the environment with safe defaults', () => {
    expect(parseConfig([], env)).toMatchObject({
      url: 'https://fleet.example.com',
      adminToken: 'secret-token',
      expectSchema: 3,
      timeoutMs: 10_000,
      retries: 5,
      backoffMs: 2000,
      requireGithub: false,
    });
    expect(
      parseConfig(
        [
          '--timeout',
          '3',
          '--retries',
          '0',
          '--backoff',
          '1',
          '--expect-schema',
          '3',
          '--require-github',
        ],
        env
      )
    ).toMatchObject({
      timeoutMs: 3000,
      retries: 0,
      backoffMs: 1000,
      requireGithub: true,
    });
  });

  test('refuses what could leak the token', () => {
    for (const url of [
      'http://fleet.example.com',
      'https://user:pw@fleet.example.com',
      'ftp://fleet.example.com',
      'not a url',
      '',
    ]) {
      expect(() => parseConfig([], { ...env, FLEET_URL: url })).toThrow(
        UsageError
      );
    }
    expect(
      parseConfig([], { ...env, FLEET_URL: 'http://127.0.0.1:8080' }).url
    ).toBe('http://127.0.0.1:8080');
    expect(
      parseConfig([], { ...env, FLEET_URL: 'http://localhost:3000' }).url
    ).toBe('http://localhost:3000');
    expect(() => parseConfig([], { FLEET_URL: env.FLEET_URL })).toThrow(
      /FLEET_ADMIN_TOKEN/
    );
    expect(() => parseConfig(['--token', 'x'], env)).toThrow(
      /unknown option --token/
    );
    expect(() => parseConfig(['--retries', '-1'], env)).toThrow(UsageError);
  });
});
