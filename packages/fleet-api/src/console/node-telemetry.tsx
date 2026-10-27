/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import type { Telemetry } from '../telemetry';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { runLink, telemetryFresh } from '../ui/lib/telemetry';
import { TelemetryResources } from './telemetry-resources';
import { TelemetryTable } from './telemetry-table';

export function NodeTelemetry({
  entry,
  now,
}: {
  entry: FleetEntry;
  now: Date;
}) {
  const sample = entry.facts.telemetry;
  if (!sample)
    return (
      <Alert title="Hardware telemetry unavailable" color="orange">
        This agent has not reported extended telemetry. Memory, load and disk
        figures above retain their existing heartbeat history.
      </Alert>
    );
  return (
    <Stack>
      <TelemetryHeader entry={entry} now={now} />
      <TelemetryResources sample={sample} />
      <RunnerActivity sample={sample} />
      <TelemetryTable
        title="Service diagnostics"
        columns={['Time', 'Source', 'Level', 'Summary']}
        rows={sample.logs.map((item) => [
          new Date(item.at).toLocaleString(),
          item.source,
          item.level,
          item.message,
        ])}
        empty="No retained diagnostic summaries. This is not evidence that all services are healthy."
      />
      <Text size="xs" c="dimmed">
        Only bounded service and runner lifecycle summaries are collected. Raw
        job output and credentials are not uploaded to Fleet.
      </Text>
    </Stack>
  );
}

function TelemetryHeader({ entry, now }: { entry: FleetEntry; now: Date }) {
  const sample = entry.facts.telemetry!;
  const fresh = telemetryFresh(entry, now);
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Group justify="space-between">
          <Title order={2} size="h4">
            Hardware and runner telemetry
          </Title>
          <Badge color={fresh ? 'teal' : 'orange'}>
            {fresh ? 'Current sample' : 'Stale sample'}
          </Badge>
        </Group>
        <Text size="sm">
          Sampled {new Date(sample.sampledAt).toLocaleString()}.{' '}
          {fresh
            ? 'Metrics describe the last received sample.'
            : 'These historical values do not describe current usage or running jobs.'}
        </Text>
        <Text>
          CPU utilization:{' '}
          {sample.cpuUsagePercent === null
            ? 'Sampling / unavailable'
            : `${sample.cpuUsagePercent.toFixed(1)}%`}
        </Text>
        <Text>
          Memory:{' '}
          {entry.facts.memAvailableMiB === null
            ? 'Unavailable'
            : `${entry.facts.memAvailableMiB.toLocaleString()} MiB available`}{' '}
          /{' '}
          {entry.facts.memTotalMiB === null
            ? 'Unavailable'
            : `${entry.facts.memTotalMiB.toLocaleString()} MiB total`}
        </Text>
        {sample.issues.map((issue, index) => (
          <Alert key={index} color="orange">
            {issue}
          </Alert>
        ))}
      </Stack>
    </Paper>
  );
}

function RunnerActivity({ sample }: { sample: Telemetry }) {
  return (
    <>
      <TelemetryTable
        title="Runner activity"
        columns={[
          'Slot',
          'State',
          'Repository / run',
          'Job',
          'Started',
          'Finished',
          'Hook result',
        ]}
        rows={sample.runnerSlots.map((slot) => {
          const href = runLink(slot.repository, slot.runId);
          return [
            slot.slot,
            slot.state,
            href ? (
              <Anchor href={href} target="_blank" rel="noreferrer">
                {slot.repository} #{slot.runId}
              </Anchor>
            ) : (
              (slot.repository ?? 'Unavailable')
            ),
            slot.jobName,
            slot.startedAt ? new Date(slot.startedAt).toLocaleString() : null,
            slot.finishedAt ? new Date(slot.finishedAt).toLocaleString() : null,
            slot.result,
          ];
        })}
      />
      <Text size="xs" c="dimmed">
        Runner hooks report lifecycle, not a verified job outcome. Open the
        GitHub run for its authoritative status and authenticated job logs.
      </Text>
    </>
  );
}
