import type { AppDeps } from '../deps';

import { fingerprintOf } from './fingerprint';
import { gatherDiagnostics, type Gathered } from './gather';
import { safeWord } from './markdown';
import { createRedactor } from './redact';
import { BODY_LIMIT, renderBody } from './render';
import type { Diagnostics, IssueDraft, IssueTarget } from './types';

export interface BuildOptions {
  /** Secret values the process knows; removed from everything. */
  readonly literals?: readonly string[];
  readonly limit?: number;
}

const SHORT_ID = 12;
const TITLE_MAX = 120;

/** What a stored report's snapshot holds on top of the diagnostics. */
export interface SnapshotMeta {
  readonly redaction: IssueDraft['redaction'];
  readonly truncated: readonly string[];
}

function titleOf(d: Diagnostics, role: string | null): string {
  const node = d.identifiers['node'] as Record<string, unknown> | undefined;
  const workload = d.identifiers['workload'] as
    Record<string, unknown> | undefined;
  const host =
    typeof node?.['hostname'] === 'string' ? safeWord(node['hostname']) : '';
  const repo =
    typeof workload?.['repository'] === 'string'
      ? safeWord(workload['repository'], 60)
      : '';
  const where = [
    role === null ? '' : `role ${safeWord(role, 20)}`,
    host === '' ? '' : `node ${host}`,
    repo === '' ? '' : repo,
  ].filter(Boolean);
  const suffix = where.length === 0 ? '' : ` (${where.join(', ')})`;
  return `[Fleet ${d.kind}] ${d.classification.summary}${suffix}`.slice(
    0,
    TITLE_MAX
  );
}

/**
 * Pure: gathered evidence in, redacted draft out. The snapshot is redacted by
 * key and by value, the Markdown is rendered from that snapshot and redacted
 * again, and the fingerprint is computed from the redacted message.
 */
export function draftFrom(
  gathered: Extract<Gathered, { ok: true }>,
  options: BuildOptions = {}
): IssueDraft {
  const { node } = gathered;
  const aliases = new Map<string, string>(
    node === null ? [] : [[node.id, `node:${node.id.slice(0, SHORT_ID)}`]]
  );
  const redactor = createRedactor({
    literals: options.literals ?? [],
    aliases,
  });
  const safe = redactor.deep(gathered.diagnostics) as Diagnostics;
  const fingerprint = fingerprintOf({
    kind: safe.kind,
    classification: safe.classification.code,
    message: safe.message,
    role: gathered.role,
    closure: gathered.closure,
    component: safe.classification.component,
  });
  const rendered = renderBody(safe, fingerprint, options.limit ?? BODY_LIMIT);
  const body = redactor.text(rendered.body);
  const title = redactor.text(titleOf(safe, gathered.role));
  const requestId = safe.target.requestId ?? null;
  return {
    kind: safe.kind,
    nodeId: node?.id ?? null,
    title,
    body,
    fingerprint,
    classification: safe.classification,
    correlationId: requestId,
    snapshot: safe,
    redaction: redactor.summary(),
    truncated: rendered.truncated,
  };
}

export type BuildResult =
  | { readonly ok: true; readonly draft: IssueDraft }
  | { readonly ok: false; readonly error: string };

/** Gathers, redacts and renders a report for a target. */
export async function buildDraft(
  deps: AppDeps,
  target: IssueTarget,
  options: BuildOptions = {}
): Promise<BuildResult> {
  const gathered = await gatherDiagnostics(deps, target);
  if (!gathered.ok) return gathered;
  return { ok: true, draft: draftFrom(gathered, options) };
}
