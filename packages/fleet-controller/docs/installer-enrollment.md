# Installer binding, enrollment grants, hardware tiers and installation progress

This is the installer-side companion to [PROTOCOL.md](../PROTOCOL.md) (registration and enrollment) and
[ARCHITECTURE.md](../../../ARCHITECTURE.md) (the installer installs `base`, the controller assigns). It
documents what an installer is bound to, how a machine is enrolled without anyone copying a token, what a
person sees while it installs, and what is and is not verified. Everything below is additive: approval in
the dashboard and `FLEET_ENROLLMENT_TOKENS` behave exactly as before.

## How the wizard learned the controller before

Nothing tied a downloaded installer to the app that issued it. The wizard (`packages/fleet/wizard`) is one
generic binary per platform: it took the controller either from the `FLEET_CONTROLLER_URL` /
`FLEET_INSTALLER_URL` environment variables or from an address a person typed into **Connect to Fleet**
(`/api/source`). The enrollment token was a separate thing a person pasted (or `FLEET_ENROLLMENT_TOKENS`
on the controller, long-lived and shared). Any installer would talk to any controller it was pointed at,
and a leaked static token enrolled any number of machines until the operator rotated it.

## Enrollment grants

A grant is created per **Add node → Bind the installer to this app** action (admin only, audited).

| Property          | Value                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Token             | `fgr_` + 32 random bytes, base64url (47 chars, inside the enrollment-token alphabet, so every existing path carries it) |
| Stored            | `enrollment_grants.token_hash = sha256(token)` only. The token exists once, in the downloaded file                      |
| Lifetime          | default 24 h; 5 minutes to 7 days (`ttlSeconds`)                                                                        |
| Role              | optional, an active role                                                                                                |
| States            | `pending` (unused, unexpired, unrevoked), `used`, `expired`, `revoked` (derived; precedence revoked, used, expired)     |
| Binding to a node | the first node id that registers with it (`used_by_node`); permanent                                                    |
| Listing           | `GET /v1/enrollment/grants` (viewers may read) and the Add node page; never shows a token or hash                       |

### Registration with a grant

`POST /v1/nodes/register` is unchanged on the wire: the grant goes in `enrollmentToken`. A static token
that matches wins first. Otherwise a token starting `fgr_` goes through one atomic conditional
`UPDATE … WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now` (SQLite serializes writers,
so exactly one concurrent registration wins; tested with eight at once).

| Outcome                                      | Result                                                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redeemed` (first use)                       | node bound to the grant. With a role: `approved`, role assigned, `enrolledVia: "enrollment-token"`. Without: `pending`                                                        |
| `resumed` (same node id again, until expiry) | same rule as above. An interrupted install can retry                                                                                                                          |
| `reused` (any other node id)                 | the new node is **`pending`**, no role. Audit `enrollment.grant_reused` (outcome `denied`) and an `enrollment_grant_reused` warn event on **both** the new and the first node |
| `expired` / `revoked`                        | `pending`, audit `enrollment.grant_refused` (denied) and an `enrollment_grant_refused` warn event                                                                             |
| unknown `fgr_…`                              | `pending`, like a static token that does not match. No record                                                                                                                 |

If writing the node fails after a grant was redeemed, the grant is released so the installer is not burned.
Success writes `enrollment.grant_redeem` (actor `node:xxxx`) and an `enrollment_grant_redeemed` event.
Audit and events never contain the token.

**Decision: a grant approves only if the administrator also chose a role.** Creating a grant is the
administrator's act, so a role-less grant could in principle stand for approval. It does not: a leaked
role-less grant then buys an attacker nothing but a `pending` row that a person still reviews, and
"never wipe or admit a machine without explicit informed authorization" stays true. A grant with a role
is equivalent to a one-time, expiring `FLEET_ENROLLMENT_TOKENS` entry: the administrator has decided what
this machine is. The Add node form defaults to no role and warns when one is chosen.

### `POST /v1/enrollment/check` for a grant (read-only, rate limited like registration)

Body `{ "enrollmentToken", "binding"? }`. `200 { ok: true, kind: "grant", role, state: "pending" | "used",
approval: "automatic" | "manual", expiresAt }` (nothing is consumed, nothing is created).
`401` with `enrollment_grant_expired`, `enrollment_grant_revoked`, `enrollment_binding_invalid` (the signature
does not verify against this controller's key, or the grant id/token do not match) or `enrollment_not_ready`
(unknown). Static tokens answer as before.

### Admin API

| Route                                                         | Notes                                                                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/enrollment/grants` `{ role?, label?, ttlSeconds? }` | admin only, `201 { grant, binding, file: "fleet-bind.json" }`. The controller's own origin comes from the request's `Origin` (or forwarded host), never the body |
| `GET /v1/enrollment/grants?limit=`                            | newest first                                                                                                                                                     |
| `POST /v1/enrollment/grants/:id/revoke`                       | idempotent. Revoking a used grant stops a retry; it does not un-approve the node                                                                                 |

