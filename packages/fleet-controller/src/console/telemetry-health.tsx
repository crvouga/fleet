/** @jsxImportSource react */
import { Badge, SimpleGrid, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { DiskHealthSample, FamilyBase, Telemetry } from '../telemetry';
import {
  bytes,
  measured,
  perSecond,
  provenanceBadge,
  type ProvenanceBadge,
} from '../ui/lib/telemetry';
import { TelemetryTable } from './telemetry-table';

const COLOR: Record<ProvenanceBadge, string> = {
  measured: 'teal',
  estimated: 'yellow',
  unsupported: 'gray',
  stale: 'orange',
};

/** Measured, estimated, unsupported or stale, in words and color. */
export function ProvenanceTag({
  status,
  stale,
}: {
  status: FamilyBase['status'];
  stale: boolean;
}) {
  const label = provenanceBadge(status, stale);
  return (
    <Badge color={COLOR[label]} variant="light" data-provenance={label}>
      {label}
    </Badge>
  );
}

function FamilyTable({
  title,
  family,
  stale,
  columns,
  rows,
}: {
  title: string;
  family: FamilyBase | undefined;
  stale: boolean;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  if (!family)
    return (
      <TelemetryTable
        title={title}
        columns={columns}
        rows={[]}
        empty="Not reported by this agent."
      />
    );
  const unsupported = family.status === 'unsupported';
  return (
    <TelemetryTable
      title={title}
      columns={columns}
      rows={unsupported ? [] : rows}
      badge={<ProvenanceTag status={family.status} stale={stale} />}
      empty={family.reason ?? 'Unsupported on this node.'}
      note={unsupported ? null : family.reason}
    />
  );
}

function healthText(device: DiskHealthSample): string {
  const wear =
    device.wearPercent === null ? '' : ` · ${device.wearPercent}% worn`;
  return `${device.state}${wear}${device.detail ? ` · ${device.detail}` : ''}`;
}

function GpuAndDisks({ sample, stale }: Props) {
  const { gpus, diskIo, diskHealth } = sample;
  return (
    <Stack>
      <FamilyTable
        title="GPU"
        family={gpus}
        stale={stale}
        columns={['GPU', 'Utilization', 'Memory', 'Temperature', 'Power']}
        rows={(gpus?.devices ?? []).map((gpu) => [
          `${gpu.name} (${gpu.vendor})`,
          measured(gpu.utilizationPercent, '%'),
          gpu.memoryUsedBytes === null || gpu.memoryTotalBytes === null
            ? null
            : `${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}`,
          measured(gpu.temperatureCelsius, ' °C'),
          measured(gpu.powerWatts, ' W'),
        ])}
      />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <FamilyTable
          title="Disk I/O"
          family={diskIo}
          stale={stale}
          columns={['Disk', 'Read', 'Write', 'Ops', 'Busy']}
          rows={(diskIo?.devices ?? []).map((disk) => [
            disk.name,
            perSecond(disk.readBytesPerSecond),
            perSecond(disk.writeBytesPerSecond),
            measured(disk.iops, '/s'),
            measured(disk.busyPercent, '%'),
          ])}
        />
        <FamilyTable
          title="Disk health"
          family={diskHealth}
          stale={stale}
          columns={['Disk', 'Health', 'Temperature', 'Source']}
          rows={(diskHealth?.devices ?? []).map((disk) => [
            disk.name,
            healthText(disk),
            measured(disk.temperatureCelsius, ' °C'),
            disk.source,
          ])}
        />
      </SimpleGrid>
    </Stack>
  );
}

function frequencyRows(
  family: Telemetry['cpuFrequency']
): readonly (readonly ReactNode[])[] {
  return family
    ? [
        [
          measured(family.currentMHz, ' MHz'),
          measured(family.minMHz, ' MHz'),
          measured(family.maxMHz, ' MHz'),
        ],
      ]
    : [];
}

function throttleRows(
  family: Telemetry['throttling']
): readonly (readonly ReactNode[])[] {
  if (!family) return [];
  const throttled =
    family.throttled === null ? null : family.throttled ? 'Yes' : 'No';
  return [
    [
      throttled,
      family.events === null ? null : String(family.events),
      family.basis,
    ],
  ];
}

function pressureRows(
  family: Telemetry['pressure']
): readonly (readonly ReactNode[])[] {
  if (!family) return [];
  const lines = [
    ['CPU', family.cpu],
    ['Memory', family.memory],
    ['I/O', family.io],
  ] as const;
  return lines.flatMap(([name, line]) =>
    line
      ? [
          [
            name,
            measured(line.someAvg10, '%'),
            measured(line.someAvg60, '%'),
            measured(line.fullAvg10, '%'),
            measured(line.fullAvg60, '%'),
          ],
        ]
      : []
  );
}

function CpuAndPressure({ sample, stale }: Props) {
  const { cpuFrequency, throttling, pressure } = sample;
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }}>
      <FamilyTable
        title="CPU frequency"
        family={cpuFrequency}
        stale={stale}
        columns={['Current (mean)', 'Minimum', 'Maximum']}
        rows={frequencyRows(cpuFrequency)}
      />
      <FamilyTable
        title="Throttling"
        family={throttling}
        stale={stale}
        columns={['Throttled', 'Events since last sample', 'Basis']}
        rows={throttleRows(throttling)}
      />
      <FamilyTable
        title="Pressure (PSI)"
        family={pressure}
        stale={stale}
        columns={[
          'Resource',
          'Some 10 s',
          'Some 60 s',
          'Full 10 s',
          'Full 60 s',
        ]}
        rows={pressureRows(pressure)}
      />
    </SimpleGrid>
  );
}

function Connectivity({ sample, stale }: Props) {
  const { connectivity, lifecycle, network } = sample;
  return (
    <Stack>
      <FamilyTable
        title="Controller connectivity"
        family={connectivity}
        stale={stale}
        columns={['Heartbeat round trip', 'Consecutive failures']}
        rows={
          connectivity
            ? [
                [
                  measured(connectivity.controllerLatencyMs, ' ms'),
                  connectivity.consecutiveFailures === null
                    ? null
                    : String(connectivity.consecutiveFailures),
                ],
              ]
            : []
        }
      />
      <TelemetryTable
        title="Network errors since the last sample"
        columns={[
          'Interface',
          'Receive errors',
          'Transmit errors',
          'Receive drops',
          'Transmit drops',
        ]}
        rows={network
          .filter((item) => item.receiveErrors !== undefined)
          .map((item) => [
            item.name,
            measured(item.receiveErrors, ''),
            measured(item.transmitErrors, ''),
            measured(item.receiveDropped, ''),
            measured(item.transmitDropped, ''),
          ])}
        empty="Not reported by this agent."
      />
      {lifecycle ? (
        <Text size="sm">
          Restarts observed by the agent:{' '}
          {lifecycle.restartCount === null
            ? 'unavailable'
            : lifecycle.restartCount}
          {lifecycle.trackedSince
            ? ` since ${new Date(lifecycle.trackedSince).toLocaleString()}`
            : ''}
          .
        </Text>
      ) : null}
    </Stack>
  );
}

interface Props {
  sample: Telemetry;
  stale: boolean;
}

/** Families beyond CPU, memory and temperature, each labelled with its provenance. */
export function TelemetryHealth(props: Props) {
  return (
    <Stack>
      <GpuAndDisks {...props} />
      <CpuAndPressure {...props} />
      <Connectivity {...props} />
    </Stack>
  );
}
