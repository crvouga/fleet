import { describe, expect, test } from 'bun:test';

import {
  deriveIncidents,
  filterIncidents,
  INCIDENT_RULES,
  summarizeIncidents,
} from '../../src/domain/incidents';
import type { EventRow, Severity } from '../../src/types';
import { nodeIdOf, T0 } from '../support/fixtures';

let counter = 0;
function event(
  kind: string,
  seconds: number,
  extra: Partial<EventRow> & { node?: number } = {}
): EventRow {
  counter += 1;
  const { node = 1, ...rest } = extra;
  return {
    id: counter,
    at: new Date(T0.getTime() + seconds * 1000),
    nodeId: nodeIdOf(node),
    nodeLabel: `node-${node}`,
    kind,
    severity: 'warn',
    message: kind,
    data: {},
    ...rest,
  };
}
const NOW = new Date(T0.getTime() + 100_000);

describe('deriveIncidents', () => {
  test('every rule opens on its event and closes on its partner, with duration and a report link', () => {
    for (const rule of INCIDENT_RULES) {
      const open = event(rule.open, 10, { severity: 'error' });
      const close = event(rule.close, 70);
      const [incident, ...rest] = deriveIncidents([close, open], NOW);
      expect(rest).toEqual([]);
      expect(incident).toMatchObject({
        rule: rule.id,
        title: rule.title,
        open: false,
        severity: 'error',
        durationSeconds: 60,
        openEventId: open.id,
        closeEventId: close.id,
        nodeId: nodeIdOf(1),
        reportHref: `/report-issue?kind=node&event=${open.id}`,
      });
      expect(incident?.startedAt).toEqual(open.at);
      expect(incident?.endedAt).toEqual(close.at);
    }
  });

  test('an open incident measures its duration to now', () => {
    const [incident] = deriveIncidents([event('offline', 20)], NOW);
    expect(incident).toMatchObject({
      open: true,
      endedAt: null,
      closeEventId: null,
      durationSeconds: 80,
    });
  });

  test('a close with nothing open and unrelated events are ignored', () => {
    expect(
      deriveIncidents(
        [event('recovered', 5), event('boot', 6), event('revision', 7)],
        NOW
      )
    ).toEqual([]);
    expect(
      deriveIncidents([{ ...event('offline', 1), nodeId: null }], NOW)
    ).toEqual([]);
  });

  test('repeats while open escalate severity but never start a second incident', () => {
    const events = [
      event('disk_health_degraded', 1, {
        severity: 'warn',
        message: 'sda warning',
      }),
      event('disk_health_degraded', 5, {
        severity: 'error',
        message: 'sda failing',
      }),
      event('disk_health_degraded', 9, { severity: 'warn' }),
    ];
    const incidents = deriveIncidents(events, NOW);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      severity: 'error',
      message: 'sda failing',
      open: true,
    });
    expect(incidents[0]?.openEventId).toBe(events[0]?.id);
  });

  test('disk incidents are per mount', () => {
    const events = [
      event('disk_high', 1, { data: { mount: '/nix' } }),
      event('disk_high', 2, { data: { mount: '/boot' } }),
      event('disk_ok', 3, { data: { mount: '/nix' } }),
    ];
    const incidents = deriveIncidents(events, NOW);
    expect(
      incidents.map((incident) => [incident.subject, incident.open]).sort()
    ).toEqual([
      ['/boot', true],
      ['/nix', false],
    ]);
  });

  test('older disk events without data pair by the mount in their message', () => {
    const events = [
      event('disk_high', 1, { message: '/nix is 91% full (alert at 90%)' }),
      event('disk_ok', 2, { message: '/nix is down to 50% full' }),
    ];
    expect(deriveIncidents(events, NOW)[0]).toMatchObject({
      subject: '/nix',
      open: false,
    });
  });

  test('failed units close only when every failed unit has recovered', () => {
    const events = [
      event('units_failed', 1, { data: { units: ['a.service'] } }),
      event('units_failed', 2, { data: { units: ['b.service'] } }),
      event('units_recovered', 3, { data: { units: ['a.service'] } }),
    ];
    expect(deriveIncidents(events, NOW)[0]?.open).toBe(true);
    const done = deriveIncidents(
      [
        ...events,
        event('units_recovered', 4, { data: { units: ['b.service'] } }),
      ],
      NOW
    );
    expect(done).toHaveLength(1);
    expect(done[0]?.open).toBe(false);
    const legacy = deriveIncidents(
      [event('units_failed', 1), event('units_recovered', 2)],
      NOW
    );
    expect(legacy[0]?.open).toBe(false);
  });

  test('incidents of different nodes and rules are independent', () => {
    const events = [
      event('offline', 1, { node: 1 }),
      event('offline', 2, { node: 2 }),
      event('recovered', 3, { node: 1 }),
      event('rollback', 4, { node: 1 }),
    ];
    const incidents = deriveIncidents(events, NOW);
    expect(
      incidents
        .filter((incident) => incident.open)
        .map((incident) => [incident.nodeId, incident.rule])
        .sort()
    ).toEqual(
      [
        [nodeIdOf(1), 'rollback'],
        [nodeIdOf(2), 'offline'],
      ].sort()
    );
  });

  test('a node outage, recovery and a second outage are two incidents', () => {
    const events = [
      event('offline', 1),
      event('recovered', 2),
      event('offline', 3),
    ];
    const incidents = deriveIncidents(events, NOW);
    expect(incidents.map((incident) => incident.open)).toEqual([true, false]);
  });
});

