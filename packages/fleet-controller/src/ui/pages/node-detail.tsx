import type { Child } from 'hono/jsx';

import type { EventRow, HeartbeatPoint } from '../../types';
import { AreaChart, AvailabilityStrip } from '../components/chart';
import { CopyableCode } from '../components/copy';
import { Icon } from '../components/icon';
import { ChipList, RoleBadge, StatusBadge } from '../components/status';
import { ExactTime, Time } from '../components/time';
import { attentionFor } from '../lib/attention';
import { diskPercent } from '../lib/facts';
import type { FleetData, FleetEntry } from '../lib/fleet-data';
import {
  formatDuration,
  formatLoad,
  formatMiB,
  formatPercent,
  shortRevision,
} from '../lib/format';
import { availability, bucketize } from '../lib/series';
import { cx, tw } from '../lib/tw';
import { TelemetrySnapshot } from './node-telemetry';
import {
  EditPanel,
  EffectiveConfig,
  ManagePanel,
  NodeTimeline,
} from './node-panels';

function Callout(props: {
  tone: 'error' | 'warn' | 'info';
  title: string;
  children?: Child;
}) {
  const tones = {
    error: tw('border-bad-dot/40 bg-bad-soft text-bad'),
    warn: tw('border-warn-dot/50 bg-warn-soft text-warn'),
    info: tw('border-accent/30 bg-accent-soft text-accent-ink'),
  };
  return (
    <div
      role={props.tone === 'error' ? 'alert' : 'note'}
      class={cx(
        'flex items-start gap-3 rounded-xl border px-4 py-3',
        tones[props.tone]
      )}
    >
      <Icon
        name={props.tone === 'info' ? 'info' : 'alert'}
        class="mt-0.5 size-5"
      />
      <div>
        <h2 class="font-semibold">{props.title}</h2>
        <div class="mt-0.5 text-sm">{props.children}</div>
      </div>
    </div>
  );
}

