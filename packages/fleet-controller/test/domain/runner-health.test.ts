import { describe, expect, test } from 'bun:test';

import {
  CLEAR_HOLD_SECONDS,
  conditionKey,
  EMPTY_MEMORY,
  observeRunnerHealth,
  openConditions,
  queueFacts,
  registrationCode,
  RUNNER_HEALTH_EVENT_KINDS,
  RUNNER_HEALTH_KINDS,
  stepRunnerHealth,
  thresholdsOf,
  type HealthEvent,
  type HealthJob,
  type HealthMemory,
  type HealthNode,
  type HealthRunner,
  type RawCondition,
  type RunnerRuleId,
  type RunnerHealthInput,
} from '../../src/domain/runner-health';
import { INCIDENT_RULES } from '../../src/domain/incidents';
import { DEFAULT_POLICY } from '../../src/github/policy';
import type { Severity } from '../../src/types';

const NOW = new Date('2026-01-01T12:00:00Z');
const T = thresholdsOf(DEFAULT_POLICY);
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

function job(over: Partial<HealthJob> = {}): HealthJob {
  return {
    id: 1,
    repository: 'acme/app',
    name: 'build',
    status: 'queued',
    labels: ['self-hosted', 'nixos', 'ci'],
    createdAt: at(-11 * 60),
    ...over,
  };
}

function runner(over: Partial<HealthRunner> = {}): HealthRunner {
  return {
    id: 7,
    repository: 'acme/app',
    status: 'online',
    busy: false,
    labels: ['self-hosted', 'linux', 'x64', 'nixos', 'ci'],
    slot: 'slot-1',
    offlineSince: null,
    ...over,
  };
}

function node(over: Partial<HealthNode> = {}): HealthNode {
  return {
    id: 'a'.repeat(64),
    label: 'ci-1',
    role: 'ci',
    approved: true,
    status: 'online',
    issues: [],
    ...over,
  };
}

function snapshot(over: Partial<RunnerHealthInput> = {}): RunnerHealthInput {
  return { now: NOW, active: true, jobs: [], runners: [], nodes: [], ...over };
}

const rules = (input: RunnerHealthInput) =>
  observeRunnerHealth(input, T).map((c) => c.rule);

describe('queue_stalled', () => {
  const cases: [string, Partial<RunnerHealthInput>, boolean][] = [
    ['waited past the threshold, no runner at all', { jobs: [job()] }, true],
    [
      'waited less than the threshold',
      { jobs: [job({ createdAt: at(-9 * 60) })] },
      false,
    ],
    [
      'an online idle runner can take it',
      { jobs: [job()], runners: [runner()] },
      false,
    ],
    [
      'only a busy runner exists',
      { jobs: [job()], runners: [runner({ busy: true })] },
      true,
    ],
    [
      'the only runner is offline',
      { jobs: [job()], runners: [runner({ status: 'offline' })] },
      true,
    ],
    [
      'an idle runner of another repository cannot take it',
      { jobs: [job()], runners: [runner({ repository: 'acme/other' })] },
      true,
    ],
    [
      'an idle organization runner can',
      { jobs: [job()], runners: [runner({ repository: null })] },
      false,
    ],
    [
      'an idle runner lacks a requested label',
      {
        jobs: [job({ labels: ['self-hosted', 'nixos', 'ci', 'gpu'] })],
        runners: [runner()],
      },
      true,
    ],
    [
      'labels compare case-insensitively',
      {
        jobs: [job({ labels: ['Self-Hosted', 'NixOS', 'CI'] })],
        runners: [runner()],
      },
      false,
    ],
    [
      'a GitHub-hosted job is not ours',
      { jobs: [job({ labels: ['ubuntu-latest'] })] },
      false,
    ],
    [
      'a running job is not queued',
      { jobs: [job({ status: 'in_progress' })] },
      false,
    ],
    ['the integration is not active', { jobs: [job()], active: false }, false],
  ];
  test.each(cases)('%s', (_name, over, stalled) => {
    expect(rules(snapshot(over)).includes('runner_queue')).toBe(stalled);
  });

  test('severity rises to error at three times the threshold', () => {
    const warn = observeRunnerHealth(snapshot({ jobs: [job()] }), T);
    const error = observeRunnerHealth(
      snapshot({ jobs: [job({ createdAt: at(-31 * 60) })] }),
      T
    );
    expect(warn[0]?.severity).toBe('warn');
    expect(error[0]?.severity).toBe('error');
  });

  test('the threshold comes from the policy, in minutes', () => {
    const strict = thresholdsOf({ ...DEFAULT_POLICY, queueStallMinutes: 2 });
    const input = snapshot({ jobs: [job({ createdAt: at(-3 * 60) })] });
    expect(observeRunnerHealth(input, strict)).toHaveLength(1);
    expect(observeRunnerHealth(input, T)).toHaveLength(0);
  });

  test('queue facts report the oldest waiting job even below the threshold', () => {
    const facts = queueFacts(
      snapshot({
        jobs: [
          job({ id: 1, createdAt: at(-60) }),
          job({ id: 2, createdAt: at(-120) }),
        ],
      }),
      T
    );
    expect(facts).toMatchObject({ queued: 2, oldestQueuedSeconds: 120 });
    expect(facts.stalled).toHaveLength(0);
  });

  test('the message names counts and ids, never a job name or a token', () => {
    const [condition] = observeRunnerHealth(
      snapshot({ jobs: [job({ name: 'SECRET-CANARY' })] }),
      T
    );
    expect(JSON.stringify(condition)).not.toContain('SECRET-CANARY');
  });
});

