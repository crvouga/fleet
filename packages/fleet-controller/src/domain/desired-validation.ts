import type { HeartbeatBody, ReconcilePhase } from '../types';
import { isCapability } from '../types';

import {
  isRecord,
  readObject,
  readString,
  readStringList,
  type Problems,
} from './heartbeat-fields';

/** Protocol v2 fields that describe observed state. Limits from PROTOCOL.md. */
export const OBSERVED_LIMITS = {
  capabilities: 16,
  reconcileIssues: 8,
  reconcileIssue: 500,
} as const;

export const CLOSURE_PATTERN = /^(base|[a-z][a-z0-9]{0,15}(-[a-z0-9]{1,16}){0,4})$/;
export const AGE_RECIPIENT_PATTERN = /^age1[02-9ac-hj-np-z]{58}$/;
const REVISION = /^[0-9a-f]{16}$/;
const PHASES: readonly ReconcilePhase[] = [
  'converged',
  'progressing',
  'blocked',
];

/** Unknown capabilities are dropped, not errors: a newer agent may know more. */
export function readHardware(
  problems: Problems,
  value: unknown
): Pick<HeartbeatBody, 'hardware'> {
  if (value === undefined || value === null) return {};
  const raw = readObject(problems, 'hardware', value);
  const list = readStringList(
    problems,
    'hardware.capabilities',
    raw['capabilities'],
    { maxItems: OBSERVED_LIMITS.capabilities, max: 32 }
  );
  return {
    hardware: { capabilities: [...new Set(list.filter(isCapability))] },
  };
}

export function readReconcile(
  problems: Problems,
  value: unknown
): Pick<HeartbeatBody, 'reconcile'> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    problems.list.push('reconcile must be an object');
    return {};
  }
  const phase = value['phase'];
  if (!PHASES.includes(phase as ReconcilePhase)) {
    problems.list.push('reconcile.phase must be converged, progressing or blocked');
    return {};
  }
  const issues = readStringList(problems, 'reconcile.issues', value['issues'], {
    maxItems: OBSERVED_LIMITS.reconcileIssues,
    max: OBSERVED_LIMITS.reconcileIssue,
  });
  return { reconcile: { phase: phase as ReconcilePhase, issues } };
}

export function readAgeRecipient(
  problems: Problems,
  value: unknown
): Pick<HeartbeatBody, 'ageRecipient'> {
  const recipient = readString(problems, 'ageRecipient', value, {
    max: 62,
    pattern: AGE_RECIPIENT_PATTERN,
  });
  return recipient === null ? {} : { ageRecipient: recipient };
}

export function readClosure(problems: Problems, value: unknown): string {
  if (typeof value === 'string' && CLOSURE_PATTERN.test(value)) return value;
  problems.list.push('closure must be base or a flake attribute such as ci-gpu');
  return 'base';
}

/** `agent.desiredRevision`: the 16-hex revision the node applied, or null. */
export function readDesiredRevision(
  problems: Problems,
  value: unknown
): string | null {
  return readString(problems, 'agent.desiredRevision', value, {
    max: 16,
    pattern: REVISION,
  });
}
