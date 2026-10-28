/**
 * Versioned upgrades of an existing database. A new database is created from
 * schema.sql at the newest version instead. Each step runs inside the startup
 * transaction, with foreign keys off so a table rebuild cannot cascade.
 */

/**
 * Version 1 to 2: the controller owns assignment. `nodes.role` becomes the
 * nullable assigned role, the generated role CHECK is dropped (roles are
 * validated in code), and observed state gets its own columns. Every v1 role
 * is copied into both `role` and `observed_role`, so existing nodes keep
 * exactly what they run. SQLite cannot relax NOT NULL or drop a CHECK in
 * place, so the table is rebuilt.
 */
const V1_TO_V2 = `
CREATE TABLE nodes_v2 (
  id TEXT NOT NULL,
  role TEXT,
  hostname TEXT NOT NULL,
  approval TEXT NOT NULL DEFAULT 'pending',
  secret_hash TEXT NOT NULL,
  display_name TEXT,
  note TEXT,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  facts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts)),
  revision TEXT,
  agent_version TEXT,
  applied_revision TEXT,
  observed_role TEXT,
  observed_closure TEXT,
  age_recipient TEXT,
  hardware TEXT CHECK (hardware IS NULL OR (json_valid(hardware) AND json_type(hardware) = 'object')),
  reconcile TEXT CHECK (reconcile IS NULL OR (json_valid(reconcile) AND json_type(reconcile) = 'object')),
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 60,
  remote_addr TEXT,
  enrolled_via TEXT NOT NULL DEFAULT 'hello',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at TEXT,
  approved_at TEXT,
  approved_by TEXT,
  retired_at TEXT,
  offline_notified_at TEXT,
  PRIMARY KEY (id),
  CONSTRAINT nodes_id_is_sha256 CHECK (length(id) = 64 AND id NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT nodes_approval_known CHECK (approval IN ('pending', 'approved', 'rejected', 'retired')),
  CONSTRAINT nodes_enrolled_via_known CHECK (enrolled_via IN ('enrollment-token', 'hello', 'dashboard')),
  CONSTRAINT nodes_interval_sane CHECK (heartbeat_interval_seconds BETWEEN 5 AND 3600)
) STRICT;

INSERT INTO nodes_v2 (
  id, role, hostname, approval, secret_hash, display_name, note, labels, facts,
  revision, agent_version, applied_revision, observed_role, observed_closure,
  age_recipient, hardware, reconcile, heartbeat_interval_seconds, remote_addr,
  enrolled_via, first_seen_at, last_seen_at, approved_at, approved_by,
  retired_at, offline_notified_at
)
SELECT
  id, role, hostname, approval, secret_hash, display_name, note, labels, facts,
  revision, agent_version, config_revision, role, NULL,
  NULL, NULL, NULL, heartbeat_interval_seconds, remote_addr,
  CASE enrolled_via WHEN 'role-token' THEN 'enrollment-token' ELSE enrolled_via END,
  first_seen_at, last_seen_at, approved_at, approved_by,
  retired_at, offline_notified_at
FROM nodes;

DROP TABLE nodes;
ALTER TABLE nodes_v2 RENAME TO nodes;
CREATE INDEX nodes_role_idx ON nodes (role);
CREATE INDEX nodes_approval_idx ON nodes (approval);
CREATE INDEX nodes_last_seen_idx ON nodes (last_seen_at);
`;

/**
 * Version 2 to 3: operator-facing operations. Adds the audit log, lifecycle
 * operations, per-node lifecycle intent (drain, restart, credential rotation),
 * desired-state history, the controller-owned GitHub integration with its job
 * and runner mirrors, issue reports, single-use enrollment grants and controller
 * secrets, plus settings revisions (optimistic concurrency) and viewer/admin
 * roles on the allowlist. Purely additive: no existing row changes.
 */
