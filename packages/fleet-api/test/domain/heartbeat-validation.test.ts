import { describe, expect, test } from 'bun:test';

import {
  HEARTBEAT_LIMITS,
  validateHeartbeat,
} from '../../src/domain/heartbeat-validation';
import { heartbeatBody } from '../support/fixtures';

function errors(input: unknown): readonly string[] {
  const result = validateHeartbeat(input);
  if (result.ok) throw new Error('expected a refusal');
  return result.errors;
}

describe('validateHeartbeat', () => {
  test('accepts the example from PROTOCOL.md unchanged', () => {
    const body = heartbeatBody(1, {
      events: [{ kind: 'boot', severity: 'info', message: 'node started' }],
      agent: { version: '1', configRevision: '0123456789abcdef' },
    });
    const result = validateHeartbeat(JSON.parse(JSON.stringify(body)));
    expect(result).toEqual({ ok: true, value: body });
  });

  test('every field a node cannot know may be null', () => {
    const body = heartbeatBody(1, {
      revision: null,
      bootId: null,
      uptimeSeconds: null,
      kernel: null,
      arch: null,
      load1: null,
      runners: null,
      cpu: { cores: null, model: null },
      memory: { totalMiB: null, availableMiB: null },
      disk: { nixUsedPercent: null, bootUsedPercent: null },
    });
    expect(validateHeartbeat(body).ok).toBe(true);
  });

  test('optional collections default to empty and unknown keys are dropped, not stored', () => {
    const result = validateHeartbeat({
      v: 1,
      nodeId: heartbeatBody(1).nodeId,
      role: 'web',
      hostname: 'web-1234',
      agent: { version: '2' },
      secretNewField: 'ignored',
      cpu: { cores: 2, turbo: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      capabilities: [],
      addresses: [],
      failedUnits: [],
      events: [],
      runners: null,
    });
    expect(result.value.sync).toEqual({
      rolledBack: false,
      healthFailure: null,
      paused: false,
    });
    expect(JSON.stringify(result.value)).not.toContain('secretNewField');
    expect(JSON.stringify(result.value)).not.toContain('turbo');
  });

  test('rejects a body that is not an object', () => {
    for (const input of [null, 'text', 42, [], true]) {
      expect(errors(input)).toEqual(['body must be a JSON object']);
    }
  });

  test('requires protocol version 1', () => {
    expect(errors({ ...heartbeatBody(1), v: 2 })).toContain('v must be 1');
    expect(errors({ ...heartbeatBody(1), v: undefined })).toContain(
      'v must be 1'
    );
  });

  test('rejects a bad node id, role and hostname', () => {
    expect(errors({ ...heartbeatBody(1), nodeId: 'ABC' })).toContain(
      'nodeId has an invalid format'
    );
    expect(errors({ ...heartbeatBody(1), nodeId: undefined })).toContain(
      'nodeId is required'
    );
    expect(errors({ ...heartbeatBody(1), role: 'gpu' })).toContain(
      'role must be one of the known roles'
    );
    expect(errors({ ...heartbeatBody(1), hostname: 'bad host!' })).toContain(
      'hostname has an invalid format'
    );
    expect(errors({ ...heartbeatBody(1), hostname: 'a'.repeat(64) })).toContain(
      'hostname must be at most 63 characters'
    );
  });

  test('rejects wrong types and out-of-range numbers', () => {
    expect(errors({ ...heartbeatBody(1), load1: 'high' })).toContain(
      'load1 must be a number'
    );
    expect(errors({ ...heartbeatBody(1), load1: -1 })).toContain(
      'load1 must be between 0 and 1000000'
    );
    expect(errors({ ...heartbeatBody(1), uptimeSeconds: 1.5 })).toContain(
      'uptimeSeconds must be a whole number'
    );
    expect(
      errors({ ...heartbeatBody(1), uptimeSeconds: Number.NaN })
    ).toContain('uptimeSeconds must be a number');
    expect(
      errors({
        ...heartbeatBody(1),
        disk: { nixUsedPercent: 101, bootUsedPercent: -1 },
      })
    ).toEqual([
      'disk.nixUsedPercent must be between 0 and 100',
      'disk.bootUsedPercent must be between 0 and 100',
    ]);
    expect(errors({ ...heartbeatBody(1), cpu: 'fast' })).toContain(
      'cpu must be an object'
    );
    expect(
      errors({ ...heartbeatBody(1), sync: { rolledBack: 'yes' } })
    ).toContain('sync.rolledBack must be true or false');
  });

  test('runners need both numbers', () => {
    expect(errors({ ...heartbeatBody(1), runners: { slots: 4 } })).toContain(
      'runners needs slots and busy'
    );
    expect(
      errors({ ...heartbeatBody(1), runners: { slots: -1, busy: 0 } })
    ).toContain('runners.slots must be between 0 and 4096');
  });

  test('enforces list sizes and entry formats', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    expect(
      errors({
        ...heartbeatBody(1),
        failedUnits: many(HEARTBEAT_LIMITS.failedUnits + 1),
      })
    ).toEqual([
      `failedUnits may have at most ${HEARTBEAT_LIMITS.failedUnits} entries`,
    ]);
    expect(
      errors({
        ...heartbeatBody(1),
        capabilities: many(HEARTBEAT_LIMITS.capabilities + 1),
      })
    ).toHaveLength(1);
    expect(
      errors({
        ...heartbeatBody(1),
        addresses: many(HEARTBEAT_LIMITS.addresses + 1),
      })
    ).toHaveLength(1);
    expect(
      errors({ ...heartbeatBody(1), capabilities: ['has space'] })
    ).toEqual(['capabilities[0] has an invalid format']);
    expect(errors({ ...heartbeatBody(1), failedUnits: [7] })).toEqual([
      'failedUnits[0] must be a string',
    ]);
    expect(errors({ ...heartbeatBody(1), failedUnits: 'a.service' })).toEqual([
      'failedUnits must be a list',
    ]);
  });

  describe('events', () => {
    const event = { kind: 'boot', severity: 'info', message: 'ok' };

    test('allows exactly the maximum and refuses one more', () => {
      expect(
        validateHeartbeat({
          ...heartbeatBody(1),
          events: Array(HEARTBEAT_LIMITS.events).fill(event),
        }).ok
      ).toBe(true);
      expect(
        errors({
          ...heartbeatBody(1),
          events: Array(HEARTBEAT_LIMITS.events + 1).fill(event),
        })
      ).toEqual([`events may have at most ${HEARTBEAT_LIMITS.events} entries`]);
    });

    test('allows a 500 character message and refuses 501', () => {
      expect(
        validateHeartbeat({
          ...heartbeatBody(1),
          events: [{ ...event, message: 'x'.repeat(500) }],
        }).ok
      ).toBe(true);
      expect(
        errors({
          ...heartbeatBody(1),
          events: [{ ...event, message: 'x'.repeat(501) }],
        })
      ).toEqual(['events[0].message must be at most 500 characters']);
    });

    test('refuses bad severities, kinds and shapes', () => {
      expect(
        errors({
          ...heartbeatBody(1),
          events: [{ ...event, severity: 'fatal' }],
        })
      ).toEqual(['events[0].severity must be info, warn or error']);
      expect(
        errors({
          ...heartbeatBody(1),
          events: [{ ...event, kind: 'has space' }],
        })
      ).toEqual(['events[0].kind has an invalid format']);
      expect(
        errors({ ...heartbeatBody(1), events: [{ kind: 'boot' }] })
      ).toContain('events[0].message is required');
      expect(errors({ ...heartbeatBody(1), events: ['boot'] })).toEqual([
        'events[0] must be an object',
      ]);
      expect(errors({ ...heartbeatBody(1), events: 'boot' })).toEqual([
        'events must be a list',
      ]);
    });

    test('reports every problem, not just the first', () => {
      const found = errors({
        ...heartbeatBody(1),
        load1: 'x',
        kernel: 5,
        events: [{}],
      });
      expect(found.length).toBeGreaterThanOrEqual(4);
    });
  });

  test('agent version is required and configRevision is a short token', () => {
    expect(errors({ ...heartbeatBody(1), agent: {} })).toContain(
      'agent.version is required'
    );
    expect(
      errors({
        ...heartbeatBody(1),
        agent: { version: '1', configRevision: 'bad revision' },
      })
    ).toContain('agent.configRevision has an invalid format');
  });

  test('strings with control characters or markup are only ever data', () => {
    const result = validateHeartbeat({
      ...heartbeatBody(1),
      cpu: { cores: 1, model: '<script>alert(1)</script>' },
      sync: { rolledBack: false, healthFailure: 'line1\nline2', paused: false },
    });
    expect(result.ok).toBe(true);
  });
});
