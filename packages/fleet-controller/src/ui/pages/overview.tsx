import { type EventRow, type Role } from '../../types';
import { visibleRoles } from '../../domain/summary';
import { AddNodeSteps } from '../components/add-node';
import { Icon, type IconName } from '../components/icon';
import { Meter } from '../components/meter';
import { LevelPill, RoleBadge } from '../components/status';
import { Time } from '../components/time';
import {
  attentionList,
  fleetHealth,
  type AttentionItem,
  type Health,
} from '../lib/attention';
import type { FleetData } from '../lib/fleet-data';
import { pluralize, shortRevision } from '../lib/format';
import { cx, tw } from '../lib/tw';

export const LIVE_OVERVIEW = '/ui/fleet?view=overview';

const BANNER: Record<
  Health['level'],
  { tone: string; icon: IconName; title: string }
> = {
  ok: {
    tone: tw('border-ok-dot/40 bg-ok-soft text-ok'),
    icon: 'check',
    title: 'No operational alerts',
  },
  info: {
    tone: tw('border-ok-dot/40 bg-ok-soft text-ok'),
    icon: 'check',
    title: 'No operational alerts',
  },
  warn: {
    tone: tw('border-warn-dot/50 bg-warn-soft text-warn'),
    icon: 'alert',
    title: 'Needs attention',
  },
  error: {
    tone: tw('border-bad-dot/50 bg-bad-soft text-bad'),
    icon: 'alert',
    title: 'Needs attention',
  },
};

function bannerText(health: Health, pending: number): string {
  if (health.level === 'ok' || health.level === 'info') {
    const waiting = pending > 0 ? `, ${pending} waiting for approval` : '';
    return `All ${pluralize(health.active, 'active node')} are reporting normally${waiting}.`;
  }
  return `${pluralize(health.needAttention, 'node')} of ${health.active} ${health.needAttention === 1 ? 'needs' : 'need'} attention.`;
}

function HealthBanner(props: { health: Health; pending: number }) {
  const banner = BANNER[props.health.level];
  return (
    <section
      aria-label="Fleet health"
      class={cx(
        'flex items-center gap-3 rounded-xl border px-4 py-3.5 sm:px-5',
        banner.tone
      )}
    >
      <Icon name={banner.icon} class="size-6" />
      <div>
        <h2 class="text-base font-semibold">{banner.title}</h2>
        <p class="text-sm">{bannerText(props.health, props.pending)}</p>
      </div>
    </section>
  );
}

function StatTile(props: {
  label: string;
  value: number;
  href: string;
  hint: string;
  dot?: string;
}) {
  return (
    <a
      href={props.href}
      class="card card-pad block text-fg no-underline transition-colors hover:border-line-strong hover:bg-muted/40"
    >
      <p class="eyebrow flex items-center gap-1.5">
        {props.dot === undefined ? null : (
          <span
            role="presentation"
            class={cx('size-2 rounded-full', props.dot)}
          />
        )}
        {props.label}
      </p>
      <p class="tabular mt-1 text-3xl font-semibold tracking-tight">
        {props.value}
      </p>
      <p class="mt-0.5 text-xs text-fg-3">{props.hint}</p>
    </a>
  );
}

function StatTiles(props: { data: FleetData }) {
  const { byStatus, total } = props.data.summary;
  return (
    <section
      aria-label="Totals"
      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
    >
      <StatTile
        label="Online"
        value={byStatus.online}
        href="/nodes?status=online"
        hint="reporting on time"
        dot={tw('bg-ok-dot')}
      />
      <StatTile
        label="Stale"
        value={byStatus.stale}
        href="/nodes?status=stale"
        hint="missed a check-in"
        dot={tw('bg-warn-dot')}
      />
      <StatTile
        label="Offline"
        value={byStatus.offline}
        href="/nodes?status=offline"
        hint="silent too long"
        dot={tw('bg-bad-dot')}
      />
      <StatTile
        label="Pending approval"
        value={byStatus.pending}
        href="/pending"
        hint="waiting for you"
        dot={tw('bg-accent')}
      />
      <StatTile
        label="Total"
        value={total}
        href="/nodes?status=all"
        hint="every machine ever seen"
      />
    </section>
  );
}

