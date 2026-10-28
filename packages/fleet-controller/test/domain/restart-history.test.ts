import { describe, expect, test } from 'bun:test';

import { restartHistory } from '../../src/domain/restart-history';
import type { EventRow } from '../../src/types';
import { nodeIdOf, T0 } from '../support/fixtures';

let id = 0;
function boot(
  seconds: number,
  bootId: string | null,
  data: Record<string, unknown> = {}
): EventRow {
  id += 1;
  return {
    id,
    at: new Date(T0.getTime() + seconds * 1000),
    nodeId: nodeIdOf(1),
    nodeLabel: 'n',
    kind: 'boot',
    severity: 'info',
    message: 'node started',
    data: bootId === null ? data : { key: `boot:${bootId}`, ...data },
  };
}
function unclean(seconds: number, bootId: string): EventRow {
  id += 1;
  return {
    id,
    at: new Date(T0.getTime() + seconds * 1000),
    nodeId: nodeIdOf(1),
    nodeLabel: 'n',
    kind: 'unclean-shutdown',
    severity: 'warn',
    message: 'bad',
    data: { bootId },
  };
}
const NOW = new Date(T0.getTime() + 10 * 24 * 3600 * 1000);
const node = { bootId: 'c', uptimeSeconds: 3600 };

describe('restartHistory', () => {
  test('lists boots newest first with how the previous boot ended', () => {
    const history = restartHistory(
      [unclean(100, 'a'), boot(0, 'a'), boot(101, 'b'), boot(200, 'c')],
      node,
      NOW
    );
    expect(history.boots.map((b) => [b.bootId, b.previousShutdown])).toEqual([
      ['c', 'clean'],
      ['b', 'unclean'],
      ['a', 'unknown'],
    ]);
    expect(history.restarts).toBe(2);
    expect(history.uncleanShutdowns).toBe(1);
    expect(history.current.bootedAt?.getTime()).toBe(NOW.getTime() - 3600_000);
  });

  test('counts restarts inside 24 hours and 7 days, not the first observed boot', () => {
    const day = 24 * 3600;
    const history = restartHistory(
      [
        boot(0, 'a'),
        boot(10 * day - 3600, 'b'),
        boot(10 * day - 5 * day, 'c'),
        boot(10 * day - 8 * day, 'd'),
      ],
      node,
      NOW
    );
    expect(history.restartsLast24h).toBe(1);
    expect(history.restartsLast7d).toBe(2);
    expect(history.restarts).toBe(3);
  });

  test('duplicate boot ids, controller-derived boots and bad timestamps are handled', () => {
    const history = restartHistory(
      [
        boot(0, 'a'),
        boot(5, 'a'),
        boot(50, null),
        boot(60, 'b', { occurredAt: 'not a date' }),
        boot(70, 'c', { occurredAt: '2999-01-01T00:00:00Z' }),
      ],
      { bootId: null, uptimeSeconds: null },
      NOW
    );
    expect(history.boots).toHaveLength(4);
    expect(
      history.boots.every((b) => b.startedAt.getTime() <= NOW.getTime())
    ).toBe(true);
    expect(history.boots.find((b) => b.bootId === 'b')?.previousShutdown).toBe(
      'unknown'
    );
    expect(history.current).toEqual({
      bootId: null,
      uptimeSeconds: null,
      bootedAt: null,
    });
  });

  test('uses the node clock when it is plausible and keeps at most 20 boots', () => {
    const stated = '2026-10-14T11:00:00.000Z';
    expect(
      restartHistory(
        [boot(0, 'a', { occurredAt: stated })],
        node,
        NOW
      ).boots[0]?.startedAt.toISOString()
    ).toBe(stated);
    const many = Array.from({ length: 30 }, (_, index) =>
      boot(index, `b${index}`)
    );
    const history = restartHistory(many, node, NOW);
    expect(history.boots).toHaveLength(20);
    expect(history.boots[0]?.bootId).toBe('b29');
    expect(history.restarts).toBe(29);
  });

  test('no events means no restarts, not zero uptime', () => {
    expect(
      restartHistory([], { bootId: null, uptimeSeconds: null }, NOW)
    ).toMatchObject({
      boots: [],
      restarts: 0,
      uncleanShutdowns: 0,
    });
  });
});
