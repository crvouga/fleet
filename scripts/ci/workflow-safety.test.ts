import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Guards for a PUBLIC repository's workflows. Anyone can open a pull request
 * here, so a workflow must never hand a stranger a self-hosted runner, a secret
 * or a write token. Every rule below is asserted on every file in
 * .github/workflows (the template for private consumer repositories lives in
 * packages/fleet/workflows and is deliberately not scanned: it is the one place
 * `self-hosted` belongs). A new exception needs an allow-list entry with a
 * reason, and an entry that stops being needed fails the test, so exceptions
 * cannot rot.
 */

const DIRECTORY = join(import.meta.dirname, '../../.github/workflows');

type Json = Record<string, unknown>;
interface Violation {
  readonly file: string;
  readonly rule: string;
  readonly detail: string;
}

/** Self-hosted runners are allowed in exactly these files, only behind the private-repository guard. */
const SELF_HOSTED_ALLOWED: Readonly<Record<string, string>> = {
  'runner-check.yml':
    'a workflow_call reusable workflow that private consumer repositories call; every job it routes to Fleet runners is guarded by github.event.repository.private, and it never runs here',
};

/**
 * Actions referenced by a mutable tag or branch instead of a commit SHA. Each
 * entry is a known exception with the reason it is acceptable today; pinning
 * them is the recommended hardening (a SHA cannot be moved under us).
 */
const UNPINNED_ALLOWED: Readonly<Record<string, string>> = {
  'actions/*':
    'GitHub-owned actions (checkout, cache, artifacts, setup-python) at a major version tag: same publisher as the runner and the platform, maintained by GitHub, tag moves only within a major version',
  'oven-sh/setup-bun@v2':
    'installs the pinned Bun (bun-version 1.4.4) in ci.yml and publish.yml, which run with contents: read only and no secrets; third party, pin it when a SHA is reviewed',
  'dorny/paths-filter@v4':
    'ci.yml change detection with contents/pull-requests read only and no secrets; third party, pin it when a SHA is reviewed',
  'crvouga/workspace/.github/workflows/publish.yml@main':
    'the repository owner\u2019s own release workflow (shared infrastructure the AGENTS.md allows for release engineering); called only from main after the checks pass, and the only place DEPLOY_DISPATCH_TOKEN is used; pin it to a reviewed SHA when the owner tags releases',
};

/** `workflow_run` workflows run with the base repository's privileges after a fork's run. */
const WORKFLOW_RUN_ALLOWED: Readonly<Record<string, string>> = {
  'fleet-windows-sign.yml':
    'its job requires the triggering run to be a push or dispatch on main from this very repository (head_repository.full_name == github.repository) before it does anything',
};

const HOSTED = /^(ubuntu|windows|macos)-[A-Za-z0-9.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const SAFE_TRIGGERS_FOR_SECRETS = new Set([
  'push',
  'workflow_dispatch',
  'schedule',
  'workflow_call',
]);
const UNTRUSTED =
  /\$\{\{[^}]*\b(github\.head_ref|github\.event\.(pull_request\.(title|body|head\.(ref|label))|issue\.(title|body)|comment\.body|review\.body|head_commit\.(message|author\.(name|email))|commits|discussion\.(title|body)|workflow_run\.(head_branch|display_title|head_commit\.message))|inputs\.[A-Za-z_]+)[^}]*\}\}/;

const record = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};

function triggersOf(doc: Json): Json {
  const on = doc['on'];
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on))
    return Object.fromEntries(on.map((name: unknown) => [String(name), {}]));
  return record(on);
}

function walk(
  value: unknown,
  visit: (text: string, path: string) => void,
  path = ''
) {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value))
    value.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
  else
    for (const [key, item] of Object.entries(record(value)))
      walk(item, visit, `${path}.${key}`);
}

/** Every runner label a job can resolve to, expanding `${{ matrix.* }}`. */
function labelsOf(job: Json): string[] {
  const runsOn = job['runs-on'];
  const matrix = record(record(job['strategy'])['matrix']);
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') {
      const expression = /\$\{\{([^}]*)\}\}/.exec(value);
      out.push(value);
      if (expression?.[1]?.includes('matrix.')) {
        const key = /matrix\.([A-Za-z_]+)/.exec(expression[1])?.[1] ?? '';
        const values = matrix[key];
        if (Array.isArray(values)) values.forEach((v) => out.push(String(v)));
      }
    } else if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === 'object' && value !== null)
      out.push(`group:${JSON.stringify(value)}`);
  };
  add(runsOn);
  return out;
}

