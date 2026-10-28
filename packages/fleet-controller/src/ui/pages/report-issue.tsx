import type { Child } from 'hono/jsx';

import type { ReportView } from '../../issues/views';
import { CopyButton } from '../components/copy';

const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' } as const;

function Notice(props: { tone: keyof typeof TONE; children?: Child }) {
  return (
    <p class={`mb-4 text-sm font-medium ${TONE[props.tone]}`} role="status">
      {props.children}
    </p>
  );
}

interface Line {
  readonly tone: keyof typeof TONE;
  readonly text: string;
}

function lineFor(view: ReportView): Line | null {
  const number =
    view.githubIssueNumber === null ? '' : `#${view.githubIssueNumber}`;
  switch (view.status) {
    case 'created':
      return { tone: 'ok', text: `Filed as GitHub issue ${number}.` };
    case 'queued': {
      const next =
        view.nextAttemptAt === null ? '' : ` after ${view.nextAttemptAt}`;
      return {
        tone: 'warn',
        text: `GitHub could not take the report yet, so it is queued (attempt ${view.attempts}). It will be retried${next}. ${view.lastError ?? ''}`,
      };
    }
    case 'failed':
      return {
        tone: 'bad',
        text: `The report was not filed. ${view.lastError ?? ''} The preview below is intact; fix the cause and try again, or copy it.`,
      };
    case 'duplicate':
      return {
        tone: 'ok',
        text:
          view.githubIssueUrl === null
            ? 'This report repeats one that is no longer open; file it again if it still happens.'
            : `An open issue already covers this (${number}); nothing new was created.`,
      };
    default:
      return null;
  }
}

/** What happened to this report so far, in a sentence. */
function Status(props: { view: ReportView }) {
  const line = lineFor(props.view);
  if (line === null) return null;
  const { githubIssueUrl: url, status } = props.view;
  return (
    <Notice tone={line.tone}>
      {line.text}
      {status === 'created' && url !== null ? (
        <>
          {' '}
          <a href={url} rel="noreferrer noopener">
            Open it
          </a>
        </>
      ) : null}
    </Notice>
  );
}

function Duplicate(props: { view: ReportView }) {
  const link = props.view.duplicate;
  if (link === null || props.view.status === 'duplicate') return null;
  return (
    <Notice tone="warn">
      {link.url === null
        ? 'A report for this failure is already queued; creating another will reuse it.'
        : `This looks like a duplicate of GitHub issue #${link.number ?? ''}; creating the report will link to it instead of opening a new issue.`}
    </Notice>
  );
}

function Redaction(props: { view: ReportView }) {
  const { redaction, truncated } = props.view;
  return (
    <div class="mb-4 text-sm text-fg-2">
      <p>
        {redaction.length === 0
          ? 'No secrets were detected. The report still passed the redaction filter.'
          : `Removed before showing: ${redaction.map((hit) => `${hit.class} (${hit.count})`).join(', ')}.`}
      </p>
      {truncated.length === 0 ? null : (
        <p>{`Shortened to fit GitHub's size limit: ${truncated.join(', ')}.`}</p>
      )}
    </div>
  );
}

function CreateForm(props: { view: ReportView; readOnly: boolean }) {
  const { view } = props;
  if (props.readOnly)
    return (
      <p class="mb-4 text-sm text-fg-2">
        This is a read-only preview. Only administrators can create the GitHub
        issue.
      </p>
    );
  const sendable =
    view.id !== null &&
    (view.status === 'draft' || view.status === 'failed') &&
    view.submission.configured;
  return (
    <div class="mb-4 flex flex-wrap items-center gap-3">
      {sendable ? (
        <form method="post" action="/report-issue">
          <input type="hidden" name="draft" value={view.id ?? ''} />
          <button type="submit" class="btn btn-primary">
            Create GitHub issue
          </button>
        </form>
      ) : null}
      {view.submission.newIssueUrl === null ? null : (
        <a
          class="btn"
          href={view.submission.newIssueUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open prefilled GitHub issue
        </a>
      )}
    </div>
  );
}

/** The preview: what would be filed, what was removed, and the one button that files it. */
export function ReportIssueBody(props: {
  view: ReportView;
  readOnly: boolean;
}) {
  const { view } = props;
  return (
    <section class="card mb-6 p-5" aria-label="Issue report">
      <Status view={view} />
      <Duplicate view={view} />
      <h2 class="break-words text-base font-semibold">{view.title}</h2>
      {view.submission.configured || view.submission.reason === null ? null : (
        <p class="mt-2 text-sm text-warn" role="status">
          {view.submission.reason}
        </p>
      )}
      <div class="mt-3">
        <Redaction view={view} />
        <CreateForm view={view} readOnly={props.readOnly} />
      </div>
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">Report (Markdown)</h3>
        <CopyButton text={view.body} label="Copy report" />
      </div>
      <pre class="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-muted p-3 font-mono text-xs">
        {view.body}
      </pre>
    </section>
  );
}
