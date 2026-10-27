/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import type { NodeView } from '../types';
import type { ConsoleState } from './model';
import { useAction } from './action';
export function Pending({
  state,
  reload,
}: {
  state: ConsoleState;
  reload: () => void;
}) {
  const action = useAction(reload);
  const pending = state.fleet.entries.filter(
    (entry) => entry.view.approval === 'pending'
  );
  const rejected = state.fleet.entries.filter(
    (entry) => entry.view.approval === 'rejected'
  );
  return (
    <Stack gap="lg">
      <PageHeading
        title="Pending approvals"
        description="Review each machine before granting access to the fleet."
      />
      <ErrorNotice message={action.error} />
      {action.success && (
        <Alert color="teal" role="status">
          {action.success}
        </Alert>
      )}
      {!pending.length && (
        <Paper withBorder p="xl">
          <Text c="dimmed">No machines are waiting for approval.</Text>
        </Paper>
      )}
      {pending.map(({ view }) => (
        <PendingCard key={view.id} view={view} action={action} />
      ))}
      {!!rejected.length && (
        <RejectedList rejected={rejected} action={action} />
      )}
    </Stack>
  );
}

function PendingCard({
  view,
  action,
}: {
  view: NodeView;
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Paper withBorder p="lg" key={view.id}>
      <Group justify="space-between">
        <Stack gap={4}>
          <Anchor fw={600} href={`/nodes/${view.id}`}>
            {view.label}
          </Anchor>
          <Text size="sm" c="dimmed">
            Requested role: {view.role} · {view.remoteAddr ?? 'Address unknown'}
          </Text>
          <Text size="xs" ff="monospace" c="dimmed">
            {view.id}
          </Text>
        </Stack>
        <Group>
          <Button
            loading={action.busy}
            onClick={() =>
              action.run(`/nodes/${view.id}/approve`, { next: '/pending' })
            }
          >
            Approve
          </Button>
          <Button
            variant="default"
            disabled={action.busy}
            onClick={() =>
              action.run(`/nodes/${view.id}/reject`, { next: '/pending' })
            }
          >
            Reject
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

function RejectedList({
  rejected,
  action,
}: {
  rejected: ConsoleState['fleet']['entries'];
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Rejected machines ({rejected.length})
        </Title>
        {rejected.map(({ view }) => (
          <Group key={view.id} justify="space-between">
            <Anchor href={`/nodes/${view.id}`}>{view.label}</Anchor>
            <Button
              size="xs"
              variant="light"
              loading={action.busy}
              onClick={() =>
                action.run(`/nodes/${view.id}/approve`, {
                  next: '/pending',
                })
              }
            >
              Approve anyway
            </Button>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
