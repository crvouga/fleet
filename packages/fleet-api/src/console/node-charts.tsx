/** @jsxImportSource react */
import { LineChart } from '@mantine/charts';
import {
  Accordion,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import '@mantine/charts/styles.css';
import type { ConsoleState } from './model';
import type { FleetEntry } from '../ui/lib/fleet-data';
import { availability, bucketize } from '../ui/lib/series';
import { formatPercent } from '../ui/lib/format';
import { chartData, type ChartPoint } from './chart-data';
export function NodeCharts({
  state,
  entry,
}: {
  state: ConsoleState;
  entry: FleetEntry;
}) {
  const buckets = bucketize(state.points, () => null, state.fleet.now);
  const percent = availability(buckets, entry.view.firstSeenAt);
  const data = chartData(state.points, state.fleet.now);
  const series = [
    { key: 'load', title: 'Load (1 min)', color: 'indigo.5' },
    { key: 'memory', title: 'Memory used', color: 'teal.5' },
    { key: 'disk', title: 'Disk used', color: 'orange.5' },
    { key: 'cpu', title: 'CPU utilization (%)', color: 'blue.5' },
    {
      key: 'temperature',
      title: 'Highest reported sensor (°C)',
      color: 'red.5',
    },
    {
      key: 'power',
      title: 'Largest reported power domain (W)',
      color: 'yellow.5',
    },
    ...(entry.facts.slots === null
      ? []
      : [{ key: 'busy', title: 'Runner slots busy', color: 'violet.5' }]),
  ];
  return (
    <Stack gap="lg">
      <Paper withBorder p="lg">
        <Stack gap="sm">
          <Title order={2} size="h4">
            Availability, last 24 h
          </Title>
          <Text fw={700}>{formatPercent(percent)}</Text>
          <Progress
            value={percent ?? 0}
            color="teal"
            aria-label="Availability"
          />
          <Text size="xs" c="dimmed">
            Received heartbeat samples, not an uptime guarantee. History is
            bounded to 1,440 samples across the window; charts show 15-minute
            averages of those samples. Gaps mean no returned sample in that
            period.
          </Text>
        </Stack>
      </Paper>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        {series.map((metric) => (
          <MetricChart key={metric.key} metric={metric} data={data} />
        ))}
      </SimpleGrid>
      <ChartData state={state} />
    </Stack>
  );
}

function ChartData({ state }: { state: ConsoleState }) {
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
                {state.points.slice(-96).map((point) => (
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
              ['memory', 'disk', 'cpu'].includes(metric.key)
                ? { domain: [0, 100] }
                : {}
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