const mentionsSelfHosted = (job: Json): boolean =>
  JSON.stringify(job['runs-on'] ?? '')
    .toLowerCase()
    .includes('self-hosted') ||
  labelsOf(job).some((label) => label.toLowerCase().includes('self-hosted'));

function runnerViolations(
  file: string,
  doc: Json,
  used: Set<string>
): Violation[] {
  const found: Violation[] = [];
  for (const [name, raw] of Object.entries(record(doc['jobs']))) {
    const job = record(raw);
    if (job['uses'] !== undefined) continue; // a reusable-workflow call has no runner of its own
    if (mentionsSelfHosted(job)) {
      const guarded = String(job['if'] ?? '').includes(
        'github.event.repository.private'
      );
      if (file in SELF_HOSTED_ALLOWED && guarded)
        used.add(`self-hosted:${file}`);
      else
        found.push({
          file,
          rule: 'no-self-hosted',
          detail: `job ${name} routes to a self-hosted runner${file in SELF_HOSTED_ALLOWED ? ' without the github.event.repository.private guard' : ''}`,
        });
    }
    const labels = labelsOf(job).filter(
      (l) => !l.includes('${{') && !l.toLowerCase().includes('self-hosted')
    );
    for (const label of labels)
      if (!HOSTED.test(label))
        found.push({
          file,
          rule: 'hosted-runners-only',
          detail: `job ${name}: ${label} is not a GitHub-hosted runner label`,
        });
  }
  return found;
}

function triggerViolations(
  file: string,
  doc: Json,
  used: Set<string>
): Violation[] {
  const triggers = triggersOf(doc);
  const found: Violation[] = [];
  if ('pull_request_target' in triggers)
    found.push({
      file,
      rule: 'no-pull_request_target',
      detail:
        'pull_request_target runs fork-controlled input with base-repository privileges',
    });
  if ('workflow_run' in triggers) {
    if (file in WORKFLOW_RUN_ALLOWED) {
      used.add(`workflow_run:${file}`);
      const guarded = Object.values(record(doc['jobs'])).every((job) =>
        String(record(job)['if'] ?? '').includes(
          'head_repository.full_name == github.repository'
        )
      );
      if (!guarded)
        found.push({
          file,
          rule: 'workflow_run-guard',
          detail:
            'every job must require head_repository.full_name == github.repository',
        });
    } else
      found.push({
        file,
        rule: 'no-workflow_run',
        detail: 'workflow_run needs an allow-list entry with a reason',
      });
  }
  return found;
}

function usesViolations(
  file: string,
  doc: Json,
  used: Set<string>
): Violation[] {
  const found: Violation[] = [];
  walk(doc, (text, path) => {
    if (!path.endsWith('.uses')) return;
    if (text.startsWith('./')) return; // first-party, in this repository
    if (text.startsWith('docker://')) {
      if (!text.includes('@sha256:'))
        found.push({
          file,
          rule: 'pinned-actions',
          detail: `${text} is not pinned by digest`,
        });
      return;
    }
    const at = text.lastIndexOf('@');
    const ref = at < 0 ? '' : text.slice(at + 1);
    if (SHA.test(ref)) return;
    const owner = text.split('/')[0] ?? '';
    const key = text in UNPINNED_ALLOWED ? text : `${owner}/*`;
    if (key in UNPINNED_ALLOWED) used.add(`unpinned:${key}`);
    else
      found.push({
        file,
        rule: 'pinned-actions',
        detail: `${text} is not pinned to a 40-hex commit SHA`,
      });
  });
  return found;
}

function permissionViolations(file: string, doc: Json): Violation[] {
  const found: Violation[] = [];
  const top = doc['permissions'];
  const jobs = Object.entries(record(doc['jobs']));
  if (top === undefined)
    for (const [name, job] of jobs)
      if (record(job)['permissions'] === undefined)
        found.push({
          file,
          rule: 'permissions-declared',
          detail: `job ${name} inherits the default token permissions: declare permissions`,
        });
  if (typeof top === 'string' && top.endsWith('-all') && top !== 'read-all')
    found.push({
      file,
      rule: 'least-privilege',
      detail: `top-level permissions: ${top}`,
    });
  for (const [scope, level] of Object.entries(record(top)))
    if (level === 'write')
      found.push({
        file,
        rule: 'least-privilege',
        detail: `top-level ${scope}: write (grant writes to the one job that needs them)`,
      });
  for (const [name, job] of jobs) {
    const own = record(job)['permissions'];
    if (own === 'write-all')
      found.push({
        file,
        rule: 'least-privilege',
        detail: `job ${name} has write-all`,
      });
  }
  return found;
}

