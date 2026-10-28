import { reportUrl } from '../../issues/links';
import type { IssuesRuntime } from '../../issues/runtime';
import type { IssueLink, IssueTarget } from '../../issues/types';
import { attentionFor } from '../lib/attention';
import type { FleetEntry } from '../lib/fleet-data';
import { cx } from '../lib/tw';

/**
 * The same "Report issue" action everywhere a failure is shown. It is a plain
 * link to the preview page, so it works without JavaScript; the preview, not
 * this link, decides what is gathered and who may file it.
 */
export function ReportIssueLink(props: {
  target: Partial<IssueTarget> & { kind: IssueTarget['kind'] };
  label?: string;
  class?: string;
}) {
  return (
    <a
      class={cx('text-sm', props.class)}
      href={reportUrl(props.target)}
      rel="nofollow"
    >
      {props.label ?? 'Report issue'}
    </a>
  );
}

/** Where a failure was already reported: the GitHub issue, or the queued report. */
export function IssueBadge(props: { link: IssueLink }) {
  const { link } = props;
  if (link.url !== null && link.number !== null)
    return (
      <a
        class="text-sm font-medium"
        href={link.url}
        rel="noreferrer noopener"
        title="Reported on GitHub"
      >
        {`Issue #${link.number}`}
      </a>
    );
  return (
    <a
      class="text-sm text-warn"
      href={`/report-issue?draft=${encodeURIComponent(link.id)}`}
    >
      Report queued
    </a>
  );
}

/** On a warning or error row: the report link, and the issue it was already reported in. */
export function EventReport(props: {
  event: {
    readonly id: number;
    readonly nodeId: string | null;
    readonly severity: string;
  };
  link: IssueLink | undefined;
}) {
  const { event } = props;
  if (event.severity === 'info') return null;
  const target =
    event.nodeId === null
      ? { kind: 'controller' as const, eventId: event.id }
      : { kind: 'node' as const, nodeId: event.nodeId, eventId: event.id };
  return (
    <span class="flex shrink-0 flex-col items-end gap-1">
      {props.link === undefined ? null : <IssueBadge link={props.link} />}
      <ReportIssueLink target={target} />
    </span>
  );
}

/** Under a node's header: report a failure on this node, and where earlier ones were filed. */
function ReportStrip(props: {
  entry: FleetEntry;
  links: readonly IssueLink[];
}) {
  const { view } = props.entry;
  const { links } = props;
  const failing =
    view.convergence === 'blocked' ||
    attentionFor(props.entry).some((item) => item.level !== 'info');
  const installer = view.status === 'pending';
  if (!failing && !installer && links.length === 0) return null;
  return (
    <p class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1">
      {failing || installer ? (
        <ReportIssueLink
          target={{ kind: installer ? 'installer' : 'node', nodeId: view.id }}
          label={installer ? 'Report installer problem' : 'Report issue'}
        />
      ) : null}
      {links.map((link) => (
        <IssueBadge key={link.id} link={link} />
      ))}
    </p>
  );
}

/** Looks up the node's open reports, then shows the strip. */
export async function NodeReportStrip(props: {
  entry: FleetEntry;
  issues: IssuesRuntime | undefined;
}) {
  const links =
    (await props.issues?.store.linksForNode(props.entry.view.id)) ?? [];
  return <ReportStrip entry={props.entry} links={links} />;
}
