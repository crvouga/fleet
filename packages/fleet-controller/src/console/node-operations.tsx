/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import { isActive, type Operation } from '../domain/operations';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { useAction } from './action';
import type { ConsoleState } from './model';
import { OperationBadge, OperationDetail } from './operations';
import { ConfirmDialog } from './typed-confirm';
import { useJson } from './use-json';

type Dialog = 'restart' | 'replace' | 'decommission' | undefined;
type Action = ReturnType<typeof useAction>;

const TITLES = {
  restart: 'Restart this node?',
  replace: 'Replace this node?',
  decommission: 'Decommission this node?',
} as const;

const CONFIRM_LABELS = {
  restart: 'Restart node',
  replace: 'Replace node',
  decommission: 'Decommission node',
} as const;

/** Machines that could take over: registered, not rejected or retired, with no other role. */
function candidates(state: ConsoleState, entry: FleetEntry) {
  return state.fleet.entries.filter(
    ({ view }) =>
      view.id !== entry.view.id &&
      (view.approval === 'pending' || view.approval === 'approved') &&
      (view.role === null || view.role === entry.view.role)
  );
}

function ActiveOperation({
  op,
  action,
  canWrite,
}: {
  op: Operation;
  action: Action;
  canWrite: boolean;
}) {
  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Stack gap={4}>
          <Group gap="xs">
            <Text size="sm" fw={600}>
              {op.kind}
            </Text>
            <OperationBadge status={op.status} />
          </Group>
          <OperationDetail op={op} />
        </Stack>
        {isActive(op.status) && (
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
      </Group>
    </Paper>
  );
}

function DialogBody({
  dialog,
  entry,
  state,
  pick,
}: {
  dialog: Exclude<Dialog, undefined>;
  entry: FleetEntry;
  state: ConsoleState;
  pick: {
    replacement: string;
    setReplacement: (value: string) => void;
    force: boolean;
    setForce: (value: boolean) => void;
  };
}) {
  const label = entry.view.label;
  if (dialog === 'restart')
    return (
      <Text size="sm">
        {label} drains (no new jobs), waits until no job is running, then
        reboots once. It never reboots while jobs run, and never when automatic
        reboots are off.
      </Text>
    );
  if (dialog === 'replace')
    return (
      <Stack>
        <Text size="sm">
          {label} is cordoned while the replacement is approved, takes over the
          {entry.view.role ? ` ${entry.view.role}` : ''} role and converges.
          Then decommission the old node.
        </Text>
        <NativeSelect
          label="Replacement machine"
          description="It must already be registered (pending or approved)."
          data={[
            { value: '', label: 'Choose a machine' },
            ...candidates(state, entry).map(({ view }) => ({
              value: view.id,
              label: `${view.label} (${view.approval})`,
            })),
          ]}
          value={pick.replacement}
          onChange={(event) => pick.setReplacement(event.currentTarget.value)}
        />
      </Stack>
    );
  return (
    <Stack>
      <Text size="sm">
        {label} drains first (no new jobs; running jobs finish), then it is
        retired and its access ends.
      </Text>
      {entry.view.status === 'offline' && (
        <Checkbox
          label="Force: the machine is unreachable and I have checked it is powered off or isolated"
          checked={pick.force}
          onChange={(event) => pick.setForce(event.currentTarget.checked)}
        />
      )}
    </Stack>
  );
}

function Controls({
  entry,
  active,
  action,
  open,
}: {
  entry: FleetEntry;
  active: readonly Operation[];
  action: Action;
  open: (dialog: Exclude<Dialog, undefined>) => void;
}) {
  const { view } = entry;
  const running = (kind: Operation['kind']) =>
    active.some((op) => op.kind === kind);
  const base = `/nodes/${view.id}/operations`;
  const idle = !action.busy;
  return (
    <Group>
      <Button
        variant="default"
        disabled={!idle || running('drain') || running('decommission')}
        onClick={() => action.run(`${base}/drain`, {})}
      >
        Drain
      </Button>
      <Button
        variant="default"
        disabled={!idle}
        onClick={() => action.run(`${base}/undrain`, {})}
      >
        Undrain
      </Button>
      <Button
        variant="light"
        disabled={!idle || running('restart') || running('decommission')}
        onClick={() => open('restart')}
      >
        Restart
      </Button>
      <Button
        variant="light"
        disabled={!idle || running('replace') || running('decommission')}
        onClick={() => open('replace')}
      >
        Replace
      </Button>
      <Button
        variant="light"
        color="red"
        disabled={!idle || running('decommission')}
        onClick={() => open('decommission')}
      >
        Decommission
      </Button>
    </Group>
  );
}

/** The typed-confirmation dialog for restart, replace and decommission. */
function OperationDialog({
  dialog,
  close,
  entry,
  state,
  action,
}: {
  dialog: Dialog;
  close: () => void;
  entry: FleetEntry;
  state: ConsoleState;
  action: Action;
}) {
  const [replacement, setReplacement] = useState('');
  const [force, setForce] = useState(false);
  const finish = () => {
    setReplacement('');
    setForce(false);
    close();
  };
  async function confirm(typed: string) {
    if (!dialog) return;
    const values: Record<string, string> = { confirm: typed };
    if (dialog === 'replace') values['replacement'] = replacement;
    if (dialog === 'decommission' && force) values['force'] = 'true';
    if (
      await action.run(`/nodes/${entry.view.id}/operations/${dialog}`, values)
    )
      finish();
  }
  return (
    <ConfirmDialog
      opened={dialog !== undefined}
      title={dialog ? TITLES[dialog] : ''}
      expected={entry.view.label}
      confirmLabel={dialog ? CONFIRM_LABELS[dialog] : ''}
      busy={action.busy}
      error={action.error}
      onClose={finish}
      onConfirm={(typed) => void confirm(typed)}
    >
      {dialog && (
        <DialogBody
          dialog={dialog}
          entry={entry}
          state={state}
          pick={{ replacement, setReplacement, force, setForce }}
        />
      )}
    </ConfirmDialog>
  );
}

/** Drain, restart, replace and decommission, with the progress the controller can prove. */
export function NodeOperations({
  entry,
  state,
  reload,
}: {
  entry: FleetEntry;
  state: ConsoleState;
  reload: () => void;
}) {
  const { view } = entry;
  const list = useJson<{ operations: Operation[] }>(
    `/v1/operations?node=${view.id}&limit=5`
  );
  const action = useAction(() => {
    list.reload();
    reload();
  });
  const [dialog, setDialog] = useState<Dialog>();
  const operations = list.data?.operations ?? [];
  const canWrite = state.role !== 'viewer' && view.approval === 'approved';
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Operations
        </Title>
        <Text size="sm" c="dimmed">
          These record intent as settings; the node does the work and reports
          back. Progress below is what the node has proved so far.
        </Text>
        <ErrorNotice message={action.error} />
        {action.success && (
          <Alert color="teal" role="status">
            {action.success}
          </Alert>
        )}
        {canWrite && (
          <Controls
            entry={entry}
            active={operations.filter((op) => isActive(op.status))}
            action={action}
            open={setDialog}
          />
        )}
        {operations.map((op) => (
          <ActiveOperation
            key={op.id}
            op={op}
            action={action}
            canWrite={state.role !== 'viewer'}
          />
        ))}
        <OperationDialog
          dialog={dialog}
          close={() => setDialog(undefined)}
          entry={entry}
          state={state}
          action={action}
        />
      </Stack>
    </Paper>
  );
}
