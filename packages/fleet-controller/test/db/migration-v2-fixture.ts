import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

import { nodeIdOf, sha256 } from '../support/fixtures';

/** The schema exactly as version 2 shipped it (before audit, operations and GitHub tables). */
export const V2_SCHEMA = readFileSync(
  new URL('./fixtures/schema-v2.sql', import.meta.url),
  'utf8'
);

/** Tables version 2 had; the upgrade must not change a single row of them. */
export const V2_TABLES = [
  'nodes',
  'heartbeats',
  'events',
  'settings',
  'settings_history',
  'allowed_emails',
  'login_transactions',
  'browser_sessions',
  'access_audit',
] as const;

export const NEW_V3_TABLES = [
  'audit_log',
  'operations',
  'node_lifecycle',
  'desired_history',
  'github_integration',
  'ci_jobs',
  'github_runners',
  'issue_reports',
  'enrollment_grants',
  'controller_secrets',
] as const;

export const SESSION_TOKEN_HASH = sha256('session-live');
export const SESSION_CONTEXT = 'dashboard';
export const ADMINS = ['owner@example.test', 'ops@example.test'] as const;

interface NodeSpec {
  readonly n: number;
  readonly role: string | null;
  readonly approval: 'pending' | 'approved' | 'rejected' | 'retired';
  readonly observedRole?: string;
  readonly via?: 'enrollment-token' | 'hello' | 'dashboard';
  readonly extra?: Record<string, string | number | null>;
}

const NODES: readonly NodeSpec[] = [
  {
    n: 1,
    role: 'ci',
    approval: 'approved',
    observedRole: 'ci',
    via: 'enrollment-token',
    extra: {
      display_name: 'Rack 2 shelf A',
      note: 'bought 2026',
      labels: '["rack-2","gpu"]',
      applied_revision: '0123456789abcdef',
      observed_closure: 'ci-gpu',
      age_recipient: 'age1' + 'q'.repeat(58),
      hardware: '{"capabilities":["gpu"],"tier":"workstation"}',
      reconcile: '{"phase":"converged","issues":[]}',
    },
  },
  {
    n: 2,
    role: 'ci',
    approval: 'approved',
    observedRole: 'base',
    via: 'hello',
    extra: { offline_notified_at: '2026-10-14T11:00:00.000Z' },
  },
  { n: 3, role: 'devbox', approval: 'approved', observedRole: 'devbox' },
  { n: 4, role: null, approval: 'pending' },
  { n: 5, role: 'ci', approval: 'rejected', via: 'hello' },
  {
    n: 6,
    role: 'devbox',
    approval: 'retired',
    observedRole: 'devbox',
    extra: { retired_at: '2026-10-13T09:30:00.000Z' },
  },
  {
    n: 7,
    role: 'ci',
    approval: 'approved',
    observedRole: 'ci',
    via: 'dashboard',
  },
  { n: 8, role: null, approval: 'approved', observedRole: 'base' },
];

function insertNodes(sqlite: Database): void {
  for (const spec of NODES) {
    const columns: Record<string, string | number | null> = {
      id: nodeIdOf(spec.n),
      role: spec.role,
      hostname: `node-${spec.n}`,
      approval: spec.approval,
      secret_hash: sha256(`secret-${spec.n}`),
      observed_role: spec.observedRole ?? null,
      facts: JSON.stringify({
        bootId: `boot-${spec.n}`,
        runners: { slots: 4, busy: spec.n % 3 },
      }),
      revision: '9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283',
      agent_version: '2',
      enrolled_via: spec.via ?? 'hello',
      remote_addr: `203.0.113.${spec.n}`,
      first_seen_at: `2026-10-0${spec.n}T08:00:00.000Z`,
      last_seen_at: `2026-10-14T12:0${spec.n}:00.000Z`,
      approved_at:
        spec.approval === 'pending' ? null : '2026-10-10T10:00:00.000Z',
      approved_by: spec.approval === 'pending' ? null : 'owner@example.test',
      ...spec.extra,
    };
    const names = Object.keys(columns);
    sqlite
      .query(
        `insert into nodes (${names.join(', ')}) values (${names.map((k) => '$' + k).join(', ')})`
      )
      .run(columns);
  }
}

function insertHeartbeats(sqlite: Database): void {
  const insert = sqlite.query(
    `insert into heartbeats (node_id, at, uptime_seconds, load1, mem_used_percent,
       disk_percent, slots, busy_slots, telemetry, revision)
     values ($node, $at, $uptime, $load, $mem, $disk, 4, $busy, $telemetry, 'abc123')`
  );
  for (const n of [1, 2, 3, 7]) {
    for (let minute = 0; minute < 3; minute += 1) {
      const telemetry =
        n === 3
          ? null
          : JSON.stringify({
              sampledAt: `2026-10-14T12:0${minute}:00.000Z`,
              cpu: { utilizationPercent: 20 + minute * 7.5, cores: 16 },
              temperatures: [{ sensor: 'Package id 0', celsius: 55 + n }],
              power: { domain: 'package-0', watts: 38.5 },
            });
      insert.run({
        node: nodeIdOf(n),
        at: `2026-10-14T12:0${minute}:00.000Z`,
        uptime: 86_400 + minute * 60,
        load: 0.25 * (n + minute),
        mem: 41.5,
        disk: 37,
        busy: minute % 2,
        telemetry,
      });
    }
  }
}