describe('runners_offline', () => {
  const ci = node();
  const cases: [string, Partial<RunnerHealthInput>, boolean][] = [
    ['no runners listed while a CI node reports', { nodes: [ci] }, true],
    [
      'every listed runner is offline',
      { nodes: [ci], runners: [runner({ status: 'offline' })] },
      true,
    ],
    ['a Fleet runner is online', { nodes: [ci], runners: [runner()] }, false],
    [
      'a runner that is not named like a slot does not count',
      { nodes: [ci], runners: [runner({ slot: null })] },
      true,
    ],
    [
      'no CI node is reporting',
      { nodes: [node({ status: 'offline' })] },
      false,
    ],
    ['the node is not a CI node', { nodes: [node({ role: 'devbox' })] }, false],
    ['the node is not approved', { nodes: [node({ approved: false })] }, false],
    ['the integration is not active', { nodes: [ci], active: false }, false],
  ];
  test.each(cases)('%s', (_name, over, expected) => {
    expect(rules(snapshot(over)).includes('runners_offline')).toBe(expected);
  });

  test('it carries when the last runner went offline, so a later anchor restarts the hold', () => {
    const [condition] = observeRunnerHealth(
      snapshot({
        nodes: [ci],
        runners: [
          runner({ id: 1, status: 'offline', offlineSince: at(-900) }),
          runner({ id: 2, status: 'offline', offlineSince: at(-700) }),
        ],
      }),
      T
    );
    expect(condition?.notBefore).toBe(at(-700).getTime());
    expect(condition?.holdSeconds).toBe(600);
  });
});

