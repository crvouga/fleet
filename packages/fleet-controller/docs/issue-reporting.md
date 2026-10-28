# One-click issue reporting

Every failure the dashboard shows has a **Report issue** link. It opens a
preview of a structured, redacted Markdown issue written for an AI coding agent
to pick up. An administrator confirms with one button; the controller files it
in GitHub, survives a GitHub outage, and never files the same failure twice.

Code: `src/issues/*` (builder, redaction, store, delivery), `src/db/issue-*.ts`
(SQLite), `src/routes/admin-issues.ts` (JSON API), `src/jobs/issue-sync.ts`
(retries), `src/ui/{components,pages,routes}/report-issue*.tsx` (server pages),
`src/console/report-issue*.tsx` (React console). Table: `issue_reports`
(schema v3). Tests: `test/issues/*`.

## The flow

1. **Report issue** (a plain link, works without JavaScript) opens
   `GET /report-issue?kind=<kind>&node=<id>&event=<id>&job=<id>&operation=<id>&request=<id>`.
   `kind` is `installer`, `node`, `controller` or `workload`; without it the kind is
   inferred (a job is a workload, a request id is the controller, the rest is a node).
   Ids are validated and unknown ones are refused, never guessed.
2. **Preview.** The page shows the title, the redaction summary (what classes of
   secret were removed and how many), any duplicate, and the full Markdown. For an
   administrator the redacted report is saved as a **draft** in `issue_reports`, so the
   diagnostics survive the node going away and what is filed is exactly what was shown.
   A **viewer** gets the same page read-only: no button, nothing saved.
3. **Create GitHub issue** (one button, `POST /report-issue`, same-origin checked
   like every admin form, audited). It files the stored draft.

JSON equivalents (cookie session or admin token; same-origin for cookies):

