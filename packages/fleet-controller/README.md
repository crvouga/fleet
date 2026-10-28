# Fleet controller

One native Bun/Hono controller coordinates node enrollment, configuration, telemetry and recovery through its React dashboard and HTTP endpoints. Bun's built-in
SQLite stores nodes, settings, telemetry, events, sessions and access rules.
Litestream restores and replicates the working database to S3-compatible storage.
Schema initialization is automatic. Production always uses Litestream.

**Start here: [configuration and deployment](../../CONFIGURATION.md).** It lists
all required settings, optional defaults, native installation, preflight checks,
service supervision, restore behavior and corrective actions for startup failures.
Copy [the environment template](../../deployment.env.example) at the repository
root and start with `bun --env-file=deployment.env run start` from there.

`bun run check` runs portable validation against real temporary SQLite files.
For the full recovery drill, install Litestream 0.5.17 and
`moto[controller]==5.1.17` in a Python virtual environment, then run
`python packages/fleet-controller/scripts/check-replication.py`. This starts only
loopback S3 test storage and uses fake credentials. It verifies that the actual
production launcher restores data after all local working state is deleted.
