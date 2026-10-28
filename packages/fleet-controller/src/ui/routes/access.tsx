import type { Context, Hono } from 'hono';
import type { AppDeps } from '../../deps';
import {
  emailAddress,
  type AccessEntry,
  type FleetIdentity,
} from '../../auth/browser-contract';
import {
  isAccessRole,
  mayWrite,
  VIEWER_DENIED_MESSAGE,
  type AccessRole,
} from '../../auth/roles';
import { auditDenied } from '../../routes/guards';
import { Shell } from '../layout';

const LAST_ADMIN =
  'Cannot remove or demote the last administrator: promote someone else to admin first.';

type Form = Record<string, unknown>;
type Refused = { readonly status: 400 | 404 | 409; readonly text: string };

async function auditFailure(
  deps: AppDeps,
  identity: FleetIdentity,
  what: {
    readonly action: string;
    readonly email: string;
    readonly reason: string;
  }
): Promise<void> {
  await deps.store.audit({
    actor: identity.email,
    actorRole: identity.role,
    action: what.action,
    targetKind: 'access',
    targetId: what.email,
    outcome: 'failed',
    detail: { reason: what.reason },
  });
}

function done(c: Context): Response {
  if (c.req.header('accept')?.includes('application/json'))
    return c.json({
      redirect: '/access',
      flash: { kind: 'success', text: 'Access updated.' },
    });
  return c.redirect('/access', 303);
}

async function revoke(
  deps: AppDeps,
  identity: FleetIdentity,
  email: string
): Promise<Refused | null> {
  if (await deps.browserAuth!.access.revoke(email, identity.email)) return null;
  await auditFailure(deps, identity, {
    action: 'access.revoke',
    email,
    reason: 'last_admin_or_missing',
  });
  return {
    status: 409,
    text: `${LAST_ADMIN} Or that email is no longer listed.`,
  };
}

async function changeRole(
  deps: AppDeps,
  identity: FleetIdentity,
  target: { readonly email: string; readonly role: AccessRole }
): Promise<Refused | null> {
  const result = await deps.browserAuth!.access.setRole(
    target.email,
    target.role,
    identity.email
  );
  if (result === 'missing')
    return { status: 404, text: 'That email is no longer listed.' };
  if (result !== 'last_admin') return null;
  await auditFailure(deps, identity, {
    action: 'access.role',
    email: target.email,
    reason: 'last_admin',
  });
  return { status: 409, text: LAST_ADMIN };
}

/** The role a form asks for: absent means admin (the CLI default), anything else must be a role. */
function requestedRole(form: Form): AccessRole | null {
  const requested = form['role'];
  if (requested === undefined) return 'admin';
  return isAccessRole(requested) ? requested : null;
}

async function apply(
  deps: AppDeps,
  identity: FleetIdentity,
  form: Form
): Promise<Refused | null> {
  const email = emailAddress(form['email']);
  if (!email) return { status: 400, text: 'Enter a valid Email address.' };
  const role = requestedRole(form);
  if (role === null)
    return { status: 400, text: 'The role must be admin or viewer.' };
  switch (form['action']) {
    case 'revoke':
      return revoke(deps, identity, email);
    case 'role':
      return changeRole(deps, identity, { email, role });
    case undefined:
      await deps.browserAuth!.access.allow(email, identity.email, role);
      return null;
    default:
      return { status: 400, text: 'Unknown access action.' };
  }
}

export function registerAccess(app: Hono, deps: AppDeps): void {
  app.use('/access', async (c, next) => {
    const identity = await deps.browserAuth?.identity(c);
    if (!identity) return c.redirect('/login?next=%2Faccess', 303);
    if (!identity.allowed) return c.redirect('/not-allowed', 303);
    if (c.req.method !== 'GET' && !deps.auth.sameOrigin(c))
      return c.text('Forbidden', 403);
    if (c.req.method !== 'GET' && !mayWrite(identity.role)) {
      await auditDenied(deps, c, {
        actor: identity.email,
        role: identity.role,
      });
      return c.req.header('accept')?.includes('application/json')
        ? c.json({ error: VIEWER_DENIED_MESSAGE, code: 'forbidden' }, 403)
        : c.text(`Forbidden: ${VIEWER_DENIED_MESSAGE}`, 403);
    }
    await next();
    return;
  });
  app.get('/access', async (c) => {
    const identity = (await deps.browserAuth!.identity(c))!;
    const entries = await deps.browserAuth!.access.entries();
    return c.html(<AccessPage identity={identity} entries={entries} />);
  });
  app.post('/access', async (c) => {
    const form = (await c.req.parseBody()) as Form;
    const identity = (await deps.browserAuth!.identity(c))!;
    const refused = await apply(deps, identity, form);
    return refused === null ? done(c) : c.text(refused.text, refused.status);
  });
}

function RoleSelect({ name, current }: { name: string; current: AccessRole }) {
  return (
    <select class="field" name={name} aria-label="Role">
      <option value="admin" selected={current === 'admin'}>
        Admin: can change the fleet
      </option>
      <option value="viewer" selected={current === 'viewer'}>
        Viewer: read only
      </option>
    </select>
  );
}

function AccessRow({ entry, manage }: { entry: AccessEntry; manage: boolean }) {
  return (
    <li class="card card-pad">
      {entry.email}{' '}
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{entry.role}</span>
      {manage && (
        <>
          <form method="post" action="/access">
            <input type="hidden" name="email" value={entry.email} />
            <input type="hidden" name="action" value="role" />
            <RoleSelect name="role" current={entry.role} />
            <button class="btn" type="submit">
              Change role
            </button>
          </form>
          <form method="post" action="/access">
            <input type="hidden" name="email" value={entry.email} />
            <button class="btn" name="action" value="revoke" type="submit">
              Remove access
            </button>
          </form>
        </>
      )}
    </li>
  );
}

function AccessPage({
  identity,
  entries,
}: {
  identity: FleetIdentity;
  entries: readonly AccessEntry[];
}) {
  const manage = mayWrite(identity.role);
  return (
    <Shell
      title="Access"
      path="/access"
      actor={identity.email}
      pendingCount={0}
      flash={null}
    >
      <h1 class="text-2xl font-semibold">Fleet access</h1>
      <p>
        Only verified Email addresses on this list can sign in. Admins can
        change the fleet and manage access; viewers can read everything that is
        not a secret.
      </p>
      {manage ? (
        <form method="post" action="/access" class="card card-pad space-y-4">
          <label class="label" for="allowed-email">
            Email address
          </label>
          <input
            class="field"
            id="allowed-email"
            name="email"
            type="email"
            required
            maxlength={254}
          />
          <RoleSelect name="role" current="viewer" />
          <button class="btn btn-primary" type="submit">
            Allow access
          </button>
        </form>
      ) : (
        <p role="status">
          You are a viewer, so this list is read only. Ask an administrator to
          change roles.
        </p>
      )}
      <ul>
        {entries.map((entry) => (
          <AccessRow entry={entry} manage={manage} />
        ))}
      </ul>
      <p>
        The last administrator cannot be removed or demoted. Initial access is
        populated by the database owner (<code>bun run access:allow</code>).
      </p>
    </Shell>
  );
}
