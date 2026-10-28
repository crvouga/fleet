import {
  ISSUE_STATUSES,
  isIssueKind,
  type IssueReport,
  type IssueStatus,
} from '../issues/types';

import {
  dateOf,
  dateOrNull,
  jsonObject,
  numberOrNull,
  numberOf,
  text,
  textOrNull,
  type Row,
} from './rows';

function status(row: Row): IssueStatus {
  const value = row['status'];
  const found = ISSUE_STATUSES.find((known) => known === value);
  if (found === undefined)
    throw new TypeError('database column status was not a known value');
  return found;
}

function kind(row: Row): IssueReport['kind'] {
  const value = row['kind'];
  if (!isIssueKind(value))
    throw new TypeError('database column kind was not a known value');
  return value;
}

export function toIssueReport(row: Row): IssueReport {
  return {
    id: text(row, 'id'),
    fingerprint: text(row, 'fingerprint'),
    kind: kind(row),
    nodeId: textOrNull(row, 'node_id'),
    status: status(row),
    title: text(row, 'title'),
    body: text(row, 'body'),
    snapshot: jsonObject(row, 'snapshot'),
    correlationId: textOrNull(row, 'correlation_id'),
    githubIssueNumber: numberOrNull(row, 'github_issue_number'),
    githubIssueUrl: textOrNull(row, 'github_issue_url'),
    attempts: numberOf(row, 'attempts'),
    nextAttemptAt: dateOrNull(row, 'next_attempt_at'),
    lastError: textOrNull(row, 'last_error'),
    createdBy: text(row, 'created_by'),
    createdAt: dateOf(row, 'created_at'),
    updatedAt: dateOf(row, 'updated_at'),
  };
}