describe('runner_registration', () => {
  const cases: [string, string[], ReturnType<typeof registrationCode>][] = [
    [
      'a refused key',
      ['FLEET_GITHUB_KEY: GitHub refused the App credential'],
      'FLEET_GITHUB_KEY',
    ],
    [
      'a missing permission',
      ['FLEET_GITHUB_SCOPE: x (repository acme/app).'],
      'FLEET_GITHUB_SCOPE',
    ],
    [
      'an invalid target',
      ['FLEET_GITHUB_SCOPE_INVALID: targets'],
      'FLEET_GITHUB_SCOPE_INVALID',
    ],
    [
      'GitHub unavailable',
      ['FLEET_GITHUB_UNAVAILABLE: retrying'],
      'FLEET_GITHUB_UNAVAILABLE',
    ],
    [
      'a restart loop',
      ['FLEET_RUNNER_RESTARTING: runner slot-1'],
      'FLEET_RUNNER_RESTARTING',
    ],
    [
      'a code in the middle of other issues',
      ['Failed services: x', 'FLEET_GITHUB_REGISTRATION: y'],
      'FLEET_GITHUB_REGISTRATION',
    ],
    [
      'progress that is not a failure',
      ['FLEET_GITHUB_RUNNERS_PENDING: 0 of 2 online'],
      null,
    ],
    [
      'a check still running',
      ['FLEET_GITHUB_CHECK_PENDING: progressing'],
      null,
    ],
    ['runners disabled on purpose', ['FLEET_RUNNERS_DISABLED: cordoned'], null],
    ['runners starting', ['FLEET_RUNNERS_STARTING: 1 of 2'], null],
    ['a similar word', ['xFLEET_GITHUB_KEYS'], null],
    ['no issues', [], null],
  ];
  test.each(cases)('%s', (_name, issues, code) => {
    expect(registrationCode(issues)).toBe(code);
    const found = observeRunnerHealth(
      snapshot({ nodes: [node({ issues })], runners: [runner()] }),
      T
    ).filter((c) => c.rule === 'runner_registration');
    expect(found.length).toBe(code === null ? 0 : 1);
  });

  test('it is per node, for CI nodes that report, with a fixed hint and never the node text', () => {
    const bad = node({
      id: 'b'.repeat(64),
      label: 'ci-2',
      issues: ['FLEET_GITHUB_KEY: token ghs_CANARY123 leaked'],
    });
    const stale = node({
      id: 'c'.repeat(64),
      status: 'stale',
      issues: ['FLEET_GITHUB_KEY: x'],
    });
    const other = node({
      id: 'd'.repeat(64),
      role: 'devbox',
      issues: ['FLEET_GITHUB_KEY: x'],
    });
    const found = observeRunnerHealth(
      snapshot({ nodes: [bad, stale, other, node()], runners: [runner()] }),
      T
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      nodeId: bad.id,
      nodeLabel: 'ci-2',
      severity: 'error',
      holdSeconds: 300,
    });
    expect(JSON.stringify(found)).not.toContain('CANARY');
  });

  test('transient codes are warnings, permanent ones need a person', () => {
    const level = (code: string) =>
      observeRunnerHealth(
        snapshot({
          nodes: [node({ issues: [`${code}: x`] })],
          runners: [runner()],
        }),
        T
      )[0]?.severity;
    expect(level('FLEET_GITHUB_UNAVAILABLE')).toBe('warn');
    expect(level('FLEET_RUNNER_RESTARTING')).toBe('warn');
    expect(level('FLEET_GITHUB_SCOPE')).toBe('error');
    expect(level('FLEET_GITHUB_KEY')).toBe('error');
  });
});

// ---- the open/close machine ------------------------------------------------

function condition(over: Partial<RawCondition> = {}): RawCondition {
  return {
    key: 'runner_queue:',
    rule: 'runner_queue',
    nodeId: null,
    nodeLabel: null,
    severity: 'warn',
    message: 'm',
    data: {},
    holdSeconds: 0,
    notBefore: null,
    ...over,
  };
}

let nextId = 1;
interface Stored {
  id: number;
  at: Date;
  nodeId: string | null;
  kind: string;
  severity: Severity;
}

/** The condition key an event belongs to. */
function keyOf(event: HealthEvent): string {
  const rule = (Object.keys(RUNNER_HEALTH_KINDS) as RunnerRuleId[]).find(
    (candidate) =>
      RUNNER_HEALTH_KINDS[candidate].open === event.kind ||
      RUNNER_HEALTH_KINDS[candidate].close === event.kind
  );
  return conditionKey(rule ?? 'runner_queue', event.nodeId);
}

/** A tiny world: the stored events, the in-memory timers, and a clock. */
function world() {
  const events: Stored[] = [];
  let memory: HealthMemory = EMPTY_MEMORY;
  const emitted: { event: HealthEvent; at: number }[] = [];
  return {
    events,
    emitted,
    restart: () => {
      memory = EMPTY_MEMORY;
    },
    /** What a freshly restarted controller would announce now; nothing is committed. */
    afterRestart(observed: RawCondition[], seconds: number) {
      return stepRunnerHealth(
        observed,
        { open: openConditions(events), memory: EMPTY_MEMORY },
        at(seconds),
        CLEAR_HOLD_SECONDS
      ).events;
    },
    tick(observed: RawCondition[], seconds: number): readonly HealthEvent[] {
      const now = at(seconds);
      const step = stepRunnerHealth(
        observed,
        { open: openConditions(events), memory },
        now,
        CLEAR_HOLD_SECONDS
      );
      memory = step.memory;
      for (const event of step.events) {
        events.push({
          id: nextId++,
          at: now,
          nodeId: event.nodeId,
          kind: event.kind,
          severity: event.severity,
        });
        emitted.push({ event, at: seconds });
      }
      return step.events;
    },
  };
}