## The binding file

`fleet-bind.json`:

```json
{
  "v": 1,
  "origin": "https://fleet.example.org",
  "grant": "fgr_…",
  "grantId": "…",
  "issuedAt": "…Z",
  "expiresAt": "…Z",
  "keyId": "…",
  "sig": "<hex hmac-sha256>"
}
```

`sig` is HMAC-SHA256 over `fleet-bind`, `v1`, origin, grantId, grant, issuedAt, expiresAt, keyId (newline
separated) under a random 32-byte secret in `controller_secrets` (`enrollment-binding-key`), created on first
use (insert-if-absent, so concurrent first calls agree). Only the issuing controller can verify it.

**Delivery per artifact.** The published installers are immutable, checksummed and shared by every
download, and the Windows `.exe` is Authenticode-signed, so no binding is ever written into them. The
file is a separate small download next to the installer:

| Artifact                      | Binding                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Windows `.exe`                | beside the `.exe` or in Downloads. Never modified                                                             |
| macOS `.zip`, Linux `.tar.gz` | beside the unzipped program (a macOS `.app` is searched one level up), the working directory, or Downloads    |
| `fleet-node.sh` / CLI         | not read; use `--token-file` (a grant is a valid token)                                                       |
| USB media                     | none: a stick lives long and is easy to copy, so it carries no grant; the booted computer waits under Pending |

The wizard accepts `fleet-bind.json` and the browser's `fleet-bind (1).json`; the newest valid, unexpired
file wins. `FLEET_BINDING_FILE` names one explicitly (tests, automation).

### What the wizard does with it

- Reads it offline: size ≤ 4 KiB, schema, https origin (or loopback http for local tests), not expired. An expired or invalid file is reported on the home screen with the next step; it stops an in-place install but not making a USB.
- The bound origin becomes the installer source when none is set, so nobody types an address. A different origin (the source form, `FLEET_CONTROLLER_URL`, `FLEET_INSTALLER_URL`) is **refused for every mode** ("this installer is bound to …").
- At review it asks the bound controller read-only (`/v1/enrollment/check` with the grant and the binding) over verified TLS (`fleet_tls`). Redirects are refused, so the grant can only ever travel to the bound origin. An expired, revoked, modified or foreign binding refuses the plan before anything is erased. A grant that is already used, or an outage or older controller, is shown as a warning: registration after the restart decides.
- Hands the grant to the live installer through the existing private handoff (never shown, logged, in arguments or on a kernel command line; redacted in the log). A token a person pastes wins and the grant is then not presented.
- The wizard cannot verify the HMAC itself (it does not hold the secret); the controller does.

The live installer additionally maps `enrollment_grant_expired` / `enrollment_grant_revoked` to
`FLEET_ENROLLMENT_EXPIRED` / `FLEET_ENROLLMENT_REVOKED` ("Nothing was erased") before it registers or erases.

## Threat model

