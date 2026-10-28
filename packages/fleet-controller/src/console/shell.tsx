/** @jsxImportSource react */
import { Badge, Button, Divider, Stack, Text } from '@mantine/core';
import {
  IconActivity,
  IconAlertTriangle,
  IconBrandGithub,
  IconAdjustments,
  IconDashboard,
  IconHistory,
  IconListCheck,
  IconLogout,
  IconPlus,
  IconServer,
  IconShieldCheck,
  IconUsers,
} from '@tabler/icons-react';
import { AdminShell } from '@pkgs/admin-ui/shell';
import type { ReactNode } from 'react';
import type { ConsoleState } from './model';
const items = [
  { href: '/', label: 'Overview', icon: IconDashboard },
  { href: '/nodes', label: 'Nodes', icon: IconServer },
  { href: '/pending', label: 'Pending approvals', icon: IconShieldCheck },
  { href: '/events', label: 'Events', icon: IconActivity },
  { href: '/incidents', label: 'Incidents', icon: IconAlertTriangle },
  { href: '/runners', label: 'Runners', icon: IconBrandGithub },
  { href: '/operations', label: 'Operations', icon: IconListCheck },
  { href: '/audit', label: 'Audit log', icon: IconHistory },
  { href: '/settings', label: 'Settings', icon: IconAdjustments },
  { href: '/access', label: 'Access', icon: IconUsers },
  { href: '/add', label: 'Add a node', icon: IconPlus },
];
export function FleetShell({
  data,
  path,
  children,
}: {
  data: ConsoleState;
  path: string;
  children: ReactNode;
}) {
  const navigation = items
    .filter((item) => item.href !== '/audit' || data.role !== 'viewer')
    .map((item) => ({
      href: item.href,
      label: item.label,
      icon: <item.icon size={19} />,
      active: item.href === '/' ? path === '/' : path.startsWith(item.href),
      ...(item.href === '/pending' ? { count: data.fleet.pendingCount } : {}),
    }));
  const fixture = document
    .querySelector('meta[name="fleet-data-source"]')
    ?.getAttribute('content');
  return (
    <AdminShell
      name="Fleet controller"
      subtitle="Node coordination and recovery"
      icon={<IconServer size={21} />}
      navigation={navigation}
      header={
        <Badge variant="dot" color={fixture === 'fixtures' ? 'yellow' : 'teal'}>
          {fixture === 'fixtures'
            ? 'Local demo'
            : fixture === 'managed'
              ? 'Live data'
              : 'Fleet'}
        </Badge>
      }
      account={
        <Stack gap="md">
          <Divider />
          <Text size="xs" c="dimmed">
            Signed in as
          </Text>
          <Text size="xs" className="break-word">
            {data.actor}
          </Text>
          <form action="/logout" method="post">
            <Button
              type="submit"
              variant="subtle"
              color="gray"
              leftSection={<IconLogout size={17} />}
            >
              Sign out
            </Button>
          </form>
        </Stack>
      }
    >
      {children}
    </AdminShell>
  );
}
