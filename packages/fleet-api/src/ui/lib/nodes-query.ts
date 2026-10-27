import { ROLES, isRole, type NodeStatus, type Role } from '../../types';
import { diskPercent } from './facts';
import type { FleetEntry } from './fleet-data';

export const STATUS_FILTERS = [
  'all',
  'online',
  'stale',
  'offline',
  'pending',
  'rejected',
  'retired',
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const SORT_KEYS = [
  'status',
  'name',
  'role',
  'seen',
  'uptime',
  'load',
  'mem',
  'disk',
  'slots',
  'revision',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface NodesQuery {
  readonly status: StatusFilter;
  readonly role: Role | null;
  readonly q: string;
  readonly sort: SortKey;
  readonly dir: 'asc' | 'desc';
}

const MAX_SEARCH_LENGTH = 100;

export function parseNodesQuery(
  query: Readonly<Record<string, string | undefined>>
): NodesQuery {
  const status = STATUS_FILTERS.find((s) => s === query['status']) ?? 'all';
  const sort = SORT_KEYS.find((s) => s === query['sort']) ?? 'status';
  const role = query['role'];
  return {
    status,
    role: isRole(role) ? role : null,
    q: (query['q'] ?? '').trim().slice(0, MAX_SEARCH_LENGTH),
    sort,
    dir:
      query['dir'] === 'desc'
        ? 'desc'
        : query['dir'] === 'asc'
          ? 'asc'
          : defaultDirection(sort),
  };
}

const NEWEST_FIRST: readonly SortKey[] = [
  'seen',
  'uptime',
  'load',
  'mem',
  'disk',
];

export function defaultDirection(sort: SortKey): 'asc' | 'desc' {
  return NEWEST_FIRST.includes(sort) ? 'desc' : 'asc';
}

/** The query string that reproduces `query`, with `overrides` applied. */
export function nodesHref(
  query: NodesQuery,
  overrides: Partial<Record<string, string | null>> = {}
): string {
  const defaultSort = query.sort === 'status' && query.dir === 'asc';
  const base: Record<string, string | null> = {
    status: query.status === 'all' ? null : query.status,
    role: query.role,
    q: query.q,
    sort: defaultSort ? null : query.sort,
    dir: defaultSort ? null : query.dir,
    ...overrides,
  };
  const params = new URLSearchParams(
    Object.entries(base).filter(
      (pair): pair is [string, string] => pair[1] !== null && pair[1] !== ''
    )
  );
  const text = params.toString();
  return text === '' ? '/nodes' : `/nodes?${text}`;
}

const STATUS_RANK: Record<NodeStatus, number> = {
  offline: 0,
  stale: 1,
  pending: 2,
  online: 3,
  rejected: 4,
  retired: 5,
};

function haystack(entry: FleetEntry): string {
  const { view, facts } = entry;
  return [
    view.hostname,
    view.displayName,
    view.id,
    view.note,
    view.revision,
    view.role,
    view.remoteAddr,
    ...view.labels,
    ...facts.addresses,
    ...facts.capabilities,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

function matchesStatus(entry: FleetEntry, status: StatusFilter): boolean {
  if (status === 'all')
    return entry.view.status !== 'retired' && entry.view.status !== 'rejected';
  return entry.view.status === status;
}

export function filterNodes(
  entries: readonly FleetEntry[],
  query: NodesQuery
): FleetEntry[] {
  const needle = query.q.toLowerCase();
  return entries.filter(
    (entry) =>
      matchesStatus(entry, query.status) &&
      (query.role === null || entry.view.role === query.role) &&
      (needle === '' || haystack(entry).includes(needle))
  );
}

type SortValue = number | string | null;

const SORT_VALUES: Record<SortKey, (entry: FleetEntry) => SortValue> = {
  status: (e) => STATUS_RANK[e.view.status],
  name: (e) => e.view.label.toLowerCase(),
  role: (e) => ROLES.indexOf(e.view.role),
  seen: (e) => e.view.lastSeenAt?.getTime() ?? null,
  uptime: (e) => e.facts.uptimeSeconds,
  load: (e) => e.facts.load1,
  mem: (e) => e.facts.memUsedPercent,
  disk: (e) => diskPercent(e.facts),
  slots: (e) =>
    e.facts.slots === null ? null : e.facts.slots - (e.facts.busySlots ?? 0),
  revision: (e) => e.view.revision,
};

function sortValue(entry: FleetEntry, key: SortKey): SortValue {
  return SORT_VALUES[key](entry);
}

function compareValues(a: SortValue, b: SortValue): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Missing values always sort last, whatever the direction. */
export function sortNodes(
  entries: readonly FleetEntry[],
  query: NodesQuery
): FleetEntry[] {
  const sign = query.dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const left = sortValue(a, query.sort);
    const right = sortValue(b, query.sort);
    if (left === null || right === null) return compareValues(left, right);
    return (
      sign * compareValues(left, right) ||
      a.view.label.localeCompare(b.view.label)
    );
  });
}
