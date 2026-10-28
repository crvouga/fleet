import type { Operation, OperationStatus } from '../../domain/operations';
import type { AuditRow } from '../../types';
import { ReportIssueLink } from '../components/report-issue';
import { ExactTime, Time } from '../components/time';
import { cx } from '../lib/tw';

export const STATUS_LABEL: Readonly<Record<OperationStatus, string>> = {
  pending: 'Waiting',
  in_progress: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_CLASS: Readonly<Record<OperationStatus, string>> = {
  pending: 'text-fg-2',
  in_progress: 'text-accent-ink',
  succeeded: 'text-ok',
  failed: 'text-bad',
  cancelled: 'text-fg-3',
};

export function OperationStatusLabel(props: { status: OperationStatus }) {
  return (
    <span class={cx('font-medium', STATUS_CLASS[props.status])}>
      {STATUS_LABEL[props.status]}
    </span>
  );
}

function CancelForm(props: { id: string }) {
  return (
    <form method="post" action={`/operations/${props.id}/cancel`}>
      <button type="submit" class="btn btn-sm">
        Cancel
      </button>
    </form>
  );
}

function OperationRowView(props: {
  op: Operation;
  label: string | null;
  now: Date;
}) {
  const { op } = props;
  const active = op.status === 'pending' || op.status === 'in_progress';
  return (
    <tr>
      <td data-primary>
        <span class="font-medium">{op.kind}</span>{' '}
        {op.nodeId === null ? null : (
          <a href={`/nodes/${op.nodeId}`}>{props.label ?? 'node'}</a>
        )}
      </td>
      <td data-label="Status">
        <OperationStatusLabel status={op.status} />
      </td>
      <td data-label="Progress" class="text-fg-2">
        {op.status === 'failed' ? (op.failure ?? op.progress) : op.progress}
      </td>
      <td data-label="Requested" class="text-fg-2">
        {op.requestedBy} <Time at={op.requestedAt} now={props.now} />
      </td>
      <td data-label="Actions">
        {active ? <CancelForm id={op.id} /> : null}
        {op.status === 'failed' ? (
          <ReportIssueLink
            target={{
              kind: 'node',
              operationId: op.id,
              ...(op.nodeId === null ? {} : { nodeId: op.nodeId }),
            }}
          />
        ) : null}
      </td>
    </tr>
  );
}

export function OperationsTable(props: {
  operations: readonly Operation[];
  labels: ReadonlyMap<string, string>;
  now: Date;
}) {
  if (props.operations.length === 0)
    return (
      <p class="px-5 py-10 text-center text-fg-2">
        No operations yet. Drain, restart, replace or decommission a node from
        its page.
      </p>
    );
  return (
    <table class="rtable">
      <caption class="sr-only">Operations, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Operation</th>
          <th scope="col">Status</th>
          <th scope="col">Progress</th>
          <th scope="col">Requested</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {props.operations.map((op) => (
          <OperationRowView
            key={op.id}
            op={op}
            label={
              op.nodeId === null ? null : (props.labels.get(op.nodeId) ?? null)
            }
            now={props.now}
          />
        ))}
      </tbody>
    </table>
  );
}

export function OperationsBody(props: {
  operations: readonly Operation[];
  labels: ReadonlyMap<string, string>;
  now: Date;
  nextCursor: string | null;
}) {
  return (
    <div>
      <section class="card" aria-label="Operations">
        <OperationsTable
          operations={props.operations}
          labels={props.labels}
          now={props.now}
        />
      </section>
      {props.nextCursor === null ? null : (
        <nav aria-label="Pages" class="mt-4 flex justify-end text-sm">
          <a
            class="btn btn-sm"
            href={`/operations?cursor=${encodeURIComponent(props.nextCursor)}`}
            rel="next"
          >
            Older operations
          </a>
        </nav>
      )}
    </div>
  );
}

function AuditRowView(props: { entry: AuditRow }) {
  const { entry } = props;
  const tone = entry.outcome === 'success' ? 'text-ok' : 'text-bad';
  return (
    <tr>
      <td data-primary>
        <span class="font-medium">{entry.action}</span>
      </td>
      <td data-label="Outcome">
        <span class={cx('font-medium', tone)}>{entry.outcome}</span>
      </td>
      <td data-label="Actor" class="text-fg-2">
        {entry.actor}
        {entry.actorRole === null ? '' : ` (${entry.actorRole})`}
      </td>
      <td data-label="Target" class="break-all text-fg-2">
        {entry.targetKind}
        {entry.targetId === null ? '' : ` ${entry.targetId.slice(0, 12)}`}
      </td>
      <td data-label="When" class="text-fg-2">
        <ExactTime at={entry.at} />
      </td>
    </tr>
  );
}

export function AuditBody(props: {
  entries: readonly AuditRow[];
  nextBefore: number | null;
}) {
  return (
    <div>
      <section class="card" aria-label="Audit log">
        {props.entries.length === 0 ? (
          <p class="px-5 py-10 text-center text-fg-2">
            Nothing has been audited yet.
          </p>
        ) : (
          <table class="rtable">
            <caption class="sr-only">Audit log, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Outcome</th>
                <th scope="col">Actor</th>
                <th scope="col">Target</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {props.entries.map((entry) => (
                <AuditRowView key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
      </section>
      {props.nextBefore === null ? null : (
        <nav aria-label="Pages" class="mt-4 flex justify-end text-sm">
          <a
            class="btn btn-sm"
            href={`/audit?before=${props.nextBefore}`}
            rel="next"
          >
            Older entries
          </a>
        </nav>
      )}
    </div>
  );
}
