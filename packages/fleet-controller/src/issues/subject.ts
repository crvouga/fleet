import type { EventRow } from '../types';

import type { TargetContext } from './gather-context';
import type { NodeEvidence } from './gather-node';

/** The one sentence a report is about, and the event kind that names it. */
export interface Subject {
  readonly message: string;
  readonly eventKind: string | null;
}

export const NO_MESSAGE = 'No error message was recorded for this target.';

type Finder = (
  context: TargetContext,
  evidence: NodeEvidence | null,
  events: readonly EventRow[]
) => Subject | null;

const fromEvent: Finder = ({ event }) =>
  event === null ? null : { message: event.message, eventKind: event.kind };

const fromOperation: Finder = ({ operation }) =>
  operation === null
    ? null
    : {
        message:
          operation.failure ??
          operation.progress ??
          `${operation.kind} ${operation.status}`,
        eventKind: `operation_${operation.status}`,
      };

const fromJob: Finder = ({ job }) =>
  job === null
    ? null
    : {
        message: `job "${job.name}" concluded ${job.conclusion ?? job.status} in ${job.repository}`,
        eventKind: 'ci_job',
      };

const fromRequest: Finder = ({ requestError }) =>
  requestError === null
    ? null
    : {
        message: `Unhandled ${requestError.name}: ${requestError.message}`,
        eventKind: 'controller_error',
      };

const fromReconcile: Finder = (_context, evidence) => {
  const issue = evidence?.view.reconcileIssues[0];
  return issue === undefined
    ? null
    : { message: issue, eventKind: 'reconcile_blocked' };
};

const fromProblemEvent: Finder = (_context, _evidence, events) => {
  const problem = events.find((event) => event.severity !== 'info');
  return problem === undefined
    ? null
    : { message: problem.message, eventKind: problem.kind };
};

const FINDERS: readonly Finder[] = [
  fromEvent,
  fromOperation,
  fromJob,
  fromRequest,
  fromReconcile,
  fromProblemEvent,
];

export function subjectOf(
  context: TargetContext,
  evidence: NodeEvidence | null,
  events: readonly EventRow[]
): Subject {
  for (const find of FINDERS) {
    const subject = find(context, evidence, events);
    if (subject !== null) return subject;
  }
  return { message: NO_MESSAGE, eventKind: null };
}