function usesSecrets(value: unknown): boolean {
  let found = false;
  walk(value, (text) => {
    if (
      /\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z0-9_]+/.test(text) ||
      text === 'inherit'
    )
      found = true;
  });
  return found;
}

function secretViolations(file: string, doc: Json): Violation[] {
  const triggers = triggersOf(doc);
  const found: Violation[] = [];
  const jobs = Object.entries(record(doc['jobs']));
  const topLevel = usesSecrets({ env: doc['env'], defaults: doc['defaults'] });
  const exposed = Object.keys(triggers).filter(
    (t) => !SAFE_TRIGGERS_FOR_SECRETS.has(t)
  );
  for (const [name, raw] of jobs) {
    const job = record(raw);
    const secrets =
      topLevel ||
      usesSecrets(job['secrets']) ||
      usesSecrets({ ...job, if: undefined });
    if (!secrets) continue;
    const guarded =
      /github\.event_name\s*(!=\s*'pull_request'|==\s*'(push|workflow_dispatch|schedule)')/.test(
        String(job['if'] ?? '')
      );
    for (const trigger of exposed)
      if (!(trigger === 'pull_request' && guarded))
        found.push({
          file,
          rule: 'secrets-not-reachable-from-pull-requests',
          detail: `job ${name} uses secrets in a workflow triggered by ${trigger}${trigger === 'pull_request' ? ' without a github.event_name != pull_request guard' : ''}`,
        });
    if (
      'push' in triggers &&
      record(triggers['push'])['branches'] === undefined
    )
      found.push({
        file,
        rule: 'secrets-only-on-main',
        detail: `job ${name} uses secrets on a push trigger with no branch filter`,
      });
  }
  return found;
}

function injectionViolations(file: string, doc: Json): Violation[] {
  const found: Violation[] = [];
  walk(doc, (text, path) => {
    if (
      (path.endsWith('.run') || path.endsWith('.script')) &&
      UNTRUSTED.test(text)
    )
      found.push({
        file,
        rule: 'no-script-injection',
        detail: `${path} interpolates attacker-influenced input into a script; pass it through env`,
      });
  });
  return found;
}

function violations(
  file: string,
  doc: Json,
  used = new Set<string>()
): Violation[] {
  return [
    ...runnerViolations(file, doc, used),
    ...triggerViolations(file, doc, used),
    ...usesViolations(file, doc, used),
    ...permissionViolations(file, doc),
    ...secretViolations(file, doc),
    ...injectionViolations(file, doc),
  ];
}

const files = readdirSync(DIRECTORY)
  .filter((name) => /\.ya?ml$/.test(name))
  .sort();
const parsed = new Map(
  files.map((name) => [
    name,
    record(parse(readFileSync(join(DIRECTORY, name), 'utf8'))),
  ])
);

describe('workflows of this public repository', () => {
  test('there are workflows to guard', () => {
    expect(files).toEqual(
      expect.arrayContaining(['ci.yml', 'publish.yml', 'runner-check.yml'])
    );
  });

  test('no workflow breaks a rule; every exception is explicit and still needed', () => {
    const used = new Set<string>();
    const found = files.flatMap((name) =>
      violations(name, parsed.get(name) ?? {}, used)
    );
    expect(found).toEqual([]);
    const allowed = [
      ...Object.keys(SELF_HOSTED_ALLOWED).map((f) => `self-hosted:${f}`),
      ...Object.keys(UNPINNED_ALLOWED).map((a) => `unpinned:${a}`),
      ...Object.keys(WORKFLOW_RUN_ALLOWED).map((f) => `workflow_run:${f}`),
    ];
    expect(allowed.filter((entry) => !used.has(entry))).toEqual([]);
  });

  test.each(files)(
    '%s runs only on GitHub-hosted runners, except the guarded reusable workflow',
    (name) => {
      const doc = parsed.get(name) ?? {};
      const selfHosted = Object.values(record(doc['jobs'])).some((job) =>
        mentionsSelfHosted(record(job))
      );
      expect(selfHosted).toBe(name in SELF_HOSTED_ALLOWED);
    }
  );

  test('runner-check.yml is reusable only and every Fleet-routed job is private-only', () => {
    const doc = parsed.get('runner-check.yml') ?? {};
    expect(Object.keys(triggersOf(doc))).toEqual(['workflow_call']);
    for (const job of Object.values(record(doc['jobs'])))
      expect(String(record(job)['if'])).toContain(
        'github.event.repository.private'
      );
  });
});