| Endpoint                                      | Who      | Meaning                                                                                                                                         |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/issues/preview` `{kind, node, ...}` | any role | The redacted report. `persisted: true` (admin: saved as a draft) or `false` (viewer).                                                           |
| `POST /v1/issues` `{draftId}` or a target     | admin    | 201 `created`, 202 `queued` (GitHub outage), 200 `duplicate`/`existing`, 409 `issues_not_configured`, 502 `issue_failed` (reason in `message`). |
| `GET /v1/issues`                              | any role | Reports, newest first, without bodies. `?node=`, `?limit=`, `?before=`.                                                                         |
| `GET /v1/issues/:id`                          | any role | One report with its body and status.                                                                                                            |
| `GET /v1/issues/links?node=&event=&event=`    | any role | Open reports for a node and for events, for the badges.                                                                                         |

## What is gathered

Automatically, from what the controller already holds. Nothing is fetched from a
node, and nothing is invented: anything missing is said so under "Reproduction"
or in `gaps`.

| Section                          | Content                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Summary, Classification          | The error message; a stable classification code and failing component (`rollback`, `secrets-recipient-missing`, `ci-job-failed`, `controller-error`, `installer-checksum`, ...); correlation and trace ids.                                      |
| Environment and versions         | Controller version and Git commit, agent version, node revision, desired and applied revision, closure; node id (short), hostname, assigned and observed role, status; hardware (capabilities, CPU, memory, disks, kernel, arch, uptime).        |
| Desired vs observed              | The desired document, observed role/closure/revision, convergence, reconcile phase and issues, rollback, health failure, failed units, readiness issues; the effective configuration (webhook URL reduced to its origin).                        |
| Timeline, Reconciliation history | Recent events (newest first); `desired_history` rows; revision / role_converged / reconcile_blocked / rollback events.                                                                                                                           |
| Logs and errors                  | Allowlisted telemetry logs, reconcile issues, health failures, failed units; for a controller report the recorded error with its top stack frames; related failures (failed CI jobs on the node; installer step failures from bootstrap events). |
| Actions already attempted        | Operations on the node (drain, restart, replace, decommission) and audit entries (retries, credential rotation, ...), with the actor's **role**, never an email.                                                                                 |
| Reproduction                     | The events that preceded the failing event, or the operation's steps; otherwise "Not available" with the reason.                                                                                                                                 |
| Suspected area                   | Repository paths to open first, chosen by failing component.                                                                                                                                                                                     |
| Acceptance criteria              | Tailored to the kind, plus a regression test, `bun run check` and no-secrets-in-logs.                                                                                                                                                            |
| Diagnostics (JSON)               | The whole redacted snapshot, valid JSON, shrunk by cutting long arrays (the cuts are recorded).                                                                                                                                                  |
| Fingerprint                      | The dedupe key, also embedded as `<!-- fleet-issue-fingerprint:... -->` on the first line.                                                                                                                                                       |

**Request ids.** The logger gives every request an id (`X-Request-ID`, `traceId` is
the same without dashes). An unhandled error is remembered in a bounded in-memory ring
keyed by it. A 5xx keeps its JSON body (`{error, message}`) and carries the id in
`X-Request-ID` and the report address in `X-Fleet-Report`; a browser navigation gets a
small page with the id and a **Report this problem** link. After a controller restart
the ring is empty, so a report for an old request id contains the id and no error.

**Git commit.** The image build does not stamp a commit. The controller reads
`FLEET_CONTROLLER_COMMIT`, then `RAILWAY_GIT_COMMIT_SHA`, `SOURCE_COMMIT`,
`GIT_COMMIT`, `GITHUB_SHA`; otherwise it reports `unknown`.

**Size.** The body stays under 60,000 characters (GitHub's limit is 65,536). The
largest truncatable section is halved first, and every cut is marked
`[truncated N lines]`; the preview lists the shortened sections.

## Redaction

`src/issues/redact.ts` is pure. It runs three times: over the structured snapshot
(by **key name** and by **value pattern**), over the rendered Markdown, and over the
title. Removed values become `[redacted]`; the preview shows counts per class.

Removed: GitHub tokens (`ghp_ gho_ ghs_ ghu_ ghr_ github_pat_`), Vault, AWS, Slack and
`sk-` tokens, JWTs, `Bearer`/`Basic`/`Authorization`/cookie values, age secret keys,
PEM private-key blocks (also truncated ones), SOPS ciphertext, credentials in URLs and
secret query parameters (`token`, `code`, `signature`, ...), `--token`/`--password`
flags, enrollment tokens, any `key=value` or `"key": "value"` whose key looks secret
(`password`, `secret`, `token`, `psk`, `passphrase`, `credential`, `apiKey`,
`privateKey`, `secretHash`, ... including `FLEET_ADMIN_TOKEN` style names and Wi-Fi
PSKs), hex runs of 56 or more digits (node secrets and sha256 hashes), the exact values
of the admin token(s), the webhook secret and the issues token (also URL-encoded,
base64 and JSON-escaped forms), and **every email address**.

Node ids are shortened to 12 characters (`node:abcdef012345`): ids and node secrets
share the 64-hex shape, so the full id is not published. The full id stays in the
`issue_reports.node_id` column.

Properties tested (`test/issues/redact.test.ts`, `canary.test.ts`): seeded generators
plant every secret shape in logs, JSON, URLs, YAML, flags and nested structures and
assert none survives; the canary pushes every shape through the real builder,
the stored draft, the JSON API and the HTML page.

**Limits, stated plainly.** Redaction is pattern based. It cannot remove a secret
that has no recognisable shape and no revealing key, for example a bare random
password in a sentence, or a random 40-character base64 string with no label.
Whitespace inside an unquoted value ends the match (`password=two words` leaves
`words`). Git commit ids (40 hex) are kept on purpose. Hostnames, display names, role,
repository and job names, and free-text event messages appear in the report; the
preview exists so a person reads it before anything leaves the controller. Do not file
reports to a public repository if node messages may contain secrets of other shapes.

Hostile text is handled structurally: node-controlled values appear only in Markdown
code spans or fenced blocks sized to outgrow any backtick run, so a message cannot
close the block, add a heading, link, image or `@mention`. In the dashboard they are
escaped by the template engine. Titles use only `[A-Za-z0-9._/-]` from node data.

## Deduplication

The fingerprint is the first 32 hex digits of SHA-256 over: kind, classification code,
the **normalized** message (ids, UUIDs, timestamps, paths, URLs, hex digests, age keys,
hostnames and numbers stripped), role, closure and failing component. The same failure
on another node of the same role, at another time, has the same fingerprint.

- The partial unique index `issue_reports_open_fingerprint_idx` allows one
  `queued`/`created` report per fingerprint. Concurrent submissions race on it; the
  loser becomes a `duplicate` of the winner.
- A second request returns the existing report (status `duplicate`, same issue link)
  and, at most once per 24 hours, adds a "Seen again" comment to the GitHub issue.
  A recurrence count is kept in the original report's snapshot.
- If the existing issue was **closed** on GitHub, it is retired (its row becomes
  `duplicate`, "closed on GitHub") and the new occurrence files a new issue.
  `duplicate` therefore means "no longer the open report for its fingerprint".
- Repeated previews refresh one draft per fingerprint; they do not pile up rows.
- Reports link back: the node page, the Events page and the Overview show
  `Issue #N` (or "Report queued") next to a failure that has an open report.