function RoleCard(props: { role: Role; total: number; online: number }) {
  const percent = props.total === 0 ? null : (props.online / props.total) * 100;
  return (
    <a
      href={`/nodes?role=${props.role}`}
      class="card block p-4 text-fg no-underline transition-colors hover:border-line-strong hover:bg-muted/40"
    >
      <div class="flex items-baseline justify-between">
        <h3 class="font-medium">{props.role}</h3>
        <p class="tabular text-sm text-fg-2">
          <span class="text-base font-semibold text-fg">{props.online}</span>
          <span> / {props.total}</span>
          <span class="sr-only"> online</span>
        </p>
      </div>
      <Meter
        percent={percent}
        label={`${props.role} nodes online`}
        tone="health"
        class="mt-3"
      />
      <p class="mt-2 text-xs text-fg-3">
        {props.total === 0
          ? 'No nodes yet'
          : props.online === props.total
            ? 'All online'
            : `${props.total - props.online} not online`}
      </p>
    </a>
  );
}

function RoleCards(props: { data: FleetData }) {
  return (
    <section aria-labelledby="roles-title">
      <h2 id="roles-title" class="mb-3 text-sm font-semibold text-fg-2">
        Roles
      </h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {visibleRoles(props.data.summary.byRole).map((role) => (
          <RoleCard
            key={role}
            role={role}
            {...props.data.summary.byRole[role]}
          />
        ))}
      </div>
    </section>
  );
}

function CapacityCard(props: { data: FleetData }) {
  const { total, busy } = props.data.summary.runnerSlots;
  const percent = total === 0 ? null : (busy / total) * 100;
  const hosts = props.data.entries.filter(
    (e) =>
      e.facts.slots !== null &&
      (e.view.status === 'online' || e.view.status === 'stale')
  ).length;
  return (
    <section class="card card-pad" aria-labelledby="capacity-title">
      <h2 id="capacity-title" class="text-sm font-semibold text-fg-2">
        CI runner capacity
      </h2>
      <p class="tabular mt-2 text-3xl font-semibold tracking-tight">
        {busy}
        <span class="text-xl font-medium text-fg-3"> / {total}</span>
        <span class="ml-2 text-sm font-normal text-fg-2">slots busy</span>
      </p>
      <Meter percent={percent} label="Runner slots in use" class="mt-3 h-2" />
      <p class="mt-2 text-xs text-fg-3">
        {total === 0
          ? 'No runner slots reported yet.'
          : `${total - busy} free across ${pluralize(hosts, 'node')}.`}
      </p>
    </section>
  );
}

