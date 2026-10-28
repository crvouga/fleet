-- Fleet SQLite schema version 1. Applied transactionally at startup.

CREATE TABLE nodes (
  id TEXT NOT NULL,
  role TEXT NOT NULL,
  hostname TEXT NOT NULL,
  approval TEXT NOT NULL DEFAULT 'pending',
  secret_hash TEXT NOT NULL,
  display_name TEXT,
  note TEXT,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels) AND json_type(labels) = 'array'),
  facts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facts)),
  revision TEXT,
  agent_version TEXT,
  config_revision TEXT,
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
  CONSTRAINT nodes_role_known CHECK (role IN ('ci', 'web', 'cache', 'netboot', 'devbox')),
  CONSTRAINT nodes_approval_known CHECK (approval IN ('pending', 'approved', 'rejected', 'retired')),
  CONSTRAINT nodes_enrolled_via_known CHECK (enrolled_via IN ('role-token', 'hello', 'dashboard')),
  CONSTRAINT nodes_interval_sane CHECK (heartbeat_interval_seconds BETWEEN 5 AND 3600)
) STRICT;

CREATE INDEX nodes_role_idx ON nodes (role);

CREATE INDEX nodes_approval_idx ON nodes (approval);

CREATE INDEX nodes_last_seen_idx ON nodes (last_seen_at);

CREATE TABLE heartbeats (
  node_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  uptime_seconds INTEGER,
  load1 REAL,
  mem_used_percent REAL,
  disk_percent REAL,
  slots INTEGER,
  busy_slots INTEGER,
  telemetry TEXT CHECK (json_valid(telemetry)),
  revision TEXT,
  PRIMARY KEY (node_id, at),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX heartbeats_at_idx ON heartbeats (at);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  node_id TEXT,
  node_label TEXT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
  CONSTRAINT events_severity_known CHECK (severity IN ('info', 'warn', 'error')),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE settings (
  scope TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT,
  PRIMARY KEY (scope)
) STRICT;

CREATE TABLE settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value)),
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  changed_by TEXT
) STRICT;

CREATE TABLE allowed_emails (
  email TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (email)
) STRICT;

CREATE TABLE login_transactions (
  state_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  next_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (state_hash)
) STRICT;

CREATE INDEX login_transactions_expiry ON login_transactions (expires_at);

CREATE TABLE browser_sessions (
  session_context TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (token_hash)
) STRICT;

CREATE INDEX browser_sessions_expiry ON browser_sessions (expires_at);

CREATE TABLE access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX events_at_idx ON events(at DESC);

CREATE INDEX events_node_at_idx ON events(node_id, at DESC);

CREATE INDEX settings_history_scope_idx ON settings_history(scope, changed_at DESC);
