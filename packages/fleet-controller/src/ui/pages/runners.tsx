import type { JobRow, RunnerRow, RunnersView } from '../../github/views';
import { formatDuration } from '../lib/format';

/** Why there is nothing to show, in words an operator can act on. */
export function connectionNotice(view: RunnersView): string | null {
  if (!view.connection.keyConfigured) {
    return 'The controller has no GitHub App private key. Set FLEET_GITHUB_APP_PRIVATE_KEY or FLEET_GITHUB_APP_PRIVATE_KEY_FILE in deployment.env and restart. Nothing is simulated.';
  }
  if (!view.connection.configured) {
    return 'The GitHub integration is not configured. Save the App ID, installation ID and a repository or organization.';
  }
  return view.integration.lastError;
}

function Fact(props: { label: string; value: string }) {
  return (
    <div>
      <dt class="eyebrow">{props.label}</dt>
      <dd class="mt-0.5 break-words text-sm">{props.value}</dd>
    </div>
  );
}

function Status(props: { view: RunnersView }) {
  const { integration, connection, capacity } = props.view;
  const notice = connectionNotice(props.view);
  return (
    <section class="card mb-6 p-5" aria-label="GitHub connection">
      <h2 class="text-base font-semibold">GitHub connection</h2>
      {notice === null ? null : (
        <p class="mt-2 text-sm text-warn" role="status">
          {notice}
        </p>
      )}
      <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact label="Status" value={integration.status} />
        <Fact
          label="Scope"
          value={
            integration.scope === 'organization'
              ? `organization ${integration.organization}`
              : `${integration.repositories.length} repositories`
          }
        />
        <Fact
          label="Private key"
          value={connection.keyConfigured ? 'configured' : 'not configured'}
        />
        <Fact
          label="Webhook"
          value={connection.webhookEnabled ? 'enabled' : 'polling only'}
        />
        <Fact
          label="Slots busy"
          value={`${capacity.slotsBusy} of ${capacity.slotsTotal}`}
        />
        <Fact label="Queued jobs" value={String(capacity.queued)} />
        <Fact label="Running jobs" value={String(capacity.inProgress)} />
        <Fact
          label="Queued with no free slot"
          value={String(capacity.waiting)}
        />
      </dl>
    </section>
  );
}

function RunnerLine(props: { runner: RunnerRow }) {
  const { runner } = props;
  const flag =
    runner.orphan === null
      ? runner.unhealthy
        ? 'unhealthy'
        : 'ok'
      : `orphan: ${runner.orphan.reason}`;
  return (
    <tr>
      <td data-primary>{runner.name}</td>
      <td data-label="Status">{runner.busy ? 'busy' : runner.status}</td>
      <td data-label="Node">{runner.nodeLabel ?? 'unknown'}</td>
      <td data-label="Repository">{runner.repository ?? 'organization'}</td>
      <td data-label="Health">{flag}</td>
    </tr>
  );
}

function Runners(props: { runners: readonly RunnerRow[] }) {
  return (
    <section class="card mb-6 overflow-x-auto" aria-label="Runners">
      <h2 class="px-5 pt-4 text-base font-semibold">Runners</h2>
      {props.runners.length === 0 ? (
        <p class="px-5 py-6 text-fg-2">GitHub lists no Fleet runners.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Runner</th>
              <th scope="col">Status</th>
              <th scope="col">Node</th>
              <th scope="col">Repository</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {props.runners.map((runner) => (
              <RunnerLine key={runner.id} runner={runner} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function JobLine(props: { job: JobRow }) {
  const { job } = props;
  return (
    <tr>
      <td data-primary>
        {job.htmlUrl === null ? (
          job.name
        ) : (
          <a href={job.htmlUrl} rel="noreferrer noopener">
            {job.name}
          </a>
        )}
      </td>
      <td data-label="Repository">{job.repository}</td>
      <td data-label="Status">
        {job.status === 'completed'
          ? (job.conclusion ?? 'completed')
          : job.status}
      </td>
      <td data-label="Queued for">{formatDuration(job.queuedSeconds)}</td>
      <td data-label="Ran for">{formatDuration(job.runSeconds)}</td>
      <td data-label="Node">
        {job.nodeLabel ?? '-'}
        {job.runnerName === null
          ? ''
          : ` (${job.runnerName.split('-').slice(-2).join('-')})`}
      </td>
      <td data-label="Report">
        {job.reportUrl === null ? null : (
          <a href={job.reportUrl}>Report issue</a>
        )}
      </td>
    </tr>
  );
}

function Jobs(props: { jobs: readonly JobRow[] }) {
  return (
    <section class="card overflow-x-auto" aria-label="Jobs">
      <h2 class="px-5 pt-4 text-base font-semibold">Jobs</h2>
      {props.jobs.length === 0 ? (
        <p class="px-5 py-6 text-fg-2">No jobs have been recorded.</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Repository</th>
              <th scope="col">Status</th>
              <th scope="col">Queued for</th>
              <th scope="col">Ran for</th>
              <th scope="col">Node and slot</th>
              <th scope="col">
                <span class="sr-only">Report</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.jobs.map((job) => (
              <JobLine key={job.id} job={job} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The server-rendered page: status, capacity, runners and jobs. The console adds the forms. */
export function RunnersBody(props: {
  view: RunnersView;
  jobs: readonly JobRow[];
}) {
  return (
    <div>
      <Status view={props.view} />
      <Runners runners={props.view.runners} />
      <Jobs jobs={props.jobs} />
    </div>
  );
}

export function UnavailableBody() {
  return (
    <section class="card p-5">
      <p>The GitHub integration is not available in this mode.</p>
    </section>
  );
}
