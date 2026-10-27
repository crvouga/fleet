import type { Telemetry } from '../telemetry';
import { readString, requireString, type Problems } from './heartbeat-fields';
import {
  entries,
  label,
  nullableLabel,
  TELEMETRY_LIMITS,
  timestamp,
  unique,
} from './telemetry-fields';

export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const RUN_ID = /^[1-9][0-9]{0,19}$/;

export function runnerSlots(
  p: Problems,
  raw: unknown
): Telemetry['runnerSlots'] {
  const result = entries(
    p,
    'telemetry.runnerSlots',
    { value: raw, limit: TELEMETRY_LIMITS.runnerSlots },
    (item, path) => {
      const state = slotState(p, path, item['state']);
      const repository = readString(
        p,
        `${path}.repository`,
        item['repository'],
        { max: 120, pattern: REPOSITORY }
      );
      if (repository?.split('/').some((part) => part === '.' || part === '..'))
        p.list.push(`${path}.repository must name a GitHub repository`);
      const startedAt = timestamp(
        p,
        `${path}.startedAt`,
        item['startedAt'],
        true
      );
      const finishedAt = timestamp(
        p,
        `${path}.finishedAt`,
        item['finishedAt'],
        true
      );
      if (startedAt && finishedAt && new Date(finishedAt) < new Date(startedAt))
        p.list.push(`${path}.finishedAt must not precede startedAt`);
      return {
        slot: requireString(p, `${path}.slot`, item['slot'], {
          max: 7,
          pattern: /^slot-(?:[1-9]|[1-5][0-9]|6[0-4])$/,
        }),
        state,
        repository,
        runId: readString(p, `${path}.runId`, item['runId'], {
          max: 20,
          pattern: RUN_ID,
        }),
        jobName: nullableLabel(p, `${path}.jobName`, item['jobName']),
        startedAt,
        finishedAt,
        result: nullableLabel(p, `${path}.result`, item['result']),
      };
    }
  );
  unique(
    p,
    'telemetry.runnerSlots',
    result.map((item) => item.slot)
  );
  return result;
}

export function diagnostics(p: Problems, raw: unknown): Telemetry['logs'] {
  return entries(
    p,
    'telemetry.logs',
    { value: raw, limit: TELEMETRY_LIMITS.logs },
    (item, path) => {
      const level = item['level'];
      if (level !== 'info' && level !== 'warn' && level !== 'error')
        p.list.push(`${path}.level must be info, warn or error`);
      const source = label(p, `${path}.source`, item['source']);
      const message = requireString(p, `${path}.message`, item['message'], {
        max: 500,
      });
      if (!safeDiagnostic(source, message))
        p.list.push(
          `${path} must contain an allowlisted service or runner lifecycle summary`
        );
      return {
        at: timestamp(p, `${path}.at`, item['at']) ?? '',
        source,
        level:
          level === 'warn'
            ? ('warn' as const)
            : level === 'error'
              ? ('error' as const)
              : ('info' as const),
        message,
      };
    }
  );
}

function safeDiagnostic(source: string, message: string): boolean {
  const slot = source.match(/^runner:(slot-(?:[1-9]|[1-5][0-9]|6[0-4]))$/)?.[1];
  if (slot)
    return [
      `Runner ${slot} started a job.`,
      `Runner ${slot} completed its job hook; consult GitHub for the result.`,
      `Runner ${slot} stopped before its completion hook.`,
    ].includes(message);
  return safeUnitDiagnostic(source, message);
}
function safeUnitDiagnostic(source: string, message: string): boolean {
  if (
    source !== 'systemd' ||
    !message.startsWith('Service ') ||
    !message.endsWith(' is failed.')
  )
    return false;
  const unit = message.slice('Service '.length, -' is failed.'.length);
  const characters = [...unit].every(
    (character) =>
      /^[A-Za-z0-9:_.@-]$/.test(character) || character.charCodeAt(0) === 92
  );
  const suffixes = [
    'service',
    'socket',
    'timer',
    'mount',
    'target',
    'path',
    'device',
    'swap',
    'scope',
    'slice',
  ];
  return (
    unit.length <= 128 &&
    characters &&
    suffixes.includes(unit.split('.').at(-1) ?? '')
  );
}

function slotState(
  p: Problems,
  path: string,
  value: unknown
): 'idle' | 'busy' | 'offline' {
  if (value === 'idle' || value === 'busy' || value === 'offline') return value;
  p.list.push(`${path}.state must be idle, busy or offline`);
  return 'offline';
}
