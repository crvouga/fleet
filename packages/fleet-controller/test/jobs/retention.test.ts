import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_HEARTBEAT_RETENTION_DAYS,
  readHeartbeatRetentionDays,
  retentionMs,
} from '../../src/jobs/retention';

const DAY = 24 * 3600 * 1000;
function read(value: string | undefined) {
  const problems: string[] = [];
  const result = readHeartbeatRetentionDays(
    value === undefined ? {} : { FLEET_HEARTBEAT_RETENTION_DAYS: value },
    problems
  );
  return { result, problems };
}

describe('FLEET_HEARTBEAT_RETENTION_DAYS', () => {
  test('is optional, with a 30 day default applied by retentionMs', () => {
    expect(read(undefined)).toEqual({ result: {}, problems: [] });
    expect(read('  ')).toEqual({ result: {}, problems: [] });
    expect(retentionMs(undefined)).toBe(30 * DAY);
    expect(DEFAULT_HEARTBEAT_RETENTION_DAYS).toBe(30);
  });
  test('accepts whole days from 1 to 365 only', () => {
    expect(read('1').result).toEqual({ heartbeatRetentionDays: 1 });
    expect(read(' 365 ').result).toEqual({ heartbeatRetentionDays: 365 });
    for (const bad of ['0', '366', '-3', '1.5', '7d', 'abc', '1e2', '00000']) {
      const { problems } = read(bad);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('FLEET_HEARTBEAT_RETENTION_DAYS');
      expect(problems[0]).not.toContain(bad === '0' ? 'zzz' : `"${bad}"`);
    }
  });
  test('retentionMs never trusts an out-of-range value', () => {
    expect(retentionMs(7)).toBe(7 * DAY);
    for (const bad of [0, 366, 1.5, Number.NaN, -1])
      expect(retentionMs(bad)).toBe(30 * DAY);
  });
});
