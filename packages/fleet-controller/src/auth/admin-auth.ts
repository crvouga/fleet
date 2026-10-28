import type { Logger } from '@pkgs/logger';
import type { Context } from 'hono';

import type { AdminAuth, AppEnv } from '../deps';
import type { BrowserAuth } from './browser-contract';

import { safeEqual } from './hash';
import { clearedSessionCookie } from './session';

export const TOKEN_ACTOR = 'admin-token';

export interface AdminAuthOptions {
  readonly env: Pick<AppEnv, 'adminToken'>;
  readonly now: () => Date;
  readonly fetch: typeof fetch;
  readonly log: Logger;
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

export class FleetAdminAuth implements AdminAuth {
  constructor(private readonly options: AdminAuthOptions) {}

  async actor(c: Context): Promise<string | null> {
    const token = bearerToken(c);
    if (token !== null && safeEqual(token, this.options.env.adminToken)) {
      return TOKEN_ACTOR;
    }
    const identity = await this.options.browser?.identity(c);
    return identity?.allowed ? identity.email : null;
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
