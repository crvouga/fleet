/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { PageHeading } from '@pkgs/admin-ui/components';
import { attentionList, fleetHealth } from '../ui/lib/attention';
import { shortRevision } from '../ui/lib/format';
import { visibleRoles } from '../domain/summary';
import type { ConsoleState } from './model';
import { EventFeed } from './events';
import { AddNode } from './add-node';
export function Overview({ state }: { state: ConsoleState }) {
  const { fleet } = state;
  const issues = attentionList(fleet.entries);
  const health = fleetHealth(issues, fleet.entries);
  if (!fleet.entries.length) return <AddNode empty />;
  return (
    <Stack gap="lg">
      <PageHeading
        title="Overview"
        description="Health, capacity, and activity across your fleet."
      />
      <Alert
        color={health.level === 'ok' ? 'teal' : 'orange'}
        title={
          health.level === 'ok'
            ? 'No operational alerts'
            : `${health.needAttention} machines need attention`
        }
      >
        {health.level === 'ok'
          ? 'Nothing needs you right now.'
          : 'Review the latest reports and resolve the items below.'}
      </Alert>
      <SummaryCards state={state} />
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <AttentionCard issues={issues} />
        <CapacityCard state={state} />
      </SimpleGrid>
      <RoleCards state={state} />
      <Paper withBorder p="lg">
        <Stack>
          <Title order={2} size="h4">
            Recent events
          </Title>
          <EventFeed events={state.events.slice(0, 8)} now={fleet.now} />
        </Stack>
      </Paper>
    </Stack>
  );
}
function SummaryCards({ state }: { state: ConsoleState }) {
  const summary = state.fleet.summary;
  const stats = [
    { label: 'Total machines', value: summary.total },
    { label: 'Online', value: summary.byStatus.online },
    { label: 'Offline', value: summary.byStatus.offline },
    { label: 'Pending approval', value: summary.byStatus.pending },
  ];
  return (
    <SimpleGrid cols={{ base: 2, md: 4 }}>
      {stats.map((stat) => (
        <Paper key={stat.label} withBorder p="lg">
          <Text size="sm" c="dimmed">
            {stat.label}
          </Text>
          <Text size="30px" fw={700}>
            {stat.value}
          </Text>
        </Paper>
      ))}
    </SimpleGrid>
  );
}
function RoleCards({ state }: { state: ConsoleState }) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Roles
        </Title>
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Role</Table.Th>
              <Table.Th>Online</Table.Th>
              <Table.Th>Total</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleRoles(state.fleet.summary.byRole).map((role) => (
              <Table.Tr key={role}>
                <Table.Td>
                  <Anchor href={`/nodes?role=${role}`}>{role}</Anchor>
                </Table.Td>
                <Table.Td>{state.fleet.summary.byRole[role].online}</Table.Td>
                <Table.Td>{state.fleet.summary.byRole[role].total}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </Paper>
  );
}

function AttentionCard({
  issues,
}: {
  issues: ReturnType<typeof attentionList>;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Needs attention
        </Title>
        {issues.length ? (
          issues.slice(0, 12).map((issue) => (
            <Group
              key={`${issue.entry.view.id}-${issue.code}`}
              justify="space-between"
              align="flex-start"
            >
              <Anchor href={`/nodes/${issue.entry.view.id}`} size="sm" fw={600}>
                {issue.entry.view.label}
              </Anchor>
              <Text size="sm" c="dimmed" maw={330}>
                {issue.message}
              </Text>
            </Group>
          ))
        ) : (
          <Text size="sm" c="dimmed">
            No outstanding issues.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function CapacityCard({ state }: { state: ConsoleState }) {
  const fleet = state.fleet;
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          CI runner capacity
        </Title>
        <Text fw={700} size="xl">
          {fleet.summary.runnerSlots.busy} / {fleet.summary.runnerSlots.total}{' '}
          slots busy
        </Text>
        <Progress
          value={
            fleet.summary.runnerSlots.total
              ? (fleet.summary.runnerSlots.busy /
                  fleet.summary.runnerSlots.total) *
                100
              : 0
          }
        />
        <Title order={3} size="h5" mt="md">
          Revisions
        </Title>
        <Text size="sm" c="dimmed">
          Latest main: {shortRevision(fleet.latest)}
        </Text>
        {fleet.summary.revisions.map((revision) => (
          <Group key={revision.revision} justify="space-between">
            <Text size="sm" ff="monospace">
              {shortRevision(revision.revision)}
            </Text>
            <Badge variant="light" color="gray">
              {revision.count} machines
            </Badge>
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
