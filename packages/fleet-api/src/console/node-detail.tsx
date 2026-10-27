/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { CopyValue, PageHeading } from '@pkgs/admin-ui/components';
import type { ConsoleState } from './model';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { attentionFor } from '../ui/lib/attention';
import {
  effectiveSettings,
  displayValue,
  scopeLabel,
} from '../ui/lib/effective';
import { formatDuration, formatMiB, shortRevision } from '../ui/lib/format';
import { settingMeta } from '../ui/lib/setting-meta';
import { Status } from './nodes';
import { NodeCharts } from './node-charts';
import { NodeReadiness } from './node-readiness';
import { NodeRecovery } from './node-recovery';
import { NodeTelemetry } from './node-telemetry';
import { NodeEdit, NodeManage } from './node-edit';
import { EventFeed } from './events';
export function NodeDetail({
  state,
  id,
  reload,
}: {
  state: ConsoleState;
  id: string;
  reload: () => void;
}) {
  const entry = state.fleet.entries.find((item) => item.view.id === id);
  if (!entry)
    return (
      <Stack>
        <PageHeading
          title="Node not found"
          description="This node is unavailable or has been removed."
        />
        <Button component="a" href="/nodes">
          Back to nodes
        </Button>
      </Stack>
    );
  return (
    <Stack gap="lg">
      <Anchor href="/nodes" size="sm">
        ← All nodes
      </Anchor>
      <PageHeading
        title={entry.view.label}
        description={`${entry.view.hostname} · ${entry.view.role} · #${entry.view.shortId}`}
        action={
          <Group>
            <Status status={entry.view.status} />
            <Button component="a" href={`/settings/node:${id}`} variant="light">
              Node settings
            </Button>
          </Group>
        }
      />
      <NodeNotices entry={entry} />
      <NodeReadiness entry={entry} />
      <NodeRecovery
        entry={entry}
        events={state.events}
        now={state.fleet.now}
        reload={reload}
      />
      <NodeCharts state={state} entry={entry} />
      <NodeTelemetry entry={entry} now={new Date()} />
      <NodePanels entry={entry} reload={reload} />
      <EffectiveConfig state={state} entry={entry} />
      <Paper withBorder p="lg">
        <Stack>
          <Title order={2} size="h4">
            Timeline
          </Title>
          <EventFeed events={state.events} now={state.fleet.now} />
        </Stack>
      </Paper>
    </Stack>
  );
}
function NodeFacts({ entry }: { entry: FleetEntry }) {
  const { view, facts } = entry;
  const items = [
    ['Role', view.role],
    ['Kernel', facts.kernel],
    ['Architecture', facts.arch],
    ['CPU', `${facts.cpuCores ?? '?'} cores · ${facts.cpuModel ?? 'Unknown'}`],
    ['Memory', formatMiB(facts.memTotalMiB)],
    ['Uptime', formatDuration(facts.uptimeSeconds)],
    ['Agent', view.agentVersion],
    ['Revision', shortRevision(view.revision)],
    ['Config revision', view.configRevision],
    ['First seen', view.firstSeenAt.toLocaleString()],
    ['Last seen', view.lastSeenAt?.toLocaleString()],
    ['Enrolled via', view.enrolledVia],
    ['Approved by', view.approvedBy],
    ['Boot ID', facts.bootId],
  ];
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Details
        </Title>
        <CopyValue label="Node ID" value={view.id} />
        <CopyValue label="Hostname" value={view.hostname} />
        <SimpleGrid cols={2}>
          {items.map(([label, value]) => (
            <Stack gap={3} key={label}>
              <Text size="xs" c="dimmed">
                {label}
              </Text>
              <Text size="sm" className="break-word">
                {value ?? 'Unknown'}
              </Text>
            </Stack>
          ))}
        </SimpleGrid>
        <Group gap="xs">
          {[...new Set([...view.labels, ...facts.capabilities])].map(
            (label) => (
              <Badge key={label} variant="light" color="gray">
                {label}
              </Badge>
            )
          )}
        </Group>
        {facts.addresses.map((address) => (
          <CopyValue key={address} label="Address" value={address} />
        ))}
      </Stack>
    </Paper>
  );
}
function EffectiveConfig({
  state,
  entry,
}: {
  state: ConsoleState;
  entry: FleetEntry;
}) {
  const settings = effectiveSettings(entry.view, state.fleet.documents);
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Effective configuration
        </Title>
        <Table.ScrollContainer minWidth={520}>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Setting</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th>Source</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {settings.map((setting) => (
                <Table.Tr key={setting.path}>
                  <Table.Td>
                    {settingMeta(setting.section, setting.key).label}
                  </Table.Td>
                  <Table.Td>
                    <Code>{displayValue(setting.value)}</Code>
                  </Table.Td>
                  <Table.Td>
                    {setting.source ? (
                      <Anchor size="sm" href={`/settings/${setting.source}`}>
                        {scopeLabel(setting.source)}
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        Built-in default
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>
    </Paper>
  );
}

function NodePanels({
  entry,
  reload,
}: {
  entry: FleetEntry;
  reload: () => void;
}) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }}>
      <NodeFacts entry={entry} />
      <Stack>
        <NodeEdit entry={entry} reload={reload} />
        <NodeManage entry={entry} reload={reload} />
      </Stack>
    </SimpleGrid>
  );
}

function NodeNotices({ entry }: { entry: FleetEntry }) {
  return (
    <>
      {' '}
      {attentionFor(entry).map((issue) => (
        <Alert
          key={issue.code}
          color={
            issue.level === 'error'
              ? 'red'
              : issue.level === 'warn'
                ? 'orange'
                : 'indigo'
          }
          title={issue.code}
        >
          {issue.message}
        </Alert>
      ))}
      {entry.view.note && (
        <Paper withBorder p="md">
          <Text size="sm">{entry.view.note}</Text>
        </Paper>
      )}
    </>
  );
}
