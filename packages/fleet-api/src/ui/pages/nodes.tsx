import { ROLES } from '../../types';
import { AddNodeSteps } from '../components/add-node';
import { CopyButton } from '../components/copy';
import { Icon } from '../components/icon';
import { MeterCell } from '../components/meter';
import { ChipList, RoleBadge, StatusBadge } from '../components/status';
import { Time } from '../components/time';
import { diskPercent } from '../lib/facts';
import type { FleetData, FleetEntry } from '../lib/fleet-data';
import {
  formatDuration,
  formatLoad,
  pluralize,
  shortRevision,
} from '../lib/format';
import {
  STATUS_FILTERS,
  defaultDirection,
  filterNodes,
  nodesHref,
  sortNodes,
  type NodesQuery,
  type SortKey,
  type StatusFilter,
} from '../lib/nodes-query';
import { cx } from '../lib/tw';

const COLUMNS: readonly { key: SortKey | null; label: string }[] = [
  { key: 'status', label: 'Status' },
  { key: 'name', label: 'Node' },
  { key: 'role', label: 'Role' },
  { key: 'revision', label: 'Revision' },
  { key: 'seen', label: 'Last seen' },
  { key: 'uptime', label: 'Uptime' },
  { key: 'load', label: 'Load' },
  { key: 'mem', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'slots', label: 'Runners' },
];

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'All',
  online: 'Online',
  stale: 'Stale',
  offline: 'Offline',
  pending: 'Pending',
  rejected: 'Rejected',
  retired: 'Retired',
};

function countFor(
  entries: readonly FleetEntry[],
  filter: StatusFilter
): number {
  return filterNodes(entries, {
    status: filter,
    role: null,
    q: '',
    sort: 'status',
    dir: 'asc',
  }).length;
}

