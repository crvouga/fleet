/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NativeSelect,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import type { ConsoleState } from './model';
import { useAction } from './action';
export function Access({
  state,
  reload,
}: {
  state: ConsoleState;
  reload: () => void;
}) {
  const [email, setEmail] = useState('');
  const [removing, setRemoving] = useState<string>();
  const action = useAction(reload);
  if (!state.access.available)
    return (
      <Stack>
        <PageHeading
          title="Fleet access"
          description="Manage verified email addresses that may administer Fleet."
        />
        <Alert color="yellow">
          Access management requires a signed-in Fleet administrator. It is
          unavailable in this synthetic demo.
        </Alert>
      </Stack>
    );
  return (
    <Stack gap="lg">
      <PageHeading
        title="Fleet access"
        description="Only verified Email addresses on this list can sign in to Fleet."
      />
      <AccessAdvice viewer={state.role === 'viewer'} />
      <ErrorNotice message={action.error} />
      {action.success && (
        <Alert color="teal" role="status">
          {action.success}
        </Alert>
      )}
      <Paper withBorder p="lg">
        <Stack>
          <Title order={2} size="h4">
            Allowed accounts
          </Title>
          <AllowedAccounts
            state={state}
            busy={action.busy}
            remove={setRemoving}
            setRole={(target, role) =>
              void action.run('/access', {
                email: target,
                action: 'role',
                role,
              })
            }
          />
        </Stack>
      </Paper>
      {state.role !== 'viewer' && (
        <InviteAccess email={email} setEmail={setEmail} action={action} />
      )}
      <RemoveAccess
        removing={removing}
        close={() => setRemoving(undefined)}
        action={action}
      />
    </Stack>
  );
}

function RemoveAccess({
  removing,
  close,
  action,
}: {
  removing: string | undefined;
  close: () => void;
  action: ReturnType<typeof useAction>;
}) {
  return (
    <Modal
      opened={!!removing}
      onClose={() => {
        if (!action.busy) close();
      }}
      title="Remove access?"
      closeButtonProps={{ 'aria-label': 'Cancel removal' }}
      centered
    >
      <Stack>
        <Text size="sm">{removing} will lose access to Fleet immediately.</Text>
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
                removing &&
                (await action.run('/access', {
                  email: removing,
                  action: 'revoke',
                }))
              )
                close();
            }}
          >
            Remove access
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function InviteAccess({
  email,
  setEmail,
  action,
}: {
  email: string;
  setEmail: (email: string) => void;
  action: ReturnType<typeof useAction>;
}) {
  const [role, setRole] = useState('viewer');
  return (
    <Paper withBorder p="lg">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await action.run('/access', { email, role })) setEmail('');
        }}
      >
        <Stack>
          <Title order={2} size="h4">
            Allow a person
          </Title>
          <TextInput
            label="Email address"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
          <NativeSelect
            label="Role"
            description="Admins change the fleet and manage access. Viewers read everything that is not a secret."
            data={ROLE_CHOICES}
            value={role}
            onChange={(event) => setRole(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button type="submit" loading={action.busy}>
              Allow access
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

const ROLE_CHOICES = [
  { value: 'admin', label: 'Admin: can change the fleet' },
  { value: 'viewer', label: 'Viewer: read only' },
];

function AccessAdvice({ viewer }: { viewer: boolean }) {
  return (
    <Alert color="indigo">
      Admins change the fleet and manage access; viewers read everything that is
      not a secret. The last admin cannot be removed or demoted.
      {viewer &&
        ' You are a viewer, so this list is read only. Ask an administrator to change roles.'}
    </Alert>
  );
}

function AllowedAccounts({
  state,
  busy,
  remove,
  setRole,
}: {
  state: ConsoleState;
  busy: boolean;
  remove: (email: string) => void;
  setRole: (email: string, role: string) => void;
}) {
  const entries =
    state.access.entries ??
    state.access.emails.map((email) => ({ email, role: 'admin' as const }));
  const admins = entries.filter((entry) => entry.role === 'admin').length;
  const readOnly = state.role === 'viewer';
  return (
    <Stack component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
      {entries.map((item) => {
        const lastAdmin = item.role === 'admin' && admins <= 1;
        return (
          <Group component="li" key={item.email} justify="space-between">
            <Group>
              <Text size="sm">{item.email}</Text>
              {item.email === state.actor && <Badge variant="light">You</Badge>}
            </Group>
            <Group>
              <NativeSelect
                size="xs"
                aria-label={`Role of ${item.email}`}
                data={ROLE_CHOICES}
                value={item.role}
                disabled={readOnly || busy || lastAdmin}
                title={
                  lastAdmin ? 'The last admin cannot be demoted.' : undefined
                }
                onChange={(event) =>
                  setRole(item.email, event.currentTarget.value)
                }
              />
              <Button
                size="xs"
                color="red"
                variant="subtle"
                disabled={readOnly || lastAdmin || busy}
                onClick={() => remove(item.email)}
              >
                Remove access
              </Button>
            </Group>
          </Group>
        );
      })}
    </Stack>
  );
}