| Threat                                                                                                 | Protected?                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Installer from the wrong controller** (typo, phishing address, an installer meant for another fleet) | Yes for the wizard: it downloads only from the bound origin and the controller rejects a binding it did not sign. A grant presented to any other controller is unknown there (fails closed, nothing erased)                                                                                      |
| **Controller impersonation**                                                                           | TLS validation as for every download (certifi bundle in frozen builds). The grant is sent only to the bound origin over verified TLS, no redirects. An attacker who controls DNS and a CA-trusted certificate for the origin could still read the grant; the grant is single-use and short lived |
| **Cloned installer / file copied to another machine**                                                  | The first machine to register wins; the copy becomes `pending` with no role and a warning on both nodes. With a role, the copy cannot take the role                                                                                                                                              |
| **Leaked `fleet-bind.json` before first use**                                                          | **Not prevented.** The holder can enroll one machine once: `pending` (role-less grant, a person decides) or approved with the preassigned role (role grant). Mitigations: short TTL, revoke in the dashboard, role-less by default. Treat the file as a credential; delete after use             |
| **Replay after use**                                                                                   | Refused: a different node id is `pending`; the bound node may resume only until expiry                                                                                                                                                                                                           |
| **Expired or revoked grant**                                                                           | Refused at check, at register (pending) and by the live installer before erasing                                                                                                                                                                                                                 |
| **Forged or edited binding**                                                                           | The controller verifies the HMAC on check; an edited file does not verify. Registration itself does not take the binding, only the token, so an edited origin can only misdirect the wizard, not enroll anything                                                                                 |
| **Database / replica leak**                                                                            | Hashes of grants only. The HMAC key is in `controller_secrets` (replicated with the database): its theft lets an attacker forge a binding for a grant token they already hold, nothing more                                                                                                      |
| **A grant used by an attacker's hardware instead of the intended machine**                             | Not detectable: node ids are hardware-derived but not secret and the controller cannot tell which physical machine was meant. A person reviewing `pending` is the control for role-less grants                                                                                                   |
| **Wiping a machine without informed consent**                                                          | Unchanged and independent of grants: the disk is erased only after the person at the machine confirms the exact disk in the wizard (or boots the USB entry) and, in managed mode, the controller approved this identity                                                                          |

## Installation progress and errors

The live installer already sent a heartbeat per 20 s once it was approved (best effort, never blocking
the install). What was missing, now added:

- **Phase.** `fleet-install.sh` records its step (`network`, `approval`, `checks`, `disk`, `erase`, `install`) and every report is `FLEET_<CODE>: phase=<step> <text>`. The failure trap names the step it died in. Only the installer writes `phase=`, so installed nodes are never mistaken for installers.
- **Redacted and bounded.** Messages pass `agent.redact` (node secret, enrollment token or grant, key patterns), and are cut at 500 characters. Reporting failures never change whether a disk operation is safe.
- **Live hardware verdict.** Before it registers, `bootstrap-readiness.py` classifies the machine (architecture, UEFI, RAM, whether any network adapter has a driver) and stops with `FLEET_HARDWARE_UNSUPPORTED`; a partial verdict is added to the progress report (`hardware=partially automated`).
- **Pending page.** "Installations in progress" lists every node whose first reconcile issue is phase-tagged: step n of 6, last report time, the last message and code, "Nothing has been erased yet" for the steps before `erase`, a **failed** badge with an actionable next step per code, a **no recent report** badge after 10 minutes of silence (the installer may have stopped, lost power or lost its network), and a link to `/report-issue?kind=installer&node=<id>` (the issue reporting feature builds that page).
- Not reported (by construction): a machine that has not yet registered (network/approval not reached) has nothing to report with; it is a `pending` row, and the installer screen on the machine shows the same advice (`scripts/live_console.py`).

| Code                                              | Next step shown                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `FLEET_API_UNAVAILABLE`                           | it retries by itself; check the machine's network and that this app is reachable from it |
| `FLEET_APPROVAL_REQUIRED`                         | approve under Pending, then open the installer again                                     |
| `FLEET_ENROLLMENT_EXPIRED` / `_REVOKED`           | create a new installer binding under Add node, or approve under Pending                  |
| `FLEET_ENROLLMENT_*`                              | remove the token or create a new binding                                                 |
| `FLEET_HARDWARE_UNSUPPORTED`                      | nothing erased; use supported hardware or fix what the message names                     |
| `FLEET_CACHE_*`                                   | wait a few minutes; report if it persists                                                |
| `FLEET_PLATFORM_NOT_READY`, `FLEET_METADATA_*`, … | an administrator must fix the deployment and publish a new installer                     |
| `FLEET_INSTALL_FAILED`                            | Alt+F2 → `fleet-status`, report; after `erase` the disk may have changed                 |

