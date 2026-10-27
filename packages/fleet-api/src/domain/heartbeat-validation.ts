import type { HeartbeatBody, NodeEventInput, Role, Severity } from '../types';
import { isRole } from '../types';
import { readEventExtras, readRecovery } from './recovery-validation';
import { readTelemetry } from './telemetry-validation';

import {
  isRecord,
  readBoolean,
  readNumber,
  readObject,
  readString,
  readStringList,
  requireString,
  type Problems,
} from './heartbeat-fields';

/** Limits from PROTOCOL.md. Anything beyond them is a 400. */
export const HEARTBEAT_LIMITS = {
  events: 20,
  eventMessage: 500,
  eventKind: 40,
  capabilities: 32,
  addresses: 16,
  failedUnits: 100,
  text: 200,
} as const;

export type HeartbeatResult =
  | { readonly ok: true; readonly value: HeartbeatBody }
  | { readonly ok: false; readonly errors: readonly string[] };

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const NODE_ID = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9._:+-]{1,64}$/;
const SEVERITIES: readonly Severity[] = ['info', 'warn', 'error'];
const COUNT = { min: 0, max: 1_000_000_000, integer: true } as const;
const PERCENT = { min: 0, max: 100 } as const;

function readEvent(
  problems: Problems,
  path: string,
  value: unknown
): NodeEventInput | null {
  if (!isRecord(value)) {
    problems.list.push(`${path} must be an object`);
    return null;
  }
  const kind = requireString(problems, `${path}.kind`, value['kind'], {
    max: HEARTBEAT_LIMITS.eventKind,
    pattern: /^[A-Za-z0-9_.:-]{1,40}$/,
  });
  const message = requireString(problems, `${path}.message`, value['message'], {
    max: HEARTBEAT_LIMITS.eventMessage,
  });
  const severity = value['severity'];
  if (!SEVERITIES.includes(severity as Severity)) {
    problems.list.push(`${path}.severity must be info, warn or error`);
    return null;
  }
  return {
    kind,
    severity: severity as Severity,
    message,
    ...readEventExtras(problems, path, value),
  };
}

function readEvents(problems: Problems, value: unknown): NodeEventInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.list.push('events must be a list');
    return [];
  }
  if (value.length > HEARTBEAT_LIMITS.events) {
    problems.list.push(
      `events may have at most ${HEARTBEAT_LIMITS.events} entries`
    );
    return [];
  }
  const out: NodeEventInput[] = [];
  value.forEach((item, index) => {
    const event = readEvent(problems, `events[${index}]`, item);
    if (event !== null) out.push(event);
  });
  return out;
}

function readRunners(
  problems: Problems,
  value: unknown
): HeartbeatBody['runners'] {
  if (value === undefined || value === null) return null;
  const raw = readObject(problems, 'runners', value);
  const slots = readNumber(problems, 'runners.slots', raw['slots'], {
    min: 0,
    max: 4096,
    integer: true,
  });
  const busy = readNumber(problems, 'runners.busy', raw['busy'], {
    min: 0,
    max: 4096,
    integer: true,
  });
  if (slots === null || busy === null) {
    problems.list.push('runners needs slots and busy');
    return null;
  }
  if (busy > slots) problems.list.push('runners.busy must not exceed slots');
  return { slots, busy };
}

function readSync(problems: Problems, value: unknown): HeartbeatBody['sync'] {
  const raw = readObject(problems, 'sync', value);
  return {
    rolledBack: readBoolean(problems, 'sync.rolledBack', raw['rolledBack']),
    healthFailure: readString(
      problems,
      'sync.healthFailure',
      raw['healthFailure'],
      {
        max: HEARTBEAT_LIMITS.eventMessage,
      }
    ),
    paused: readBoolean(problems, 'sync.paused', raw['paused']),
  };
}

