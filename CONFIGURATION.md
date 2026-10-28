# Fleet controller configuration

Fleet runs as **one native Bun process supervised by Litestream**. SQLite is built
into Bun. S3-compatible object storage holds the durable replica; the local
SQLite working directory can be restored on a replacement host. Run one writer
per database and replica prefix. There are no selectable storage backends.

The controller package is `packages/fleet-controller` and its example unit is
`fleet-controller.service`. Existing environment variable names, node `fleetApi`
settings, HTTP routes, port defaults and explicit `FLEET_DATABASE_PATH` values
remain unchanged. The default working file remains package-local at `data/fleet.db`;
when renaming an existing checkout, move that working directory with the package.

## Required settings

Copy [deployment.env.example](deployment.env.example) to `deployment.env` at the
repository root. Fill in all five settings. Fleet never provisions the bucket,
credentials, repository or identity provider.

| Setting | Required value / correction |
| --- | --- |
| `FLEET_ADMIN_TOKEN` | A random bearer secret of at least 32 characters, without whitespace. Generate your own with `openssl rand -hex 32`. |
| `FLEET_GITHUB_REPO` | `owner/name` of the repository your nodes follow. No default to someone else's repository. |
| `FLEET_S3_BUCKET` | An existing bucket name: 3–63 lowercase letters, digits, hyphens or dots. Supply the name, not a URL. |
| `AWS_ACCESS_KEY_ID` | Access key for that bucket/prefix. |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key. |

Give the S3 credentials List/Get/Put/Delete permissions for the selected bucket
and prefix, including multipart-upload permissions required by the provider.
For non-AWS storage, set `FLEET_S3_ENDPOINT` to the provider's HTTPS origin.
Do not put credentials in URLs. Never commit `deployment.env`.

## Install, check and start

Install **Bun 1.4.4** and **Litestream 0.5.17** using their official installation
instructions. Put both executables on PATH, or set `FLEET_LITESTREAM_BIN`.
From the repository root:

```sh
bun install --frozen-lockfile
bun run build
cp deployment.env.example deployment.env
# Fill in deployment.env, including the endpoint for non-AWS storage.
bun --env-file=deployment.env run check:config
bun --env-file=deployment.env run start
```

The explicit `--env-file` matters: `deployment.env` is not loaded by a plain
`bun run start`. Service managers may supply the same variables directly.
`check:config` validates settings, runtime/binary versions, built dashboard assets
and local directory access. It does not contact S3 or create a SQLite database.

Startup restores a missing working file, initializes/validates the SQLite schema,
and performs an initial replica sync **before listening for HTTP traffic**. This
checks real bucket access even when a local database already exists. A fresh
bucket/prefix is allowed; access failures never trigger an empty-data fallback.
After the initial sync, Litestream continuously replicates while supervising the
controller. Startup failures exit nonzero, identify the failing stage and explain the
fix. A failed worker/replication process also exits nonzero for the service
manager to restart. Credentials and SQL parameters are never included in Fleet's
error messages; retain the preceding Litestream diagnostic when investigating
S3 failures.

## Optional settings and defaults

| Setting | Default / meaning |
| --- | --- |
| `FLEET_DATABASE_PATH` | Absolute path to `packages/fleet-controller/data/fleet.db` in this checkout. Set an absolute path for a service installation. The file and its directory must be writable by the service user. Relative overrides resolve from the controller package working directory when using `bun run start`. |
| `FLEET_S3_PREFIX` | `fleet`. Use a unique prefix per independent deployment; no leading/trailing slash, empty segments or `.`/`..` segments. Reuse it when replacing the same node. |
| `FLEET_S3_ENDPOINT` | AWS S3 by default. For other providers, an HTTPS origin without path/query/credentials. Loopback HTTP is allowed for local testing only. |
| `AWS_REGION` | `us-east-1`. Set your bucket region, or `auto` for providers that require it. |
| `AWS_SESSION_TOKEN` | Unset. Supply when using temporary AWS credentials; renew credentials before expiration. |
| `PORT` | `8080`; an integer from 1 to 65535. Use an unused port above 1023 without root privileges. |
| `FLEET_LITESTREAM_BIN` | `litestream` on PATH; must report version 0.5.17. |
| `FLEET_STARTUP_TIMEOUT_SECONDS` | `60` per restore/initial-sync operation; integer 1–3600. Increase for large databases or slow object storage. A stalled startup is terminated with a nonzero exit, preserving local data for investigation. No deadline is applied to the running controller. |
| `FLEET_ROLE_TOKEN_HASHES` | `{}`. Nodes require manual approval unless a role's SHA-256 shared-token hash is configured in this JSON map. |

