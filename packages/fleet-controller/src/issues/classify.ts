import type { Classification, IssueKind } from './types';

interface Rule {
  readonly test: RegExp;
  readonly code: string;
  readonly component: string;
  readonly summary: string;
}

/** What a failure is called, in order: the first rule that matches `eventKind message` wins. */
const RULES: readonly Rule[] = [
  {
    test: /\brollback\b|rolled back|health ?check failed/i,
    code: 'rollback',
    component: 'fleet-sync',
    summary: 'Node rolled back after a failed update',
  },
  {
    test: /FLEET_SECRETS_RECIPIENT_MISSING|not a recipient/i,
    code: 'secrets-recipient-missing',
    component: 'secrets',
    summary: 'Node is not a recipient of the encrypted secrets',
  },
  {
    test: /reconcile_blocked|\bblocked\b.*FLEET_|FLEET_[A-Z_]+/i,
    code: 'reconcile-blocked',
    component: 'fleet-sync',
    summary: 'Node reconcile is blocked',
  },
  {
    test: /units_failed|failed units?|\.service\b.*failed/i,
    code: 'unit-failed',
    component: 'node-services',
    summary: 'Systemd units failed on the node',
  },
  {
    test: /\boffline\b|has not reported|not reported for/i,
    code: 'node-offline',
    component: 'fleet-agent',
    summary: 'Node stopped reporting',
  },
  {
    test: /disk_high|disk .*full|no space left/i,
    code: 'disk-pressure',
    component: 'node-storage',
    summary: 'Node disk is nearly full',
  },
  {
    test: /credential_|credential rotation|rotate/i,
    code: 'credential',
    component: 'credentials',
    summary: 'Node credential problem',
  },
  {
    test: /operation_failed|operation .*failed|\bfailed\b.*(drain|restart|replace|decommission)/i,
    code: 'operation-failed',
    component: 'controller-operations',
    summary: 'A node operation failed',
  },
  {
    test: /checksum|sha256|release is broken|image changed/i,
    code: 'installer-checksum',
    component: 'installer',
    summary: 'Installer image did not match its checksum',
  },
  {
    test: /urlerror|timed out|network|getaddrinfo|connection (?:reset|refused)/i,
    code: 'network',
    component: 'network',
    summary: 'Network failure',
  },
  {
    test: /permission denied|access is denied|administrator|elevat/i,
    code: 'installer-privilege',
    component: 'installer',
    summary: 'Installer lacked administrator permission',
  },
  {
    test: /boot layout|bootstrap|installer/i,
    code: 'installer-failure',
    component: 'installer',
    summary: 'Installer step failed',
  },
  {
    test: /conclusion|job .*failed|\bfailure\b|cancelled|timed_out/i,
    code: 'ci-job-failed',
    component: 'runner',
    summary: 'A CI job failed on a Fleet runner',
  },
  {
    test: /internal|unhandled|exception|TypeError|RangeError|5\d\d/i,
    code: 'controller-error',
    component: 'controller',
    summary: 'Controller error',
  },
];

const FALLBACK: Readonly<Record<IssueKind, Classification>> = {
  installer: {
    code: 'installer-failure',
    component: 'installer',
    summary: 'Installer step failed',
  },
  node: {
    code: 'node-problem',
    component: 'fleet-agent',
    summary: 'Node problem',
  },
  controller: {
    code: 'controller-error',
    component: 'controller',
    summary: 'Controller error',
  },
  workload: {
    code: 'ci-job-failed',
    component: 'runner',
    summary: 'A CI job failed on a Fleet runner',
  },
};

/** The kind constrains the component, so a node's "failed" is never a CI job's. */
const KIND_PREFERS: Readonly<Record<IssueKind, ReadonlySet<string>>> = {
  installer: new Set(['installer', 'network']),
  node: new Set([
    'fleet-sync',
    'secrets',
    'node-services',
    'fleet-agent',
    'node-storage',
    'credentials',
    'controller-operations',
    'network',
  ]),
  controller: new Set(['controller', 'controller-operations', 'credentials']),
  workload: new Set(['runner', 'network', 'node-services']),
};

/** Names a failure from the event kind and message. Pure and total: it always answers. */
export function classify(
  kind: IssueKind,
  eventKind: string | null,
  message: string
): Classification {
  const subject = `${eventKind ?? ''} ${message}`;
  const allowed = KIND_PREFERS[kind];
  for (const rule of RULES) {
    if (allowed.has(rule.component) && rule.test.test(subject))
      return {
        code: rule.code,
        component: rule.component,
        summary: rule.summary,
      };
  }
  return FALLBACK[kind];
}

/** Where in the repository a developer should look first, by component. */
const AREAS: Readonly<Record<string, readonly string[]>> = {
  'fleet-sync': [
    'packages/fleet/scripts/fleet-sync.sh',
    'packages/fleet/scripts/boot-health.sh',
    'packages/fleet/scripts/recovery.py',
    "ARCHITECTURE.md (the node's two loops)",
  ],
  secrets: [
    'packages/fleet/scripts/fleet-keys.py',
    'packages/fleet/secrets',
    'packages/fleet/scripts/fleet_target.py',
  ],
  'node-services': [
    'packages/fleet/modules',
    'packages/fleet/scripts/agent.py',
  ],
  'fleet-agent': [
    'packages/fleet/scripts/agent.py',
    'packages/fleet-controller/src/routes/node-routes.ts',
    'packages/fleet-controller/src/domain/status.ts',
  ],
  'node-storage': [
    'packages/fleet/scripts/agent.py',
    'packages/fleet-controller/src/domain/heartbeat-events.ts',
  ],
  credentials: [
    'packages/fleet-controller/src/domain/credential-rotation.ts',
    'packages/fleet/scripts/credential_rotation.py',
  ],
  'controller-operations': [
    'packages/fleet-controller/src/operations',
    'packages/fleet-controller/src/domain/operations.ts',
    'packages/fleet-controller/docs/operations.md',
  ],
  installer: [
    'packages/fleet/wizard/diagnostics.py',
    'packages/fleet/scripts/decide.py',
    'packages/fleet/scripts/bootstrap.sh',
    'packages/fleet/scripts/bootstrap_report.py',
  ],
  network: [
    'packages/fleet/scripts/agent.py',
    'packages/fleet-controller/src/routes/node-routes.ts',
  ],
  runner: [
    'packages/fleet/scripts/runner_job.py',
    'packages/fleet/scripts/runner_control.py',
    'packages/fleet-controller/src/github',
    'packages/fleet-controller/docs/github-runners.md',
  ],
  controller: [
    'packages/fleet-controller/src/app.ts',
    'packages/fleet-controller/src/routes',
    'packages/fleet-controller/PROTOCOL.md',
  ],
};

export function suspectedArea(
  classification: Classification
): readonly string[] {
  return AREAS[classification.component] ?? AREAS['controller']!;
}
