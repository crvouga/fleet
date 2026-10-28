/** @jsxImportSource react */
import {
  Anchor,
  Badge,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import {
  duration,
  type JobData,
  type RunnerData,
  type RunnersData,
} from './runners-api';

function jobColor(job: JobData): string {
  if (job.failed) return 'red';
  if (job.status === 'completed') return 'teal';
  return job.status === 'in_progress' ? 'blue' : 'gray';
}

function JobRow({ job }: { job: JobData }) {
  const state =
    job.status === 'completed'
      ? (job.conclusion ?? 'completed')
      : job.status.replace('_', ' ');
  return (
    <Table.Tr>
      <Table.Td>
        {job.htmlUrl ? (
          <Anchor href={job.htmlUrl} target="_blank" rel="noreferrer noopener">
            {job.name}
          </Anchor>
        ) : (
          job.name
        )}
        <Text size="xs" c="dimmed">
          {job.repository}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge color={jobColor(job)} variant="light">
          {state}
        </Badge>
      </Table.Td>
      <Table.Td>{duration(job.queuedSeconds)}</Table.Td>
      <Table.Td>{duration(job.runSeconds)}</Table.Td>
      <Table.Td>
        {job.nodeId ? (
          <Anchor href={`/nodes/${job.nodeId}`}>
            {job.nodeLabel ?? 'node'}
          </Anchor>
        ) : (
          '-'
        )}
        {job.runnerName ? (
          <Text size="xs" c="dimmed">
            {job.runnerName.split('-').slice(-2).join('-')}
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td>
        {job.reportUrl ? (
          <Anchor href={job.reportUrl}>Report issue</Anchor>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

const FILTERS = [
  { value: 'active', label: 'Queued and running' },
  { value: 'queued', label: 'Queued' },
  { value: 'in_progress', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: '', label: 'All' },
];

export function JobsPanel(props: {
  jobs: JobData[];
  filter: string;
  setFilter: (value: string) => void;
  more: (() => void) | null;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Jobs
          </Title>
          <Select
            aria-label="Filter jobs"
            data={FILTERS}
            value={props.filter}
            allowDeselect={false}
            onChange={(value) => props.setFilter(value ?? '')}
          />
        </Group>
        {props.jobs.length === 0 ? (
          <Text c="dimmed">No jobs match.</Text>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Job</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Queued for</Table.Th>
                  <Table.Th>Ran for</Table.Th>
                  <Table.Th>Node and slot</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {props.jobs.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {props.more ? (
          <Anchor component="button" type="button" onClick={props.more}>
            Show older jobs
          </Anchor>
        ) : null}
      </Stack>
    </Paper>
  );
}

function RunnerRow({ runner }: { runner: RunnerData }) {
  const flag = runner.orphan
    ? { color: 'red', text: `Orphan: ${runner.orphan.reason}` }
    : runner.unhealthy
      ? { color: 'yellow', text: 'Unhealthy' }
      : { color: 'teal', text: 'Healthy' };
  return (
    <Table.Tr>
      <Table.Td>{runner.name}</Table.Td>
      <Table.Td>{runner.busy ? 'busy' : runner.status}</Table.Td>
      <Table.Td>
        {runner.nodeId ? (
          <Anchor href={`/nodes/${runner.nodeId}`}>{runner.nodeLabel}</Anchor>
        ) : (
          'unknown'
        )}
      </Table.Td>
      <Table.Td>{runner.repository ?? 'organization'}</Table.Td>
      <Table.Td>
        <Badge color={flag.color} variant="light">
          {flag.text}
        </Badge>
        {runner.orphan?.removalAt ? (
          <Text size="xs" c="dimmed">
            Removable after {new Date(runner.orphan.removalAt).toLocaleString()}
          </Text>
        ) : null}
      </Table.Td>
    </Table.Tr>
  );
}

export function RunnersPanel({ runners }: { runners: RunnerData[] }) {
  const [onlyProblems, setOnlyProblems] = useState(false);
  const shown = onlyProblems ? runners.filter((r) => r.unhealthy) : runners;
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Runners ({runners.length})
          </Title>
          <Anchor
            component="button"
            type="button"
            onClick={() => setOnlyProblems(!onlyProblems)}
          >
            {onlyProblems ? 'Show all runners' : 'Show only problems'}
          </Anchor>
        </Group>
        {shown.length === 0 ? (
          <Text c="dimmed">
            GitHub lists no Fleet runners{onlyProblems ? ' with a problem' : ''}
            .
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Runner</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Node</Table.Th>
                  <Table.Th>Repository</Table.Th>
                  <Table.Th>Health</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((runner) => (
                  <RunnerRow key={runner.id} runner={runner} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Paper>
  );
}

export function PlacementPanel({ data }: { data: RunnersData }) {
  if (data.placements.length === 0) return null;
  return (
    <Paper withBorder p="lg">
      <Stack gap="xs">
        <Title order={2} size="h4">
          Placement
        </Title>
        <Text size="sm" c="dimmed">
          Repositories spread across eligible CI nodes. Each decision is
          recorded as a placement event.
        </Text>
        {data.placements.map((node) => (
          <Text key={node.nodeId} size="sm">
            <Anchor href={`/nodes/${node.nodeId}`}>{node.label}</Anchor>
            {node.eligible ? '' : ' (cordoned or disabled)'}:{' '}
            {node.repositories.join(', ') || 'no repositories'}
          </Text>
        ))}
        {data.unplaced.length > 0 ? (
          <Text size="sm" c="red">
            No eligible node for: {data.unplaced.join(', ')}
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );
}