## Hardware support tiers

`classify_hardware` (`packages/fleet/scripts/decide.py`) is one pure function returning
`{ tier, reasons[], required_actions[], acknowledgement, checked[] }`. The wizard shows it on the home
screen and review page, `start()` and the privileged helper refuse `unsupported` (even when acknowledged)
and require the exact acknowledgement for `partially automated`, and the live installer re-classifies from
what it can see. The matrix and every reason code are in
[installer.md](../../fleet/docs/installer.md#hardware-support-tiers) and
[hardware.md](../../fleet/docs/hardware.md); the Add node page shows the same rows. Tests compare the
three (and the code) so they cannot drift. Wi-Fi as the only network is _partially automated_: driver
support in the live image cannot be proven before it boots.

## Interrupted installs, failed boots, network failures: what is verified

By reading the code and the existing/new tests (all simulated: fake `disko`, `nixos-install`, `kexec`, a
loopback controller; no disks, no firmware):

- **Interrupted install is safe to retry.** A failed or interrupted step leaves no `/nix/fleet-state/installed` marker; the next live boot repartitions and completes (`test_install.py::test_an_interrupted_install_is_safe_to_run_again`). Windows conversions that did not finish are taken back first (`test_windows_*recovery*`).
- **Wait before wipe on no network.** `fleet-wifi-ready` failing stops before `select-disk` and `disko` (`test_failed_wifi_readiness_stops_before_disk_operations`); integration/approval failures stop before the disk is selected (`test_integration_failure_never_selects_or_erases_a_disk…`). Approval waits at most five minutes and then stops without erasing (`test_pending_approval_timeout_never_authorizes_installation`).
- **Boot-count fallback.** `scripts/boot-count.sh` is covered by `test_boot_count.py` with simulated boot entries; the NixOS VM tests (`tests/*.nix`) need Nix and were not run here.
- **New:** a failure reports the phase it stopped in (`test_a_failure_is_reported_to_fleet_with_the_phase…`); expired/revoked grants stop before erasing; unsupported live hardware stops before registering.

### Needs real-hardware validation

None of the following can be established on a developer machine or in the simulations, and no platform claim is made for them:

- Windows in-place conversion end to end (shrink, ESP boot entry, the one-time firmware boot option, undo after a power cut), including BitLocker and Secure Boot behaviour.
- `kexec` handoff on real Linux machines and filesystems, and the live image's first boot on real UEFI firmware.
- USB writes and read-back on real sticks and card readers; booting a prepared stick on real firmware.
- Whether a given Wi-Fi or Ethernet adapter has a driver and firmware in the pinned Linux system (`wifi-vm` uses simulated radios).
- Boot-count fallback after three failed boots, and iPXE `exit 1` returning to disk, on a real board.
- macOS Keychain release of a saved Wi-Fi password; Windows SmartScreen/Authenticode behaviour with the real publisher certificate.
- The NixOS changes in `modules/installer.nix` are unchanged by this work; nothing here was built with Nix. The new Python in the live image rides in the existing tools directory (`decide.py`, `bootstrap_report.py`, `bootstrap-readiness.py`, `live_console.py` were already copied there).

## Limits

- The ISO's readiness document carries no controller address, so a wizard cannot compare the image's baked-in `fleetApi.url` with the binding's origin before downloading. A mismatch fails closed instead: the grant is unknown to the other controller and the live installer stops (`FLEET_ENROLLMENT_REJECTED`) before erasing.
- The grant is not carried on USB media, and the command-line `fleet-node.sh` does not read `fleet-bind.json`.
- A grant that was resumed by its own node after a person approved a role-less node re-registers as pending (the same as every unauthenticated re-registration: nobody who learns a node id can silently take over an approved node).