describe('incident invariants over random event streams', () => {
  const kinds = [
    ...INCIDENT_RULES.flatMap((rule) => [rule.open, rule.close]),
    'boot',
    'revision',
  ];
  const severities: Severity[] = ['info', 'warn', 'error'];

  function stream(seed: number): EventRow[] {
    let state = seed;
    const next = (limit: number) => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state % limit;
    };
    return Array.from({ length: 60 }, (_, index) =>
      event(kinds[next(kinds.length)]!, index * 5, {
        node: 1 + next(3),
        severity: severities[next(3)]!,
        data:
          next(2) === 0
            ? { mount: next(2) === 0 ? '/nix' : '/boot' }
            : { units: [`u${next(3)}.service`] },
      })
    );
  }

  test('every close matches an earlier open, nothing overlaps and re-deriving is idempotent', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const events = stream(seed);
      const ids = new Map(events.map((item) => [item.id, item]));
      const incidents = deriveIncidents(events, NOW);
      expect(deriveIncidents([...events].reverse(), NOW)).toEqual(incidents);
      expect(deriveIncidents([...events, ...events], NOW)).toEqual(incidents);
      const groups = new Map<string, typeof incidents>();
      for (const incident of incidents) {
        const opener = ids.get(incident.openEventId)!;
        expect(
          INCIDENT_RULES.some(
            (rule) => rule.open === opener.kind && rule.id === incident.rule
          )
        ).toBe(true);
        expect(opener.nodeId).toBe(incident.nodeId);
        expect(incident.open).toBe(incident.closeEventId === null);
        if (incident.closeEventId !== null) {
          const closer = ids.get(incident.closeEventId)!;
          expect(
            INCIDENT_RULES.some(
              (rule) => rule.close === closer.kind && rule.id === incident.rule
            )
          ).toBe(true);
          expect(closer.nodeId).toBe(incident.nodeId);
          expect(closer.at.getTime()).toBeGreaterThanOrEqual(
            opener.at.getTime()
          );
          expect(incident.endedAt).toEqual(closer.at);
        }
        expect(incident.durationSeconds).toBeGreaterThanOrEqual(0);
        const key = `${incident.nodeId}|${incident.rule}|${incident.subject ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), incident]);
      }
      for (const group of groups.values()) {
        const ordered = [...group].sort(
          (a, b) =>
            a.startedAt.getTime() - b.startedAt.getTime() ||
            a.openEventId - b.openEventId
        );
        ordered.forEach((incident, index) => {
          if (index === 0) return;
          const before = ordered[index - 1]!;
          // The previous incident ended before this one started: no overlap.
          expect(before.endedAt).not.toBeNull();
          expect(before.endedAt!.getTime()).toBeLessThanOrEqual(
            incident.startedAt.getTime()
          );
        });
        expect(
          group.filter((incident) => incident.open).length
        ).toBeLessThanOrEqual(1);
      }
      expect(new Set(incidents.map((incident) => incident.id)).size).toBe(
        incidents.length
      );
    }
  });
});

describe('filterIncidents and summarizeIncidents', () => {
  const events = [
    event('offline', 1, { node: 1 }),
    event('recovered', 2, { node: 1 }),
    event('rollback', 3, { node: 2, severity: 'error' }),
    event('offline', 4, { node: 2 }),
  ];
  const all = deriveIncidents(events, NOW);

  test('filters by open state and node', () => {
    expect(
      filterIncidents(all, { open: true, limit: 10 }).incidents
    ).toHaveLength(2);
    expect(
      filterIncidents(all, { open: false, limit: 10 }).incidents
    ).toHaveLength(1);
    expect(
      filterIncidents(all, { nodeId: nodeIdOf(2), limit: 10 }).incidents.every(
        (incident) => incident.nodeId === nodeIdOf(2)
      )
    ).toBe(true);
  });

  test('pages with a cursor that never repeats or skips', () => {
    const first = filterIncidents(all, { limit: 2 });
    expect(first.incidents).toHaveLength(2);
    expect(first.nextBefore).toBe(first.incidents[1]?.openEventId ?? null);
    const second = filterIncidents(all, {
      limit: 2,
      before: first.nextBefore!,
    });
    expect(second.nextBefore).toBeNull();
    expect(
      [...first.incidents, ...second.incidents].map((incident) => incident.id)
    ).toEqual(all.map((incident) => incident.id));
  });

  test('summarizes open incidents by severity', () => {
    expect(summarizeIncidents(all)).toEqual({
      open: 2,
      total: 3,
      openBySeverity: { info: 0, warn: 1, error: 1 },
    });
  });
});
