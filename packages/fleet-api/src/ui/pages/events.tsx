import type { EventRow } from '../../types';
import { EventList } from './overview';
import type { FleetEntry } from '../lib/fleet-data';

export const EVENTS_PAGE_SIZE = 25;

export interface EventsQuery {
  readonly severity: 'warn' | 'error' | null;
  readonly nodeId: string | null;
  readonly before: number | null;
}

export function parseEventsQuery(
  query: Readonly<Record<string, string | undefined>>
): EventsQuery {
  const severity = query['severity'];
  const before = Number.parseInt(query['before'] ?? '', 10);
  const nodeId = query['node'] ?? '';
  return {
    severity: severity === 'warn' || severity === 'error' ? severity : null,
    nodeId: /^[0-9a-f]{64}$/.test(nodeId) ? nodeId : null,
    before: Number.isInteger(before) && before > 0 ? before : null,
  };
}

export function eventsHref(query: EventsQuery, before: number | null): string {
  const params = new URLSearchParams();
  if (query.severity !== null) params.set('severity', query.severity);
  if (query.nodeId !== null) params.set('node', query.nodeId);
  if (before !== null) params.set('before', String(before));
  const text = params.toString();
  return text === '' ? '/events' : `/events?${text}`;
}

function Filters(props: {
  query: EventsQuery;
  entries: readonly FleetEntry[];
}) {
  const { query } = props;
  return (
    <form
      method="get"
      action="/events"
      class="mb-4 flex flex-wrap items-end gap-2"
    >
      <div>
        <label for="events-severity" class="label sr-only">
          Severity
        </label>
        <select id="events-severity" name="severity" class="field pr-8">
          <option value="" selected={query.severity === null}>
            All severities
          </option>
          <option value="warn" selected={query.severity === 'warn'}>
            Warnings
          </option>
          <option value="error" selected={query.severity === 'error'}>
            Errors
          </option>
        </select>
      </div>
      <div>
        <label for="events-node" class="label sr-only">
          Node
        </label>
        <select id="events-node" name="node" class="field max-w-64 pr-8">
          <option value="" selected={query.nodeId === null}>
            All nodes
          </option>
          {props.entries.map((entry) => (
            <option
              key={entry.view.id}
              value={entry.view.id}
              selected={query.nodeId === entry.view.id}
            >
              {entry.view.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" class="btn btn-primary">
        Filter
      </button>
      {query.severity === null && query.nodeId === null ? null : (
        <a class="btn btn-ghost" href="/events">
          Clear
        </a>
      )}
    </form>
  );
}

export function EventsBody(props: {
  query: EventsQuery;
  entries: readonly FleetEntry[];
  events: readonly EventRow[];
  hasMore: boolean;
  now: Date;
}) {
  const last = props.events[props.events.length - 1];
  return (
    <div>
      <Filters query={props.query} entries={props.entries} />
      <section class="card" aria-label="Events">
        {props.events.length === 0 ? (
          <p class="px-5 py-10 text-center text-fg-2">No events match.</p>
        ) : (
          <EventList events={props.events} now={props.now} />
        )}
      </section>
      <nav
        aria-label="Pages"
        class="mt-4 flex items-center justify-between text-sm"
      >
        {props.query.before === null ? (
          <span />
        ) : (
          <a class="btn btn-sm" href={eventsHref(props.query, null)}>
            Back to newest
          </a>
        )}
        {props.hasMore && last !== undefined ? (
          <a
            class="btn btn-sm"
            href={eventsHref(props.query, last.id)}
            rel="next"
          >
            Older events
          </a>
        ) : null}
      </nav>
    </div>
  );
}