function StatusTabs(props: {
  entries: readonly FleetEntry[];
  query: NodesQuery;
}) {
  return (
    <nav
      aria-label="Filter by status"
      class="-mx-1 flex gap-1 overflow-x-auto pb-1"
    >
      {STATUS_FILTERS.map((filter) => {
        const current = props.query.status === filter;
        return (
          <a
            key={filter}
            href={nodesHref(props.query, {
              status: filter === 'all' ? null : filter,
            })}
            aria-current={current ? 'true' : undefined}
            class={cx(
              'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-medium no-underline',
              current
                ? 'bg-accent-soft text-accent-ink'
                : 'text-fg-2 hover:bg-muted hover:text-fg'
            )}
          >
            {FILTER_LABEL[filter]}
            <span class="tabular text-xs text-fg-3">
              {countFor(props.entries, filter)}
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function SortSelect(props: { query: NodesQuery }) {
  const { query } = props;
  return (
    <div class="md:hidden">
      <label for="nodes-sort" class="label sr-only">
        Sort by
      </label>
      <select id="nodes-sort" name="sort" class="field pr-8">
        {COLUMNS.map((column) =>
          column.key === null ? null : (
            <option
              key={column.key}
              value={column.key}
              selected={query.sort === column.key}
            >
              {`Sort: ${column.label}`}
            </option>
          )
        )}
      </select>
    </div>
  );
}

/** Search and role filter: a plain GET form, so it works without JavaScript. */
function SearchForm(props: { query: NodesQuery }) {
  const { query } = props;
  return (
    <form
      method="get"
      action="/nodes"
      role="search"
      class="flex flex-wrap items-end gap-2"
    >
      <div class="min-w-48 flex-1">
        <label for="nodes-q" class="label sr-only">
          Search nodes
        </label>
        <div class="relative">
          <Icon
            name="search"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3"
          />
          <input
            id="nodes-q"
            type="search"
            name="q"
            value={query.q}
            maxlength={100}
            placeholder="Search name, hostname, label, revision, address"
            class="field pl-9"
          />
        </div>
      </div>
      <div>
        <label for="nodes-role" class="label sr-only">
          Role
        </label>
        <select id="nodes-role" name="role" class="field pr-8">
          <option value="" selected={query.role === null}>
            All roles
          </option>
          {ROLES.map((role) => (
            <option key={role} value={role} selected={query.role === role}>
              {role}
            </option>
          ))}
        </select>
      </div>
      {query.status === 'all' ? null : (
        <input type="hidden" name="status" value={query.status} />
      )}
      <SortSelect query={query} />
      <button type="submit" class="btn btn-primary">
        Filter
      </button>
    </form>
  );
}

function SortHeader(props: {
  column: (typeof COLUMNS)[number];
  query: NodesQuery;
}) {
  const { key, label } = props.column;
  if (key === null) return <th scope="col">{label}</th>;
  const active = props.query.sort === key;
  const nextDir = active
    ? props.query.dir === 'asc'
      ? 'desc'
      : 'asc'
    : defaultDirection(key);
  const sortAttr = active
    ? props.query.dir === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';
  return (
    <th scope="col" aria-sort={sortAttr}>
      <a
        href={nodesHref(props.query, { sort: key, dir: nextDir })}
        class={cx(
          'inline-flex items-center gap-1 no-underline hover:text-fg',
          active ? 'text-fg' : 'text-fg-3'
        )}
      >
        {label}
        {active ? (
          <Icon
            name={props.query.dir === 'asc' ? 'up' : 'down'}
            class="size-3"
          />
        ) : null}
      </a>
    </th>
  );
}

function RevisionCell(props: { entry: FleetEntry; latest: string | null }) {
  const { view } = props.entry;
  if (view.revision === null) return <span class="text-fg-3">unknown</span>;
  return (
    <span class="inline-flex items-center gap-1.5">
      <code class="font-mono text-xs">{shortRevision(view.revision)}</code>
      {props.entry.behind ? (
        <span
          class="rounded bg-warn-soft px-1 py-0.5 text-xs font-medium text-warn"
          title={`Latest main is ${shortRevision(props.latest)}`}
        >
          behind
        </span>
      ) : null}
    </span>
  );
}

function RunnersCell(props: { entry: FleetEntry }) {
  const { slots, busySlots } = props.entry.facts;
  if (slots === null) return <span class="text-fg-3">n/a</span>;
  return (
    <span class="tabular">
      {busySlots ?? 0}
      <span class="text-fg-3"> / {slots}</span>
      <span class="sr-only"> slots busy</span>
    </span>
  );
}

function NameCell(props: { entry: FleetEntry }) {
  const { view } = props.entry;
  return (
    <div class="min-w-0">
      <div class="flex items-center gap-1">
        <a href={`/nodes/${view.id}`} class="truncate font-medium text-fg">
          {view.label}
        </a>
        <CopyButton
          text={view.hostname}
          label={`Copy hostname ${view.hostname}`}
        />
      </div>
      <p class="truncate font-mono text-xs text-fg-3">
        {view.displayName === null ? '' : `${view.hostname} · `}#{view.shortId}
      </p>
      <ChipList items={view.labels} />
    </div>
  );
}

function NodeTableRow(props: { entry: FleetEntry; data: FleetData }) {
  const { entry, data } = props;
  const { view, facts } = entry;
  const reporting = view.lastSeenAt !== null;
  return (
    <tr>
      <td data-label="Status">
        <StatusBadge status={view.status} />
      </td>
      <td data-primary>
        <NameCell entry={entry} />
      </td>
      <td data-label="Role">
        <RoleBadge role={view.role} />
      </td>
      <td data-label="Revision">
        <RevisionCell entry={entry} latest={data.latest} />
      </td>
      <td data-label="Last seen" class="text-fg-2">
        <Time at={view.lastSeenAt} now={data.now} />
      </td>
      <td data-label="Uptime" class="tabular text-fg-2">
        {reporting ? formatDuration(facts.uptimeSeconds) : 'n/a'}
      </td>
      <td data-label="Load" class="tabular text-fg-2">
        {reporting ? formatLoad(facts.load1) : 'n/a'}
      </td>
      <td data-label="Memory">
        <MeterCell
          percent={reporting ? facts.memUsedPercent : null}
          label={`${view.label} memory used`}
        />
      </td>
      <td data-label="Disk">
        <MeterCell
          percent={reporting ? diskPercent(facts) : null}
          label={`${view.label} disk used`}
        />
      </td>
      <td data-label="Runners">
        <RunnersCell entry={entry} />
      </td>
    </tr>
  );
}

function NoMatches(props: { query: NodesQuery }) {
  return (
    <div class="px-4 py-12 text-center">
      <p class="font-medium">No nodes match these filters</p>
      <p class="mt-1 text-fg-2">
        {props.query.q === ''
          ? 'Try another status or role.'
          : `Nothing found for "${props.query.q}".`}
      </p>
      <a href="/nodes" class="btn mt-4">
        Clear filters
      </a>
    </div>
  );
}

/** The auto-refreshing part of the nodes page: tabs, count and table. */
export function NodesBody(props: { data: FleetData; query: NodesQuery }) {
  const { data, query } = props;
  if (data.entries.length === 0)
    return <AddNodeSteps heading="h2" title="Add your first node" />;
  const rows = sortNodes(filterNodes(data.entries, query), query);
  return (
    <div class="space-y-3">
      <StatusTabs entries={data.entries} query={query} />
      <div class="card overflow-hidden">
        {rows.length === 0 ? (
          <NoMatches query={query} />
        ) : (
          <table class="rtable">
            <caption class="sr-only">{`${pluralize(rows.length, 'node')}, sorted by ${query.sort} ${query.dir === 'asc' ? 'ascending' : 'descending'}`}</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <SortHeader
                    key={column.label}
                    column={column}
                    query={query}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <NodeTableRow key={entry.view.id} entry={entry} data={data} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p class="px-1 text-xs text-fg-3">
        Showing {pluralize(rows.length, 'node')}. Retired and rejected machines
        appear under their own tabs.
      </p>
    </div>
  );
}

export function NodesToolbar(props: { query: NodesQuery }) {
  return (
    <div class="mb-4">
      <SearchForm query={props.query} />
    </div>
  );
}