Browser login is optional. Supply **all three** of `FLEET_OIDC_ISSUER` (HTTPS OIDC
issuer), `FLEET_OIDC_CLIENT_ID`, and `FLEET_PUBLIC_ORIGIN` (HTTPS origin, or loopback
HTTP for development), or leave all three unset. Register the exact callback
`${FLEET_PUBLIC_ORIGIN}/auth/callback`. Invalid/incomplete settings fail startup.
Without OIDC, use the bearer-token controller administration endpoints. Explicitly authorize the first
browser owner after Fleet has restored and started:

```sh
bun --env-file=deployment.env run access:allow owner@example.org
```

Use the same checkout/environment and working-file path as the running service.
First browser sign-in never grants access automatically.

## Keep it running

Use your OS service manager to restart `bun run start` after a failure. An
[example systemd unit](examples/deployment/fleet-controller.service) supplies the same
environment from `/etc/fleet/fleet.env`, restarts after unexpected exits and allows 60
seconds for shutdown. Edit paths and the service user before installing it;
Fleet does not install units, create users or provision credentials for you.
Put your HTTPS reverse proxy in front of port 8080 for remote browser access.
Monitor `/health` and Litestream's logs/replica freshness. `/health` checks the
controller/database, not ongoing S3 replication; Litestream retries transient outages.

Stop the old writer before starting a replacement. Preserve the complete local
directory across ordinary restarts, including the WAL/SHM and Litestream metadata.
To replace a lost host, use the same environment/bucket/prefix with an empty
writable directory. Do not copy just a live `.db` file. Never run a restore drill
alongside the original writer against the same prefix.

Replication is asynchronous (one-second interval). Abrupt host loss may lose
recent writes; S3 outages widen this window. A graceful stop lets Litestream
perform a final sync. Retain local state if that sync fails. Do not use bucket
lifecycle rules that independently delete active replica objects.

## Troubleshooting

| Failure stage | What to fix |
| --- | --- |
| Configuration | Set the named settings in `deployment.env`, correct their format, and include `--env-file=deployment.env`. Removed backend settings must be unset, including blank ones. |
| Runtime / Litestream | Install Bun 1.4.4 and Litestream 0.5.17; correct PATH or `FLEET_LITESTREAM_BIN`. |
| Assets | Run `bun install --frozen-lockfile` and `bun run build`; make the built assets readable by the service user. |
| Filesystem | Fix directory/file ownership and write access, free disk space, or choose another `FLEET_DATABASE_PATH`. |
| Restore / initial replica write | Check endpoint, region, bucket/prefix, credential validity, network connectivity and List/Get/Put/Delete permissions. Read the preceding Litestream error. Startup never falls back to unreplicated operation. |
| SQLite / schema | Stop other writers. Preserve corrupt files before restoring. If the schema is newer, deploy the matching newer Fleet version; never lower the schema version manually. |
| Listen | Free `PORT` or choose an unused unprivileged port; stop the previous instance. |

`DATABASE_URL`, `FLEET_DB_PREPARE`, `FLEET_DATABASE_URL`,
`FLEET_DATABASE_AUTH_TOKEN`, and `FLEET_STORAGE_MODE` are removed and rejected.
PostgreSQL data is not imported. Start with a fresh SQLite installation or arrange
a reviewed export/import before cutover.
