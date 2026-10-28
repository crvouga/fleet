/** @jsxImportSource react */
import { Anchor, Group } from '@mantine/core';
import { useEffect, useState } from 'react';
import { reportUrl } from '../issues/links';
import type { IssueLink, IssueTarget } from '../issues/types';
import { attentionFor } from '../ui/lib/attention';
import type { FleetEntry } from '../ui/lib/fleet-data';

/** The same "Report issue" action as the server pages: a plain link to the preview. */
export function ReportIssueAnchor({
  target,
  label = 'Report issue',
}: {
  target: Partial<IssueTarget> & { kind: IssueTarget['kind'] };
  label?: string;
}) {
  return (
    <Anchor size="sm" href={reportUrl(target)}>
      {label}
    </Anchor>
  );
}

/** Where a failure was already reported: the GitHub issue, or the queued report. */
export function IssueBadge({ link }: { link: IssueLink }) {
  if (link.url && link.number !== null)
    return (
      <Anchor
        size="sm"
        fw={600}
        href={link.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        Issue #{link.number}
      </Anchor>
    );
  return (
    <Anchor size="sm" c="orange" href={`/report-issue?draft=${link.id}`}>
      Report queued
    </Anchor>
  );
}

interface Links {
  node: IssueLink[];
  events: Record<string, IssueLink>;
}

const NONE: Links = { node: [], events: {} };

/**
 * Open reports for a node and for events, read once from the API. Quiet on
 * failure: a missing badge must never break the page that shows it.
 */
export function useIssueLinks(nodeId?: string, eventIds: number[] = []): Links {
  const [links, setLinks] = useState<Links>(NONE);
  const query = new URLSearchParams();
  if (nodeId) query.set('node', nodeId);
  for (const id of eventIds.slice(0, 100)) query.append('event', String(id));
  const text = query.toString();
  useEffect(() => {
    if (!text) return;
    const controller = new AbortController();
    fetch(`/v1/issues/links?${text}`, {
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then((response) => (response.ok ? response.json() : NONE))
      .then((value: Links) => setLinks(value))
      .catch(() => undefined);
    return () => controller.abort();
  }, [text]);
  return links;
}

/** Open reports for the events on screen. */
export function useEventLinks(events: readonly { id: number }[]): Links {
  return useIssueLinks(
    undefined,
    events.map((event) => event.id)
  );
}

/** Report link for an event row (warnings and errors only), with its issue badge. */
export function EventReport({
  event,
  link,
}: {
  event: { id: number; nodeId: string | null; severity: string };
  link: IssueLink | undefined;
}) {
  if (event.severity === 'info') return null;
  return (
    <Group gap="xs">
      {link && <IssueBadge link={link} />}
      <ReportIssueAnchor
        target={
          event.nodeId
            ? { kind: 'node', nodeId: event.nodeId, eventId: event.id }
            : { kind: 'controller', eventId: event.id }
        }
      />
    </Group>
  );
}

/** Under a node's header: report a failure on this node, and where earlier ones were filed. */
export function NodeReportStrip({ entry }: { entry: FleetEntry }) {
  const { view } = entry;
  const links = useIssueLinks(view.id);
  const failing =
    view.convergence === 'blocked' ||
    attentionFor(entry).some((item) => item.level !== 'info');
  const installer = view.status === 'pending';
  if (!failing && !installer && links.node.length === 0) return null;
  return (
    <Group gap="md">
      {(failing || installer) && (
        <ReportIssueAnchor
          target={{ kind: installer ? 'installer' : 'node', nodeId: view.id }}
          label={installer ? 'Report installer problem' : 'Report issue'}
        />
      )}
      {links.node.map((link) => (
        <IssueBadge key={link.id} link={link} />
      ))}
    </Group>
  );
}
