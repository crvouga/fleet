/** @jsxImportSource react */
import { Alert, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IncidentTable, type IncidentJson } from './incidents';
import { duration, type RunnersData } from './runners-api';
import { useJson } from './use-json';

const RUNNER_RULES = new Set([
  'runner_queue',
  'runners_offline',
  'runner_registration',
]);

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} size="xl">
        {value}
      </Text>
    </Paper>
  );
}

/** Queue and runner health, and the open incidents derived from it. */
export function HealthPanel({ health }: { health: RunnersData['health'] }) {
  const incidents = useJson<{ incidents: IncidentJson[] }>(
    '/v1/incidents?open=true&limit=200'
  );
  if (!health.available) return null;
  const open = (incidents.data?.incidents ?? []).filter((incident) =>
    RUNNER_RULES.has(incident.rule)
  );
  return (
    <Stack gap="sm" aria-label="Runner health">
      <Title order={2} size="h4">
        Runner health
      </Title>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Figure label="Runners online" value={String(health.runnersOnline)} />
        <Figure
          label="Queued fleet jobs"
          value={String(health.queuedFleetJobs)}
        />
        <Figure
          label="Oldest queued job"
          value={duration(health.oldestQueuedSeconds)}
        />
        <Figure
          label="Queue"
          value={health.queueStalled ? 'stalled' : 'moving'}
        />
      </SimpleGrid>
      {health.conditions.map((condition) => (
        <Alert
          key={`${condition.rule}:${condition.nodeId ?? ''}`}
          color={condition.severity === 'error' ? 'red' : 'yellow'}
          title={condition.nodeLabel ?? 'Fleet'}
        >
          {condition.message}
        </Alert>
      ))}
      {open.length > 0 ? <IncidentTable incidents={open} showNode /> : null}
    </Stack>
  );
}
