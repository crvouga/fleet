/** @jsxImportSource react */
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Group,
  NavLink,
  Stack,
  Text,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { AdminBrand } from './components';
import { ThemePicker } from './theme-picker';

export interface AdminNavItem {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  count?: number;
}
interface ShellProps {
  name: string;
  subtitle?: string;
  icon?: ReactNode;
  navigation: AdminNavItem[];
  account: ReactNode;
  children: ReactNode;
  header?: ReactNode;
}

export function AdminShell(props: ShellProps) {
  const [opened, { toggle, close }] = useDisclosure();
  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 248, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding={{ base: 'md', sm: 'xl' }}
    >
      <Button
        className="skip-link"
        onClick={() => document.getElementById('main-content')?.focus()}
      >
        Skip to content
      </Button>
      <AppShell.Header px={{ base: 'sm', sm: 'lg' }}>
        <Group h="100%" justify="space-between" wrap="nowrap" gap="xs">
          <Group wrap="nowrap" gap="xs">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={opened ? 'Close navigation' : 'Open navigation'}
              aria-expanded={opened}
              aria-controls="admin-navigation"
            />
            <AdminBrand
              name={props.name}
              {...(props.subtitle ? { subtitle: props.subtitle } : {})}
              icon={props.icon}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            {props.header}
            <ThemePicker />
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar id="admin-navigation" p="md">
        <AppShell.Section grow>
          <Navigation items={props.navigation} close={close} />
        </AppShell.Section>
        <AppShell.Section>{props.account}</AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main id="main-content" tabIndex={-1}>
        <Box maw={1240} mx="auto">
          {props.children}
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

function Navigation({
  items,
  close,
}: {
  items: AdminNavItem[];
  close: () => void;
}) {
  return (
    <Stack gap={4}>
      <Text
        size="xs"
        fw={600}
        c="dimmed"
        tt="uppercase"
        px="sm"
        mt="sm"
        mb="sm"
      >
        Workspace
      </Text>
      {items.map((item) => (
        <NavLink
          key={item.href}
          component="a"
          href={item.href}
          label={item.label}
          leftSection={item.icon}
          active={item.active}
          aria-current={item.active ? 'page' : undefined}
          onClick={close}
          mb={4}
          rightSection={
            item.count ? (
              <Badge size="xs" variant="light">
                {item.count}
              </Badge>
            ) : undefined
          }
        />
      ))}
    </Stack>
  );
}
