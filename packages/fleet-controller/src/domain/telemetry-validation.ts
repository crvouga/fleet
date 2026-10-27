import type { Telemetry } from '../telemetry';
import {
  isRecord,
  readNumber,
  readStringList,
  type Problems,
} from './heartbeat-fields';
import { diagnostics, runnerSlots } from './telemetry-activity';
import { count, TELEMETRY_LIMITS, timestamp } from './telemetry-fields';
import { hardware, network } from './telemetry-hardware';

function swap(p: Problems, value: unknown): Telemetry['swap'] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    p.list.push('telemetry.swap must be an object or null');
    return null;
  }
  const totalBytes = count(p, 'telemetry.swap.totalBytes', value['totalBytes']);
  const usedBytes = count(p, 'telemetry.swap.usedBytes', value['usedBytes']);
  if (usedBytes > totalBytes)
    p.list.push('telemetry.swap.usedBytes must not exceed totalBytes');
  return { totalBytes, usedBytes };
}

export function readTelemetry(
  p: Problems,
  value: unknown
): Telemetry | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    p.list.push('telemetry must be an object');
    return undefined;
  }
  return {
    sampledAt: timestamp(p, 'telemetry.sampledAt', value['sampledAt']) ?? '',
    cpuUsagePercent: readNumber(
      p,
      'telemetry.cpuUsagePercent',
      value['cpuUsagePercent'],
      { min: 0, max: 100 }
    ),
    ...hardware(p, value),
    swap: swap(p, value['swap']),
    network: network(p, value['network']),
    runnerSlots: runnerSlots(p, value['runnerSlots']),
    logs: diagnostics(p, value['logs']),
    issues: readStringList(p, 'telemetry.issues', value['issues'], {
      maxItems: TELEMETRY_LIMITS.issues,
      max: 500,
    }),
  };
}

/** Stored legacy/malformed reports remain unknown rather than fabricated zeroes. */
export function telemetryOf(value: unknown): Telemetry | null {
  const problems: Problems = { list: [] };
  const sample = readTelemetry(problems, value);
  return problems.list.length ? null : (sample ?? null);
}

export function sampleIsFresh(
  sample: Telemetry,
  now: Date,
  intervalSeconds: number
): boolean {
  const age = now.getTime() - new Date(sample.sampledAt).getTime();
  return age >= -60_000 && age <= Math.max(90, intervalSeconds * 2.5) * 1000;
}