## Filing and outages

Filing is **optional** and configured only by the operator (see the variables below).
Not configured: the page says so and why, shows the Markdown with a copy button and,
when `FLEET_ISSUES_REPOSITORY` is set, a prefilled "new issue" address (shortened at a
line boundary with a note to stay under 7,500 characters; the fingerprint marker is on
the first line, so it always survives). `POST /v1/issues` answers 409
`issues_not_configured`. In synthetic fixture mode nothing is filed.

Failure classes (`src/issues/github-issues.ts`, `src/issues/delivery.ts`):

| Class                                                                                           | Result                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network error, timeout, 5xx, 408, 429, 403 with rate-limit headers or a secondary-limit message | **Temporary.** Status `queued`, `next_attempt_at` set with exponential backoff and jitter (30 s base, 1 h cap, equal jitter), or GitHub's `Retry-After`/rate-limit reset if longer (at most 2 h). |
| 401, 403 (other), 404, 410, 422, other 4xx                                                      | **Permanent.** Status `failed` with a visible, actionable `last_error` (check the token, the repository, the labels). The preview stays usable.                                                   |
| Temporary failures past 8 attempts                                                              | `failed` with "Gave up after N attempts. Open the report and press Create GitHub issue to try again."                                                                                             |

A `failed` report can be filed again (button on the preview). The retry job
(`src/jobs/issue-sync.ts`, every 15 s, registered only when issue reporting exists)
sends due `queued` reports and audits only the end of a delivery (`issue.deliver`).

**Idempotence.** An attempt is first _claimed_ (`attempts + 1`, `next_attempt_at` moved
to a lease), so two job passes or a request and a job cannot both send. Before creating,
the controller lists the repository's **open** issues created since the report and looks
for the fingerprint marker; if GitHub already has it (the controller crashed or lost
the answer after GitHub created the issue), that issue is adopted instead of creating a
second one. Closed or older issues are earlier occurrences and are not adopted.

## Configuration

| Variable                      | Meaning                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `FLEET_ISSUES_REPOSITORY`     | `owner/name`. Alone: prefilled link only.                                                                                      |
| `FLEET_ISSUES_GITHUB_TOKEN`   | Fine-grained token, **Issues: write** on that repository. Needs the repository. Memory only; never stored, rendered or logged. |
| `FLEET_ISSUES_LABELS`         | Comma-separated labels (at most 10). Default `fleet-report`.                                                                   |
| `FLEET_ISSUES_GITHUB_API_URL` | GitHub Enterprise Server API origin; HTTPS (HTTP only on loopback). Default `https://api.github.com`.                          |
| `FLEET_CONTROLLER_COMMIT`     | Optional build commit shown in reports.                                                                                        |

A token without a repository refuses startup (naming the variable, never the value).
Never put the token in the repository, a report, a log or a setting.

## Audit

`issue.preview` (admin, draft saved), `issue.create` (outcome and attempts),
`issue.duplicate`, `issue.deliver` (retry job, actor `system:issue-sync`). `detail`
holds the kind, fingerprint, report id and issue number; never a body, token or email.
Viewer attempts to create are refused 403 and audited as denied.

## Not covered here

- The React console page (`src/console/report-issue.tsx`) is type-checked, linted
  and bundled (`bun build`), but there is no automated browser test of it in this
  change; the server pages and the JSON API it calls are covered.
- The installer wizard's own local diagnostics report
  (`packages/fleet/wizard/diagnostics.py`) is unchanged; controller reports of kind
  `installer` are built from the events a node sent to the controller.
