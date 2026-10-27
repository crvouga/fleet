/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
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
import { useUnsavedChanges, UnsavedDialog } from './unsaved';
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
  const [confirm, setConfirm] = useState<'retire' | 'delete'>();
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
            <Button
              loading={action.busy}
              onClick={() => action.run(`/nodes/${view.id}/approve`, {})}
            >
              Approve
            </Button>
          )}
          {view.approval === 'pending' && (
            <Button
              variant="default"
              disabled={action.busy}
              onClick={() => action.run(`/nodes/${view.id}/reject`, {})}
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

function ManageDialog({
  confirm,
  close,
  view,
  action,
}: {
  confirm: 'retire' | 'delete' | undefined;
  close: () => void;
  view: FleetEntry['view'];
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Modal
      opened={!!confirm}
      onClose={() => {
        if (!action.busy) close();
      }}
      title={
        confirm === 'delete'
          ? 'Delete this node and history?'
          : 'Retire this node?'
      }
      closeButtonProps={{ 'aria-label': 'Cancel action' }}
      closeOnClickOutside={!action.busy}
      closeOnEscape={!action.busy}
      centered
    >
      <Stack>
        <Text size="sm">
          {confirm === 'delete'
            ? `Permanently delete ${view.label} and its heartbeat history? This cannot be undone.`
            : `Revoke access for ${view.label} and stop offline notices?`}
        </Text>
        <ErrorNotice message={action.error} />
        <Group justify="flex-end">
          <Button
            variant="default"
            disabled={action.busy}
            onClick={() => close()}
          >
            Cancel
          </Button>
          <Button
            color="red"
            loading={action.busy}
            onClick={async () => {
              if (
                confirm &&
                (await action.run(`/nodes/${view.id}/${confirm}`, {
                  confirm: 'yes',
                }))
              )
                close();
            }}
          >
            {confirm === 'delete' ? 'Delete node and history' : 'Retire node'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function SaveNotice({ message }: { message: string }) {
  return message ? (
    <Alert color="teal" role="status">
      {message}
    </Alert>
  ) : null;
}
