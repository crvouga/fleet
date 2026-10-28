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
repository root. Fill in all four settings. Fleet never provisions the bucket,
credentials, repository or identity provider.

| Setting                 | Required value / correction                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `FLEET_ADMIN_TOKEN`     | A random bearer secret of at least 32 characters, without whitespace. Generate your own with `openssl rand -hex 32`. |
| `FLEET_S3_BUCKET`       | An existing bucket name: 3–63 lowercase letters, digits, hyphens or dots. Supply the name, not a URL.                |
| `AWS_ACCESS_KEY_ID`     | Access key for that bucket/prefix.                                                                                   |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key.                                                                                            |

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

| Setting                         | Default / meaning                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FLEET_DATABASE_PATH`           | Absolute path to `packages/fleet-controller/data/fleet.db` in this checkout. Set an absolute path for a service installation. The file and its directory must be writable by the service user. Relative overrides resolve from the controller package working directory when using `bun run start`.                                  |
| `FLEET_S3_PREFIX`               | `fleet`. Use a unique prefix per independent deployment; no leading/trailing slash, empty segments or `.`/`..` segments. Reuse it when replacing the same node.                                                                                                                                                                      |
| `FLEET_S3_ENDPOINT`             | AWS S3 by default. For other providers, an HTTPS origin without path/query/credentials. Loopback HTTP is allowed for local testing only.                                                                                                                                                                                             |
| `AWS_REGION`                    | `us-east-1`. Set your bucket region, or `auto` for providers that require it.                                                                                                                                                                                                                                                        |
| `AWS_SESSION_TOKEN`             | Unset. Supply when using temporary AWS credentials; renew credentials before expiration.                                                                                                                                                                                                                                             |
| `PORT`                          | `8080`; an integer from 1 to 65535. Use an unused port above 1023 without root privileges.                                                                                                                                                                                                                                           |
| `FLEET_LITESTREAM_BIN`          | `litestream` on PATH; must report version 0.5.17.                                                                                                                                                                                                                                                                                    |
| `FLEET_STARTUP_TIMEOUT_SECONDS` | `60` per restore/initial-sync operation; integer 1–3600. Increase for large databases or slow object storage. A stalled startup is terminated with a nonzero exit, preserving local data for investigation. No deadline is applied to the running controller.                                                                        |
| `FLEET_ENROLLMENT_TOKENS`       | `[]`. Nodes require manual approval unless they present an enrollment token whose SHA-256 is listed here: a JSON array (at most 16) of `{ "sha256": "<64 hex>", "role": "<active role>" \| null }`. A matching token approves the node and assigns the role when the node has none. `FLEET_ROLE_TOKEN_HASHES` is refused at startup. |

Each deployment uses one operator-owned user pool. Fleet connects directly to its
standard OIDC provider; no shared auth relay, Google account, Vault, or original
infrastructure is required. Register a public client with authorization code +
S256 PKCE and enable the standard `openid email profile` scopes. The provider must
issue signed ID tokens containing `iss`, `sub`, `email`, and `email_verified: true`.

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
First browser sign-in never grants access automatically. Fleet owns its opaque,
SQLite-backed sessions and email allowlist; the provider owns user authentication.
Provider errors refuse sign-in and never select another provider or fixture user.

For application embedding, `startController(env, log, { authFactory, fetch })` in
`packages/fleet-controller/src/controller.ts` is the trusted composition boundary.
`AuthFactory` receives the deployment OIDC configuration, access store, clock, and
HTTP transport and returns `AdminAuth` and optional `BrowserAuth` interfaces. A
replacement factory fully replaces default authentication; an invalid factory
fails startup. No request or tenant field selects the adapter. Keep production
browser adapters on validated OIDC code + S256 PKCE.

The default factory in `src/auth/composition.ts` explicitly constructs
`FleetBrowserAuth(access, oidc, provider, now)`. To replace only the provider,
inject an `IdentityProvider` implementing `authorize` and `exchange` while keeping
Fleet sessions and access management. Its `exchange` implementation must return
claims only after signature, issuer, audience, expiry, state, and nonce validation.
`createOidcClient(oidc, fetch)` supplies this validation using `openid-client`;
all discovery, token, and signing-key requests use the supplied transport. There
is no implicit provider construction inside the browser auth service.

## Keep it running

### Container hosting

The root `Dockerfile` packages the same controller and Litestream supervisor for
`linux/amd64` hosting. Build without secrets with
`docker build --platform linux/amd64 -t fleet .`.
It pins Bun 1.4.4 and Litestream 0.5.17, builds dashboard assets, installs frozen
production dependencies, and runs as the unprivileged `bun` user. The entrypoint
receives SIGTERM directly. Supply the settings above as runtime environment
variables; no Vault client or credentials are included in the image.

The working file defaults to `/var/lib/fleet/fleet.db`. Its directory is writable
without a persistent volume: ordinary container restarts retain it, and a newly
created container restores from S3. A mounted directory must also be writable by
the container user. Allow at least 60 seconds for shutdown and a startup grace
covering both restore and initial sync (60 seconds each by default). Configure
one replica with **stop-before-start deployment**, including rollback; ordinary
rolling deployment can corrupt the replica by running two writers concurrently.

`.github/workflows/publish.yml` builds and tests the Linux image on pull requests.
The container check uses disposable Moto S3 storage to exercise readiness,
graceful shutdown, restart persistence, fresh-container restore, denied writes
and refusal to start without configuration. Trusted main pushes call workspace's
reusable publisher for `ghcr.io/crvouga/chrisvouga-fleet-api:<commit-sha>` and
`:latest`. Deployment notification is disabled until the workspace inventory and
Vault bindings are ready. Hosting, secrets and DNS remain OpenTofu-owned in the
operator's platform repository. Image publication does not establish live
deployment, real R2 permissions, replica freshness or OIDC acceptance.

### Native service manager

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

| Failure stage                   | What to fix                                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration                   | Set the named settings in `deployment.env`, correct their format, and include `--env-file=deployment.env`. Removed backend settings must be unset, including blank ones.                                       |
| Runtime / Litestream            | Install Bun 1.4.4 and Litestream 0.5.17; correct PATH or `FLEET_LITESTREAM_BIN`.                                                                                                                               |
| Assets                          | Run `bun install --frozen-lockfile` and `bun run build`; make the built assets readable by the service user.                                                                                                   |
| Filesystem                      | Fix directory/file ownership and write access, free disk space, or choose another `FLEET_DATABASE_PATH`.                                                                                                       |
| Restore / initial replica write | Check endpoint, region, bucket/prefix, credential validity, network connectivity and List/Get/Put/Delete permissions. Read the preceding Litestream error. Startup never falls back to unreplicated operation. |
| SQLite / schema                 | Stop other writers. Preserve corrupt files before restoring. If the schema is newer, deploy the matching newer Fleet version; never lower the schema version manually.                                         |
| Listen                          | Free `PORT` or choose an unused unprivileged port; stop the previous instance.                                                                                                                                 |

`DATABASE_URL`, `FLEET_DB_PREPARE`, `FLEET_DATABASE_URL`,
`FLEET_DATABASE_AUTH_TOKEN`, and `FLEET_STORAGE_MODE` are removed and rejected.
PostgreSQL data is not imported. Start with a fresh SQLite installation or arrange
a reviewed export/import before cutover.

## Enrollment and installer publication

The core controller, dashboard and installer enrollment do not require a GitHub
repository or account. Nodes register directly with `/v1/nodes/register` using
a private per-node secret and appear under **Pending**. An authorized Fleet
owner approves or rejects them in the app. The live installer waits up to five
minutes for approval before disk changes; rejection and timeout leave disks
untouched. Its credential is copied into the installed system.

The installer installs the role-less `base` system. The controller decides what
each machine is for: approve it (optionally choosing a role), or assign, change
or remove its role later on the node page or with `PATCH /v1/nodes/:id { role }`.
A reinstalled machine keeps its hardware node id, so its stored role is applied
again after approval. A role change is a drained reboot into the new closure,
not a reinstall.

`FLEET_ENROLLMENT_TOKENS` is optional, for explicitly authorized automatic
approval. Generate a random token (for example `openssl rand -hex 32`), give it
to the installer as the optional enrollment token, and list only its hash:

```sh
token=$(openssl rand -hex 32)
printf %s "$token" | sha256sum   # the "sha256" value
FLEET_ENROLLMENT_TOKENS='[{"sha256":"<hash>","role":"ci"},{"sha256":"<hash2>","role":null}]'
```

A node presenting a listed token is approved; the entry's `role` is assigned
only when the node has none, and re-registration never clears an assigned role.
`FLEET_ROLE_TOKEN_HASHES` is no longer read: startup fails until each old
`{ "<role>": "<hash>" }` pair is moved to `FLEET_ENROLLMENT_TOKENS` as
`{ "sha256": "<hash>", "role": "<role>" }` and the old variable is unset.

Role secrets stay in the operator's repository, encrypted with SOPS. Each node
creates its own age identity on first boot and reports only the public
recipient. `GET /v1/recipients` (admin) lists the recipients of approved nodes
by assigned role; re-encrypt each role's file to them (`sops updatekeys`) and
merge. Fleet never holds a private age key or writes to Git. A node whose
recipient is missing reports itself blocked until that change is merged.

Set optional `FLEET_INSTALLER_DIR` to an absolute directory containing built
installer executables, archives, the ISO or image parts, readiness metadata, and
matching `.sha256` files. Publish native installer checksums alongside each file
(for example `fleet-installer-windows-x64.exe.sha256`). Build from this checkout;
use `packages/fleet/scripts/release-image.py` for verified ISO parts and metadata.
The app's `/installers/release` page lists downloads and `/installers/assets/`
serves only allowed artifact names. Artifacts are public read-only downloads;
keep all secrets outside that publication directory. Symlinks escaping it are
refused. Missing images are reported explicitly, with no upstream fallback.

Installer clients select this app with `FLEET_CONTROLLER_URL=https://fleet.example.org`
or enter that origin in the wizard. `FLEET_INSTALLER_URL` remains an explicit
image URL override. The image must be built with your intended `fleetApi.url`;
entering a download origin never rewrites the image's trusted approval authority.

Set optional `FLEET_TARGET_REVISION` to a full 40-character Git commit to display
which nodes are behind. With it unset, the desired revision is unknown; Fleet
does not query GitHub. Nodes still pull their operator-configured Git source,
which can be hosted on any suitable Git server. SSH sources use public host-key
pins supplied in `repo.sshKnownHosts`.

GitHub remains optional for CI runner roles and user-initiated bug reports.
`FLEET_BUG_REPORT_REPO=owner/name` on installer clients chooses the bug-report
repository; it never selects an image, enrollment service, or update source. The
legacy client `FLEET_GITHUB_REPO` is accepted only as a bug-report alias when
`FLEET_BUG_REPORT_REPO` is unset; the controller does not read it.
The former issue-triggered enrollment workflow has been removed.
