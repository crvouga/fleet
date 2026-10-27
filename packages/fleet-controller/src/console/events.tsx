/** @jsxImportSource react */
import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { PageHeading } from '@pkgs/admin-ui/components';
import type { EventRow } from '../types';
import type { ConsoleState } from './model';
import { relativeTime } from '../ui/lib/format';
import { navigate } from './router';
export function EventFeed({
  events,
  now,
}: {
  events: readonly EventRow[];
  now: Date;
}) {
  if (!events.length)
    return (
      <Text size="sm" c="dimmed" py="lg">
        No events match.
      </Text>
    );
  return (
    <Table.ScrollContainer minWidth={550}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Severity</Table.Th>
            <Table.Th>Event</Table.Th>
            <Table.Th>Time</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((event) => (
            <Table.Tr key={event.id}>
              <Table.Td>
                <Badge
                  variant="light"
                  color={
                    event.severity === 'error'
                      ? 'red'
                      : event.severity === 'warn'
                        ? 'orange'
                        : 'gray'
                  }
                >
                  {event.severity}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Stack gap={2}>
                  <Text size="sm">{event.message}</Text>
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      {event.kind}
                    </Text>
                    {event.nodeId && (
                      <Anchor size="xs" href={`/nodes/${event.nodeId}`}>
                        {event.nodeLabel ?? 'Node'}
                      </Anchor>
                    )}
                  </Group>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" title={event.at.toISOString()}>
                  {relativeTime(event.at, now)}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
export function Events({ state, path }: { state: ConsoleState; path: string }) {
  const params = new URLSearchParams(path.split('?')[1]);
  const severity = params.get('severity') ?? 'all';
  const node = params.get('node') ?? 'all';
  const before = Number(params.get('before') ?? Number.MAX_SAFE_INTEGER);
  const matching = state.events.filter(
    (event) =>
      (severity === 'all' ||
        event.severity === severity ||
        (severity === 'warn' && event.severity === 'error')) &&
      (node === 'all' || event.nodeId === node) &&
      event.id < before
  );
  const shown = matching.slice(0, 25);
  function filter(key: string, value: string | null) {
    const query = new URLSearchParams(params);
    query.delete('before');
    if (value && value !== 'all') query.set(key, value);
    else query.delete(key);
    navigate(`/events?${query}`);
  }
  function older() {
    const query = new URLSearchParams(params);
    query.set('before', String(shown.at(-1)?.id ?? state.nextBefore));
    navigate(`/events?${query}`);
  }
  return (
    <Stack>
      <PageHeading
        title="Events"
        description="Node reports and administrative changes, newest first."
      />
      <Paper withBorder p="lg">
        <Stack>
          <EventFilters
            state={state}
            severity={severity}
            node={node}
            filter={filter}
          />
          <EventFeed events={shown} now={state.fleet.now} />
          <Group justify="space-between">
            <Button variant="subtle" component="a" href="/events">
              Back to newest
            </Button>
            {(matching.length > 25 || state.nextBefore !== null) && (
              <Button variant="default" onClick={older}>
                Older events
              </Button>
            )}
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}

function EventFilters({
  state,
  severity,
  node,
  filter,
}: {
  state: ConsoleState;
  severity: string;
  node: string;
  filter: (key: string, value: string | null) => void;
}) {
  return (
    <Group>
      <Select
        label="Severity"
        data={['all', 'info', 'warn', 'error']}
        value={severity}
        onChange={(value) => filter('severity', value)}
        allowDeselect={false}
      />
      <Select
        label="Node"
        data={[
          { value: 'all', label: 'All nodes' },
          ...state.fleet.entries.map((entry) => ({
            value: entry.view.id,
            label: entry.view.label,
          })),
        ]}
        value={node}
        onChange={(value) => filter('node', value)}
        searchable
        allowDeselect={false}
      />
    </Group>
  );
}
