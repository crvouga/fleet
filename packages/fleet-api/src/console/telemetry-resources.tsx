/** @jsxImportSource react */
import { SimpleGrid, Stack, Text } from '@mantine/core';
import type { Telemetry } from '../telemetry';
import { bytes } from '../ui/lib/telemetry';
import { TelemetryTable } from './telemetry-table';
export function TelemetryResources({ sample }: { sample: Telemetry }) {
  return (
    <Stack>
      <TelemetryTable
        title="Storage"
        columns={['Mount', 'Used', 'Available', 'Total']}
        rows={sample.filesystems.map((item) => [
          item.mount,
          bytes(item.usedBytes),
          bytes(item.availableBytes),
          bytes(item.totalBytes),
        ])}
      />
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <TelemetryTable
          title="Temperature sensors"
          columns={['Sensor', 'Temperature']}
          rows={sample.temperatures.map((item) => [
            item.name,
            `${item.celsius.toFixed(1)} °C`,
          ])}
        />
        <TelemetryTable
          title="Power measurements"
          columns={['Domain', 'Power', 'Source']}
          rows={sample.power.map((item) => [
            item.name,
            `${item.watts.toFixed(2)} W`,
            item.source,
          ])}
        />
      </SimpleGrid>
      <Text size="xs" c="dimmed">
        Power values describe reported hardware domains and may overlap. They do
        not establish whole-machine or wall power. Missing sensors are
        unavailable, never zero.
      </Text>
      <TelemetryTable
        title="Network interfaces"
        columns={[
          'Interface',
          'Received',
          'Transmitted',
          'Receive rate',
          'Transmit rate',
        ]}
        rows={sample.network.map((item) => [
          item.name,
          bytes(item.receivedBytes),
          bytes(item.transmittedBytes),
          item.receiveBytesPerSecond === null
            ? 'Sampling / unavailable'
            : `${bytes(item.receiveBytesPerSecond)}/s`,
          item.transmitBytesPerSecond === null
            ? 'Sampling / unavailable'
            : `${bytes(item.transmitBytesPerSecond)}/s`,
        ])}
      />
      <TelemetryTable
        title="Swap"
        columns={['Used', 'Total']}
        rows={
          sample.swap
            ? [[bytes(sample.swap.usedBytes), bytes(sample.swap.totalBytes)]]
            : []
        }
      />
    </Stack>
  );
}
