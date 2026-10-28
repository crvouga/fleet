import type { Context } from 'hono';

import type { AdminAuth, AppEnv } from '../deps';
import type { BrowserAuth } from './browser-contract';

import { matchesAdminToken } from './admin-token';
import { isAccessRole, type AccessRole } from './roles';
import { clearedSessionCookie } from './session';

export const TOKEN_ACTOR = 'admin-token';

export interface AdminAuthOptions {
  readonly env: Pick<AppEnv, 'adminToken'> &
    Partial<Pick<AppEnv, 'adminTokenNext'>>;
  readonly browser?: BrowserAuth;
  readonly publicOrigin?: string;
}

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function hostOf(value: string | undefined): string | null {
  if (value === undefined || value === 'null') return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function requestHosts(c: Context): string[] {
  const hosts = [c.req.header('host'), new URL(c.req.url).host];
  const forwarded = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0) hosts.push(forwarded);
  return hosts.filter((h): h is string => typeof h === 'string');
}

interface Principal {
  readonly actor: string;
  readonly role: AccessRole;
}

export class FleetAdminAuth implements AdminAuth {
  /** One lookup per request: the actor and the role come from the same answer. */
  private readonly resolved = new WeakMap<Request, Principal | null>();
  constructor(private readonly options: AdminAuthOptions) {}

  private async principal(c: Context): Promise<Principal | null> {
    const cached = this.resolved.get(c.req.raw);
    if (cached !== undefined) return cached;
    const found = await this.lookup(c);
    this.resolved.set(c.req.raw, found);
    return found;
  }

  private async lookup(c: Context): Promise<Principal | null> {
    const token = bearerToken(c);
    if (token !== null && matchesAdminToken(token, this.options.env)) {
      return { actor: TOKEN_ACTOR, role: 'admin' };
    }
    const identity = await this.options.browser?.identity(c);
    if (!identity?.allowed) return null;
    // Fail closed: a role the contract does not know is a viewer.
    return {
      actor: identity.email,
      role: isAccessRole(identity.role) ? identity.role : 'viewer',
    };
  }

  async actor(c: Context): Promise<string | null> {
    return (await this.principal(c))?.actor ?? null;
  }

  async role(c: Context): Promise<AccessRole | null> {
    return (await this.principal(c))?.role ?? null;
  }

  logoutCookie(): string {
    return clearedSessionCookie();
  }

  /** Origin, else Referer, must name this site. Absent both: refuse. */
  sameOrigin(c: Context): boolean {
    const origin = c.req.header('origin');
    if (this.options.publicOrigin) {
      try {
        return (
          new URL(origin ?? c.req.header('referer') ?? '').origin ===
          this.options.publicOrigin
        );
      } catch {
        return false;
      }
    }
    const claimed = hostOf(origin ?? c.req.header('referer'));
    if (claimed === null) return false;
    return requestHosts(c).includes(claimed);
  }
}
