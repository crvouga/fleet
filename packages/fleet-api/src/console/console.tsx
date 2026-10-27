/** @jsxImportSource react */
import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { Alert, Button, Center, Group, Loader, Stack } from '@mantine/core';
import { useDocumentTitle } from '@mantine/hooks';
import {
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-react';
import { AdminProvider, prepareAdminUi } from '@pkgs/admin-ui/provider';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import { installNavigation, useLocation } from './router';
import { useConsoleResource } from './resource';
import { FleetShell } from './shell';
import { SignIn } from './access';
import { Pages } from './pages';
prepareAdminUi();
installNavigation();
function Console() {
  const path = useLocation();
  const pathname = path.split('?')[0] ?? '/';
  const resource = useConsoleResource(path);
  useDocumentTitle(`${pageTitle(path)} · Fleet`);
  useEffect(() => {
    document.querySelector<HTMLElement>('main h1')?.focus();
  }, [pathname, resource.data?.path, resource.data?.status]);
  if (!resource.data)
    return <InitialLoading error={resource.error} reload={resource.reload} />;
  if (resource.data.status !== 'ready') return <SignIn state={resource.data} />;
  return (
    <FleetShell data={resource.data} path={path}>
      <Stack gap="lg">
        <DataNotice />
        <Group justify="flex-end">
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={
              resource.paused ? (
                <IconPlayerPlay size={14} />
              ) : (
                <IconPlayerPause size={14} />
              )
            }
            aria-pressed={resource.paused}
            onClick={() => resource.setPaused(!resource.paused)}
          >
            {resource.paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            loading={resource.loading}
            leftSection={<IconRefresh size={14} />}
            onClick={resource.reload}
          >
            Refresh
          </Button>
        </Group>
        <ErrorNotice message={resource.error} retry={resource.reload} />
        <SnapshotNotice error={resource.error} at={resource.data.fleet.now} />
        {resource.data.path !== path ? (
          resource.error ? null : (
            <Center mih={220}>
              <Loader aria-label="Loading page" />
            </Center>
          )
        ) : (
          <Pages
            key={path.split('?')[0]}
            state={resource.data}
            path={path}
            reload={resource.reload}
          />
        )}
      </Stack>
    </FleetShell>
  );
}
function DataNotice() {
  const source = document
    .querySelector('meta[name="fleet-data-source"]')
    ?.getAttribute('content');
  if (source === 'fixtures')
    return (
      <Alert color="yellow" title="LOCAL DEMO">
        Synthetic fleet data. Changes disappear on restart; no real machines are
        affected.
      </Alert>
    );
  if (source === 'managed')
    return (
      <Alert color="orange" title="LIVE FLEET DATA">
        Changes affect the managed fleet. Background jobs run only on the
        deployed service.
      </Alert>
    );
  return null;
}
function pageTitle(path: string) {
  const section = path.split('/')[1]?.split('?')[0];
  return (
    (
      {
        nodes: 'Nodes',
        pending: 'Pending approvals',
        settings: 'Settings',
        access: 'Access',
        events: 'Events',
        add: 'Add a node',
        login: 'Sign in',
        'not-allowed': 'Not allowed',
      } as Record<string, string>
    )[section ?? ''] ?? 'Overview'
  );
}
createRoot(document.getElementById('admin-root')!).render(
  <AdminProvider>
    <Console />
  </AdminProvider>
);

function InitialLoading({
  error,
  reload,
}: {
  error: string;
  reload: () => void;
}) {
  return (
    <Center mih="100dvh">
      <Stack align="center">
        {error ? (
          <ErrorNotice message={error} retry={reload} />
        ) : (
          <Loader aria-label="Loading Fleet" />
        )}
      </Stack>
    </Center>
  );
}

function SnapshotNotice({ error, at }: { error: string; at: Date }) {
  if (!error) return null;
  return (
    <Alert color="orange" title="Showing the last successful report">
      Live refresh failed. The displayed metrics and job states may be stale;
      the last snapshot was received at {at.toLocaleString()}.
    </Alert>
  );
}
