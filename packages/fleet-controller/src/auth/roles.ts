/**
 * Authorization roles. A viewer reads everything that is not a secret; only an
 * admin changes anything. The admin Bearer token is always an admin.
 */
export const ACCESS_ROLES = ['admin', 'viewer'] as const;
export type AccessRole = (typeof ACCESS_ROLES)[number];

export function isAccessRole(value: unknown): value is AccessRole {
  return (
    typeof value === 'string' &&
    (ACCESS_ROLES as readonly string[]).includes(value)
  );
}

/** Methods that never change state. Everything else needs an admin. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method.toUpperCase());
}

/** Fail closed: anything that is not exactly `admin` may not write. */
export function mayWrite(role: AccessRole | null | undefined): boolean {
  return role === 'admin';
}

export const VIEWER_DENIED_MESSAGE =
  'Your account is a viewer: it can read the fleet but not change it. Ask an administrator to make you an admin on the Access page.';
