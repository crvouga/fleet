/** @jsxImportSource react */
import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import { useState } from 'react';
import { formatDuration } from '../ui/lib/format';
import { useJson } from './use-json';

/** The /v1/incidents reply as JSON delivers it: times are ISO strings. */
export interface IncidentJson {
  id: string;
  rule: string;
  /** Null for a fleet-wide incident (job queue stalled, no runners online). */
  nodeId: string | null;
  nodeLabel: string | null;
  title: string;
  subject: string | null;
  severity: 'info' | 'warn' | 'error';
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  open: boolean;
  message: string;
  reportHref: string;
}
interface IncidentReply {
  incidents: IncidentJson[];
  nextBefore: number | null;
  summary: { open: number; total: number };
  truncated: boolean;
}

const SEVERITY_COLOR = { info: 'blue', warn: 'orange', error: 'red' } as const;

function IncidentRow({
  incident,
  showNode,
}: {
  incident: IncidentJson;
  showNode: boolean;
}) {
  const ended = new Date(incident.endedAt ?? incident.startedAt);
  return (
    <Table.Tr>
      {showNode ? (
        <Table.Td>
          {incident.nodeId === null ? (
            <Anchor size="sm" href="/runners">
              Runners
            </Anchor>
          ) : (
            <Anchor size="sm" href={`/nodes/${incident.nodeId}`}>
              {incident.nodeLabel ?? incident.nodeId.slice(0, 8)}
            </Anchor>
          )}
        </Table.Td>
      ) : null}
      <Table.Td>
        <Text size="sm" fw={600}>
          {incident.title}
          {incident.subject ? ` (${incident.subject})` : ''}
        </Text>
        <Text size="xs" c="dimmed">
          {incident.message}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge color={SEVERITY_COLOR[incident.severity]} variant="light">
          {incident.severity}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Text size="xs">{new Date(incident.startedAt).toLocaleString()}</Text>
      </Table.Td>
      <Table.Td>
        <Text size="xs">
          {formatDuration(incident.durationSeconds)}
          {incident.open ? ' so far' : ''}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge color={incident.open ? 'red' : 'teal'} variant="dot">
          {incident.open ? 'open' : `resolved ${ended.toLocaleString()}`}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Anchor size="sm" href={incident.reportHref}>
          Report issue
        </Anchor>
      </Table.Td>
    </Table.Tr>
  );
}

export function IncidentTable({
  incidents,
  showNode,
}: {
  incidents: readonly IncidentJson[];
  showNode: boolean;
}) {
  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            {showNode ? <Table.Th>Node</Table.Th> : null}
            <Table.Th>Incident</Table.Th>
            <Table.Th>Severity</Table.Th>
            <Table.Th>Started</Table.Th>
            <Table.Th>Duration</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Report</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {incidents.map((incident) => (
            <IncidentRow
              key={incident.id}
              incident={incident}
              showNode={showNode}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

function Paging({ reply }: { reply: IncidentReply | undefined }) {
  return (
    <Group justify="space-between" mt="md">
      <Button variant="subtle" component="a" href="/incidents">
        Back to newest
      </Button>
      {reply?.nextBefore ? (
        <Button
          variant="default"
          component="a"
          href={`/incidents?before=${reply.nextBefore}`}
        >
          Older incidents
        </Button>
      ) : null}
    </Group>
  );
}

/** Fleet-wide incidents, derived from open and close events. */
export function Incidents() {
  const [filter, setFilter] = useState('all');
  const before = new URLSearchParams(window.location.search).get('before');
  const query = [
    'limit=50',
    filter === 'open' ? 'open=true' : '',
    before ? `before=${encodeURIComponent(before)}` : '',
  ].filter(Boolean);
  const list = useJson<IncidentReply>(`/v1/incidents?${query.join('&')}`);
  const incidents = list.data?.incidents ?? [];
  return (
    <Stack>
      <PageHeading
        title="Incidents"
        description="Problems from when a node reported them until it reported them resolved, newest first. Derived from the event history."
      />
      <ErrorNotice message={list.error} retry={list.reload} />
      <Group justify="space-between">
        <SegmentedControl
          data={[
            { value: 'all', label: 'All' },
            { value: 'open', label: 'Open' },
          ]}
          value={filter}
          onChange={setFilter}
          aria-label="Incident filter"
        />
        <Text size="sm" c="dimmed">
          {list.data ? `${list.data.summary.open} open` : ''}
        </Text>
      </Group>
      <Paper withBorder p="lg">
        {list.data && incidents.length === 0 ? (
          <Text c="dimmed">No incidents.</Text>
        ) : (
          <IncidentTable incidents={incidents} showNode />
        )}
        {list.data?.truncated ? (
          <Text size="xs" c="dimmed" mt="sm">
            Only the most recent events were examined; older incidents may be
            missing.
          </Text>
        ) : null}
        <Paging reply={list.data} />
      </Paper>
    </Stack>
  );
}

/** The incidents of one node, on its page. */
export function NodeIncidents({ nodeId }: { nodeId: string }) {
  const list = useJson<IncidentReply>(`/v1/incidents?node=${nodeId}&limit=10`);
  const incidents = list.data?.incidents ?? [];
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          Incidents
        </Title>
        <ErrorNotice message={list.error} retry={list.reload} />
        {list.data && incidents.length === 0 ? (
          <Text c="dimmed" size="sm">
            No incidents recorded for this node.
          </Text>
        ) : (
          <IncidentTable incidents={incidents} showNode={false} />
        )}
        <Anchor size="sm" href="/incidents">
          All incidents
        </Anchor>
      </Stack>
    </Paper>
  );
}
