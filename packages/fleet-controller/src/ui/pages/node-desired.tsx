import type { Child } from 'hono/jsx';

import { ACTIVE_ROLES, type NodeView, type Role } from '../../types';
import { CopyableCode } from '../components/copy';
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

/** What Fleet wants this node to run against what it reports it runs. */
export function DesiredStatePanel(props: { view: NodeView }) {
  const { view } = props;
  return (
    <section class="card card-pad space-y-4" aria-labelledby="desired-title">
      <h2 id="desired-title" class="text-sm font-semibold">
        Role and desired state
      </h2>
      <RoleForm view={view} />
      <StateFacts view={view} />
      <AgeRotation view={view} />
      <Issues issues={view.reconcileIssues} />
    </section>
  );
}