function readMachine(problems: Problems, raw: Record<string, unknown>) {
  const cpu = readObject(problems, 'cpu', raw['cpu']);
  const memory = readObject(problems, 'memory', raw['memory']);
  const disk = readObject(problems, 'disk', raw['disk']);
  return {
    kernel: readString(problems, 'kernel', raw['kernel'], { max: 64 }),
    arch: readString(problems, 'arch', raw['arch'], { max: 32 }),
    cpu: {
      cores: readNumber(problems, 'cpu.cores', cpu['cores'], {
        min: 0,
        max: 4096,
        integer: true,
      }),
      model: readString(problems, 'cpu.model', cpu['model'], {
        max: HEARTBEAT_LIMITS.text,
      }),
    },
    memory: {
      totalMiB: readNumber(
        problems,
        'memory.totalMiB',
        memory['totalMiB'],
        COUNT
      ),
      availableMiB: readNumber(
        problems,
        'memory.availableMiB',
        memory['availableMiB'],
        COUNT
      ),
    },
    load1: readNumber(problems, 'load1', raw['load1'], {
      min: 0,
      max: 1_000_000,
    }),
    disk: {
      nixUsedPercent: readNumber(
        problems,
        'disk.nixUsedPercent',
        disk['nixUsedPercent'],
        PERCENT
      ),
      bootUsedPercent: readNumber(
        problems,
        'disk.bootUsedPercent',
        disk['bootUsedPercent'],
        PERCENT
      ),
    },
  };
}

function readAgent(problems: Problems, value: unknown): HeartbeatBody['agent'] {
  const raw = readObject(problems, 'agent', value);
  return {
    version: requireString(problems, 'agent.version', raw['version'], {
      max: 32,
      pattern: TOKEN,
    }),
    configRevision: readString(
      problems,
      'agent.configRevision',
      raw['configRevision'],
      {
        max: 64,
        pattern: TOKEN,
      }
    ),
  };
}

function readIdentity(problems: Problems, raw: Record<string, unknown>) {
  const role = raw['role'];
  if (!isRole(role)) problems.list.push('role must be one of the known roles');
  return {
    nodeId: requireString(problems, 'nodeId', raw['nodeId'], {
      max: 64,
      pattern: NODE_ID,
    }),
    role: (isRole(role) ? role : 'ci') as Role,
    hostname: requireString(problems, 'hostname', raw['hostname'], {
      max: 63,
      pattern: HOSTNAME,
    }),
  };
}

function readLists(problems: Problems, raw: Record<string, unknown>) {
  return {
    capabilities: readStringList(
      problems,
      'capabilities',
      raw['capabilities'],
      {
        maxItems: HEARTBEAT_LIMITS.capabilities,
        max: 50,
        pattern: /^[A-Za-z0-9_.:-]{1,50}$/,
      }
    ),
    addresses: readStringList(problems, 'addresses', raw['addresses'], {
      maxItems: HEARTBEAT_LIMITS.addresses,
      max: 64,
    }),
    failedUnits: readStringList(problems, 'failedUnits', raw['failedUnits'], {
      maxItems: HEARTBEAT_LIMITS.failedUnits,
      max: 128,
    }),
  };
}

/**
 * Strict where it matters: types, ranges and sizes. Unknown keys are ignored
 * and never stored, so a newer agent does not break an older server.
 */
export function validateHeartbeat(input: unknown): HeartbeatResult {
  if (!isRecord(input))
    return { ok: false, errors: ['body must be a JSON object'] };
  const problems: Problems = { list: [] };
  if (input['v'] !== 1) problems.list.push('v must be 1');
  const telemetry = readTelemetry(problems, input['telemetry']);
  const recovery = readRecovery(problems, input['recovery']);
  const value: HeartbeatBody = {
    v: 1,
    ...readIdentity(problems, input),
    ...readLists(problems, input),
    revision: readString(problems, 'revision', input['revision'], {
      max: 64,
      pattern: TOKEN,
    }),
    bootId: readString(problems, 'bootId', input['bootId'], {
      max: 64,
      pattern: TOKEN,
    }),
    uptimeSeconds: readNumber(
      problems,
      'uptimeSeconds',
      input['uptimeSeconds'],
      {
        min: 0,
        max: 10_000_000_000,
        integer: true,
      }
    ),
    ...readMachine(problems, input),
    sync: readSync(problems, input['sync']),
    runners: readRunners(problems, input['runners']),
    agent: readAgent(problems, input['agent']),
    events: readEvents(problems, input['events']),
    ...(telemetry ? { telemetry } : {}),
    ...(recovery ? { recovery } : {}),
    ...(input['readiness'] === undefined
      ? {}
      : {
          readiness: {
            issues: readStringList(
              problems,
              'readiness.issues',
              readObject(problems, 'readiness', input['readiness'])['issues'],
              { maxItems: 12, max: 500 }
            ),
          },
        }),
  };
  return problems.list.length > 0
    ? { ok: false, errors: problems.list }
    : { ok: true, value };
}
