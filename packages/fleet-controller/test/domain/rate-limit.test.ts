import { describe, expect, test } from 'bun:test';

import { RateLimiter } from '../../src/domain/rate-limit';

function limiter(limit: number, windowMs: number, maxKeys?: number) {
  let now = 1_000_000;
  const instance = new RateLimiter({
    limit,
    windowMs,
    now: () => now,
    ...(maxKeys !== undefined ? { maxKeys } : {}),
  });
  return { instance, advance: (ms: number) => (now += ms) };
}

describe('RateLimiter', () => {
  test('allows the limit, then refuses with the seconds to wait', () => {
    const { instance, advance } = limiter(3, 60_000);
    expect([1, 2, 3].map(() => instance.hit('a').allowed)).toEqual([
      true,
      true,
      true,
    ]);
    advance(15_000);
    expect(instance.hit('a')).toEqual({
      allowed: false,
      retryAfterSeconds: 45,
    });
    expect(instance.hit('a').allowed).toBe(false);
  });

  test('a new window starts exactly when the old one ends', () => {
    const { instance, advance } = limiter(1, 1000);
    expect(instance.hit('a').allowed).toBe(true);
    advance(999);
    expect(instance.hit('a').allowed).toBe(false);
    advance(1);
    expect(instance.hit('a').allowed).toBe(true);
  });

  test('keys are independent', () => {
    const { instance } = limiter(1, 1000);
    expect(instance.hit('a').allowed).toBe(true);
    expect(instance.hit('b').allowed).toBe(true);
    expect(instance.hit('a').allowed).toBe(false);
  });

  test('refusals do not extend the window', () => {
    const { instance, advance } = limiter(1, 1000);
    instance.hit('a');
    for (let i = 0; i < 50; i += 1) instance.hit('a');
    advance(1000);
    expect(instance.hit('a').allowed).toBe(true);
  });

  test('retry-after is at least one second', () => {
    const { instance, advance } = limiter(1, 1000);
    instance.hit('a');
    advance(999);
    expect(instance.hit('a').retryAfterSeconds).toBe(1);
  });

  test('memory is bounded: past maxKeys the oldest keys are forgotten', () => {
    const { instance } = limiter(1, 60_000, 3);
    for (const key of ['a', 'b', 'c', 'd']) instance.hit(key);
    expect(instance.hit('d').allowed).toBe(false);
    expect(instance.hit('a').allowed).toBe(true);
  });

  test('expired keys are dropped first when the bound is hit', () => {
    const { instance, advance } = limiter(1, 1000, 2);
    instance.hit('old');
    advance(2000);
    instance.hit('b');
    instance.hit('c');
    expect(instance.hit('b').allowed).toBe(false);
    expect(instance.hit('c').allowed).toBe(false);
  });
});
