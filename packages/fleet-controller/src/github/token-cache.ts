import type { KeyObject } from 'node:crypto';

import { signAppJwt } from './app-jwt';
import { GithubError } from './errors';
import { record, text } from './normalize';
import { send, type Transport } from './transport';

export interface TokenCache {
  /** A valid installation token; mints (once, even when called concurrently) when needed. */
  token(): Promise<string>;
  /** Forget the token: GitHub said it expired or was revoked. */
  invalidate(): void;
  /** A fresh App JWT, for the endpoints that authenticate as the App itself. */
  appJwt(): string;
}

export interface TokenCacheOptions {
  readonly transport: Transport;
  readonly appId: string;
  readonly installationId: string;
  readonly key: KeyObject;
  /** Mint again when less than this remains. */
  readonly refreshBeforeMs?: number;
}

const DEFAULT_REFRESH_BEFORE_MS = 5 * 60_000;
const FAILURE_MEMORY_MS = 30_000;

interface Cached {
  readonly token: string;
  readonly expiresAt: number;
}

export function createTokenCache(options: TokenCacheOptions): TokenCache {
  const { transport } = options;
  const margin = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
  const clock = () => transport.now().getTime();
  let cached: Cached | null = null;
  let inflight: Promise<string> | null = null;
  let refused: { error: GithubError; until: number } | null = null;
  const appJwt = () => signAppJwt(options.appId, options.key, transport.now());

  async function mint(): Promise<string> {
    const answer = record(
      await send(transport, {
        method: 'POST',
        path: `/app/installations/${options.installationId}/access_tokens`,
        bearer: appJwt(),
        kind: 'installation',
      })
    );
    const token = text(answer['token']);
    const expires = Date.parse(text(answer['expires_at']) ?? '');
    if (token === null) {
      throw new GithubError(
        'FLEET_GITHUB_UNAVAILABLE',
        'GitHub sent no installation token',
        { temporary: true }
      );
    }
    const lifetime = Number.isNaN(expires) ? 55 * 60_000 : expires - clock();
    cached = { token, expiresAt: clock() + lifetime };
    return token;
  }

  async function obtain(): Promise<string> {
    try {
      const token = await mint();
      refused = null;
      return token;
    } catch (error) {
      // A wrong key or installation will not fix itself; do not ask GitHub on every call.
      const permanent = error instanceof GithubError && !error.temporary;
      if (permanent) refused = { error, until: clock() + FAILURE_MEMORY_MS };
      throw error;
    } finally {
      inflight = null;
    }
  }

  return {
    appJwt,
    invalidate() {
      cached = null;
    },
    token() {
      if (cached !== null && cached.expiresAt - clock() > margin) {
        return Promise.resolve(cached.token);
      }
      if (refused !== null && clock() < refused.until) {
        return Promise.reject(refused.error);
      }
      inflight ??= obtain();
      return inflight;
    },
  };
}
