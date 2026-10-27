import type { NodeEventInput, RecoveryFacts } from '../types';

import {
  isRecord,
  readNumber,
  readObject,
  readString,
  readStringList,
  type Problems,
} from './heartbeat-fields';

/** packages/fleet/scripts/recovery.py KEY; the outbox file name is derived from it. */
const EVENT_KEY = /^[A-Za-z0-9:._-]{1,120}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const MAX_DATA_FIELDS = 16;
const MAX_DATA_TEXT = 300;
const GATE_REASON = /^[a-z-]{1,30}$/;

/** key, at and data on one node event; absent on events from older agents. */
export function readEventExtras(
  problems: Problems,
  path: string,
  value: Record<string, unknown>
): Pick<NodeEventInput, 'key' | 'at' | 'data'> {
  const key = readString(problems, `${path}.key`, value['key'], {
    max: 120,
    pattern: EVENT_KEY,
  });
  const at = readString(problems, `${path}.at`, value['at'], {
    max: 20,
    pattern: TIMESTAMP,
  });
  const data = readEventData(problems, `${path}.data`, value['data']);
  return {
    ...(key === null ? {} : { key }),
    ...(at === null ? {} : { at }),
    ...(data === null ? {} : { data }),
  };
}

/** Flat scalars only, bounded: evidence for a person, never a nested document. */
function readEventData(
  problems: Problems,
  path: string,
  value: unknown
): Record<string, string | number | boolean | null> | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    problems.list.push(`${path} must be an object`);
    return null;
  }
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, item] of Object.entries(value).slice(0, MAX_DATA_FIELDS)) {
    const kept = scalar(item);
    if (/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) && kept !== undefined)
      out[name] = kept;
  }
  return out;
}

function scalar(item: unknown): string | number | boolean | null | undefined {
  if (typeof item === 'string') return item.slice(0, MAX_DATA_TEXT);
  if (item === null || typeof item === 'boolean') return item;
  if (typeof item === 'number' && Number.isFinite(item)) return item;
  return undefined;
}

function readBoot(problems: Problems, value: unknown): RecoveryFacts['boot'] {
  const boot = readObject(problems, 'recovery.boot', value);
  const ratio = Array.isArray(boot['uncleanOfLast'])
    ? boot['uncleanOfLast']
    : [];
  const bound = { min: 0, max: 1000, integer: true } as const;
  return {
    previousClean:
      typeof boot['previousClean'] === 'boolean' ? boot['previousClean'] : null,
    previousEndedAt: readString(
      problems,
      'recovery.boot.previousEndedAt',
      boot['previousEndedAt'],
      { max: 20, pattern: TIMESTAMP }
    ),
    uncleanOfLast: [
      readNumber(problems, 'recovery.boot.uncleanOfLast[0]', ratio[0], bound) ??
        0,
      readNumber(problems, 'recovery.boot.uncleanOfLast[1]', ratio[1], bound) ??
        0,
    ],
  };
}

function readQuarantine(
  problems: Problems,
  value: unknown
): RecoveryFacts['quarantine'] {
  if (!isRecord(value)) return null;
  const field = (name: string, max: number, pattern?: RegExp) =>
    readString(problems, `recovery.quarantine.${name}`, value[name], {
      max,
      ...(pattern ? { pattern } : {}),
    });
  return {
    revision: field('revision', 64),
    toplevel: field('toplevel', 300),
    at: field('at', 20, TIMESTAMP),
    reason: field('reason', 500),
  };
}

function readGate(problems: Problems, value: unknown): RecoveryFacts['gate'] {
  const gate = readObject(problems, 'recovery.gate', value);
  return {
    closed: gate['closed'] === true,
    reasons: readStringList(
      problems,
      'recovery.gate.reasons',
      gate['reasons'],
      {
        maxItems: 8,
        max: 30,
        pattern: GATE_REASON,
      }
    ),
  };
}

/** The node's recovery facts; undefined from agents that do not send them. */
export function readRecovery(
  problems: Problems,
  value: unknown
): RecoveryFacts | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = readObject(problems, 'recovery', value);
  return {
    boot: readBoot(problems, raw['boot']),
    quarantine: readQuarantine(problems, raw['quarantine']),
    gate: readGate(problems, raw['gate']),
    outbox:
      readNumber(problems, 'recovery.outbox', raw['outbox'], {
        min: 0,
        max: 100_000,
        integer: true,
      }) ?? 0,
  };
}
