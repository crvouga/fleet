/** @jsxImportSource react */
import { useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import type { ReactNode } from 'react';

interface DialogProps {
  opened: boolean;
  title: string;
  expected: string;
  confirmLabel: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (typed: string) => void;
  children?: ReactNode;
}

function ConfirmForm({
  expected,
  confirmLabel,
  busy,
  error,
  onClose,
  onConfirm,
  children,
}: Omit<DialogProps, 'opened' | 'title'>) {
  const [typed, setTyped] = useState('');
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (typed.trim() === expected) onConfirm(typed);
      }}
    >
      <Stack>
        {children}
        <TextInput
          label={`Type ${expected} to confirm`}
          description="This guards against acting on the wrong machine."
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          data-autofocus
          disabled={busy}
        />
        <ErrorNotice message={error} />
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            color="red"
            loading={busy}
            disabled={typed.trim() !== expected}
          >
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * A destructive action behind typed confirmation: the button stays disabled
 * until the person types the node's name. The server checks it again, so this
 * is a convenience and never the control. The form remounts on every opening,
 * so a typed name never survives into the next dialog.
 */
export function ConfirmDialog(props: DialogProps) {
  const { opened, title, busy, onClose } = props;
  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      closeButtonProps={{ 'aria-label': 'Cancel action' }}
      closeOnClickOutside={!busy}
      closeOnEscape={!busy}
      keepMounted={false}
      centered
    >
      <ConfirmForm {...props} />
    </Modal>
  );
}
