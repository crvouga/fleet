import { AwsClient } from 'aws4fetch';

import type { StorageConfig } from '../storage';

export interface StoredObject {
  readonly body: string;
  readonly etag: string;
}

/** Create only when absent, or replace only the exact version that was read. */
export type WriteCondition =
  { readonly ifNoneMatch: '*' } | { readonly ifMatch: string };

export type ConditionalWrite =
  { readonly ok: true; readonly etag: string } | { readonly ok: false };

/** The object-storage operations writer ownership needs; S3, R2 and test fakes implement it. */
export interface ConditionalStore {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    body: string,
    condition: WriteCondition
  ): Promise<ConditionalWrite>;
  remove(key: string): Promise<void>;
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** The request failed in a way that says nothing about ownership; retry later. */
export class ObjectStoreError extends Error {
  constructor(operation: string, status: number | string) {
    super(`object storage ${operation} failed (${String(status)})`);
    this.name = 'ObjectStoreError';
  }
}

function baseUrl(storage: StorageConfig): string {
  const origin =
    storage.endpoint?.replace(/\/$/, '') ??
    `https://s3.${storage.region}.amazonaws.com`;
  return `${origin}/${storage.bucket}`;
}

function conditionHeaders(condition: WriteCondition): Record<string, string> {
  return 'ifNoneMatch' in condition
    ? { 'if-none-match': '*' }
    : { 'if-match': condition.ifMatch };
}

/** Path-style SigV4 requests, which every S3-compatible provider accepts. */
export function s3ConditionalStore(
  storage: StorageConfig,
  credentials: S3Credentials
): ConditionalStore {
  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken
      ? { sessionToken: credentials.sessionToken }
      : {}),
    region: storage.region,
    service: 's3',
  });
  const base = baseUrl(storage);
  const url = (key: string) =>
    `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const send = (key: string, init: RequestInit) =>
    client.fetch(url(key), {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  return {
    async get(key) {
      const response = await send(key, { method: 'GET' });
      if (response.status === 404) return null;
      const etag = response.headers.get('etag');
      if (!response.ok || etag === null)
        throw new ObjectStoreError('read', response.status);
      return { body: await response.text(), etag };
    },
    async put(key, body, condition) {
      const response = await send(key, {
        method: 'PUT',
        body,
        headers: {
          'content-type': 'application/json',
          ...conditionHeaders(condition),
        },
      });
      // 409: a concurrent conditional write is in progress (S3); treat as lost.
      if (response.status === 412 || response.status === 409)
        return { ok: false };
      const etag = response.headers.get('etag');
      if (!response.ok || etag === null)
        throw new ObjectStoreError('conditional write', response.status);
      return { ok: true, etag };
    },
    async remove(key) {
      const response = await send(key, { method: 'DELETE' });
      if (!response.ok && response.status !== 404)
        throw new ObjectStoreError('delete', response.status);
    },
  };
}
