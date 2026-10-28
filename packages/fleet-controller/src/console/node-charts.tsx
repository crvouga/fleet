/** @jsxImportSource react */
import { LineChart } from '@mantine/charts';
import {
  Accordion,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import '@mantine/charts/styles.css';
import type { ConsoleState } from './model';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { availability, bucketizeWindow } from '../ui/lib/series';
import type { HeartbeatPoint } from '../types';
import { formatPercent } from '../ui/lib/format';
import { chartData, type ChartPoint } from './chart-data';
import { useJson } from './use-json';
const WINDOWS = [
  { value: '24', label: '24 hours' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
];

/** Metric charts for a window; 7 and 30 days come from the bounded history endpoint. */
export function NodeCharts({
  state,
  entry,
}: {
  state: ConsoleState;
  entry: FleetEntry;
}) {
  const [hours, setHours] = useState('24');
  return (
    <Stack gap="lg">
      <SegmentedControl
        data={WINDOWS}
        value={hours}
        onChange={setHours}
        aria-label="History window"
      />
      {hours === '24' ? (
        <ChartsFor
          points={state.points}
          entry={entry}
          now={state.fleet.now}
          hours={24}
        />
      ) : (
        <LongHistory state={state} entry={entry} hours={Number(hours)} />
      )}
    </Stack>
  );
}

function LongHistory({
  state,
  entry,
  hours,
}: {
  state: ConsoleState;
  entry: FleetEntry;
  hours: number;
}) {
  const history = useJson<{ heartbeats: HeartbeatPoint[] }>(
    `/v1/nodes/${entry.view.id}/history?hours=${hours}`
  );
  if (!history.data)
    return (
      <Text c="dimmed" size="sm">
        {history.error || 'Loading history…'}
      </Text>
    );
  return (
    <ChartsFor
      points={history.data.heartbeats}
      entry={entry}
      now={state.fleet.now}
      hours={hours}
    />
  );
}

const SERIES = [
  { key: 'load', title: 'Load (1 min)', color: 'indigo.5' },
  { key: 'memory', title: 'Memory used', color: 'teal.5' },
  { key: 'disk', title: 'Disk used', color: 'orange.5' },
  { key: 'cpu', title: 'CPU utilization (%)', color: 'blue.5' },
  { key: 'temperature', title: 'Highest reported sensor (°C)', color: 'red.5' },
  {
    key: 'power',
    title: 'Largest reported power domain (W)',
    color: 'yellow.5',
  },
  { key: 'gpuUtilization', title: 'GPU utilization (%)', color: 'grape.5' },
  { key: 'gpuTemperature', title: 'Hottest GPU (°C)', color: 'pink.5' },
  { key: 'diskBusy', title: 'Busiest disk (%)', color: 'cyan.5' },
  {
    key: 'memoryPressure',
    title: 'Memory pressure, 60 s (%)',
    color: 'lime.5',
  },
];
const PERCENT_SERIES = [
  'memory',
  'disk',
  'cpu',
  'gpuUtilization',
  'diskBusy',
  'memoryPressure',
];

function ChartsFor({
  points,
  entry,
  now,
  hours,
}: {
  points: readonly HeartbeatPoint[];
  entry: FleetEntry;
  now: Date;
  hours: number;
}) {
  const buckets = bucketizeWindow(points, () => null, {
    end: now,
    windowHours: hours,
  });
  const percent = availability(buckets, entry.view.firstSeenAt);
  const data = chartData(points, now, hours);
  const series = [
    ...SERIES,
    ...(entry.facts.slots === null
      ? []
      : [{ key: 'busy', title: 'Runner slots busy', color: 'violet.5' }]),
  ];
  return (
    <Stack gap="lg">
      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Title order={2} size="h4">
            Availability, last {hours === 24 ? '24 h' : `${hours / 24} days`}
          </Title>
          <Text fw={700}>{formatPercent(percent)}</Text>
          <Progress
            value={percent ?? 0}
            color="teal"
            aria-label="Availability"
          />
          <Text size="xs" c="dimmed">
            Received heartbeat samples, not an uptime guarantee. History is
            bounded to 1,440 samples across the window and kept for the
            configured retention (30 days by default); charts show averages of
            those samples in time buckets. Gaps mean no returned sample in that
            period. Metrics a node does not support are left blank, never drawn
            as zero.
          </Text>
        </Stack>
      </Paper>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {series.map((metric) => (
          <MetricChart key={metric.key} metric={metric} data={data} />
        ))}
      </SimpleGrid>
      <ChartData points={points} />
    </Stack>
  );
}

function ChartData({ points }: { points: readonly HeartbeatPoint[] }) {
  return (
    <Accordion variant="separated">
      <Accordion.Item value="data">
        <Accordion.Control>Show data</Accordion.Control>
        <Accordion.Panel>
          <Table.ScrollContainer minWidth={500}>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  {['Time', 'Load', 'Memory %', 'Disk %', 'Busy slots'].map(
                    (label) => (
                      <Table.Th key={label}>{label}</Table.Th>
                    )
                  )}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {points.slice(-96).map((point) => (
                  <Table.Tr key={point.at.toISOString()}>
                    <Table.Td>{point.at.toLocaleString()}</Table.Td>
                    {[
                      point.load1,
                      point.memUsedPercent,
                      point.diskPercent,
                      point.busySlots,
                    ].map((value, index) => (
                      <Table.Td key={index}>{value ?? '—'}</Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function MetricChart({
  metric,
  data,
}: {
  metric: { key: string; title: string; color: string };
  data: ChartPoint[];
}) {
  return (
    <Paper withBorder p="lg" key={metric.key}>
      <Stack>
        <Title order={3} size="h5">
          {metric.title}
        </Title>
        {data.some(
          (point) =>
            typeof (point as unknown as Record<string, unknown>)[metric.key] ===
            'number'
        ) ? (
          <LineChart
            h={200}
            data={data}
            dataKey="time"
            series={[
              {
                name: metric.key,
                label: metric.title,
                color: metric.color,
              },
            ]}
            curveType="linear"
            yAxisProps={
              PERCENT_SERIES.includes(metric.key) ? { domain: [0, 100] } : {}
            }
            connectNulls={false}
            withDots={false}
          />
        ) : (
          <Text c="dimmed" size="sm" py="xl">
            No measurements reported in this window.
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
