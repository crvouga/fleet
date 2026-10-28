import type { PressureSample, Telemetry, ThrottlingFamily } from '../telemetry';

import { series } from './metric-lines';

type Labels = Record<string, string>;

export const HEALTH_HELP: Record<string, string> = {
  fleet_node_metric_provenance:
    '1 for the provenance (measured, estimated or unsupported) of each reported metric family on a current sample.',
  fleet_node_gpu_utilization_percent:
    'Measured GPU utilization; unsupported GPUs are omitted.',
  fleet_node_gpu_memory_bytes: 'Measured GPU memory by state.',
  fleet_node_gpu_temperature_celsius: 'Measured GPU temperature.',
  fleet_node_gpu_power_watts: 'Measured GPU power draw.',
  fleet_node_disk_io_bytes_per_second:
    'Measured whole-disk throughput by direction; omitted until a second sample.',
  fleet_node_disk_io_ops_per_second:
    'Measured whole-disk operations per second.',
  fleet_node_disk_busy_percent:
    'Share of the sample interval a whole disk spent servicing I/O.',
  fleet_node_disk_health_state:
    'Disk health: 0 ok, 1 warning, 2 failing. Unknown health is omitted.',
  fleet_node_disk_temperature_celsius:
    'Disk temperature from SMART or the kernel.',
  fleet_node_disk_wear_percent:
    'Endurance used, from SMART; omitted when unreported.',
  fleet_node_cpu_frequency_mhz:
    'Measured CPU frequency (mean current, minimum, maximum).',
  fleet_node_cpu_throttled:
    '1 when the CPU is throttled. provenance is measured for kernel counters, estimated for frequency inference.',
  fleet_node_cpu_throttle_events:
    'Thermal throttle events counted since the previous sample.',
  fleet_node_pressure_percent:
    'Pressure stall information: percent of time tasks were stalled.',
  fleet_node_network_errors_since_last_sample:
    'Interface errors counted since the previous sample; omitted when unknown.',
  fleet_node_network_dropped_since_last_sample:
    'Interface drops counted since the previous sample; omitted when unknown.',
  fleet_node_controller_latency_ms:
    'The node-measured round trip of its previous heartbeat to the controller.',
  fleet_node_heartbeat_consecutive_failures:
    'Heartbeats the node failed to deliver before this one.',
  fleet_node_uptime_seconds: 'Node uptime from its last current sample.',
  fleet_node_restarts_observed:
    'Restarts the node agent has observed since it began tracking.',
};

function provenance(sample: Telemetry, labels: Labels): string[] {
  const families = {
    gpus: sample.gpus,
    disk_io: sample.diskIo,
    disk_health: sample.diskHealth,
    cpu_frequency: sample.cpuFrequency,
    throttling: sample.throttling,
    pressure: sample.pressure,
    connectivity: sample.connectivity,
  };
  return Object.entries(families).flatMap(([family, value]) =>
    value === undefined
      ? []
      : series('fleet_node_metric_provenance', 1, {
          ...labels,
          family,
          provenance: value.status,
        })
  );
}

function gpuMetrics(sample: Telemetry, labels: Labels): string[] {
  if (!sample.gpus || sample.gpus.status === 'unsupported') return [];
  return sample.gpus.devices.flatMap((gpu) => {
    const at = { ...labels, gpu: gpu.name, vendor: gpu.vendor };
    return [
      ...series(
        'fleet_node_gpu_utilization_percent',
        gpu.utilizationPercent,
        at
      ),
      ...series('fleet_node_gpu_memory_bytes', gpu.memoryUsedBytes, {
        ...at,
        state: 'used',
      }),
      ...series('fleet_node_gpu_memory_bytes', gpu.memoryTotalBytes, {
        ...at,
        state: 'total',
      }),
      ...series(
        'fleet_node_gpu_temperature_celsius',
        gpu.temperatureCelsius,
        at
      ),
      ...series('fleet_node_gpu_power_watts', gpu.powerWatts, at),
    ];
  });
}

function diskIoMetrics(sample: Telemetry, labels: Labels): string[] {
  if (!sample.diskIo || sample.diskIo.status === 'unsupported') return [];
  return sample.diskIo.devices.flatMap((disk) => {
    const at = { ...labels, device: disk.name };
    return [
      ...series(
        'fleet_node_disk_io_bytes_per_second',
        disk.readBytesPerSecond,
        {
          ...at,
          direction: 'read',
        }
      ),
      ...series(
        'fleet_node_disk_io_bytes_per_second',
        disk.writeBytesPerSecond,
        {
          ...at,
          direction: 'write',
        }
      ),
      ...series('fleet_node_disk_io_ops_per_second', disk.iops, at),
      ...series('fleet_node_disk_busy_percent', disk.busyPercent, at),
    ];
  });
}

const HEALTH_LEVEL = { ok: 0, warning: 1, failing: 2 } as const;

