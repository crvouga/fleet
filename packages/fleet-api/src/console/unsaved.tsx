/** @jsxImportSource react */
import { useEffect, useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { navigate } from './router';

export function useUnsavedChanges(dirty: boolean) {
  const [destination, setDestination] = useState<string>();
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const guard = (event: Event) => {
      event.preventDefault();
      setDestination((event as CustomEvent<string>).detail);
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('fleet:before-navigate', guard);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('fleet:before-navigate', guard);
    };
  }, [dirty]);
  return { destination, close: () => setDestination(undefined) };
}

export function UnsavedDialog({
  navigation,
  busy,
}: {
  navigation: ReturnType<typeof useUnsavedChanges>;
  busy: boolean;
}) {
  return (
    <Modal
      opened={!!navigation.destination}
      onClose={navigation.close}
      title={busy ? 'Changes are being saved' : 'Discard unsaved changes?'}
      centered
    >
      <Stack>
        <Text size="sm">
          {busy
            ? 'Wait for the current request to finish before leaving.'
            : 'Your draft has not been saved. Stay here to keep editing, or discard it and leave.'}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={navigation.close}>
            Keep editing
          </Button>
          <Button
            color="red"
            disabled={busy}
            onClick={() => {
              const href = navigation.destination;
              navigation.close();
              if (href) navigate(href, true);
            }}
          >
            Discard and leave
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
