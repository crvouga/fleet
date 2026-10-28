/** @jsxImportSource react */
import {
  Alert,
  Anchor,
  Button,
  CopyButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { ErrorNotice, PageHeading } from '@pkgs/admin-ui/components';
import { useCallback, useEffect, useState } from 'react';
import type { ReportView } from '../issues/views';
import { readJson, sendJson } from './runners-api';
import type { ConsoleState } from './model';
import { navigate } from './router';

type Loaded = { view: ReportView; persisted: boolean };

function targetBody(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    ['kind', 'node', 'event', 'job', 'operation', 'request']
      .map((key) => [key, params.get(key)] as const)
      .filter(([, value]) => value)
  ) as Record<string, string>;
}

/** The report for `?draft=<id>`, or a fresh preview of the target in the address. */
function useReport(params: URLSearchParams) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState('');
  const draft = params.get('draft');
  const key = params.toString();
  const load = useCallback(async () => {
    try {
      setLoaded(
        draft
          ? {
              view: await readJson<ReportView>(`/v1/issues/${draft}`),
              persisted: true,
            }
          : await sendJson<ReportView & { persisted: boolean }>(
              'POST',
              '/v1/issues/preview',
              targetBody(params)
            ).then((view) => ({ view, persisted: view.persisted }))
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);
  return { loaded, error, load };
}

function Banner({ view }: { view: ReportView }) {
  const number = view.githubIssueNumber ? `#${view.githubIssueNumber}` : '';
  if (view.status === 'created')
    return (
      <Alert
        color="teal"
        role="status"
        title={`Filed as GitHub issue ${number}`}
      >
        {view.githubIssueUrl && (
          <Anchor
            href={view.githubIssueUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open the issue
          </Anchor>
        )}
      </Alert>
    );
  if (view.status === 'queued')
    return (
      <Alert color="yellow" role="status" title="Queued for retry">
        GitHub could not take the report yet (attempt {view.attempts}). It will
        be retried
        {view.nextAttemptAt
          ? ` after ${new Date(view.nextAttemptAt).toLocaleString()}`
          : ''}
        . {view.lastError}
      </Alert>
    );
  if (view.status === 'failed')
    return (
      <Alert color="red" role="alert" title="The report was not filed">
        {view.lastError} The preview below is intact; fix the cause and try
        again, or copy it.
      </Alert>
    );
  if (view.status === 'duplicate')
    return (
      <Alert color="teal" role="status" title="Already reported">
        {view.githubIssueUrl
          ? `An open issue already covers this (${number}); nothing new was created.`
          : 'This report repeats one that is no longer open; file it again if it still happens.'}
      </Alert>
    );
  return null;
}

function DuplicateHint({ view }: { view: ReportView }) {
  if (!view.duplicate || view.status === 'duplicate') return null;
  return (
    <Alert color="yellow" role="status" title="Looks like a duplicate">
      {view.duplicate.url
        ? `GitHub issue #${view.duplicate.number} already covers this; creating the report will link to it instead of opening a new issue.`
        : 'A report for this failure is already queued; creating another will reuse it.'}
    </Alert>
  );
}

function Actions({
  view,
  readOnly,
  persisted,
  onCreated,
}: {
  view: ReportView;
  readOnly: boolean;
  persisted: boolean;
  onCreated: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sendable =
    persisted &&
    !readOnly &&
    view.id &&
    view.submission.configured &&
    (view.status === 'draft' || view.status === 'failed');
  async function create() {
    setBusy(true);
    setError('');
    try {
      await sendJson('POST', '/v1/issues', { draftId: view.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy(false);
      if (view.id) onCreated(view.id);
    }
  }
  return (
    <Stack gap="xs">
      <ErrorNotice message={error} />
      {readOnly && (
        <Text size="sm" c="dimmed">
          This is a read-only preview. Only administrators can create the GitHub
          issue.
        </Text>
      )}
      <Group>
        {sendable && (
          <Button loading={busy} onClick={() => void create()}>
            Create GitHub issue
          </Button>
        )}
        {view.submission.newIssueUrl && (
          <Button
            component="a"
            variant="default"
            href={view.submission.newIssueUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Open prefilled GitHub issue
          </Button>
        )}
        <CopyButton value={view.body}>
          {({ copied, copy }) => (
            <Button variant="default" onClick={copy}>
              {copied ? 'Copied' : 'Copy report'}
            </Button>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
}

/** `/report-issue`: preview for everyone signed in, "Create GitHub issue" for administrators. */
export function ReportIssue({
  state,
  path,
}: {
  state: ConsoleState;
  path: string;
}) {
  const params = new URLSearchParams(path.split('?')[1]);
  const { loaded, error, load } = useReport(params);
  const view = loaded?.view;
  return (
    <Stack gap="lg">
      <PageHeading
        title="Report an issue"
        description="Review what will be sent. Secrets are removed first."
      />
      <ErrorNotice message={error} retry={() => void load()} />
      {!view && !error && <Loader aria-label="Building the report" />}
      {view && (
        <Paper withBorder p="lg">
          <Stack>
            <Banner view={view} />
            <DuplicateHint view={view} />
            <Title order={2} size="h4" style={{ overflowWrap: 'anywhere' }}>
              {view.title}
            </Title>
            {!view.submission.configured && view.submission.reason && (
              <Alert color="yellow" role="status">
                {view.submission.reason}
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              {view.redaction.length === 0
                ? 'No secrets were detected. The report still passed the redaction filter.'
                : `Removed before showing: ${view.redaction.map((hit) => `${hit.class} (${hit.count})`).join(', ')}.`}
              {view.truncated.length > 0 &&
                ` Shortened to fit GitHub's size limit: ${view.truncated.join(', ')}.`}
            </Text>
            <Actions
              view={view}
              readOnly={state.role === 'viewer'}
              persisted={loaded.persisted}
              onCreated={(id) => navigate(`/report-issue?draft=${id}`, true)}
            />
            <ScrollArea.Autosize mah={512}>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  fontSize: 12,
                }}
              >
                {view.body}
              </pre>
            </ScrollArea.Autosize>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
