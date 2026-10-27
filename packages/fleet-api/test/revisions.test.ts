import { describe, expect, test } from 'bun:test';

import { GithubRevisionSource } from '../src/revisions/github';

import { Clock, silent } from './support/api';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly redirect: string | undefined;
}

type Answer = Response | Error;

function harness(answers: Answer[]) {
  const clock = new Clock();
  const calls: Call[] = [];
  const queue = [...answers];
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      redirect: init?.redirect,
    });
    const next = queue.shift();
    if (next === undefined) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const source = new GithubRevisionSource({
    repo: 'crvouga/fleet',
    fetch: fakeFetch,
    now: clock.now,
    log: silent,
  });
  return { source, clock, calls };
}

const ok = (sha: string, etag = `"etag-${sha.slice(0, 4)}"`) =>
  new Response(`${sha}\n`, { status: 200, headers: { ETag: etag } });

describe('GithubRevisionSource', () => {
  test('asks for the sha of main on the configured repository', async () => {
    const { source, calls } = harness([ok(SHA_A)]);
    expect(await source.latest()).toBe(SHA_A);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/crvouga/fleet/commits/main'
    );
    expect(calls[0]?.headers['Accept']).toBe('application/vnd.github.sha');
    expect(calls[0]?.headers['User-Agent']).toBe('fleet-api');
    expect(calls[0]?.redirect).toBe('manual');
  });

  test('caches for sixty seconds', async () => {
    const { source, clock, calls } = harness([ok(SHA_A), ok(SHA_B)]);
    expect(await source.latest()).toBe(SHA_A);
    clock.advance(59);
    expect(await source.latest()).toBe(SHA_A);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    expect(await source.latest()).toBe(SHA_B);
    expect(calls).toHaveLength(2);
  });

  test('revalidates with the ETag and keeps the value on 304', async () => {
    const { source, clock, calls } = harness([
      ok(SHA_A, '"v1"'),
      new Response(null, { status: 304 }),
    ]);
    await source.latest();
    clock.advance(61);
    expect(await source.latest()).toBe(SHA_A);
    expect(calls[1]?.headers['If-None-Match']).toBe('"v1"');
  });

  test('a new commit replaces the value and the ETag', async () => {
    const { source, clock, calls } = harness([
      ok(SHA_A, '"v1"'),
      ok(SHA_B, '"v2"'),
      new Response(null, { status: 304 }),
    ]);
    await source.latest();
    clock.advance(61);
    expect(await source.latest()).toBe(SHA_B);
    clock.advance(61);
    expect(await source.latest()).toBe(SHA_B);
    expect(calls[2]?.headers['If-None-Match']).toBe('"v2"');
  });

  test('any failure returns the last good value', async () => {
    const failures: Answer[] = [
      new Response('rate limited', { status: 403 }),
      new Response('oops', { status: 500 }),
      new Error('network down'),
      new Response('not a sha', { status: 200 }),
      new Response('A'.repeat(40) + 'zz', { status: 200 }),
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example' },
      }),
    ];
    const { source, clock } = harness([ok(SHA_A), ...failures]);
    expect(await source.latest()).toBe(SHA_A);
    for (let i = 0; i < failures.length; i += 1) {
      clock.advance(61);
      expect(await source.latest()).toBe(SHA_A);
    }
  });

  test('with no good value yet, failure is null and never throws', async () => {
    const { source } = harness([new Error('network down')]);
    expect(await source.latest()).toBeNull();
  });

  test('a failure is not retried until the cache window passes', async () => {
    const { source, clock, calls } = harness([
      new Response('no', { status: 503 }),
      ok(SHA_A),
    ]);
    expect(await source.latest()).toBeNull();
    clock.advance(30);
    expect(await source.latest()).toBeNull();
    expect(calls).toHaveLength(1);
    clock.advance(31);
    expect(await source.latest()).toBe(SHA_A);
  });

  test('concurrent callers share one request', async () => {
    const { source, calls } = harness([ok(SHA_A)]);
    const results = await Promise.all([
      source.latest(),
      source.latest(),
      source.latest(),
    ]);
    expect(results).toEqual([SHA_A, SHA_A, SHA_A]);
    expect(calls).toHaveLength(1);
  });

  test('uppercase hex is normalised', async () => {
    const { source } = harness([ok(SHA_A.toUpperCase())]);
    expect(await source.latest()).toBe(SHA_A);
  });
});
