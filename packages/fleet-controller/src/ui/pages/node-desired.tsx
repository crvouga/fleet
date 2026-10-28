import type { Child } from 'hono/jsx';

import { ACTIVE_ROLES, type NodeView, type Role } from '../../types';
import { CopyableCode } from '../components/copy';
import { ActionForm, Confirm } from '../components/forms';
import { Time } from '../components/time';
import type { CredentialStatus } from '../../domain/credential-rotation';
import type { AnnotatedDesiredRow } from '../../domain/desired-history';
import { ChipList, ConvergenceBadge } from '../components/status';

/** Active roles, plus a retired role the node still carries so it stays visible. */
export function assignableRoles(current: Role | null): readonly Role[] {
  return current === null || (ACTIVE_ROLES as readonly Role[]).includes(current)
    ? ACTIVE_ROLES
    : [...ACTIVE_ROLES, current];
}

/** Assign, change or unassign the role. A plain POST form; the node converges on its own. */
export function RoleForm(props: { view: NodeView }) {
  const { view } = props;
  return (
    <form
      method="post"
      action={`/nodes/${view.id}/role`}
      class="flex flex-wrap items-end gap-2"
    >
      <div class="min-w-40 flex-1">
        <label class="label" for="assign-role">
          Assigned role
        </label>
        <select
          id="assign-role"
          name="role"
          class="field pr-8"
          aria-describedby="assign-role-help"
        >
          <option value="" selected={view.role === null}>
            No role (base)
          </option>
          {assignableRoles(view.role).map((role) => (
            <option key={role} value={role} selected={view.role === role}>
              {role}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" class="btn btn-primary">
        Assign role
      </button>
      <p id="assign-role-help" class="help w-full">
        Fleet decides what this machine runs. A change is applied like a kernel
        update: the node drains, reboots into the new system and rolls back if
        it is unhealthy. Nothing is erased.
      </p>
    </form>
  );
}

function Fact(props: { label: string; children?: Child }) {
  return (
    <div class="min-w-0">
      <dt class="eyebrow">{props.label}</dt>
      <dd class="mt-0.5 break-words text-sm">{props.children}</dd>
    </div>
  );
}

function Mono(props: { text: string | null; empty: string }) {
  return props.text === null ? (
    <span class="text-fg-3">{props.empty}</span>
  ) : (
    <code class="font-mono text-xs">{props.text}</code>
  );
}

function StateFacts(props: { view: NodeView }) {
  const { view } = props;
  return (
    <dl class="grid grid-cols-2 gap-x-4 gap-y-4">
      <Fact label="Convergence">
        <ConvergenceBadge convergence={view.convergence} />
      </Fact>
      <Fact label="Running role">
        <Mono text={view.observedRole} empty="not reported" />
      </Fact>
      <Fact label="Desired closure">
        <Mono text={view.desiredClosure} empty="keep the running system" />
      </Fact>
      <Fact label="Running closure">
        <Mono text={view.observedClosure} empty="not reported" />
      </Fact>
      <Fact label="Desired revision">
        <Mono text={view.desiredRevision} empty="none" />
      </Fact>
      <Fact label="Applied revision">
        <Mono text={view.appliedRevision} empty="none applied" />
      </Fact>
      <Fact label="Hardware">
        <ChipList items={view.hardwareCapabilities} empty="nothing detected" />
      </Fact>
      <Fact label="Age recipient">
        {view.ageRecipient === null ? (
          <span class="text-fg-3">not reported</span>
        ) : (
          <CopyableCode text={view.ageRecipient} label="Copy age recipient" />
        )}
      </Fact>
    </dl>
  );
}

/** A pending next recipient and the rotate action (a plain POST form, audited as a node setting). */
function AgeRotation(props: { view: NodeView }) {
  const { view } = props;
  const secrets =
    view.role === null ? 'its role secrets' : `the ${view.role} role secrets`;
  return (
    <div class="space-y-2">
      {view.ageRecipientNext !== null && (
        <div role="status" class="text-sm text-fg-2">
          <p class="eyebrow">Next age recipient</p>
          <CopyableCode
            text={view.ageRecipientNext}
            label="Copy next age recipient"
          />
          <p class="mt-1">
            Rotation pending: re-encrypt {secrets} for the next recipient and
            merge. Remove the old recipient after the node reports the new one.
          </p>
        </div>
      )}
      <form method="post" action={`/nodes/${view.id}/recovery/rotate-age-key`}>
        <button type="submit" class="btn btn-sm">
          Rotate age identity
        </button>
      </form>
    </div>
  );
}

function Issues(props: { issues: readonly string[] }) {
  if (props.issues.length === 0) return null;
  return (
    <div>
      <h3 class="eyebrow">What blocks convergence</h3>
      <ul class="mt-1 list-disc space-y-1 pl-5 text-sm text-fg-2">
        {props.issues.map((issue) => (
          <li key={issue} class="break-words">
            {issue}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CredentialSummary(props: { credential: CredentialStatus }) {
  const { credential } = props;
  if (credential.revokedAt !== null)
    return (
      <p role="status" class="text-sm text-bad">
        Credential revoked. The node is locked out; if it registers again it
        waits for a person to approve it.
      </p>
    );
  if (credential.rotationPending)
    return (
      <p role="status" class="text-sm text-fg-2">
        Rotation in progress: the node offered a new secret. Both work until it
        reports with the new one.
      </p>
    );
  if (credential.rotateRequestedAt !== null)
    return (
      <p role="status" class="text-sm text-fg-2">
        Rotation requested: the node rotates on its next heartbeat.
      </p>
    );
  return (
    <p class="text-sm text-fg-2">
      {credential.rotatedAt === null
        ? 'The credential has not been rotated.'
        : 'The credential was rotated.'}
    </p>
  );
}

/** Rotate or revoke the node's secret (plain POST forms; admins only, enforced by the server). */
function CredentialPanel(props: {
  view: NodeView;
  credential: CredentialStatus;
  readOnly: boolean;
}) {
  const { view, credential, readOnly } = props;
  const locked = readOnly || credential.revokedAt !== null;
  return (
    <div class="space-y-2">
      <h3 class="eyebrow">Node credential</h3>
      <CredentialSummary credential={credential} />
      {locked ? null : (
        <div class="space-y-2">
          <ActionForm
            action={`/nodes/${view.id}/credential/rotate`}
            label="Rotate credential"
            small
          />
          <Confirm
            id="revoke-credential"
            summary="Revoke credential"
            button="Revoke credential"
            action={`/nodes/${view.id}/credential/revoke`}
            expected={view.label}
            warning="The node is locked out immediately. Use this for a lost or compromised machine. If it registers again it waits for approval; reject it to keep it out."
          />
        </div>
      )}
    </div>
  );
}

function causeText(cause: string | null): string {
  if (cause === null) return 'changed';
  if (cause === 'initial') return 'first document recorded';
  if (cause.startsWith('settings:'))
    return `settings saved (${cause.slice('settings:'.length)})`;
  return cause.replaceAll(',', ', ');
}

/** Every distinct desired document this node was told, newest first; a return to an earlier one is a rollback. */
function DesiredHistoryPanel(props: {
  rows: readonly AnnotatedDesiredRow[];
  now: Date;
}) {
  return (
    <div>
      <h3 class="eyebrow">Desired-state history</h3>
      {props.rows.length === 0 ? (
        <p class="mt-1 text-sm text-fg-2">
          Nothing recorded yet. A row is added when the node is told a different
          desired document.
        </p>
      ) : (
        <ol class="mt-1 space-y-1 text-sm">
          {props.rows.map((row, index) => (
            <li key={row.id} class="flex flex-wrap items-center gap-2">
              <code class="font-mono text-xs">{row.revision}</code>
              {index === 0 ? (
                <span class="rounded bg-ok-soft px-1.5 py-0.5 text-xs font-medium text-ok">
                  current
                </span>
              ) : null}
              {row.revertsTo === null ? null : (
                <span class="rounded bg-warn-soft px-1.5 py-0.5 text-xs font-medium">
                  rollback to #{row.revertsTo}
                </span>
              )}
              <span class="text-fg-2">{causeText(row.cause)}</span>
              <span class="text-xs text-fg-3">
                <Time at={row.at} now={props.now} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What Fleet wants this node to run against what it reports it runs. */
export function DesiredStatePanel(props: {
  view: NodeView;
  history?: readonly AnnotatedDesiredRow[];
  credential?: CredentialStatus | null;
  readOnly?: boolean;
  now?: Date;
}) {
  const { view } = props;
  return (
    <section class="card card-pad space-y-4" aria-labelledby="desired-title">
      <h2 id="desired-title" class="text-sm font-semibold">
        Role and desired state
      </h2>
      <RoleForm view={view} />
      <StateFacts view={view} />
      <AgeRotation view={view} />
      {props.credential ? (
        <CredentialPanel
          view={view}
          credential={props.credential}
          readOnly={props.readOnly ?? false}
        />
      ) : null}
      <DesiredHistoryPanel
        rows={props.history ?? []}
        now={props.now ?? new Date()}
      />
      <Issues issues={view.reconcileIssues} />
    </section>
  );
}
