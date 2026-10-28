import type { Incident } from '../../domain/incidents';
import type { RestartHistory } from '../../domain/restart-history';
import { ExactTime, Time } from '../components/time';
import { formatDuration } from '../lib/format';
import { cx } from '../lib/tw';

const SEVERITY_CLASS = {
  info: 'text-fg-2',
  warn: 'text-warn',
  error: 'text-bad',
} as const;

function IncidentRowView(props: {
  incident: Incident;
  now: Date;
  showNode: boolean;
}) {
  const { incident } = props;
  return (
    <tr>
      <td data-primary>
        <span class="font-medium">
          {incident.title}
          {incident.subject === null ? '' : ` (${incident.subject})`}
        </span>
        {props.showNode ? (
          <>
            {' '}
            <a href={`/nodes/${incident.nodeId}`}>
              {incident.nodeLabel ?? incident.nodeId.slice(0, 8)}
            </a>
          </>
        ) : null}
        <div class="text-xs text-fg-2">{incident.message}</div>
      </td>
      <td data-label="Severity">
        <span class={cx('font-medium', SEVERITY_CLASS[incident.severity])}>
          {incident.severity}
        </span>
      </td>
      <td data-label="Started">
        <Time at={incident.startedAt} now={props.now} />
      </td>
      <td data-label="Duration" class="text-fg-2">
        {formatDuration(incident.durationSeconds)}
        {incident.open ? ' so far' : ''}
      </td>
      <td data-label="State">
        {incident.open ? (
          <span class="font-medium text-bad">open</span>
        ) : (
          <span class="text-ok">
            resolved <ExactTime at={incident.endedAt} />
          </span>
        )}
      </td>
      <td data-label="Report">
        <a href={incident.reportHref}>Report issue</a>
      </td>
    </tr>
  );
}

export function IncidentsTable(props: {
  incidents: readonly Incident[];
  now: Date;
  showNode: boolean;
}) {
  if (props.incidents.length === 0)
    return <p class="px-5 py-10 text-center text-fg-2">No incidents.</p>;
  return (
    <table class="rtable">
      <caption class="sr-only">Incidents, newest first</caption>
      <thead>
        <tr>
          <th scope="col">Incident</th>
          <th scope="col">Severity</th>
          <th scope="col">Started</th>
          <th scope="col">Duration</th>
          <th scope="col">State</th>
          <th scope="col">Report</th>
        </tr>
      </thead>
      <tbody>
        {props.incidents.map((incident) => (
          <IncidentRowView
            key={incident.id}
            incident={incident}
            now={props.now}
            showNode={props.showNode}
          />
        ))}
      </tbody>
    </table>
  );
}

export function IncidentsBody(props: {
  incidents: readonly Incident[];
  openOnly: boolean;
  openCount: number;
  nextBefore: number | null;
  truncated: boolean;
  now: Date;
}) {
  return (
    <div>
      <nav aria-label="Filter" class="mb-4 flex items-center gap-2 text-sm">
        <a
          class={cx('btn btn-sm', props.openOnly ? '' : 'btn-primary')}
          href="/incidents"
        >
          All
        </a>
        <a
          class={cx('btn btn-sm', props.openOnly ? 'btn-primary' : '')}
          href="/incidents?open=true"
        >
          Open ({props.openCount})
        </a>
      </nav>
      <section class="card" aria-label="Incidents">
        <IncidentsTable incidents={props.incidents} now={props.now} showNode />
      </section>
      {props.truncated ? (
        <p class="mt-2 text-xs text-fg-3">
          Only the most recent events were examined; older incidents may be
          missing.
        </p>
      ) : null}
      {props.nextBefore === null ? null : (
        <nav aria-label="Pages" class="mt-4 flex justify-end text-sm">
          <a
            class="btn btn-sm"
            href={`/incidents?${props.openOnly ? 'open=true&' : ''}before=${props.nextBefore}`}
            rel="next"
          >
            Older incidents
          </a>
        </nav>
      )}
    </div>
  );
}

/** The node page's incident list. */
export function NodeIncidentsPanel(props: {
  incidents: readonly Incident[];
  now: Date;
}) {
  return (
    <section class="card card-pad" aria-labelledby="node-incidents-title">
      <h2 id="node-incidents-title" class="font-semibold">
        Incidents
      </h2>
      <IncidentsTable
        incidents={props.incidents}
        now={props.now}
        showNode={false}
      />
      <a class="text-sm" href="/incidents">
        All incidents
      </a>
    </section>
  );
}

/** Restarts and uptime, from boot events. */
export function RestartHistoryPanel(props: {
  history: RestartHistory;
  now: Date;
}) {
  const { history } = props;
  return (
    <section class="card card-pad space-y-2" aria-labelledby="restarts-title">
      <h2 id="restarts-title" class="font-semibold">
        Restarts and uptime
      </h2>
      <p class="text-sm">
        Uptime{' '}
        {history.current.uptimeSeconds === null
          ? 'unavailable'
          : formatDuration(history.current.uptimeSeconds)}
        . Restarts: {history.restartsLast24h} in 24 h, {history.restartsLast7d}{' '}
        in 7 d. Unclean shutdowns: {history.uncleanShutdowns}.
      </p>
      {history.boots.length === 0 ? (
        <p class="text-sm text-fg-3">No boot events recorded.</p>
      ) : (
        <table class="w-full text-left text-sm">
          <thead>
            <tr>
              <th class="p-2">Boot started</th>
              <th class="p-2">Previous shutdown</th>
            </tr>
          </thead>
          <tbody>
            {history.boots.map((boot) => (
              <tr key={boot.eventId}>
                <td class="p-2">
                  <ExactTime at={boot.startedAt} />
                </td>
                <td class="p-2">{boot.previousShutdown}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p class="text-xs text-fg-3">
        Derived from boot events. Clean means the node reported no unclean
        shutdown; the oldest recorded boot has an unknown predecessor.
      </p>
    </section>
  );
}
