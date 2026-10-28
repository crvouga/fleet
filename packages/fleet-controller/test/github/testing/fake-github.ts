import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

import { freePort } from '../../support/port';

export interface Injected {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface FakeRunner {
  id: number;
  name: string;
  status: 'online' | 'offline';
  busy: boolean;
  labels: string[];
}

export interface FakeJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  labels: string[];
  runner_id: number | null;
  runner_name: string | null;
  html_url: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FakeRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  updated_at: string;
}

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly bearer: string;
}

export interface FakeGithub {
  readonly url: string;
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: KeyObject;
  readonly requests: Recorded[];
  /** Runners per `owner/name`, or per organization name. */
  readonly runners: Map<string, FakeRunner[]>;
  readonly runs: Map<string, FakeRun[]>;
  readonly jobs: Map<number, FakeJob[]>;
  /** Fail matching requests with these answers, in order, before serving normally. */
  inject(match: string, ...answers: Injected[]): void;
  /** Fail every matching request until cleared. */
  injectAlways(match: string, answer: Injected): void;
  clearInjected(): void;
  count(match: string): number;
  /** Make every issued installation token invalid (as if it expired early). */
  revokeInstallationTokens(): void;
  stop(): void;
}

let pair: { privateKey: KeyObject; publicKey: KeyObject } | null = null;

/** One RSA key per test process: generating them is the slow part. */
export function testKeyPair() {
  pair ??= generateKeyPairSync('rsa', { modulusLength: 2048 });
  return pair;
}

