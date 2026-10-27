# The fleet API's whole database lives in the "fleet" Postgres schema. The
# database is shared with other projects, so nothing here (and no SQL in src/)
# may create or read anything outside it. OpenTofu applies this file with the
# operator-managed Atlas schema workflow; no
# migration runner exists.
schema "fleet" {}

# One row per machine. The id is the full sha256 of the machine's stable
# hardware id (the node's 4-hex name is its first four digits).
table "nodes" {
  schema = schema.fleet
  column "id" {
    null = false
    type = text
  }
  column "role" {
    null = false
    type = text
  }
  column "hostname" {
    null = false
    type = text
  }
  # pending: announced itself, waiting for a person. approved: reports and
  # receives configuration. rejected: refused by a person. retired: removed.
  column "approval" {
    null    = false
    type    = text
    default = "pending"
  }
  # sha256 of the node's own secret. The secret itself is never stored.
  column "secret_hash" {
    null = false
    type = text
  }
  column "display_name" {
    null = true
    type = text
  }
  column "note" {
    null = true
    type = text
  }
  column "labels" {
    null    = false
    type    = sql("text[]")
    default = sql("'{}'::text[]")
  }
  # The latest heartbeat body, minus history. Shown on the node page.
  column "facts" {
    null    = false
    type    = jsonb
    default = sql("'{}'::jsonb")
  }
  column "revision" {
    null = true
    type = text
  }
  column "agent_version" {
    null = true
    type = text
  }
  column "config_revision" {
    null = true
    type = text
  }
  column "heartbeat_interval_seconds" {
    null    = false
    type    = integer
    default = 60
  }
  column "remote_addr" {
    null = true
    type = text
  }
  # role-token: proved it holds its role's shared key. hello: announced itself
  # and waited for approval. dashboard: a person added it.
  column "enrolled_via" {
    null    = false
    type    = text
    default = "hello"
  }
  column "first_seen_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "last_seen_at" {
    null = true
    type = timestamptz
  }
  column "approved_at" {
    null = true
    type = timestamptz
  }
  column "approved_by" {
    null = true
    type = text
  }
  column "retired_at" {
    null = true
    type = timestamptz
  }
  # Set when "went offline" was announced, cleared when it reports again, so
  # one outage sends one notification.
  column "offline_notified_at" {
    null = true
    type = timestamptz
  }
  primary_key {
    columns = [column.id]
  }
  check "nodes_id_is_sha256" {
    expr = "id ~ '^[0-9a-f]{64}$'"
  }
  # Every role in packages/fleet/roles.json; scripts/fleet_roles.py sync
  # rewrites the list. A retired role stays until its rows are gone.
  check "nodes_role_known" {
    expr = "role IN ('ci', 'web', 'cache', 'netboot', 'devbox')"
  }
  check "nodes_approval_known" {
    expr = "approval IN ('pending', 'approved', 'rejected', 'retired')"
  }
  check "nodes_enrolled_via_known" {
    expr = "enrolled_via IN ('role-token', 'hello', 'dashboard')"
  }
  check "nodes_interval_sane" {
    expr = "heartbeat_interval_seconds BETWEEN 5 AND 3600"
  }
  index "nodes_role_idx" {
    columns = [column.role]
  }
  index "nodes_approval_idx" {
    columns = [column.approval]
  }
  index "nodes_last_seen_idx" {
    columns = [column.last_seen_at]
  }
}

# Short history for the sparklines. Pruned by the API (see retention in code).
table "heartbeats" {
  schema = schema.fleet
  column "node_id" {
    null = false
    type = text
  }
  column "at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "uptime_seconds" {
    null = true
    type = bigint
  }
  column "load1" {
    null = true
    type = real
  }
  column "mem_used_percent" {
    null = true
    type = real
  }
  column "disk_percent" {
    null = true
    type = real
  }
  column "slots" {
    null = true
    type = integer
  }
  column "busy_slots" {
    null = true
    type = integer
  }
  # Optional bounded hardware samples; older agents and historical rows stay null.
  column "telemetry" {
    null = true
    type = jsonb
  }
  column "revision" {
    null = true
    type = text
  }
  primary_key {
    columns = [column.node_id, column.at]
  }
  foreign_key "heartbeats_node_fk" {
    columns     = [column.node_id]
    ref_columns = [table.nodes.column.id]
    on_delete   = CASCADE
  }
  index "heartbeats_at_idx" {
    columns = [column.at]
  }
}