describe('stepRunnerHealth', () => {
  test('the vocabulary matches the incident rules', () => {
    for (const [rule, pair] of Object.entries(RUNNER_HEALTH_KINDS)) {
      expect(INCIDENT_RULES.find((r) => r.id === rule)).toMatchObject(pair);
    }
    expect(RUNNER_HEALTH_EVENT_KINDS).toHaveLength(6);
  });

  test('opens once, stays silent while it holds, closes once after the hold', () => {
    const w = world();
    const on = [condition()];
    expect(w.tick(on, 0).map((e) => e.kind)).toEqual(['runner_queue_stalled']);
    expect(w.tick(on, 60)).toEqual([]);
    expect(w.tick(on, 120)).toEqual([]);
    expect(w.tick([], 180)).toEqual([]);
    expect(w.tick([], 240)).toEqual([]);
    expect(w.tick([], 300).map((e) => e.kind)).toEqual(['runner_queue_ok']);
    expect(w.tick([], 360)).toEqual([]);
  });

  test('a clear that comes back inside the hold never closes (no flapping)', () => {
    const w = world();
    w.tick([condition()], 0);
    for (let t = 30; t <= 900; t += 30) {
      expect(w.tick(t % 90 === 0 ? [] : [condition()], t)).toEqual([]);
    }
    expect(w.emitted).toHaveLength(1);
  });

  test('a hold delays the opening; an absence in between resets it', () => {
    const w = world();
    const reg = condition({
      key: 'runner_registration:n1',
      rule: 'runner_registration',
      nodeId: 'n1',
      holdSeconds: 300,
    });
    expect(w.tick([reg], 0)).toEqual([]);
    expect(w.tick([reg], 200)).toEqual([]);
    expect(w.tick([], 250)).toEqual([]); // gone before it held
    expect(w.tick([reg], 300)).toEqual([]); // starts over
    expect(w.tick([reg], 599)).toEqual([]);
    expect(w.tick([reg], 600).map((e) => e.kind)).toEqual([
      'runner_registration_failing',
    ]);
    expect(w.emitted[0]?.event.nodeId).toBe('n1');
  });

  test('after a restart an older anchor does not shorten the hold (silence over speed)', () => {
    const w = world();
    const offline = condition({
      key: 'runners_offline:',
      rule: 'runners_offline',
      severity: 'error',
      holdSeconds: 600,
      notBefore: at(-1000).getTime(),
    });
    expect(w.tick([offline], 0)).toEqual([]);
    expect(w.tick([offline], 599)).toEqual([]);
    expect(w.tick([offline], 600).map((e) => e.kind)).toEqual([
      'runners_offline',
    ]);
  });

  test('a newer anchor restarts the hold (a runner was online in between)', () => {
    const w = world();
    const offline = (since: number) =>
      condition({
        key: 'runners_offline:',
        rule: 'runners_offline',
        holdSeconds: 600,
        notBefore: at(since).getTime(),
      });
    expect(w.tick([offline(-100)], 0)).toEqual([]);
    expect(w.tick([offline(300)], 400)).toEqual([]);
    expect(w.tick([offline(300)], 899)).toEqual([]);
    expect(w.tick([offline(300)], 900)).toHaveLength(1);
  });

  test('it escalates only when it gets worse, never when it gets better', () => {
    const w = world();
    expect(w.tick([condition({ severity: 'warn' })], 0)).toHaveLength(1);
    expect(
      w.tick([condition({ severity: 'error' })], 60).map((e) => e.severity)
    ).toEqual(['error']);
    expect(w.tick([condition({ severity: 'warn' })], 120)).toEqual([]);
    expect(w.tick([condition({ severity: 'error' })], 180)).toEqual([]);
  });

  test('per-node conditions are independent', () => {
    const w = world();
    const mk = (n: string) =>
      condition({
        key: `runner_registration:${n}`,
        rule: 'runner_registration',
        nodeId: n,
      });
    w.tick([mk('a'), mk('b')], 0);
    w.tick([mk('b')], 60);
    const closed = w.tick([mk('b')], 200);
    expect(closed.map((e) => `${e.kind}:${e.nodeId}`)).toEqual([
      'runner_registration_ok:a',
    ]);
  });

  test('a closing event with nothing open is never produced', () => {
    const w = world();
    for (let t = 0; t < 600; t += 60) expect(w.tick([], t)).toEqual([]);
  });
});

// ---- randomized sequences --------------------------------------------------

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const KEYS = [
  { key: 'runner_queue:', rule: 'runner_queue', nodeId: null, hold: 0 },
  { key: 'runners_offline:', rule: 'runners_offline', nodeId: null, hold: 600 },
  {
    key: 'runner_registration:n1',
    rule: 'runner_registration',
    nodeId: 'n1',
    hold: 300,
  },
  {
    key: 'runner_registration:n2',
    rule: 'runner_registration',
    nodeId: 'n2',
    hold: 300,
  },
] as const;

