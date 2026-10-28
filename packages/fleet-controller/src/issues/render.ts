import { markerFor } from './fingerprint';
import { fitSections, inline, oneLine, type Section } from './markdown';
import type { Diagnostics, LogLine, TimelineEntry } from './types';

/** GitHub rejects bodies over 65,536 characters; stay clear of it. */
export const BODY_LIMIT = 60_000;
const JSON_BUDGET = 22_000;
const SHRINKABLE = [
  'timeline',
  'logs',
  'reconcileHistory',
  'actions',
  'testFailures',
] as const;

type Rec = Readonly<Record<string, unknown>>;

function field(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function bullets(record: Rec | null, hideEmpty = false): string[] {
  if (record === null) return ['- not available'];
  return Object.entries(record)
    .filter(([, value]) => !hideEmpty || !isEmpty(value))
    .map(([key, value]) => `- ${key}: ${inline(field(value))}`);
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  );
}

function timelineLine(entry: TimelineEntry): string {
  const severity = entry.severity === undefined ? '' : ` (${entry.severity})`;
  return `- ${entry.at} ${entry.source} ${inline(entry.kind, 60)}${severity}: ${inline(entry.message, 240)}`;
}

function logLine(line: LogLine): string {
  const at = line.at === null ? '' : `${line.at} `;
  return oneLine(`${at}[${line.level}] ${line.source}: ${line.message}`, 400);
}

function summary(d: Diagnostics): Section {
  const node = d.identifiers['node'] as Rec | undefined;
  return {
    title: 'Summary',
    truncatable: false,
    lines: [
      `${d.classification.summary}.`,
      '',
      `- Reported: ${inline(d.generatedAt)}`,
      `- Kind: ${inline(d.kind)}`,
      ...(node === undefined
        ? []
        : [
            `- Node: ${inline(field(node['label']))} (${inline(field(node['shortId']))}), assigned role ${inline(field(node['assignedRole']))}, status ${inline(field(node['status']))}`,
          ]),
      `- Error: ${inline(d.message, 500)}`,
    ],
  };
}

function classification(d: Diagnostics): Section {
  return {
    title: 'Classification',
    truncatable: false,
    lines: [
      `- Code: ${inline(d.classification.code)}`,
      `- Failing component: ${inline(d.classification.component)}`,
      ...bullets(d.correlation, true).map((line) =>
        line.replace('- ', '- correlation ')
      ),
    ],
  };
}

function environment(d: Diagnostics): Section {
  return {
    title: 'Environment and versions',
    lines: [
      '**Versions**',
      ...bullets(d.versions),
      '',
      '**Identifiers**',
      ...Object.entries(d.identifiers).map(
        ([name, value]) => `- ${name}: ${inline(field(value), 500)}`
      ),
      '',
      '**Hardware and environment**',
      ...bullets(d.hardware),
    ],
  };
}

function desiredObserved(d: Diagnostics): Section[] {
  return [
    {
      title: 'Desired vs observed',
      lines: [
        '**Desired** (what the controller wants this node to run)',
        ...bullets(d.desired),
        '',
        '**Observed** (what the node reported)',
        ...bullets(d.observed),
      ],
    },
    {
      title: 'Effective configuration (secrets removed)',
      lines: JSON.stringify(d.effectiveConfig, null, 2).split('\n'),
      fence: 'json',
    },
  ];
}

function timeline(d: Diagnostics): Section[] {
  const history = d.reconcileHistory.map(
    (row) => `- ${inline(JSON.stringify(row), 400)}`
  );
  return [
    {
      title: 'Timeline',
      lines:
        d.timeline.length === 0
          ? ['- no events recorded']
          : d.timeline.map(timelineLine),
    },
    {
      title: 'Reconciliation history',
      lines: history.length === 0 ? ['- none recorded'] : history,
    },
  ];
}

function logs(d: Diagnostics): Section {
  const failures = d.testFailures.map(
    (row) => `- ${inline(JSON.stringify(row), 400)}`
  );
  return {
    title: 'Logs and errors',
    lines: d.logs.length === 0 ? ['(no logs recorded)'] : d.logs.map(logLine),
    fence: 'text',
    ...(failures.length === 0
      ? {}
      : { intro: ['**Related failures**', ...failures, '', '**Logs**'] }),
  };
}