# Everything that happened: boots, rollbacks, approvals, outages, setting
# changes. node_label keeps the name readable after a node is deleted.
table "events" {
  schema = schema.fleet
  column "id" {
    null = false
    type = bigint
    identity {
      generated = ALWAYS
    }
  }
  column "at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "node_id" {
    null = true
    type = text
  }
  column "node_label" {
    null = true
    type = text
  }
  column "kind" {
    null = false
    type = text
  }
  column "severity" {
    null    = false
    type    = text
    default = "info"
  }
  column "message" {
    null = false
    type = text
  }
  column "data" {
    null    = false
    type    = jsonb
    default = sql("'{}'::jsonb")
  }
  primary_key {
    columns = [column.id]
  }
  foreign_key "events_node_fk" {
    columns     = [column.node_id]
    ref_columns = [table.nodes.column.id]
    on_delete   = SET_NULL
  }
  check "events_severity_known" {
    expr = "severity IN ('info', 'warn', 'error')"
  }
  index "events_at_idx" {
    on {
      desc   = true
      column = column.at
    }
  }
  index "events_node_at_idx" {
    on {
      column = column.node_id
    }
    on {
      desc   = true
      column = column.at
    }
  }
}

# Configuration, one document per scope: "fleet", "role:ci", "node:<id>".
# A node receives the merge of the documents that apply to it.
table "settings" {
  schema = schema.fleet
  column "scope" {
    null = false
    type = text
  }
  column "value" {
    null    = false
    type    = jsonb
    default = sql("'{}'::jsonb")
  }
  column "updated_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "updated_by" {
    null = true
    type = text
  }
  primary_key {
    columns = [column.scope]
  }
}

# Who changed what, kept so a bad change can be read back and undone.
table "settings_history" {
  schema = schema.fleet
  column "id" {
    null = false
    type = bigint
    identity {
      generated = ALWAYS
    }
  }
  column "scope" {
    null = false
    type = text
  }
  column "value" {
    null = false
    type = jsonb
  }
  column "changed_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  column "changed_by" {
    null = true
    type = text
  }
  primary_key {
    columns = [column.id]
  }
  index "settings_history_scope_idx" {
    on {
      column = column.scope
    }
    on {
      desc   = true
      column = column.changed_at
    }
  }
}

# Browser Google/OIDC authorization; never seeded from source code.
table "allowed_emails" {
  schema = schema.fleet
  column "email" {
    null = false
    type = text
  }
  column "added_by" {
    null = false
    type = text
  }
  column "added_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key { columns = [column.email] }
}

# Browser Google/OIDC authorization; never seeded from source code.
table "login_transactions" {
  schema = schema.fleet
  column "state_hash" {
    null = false
    type = text
  }
  column "binding_hash" {
    null = false
    type = text
  }
  column "verifier" {
    null = false
    type = text
  }
  column "nonce" {
    null = false
    type = text
  }
  column "next_path" {
    null = false
    type = text
  }
  column "expires_at" {
    null = false
    type = timestamptz
  }
  primary_key { columns = [column.state_hash] }
  index "login_transactions_expiry" { columns = [column.expires_at] }
}

# Browser Google/OIDC authorization; never seeded from source code.
table "browser_sessions" {
  schema = schema.fleet
  column "session_context" {
    type = text
    null = false
  }
  column "token_hash" {
    null = false
    type = text
  }
  column "issuer" {
    null = false
    type = text
  }
  column "subject" {
    null = false
    type = text
  }
  column "email" {
    null = false
    type = text
  }
  column "expires_at" {
    null = false
    type = timestamptz
  }
  primary_key { columns = [column.token_hash] }
  index "browser_sessions_expiry" { columns = [column.expires_at] }
}

# Browser Google/OIDC authorization; never seeded from source code.
table "access_audit" {
  schema = schema.fleet
  column "id" {
    null = false
    type = bigint
    identity { generated = ALWAYS }
  }
  column "email" {
    null = false
    type = text
  }
  column "actor" {
    null = false
    type = text
  }
  column "action" {
    null = false
    type = text
  }
  column "at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key { columns = [column.id] }
}