const V2_TO_V3 = `
ALTER TABLE settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE allowed_emails ADD COLUMN role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'viewer'));

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor TEXT NOT NULL,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'success',
  request_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  CONSTRAINT audit_outcome_known CHECK (outcome IN ('success', 'denied', 'failed'))
) STRICT;

CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

CREATE INDEX audit_log_target_idx ON audit_log (target_kind, target_id, at DESC);

CREATE TABLE operations (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  progress TEXT,
  failure TEXT,
  idempotency_key TEXT,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  PRIMARY KEY (id),
  CONSTRAINT operations_status_known CHECK (status IN ('pending', 'in_progress', 'succeeded', 'failed', 'cancelled'))
) STRICT;

CREATE UNIQUE INDEX operations_idempotency_idx ON operations (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX operations_node_idx ON operations (node_id, requested_at DESC);

CREATE INDEX operations_status_idx ON operations (status, requested_at DESC);

CREATE TABLE node_lifecycle (
  node_id TEXT NOT NULL,
  drain_requested_at TEXT,
  drain_reason TEXT,
  restart_requested_at TEXT,
  restart_completed_at TEXT,
  replaced_by TEXT,
  decommission_requested_at TEXT,
  rotate_requested_at TEXT,
  next_secret_hash TEXT,
  rotated_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (node_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE desired_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  desired TEXT NOT NULL CHECK (json_valid(desired)),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cause TEXT,
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX desired_history_node_idx ON desired_history (node_id, at DESC);

CREATE TABLE github_integration (
  id INTEGER NOT NULL CHECK (id = 1),
  scope TEXT NOT NULL DEFAULT 'repository',
  organization TEXT NOT NULL DEFAULT '',
  repositories TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(repositories) AND json_type(repositories) = 'array'),
  runner_group TEXT,
  app_id TEXT NOT NULL DEFAULT '',
  installation_id TEXT NOT NULL DEFAULT '',
  policy TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy)),
  status TEXT NOT NULL DEFAULT 'unconfigured',
  last_sync_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (id),
  CONSTRAINT github_scope_known CHECK (scope IN ('repository', 'organization'))
) STRICT;

CREATE TABLE ci_jobs (
  id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  runner_id INTEGER,
  runner_name TEXT,
  node_id TEXT,
  html_url TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source TEXT NOT NULL DEFAULT 'poll',
  PRIMARY KEY (id),
  CONSTRAINT ci_jobs_status_known CHECK (status IN ('queued', 'in_progress', 'completed')),
  CONSTRAINT ci_jobs_source_known CHECK (source IN ('poll', 'webhook'))
) STRICT;

CREATE INDEX ci_jobs_status_idx ON ci_jobs (status, created_at DESC);

CREATE INDEX ci_jobs_node_idx ON ci_jobs (node_id, created_at DESC);

CREATE TABLE github_runners (
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  repository TEXT,
  status TEXT NOT NULL,
  busy INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  node_id TEXT,
  slot TEXT,
  seen_at TEXT NOT NULL,
  offline_since TEXT,
  orphan_since TEXT,
  PRIMARY KEY (id)
) STRICT;

CREATE TABLE issue_reports (
  id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  node_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(snapshot)),
  correlation_id TEXT,
  github_issue_number INTEGER,
  github_issue_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (id),
  CONSTRAINT issue_reports_status_known CHECK (status IN ('draft', 'queued', 'created', 'failed', 'duplicate'))
) STRICT;

CREATE UNIQUE INDEX issue_reports_open_fingerprint_idx ON issue_reports (fingerprint) WHERE status IN ('queued', 'created');

CREATE INDEX issue_reports_status_idx ON issue_reports (status, next_attempt_at);

CREATE TABLE enrollment_grants (
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT,
  label TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_node TEXT,
  revoked_at TEXT,
  PRIMARY KEY (id),
  CONSTRAINT enrollment_grants_token_unique UNIQUE (token_hash)
) STRICT;

CREATE TABLE controller_secrets (
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (name)
) STRICT;
`;

/** `MIGRATIONS[n]` upgrades version n to n + 1. */
export const MIGRATIONS: Readonly<Record<number, string>> = {
  1: V1_TO_V2,
  2: V2_TO_V3,
};

export const SCHEMA_VERSION = 3;
