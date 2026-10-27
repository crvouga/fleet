import type { NodeView } from '../types';
import { readFacts, type NodeFacts } from '../ui/lib/facts';
import type { Telemetry } from '../telemetry';
import { sampleIsFresh } from '../domain/telemetry-validation';
import { integrationReady } from '../domain/readiness';

function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
function series(
  name: string,
  value: number | null,
  labels: Record<string, string>
): string[] {
  return value === null
    ? []
    : [
        `${name}{${Object.entries(labels)
          .map(([key, text]) => `${key}=${quoted(text)}`)
          .join(',')}} ${value}`,
      ];
}
function capacityMetrics(
  facts: NodeFacts,
  labels: Record<string, string>
): string[] {
  const mib = (value: number | null) =>
    value === null ? null : value * 1048576;
  return [
    ...series('fleet_node_memory_bytes', mib(facts.memTotalMiB), {
      ...labels,
      state: 'total',
    }),
    ...series('fleet_node_memory_bytes', mib(facts.memAvailableMiB), {
      ...labels,
      state: 'available',
    }),
    ...series('fleet_node_runner_slots', facts.slots, {
      ...labels,
      state: 'total',
    }),
    ...series('fleet_node_runner_slots', facts.busySlots, {
      ...labels,
      state: 'busy',
    }),
  ];
}
function sensorMetrics(
  sample: Telemetry,
  labels: Record<string, string>
): string[] {
  return [
    ...series('fleet_node_cpu_usage_percent', sample.cpuUsagePercent, labels),
    ...sample.temperatures.flatMap((item) =>
      series('fleet_node_temperature_celsius', item.celsius, {
        ...labels,
        sensor: item.name,
      })
    ),
    ...sample.power.flatMap((item) =>
      series('fleet_node_power_watts', item.watts, {
        ...labels,
        sensor: item.name,
        source: item.source,
      })
    ),
    ...sample.filesystems.flatMap((item) =>
      Object.entries({
        total: item.totalBytes,
        used: item.usedBytes,
        available: item.availableBytes,
      }).flatMap(([state, value]) =>
        series('fleet_node_filesystem_bytes', value, {
          ...labels,
          mount: item.mount,
          state,
        })
      )
    ),
    ...Object.entries(sample.swap ?? {}).flatMap(([state, value]) =>
      series('fleet_node_swap_bytes', value, {
        ...labels,
        state: state.replace('Bytes', ''),
      })
    ),
    ...networkMetrics(sample, labels),
  ];
}
function networkMetrics(
  sample: Telemetry,
  labels: Record<string, string>
): string[] {
  return sample.network.flatMap((item) => [
    ...series(
      'fleet_node_network_bytes_per_second',
      item.receiveBytesPerSecond,
      { ...labels, interface: item.name, direction: 'receive' }
    ),
    ...series(
      'fleet_node_network_bytes_per_second',
      item.transmitBytesPerSecond,
      { ...labels, interface: item.name, direction: 'transmit' }
    ),
    ...series('fleet_node_network_received_bytes', item.receivedBytes, {
      ...labels,
      interface: item.name,
    }),
    ...series('fleet_node_network_transmitted_bytes', item.transmittedBytes, {
      ...labels,
      interface: item.name,
    }),
  ]);
}
function nodeMetrics(view: NodeView, now: Date): string[] {
  const facts = readFacts(view);
  const sample = facts.telemetry;
  const labels = { node: view.hostname, node_id: view.id, role: view.role };
  const online = view.status === 'online';
  const fresh =
    online &&
    sample !== null &&
    sampleIsFresh(sample, now, view.heartbeatIntervalSeconds);
  const lines = [
    ...series('fleet_node_telemetry_fresh', fresh ? 1 : 0, labels),
    ...series(
      'fleet_node_ready',
      integrationReady(view, facts) ? 1 : 0,
      labels
    ),
  ];
  if (online) lines.push(...capacityMetrics(facts, labels));
  if (fresh && sample) lines.push(...sensorMetrics(sample, labels));
  return lines;
}
export function resourceMetrics(
  views: readonly NodeView[],
  now: Date
): string[] {
  const help: Record<string, string> = {
    fleet_node_telemetry_fresh:
      '1 only for a current hardware sample on an online approved node.',
    fleet_node_ready:
      '1 only for a current approved node with reported integration checks passing.',
    fleet_node_memory_bytes: 'Last reported memory capacity on an online node.',
    fleet_node_runner_slots:
      'Reported runner capacity and jobs busy on an online node.',
    fleet_node_cpu_usage_percent:
      'Measured CPU utilization; omitted until sampled.',
    fleet_node_filesystem_bytes: 'Filesystem bytes by mount and state.',
    fleet_node_temperature_celsius:
      'Reported sensor temperatures; unavailable sensors are omitted.',
    fleet_node_power_watts:
      'Reported power domain measurement, not whole-machine power.',
    fleet_node_network_bytes_per_second:
      'Sampled interface traffic; unknown rates are omitted.',
    fleet_node_network_received_bytes:
      'Cumulative received bytes on the reported interface.',
    fleet_node_network_transmitted_bytes:
      'Cumulative transmitted bytes on the reported interface.',
    fleet_node_swap_bytes: 'Reported swap bytes by state.',
  };
  return [
    ...Object.entries(help).flatMap(([name, text]) => [
      `# HELP ${name} ${text}`,
      `# TYPE ${name} gauge`,
    ]),
    ...views
      .filter((view) => view.approval === 'approved')
      .flatMap((view) => nodeMetrics(view, now)),
  ];
}
