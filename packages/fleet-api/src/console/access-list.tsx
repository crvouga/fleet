/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
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
          Access management requires a signed-in Fleet administrator.
          It is unavailable in this synthetic demo.
        </Alert>
      </Stack>
    );
  return (
    <Stack gap="lg">
      <PageHeading
        title="Fleet access"
        description="Only verified Email addresses on this list can administer Fleet."
      />
      <AccessAdvice />
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
          />
        </Stack>
      </Paper>
      <InviteAccess email={email} setEmail={setEmail} action={action} />
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
      title="Remove administrator access?"
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
  return (
    <Paper withBorder p="lg">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await action.run('/access', { email })) setEmail('');
        }}
      >
        <Stack>
          <Title order={2} size="h4">
            Invite an administrator
          </Title>
          <TextInput
            label="Email address"
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
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

function AccessAdvice() {
  return (
    <Alert color="indigo">
      Every listed person can manage access and administer the fleet. The final
      allowed account cannot be removed.
    </Alert>
  );
}

function AllowedAccounts({
  state,
  busy,
  remove,
}: {
  state: ConsoleState;
  busy: boolean;
  remove: (email: string) => void;
}) {
  return (
    <Stack component="ul" m={0} p={0} style={{ listStyle: 'none' }}>
      {state.access.emails.map((item) => (
        <Group component="li" key={item} justify="space-between">
          <Group>
            <Text size="sm">{item}</Text>
            {item === state.actor && <Badge variant="light">You</Badge>}
          </Group>
          <Button
            size="xs"
            color="red"
            variant="subtle"
            disabled={state.access.emails.length === 1 || busy}
            onClick={() => remove(item)}
          >
            Remove access
          </Button>
        </Group>
      ))}
    </Stack>
  );
}
