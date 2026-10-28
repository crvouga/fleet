/** @jsxImportSource react */
import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { CredentialStatus } from '../domain/credential-rotation';
import type { NodeView } from '../types';
import type { useAction } from './action';

type Action = ReturnType<typeof useAction>;

function Summary({ credential }: { credential: CredentialStatus }) {
  if (credential.revokedAt !== null)
    return (
      <Alert color="red" title="Credential revoked">
        Revoked {credential.revokedAt.toLocaleString()}. The node is locked out.
        If it registers again it waits for a person to approve it.
      </Alert>
    );
  if (credential.rotationPending)
    return (
      <Alert color="indigo" title="Rotation in progress">
        The node has offered a new secret. Both work until the node reports with
        the new one, then the old one stops working.
      </Alert>
    );
  if (credential.rotateRequestedAt !== null)
    return (
      <Alert color="indigo" title="Rotation requested">
        Requested {credential.rotateRequestedAt.toLocaleString()}. The node
        rotates on its next heartbeat.
      </Alert>
    );
  return (
    <Text size="sm" c="dimmed">
      {credential.rotatedAt === null
        ? 'The credential has not been rotated.'
        : `Last rotated ${credential.rotatedAt.toLocaleString()}.`}
    </Text>
  );
}

function RevokeDialog({
  view,
  action,
  opened,
  close,
}: {
  view: NodeView;
  action: Action;
  opened: boolean;
  close: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <Modal
      opened={opened}
      onClose={close}
      title="Revoke this node's credential?"
      centered
    >
      <Stack>
        <Text size="sm">
          {view.label} is locked out immediately. Use this for a lost or
          compromised machine. If it registers again it waits for approval; to
          keep it out for good, also reject it.
        </Text>
        <TextInput
          label={`Type ${view.label} to confirm`}
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            color="red"
            loading={action.busy}
            disabled={typed.trim() !== view.label}
            onClick={async () => {
              if (
                await action.run(`/nodes/${view.id}/credential/revoke`, {
                  confirm: typed,
                })
              ) {
                close();
                setTyped('');
              }
            }}
          >
            Revoke now
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Rotate or revoke the node's secret. Admins only; the server enforces it too. */
export function NodeCredential({
  view,
  credential,
  action,
  readOnly,
}: {
  view: NodeView;
  credential: CredentialStatus | null | undefined;
  action: Action;
  readOnly: boolean;
}) {
  const [revoking, setRevoking] = useState(false);
  if (!credential) return null;
  const locked = readOnly || credential.revokedAt !== null;
  return (
    <Stack gap="xs">
      <Title order={3} size="h5">
        Node credential
      </Title>
      <Summary credential={credential} />
      <Group>
        <Button
          size="xs"
          variant="light"
          disabled={locked}
          loading={action.busy}
          onClick={() => action.run(`/nodes/${view.id}/credential/rotate`, {})}
        >
          Rotate credential
        </Button>
        <Button
          size="xs"
          color="red"
          variant="light"
          disabled={locked}
          onClick={() => setRevoking(true)}
        >
          Revoke credential
        </Button>
      </Group>
      <RevokeDialog
        view={view}
        action={action}
        opened={revoking}
        close={() => setRevoking(false)}
      />
    </Stack>
  );
}
