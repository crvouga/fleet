import { describe, expect, test } from 'bun:test';

import { recoveryView } from '../../src/domain/recovery';
import type { EventRow } from '../../src/types';

const NOW = new Date('2026-10-26T12:00:00Z');

function facts(recovery: unknown): Record<string, unknown> {
  return { recovery };
}

const healthy = {
  boot: {
    previousClean: true,
    previousEndedAt: '2026-10-25T00:00:00Z',
    uncleanOfLast: [0, 3],
  },
  quarantine: null,
  gate: { closed: false, reasons: [] },
  outbox: 0,
};

function event(
  kind: string,
  message: string,
  data = {},
  hoursAgo = 1
): EventRow {
  return {
    id: 1,
    at: new Date(NOW.getTime() - hoursAgo * 3600_000),
    nodeId: 'n',
    nodeLabel: 'ci-a3f9',
    kind,
    severity: 'warn',
    message,
    data,
  };
}

describe('recoveryView', () => {
  test('an older agent is not reported as healthy', () => {
    const view = recoveryView({}, [], NOW, 'ci');
    expect(view.state).toBe('unknown');
    expect(view.items).toEqual([]);
  });

  test('a clean node has nothing to recover from', () => {
    const view = recoveryView(facts(healthy), [], NOW, 'ci');
    expect(view.state).toBe('ok');
    expect(view.items.map((item) => item.tone)).toEqual(['ok', 'ok', 'ok']);
  });

  test('an unclean shutdown says what it could have been, not what it was', () => {
    const view = recoveryView(
      facts({
        ...healthy,
        boot: {
          previousClean: false,
          previousEndedAt: null,
          uncleanOfLast: [2, 5],
        },
      }),
      [],
      NOW,
      'ci'
    );
    expect(view.state).toBe('recovered');
    expect(view.items[0]?.detail).toContain(
      'power loss, a hard reset, a kernel panic or a watchdog reset'
    );
    expect(view.items[0]?.detail).toContain('2 of the last 5 boots');
  });

  test('a quarantined kernel needs a decision and offers a retry', () => {
    const view = recoveryView(
      facts({
        ...healthy,
        quarantine: {
          revision: 'c839ee07aabb',
          toplevel: '/nix/store/x',
          at: '2026-10-26T10:00:00Z',
          reason: 'The cause is not certain.',
        },
      }),
      [],
      NOW,
      'ci'
    );
    expect(view.state).toBe('attention');
    const kernel = view.items.find((item) => item.label === 'Kernel update');
    expect(kernel?.action).toBe('retry-update');
    expect(kernel?.detail).toContain('revision c839ee07');
    expect(kernel?.detail).toContain('not certain');
  });

  test('closed admission names every reason and offers a reopen only for a manual drain', () => {
    const lowDisk = recoveryView(
      facts({ ...healthy, gate: { closed: true, reasons: ['low-disk'] } }),
      [],
      NOW,
      'ci'
    );
    const admission = lowDisk.items.find(
      (item) => item.label === 'Runner admission'
    );
    expect(admission?.detail).toContain('free disk space');
    expect(admission?.action).toBeUndefined();
    const manual = recoveryView(
      facts({
        ...healthy,
        gate: { closed: true, reasons: ['manual', 'update'] },
      }),
      [],
      NOW,
      'ci'
    );
    const both = manual.items.find((item) => item.label === 'Runner admission');
    expect(both?.action).toBe('reopen-admission');
    expect(both?.detail).toContain('by hand');
    expect(both?.detail).toContain('an update is draining');
  });

  test('recent interrupted jobs are listed with a link to the run; old ones are not', () => {
    const events = [
      event(
        'job-interrupted',
        'A CI job on slot-1 was interrupted by a reset or power loss',
        {
          url: 'https://github.com/owner/repo/actions/runs/1234',
        }
      ),
      event('job-interrupted', 'old', {}, 24 * 9),
      event('job-interrupted', 'bad link', { url: 'https://evil.example/x' }),
    ];
    const view = recoveryView(facts(healthy), events, NOW, 'ci');
    const jobs = view.items.filter((item) => item.label === 'Interrupted job');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.link).toBe(
      'https://github.com/owner/repo/actions/runs/1234'
    );
    expect(jobs[1]?.link).toBeUndefined();
    expect(view.state).toBe('recovered');
  });

  test('a devbox has no runner admission line', () => {
    const view = recoveryView(facts(healthy), [], NOW, 'devbox');
    expect(view.items.map((item) => item.label)).toEqual([
      'Last shutdown',
      'Kernel update',
    ]);
  });

  test('events still on the node are counted', () => {
    const view = recoveryView(facts({ ...healthy, outbox: 3 }), [], NOW, 'ci');
    expect(view.items.at(-1)?.detail).toContain('3 recovery events');
  });
});