describe('the new check workflows', () => {
  const expected: Record<string, readonly string[]> = {
    'live-github-contract.yml': ['schedule', 'workflow_dispatch'],
    'post-deploy.yml': ['workflow_dispatch', 'workflow_call'],
  };
  const required = new Set(['live-github-contract.yml']);

  for (const [name, triggers] of Object.entries(expected)) {
    const present = existsSync(join(DIRECTORY, name));
    test(`${name} exists${required.has(name) ? '' : ' or is not part of this change'}`, () => {
      if (required.has(name)) expect(present).toBe(true);
    });
    if (!present) continue;
    const doc = parsed.get(name) ?? {};

    test(`${name} has only ${triggers.join(' and ')} triggers, so a fork can never reach it`, () => {
      expect(Object.keys(triggersOf(doc)).sort()).toEqual([...triggers].sort());
    });
    test(`${name} is hosted, least-privilege and bounded`, () => {
      expect(record(doc['permissions'])['contents']).toBe('read');
      expect(doc['concurrency']).toBeDefined();
      for (const [job, raw] of Object.entries(record(doc['jobs']))) {
        expect(labelsOf(record(raw)).every((l) => HOSTED.test(l))).toBe(true);
        expect([job, record(raw)['timeout-minutes']]).toEqual([
          job,
          expect.any(Number),
        ]);
      }
    });
  }

  test('live-github-contract.yml maps its secret into the one step that needs it, never job or workflow wide', () => {
    const doc = parsed.get('live-github-contract.yml') ?? {};
    expect(usesSecrets({ env: doc['env'] })).toBe(false);
    for (const raw of Object.values(record(doc['jobs']))) {
      const job = record(raw);
      expect(usesSecrets({ env: job['env'] })).toBe(false);
      const steps = (job['steps'] as unknown[]).map(record);
      // The guard step only sees a boolean (`secrets.X != ''`); one step gets the value.
      const withSecret = steps.filter((step) =>
        Object.values(record(step['env'])).some((value) =>
          /^\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}$/.test(String(value))
        )
      );
      expect(withSecret).toHaveLength(1);
      expect(String(withSecret[0]?.['run'])).toContain(
        'live-github-contract.ts'
      );
    }
  });

  test('live-github-contract.yml skips cleanly when unconfigured and never prints secrets', () => {
    const text = readFileSync(
      join(DIRECTORY, 'live-github-contract.yml'),
      'utf8'
    );
    expect(text).toContain('::notice');
    expect(text).not.toMatch(/echo[^\n]*\$\{\{\s*secrets\./);
    expect(text).not.toContain('upload-artifact');
  });
});

describe('the rules catch what they are for (self-test)', () => {
  const run = (yaml: string, file = 'x.yml') =>
    violations(file, record(parse(yaml)));
  const rules = (yaml: string, file?: string) =>
    run(yaml, file).map((v) => v.rule);
  const base = 'permissions:\n  contents: read\n';

  test('a clean workflow passes', () => {
    const clean = `${base}on:\n  workflow_dispatch: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: owner/tool@${'a'.repeat(40)}\n      - uses: ./.github/actions/local\n`;
    expect(run(clean)).toEqual([]);
  });

  test('self-hosted runners are refused, in every spelling', () => {
    for (const runsOn of [
      'self-hosted',
      '[self-hosted, nixos, ci]',
      '${{ fromJSON(\'["self-hosted"]\') }}',
      '{ group: team-runners }',
      'nixos',
    ]) {
      const yaml = `${base}on: push\njobs:\n  a:\n    runs-on: ${runsOn}\n    steps: []\n`;
      expect(
        rules(yaml).some(
          (r) => r === 'no-self-hosted' || r === 'hosted-runners-only'
        )
      ).toBe(true);
    }
    const matrix = `${base}on: push\njobs:\n  a:\n    runs-on: \${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]\n    steps: []\n`;
    expect(rules(matrix)).toContain('no-self-hosted');
  });

  test('the allow-listed reusable workflow still needs its private guard', () => {
    const unguarded = `${base}on: workflow_call\njobs:\n  a:\n    runs-on: [self-hosted]\n    steps: []\n`;
    expect(rules(unguarded, 'runner-check.yml')).toContain('no-self-hosted');
    const guarded = `${base}on: workflow_call\njobs:\n  a:\n    if: github.event.repository.private\n    runs-on: [self-hosted]\n    steps: []\n`;
    expect(rules(guarded, 'runner-check.yml')).toEqual([]);
  });

  test('pull_request_target and unknown workflow_run are refused', () => {
    expect(
      rules(`${base}on:\n  pull_request_target: {}\njobs: {}\n`)
    ).toContain('no-pull_request_target');
    expect(
      rules(`${base}on:\n  workflow_run:\n    workflows: [CI]\njobs: {}\n`)
    ).toContain('no-workflow_run');
  });

  test('actions must be pinned to a full SHA unless allow-listed', () => {
    for (const ref of ['v1', 'main', 'a'.repeat(39), 'A'.repeat(40)]) {
      const yaml = `${base}on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: evil/tool@${ref}\n`;
      expect(rules(yaml)).toContain('pinned-actions');
    }
    const reusable = `${base}on: push\njobs:\n  a:\n    uses: evil/repo/.github/workflows/x.yml@main\n`;
    expect(rules(reusable)).toContain('pinned-actions');
    const docker = `${base}on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker://alpine:3\n`;
    expect(rules(docker)).toContain('pinned-actions');
  });

  test('permissions must be declared and may not be broad', () => {
    expect(
      rules(
        'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n'
      )
    ).toContain('permissions-declared');
    const perJob =
      'on: push\njobs:\n  a:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n    steps: []\n';
    expect(rules(perJob)).not.toContain('permissions-declared');
    expect(rules('permissions: write-all\non: push\njobs: {}\n')).toContain(
      'least-privilege'
    );
    expect(
      rules('permissions:\n  contents: write\non: push\njobs: {}\n')
    ).toContain('least-privilege');
  });

  test('secrets are unreachable from pull requests, even through a reusable workflow', () => {
    const exposed = `${base}on:\n  pull_request: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.TOKEN }}\n`;
    expect(rules(exposed)).toContain(
      'secrets-not-reachable-from-pull-requests'
    );
    const inherit = `${base}on:\n  pull_request: {}\njobs:\n  a:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n`;
    expect(rules(inherit)).toContain(
      'secrets-not-reachable-from-pull-requests'
    );
    const guarded = `${base}on:\n  pull_request: {}\n  push:\n    branches: [main]\njobs:\n  a:\n    if: github.event_name != 'pull_request'\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.TOKEN }}\n`;
    expect(rules(guarded)).toEqual([]);
    const issue = `${base}on:\n  issue_comment: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.TOKEN }}\n`;
    expect(rules(issue)).toContain('secrets-not-reachable-from-pull-requests');
    const everywhere = `${base}on:\n  push: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.TOKEN }}\n`;
    expect(rules(everywhere)).toContain('secrets-only-on-main');
    const dispatch = `${base}on:\n  workflow_dispatch: {}\n  schedule:\n    - cron: '0 0 * * 1'\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.TOKEN }}\n`;
    expect(rules(dispatch)).toEqual([]);
    const tokenOnly = `${base}on:\n  pull_request: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n        env:\n          T: \${{ secrets.GITHUB_TOKEN }}\n`;
    expect(rules(tokenOnly)).toEqual([]);
  });

  test('attacker-controlled input never goes straight into a script', () => {
    for (const expression of [
      'github.head_ref',
      'github.event.pull_request.title',
      'github.event.comment.body',
      'inputs.command',
    ]) {
      const yaml = `${base}on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "\${{ ${expression} }}"\n`;
      expect(rules(yaml)).toContain('no-script-injection');
    }
    const viaEnv = `${base}on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - env:\n          TITLE: \${{ github.event.pull_request.title }}\n        run: echo "$TITLE"\n`;
    expect(rules(viaEnv)).toEqual([]);
  });
});
