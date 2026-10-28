import { describe, expect, test } from 'bun:test';
import { createLogger } from '@pkgs/logger';

import {
  ConfigurationError,
  readControllerEnv,
  type EnvSource,
} from '../../src/env';
import { readBuildInfo } from '../../src/issues/build-info';
import { classify } from '../../src/issues/classify';
import { createErrorRing, describeError } from '../../src/issues/errors';
import {
  fingerprintIn,
  fingerprintOf,
  markerFor,
  normalizeMessage,
} from '../../src/issues/fingerprint';
import { reportUrl } from '../../src/issues/links';
import {
  fenced,
  fitSections,
  inline,
  safeWord,
  type Section,
} from '../../src/issues/markdown';
import { NEW_ISSUE_URL_MAX, newIssueUrl } from '../../src/issues/prefill';
import { shrinkJson } from '../../src/issues/render';
import { parseTarget } from '../../src/issues/target';
import { startJobs, DEFAULT_TIMINGS } from '../../src/jobs/scheduler';
import { createTestDeps } from '../../src/testing/test-deps';
import { MemoryIssueStore } from '../../src/issues/memory-store';
import { withIssues } from '../../src/issues/compose';
import { IDS } from './support';

const BASE: EnvSource = {
  FLEET_S3_BUCKET: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
  FLEET_ADMIN_TOKEN: 'a'.repeat(32),
  FLEET_SESSION_SECRET: 'b'.repeat(32),
};