function insertEventsAndSettings(sqlite: Database): void {
  const event = sqlite.query(
    `insert into events (at, node_id, node_label, kind, severity, message, data)
     values ($at, $node, $label, $kind, $severity, $message, $data)`
  );
  const rows: [string, number | null, string, string, string, object][] = [
    [
      '2026-10-14T12:00:00.000Z',
      1,
      'boot',
      'info',
      'node started',
      { bootId: 'boot-1' },
    ],
    ['2026-10-14T12:05:00.000Z', 2, 'offline', 'error', 'node 2 is silent', {}],
    [
      '2026-10-14T12:06:00.000Z',
      3,
      'rollback',
      'warn',
      'rolled back',
      { reason: 'health' },
    ],
    [
      '2026-10-14T12:07:00.000Z',
      null,
      'webhook',
      'info',
      'fleet wide notice',
      {},
    ],
  ];
  for (const [at, n, kind, severity, message, data] of rows) {
    event.run({
      at,
      node: n === null ? null : nodeIdOf(n),
      label: n === null ? null : `node-${n}`,
      kind,
      severity,
      message,
      data: JSON.stringify(data),
    });
  }
  const scopes: [string, object][] = [
    ['fleet', { sync: { paused: false }, heartbeat: { intervalSeconds: 45 } }],
    ['role:ci', { runners: { extraLabels: ['lab-a'] } }],
    [`node:${nodeIdOf(1)}`, { capacity: { slotMax: 2 } }],
  ];
  for (const [scope, value] of scopes) {
    sqlite
      .query(
        `insert into settings (scope, value, updated_by) values ($scope, $value, 'owner@example.test')`
      )
      .run({ scope, value: JSON.stringify(value) });
    for (const version of [1, 2]) {
      sqlite
        .query(
          `insert into settings_history (scope, value, changed_at, changed_by)
           values ($scope, $value, $at, 'owner@example.test')`
        )
        .run({
          scope,
          value: JSON.stringify({ version }),
          at: `2026-10-1${version}T10:00:00.000Z`,
        });
    }
  }
}

function insertAccess(sqlite: Database): void {
  const allow = sqlite.query(
    `insert into allowed_emails (email, added_by, added_at) values ($email, $by, $at)`
  );
  for (const [index, email] of [
    ...ADMINS,
    'colleague@example.test',
  ].entries()) {
    allow.run({
      email,
      by: index === 0 ? 'bootstrap' : 'owner@example.test',
      at: `2026-09-0${index + 1}T08:00:00.000Z`,
    });
  }
  sqlite.exec(`
    insert into access_audit (email, actor, action, at) values
      ('owner@example.test', 'bootstrap', 'allow', '2026-09-01T08:00:00.000Z'),
      ('ops@example.test', 'owner@example.test', 'allow', '2026-09-02T08:00:00.000Z'),
      ('gone@example.test', 'owner@example.test', 'revoke', '2026-09-03T08:00:00.000Z');
  `);
  const session = sqlite.query(
    `insert into browser_sessions (session_context, token_hash, issuer, subject, email, expires_at)
     values ($context, $hash, 'https://accounts.example.test', $subject, $email, $expires)`
  );
  session.run({
    context: SESSION_CONTEXT,
    hash: SESSION_TOKEN_HASH,
    subject: 'sub-owner',
    email: 'owner@example.test',
    expires: '2999-01-01T00:00:00.000Z',
  });
  session.run({
    context: SESSION_CONTEXT,
    hash: sha256('session-expired'),
    subject: 'sub-ops',
    email: 'ops@example.test',
    expires: '2020-01-01T00:00:00.000Z',
  });
  sqlite
    .query(
      `insert into login_transactions (state_hash, binding_hash, verifier, nonce, next_path, expires_at)
       values ($state, $binding, 'verifier', 'nonce', '/nodes', '2999-01-01T00:00:00.000Z')`
    )
    .run({ state: sha256('state'), binding: sha256('binding') });
}

/** A realistic version 2 database as the previous release left it, closed and ready to upgrade. */
export function writeV2(path: string): void {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec(V2_SCHEMA);
    sqlite.exec('PRAGMA user_version = 2');
    insertNodes(sqlite);
    insertHeartbeats(sqlite);
    insertEventsAndSettings(sqlite);
    insertAccess(sqlite);
  } finally {
    sqlite.close();
  }
}

type Dump = Record<string, unknown[]>;

/**
 * Every row of the given tables, restricted to the columns the database
 * `reference` has for them, in rowid order.
 */
export function dumpRows(
  path: string,
  tables: readonly string[],
  columnsOf: Readonly<Record<string, readonly string[]>>
): Dump {
  const sqlite = new Database(path, { readonly: true });
  try {
    const dump: Dump = {};
    for (const table of tables) {
      const list = (columnsOf[table] ?? []).join(', ');
      dump[table] = sqlite
        .query(`select ${list} from ${table} order by rowid`)
        .all();
    }
    return dump;
  } finally {
    sqlite.close();
  }
}

/** Column names of each table as the database at `path` has them. */
export function columnNames(
  path: string,
  tables: readonly string[]
): Record<string, string[]> {
  const sqlite = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        sqlite
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name),
      ])
    );
  } finally {
    sqlite.close();
  }
}