function Callouts(props: { entry: FleetEntry }) {
  const { entry } = props;
  const { facts, view } = entry;
  const diskIssue = attentionFor(entry).find((item) => item.code === 'disk');
  return (
    <div class="space-y-3 empty:hidden">
      {view.status === 'pending' ? (
        <Callout tone="info" title="Waiting for your approval">
          This machine asked to join as <strong>{view.role}</strong>. Check the
          details below, then approve or reject it.
        </Callout>
      ) : null}
      {view.status === 'offline' ? (
        <Callout tone="error" title="Offline">
          {view.ageSeconds === null
            ? 'This node has never reported.'
            : `No report for ${formatDuration(view.ageSeconds)}. The values below are from its last report.`}
        </Callout>
      ) : null}
      {facts.rolledBack ? (
        <Callout tone="error" title="Rolled back">
          The last update failed its health check and the node returned to the
          previous system.
          {facts.healthFailure === null
            ? ''
            : ` Reason: ${facts.healthFailure}`}
        </Callout>
      ) : null}
      {facts.failedUnits.length > 0 ? (
        <Callout
          tone="error"
          title={`${facts.failedUnits.length} failed ${facts.failedUnits.length === 1 ? 'unit' : 'units'}`}
        >
          <ul class="flex flex-wrap gap-1.5">
            {facts.failedUnits.map((unit) => (
              <li key={unit} class="chip">
                {unit}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {diskIssue === undefined ? null : (
        <Callout tone="warn" title="Disk almost full">
          {diskIssue.message}
        </Callout>
      )}
    </div>
  );
}

function Fact(props: { label: string; children?: Child }) {
  return (
    <div class="min-w-0">
      <dt class="eyebrow">{props.label}</dt>
      <dd class="mt-0.5 break-words text-sm">{props.children}</dd>
    </div>
  );
}

function Unknown() {
  return <span class="text-fg-3">unknown</span>;
}

function IdentityFacts(props: { entry: FleetEntry }) {
  const { view, facts } = props.entry;
  return (
    <>
      <Fact label="Hostname">
        <CopyableCode text={view.hostname} label="Copy hostname" />
      </Fact>
      <Fact label="Role">
        <RoleBadge role={view.role} />
      </Fact>
      <Fact label="Capabilities">
        <ChipList items={facts.capabilities} empty="none" />
      </Fact>
      <Fact label="Revision">
        {view.revision === null ? (
          <Unknown />
        ) : (
          <code class="font-mono text-xs">{shortRevision(view.revision)}</code>
        )}
        {props.entry.behind ? ' (behind main)' : ''}
      </Fact>
    </>
  );
}

function HardwareFacts(props: { entry: FleetEntry }) {
  const { facts } = props.entry;
  return (
    <>
      <Fact label="Kernel">{facts.kernel ?? <Unknown />}</Fact>
      <Fact label="Architecture">{facts.arch ?? <Unknown />}</Fact>
      <Fact label="CPU">
        {facts.cpuCores === null ? <Unknown /> : `${facts.cpuCores} cores`}
        {facts.cpuModel === null ? '' : ` · ${facts.cpuModel}`}
      </Fact>
      <Fact label="Memory">{formatMiB(facts.memTotalMiB)}</Fact>
      <Fact label="Uptime">{formatDuration(facts.uptimeSeconds)}</Fact>
      <Fact label="Boot id">
        <span class="font-mono text-xs">{facts.bootId ?? 'unknown'}</span>
      </Fact>
      <Fact label="Addresses">
        {facts.addresses.length === 0 ? (
          <Unknown />
        ) : (
          <ul class="space-y-1">
            {facts.addresses.map((address) => (
              <li key={address}>
                <CopyableCode
                  text={address}
                  label={`Copy address ${address}`}
                />
              </li>
            ))}
          </ul>
        )}
      </Fact>
    </>
  );
}

function EnrolmentFacts(props: { entry: FleetEntry; data: FleetData }) {
  const { view } = props.entry;
  return (
    <>
      <Fact label="Agent">{view.agentVersion ?? <Unknown />}</Fact>
      <Fact label="Config revision">
        <span class="font-mono text-xs">
          {view.configRevision ?? 'none applied'}
        </span>
      </Fact>
      <Fact label="Enrolled via">{view.enrolledVia}</Fact>
      <Fact label="First seen">
        <ExactTime at={view.firstSeenAt} />
      </Fact>
      <Fact label="Last seen">
        <Time at={view.lastSeenAt} now={props.data.now} />
      </Fact>
      <Fact label="Node id">
        <CopyableCode text={view.id} label="Copy node id" />
      </Fact>
      {view.approvedAt === null ? null : (
        <Fact label="Approved">
          <ExactTime at={view.approvedAt} />
          {view.approvedBy === null ? '' : ` by ${view.approvedBy}`}
        </Fact>
      )}
    </>
  );
}

function FactsPanel(props: { entry: FleetEntry; data: FleetData }) {
  return (
    <section class="card card-pad" aria-labelledby="facts-title">
      <h2 id="facts-title" class="text-sm font-semibold">
        Details
      </h2>
      <dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
        <IdentityFacts entry={props.entry} />
        <HardwareFacts entry={props.entry} />
        <EnrolmentFacts entry={props.entry} data={props.data} />
      </dl>
    </section>
  );
}

function Charts(props: {
  entry: FleetEntry;
  points: readonly HeartbeatPoint[];
  now: Date;
}) {
  const { entry, points, now } = props;
  const load = bucketize(points, (p) => p.load1, now);
  const mem = bucketize(points, (p) => p.memUsedPercent, now);
  const disk = bucketize(points, (p) => p.diskPercent, now);
  const busy = bucketize(points, (p) => p.busySlots, now);
  const beats = bucketize(points, () => null, now);
  const slots = Math.max(1, entry.facts.slots ?? 0);
  const loadMax = Math.max(1, ...load.map((b) => b.value ?? 0)) * 1.1;
  return (
    <div class="space-y-4">
      <h2 class="sr-only">Last 24 hours</h2>
      <AvailabilityStrip
        buckets={beats}
        firstSeenAt={entry.view.firstSeenAt}
        percent={availability(beats, entry.view.firstSeenAt)}
      />
      <div class="grid gap-4 md:grid-cols-2">
        <AreaChart
          title="Load (1 min)"
          buckets={load}
          max={loadMax}
          format={(v) => v.toFixed(2)}
          headline={formatLoad(entry.facts.load1)}
          note={`${entry.facts.cpuCores ?? '?'} cores`}
        />
        <AreaChart
          title="Memory used"
          buckets={mem}
          max={100}
          format={(v) => `${Math.round(v)}%`}
          headline={formatPercent(entry.facts.memUsedPercent)}
        />
        <AreaChart
          title="Disk used"
          buckets={disk}
          max={100}
          format={(v) => `${Math.round(v)}%`}
          headline={formatPercent(diskPercent(entry.facts))}
        />
        {entry.facts.slots === null ? null : (
          <AreaChart
            title="Runner slots busy"
            buckets={busy}
            max={slots}
            format={(v) => v.toFixed(1)}
            headline={`${entry.facts.busySlots ?? 0} / ${entry.facts.slots}`}
          />
        )}
      </div>
    </div>
  );
}

export interface NodeDetailProps {
  readonly entry: FleetEntry;
  readonly data: FleetData;
  readonly points: readonly HeartbeatPoint[];
  readonly events: readonly EventRow[];
}

export function NodeHeaderMeta(props: { entry: FleetEntry }) {
  const { view } = props.entry;
  return (
    <span class="flex flex-wrap items-center gap-2">
      <StatusBadge status={view.status} />
      <RoleBadge role={view.role} />
      <span class="font-mono text-xs text-fg-3">
        {view.hostname} #{view.shortId}
      </span>
    </span>
  );
}

/** Everything on the node page below the header. */
export function NodeDetailBody(props: NodeDetailProps) {
  const { entry, data, points, events } = props;
  return (
    <div class="space-y-6">
      <Callouts entry={entry} />
      {entry.view.note === null ? null : (
        <p class="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-fg-2">
          {entry.view.note}
        </p>
      )}
      <div class="grid gap-6 lg:grid-cols-3">
        <div class="space-y-6 lg:col-span-2">
          <Charts entry={entry} points={points} now={data.now} />
          <TelemetrySnapshot entry={entry} now={data.now} />
          <EffectiveConfig view={entry.view} documents={data.documents} />
          <NodeTimeline events={events} now={data.now} />
        </div>
        <div class="space-y-6">
          <FactsPanel entry={entry} data={data} />
          <EditPanel view={entry.view} />
          <ManagePanel view={entry.view} />
        </div>
      </div>
    </div>
  );
}
