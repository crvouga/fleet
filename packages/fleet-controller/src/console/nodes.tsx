/** @jsxImportSource react */
import { useState } from 'react';
import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { PageHeading } from '@pkgs/admin-ui/components';
import type { ConsoleState } from './model';
import type { FleetEntry } from '../ui/lib/fleet-data';
import {
  filterNodes,
  parseNodesQuery,
  sortNodes,
  SORT_KEYS,
  STATUS_FILTERS,
} from '../ui/lib/nodes-query';
import {
  formatDuration,
  formatLoad,
  formatPercent,
  relativeTime,
  shortRevision,
} from '../ui/lib/format';
import { diskPercent } from '../ui/lib/facts';
import { ROLES } from '../types';
import { navigate } from './router';
const colors: Record<string, string> = {
  online: 'teal',
  stale: 'yellow',
  offline: 'red',
  pending: 'indigo',
  rejected: 'gray',
  retired: 'gray',
};
export function Status({ status }: { status: string }) {
  return (
    <Badge variant="dot" color={colors[status] ?? 'gray'} tt="capitalize">
      {status}
    </Badge>
  );
}
export function Nodes({ state, path }: { state: ConsoleState; path: string }) {
  const query = parseNodesQuery(
    Object.fromEntries(new URLSearchParams(path.split('?')[1]))
  );
  const entries = sortNodes(filterNodes(state.fleet.entries, query), query);
  return (
    <Stack gap="lg">
      <PageHeading
        title="Nodes"
        description="Every machine and its latest report."
        action={
          <Button
            component="a"
            href="/add"
            leftSection={<IconPlus size={16} />}
          >
            Add node
          </Button>
        }
      />
      <Paper withBorder p="lg">
        <Stack gap="lg">
          <NodeFilters path={path} />
          <NodeTable entries={entries} now={state.fleet.now} />
          <Text size="xs" c="dimmed">
            {entries.length} of {state.fleet.entries.length} machines
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );
}
function NodeFilters({ path }: { path: string }) {
  const initial = new URLSearchParams(path.split('?')[1]);
  const [search, setSearch] = useState(initial.get('q') ?? '');
  function filter(key: string, value: string | null) {
    const params = new URLSearchParams(path.split('?')[1]);
    if (value) params.set(key, value);
    else params.delete(key);
    navigate(`/nodes?${params}`);
  }
  return (
    <Group align="end">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          filter('q', search);
        }}
      >
        <Group align="end">
          <TextInput
            label="Search nodes"
            placeholder="Name, label, address, or revision…"
            leftSection={<IconSearch size={16} />}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          <Button type="submit" variant="default">
            Search
          </Button>
        </Group>
      </form>
      <Select
        label="Status"
        data={[...STATUS_FILTERS]}
        value={initial.get('status') ?? 'all'}
        onChange={(value) => filter('status', value)}
        allowDeselect={false}
        w={130}
      />
      <Select
        label="Role"
        data={['all', ...ROLES]}
        value={initial.get('role') ?? 'all'}
        onChange={(value) => filter('role', value === 'all' ? null : value)}
        allowDeselect={false}
        w={130}
      />
      <Select
        label="Sort by"
        data={[...SORT_KEYS]}
        value={initial.get('sort') ?? 'status'}
        onChange={(value) => filter('sort', value)}
        allowDeselect={false}
        w={140}
      />
      <Select
        label="Direction"
        data={[
          { value: 'asc', label: 'Ascending' },
          { value: 'desc', label: 'Descending' },
        ]}
        value={initial.get('dir') ?? 'asc'}
        onChange={(value) => filter('dir', value)}
        allowDeselect={false}
        w={140}
      />
    </Group>
  );
}
export function NodeTable({
  entries,
  now,
}: {
  entries: readonly FleetEntry[];
  now: Date;
}) {
  if (!entries.length)
    return (
      <Stack align="center" py="xl">
        <Text fw={600}>No matching nodes</Text>
        <Text size="sm" c="dimmed">
          Try another filter, or add your first machine.
        </Text>
        <Button component="a" href="/add" variant="light">
          Add a node
        </Button>
      </Stack>
    );
  return (
    <Table.ScrollContainer minWidth={860}>
      <Table verticalSpacing="md" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {[
              'Node',
              'Role',
              'Status',
              'Last seen',
              'Load',
              'Memory',
              'Disk',
              'Runner slots',
              'Revision',
            ].map((name) => (
              <Table.Th key={name}>{name}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {entries.map((entry) => (
            <NodeRow key={entry.view.id} entry={entry} now={now} />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
function NodeRow({ entry, now }: { entry: FleetEntry; now: Date }) {
  const { view, facts } = entry;
  return (
    <Table.Tr>
      <Table.Td>
        <Stack gap={2}>
          <Anchor href={`/nodes/${view.id}`} fw={600} size="sm">
            {view.label}
          </Anchor>
          <Text size="xs" c="dimmed">
            {view.hostname} · {formatDuration(facts.uptimeSeconds)}
          </Text>
        </Stack>
      </Table.Td>
      <Table.Td>
        <Badge variant="light" color="gray">
          {view.role}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Status status={view.status} />
      </Table.Td>
      <Table.Td>
        <Text size="sm" title={view.lastSeenAt?.toISOString()}>
          {relativeTime(view.lastSeenAt, now)}
        </Text>
      </Table.Td>
      <Table.Td>{formatLoad(facts.load1)}</Table.Td>
      <Table.Td>{formatPercent(facts.memUsedPercent)}</Table.Td>
      <Table.Td>
        <Stack gap={4}>
          <Text size="xs">{formatPercent(diskPercent(facts))}</Text>
          <Progress
            size="xs"
            color={
              (diskPercent(facts) ?? 0) >= entry.diskAlertPercent
                ? 'orange'
                : 'indigo'
            }
            value={diskPercent(facts) ?? 0}
            aria-label={`${view.label} disk usage`}
          />
        </Stack>
      </Table.Td>
      <Table.Td>
        {facts.slots === null
          ? '—'
          : `${facts.busySlots ?? 0} / ${facts.slots}`}
      </Table.Td>
      <Table.Td>
        <Text size="xs" ff="monospace">
          {shortRevision(view.revision)}
          {entry.behind ? ' · behind' : ''}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}
