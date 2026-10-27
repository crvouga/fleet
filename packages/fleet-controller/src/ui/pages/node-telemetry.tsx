import type { Telemetry } from '../../telemetry';
import type { Child } from 'hono/jsx';
import type { FleetEntry } from '../lib/fleet-data';
import { bytes, runLink, telemetryFresh } from '../lib/telemetry';
function SampleTable(props: {
  title: string;
  headings: string[];
  rows: Child[][];
}) {
  return (
    <section>
      <h3 class="mt-4 font-semibold">{props.title}</h3>
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
        <p class="text-sm text-fg-3">No measurements reported.</p>
      )}
    </section>
  );
}
export function TelemetrySnapshot(props: { entry: FleetEntry; now: Date }) {
  const sample = props.entry.facts.telemetry;
  if (!sample)
    return (
      <section class="card card-pad">
        <h2 class="font-semibold">Hardware telemetry unavailable</h2>
        <p>This agent has not reported extended telemetry.</p>
      </section>
    );
  return (
    <section class="card card-pad space-y-3">
      <h2 class="font-semibold">Hardware and runner telemetry</h2>
      <p>
        {telemetryFresh(props.entry, props.now)
          ? 'Last current sample'
          : 'Stale sample: values do not describe current usage or running jobs'}{' '}
        · {sample.sampledAt}
      </p>
      <p>
        CPU utilization:{' '}
        {sample.cpuUsagePercent === null
          ? 'Sampling / unavailable'
          : `${sample.cpuUsagePercent.toFixed(1)}%`}
      </p>
      {sample.issues.map((issue, index) => (
        <p key={index}>{issue}</p>
      ))}
      <HardwareSnapshot sample={sample} />
      <SampleTable
        title="Runner activity"
        headings={['Slot', 'State', 'Job', 'GitHub run', 'Hook result']}
        rows={sample.runnerSlots.map((slot) => {
          const href = runLink(slot.repository, slot.runId);
          return [
            slot.slot,
            slot.state,
            slot.jobName,
            href ? (
              <a href={href} rel="noreferrer">
                {slot.repository} #{slot.runId}
              </a>
            ) : null,
            slot.result,
          ];
        })}
      />
      <SampleTable
        title="Service diagnostics"
        headings={['Time', 'Source', 'Level', 'Summary']}
        rows={sample.logs.map((item) => [
          item.at,
          item.source,
          item.level,
          item.message,
        ])}
      />
      <p class="text-xs text-fg-3">
        Only bounded service and runner lifecycle summaries are collected. Open
        the GitHub run for authoritative job status and authenticated logs.
      </p>
    </section>
  );
}

function HardwareSnapshot({ sample }: { sample: Telemetry }) {
  return (
    <>
      <SampleTable
        title="Storage"
        headings={['Mount', 'Used', 'Available', 'Total']}
        rows={sample.filesystems.map((item) => [
          item.mount,
          bytes(item.usedBytes),
          bytes(item.availableBytes),
          bytes(item.totalBytes),
        ])}
      />
      <SampleTable
        title="Temperature sensors"
        headings={['Sensor', 'Temperature']}
        rows={sample.temperatures.map((item) => [
          item.name,
          `${item.celsius} °C`,
        ])}
      />
      <SampleTable
        title="Power measurements"
        headings={['Domain', 'Power', 'Source']}
        rows={sample.power.map((item) => [
          item.name,
          `${item.watts} W`,
          item.source,
        ])}
      />
      <p class="text-xs text-fg-3">
        Power domains may overlap and do not establish whole-machine power.
        Missing measurements are unavailable, never zero.
      </p>
    </>
  );
}