function diskHealthMetrics(sample: Telemetry, labels: Labels): string[] {
  if (!sample.diskHealth || sample.diskHealth.status === 'unsupported')
    return [];
  return sample.diskHealth.devices.flatMap((disk) => {
    const at = { ...labels, device: disk.name, source: disk.source };
    return [
      ...series(
        'fleet_node_disk_health_state',
        disk.state === 'unknown' ? null : HEALTH_LEVEL[disk.state],
        at
      ),
      ...series(
        'fleet_node_disk_temperature_celsius',
        disk.temperatureCelsius,
        at
      ),
      ...series('fleet_node_disk_wear_percent', disk.wearPercent, at),
    ];
  });
}

function cpuMetrics(sample: Telemetry, labels: Labels): string[] {
  const frequency =
    sample.cpuFrequency && sample.cpuFrequency.status !== 'unsupported'
      ? Object.entries({
          current: sample.cpuFrequency.currentMHz,
          min: sample.cpuFrequency.minMHz,
          max: sample.cpuFrequency.maxMHz,
        }).flatMap(([state, value]) =>
          series('fleet_node_cpu_frequency_mhz', value, { ...labels, state })
        )
      : [];
  return [...frequency, ...throttleMetrics(sample.throttling, labels)];
}

function throttleMetrics(
  family: ThrottlingFamily | undefined,
  labels: Labels
): string[] {
  if (!family || family.status === 'unsupported' || family.throttled === null)
    return [];
  const at = {
    ...labels,
    provenance: family.status,
    basis: family.basis ?? 'unknown',
  };
  return [
    ...series('fleet_node_cpu_throttled', family.throttled ? 1 : 0, at),
    ...series('fleet_node_cpu_throttle_events', family.events, at),
  ];
}

function pressureLines(
  resource: string,
  value: PressureSample | null,
  labels: Labels
): string[] {
  if (value === null) return [];
  return Object.entries({
    'some:10': value.someAvg10,
    'some:60': value.someAvg60,
    'full:10': value.fullAvg10,
    'full:60': value.fullAvg60,
  }).flatMap(([key, percent]) => {
    const [kind = '', window = ''] = key.split(':');
    return series('fleet_node_pressure_percent', percent, {
      ...labels,
      resource,
      kind,
      window,
    });
  });
}

function pressureMetrics(sample: Telemetry, labels: Labels): string[] {
  const { pressure } = sample;
  if (!pressure || pressure.status === 'unsupported') return [];
  return [
    ...pressureLines('cpu', pressure.cpu, labels),
    ...pressureLines('memory', pressure.memory, labels),
    ...pressureLines('io', pressure.io, labels),
  ];
}

function networkErrorMetrics(sample: Telemetry, labels: Labels): string[] {
  return sample.network.flatMap((item) => {
    const at = { ...labels, interface: item.name };
    return [
      ...series(
        'fleet_node_network_errors_since_last_sample',
        item.receiveErrors ?? null,
        { ...at, direction: 'receive' }
      ),
      ...series(
        'fleet_node_network_errors_since_last_sample',
        item.transmitErrors ?? null,
        { ...at, direction: 'transmit' }
      ),
      ...series(
        'fleet_node_network_dropped_since_last_sample',
        item.receiveDropped ?? null,
        { ...at, direction: 'receive' }
      ),
      ...series(
        'fleet_node_network_dropped_since_last_sample',
        item.transmitDropped ?? null,
        { ...at, direction: 'transmit' }
      ),
    ];
  });
}

function nodeMetrics(sample: Telemetry, labels: Labels): string[] {
  const { connectivity, lifecycle } = sample;
  return [
    ...(connectivity && connectivity.status !== 'unsupported'
      ? [
          ...series(
            'fleet_node_controller_latency_ms',
            connectivity.controllerLatencyMs,
            labels
          ),
          ...series(
            'fleet_node_heartbeat_consecutive_failures',
            connectivity.consecutiveFailures,
            labels
          ),
        ]
      : []),
    ...series(
      'fleet_node_uptime_seconds',
      lifecycle?.uptimeSeconds ?? null,
      labels
    ),
    ...series(
      'fleet_node_restarts_observed',
      lifecycle?.restartCount ?? null,
      labels
    ),
  ];
}

/**
 * The health families of one current sample. The caller only passes fresh
 * samples; unsupported families and unknown values are omitted, never zero.
 */
export function healthMetrics(sample: Telemetry, labels: Labels): string[] {
  return [
    ...provenance(sample, labels),
    ...gpuMetrics(sample, labels),
    ...diskIoMetrics(sample, labels),
    ...diskHealthMetrics(sample, labels),
    ...cpuMetrics(sample, labels),
    ...pressureMetrics(sample, labels),
    ...networkErrorMetrics(sample, labels),
    ...nodeMetrics(sample, labels),
  ];
}
