import type { KeyObject } from 'node:crypto';

import type { Logger } from '@pkgs/logger';

import { GithubClient } from './client';
import type { CircuitSnapshot } from './circuit';
import { createDeliveryLog, type DeliveryLog } from './delivery-log';
import { DEFAULT_GITHUB_API_URL, type GithubEnv } from './env';
import { isConfigured } from './policy';
import type { GithubStore } from './store';
import type { FetchLike, RetryPolicy } from './transport';
import type { Integration } from './types';

export type Connection =
  | {
      readonly ok: true;
      readonly client: GithubClient;
      readonly integration: Integration;
    }
  | {
      readonly ok: false;
      readonly reason: 'no_key' | 'unconfigured';
      readonly code: 'FLEET_GITHUB_UNCONFIGURED';
      readonly message: string;
      readonly integration: Integration;
    };

export interface GithubRuntimeOptions {
  readonly env: GithubEnv | undefined;
  readonly store: GithubStore;
  readonly now: () => Date;
  readonly fetch: FetchLike;
  readonly log: Logger;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly retry?: Partial<RetryPolicy>;
}

/** What routes, the sync job and the dashboard share. Built once at boot. */
export interface GithubRuntime {
  readonly store: GithubStore;
  readonly now: () => Date;
  readonly log: Logger;
  readonly deliveries: DeliveryLog;
  /** True only when an operator supplied the App private key. */
  keyConfigured(): boolean;
  webhookEnabled(): boolean;
  webhookSecret(): string | undefined;
  /** A client for the stored integration, or why there is none. Nothing is simulated. */
  connect(): Promise<Connection>;
  /** The newest client's circuit, for the status panel. Null before the first call. */
  circuit(): CircuitSnapshot | null;
}

const NO_KEY =
  'the controller has no GitHub App private key: set FLEET_GITHUB_APP_PRIVATE_KEY or FLEET_GITHUB_APP_PRIVATE_KEY_FILE';
const NOT_SET_UP =
  'the GitHub integration is not configured: save the App ID, installation ID and a repository or organization';

function newClient(
  options: GithubRuntimeOptions,
  integration: Integration,
  privateKey: KeyObject
): GithubClient {
  return new GithubClient({
    apiUrl: options.env?.apiUrl ?? DEFAULT_GITHUB_API_URL,
    appId: integration.appId,
    installationId: integration.installationId,
    key: privateKey,
    fetch: options.fetch,
    now: options.now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  });
}

function refusedConnection(
  reason: 'no_key' | 'unconfigured',
  integration: Integration
): Connection {
  return {
    ok: false,
    reason,
    code: 'FLEET_GITHUB_UNCONFIGURED',
    message: reason === 'no_key' ? NO_KEY : NOT_SET_UP,
    integration,
  };
}

export function createGithubRuntime(
  options: GithubRuntimeOptions
): GithubRuntime {
  const { env } = options;
  let current: { key: string; client: GithubClient } | null = null;
  return {
    store: options.store,
    now: options.now,
    log: options.log,
    deliveries: createDeliveryLog(options.now),
    keyConfigured: () => env?.privateKey !== undefined,
    webhookEnabled: () => env?.webhookSecret !== undefined,
    webhookSecret: () => env?.webhookSecret,
    circuit: () => current?.client.circuit() ?? null,
    async connect() {
      const integration = await options.store.getIntegration();
      const privateKey = env?.privateKey;
      if (privateKey === undefined)
        return refusedConnection('no_key', integration);
      if (!isConfigured(integration))
        return refusedConnection('unconfigured', integration);
      const key = `${env?.apiUrl}|${integration.appId}|${integration.installationId}`;
      if (current?.key !== key) {
        current = { key, client: newClient(options, integration, privateKey) };
      }
      return { ok: true, client: current.client, integration };
    },
  };
}
