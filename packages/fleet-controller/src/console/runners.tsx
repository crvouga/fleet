/** @jsxImportSource react */
import {
  Alert,
  Badge,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import { useCallback, useEffect, useState } from 'react';
import type { ConsoleState } from './model';
import { IntegrationForm } from './runners-config';
import { HealthPanel } from './runners-health';
import { readJson, type JobData, type RunnersData } from './runners-api';
import { JobsPanel, PlacementPanel, RunnersPanel } from './runners-tables';

const REFRESH_MS = 10_000;
const PAGE = 50;

function statusColor(status: string): string {
  if (status === 'ok') return 'teal';
  return status === 'degraded' ? 'yellow' : status === 'error' ? 'red' : 'gray';
}

function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <Paper withBorder p="md">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={600} size="xl">
        {value}
      </Text>
      {hint ? (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      ) : null}
    </Paper>
  );
}

function Notice({ data }: { data: RunnersData }) {
  if (!data.connection.keyConfigured) {
    return (
      <Alert color="yellow" title="No GitHub App private key">
        The controller has no GitHub App private key, so it cannot talk to
        GitHub. Set FLEET_GITHUB_APP_PRIVATE_KEY or
        FLEET_GITHUB_APP_PRIVATE_KEY_FILE in the controller's environment and
        restart it. Nothing on this page is simulated.
      </Alert>
    );
  }
  if (!data.connection.configured) {
    return (
      <Alert color="blue" title="GitHub is not connected yet">
        Save the App ID, installation ID and a repository or organization below,
        then verify the connection.
      </Alert>
    );
  }
  return data.integration.lastError ? (
    <Alert
      color={data.integration.status === 'error' ? 'red' : 'yellow'}
      title={`GitHub sync ${data.integration.status}`}
    >
      {data.integration.lastError}
    </Alert>
  ) : null;
}

function Summary({ data }: { data: RunnersData }) {
  const { capacity, integration, connection } = data;
  return (
    <Stack>
      <Group gap="sm">
        <Badge color={statusColor(integration.status)} variant="dot">
          {integration.status}
        </Badge>
        <Text size="sm" c="dimmed">
          {integration.lastSyncAt
            ? `Last sync ${new Date(integration.lastSyncAt).toLocaleString()}`
            : 'Not synced yet'}
          {connection.webhookEnabled ? ' - webhook enabled' : ' - polling only'}
          {connection.circuit && connection.circuit.state !== 'closed'
            ? ` - GitHub calls ${connection.circuit.state}`
            : ''}
        </Text>
      </Group>
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        <Tile
          label="Slots busy"
          value={`${capacity.slotsBusy} of ${capacity.slotsTotal}`}
          hint={`${capacity.nodes} CI nodes reporting`}
        />
        <Tile label="Free slots" value={String(capacity.slotsFree)} />
        <Tile label="Queued jobs" value={String(capacity.queued)} />
        <Tile label="Running jobs" value={String(capacity.inProgress)} />
        <Tile
          label="Queued, no free slot"
          value={String(capacity.waiting)}
          hint={capacity.waiting > 0 ? 'Demand exceeds capacity' : undefined}
        />
      </SimpleGrid>
    </Stack>
  );
}

function useRunners() {
  const [data, setData] = useState<RunnersData | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      readJson<RunnersData>('/v1/runners', controller.signal)
        .then((next) => {
          setData(next);
          setError('');
          setLoads((count) => count + 1);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error ? cause.message : 'Request failed.'
            );
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [version]);
  return {
    data,
    error,
    loads,
    reload: useCallback(() => setVersion((v) => v + 1), []),
  };
}

function useJobs(filter: string, version: number) {
  const [jobs, setJobs] = useState<JobData[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const query = (before?: number) =>
    `/v1/jobs?limit=${PAGE}${filter ? `&status=${filter}` : ''}${before ? `&before=${before}` : ''}`;
  useEffect(() => {
    let live = true;
    readJson<{ jobs: JobData[]; nextBefore: number | null }>(query())
      .then((page) => {
        if (!live) return;
        setJobs(page.jobs);
        setNext(page.nextBefore);
        setError('');
      })
      .catch(
        (cause: unknown) =>
          live &&
          setError(cause instanceof Error ? cause.message : 'Request failed.')
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, version]);
  async function more() {
    if (next === null) return;
    const page = await readJson<{ jobs: JobData[]; nextBefore: number | null }>(
      query(next)
    );
    setJobs((old) => [...old, ...page.jobs]);
    setNext(page.nextBefore);
  }
  return { jobs, error, more: next === null ? null : () => void more() };
}

export function Runners(_props: { state: ConsoleState }) {
  const { data, error, loads, reload } = useRunners();
  const [filter, setFilter] = useState('active');
  const jobs = useJobs(filter, loads);
  return (
    <Stack gap="lg">
      <PageHeading
        title="Runners"
        description="GitHub Actions runners, queued and finished jobs, and capacity. The GitHub App key lives only on the controller."
      />
      <ErrorNotice message={error || jobs.error} />
      {data === null ? (
        <Paper withBorder p="xl">
          <Title order={2} size="h5">
            {error ? 'Runners are unavailable' : 'Loading runners'}
          </Title>
        </Paper>
      ) : (
        <Stack gap="lg">
          <Notice data={data} />
          <Summary data={data} />
          <HealthPanel health={data.health} />
          <JobsPanel
            jobs={jobs.jobs}
            filter={filter}
            setFilter={setFilter}
            more={jobs.more}
          />
          <RunnersPanel runners={data.runners} />
          <PlacementPanel data={data} />
          <IntegrationForm
            key={data.integration.updatedAt ?? 'new'}
            value={data.integration}
            canEdit={data.access === 'admin'}
            keyConfigured={data.connection.keyConfigured}
            reload={reload}
          />
        </Stack>
      )}
    </Stack>
  );
}