function b64(part: string): Buffer {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function validJwt(token: string, appId: string): boolean {
  const [header, claims, signature] = token.split('.');
  if (header === undefined || claims === undefined || signature === undefined)
    return false;
  const verify = createVerify('RSA-SHA256');
  verify.update(`${header}.${claims}`);
  const key = testKeyPair().publicKey;
  if (!verify.verify(key, b64(signature))) return false;
  const body = JSON.parse(b64(claims).toString('utf8')) as {
    iss: string;
    iat: number;
    exp: number;
  };
  return (
    body.iss === appId && body.exp - body.iat <= 600 && body.exp > body.iat
  );
}

export interface FakeOptions {
  readonly now: () => Date;
  readonly appId?: string;
  readonly installationId?: string;
}

interface World {
  readonly appId: string;
  readonly installationId: string;
  readonly now: () => Date;
  readonly tokens: Set<string>;
  readonly runners: Map<string, FakeRunner[]>;
  readonly runs: Map<string, FakeRun[]>;
  readonly jobs: Map<number, FakeJob[]>;
  issued: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const notFound = () => json({ message: 'Not Found' }, 404);
const expires = (world: World) =>
  new Date(world.now().getTime() + 3600_000).toISOString();

interface Call {
  readonly method: string;
  readonly url: URL;
}

function deleteRoute(
  world: World,
  target: string,
  runner: FakeRunner,
  rest: string[]
): Response {
  if (rest[1] === 'labels') {
    const label = decodeURIComponent(rest[2] ?? '');
    runner.labels = runner.labels.filter((l) => l !== label);
    return json({ labels: runner.labels });
  }
  if (runner.busy) return json({ message: 'Runner is busy' }, 422);
  const list = world.runners.get(target) ?? [];
  world.runners.set(
    target,
    list.filter((r) => r !== runner)
  );
  return new Response(null, { status: 204 });
}

function runnerRoute(
  world: World,
  target: string,
  rest: string[],
  call: Call
): Response {
  const list = world.runners.get(target) ?? [];
  if (call.method === 'GET' && rest.length === 0) {
    const page = Number(call.url.searchParams.get('page') ?? '1');
    const size = Number(call.url.searchParams.get('per_page') ?? '30');
    const slice = list.slice((page - 1) * size, page * size);
    return json({ total_count: list.length, runners: slice });
  }
  if (call.method === 'POST' && rest[0] === 'registration-token') {
    world.issued += 1;
    const token = `REGTOKEN-${world.issued}`;
    return json({ token, expires_at: expires(world) }, 201);
  }
  const runner = list.find((r) => String(r.id) === rest[0]);
  if (runner === undefined || call.method !== 'DELETE') return notFound();
  return deleteRoute(world, target, runner, rest);
}

function appRoute(world: World, parts: string[], bearer: string): Response {
  if (!validJwt(bearer, world.appId))
    return json({ message: 'Bad credentials' }, 401);
  if (parts.length === 1) return json({ slug: 'fleet-test' });
  if (parts.length === 2)
    return json([
      { id: Number(world.installationId), account: { login: 'acme' } },
    ]);
  if (parts[2] !== world.installationId) return notFound();
  world.issued += 1;
  const token = `ghs_installation_${world.issued}`;
  world.tokens.add(token);
  return json({ token, expires_at: expires(world) }, 201);
}

function repoRoute(world: World, parts: string[], call: Call): Response {
  const repository = `${parts[1]}/${parts[2]}`;
  const { url } = call;
  if (parts[4] === 'runners')
    return runnerRoute(world, repository, parts.slice(5), call);
  if (parts[4] !== 'runs') return notFound();
  if (parts.length === 5) {
    const status = url.searchParams.get('status');
    const runs = (world.runs.get(repository) ?? []).filter(
      (r) => r.status === status
    );
    const rows = runs.map((r) => ({
      ...r,
      repository: { full_name: repository },
    }));
    return json({ workflow_runs: rows });
  }
  return parts[6] === 'jobs'
    ? json({ jobs: world.jobs.get(Number(parts[5])) ?? [] })
    : notFound();
}

function route(world: World, call: Call, bearer: string): Response {
  const { url } = call;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'app') return appRoute(world, parts, bearer);
  if (!world.tokens.has(bearer))
    return json({ message: 'Bad credentials' }, 401);
  if (parts[0] === 'installation') {
    const names = [...world.runs.keys()].map((full_name) => ({ full_name }));
    return json({ repositories: names });
  }
  if (parts[0] === 'orgs' && parts[2] === 'actions' && parts[3] === 'runners')
    return runnerRoute(world, parts[1] ?? '', parts.slice(4), call);
  return parts[0] === 'repos' && parts[3] === 'actions'
    ? repoRoute(world, parts, call)
    : notFound();
}

/** A loopback GitHub: App JWT auth, installation tokens, runners, runs, jobs. */
export async function startFakeGithub(
  options: FakeOptions
): Promise<FakeGithub> {
  const world: World = {
    appId: options.appId ?? '12345',
    installationId: options.installationId ?? '777',
    now: options.now,
    tokens: new Set(),
    runners: new Map(),
    runs: new Map(),
    jobs: new Map(),
    issued: 0,
  };
  const requests: Recorded[] = [];
  const queued: { match: string; answers: Injected[] }[] = [];
  const always = new Map<string, Injected>();
  const injected = (key: string): Injected | null => {
    for (const entry of queued) {
      if (key.includes(entry.match) && entry.answers.length > 0)
        return entry.answers.shift() ?? null;
    }
    for (const [match, spec] of always) if (key.includes(match)) return spec;
    return null;
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: await freePort(),
    fetch(request) {
      const url = new URL(request.url);
      const bearer = (request.headers.get('authorization') ?? '').replace(
        'Bearer ',
        ''
      );
      requests.push({ method: request.method, path: url.pathname, bearer });
      const spec = injected(`${request.method} ${url.pathname}`);
      if (spec === null)
        return route(world, { method: request.method, url }, bearer);
      return new Response(
        JSON.stringify(spec.body ?? { message: 'injected' }),
        {
          status: spec.status,
          headers: { 'content-type': 'application/json', ...spec.headers },
        }
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    appId: world.appId,
    installationId: world.installationId,
    privateKey: testKeyPair().privateKey,
    requests,
    runners: world.runners,
    runs: world.runs,
    jobs: world.jobs,
    inject: (match, ...answers) => queued.push({ match, answers }),
    injectAlways: (match, answer) => always.set(match, answer),
    clearInjected: () => {
      queued.length = 0;
      always.clear();
    },
    count: (match) =>
      requests.filter((r) => `${r.method} ${r.path}`.includes(match)).length,
    revokeInstallationTokens: () => world.tokens.clear(),
    stop: () => void server.stop(true),
  };
}