function refused(extra: EnvSource): string {
  try {
    readControllerEnv({ ...BASE, ...extra });
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error('expected a configuration error');
}

describe('FLEET_ISSUES_* environment', () => {
  test('is off by default', () => {
    expect(readControllerEnv(BASE).issues).toBeUndefined();
  });

  test('token and repository turn filing on; labels and API URL are optional', () => {
    const env = readControllerEnv({
      ...BASE,
      FLEET_ISSUES_GITHUB_TOKEN: 'github_pat_' + 'x'.repeat(30),
      FLEET_ISSUES_REPOSITORY: 'acme/fleet-reports',
      FLEET_ISSUES_LABELS: 'fleet-report, bug',
      FLEET_ISSUES_GITHUB_API_URL: 'https://ghe.example/api/v3/',
    });
    expect(env.issues).toEqual({
      token: 'github_pat_' + 'x'.repeat(30),
      repository: 'acme/fleet-reports',
      labels: ['fleet-report', 'bug'],
      apiUrl: 'https://ghe.example/api/v3',
    });
  });

  test('a repository alone enables only the prefilled link', () => {
    const env = readControllerEnv({
      ...BASE,
      FLEET_ISSUES_REPOSITORY: 'acme/fleet-reports',
    });
    expect(env.issues).toMatchObject({ repository: 'acme/fleet-reports' });
    expect(env.issues?.token).toBeUndefined();
  });

  test('refuses a token with nowhere to file, bad values, and never echoes the token', () => {
    const secret = 'github_pat_' + 'SECRETVALUE'.repeat(3);
    const text = refused({ FLEET_ISSUES_GITHUB_TOKEN: secret });
    expect(text).toContain('FLEET_ISSUES_REPOSITORY');
    expect(text).not.toContain(secret);
    expect(refused({ FLEET_ISSUES_REPOSITORY: 'not-a-repo' })).toContain(
      'owner/name'
    );
    const spaced = refused({
      FLEET_ISSUES_REPOSITORY: 'a/b',
      FLEET_ISSUES_GITHUB_TOKEN: 'short token',
    });
    expect(spaced).toContain('FLEET_ISSUES_GITHUB_TOKEN must be');
    expect(spaced).not.toContain('short token');
    expect(
      refused({
        FLEET_ISSUES_REPOSITORY: 'a/b',
        FLEET_ISSUES_GITHUB_API_URL: 'http://evil.example',
      })
    ).toContain('FLEET_ISSUES_GITHUB_API_URL');
    expect(
      refused({
        FLEET_ISSUES_REPOSITORY: 'a/b',
        FLEET_ISSUES_LABELS: 'a'.repeat(80),
      })
    ).toContain('FLEET_ISSUES_LABELS');
    expect(
      readControllerEnv({
        ...BASE,
        FLEET_ISSUES_REPOSITORY: 'a/b',
        FLEET_ISSUES_GITHUB_API_URL: 'http://127.0.0.1:9',
      }).issues?.apiUrl
    ).toBe('http://127.0.0.1:9');
  });
});

describe('build info', () => {
  test('reads the commit from the first variable that holds one, else "unknown"', () => {
    expect(readBuildInfo({}).commit).toBe('unknown');
    expect(readBuildInfo({ GIT_COMMIT: 'not a sha' }).commit).toBe('unknown');
    expect(
      readBuildInfo({
        GIT_COMMIT: 'abcdef1234567',
        RAILWAY_GIT_COMMIT_SHA: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
      }).commit
    ).toBe('9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283');
    expect(readBuildInfo({}).version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('fingerprints', () => {
  const base = {
    kind: 'node' as 'node' | 'installer',
    classification: 'rollback',
    role: 'ci',
    closure: 'ci',
    component: 'fleet-sync',
  };
  test('normalization strips what varies', () => {
    const a = normalizeMessage(
      'Failed at 2026-10-14T12:00:00.123Z on fleet-ab12: /nix/store/abc/bin x 42 times (req 6f1c7a8e-1111-4222-8333-944455556666) https://x.test/a?b=1 9f3c2a1'
    );
    const b = normalizeMessage(
      'Failed at 2027-01-01 01:02:03 on fleet-cd34: /nix/store/zzz/bin x 7 times (req aaaaaaaa-1111-4222-8333-944455556666) https://y.test/q 1234abc'
    );
    expect(a).toBe(b);
  });
  test('each ingredient changes the fingerprint', () => {
    const f = (over: Partial<typeof base> & { message?: string } = {}) =>
      fingerprintOf({ ...base, message: 'boom', ...over });
    expect(f()).toBe(f());
    expect(
      new Set([
        f(),
        f({ kind: 'installer' }),
        f({ classification: 'x' }),
        f({ message: 'other' }),
        f({ role: 'web' }),
        f({ closure: 'ci-gpu' }),
        f({ component: 'secrets' }),
      ]).size
    ).toBe(7);
  });
  test('the marker round-trips and only a well-formed one counts', () => {
    const fp = 'a'.repeat(32);
    expect(fingerprintIn(`text\n${markerFor(fp)}\nmore`)).toBe(fp);
    expect(fingerprintIn('<!-- fleet-issue-fingerprint:short -->')).toBeNull();
    expect(fingerprintIn('no marker')).toBeNull();
  });
});

describe('classification', () => {
  test('names failures by kind and keeps kinds apart', () => {
    expect(
      classify('node', 'rollback', 'rolled back to the previous system').code
    ).toBe('rollback');
    expect(
      classify(
        'node',
        'reconcile_blocked',
        'FLEET_SECRETS_RECIPIENT_MISSING: x'
      ).code
    ).toBe('secrets-recipient-missing');
    expect(
      classify('node', 'offline', 'x has not reported for 400 seconds').code
    ).toBe('node-offline');
    expect(
      classify('installer', 'install', 'checksum mismatch for image').code
    ).toBe('installer-checksum');
    expect(
      classify('workload', 'ci_job', 'job "t" concluded failure in a/b').code
    ).toBe('ci-job-failed');
    expect(
      classify('controller', 'controller_error', 'Unhandled TypeError: x').code
    ).toBe('controller-error');
    expect(classify('node', null, 'something odd').code).toBe('node-problem');
    expect(classify('workload', 'rollback', 'rolled back').component).toBe(
      'runner'
    );
  });
});

describe('targets', () => {
  test('infers the kind and validates ids', () => {
    expect(parseTarget({ job: '77' })).toEqual({
      ok: true,
      target: { kind: 'workload', jobId: 77 },
    });
    expect(parseTarget({ request: '6f1c7a8e-1111-4222' })).toMatchObject({
      ok: true,
      target: { kind: 'controller' },
    });
    expect(parseTarget({ node: IDS.online, event: '4' })).toEqual({
      ok: true,
      target: { kind: 'node', nodeId: IDS.online, eventId: 4 },
    });
    expect(parseTarget({ kind: 'controller' })).toEqual({
      ok: true,
      target: { kind: 'controller' },
    });
    expect(parseTarget({})).toMatchObject({ ok: false });
    expect(parseTarget({ kind: 'node' })).toMatchObject({ ok: false });
    expect(parseTarget({ kind: 'node', node: 'zz' })).toMatchObject({
      ok: false,
    });
    expect(
      parseTarget({ kind: 'node', node: IDS.online, event: '-3' })
    ).toMatchObject({ ok: false });
    expect(parseTarget({ kind: 'workload', job: '1e3' })).toMatchObject({
      ok: false,
    });
    expect(parseTarget({ kind: 'node', operation: '../x' })).toMatchObject({
      ok: false,
    });
  });
  test('reportUrl and parseTarget agree', () => {
    const url = new URL(
      reportUrl({
        kind: 'node',
        nodeId: IDS.online,
        eventId: 4,
        operationId: 'op-1',
      }),
      'http://x'
    );
    expect(parseTarget(Object.fromEntries(url.searchParams))).toEqual({
      ok: true,
      target: {
        kind: 'node',
        nodeId: IDS.online,
        eventId: 4,
        operationId: 'op-1',
      },
    });
  });
});

describe('markdown safety', () => {
  test('inline code outgrows any backtick run; fences too', () => {
    expect(inline('a `b` c')).toBe('``a `b` c``');
    expect(inline('`x`')).toBe('`` `x` ``');
    expect(inline('line\none')).toBe('`line one`');
    expect(fenced(['```', 'x'])[0]).toBe('````');
    expect(fenced(['x'], 'json')).toEqual(['```json', 'x', '```']);
    expect(safeWord('a b/c<script>@x')).toBe('a-b/c-script-x');
  });

  test('fitSections halves the largest section first and marks every cut', () => {
    const big: Section = {
      title: 'Big',
      lines: Array.from(
        { length: 200 },
        (_, i) => `line ${i} ${'x'.repeat(50)}`
      ),
    };
    const small: Section = { title: 'Small', lines: ['a', 'b', 'c', 'd', 'e'] };
    const keep: Section = {
      title: 'Keep',
      lines: Array.from({ length: 50 }, () => 'k'.repeat(60)),
      truncatable: false,
    };
    const fitted = fitSections('# head\n', [small, big, keep], 6000);
    expect(fitted.text.length).toBeLessThanOrEqual(6000);
    expect(fitted.truncated).toEqual(['Big']);
    expect(fitted.text).toMatch(/\[truncated \d+ lines\]/);
    expect(fitted.text).toContain('## Small');
    expect(fitted.text.match(/k{60}/g)).toHaveLength(50);
    const none = fitSections('h', [small], 6000);
    expect(none.truncated).toEqual([]);
    const brutal = fitSections('h', [keep], 500);
    expect(brutal.text.length).toBeLessThanOrEqual(500);
    expect(brutal.truncated).toContain('body');
  });

  test('shrinkJson stays valid JSON within budget and records what it cut', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      at: 'x',
      source: 'event' as const,
      kind: 'k',
      message: `m${i}`.repeat(20),
    }));
    const diag = {
      schema: 1,
      kind: 'node',
      timeline: entries,
      logs: [],
      reconcileHistory: [],
      actions: [],
      testFailures: [],
      effectiveConfig: {},
      desired: null,
    } as never;
    const text = shrinkJson(diag, 5000);
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(JSON.parse(text).truncated.timeline).toBeGreaterThan(0);
  });
});

describe('prefilled new-issue address', () => {
  test('short bodies pass through whole', () => {
    const url = newIssueUrl({
      origin: 'https://github.com',
      repository: 'a/b',
      title: 'T',
      body: 'short',
      labels: ['x', 'y'],
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/a/b/issues/new');
    expect(parsed.searchParams.get('body')).toBe('short');
    expect(parsed.searchParams.get('labels')).toBe('x,y');
  });
  test('long, multi-byte bodies are cut at a line, noted, and always fit', () => {
    const body = [
      '<!-- fleet-issue-fingerprint:' + 'a'.repeat(32) + ' -->',
      ...Array.from(
        { length: 500 },
        (_, i) => `line ${i} ü€😀 ${'x'.repeat(30)}`
      ),
    ].join('\n');
    const url = newIssueUrl({
      origin: 'https://github.com',
      repository: 'a/b',
      title: 'T'.repeat(100),
      body,
      labels: [],
    });
    expect(url.length).toBeLessThanOrEqual(NEW_ISSUE_URL_MAX);
    const text = new URL(url).searchParams.get('body')!;
    expect(text.startsWith('<!-- fleet-issue-fingerprint:')).toBe(true);
    expect(text).toContain('Shortened for the length of a web address');
    expect(text).not.toContain('�');
  });
});

describe('error ring', () => {
  test('is bounded, newest wins, and describes errors without their payloads', () => {
    const ring = createErrorRing(3);
    for (let i = 0; i < 5; i += 1)
      ring.record(
        describeError(new Error(`e${i}`), {
          requestId: `r${i}`,
          at: new Date(0),
          method: 'GET',
          route: '/x',
          status: 500,
        })
      );
    expect(ring.find('r0')).toBeUndefined();
    expect(ring.find('r4')?.message).toBe('e4');
    expect(ring.recent(2).map((e) => e.requestId)).toEqual(['r4', 'r3']);
    const odd = describeError('plain string', {
      requestId: 'q',
      at: new Date(0),
      method: 'GET',
      route: '/',
      status: 500,
    });
    expect(odd).toMatchObject({
      name: 'NonError',
      message: 'plain string',
      stack: [],
    });
  });
});

describe('scheduler', () => {
  test('registers the issue sync only when issue reporting exists, and runs it', async () => {
    const base = createTestDeps();
    const calls: string[] = [];
    const api = { calls };
    void api;
    const withRuntime = withIssues(base, {
      store: new MemoryIssueStore(),
      log: createLogger({ name: 't', level: 'silent' }),
    });
    let ticks = 0;
    const runtime = withRuntime.issues!;
    const spy = {
      ...runtime,
      store: Object.assign(Object.create(runtime.store), {
        due: async () => {
          ticks += 1;
          return [];
        },
      }),
    };
    const configured = {
      ...runtime,
      config: {
        token: 'x'.repeat(30),
        repository: 'a/b',
        labels: [],
        apiUrl: 'http://127.0.0.1:1',
      },
      store: spy.store,
    };
    const jobs = startJobs(
      {
        store: base.store,
        now: base.now,
        fetch: async () => new Response('ok'),
        log: createLogger({ name: 't', level: 'silent' }),
        issues: configured,
      },
      {
        ...DEFAULT_TIMINGS,
        sweepEveryMs: 1_000_000,
        pruneEveryMs: 1_000_000,
        issueSyncEveryMs: 10,
      }
    );
    await Bun.sleep(80);
    jobs.stop();
    expect(ticks).toBeGreaterThan(1);
    const idle = startJobs(
      {
        store: base.store,
        now: base.now,
        fetch: async () => new Response('ok'),
        log: createLogger({ name: 't', level: 'silent' }),
      },
      { ...DEFAULT_TIMINGS, issueSyncEveryMs: 10 }
    );
    idle.stop();
  });
});
