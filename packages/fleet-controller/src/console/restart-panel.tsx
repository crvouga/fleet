/** @jsxImportSource react */
import { Badge, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import { formatDuration } from '../ui/lib/format';
import { NodeIncidents } from './incidents';
import { useJson } from './use-json';

interface RestartJson {
  boots: {
    eventId: number;
    bootId: string | null;
    startedAt: string;
    previousShutdown: 'clean' | 'unclean' | 'unknown';
  }[];
  restarts: number;
  uncleanShutdowns: number;
  restartsLast24h: number;
  restartsLast7d: number;
  current: { uptimeSeconds: number | null; bootedAt: string | null };
}

const SHUTDOWN_COLOR = { clean: 'teal', unclean: 'red', unknown: 'gray' };

/** Recent boots, uptime and how the boot before each one ended. */
export function RestartPanel({ nodeId }: { nodeId: string }) {
  const history = useJson<RestartJson>(`/v1/nodes/${nodeId}/restarts`);
  const data = history.data;
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Restarts and uptime
        </Title>
        <ErrorNotice message={history.error} retry={history.reload} />
        {data ? (
          <>
            <Group gap="xl">
              <Text size="sm">
                Uptime:{' '}
                {data.current.uptimeSeconds === null
                  ? 'unavailable'
                  : formatDuration(data.current.uptimeSeconds)}
              </Text>
              <Text size="sm">Restarts, 24 h: {data.restartsLast24h}</Text>
              <Text size="sm">Restarts, 7 d: {data.restartsLast7d}</Text>
              <Text size="sm">Unclean shutdowns: {data.uncleanShutdowns}</Text>
            </Group>
            {data.boots.length === 0 ? (
              <Text size="sm" c="dimmed">
                No boot events have been recorded for this node.
              </Text>
            ) : (
              <Table verticalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Boot started</Table.Th>
                    <Table.Th>Previous shutdown</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.boots.map((boot) => (
                    <Table.Tr key={boot.eventId}>
                      <Table.Td>
                        {new Date(boot.startedAt).toLocaleString()}
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          variant="light"
                          color={SHUTDOWN_COLOR[boot.previousShutdown]}
                        >
                          {boot.previousShutdown}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            <Text size="xs" c="dimmed">
              Derived from boot events. &quot;clean&quot; means the node
              reported no unclean shutdown; the oldest recorded boot is where
              observation began, so its predecessor is unknown.
            </Text>
          </>
        ) : null}
      </Stack>
    </Paper>
  );
}

/** Restarts, uptime and incidents for one node. */
export function NodeHistory({ nodeId }: { nodeId: string }) {
  return (
    <>
      <RestartPanel nodeId={nodeId} />
      <NodeIncidents nodeId={nodeId} />
    </>
  );
}
