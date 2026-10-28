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

/** `MIGRATIONS[n]` upgrades version n to n + 1. */
export const MIGRATIONS: Readonly<Record<number, string>> = { 1: V1_TO_V2 };

export const SCHEMA_VERSION = 2;