function randomObservation(random: () => number, bias: number): RawCondition[] {
  return KEYS.filter(() => random() < bias).map((k) =>
    condition({
      key: k.key,
      rule: k.rule,
      nodeId: k.nodeId,
      holdSeconds: k.hold,
      severity: random() < 0.3 ? 'error' : 'warn',
    })
  );
}

interface Trace {
  readonly seconds: number;
  readonly present: ReadonlySet<string>;
}

/** How long (seconds) the key's presence has been `present` as of `when`. */
function streak(
  trace: readonly Trace[],
  key: string,
  when: number,
  present: boolean
): number {
  let since = when;
  for (const sample of trace.filter((t) => t.seconds <= when).reverse()) {
    if (sample.present.has(key) !== present) break;
    since = sample.seconds;
  }
  return when - since;
}

function run(seed: number, restarts: boolean) {
  const random = prng(seed);
  const w = world();
  const trace: Trace[] = [];
  let seconds = 0;
  const bias = 0.2 + random() * 0.6;
  for (let i = 0; i < 400; i += 1) {
    seconds += 15 + Math.floor(random() * 90);
    const observed = randomObservation(random, bias);
    if (restarts && random() < 0.05) w.restart();
    w.tick(observed, seconds);
    trace.push({ seconds, present: new Set(observed.map((o) => o.key)) });
    // Re-deriving at once, after a restart, announces nothing new.
    expect(w.afterRestart(observed, seconds)).toEqual([]);
  }
  return { w, trace };
}

describe('randomized sequences', () => {
  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

  test.each(seeds)(
    'seed %d: edges alternate and re-derivation is silent',
    (seed) => {
      const { w } = run(seed, true);
      const open = new Map<string, Severity>();
      const rank = { info: 0, warn: 1, error: 2 } as const;
      for (const { event } of w.emitted) {
        const key = keyOf(event);
        if (event.edge === 'close') {
          expect(open.has(key)).toBe(true);
          open.delete(key);
        } else {
          const was = open.get(key);
          if (was !== undefined)
            expect(rank[event.severity]).toBeGreaterThan(rank[was]);
          open.set(key, event.severity);
        }
      }
    }
  );

  test.each(seeds)(
    'seed %d: it never closes before the clear hold nor opens before the hold',
    (seed) => {
      const { w, trace } = run(seed, false);
      const open = new Set<string>();
      for (const { event, at: when } of w.emitted) {
        const key = keyOf(event);
        const spec = KEYS.find((k) => k.key === key);
        const wasOpen = open.has(key);
        if (event.edge === 'close') open.delete(key);
        else open.add(key);
        if (event.edge === 'open' && wasOpen) continue; // an escalation
        const needed =
          event.edge === 'close' ? CLEAR_HOLD_SECONDS : (spec?.hold ?? 0);
        const held = streak(trace, key, when, event.edge === 'open');
        expect(held).toBeGreaterThanOrEqual(needed);
      }
    }
  );

  test.each(seeds.slice(0, 20))(
    'seed %d: when everything clears, everything closes',
    (seed) => {
      const random = prng(seed);
      const w = world();
      let seconds = 0;
      for (let i = 0; i < 100; i += 1) {
        seconds += 60;
        w.tick(randomObservation(random, 0.8), seconds);
      }
      for (let i = 0; i < 5; i += 1) {
        seconds += 60;
        w.tick([], seconds);
      }
      expect(openConditions(w.events).size).toBe(0);
    }
  );

  test('the generator exercises opens, escalations and closes', () => {
    const kinds = new Set<string>();
    for (const seed of seeds) {
      for (const { event } of run(seed, false).w.emitted) kinds.add(event.kind);
    }
    expect(kinds.size).toBe(RUNNER_HEALTH_EVENT_KINDS.length);
  });

  test('a flapping condition that never stays clear opens once and closes never', () => {
    const w = world();
    let seconds = 0;
    for (let i = 0; i < 200; i += 1) {
      seconds += 30;
      w.tick(i % 3 === 0 ? [] : [condition()], seconds);
    }
    expect(w.emitted.map((e) => e.event.kind)).toEqual([
      'runner_queue_stalled',
    ]);
  });
});
