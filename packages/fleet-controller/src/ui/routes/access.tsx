import type { Hono } from 'hono';
import type { AppDeps } from '../../deps';
import { emailAddress } from '../../auth/browser-contract';
import { Shell } from '../layout';

export function registerAccess(app: Hono, deps: AppDeps): void {
  app.use('/access', async (c, next) => {
    const identity = await deps.browserAuth?.identity(c);
    if (!identity) return c.redirect('/login?next=%2Faccess', 303);
    if (!identity.allowed) return c.redirect('/not-allowed', 303);
    if (c.req.method !== 'GET' && !deps.auth.sameOrigin(c))
      return c.text('Forbidden', 403);
    await next();
    return;
  });
  app.get('/access', async (c) => {
    const identity = (await deps.browserAuth!.identity(c))!;
    const emails = await deps.browserAuth!.access.emails();
    return c.html(<AccessPage email={identity.email} emails={emails} />);
  });
  app.post('/access', async (c) => {
    const form = await c.req.parseBody();
    const email = emailAddress(form['email']);
    if (!email) return c.text('Enter a valid Email address.', 400);
    const identity = (await deps.browserAuth!.identity(c))!;
    const store = deps.browserAuth!.access;
    if (form['action'] === 'revoke') {
      if (!(await store.revoke(email, identity.email)))
        return c.text(
          'Cannot remove the final allowed account, or that email is no longer listed.',
          409
        );
    } else if (form['action'] === undefined)
      await store.allow(email, identity.email);
    else return c.text('Unknown access action.', 400);
    if (c.req.header('accept')?.includes('application/json'))
      return c.json({
        redirect: '/access',
        flash: { kind: 'success', text: 'Access updated.' },
      });
    return c.redirect('/access', 303);
  });
}

function AccessPage({
  email,
  emails,
}: {
  email: string;
  emails: readonly string[];
}) {
  return (
    <Shell
      title="Access"
      path="/access"
      actor={email}
      pendingCount={0}
      flash={null}
    >
      <h1 class="text-2xl font-semibold">Fleet access</h1>
      <p>
        Only verified Email addresses on this list can administer Fleet.
        All listed people can manage access.
      </p>
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
        <button class="btn btn-primary" type="submit">
          Allow access
        </button>
      </form>
      <ul>
        {emails.map((email) => (
          <li class="card card-pad">
            {email}
            <form method="post" action="/access">
              <input type="hidden" name="email" value={email} />
              <button class="btn" name="action" value="revoke" type="submit">
                Remove access
              </button>
            </form>
          </li>
        ))}
      </ul>
      <p>
        The final allowed account cannot be removed. Initial access is populated
        by the database owner.
      </p>
    </Shell>
  );
}
