/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import type { Operation, OperationStatus } from '../domain/operations';
import { relativeTime } from '../ui/lib/format';
import { useAction } from './action';
import type { ConsoleState } from './model';
import { ReportIssueAnchor } from './report-issue-link';
import { useJson } from './use-json';

interface OperationsReply {
  operations: Operation[];
  nextCursor: string | null;
}

export const STATUS_BADGE: Readonly<Record<OperationStatus, [string, string]>> =
  {
    pending: ['Waiting', 'gray'],
    in_progress: ['In progress', 'indigo'],
    succeeded: ['Succeeded', 'teal'],
    failed: ['Failed', 'red'],
    cancelled: ['Cancelled', 'gray'],
  };

export function OperationBadge({ status }: { status: OperationStatus }) {
  const [label, color] = STATUS_BADGE[status];
  return (
    <Badge color={color} variant="light">
      {label}
    </Badge>
  );
}

/** What the controller can prove so far, or why it failed and what to do. */
export function OperationDetail({ op }: { op: Operation }) {
  return (
    <Stack gap={2}>
      <Text size="sm">
        {op.status === 'failed' ? (op.failure ?? op.progress) : op.progress}
      </Text>
      {op.status === 'failed' && op.progress && (
        <Text size="xs" c="dimmed">
          {op.progress}
        </Text>
      )}
    </Stack>
  );
}

function OperationRow({
  op,
  label,
  now,
  action,
  canWrite,
}: {
  op: Operation;
  label: string;
  now: Date;
  action: ReturnType<typeof useAction>;
  canWrite: boolean;
}) {
  const active = op.status === 'pending' || op.status === 'in_progress';
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {op.kind}
          </Text>
          {op.nodeId && (
            <Anchor size="xs" href={`/nodes/${op.nodeId}`}>
              {label}
            </Anchor>
          )}
        </Stack>
      </Table.Td>
      <Table.Td>
        <OperationBadge status={op.status} />
      </Table.Td>
      <Table.Td>
        <OperationDetail op={op} />
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed" title={op.requestedAt.toISOString()}>
          {op.requestedBy} · {relativeTime(op.requestedAt, now)}
        </Text>
      </Table.Td>
      <Table.Td>
        {active && (
          <Button
            size="xs"
            variant="default"
            loading={action.busy}
            disabled={!canWrite}
            onClick={() => action.run(`/operations/${op.id}/cancel`, {})}
          >
            Cancel
          </Button>
        )}
        {op.status === 'failed' && (
          <ReportIssueAnchor
            target={{
              kind: 'node',
              operationId: op.id,
              ...(op.nodeId ? { nodeId: op.nodeId } : {}),
            }}
          />
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function OperationsTable({
  rows,
  state,
  action,
}: {
  rows: readonly Operation[];
  state: ConsoleState;
  action: ReturnType<typeof useAction>;
}) {
  const labels = new Map(
    state.fleet.entries.map((entry) => [entry.view.id, entry.view.label])
  );
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Operation</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Progress</Table.Th>
            <Table.Th>Requested</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((op) => (
            <OperationRow
              key={op.id}
              op={op}
              label={labels.get(op.nodeId ?? '') ?? 'Node'}
              now={state.fleet.now}
              action={action}
              canWrite={state.role !== 'viewer'}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function Operations({
  state,
  reload,
}: {
  state: ConsoleState;
  reload: () => void;
}) {
  const location = new URLSearchParams(window.location.search);
  const cursor = location.get('cursor');
  const url = `/v1/operations?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  const list = useJson<OperationsReply>(url);
  const action = useAction(() => {
    list.reload();
    reload();
  });
  const rows = list.data?.operations ?? [];
  return (
    <Stack>
      <PageHeading
        title="Operations"
        description="Drain, restart, replace and decommission, with the progress the controller can prove from what nodes report."
      />
      <ErrorNotice message={list.error || action.error} retry={list.reload} />
      {action.success && (
        <Alert color="teal" role="status">
          {action.success}
        </Alert>
      )}
      <Paper withBorder p="lg">
        {list.data && rows.length === 0 ? (
          <Text c="dimmed">
            No operations yet. Start one from a node’s page.
          </Text>
        ) : (
          <OperationsTable rows={rows} state={state} action={action} />
        )}
        <Group justify="space-between" mt="md">
          <Button variant="subtle" component="a" href="/operations">
            Back to newest
          </Button>
          {list.data?.nextCursor && (
            <Button
              variant="default"
              component="a"
              href={`/operations?cursor=${encodeURIComponent(list.data.nextCursor)}`}
            >
              Older operations
            </Button>
          )}
        </Group>
      </Paper>
    </Stack>
  );
}
