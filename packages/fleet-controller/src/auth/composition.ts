import { FleetAdminAuth } from './admin-auth';
import { FleetBrowserAuth } from './browser-auth';
import { createOidcClient } from './oidc-client';
import type { AuthFactory, AuthContext } from './contracts';
import { StartupError } from '../startup-error';

/** The default adapter speaks standard OIDC directly to the configured provider. */
export const createDefaultAuth: AuthFactory = (context) => {
  const browserAuth = context.oidc
    ? new FleetBrowserAuth(
        context.access,
        context.oidc,
        createOidcClient(context.oidc, context.fetch),
        context.now
      )
    : undefined;
  return {
    ...(browserAuth ? { browserAuth } : {}),
    auth: new FleetAdminAuth({
      env: { adminToken: context.adminToken },
      ...(browserAuth && context.oidc
        ? { browser: browserAuth, publicOrigin: context.oidc.origin }
        : {}),
    }),
  };
};

/** Invalid adapters fail before listening; they never fall back to another auth service. */
export function resolveAuth(factory: AuthFactory, context: AuthContext) {
  try {
    const services = factory(context);
    if (
      !services?.auth ||
      typeof services.auth.actor !== 'function' ||
      typeof services.auth.sameOrigin !== 'function' ||
      typeof services.auth.logoutCookie !== 'function'
    )
      throw new Error();
    return services;
  } catch {
    throw new StartupError(
      'authentication',
      'Authentication adapter initialization failed. Check the injected authFactory and its deployment configuration.'
    );
  }
}
