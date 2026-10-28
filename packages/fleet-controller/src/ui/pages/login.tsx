import { BareShell } from '../layout';

export function LoginPage(props: {
  next: string;
  error: string | null;
  available?: boolean;
}) {
  return (
    <BareShell title="Sign in">
      <h1 class="text-2xl font-semibold tracking-tight">
        Sign in to Fleet controller
      </h1>
      <div class="card card-pad space-y-4">
        {props.available === false ? null : (
          <p>Continue with your organization’s identity provider.</p>
        )}
        {props.error ? <p role="alert">{props.error}</p> : null}
        {props.available === false ? (
          <p role="status">
            OpenID Connect sign-in is unavailable until the identity provider is
            configured. Contact your Fleet administrator.
          </p>
        ) : (
          <a
            class="btn btn-primary w-full"
            href={`/auth/login?next=${encodeURIComponent(props.next)}`}
          >
            Sign in with OpenID Connect
          </a>
        )}
      </div>
    </BareShell>
  );
}

export function NotAllowedPage(props: { email: string }) {
  return (
    <BareShell title="Not allowed">
      <h1 class="text-2xl font-semibold tracking-tight">Not allowed</h1>
      <div class="card card-pad space-y-4">
        <p>
          Signed in as {props.email}. This account is not on Fleet’s access
          list.
        </p>
        <p>
          Ask a Fleet administrator to add your email, or sign out to use
          another account.
        </p>
        <form method="post" action="/logout">
          <button class="btn btn-primary" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </BareShell>
  );
}
