import { isIssueKind, type IssueKind, type IssueTarget } from './types';

export type ParsedTarget =
  | { readonly ok: true; readonly target: IssueTarget }
  | { readonly ok: false; readonly errors: readonly string[] };

const NODE_ID = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

type Input = Readonly<Record<string, unknown>>;

function text(input: Input, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function positive(
  raw: string | undefined,
  name: string,
  errors: string[]
): number | undefined {
  if (raw === undefined) return undefined;
  const number = /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  if (number > 0) return number;
  errors.push(`${name} must be a positive integer`);
  return undefined;
}

function matching(
  raw: string | undefined,
  pattern: RegExp,
  name: string,
  errors: string[]
): string | undefined {
  if (raw === undefined) return undefined;
  if (pattern.test(raw)) return raw;
  errors.push(`${name} is not a valid id`);
  return undefined;
}

/** Without an explicit kind: a job is a workload, a request is the controller, the rest is a node. */
function inferKind(input: Input): IssueKind | null {
  if (text(input, 'job', 'jobId') !== undefined) return 'workload';
  if (text(input, 'request', 'requestId') !== undefined) return 'controller';
  if (
    text(
      input,
      'node',
      'nodeId',
      'event',
      'eventId',
      'operation',
      'operationId'
    ) !== undefined
  )
    return 'node';
  return null;
}

function kindOf(input: Input, errors: string[]): IssueKind | null {
  const raw = text(input, 'kind');
  const kind =
    raw === undefined ? inferKind(input) : isIssueKind(raw) ? raw : null;
  if (kind === null)
    errors.push('kind must be one of installer, node, controller, workload');
  return kind;
}

function ids(input: Input, errors: string[]): Omit<IssueTarget, 'kind'> {
  const nodeId = matching(
    text(input, 'node', 'nodeId'),
    NODE_ID,
    'node',
    errors
  );
  const eventId = positive(text(input, 'event', 'eventId'), 'event', errors);
  const jobId = positive(text(input, 'job', 'jobId'), 'job', errors);
  const operationId = matching(
    text(input, 'operation', 'operationId'),
    OPERATION_ID,
    'operation',
    errors
  );
  const requestId = matching(
    text(input, 'request', 'requestId'),
    REQUEST_ID,
    'request',
    errors
  );
  return {
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(eventId === undefined ? {} : { eventId }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(operationId === undefined ? {} : { operationId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * Reads a target from the query string or a JSON body. Strict: unknown ids are
 * refused rather than guessed, so a report never describes the wrong thing.
 */
export function parseTarget(input: Input): ParsedTarget {
  const errors: string[] = [];
  const kind = kindOf(input, errors);
  const named = ids(input, errors);
  if (kind !== null && kind !== 'controller' && Object.keys(named).length === 0)
    errors.push('name what to report: node, event, job, operation or request');
  if (errors.length > 0 || kind === null) return { ok: false, errors };
  return { ok: true, target: { kind, ...named } };
}
