import { shaped } from '../contract/skeleton';

/** A loose JSON object: these are test payloads that tests adjust field by field. */
type Json = ReturnType<typeof JSON.parse>;

const slug = (fullName: string) => ({
  full_name: fullName,
  name: fullName.split('/')[1] ?? fullName,
  owner: { login: fullName.split('/')[0] ?? fullName },
});

/**
 * A `workflow_job` webhook delivery as GitHub sends it: the full payload of the
 * published schema (`webhook-workflow-job-<action>`), with the fields the
 * controller reads set. The contract tests validate it against that schema.
 */
export function workflowJob(over: Json = {}, action = 'queued'): Json {
  const done = action === 'completed';
  return shaped(`webhook-workflow-job-${action.replace('_', '-')}`, {
    action,
    repository: slug('acme/app'),
    workflow_job: {
      id: 501,
      run_id: 90,
      name: 'test',
      status: action === 'completed' ? 'completed' : action,
      conclusion: action === 'completed' ? 'success' : null,
      labels: ['self-hosted', 'ci'],
      runner_id: null,
      runner_name: null,
      html_url: 'https://github.com/acme/app/actions/runs/90/job/501',
      created_at: '2026-10-14T11:58:00Z',
      // GitHub sends started_at for a queued job too: its creation time.
      started_at: '2026-10-14T11:58:00Z',
      completed_at: done ? '2026-10-14T12:00:00Z' : null,
      ...over,
    },
  });
}

/** A `workflow_run` webhook delivery (`webhook-workflow-run-<action>`). */
export function workflowRun(action = 'completed', over: Json = {}): Json {
  return shaped(`webhook-workflow-run-${action.replace('_', '-')}`, {
    action,
    repository: slug('acme/app'),
    workflow_run: { id: 1, status: action, ...over },
  });
}

/** The `ping` GitHub sends when a webhook is created. */
export function ping(): Json {
  return shaped('webhook-ping', { zen: 'Keep it logically awesome.' });
}
