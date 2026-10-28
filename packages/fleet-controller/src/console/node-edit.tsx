/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { useAction } from './action';
import { ApproveWithRole } from './role-select';
import { useUnsavedChanges, UnsavedDialog } from './unsaved';
import { ConfirmDialog } from './typed-confirm';
export function NodeEdit({
  entry,
  reload,
}: {
  entry: FleetEntry;
  reload: () => void;
}) {
  const [name, setName] = useState(entry.view.displayName ?? '');
  const [note, setNote] = useState(entry.view.note ?? '');
  const [labels, setLabels] = useState(entry.view.labels.join('\n'));
  const action = useAction(reload);
  const [dirty, setDirty] = useState(false);
  const navigation = useUnsavedChanges(dirty || action.busy);
  return (
    <Paper withBorder p="lg">
      <UnsavedDialog navigation={navigation} busy={action.busy} />
      <form
        onChange={() => setDirty(true)}
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await action.run(`/nodes/${entry.view.id}/edit`, {
              displayName: name,
              note,
              labels,
            })
          )
            setDirty(false);
        }}
      >
        <Stack>
          <Title order={2} size="h4">
            Name, note and labels
          </Title>
          <TextInput
            label="Display name"
            placeholder={entry.view.hostname}
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            disabled={action.busy}
          />
          <Textarea
            label="Note"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            disabled={action.busy}
          />
          <Textarea
            label="Labels"
            description="One per line, up to 16. Letters, digits, dot, dash, colon and underscore."
            value={labels}
            onChange={(event) => setLabels(event.currentTarget.value)}
            disabled={action.busy}
          />
          <ErrorNotice message={action.error} />
          <SaveNotice message={action.success} />
          <Group justify="flex-end">
            <Button type="submit" loading={action.busy}>
              Save changes
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}
export function NodeManage({
  entry,
  reload,
}: {
  entry: FleetEntry;
  reload: () => void;
}) {
  const action = useAction(reload);
  const [confirm, setConfirm] = useState<Destructive>();
  const { view } = entry;
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Manage node
        </Title>
        <ErrorNotice message={action.error} />
        {action.success && <Alert color="teal">{action.success}</Alert>}
        <Group>
          {['pending', 'rejected'].includes(view.approval) && (
            <ApproveWithRole id={view.id} label="Approve" action={action} />
          )}
          {view.approval === 'pending' && (
            <Button
              variant="default"
              disabled={action.busy}
              onClick={() => setConfirm('reject')}
            >
              Reject
            </Button>
          )}
          {view.approval === 'approved' && (
            <Button
              variant="light"
              color="orange"
              disabled={action.busy}
              onClick={() => setConfirm('retire')}
            >
              Retire node
            </Button>
          )}
          <Button
            variant="light"
            color="red"
            disabled={action.busy}
            onClick={() => setConfirm('delete')}
          >
            Delete node
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          Retiring revokes access and stops offline notices. Deleting
          permanently removes the node and its heartbeat history.
        </Text>
        <ManageDialog
          confirm={confirm}
          close={() => setConfirm(undefined)}
          view={view}
          action={action}
        />
      </Stack>
    </Paper>
  );
}

type Destructive = 'retire' | 'delete' | 'reject';

const DESTRUCTIVE: Readonly<
  Record<
    Destructive,
    { title: string; button: string; text: (label: string) => string }
  >
> = {
  retire: {
    title: 'Retire this node?',
    button: 'Retire node',
    text: (label) =>
      `Revoke access for ${label} and stop offline notices? To drain it first, use Decommission.`,
  },
  delete: {
    title: 'Delete this node and history?',
    button: 'Delete node and history',
    text: (label) =>
      `Permanently delete ${label} and its heartbeat history? This cannot be undone.`,
  },
  reject: {
    title: 'Reject this machine?',
    button: 'Reject machine',
    text: (label) =>
      `Refuse ${label}. It is told to back off until a person approves it again.`,
  },
};

function ManageDialog({
  confirm,
  close,
  view,
  action,
}: {
  confirm: Destructive | undefined;
  close: () => void;
  view: FleetEntry['view'];
  action: ReturnType<typeof useAction>;
}) {
  const meta = DESTRUCTIVE[confirm ?? 'retire'];
  return (
    <ConfirmDialog
      opened={!!confirm}
      title={meta.title}
      expected={view.label}
      confirmLabel={meta.button}
      busy={action.busy}
      error={action.error}
      onClose={close}
      onConfirm={async (typed) => {
        if (
          confirm &&
          (await action.run(`/nodes/${view.id}/${confirm}`, { confirm: typed }))
        )
          close();
      }}
    >
      <Text size="sm">{meta.text(view.label)}</Text>
    </ConfirmDialog>
  );
}

function SaveNotice({ message }: { message: string }) {
  return message ? (
    <Alert color="teal" role="status">
      {message}
    </Alert>
  ) : null;
}
