import type { Child } from 'hono/jsx';

import type { DiskHealthSample, FamilyBase, Telemetry } from '../../telemetry';
import { cx } from '../lib/tw';
import {
  bytes,
  measured,
  perSecond,
  provenanceBadge,
  type ProvenanceBadge,
} from '../lib/telemetry';

const BADGE_TONE: Record<ProvenanceBadge, string> = {
  measured: 'text-ok',
  estimated: 'text-warn',
  unsupported: 'text-fg-3',
  stale: 'text-warn',
};

/** The provenance in words, never color alone. */
export function Provenance(props: {
  status: FamilyBase['status'];
  stale: boolean;
}) {
  const label = provenanceBadge(props.status, props.stale);
  return (
    <span class={cx('chip', BADGE_TONE[label])} data-provenance={label}>
      {label}
    </span>
  );
}

export function SampleTable(props: {
  title: string;
  headings: string[];
  rows: Child[][];
  badge?: Child;
  empty?: string;
}) {
  return (
    <section>
      <h3 class="mt-4 flex items-center gap-2 font-semibold">
        {props.title}
        {props.badge ?? null}
      </h3>
      {props.rows.length ? (
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr>
                {props.headings.map((name) => (
                  <th key={name} class="p-2">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((value, cell) => (
                    <td key={cell} class="p-2">
                      {value ?? 'Unavailable'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="text-sm text-fg-3">
          {props.empty ?? 'No measurements reported.'}
        </p>
      )}
    </section>
  );
}

/** A family's table, its provenance badge and, when it is not a plain measurement, why. */
function Family(props: {
  title: string;
  family: (FamilyBase & { readonly devices?: readonly unknown[] }) | undefined;
  stale: boolean;
  headings: string[];
  rows: Child[][];
}) {
  const { family } = props;
  if (!family)
    return (
      <SampleTable
        title={props.title}
        headings={props.headings}
        rows={[]}
        empty="Not reported by this agent."
      />
    );
  return (
    <div>
      <SampleTable
        title={props.title}
        headings={props.headings}
        rows={family.status === 'unsupported' ? [] : props.rows}
        badge={<Provenance status={family.status} stale={props.stale} />}
        empty={family.reason ?? 'Unsupported on this node.'}
      />
      {family.reason && family.status !== 'unsupported' ? (
        <p class="text-xs text-fg-3">{family.reason}</p>
      ) : null}
    </div>
  );
}

function healthText(device: DiskHealthSample): string {
  const wear =
    device.wearPercent === null ? '' : ` · ${device.wearPercent}% worn`;
  return `${device.state}${wear}${device.detail ? ` · ${device.detail}` : ''}`;
}

function Gpus(props: { sample: Telemetry; stale: boolean }) {
  const family = props.sample.gpus;
  return (
    <Family
      title="GPU"
      family={family}
      stale={props.stale}
      headings={['GPU', 'Utilization', 'Memory', 'Temperature', 'Power']}
      rows={(family?.devices ?? []).map((gpu) => [
        `${gpu.name} (${gpu.vendor})`,
        measured(gpu.utilizationPercent, '%'),
        gpu.memoryUsedBytes === null || gpu.memoryTotalBytes === null
          ? null
          : `${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}`,
        measured(gpu.temperatureCelsius, ' °C'),
        measured(gpu.powerWatts, ' W'),
      ])}
    />
  );
}

function Disks(props: { sample: Telemetry; stale: boolean }) {
  const { diskIo, diskHealth } = props.sample;
  return (
    <>
      <Family
        title="Disk I/O"
        family={diskIo}
        stale={props.stale}
        headings={['Disk', 'Read', 'Write', 'Operations', 'Busy']}
        rows={(diskIo?.devices ?? []).map((disk) => [
          disk.name,
          perSecond(disk.readBytesPerSecond),
          perSecond(disk.writeBytesPerSecond),
          measured(disk.iops, '/s'),
          measured(disk.busyPercent, '%'),
        ])}
      />
      <Family
        title="Disk health"
        family={diskHealth}
        stale={props.stale}
        headings={['Disk', 'Health', 'Temperature', 'Source']}
        rows={(diskHealth?.devices ?? []).map((disk) => [
          disk.name,
          healthText(disk),
          measured(disk.temperatureCelsius, ' °C'),
          disk.source,
        ])}
      />
    </>
  );
}

function Cpu(props: { sample: Telemetry; stale: boolean }) {
  const { cpuFrequency, throttling } = props.sample;
  return (
    <>
      <Family
        title="CPU frequency"
        family={cpuFrequency}
        stale={props.stale}
        headings={['Current (mean)', 'Minimum', 'Maximum']}
        rows={
          cpuFrequency
            ? [
                [
                  measured(cpuFrequency.currentMHz, ' MHz'),
                  measured(cpuFrequency.minMHz, ' MHz'),
                  measured(cpuFrequency.maxMHz, ' MHz'),
                ],
              ]
            : []
        }
      />
      <Family
        title="Throttling"
        family={throttling}
        stale={props.stale}
        headings={['Throttled', 'Events since last sample', 'Basis']}
        rows={
          throttling
            ? [
                [
                  throttling.throttled === null
                    ? null
                    : throttling.throttled
                      ? 'Yes'
                      : 'No',
                  throttling.events === null ? null : String(throttling.events),
                  throttling.basis,
                ],
              ]
            : []
        }
      />
    </>
  );
}

function Pressure(props: { sample: Telemetry; stale: boolean }) {
  const family = props.sample.pressure;
  const lines = family
    ? ([
        ['CPU', family.cpu],
        ['Memory', family.memory],
        ['I/O', family.io],
      ] as const)
    : [];
  return (
    <Family
      title="Pressure (PSI)"
      family={family}
      stale={props.stale}
      headings={[
        'Resource',
        'Some 10 s',
        'Some 60 s',
        'Full 10 s',
        'Full 60 s',
      ]}
      rows={lines.flatMap(([name, line]) =>
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
      )}
    />
  );
}

function Connectivity(props: { sample: Telemetry; stale: boolean }) {
  const { connectivity, lifecycle, network } = props.sample;
  return (
    <>
      <Family
        title="Controller connectivity"
        family={connectivity}
        stale={props.stale}
        headings={['Heartbeat round trip', 'Consecutive failures']}
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
      <SampleTable
        title="Network errors since the last sample"
        headings={[
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
        <p class="text-sm">
          Uptime{' '}
          {lifecycle.uptimeSeconds === null
            ? 'unavailable'
            : `${Math.floor(lifecycle.uptimeSeconds / 3600)} h`}
          . Restarts observed by the agent:{' '}
          {lifecycle.restartCount === null
            ? 'unavailable'
            : lifecycle.restartCount}
          {lifecycle.trackedSince ? ` since ${lifecycle.trackedSince}` : ''}.
        </p>
      ) : null}
    </>
  );
}

/**
 * Metrics families beyond CPU, memory and temperature. Every one says whether
 * it was measured, estimated or unsupported, and a stale sample says stale.
 */
export function HealthSnapshot(props: { sample: Telemetry; stale: boolean }) {
  return (
    <>
      <Gpus {...props} />
      <Disks {...props} />
      <Cpu {...props} />
      <Pressure {...props} />
      <Connectivity {...props} />
    </>
  );
}