function actions(d: Diagnostics): Section {
  return {
    title: 'Actions already attempted',
    lines:
      d.actions.length === 0
        ? ['- none recorded']
        : d.actions.map(timelineLine),
  };
}

function reproduction(d: Diagnostics): Section {
  return {
    title: 'Reproduction',
    lines:
      d.reproduction === null
        ? [
            'Not available.',
            ...d.gaps
              .filter((g) => g.startsWith('Reproduction'))
              .map((g) => `- ${g}`),
          ]
        : d.reproduction.map((step, i) => `${i + 1}. ${inline(step, 400)}`),
  };
}

const CRITERIA: Readonly<Record<string, string>> = {
  installer:
    'The installer completes this step on the same hardware without the reported failure.',
  node: 'The node reaches reconcile phase `converged` on its desired revision and stays online.',
  controller:
    'The same request no longer fails and the controller logs no unhandled error for it.',
  workload: 'The same job succeeds on a Fleet runner of this role.',
};

function area(d: Diagnostics): Section[] {
  return [
    {
      title: 'Suspected area (where to look in the repo)',
      truncatable: false,
      lines: d.suspectedArea.map((path) => `- ${inline(path)}`),
    },
    {
      title: 'Acceptance criteria',
      truncatable: false,
      lines: [
        `- [ ] ${CRITERIA[d.kind]}`,
        `- [ ] A regression test reproduces ${inline(d.classification.code)} and passes (bun test under packages/fleet-controller/test, or pytest under packages/fleet/tests).`,
        '- [ ] `bun run check` passes (Linux: also `bun run check:nix`).',
        '- [ ] No credential, token or SQL parameter is logged or added to a report (AGENTS.md).',
      ],
    },
  ];
}

/** Valid JSON that fits the budget: the long arrays are cut, and the cuts are recorded. */
export function shrinkJson(d: Diagnostics, budget = JSON_BUDGET): string {
  const copy: Record<string, unknown> = { ...d };
  const cuts: Record<string, number> = {};
  const render = () =>
    JSON.stringify(
      { ...copy, ...(Object.keys(cuts).length > 0 ? { truncated: cuts } : {}) },
      null,
      2
    );
  let text = render();
  for (let pass = 0; pass < 12 && text.length > budget; pass += 1) {
    for (const key of SHRINKABLE) {
      const list = copy[key] as unknown[];
      if (list.length <= 1) continue;
      const keep = Math.floor(list.length / 2);
      cuts[key] = (cuts[key] ?? 0) + list.length - keep;
      copy[key] = list.slice(0, keep);
    }
    text = render();
  }
  if (text.length > budget)
    return JSON.stringify(
      {
        ...d,
        effectiveConfig: null,
        desired: null,
        timeline: [],
        logs: [],
        reconcileHistory: [],
        actions: [],
        testFailures: [],
        truncated: 'all long fields',
      },
      null,
      2
    ).slice(0, budget);
  return text;
}

export interface Rendered {
  readonly body: string;
  readonly truncated: readonly string[];
}

export function renderBody(
  d: Diagnostics,
  fingerprint: string,
  limit = BODY_LIMIT
): Rendered {
  const json = shrinkJson(d);
  const head = [
    markerFor(fingerprint),
    '> Filed by the Fleet controller for an AI coding agent. Secrets, tokens and emails were removed before this was written.',
    '',
  ].join('\n');
  const tail: Section = {
    title: 'Diagnostics (JSON)',
    truncatable: false,
    lines: json.split('\n'),
    fence: 'json',
  };
  const fingerprintSection: Section = {
    title: 'Fingerprint',
    truncatable: false,
    lines: [`\`${fingerprint}\``],
  };
  const sections = [
    summary(d),
    classification(d),
    environment(d),
    ...desiredObserved(d),
    ...timeline(d),
    logs(d),
    actions(d),
    reproduction(d),
    ...area(d),
    tail,
    fingerprintSection,
  ];
  const fitted = fitSections(head, sections, limit);
  return { body: fitted.text, truncated: fitted.truncated };
}