function RevisionCard(props: { data: FleetData }) {
  const { latest, entries, summary } = props.data;
  const counted = entries.filter(
    (e) => e.view.approval !== 'retired' && e.view.revision !== null
  );
  const behind = counted.filter((e) => e.behind).length;
  const current = counted.length - behind;
  return (
    <section class="card card-pad" aria-labelledby="revisions-title">
      <h2 id="revisions-title" class="text-sm font-semibold text-fg-2">
        Revisions
      </h2>
      {latest === null ? (
        <p class="mt-2 text-fg-2">Latest main commit unknown right now.</p>
      ) : (
        <p class="mt-2 text-base">
          <span class="tabular font-semibold">{current}</span>{' '}
          {current === 1 ? 'node is' : 'nodes are'} on the latest main (
          <code class="font-mono text-xs">{shortRevision(latest)}</code>),{' '}
          <span class={cx('tabular font-semibold', behind > 0 && 'text-warn')}>
            {behind}
          </span>{' '}
          behind.
        </p>
      )}
      <Meter
        percent={counted.length === 0 ? null : (current / counted.length) * 100}
        label="Nodes on the latest main"
        tone="health"
        class="mt-3"
      />
      <ul class="mt-3 space-y-1 text-xs">
        {summary.revisions.slice(0, 4).map((r) => (
          <li key={r.revision} class="flex items-center justify-between gap-2">
            <code class="font-mono text-fg-2">{shortRevision(r.revision)}</code>
            <span class="tabular text-fg-3">
              {pluralize(r.count, 'node')}
              {latest !== null && latest.startsWith(r.revision)
                ? ' · latest'
                : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LEVEL_ICON: Record<AttentionItem['level'], IconName> = {
  error: 'alert',
  warn: 'alert',
  info: 'clock',
};

function AttentionRow(props: { item: AttentionItem; now: Date }) {
  const { entry } = props.item;
  return (
    <li class="flex items-start gap-3 px-4 py-3 sm:px-5">
      <Icon name={LEVEL_ICON[props.item.level]} class="mt-1 text-fg-3" />
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={`/nodes/${entry.view.id}`} class="font-medium text-fg">
            {entry.view.label}
          </a>
          <RoleBadge role={entry.view.role} />
          <LevelPill level={props.item.level} />
        </p>
        <p class="mt-0.5 text-sm text-fg-2">{props.item.message}</p>
      </div>
      <p class="hidden text-xs text-fg-3 sm:block">
        seen <Time at={entry.view.lastSeenAt} now={props.now} />
      </p>
    </li>
  );
}

const MAX_ATTENTION = 10;

function AttentionPanel(props: { items: readonly AttentionItem[]; now: Date }) {
  const shown = props.items.slice(0, MAX_ATTENTION);
  return (
    <section class="card" aria-labelledby="attention-title">
      <div class="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
        <h2 id="attention-title" class="text-sm font-semibold">
          Needs attention
        </h2>
        <span class="tabular text-xs text-fg-3">{props.items.length}</span>
      </div>
      {shown.length === 0 ? (
        <p class="flex items-center gap-2 px-4 py-6 text-fg-2 sm:px-5">
          <Icon name="check" class="text-ok" />
          Nothing needs you right now.
        </p>
      ) : (
        <ul class="divide-y divide-line">
          {shown.map((item) => (
            <AttentionRow
              key={`${item.entry.view.id}:${item.code}`}
              item={item}
              now={props.now}
            />
          ))}
        </ul>
      )}
      {props.items.length > shown.length ? (
        <p class="border-t border-line px-4 py-3 text-sm sm:px-5">
          <a href="/nodes">
            {props.items.length - shown.length} more on the nodes page
          </a>
        </p>
      ) : null}
    </section>
  );
}

export function EventList(props: { events: readonly EventRow[]; now: Date }) {
  return (
    <ul class="divide-y divide-line">
      {props.events.map((event) => (
        <li key={event.id} class="flex items-start gap-3 px-4 py-3 sm:px-5">
          <span class="mt-0.5 w-16 shrink-0">
            <LevelPill level={event.severity} />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-sm">{event.message}</p>
            <p class="mt-0.5 text-xs text-fg-3">
              {event.nodeId !== null ? (
                <a href={`/nodes/${event.nodeId}`}>
                  {event.nodeLabel ?? event.nodeId.slice(0, 4)}
                </a>
              ) : (
                (event.nodeLabel ?? 'fleet')
              )}{' '}
              · {event.kind} · <Time at={event.at} now={props.now} />
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RecentProblems(props: { events: readonly EventRow[]; now: Date }) {
  return (
    <section class="card" aria-labelledby="feed-title">
      <div class="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
        <h2 id="feed-title" class="text-sm font-semibold">
          Recent warnings and errors
        </h2>
        <a href="/events" class="text-xs">
          All events
        </a>
      </div>
      {props.events.length === 0 ? (
        <p class="px-4 py-6 text-fg-2 sm:px-5">
          No warnings or errors recently.
        </p>
      ) : (
        <EventList events={props.events} now={props.now} />
      )}
    </section>
  );
}

/** The auto-refreshing part of the overview. */
export function OverviewBody(props: {
  data: FleetData;
  events: readonly EventRow[];
}) {
  const { data } = props;
  if (data.entries.length === 0)
    return <AddNodeSteps heading="h2" title="Add your first node" />;
  const items = attentionList(data.entries);
  const health = fleetHealth(items, data.entries);
  return (
    <div class="space-y-6">
      <HealthBanner health={health} pending={data.pendingCount} />
      <StatTiles data={data} />
      <RoleCards data={data} />
      <div class="grid gap-6 lg:grid-cols-3">
        <div class="space-y-6 lg:col-span-2">
          <AttentionPanel items={items} now={data.now} />
          <RecentProblems events={props.events} now={data.now} />
        </div>
        <div class="space-y-6">
          <CapacityCard data={data} />
          <RevisionCard data={data} />
        </div>
      </div>
    </div>
  );
}
