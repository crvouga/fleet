import type { Hono } from 'hono';
import type { AppDeps } from '../../deps';
import { LoginPage, NotAllowedPage } from '../pages/login';
import { safeNext } from './guard';

export function registerBrowser(app: Hono, deps: AppDeps): void {
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/login', async (c) => {
    if (await deps.auth.actor(c))
      return c.redirect(safeNext(c.req.query('next')), 303);
    if (await deps.browserAuth?.identity(c))
      return c.redirect('/not-allowed', 303);
    const error = c.req.query('error');
    return c.html(
      <LoginPage
        next={safeNext(c.req.query('next'))}
        available={!!deps.browserAuth}
        error={
          error
            ? 'OpenID Connect sign-in could not be completed. Please try again; contact your administrator if it continues.'
            : null
        }
      />
    );
  });
  app.get(
    '/auth/login',
    (c) =>
      deps.browserAuth?.begin(c) ?? c.redirect('/login?error=unavailable', 303)
  );
  app.get(
    '/auth/callback',
    (c) =>
      deps.browserAuth?.callback(c) ??
      c.redirect('/login?error=unavailable', 303)
  );
  app.get('/not-allowed', async (c) => {
    const identity = await deps.browserAuth?.identity(c);
    if (!identity) return c.redirect('/login', 303);
    if (identity.allowed) return c.redirect('/', 303);
    return c.html(<NotAllowedPage email={identity.email} />, 403);
  });
  app.post('/login', (c) =>
    c.text(
      'Password sign-in has been removed. Use Google through the authentication relay.',
      410
    )
  );
  app.post('/logout', async (c) => {
    if (!deps.auth.sameOrigin(c))
      return c.text('Forbidden: cross-site request refused.', 403);
    // Denied users must be able to sign out too; no allowlist guard here.
    await deps.browserAuth?.logout(c);
    c.header('Set-Cookie', deps.auth.logoutCookie(), { append: true });
    return c.redirect('/login', 303);
  });
}
