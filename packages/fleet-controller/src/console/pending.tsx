/** @jsxImportSource react */
import { useState } from 'react';
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
import { ApproveWithRole } from './role-select';
import { ConfirmDialog } from './typed-confirm';
import { InstallerProgressPanel } from './installer-progress';
import { ReportIssueAnchor } from './report-issue-link';
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
      <InstallerProgressPanel state={state} />
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
  const [rejecting, setRejecting] = useState(false);
  return (
    <Paper withBorder p="lg" key={view.id}>
      <Group justify="space-between">
        <Stack gap={4}>
          <Anchor fw={600} href={`/nodes/${view.id}`}>
            {view.label}
          </Anchor>
          <Text size="sm" c="dimmed">
            Runs: {view.observedRole ?? 'not reported'} · Hardware:{' '}
            {view.hardwareCapabilities.join(', ') || 'nothing detected'} ·{' '}
            {view.remoteAddr ?? 'Address unknown'}
          </Text>
          <Text size="xs" ff="monospace" c="dimmed">
            {view.id}
          </Text>
          <ReportIssueAnchor
            target={{ kind: 'installer', nodeId: view.id }}
            label="Report installer problem"
          />
        </Stack>
        <Group>
          <ApproveWithRole
            id={view.id}
            label="Approve"
            action={action}
            next="/pending"
          />
          <Button
            variant="default"
            disabled={action.busy}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
        </Group>
      </Group>
      <ConfirmDialog
        opened={rejecting}
        title="Reject this machine?"
        expected={view.label}
        confirmLabel="Reject machine"
        busy={action.busy}
        error={action.error}
        onClose={() => setRejecting(false)}
        onConfirm={async (typed) => {
          if (
            await action.run(`/nodes/${view.id}/reject`, {
              confirm: typed,
              next: '/pending',
            })
          )
            setRejecting(false);
        }}
      >
        <Text size="sm">
          {view.label} is refused until a person approves it again.
        </Text>
      </ConfirmDialog>
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
            <ApproveWithRole
              id={view.id}
              label="Approve anyway"
              action={action}
              next="/pending"
              size="xs"
            />
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
