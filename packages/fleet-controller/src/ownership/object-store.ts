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

/** One listed object; `lastModified` is the storage server's time (epoch ms), never a local clock. */
export interface ListedObject {
  readonly key: string;
  readonly lastModified: number;
}

/** The object-storage operations writer ownership needs; S3, R2 and test fakes implement it. */
export interface ConditionalStore {
  get(key: string): Promise<StoredObject | null>;
  put(
    key: string,
    body: string,
    condition: WriteCondition
  ): Promise<ConditionalWrite>;
  remove(key: string): Promise<void>;
  /** Every object whose key starts with `prefix`, in key order; follows continuation tokens. */
  list(prefix: string): Promise<ListedObject[]>;
}

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const LIST_PAGE_SIZE = 1000;
/** A listing this long means something is wrong; refuse rather than loop or exhaust memory. */
const MAX_LIST_PAGES = 1000;

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

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXml(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g,
    (whole, name: string) => {
      if (name.startsWith('#x'))
        return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith('#'))
        return String.fromCodePoint(Number(name.slice(1)));
      return XML_ENTITIES[name] ?? whole;
    }
  );
}

function tag(block: string, name: string): string | null {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return found?.[1] === undefined ? null : decodeXml(found[1]);
}

interface ListPage {
  readonly objects: ListedObject[];
  readonly next: string | null;
}

function parseContents(block: string): ListedObject {
  const key = tag(block, 'Key');
  const modified = Date.parse(tag(block, 'LastModified') ?? '');
  if (key === null || Number.isNaN(modified))
    throw new ObjectStoreError('list', 'unreadable listing');
  return { key, lastModified: modified };
}

/** Parses one ListObjectsV2 response (S3 and R2 share the schema). */
export function parseListPage(xml: string): ListPage {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(
    (match) => parseContents(match[1] ?? '')
  );
  const truncated = tag(xml, 'IsTruncated') === 'true';
  const next = tag(xml, 'NextContinuationToken');
  if (truncated && !next)
    throw new ObjectStoreError('list', 'truncated listing without a token');
  return { objects, next: truncated ? next : null };
}

type Fetcher = (target: string, init: RequestInit) => Promise<Response>;

/** Every object under `prefix`, following continuation tokens page by page. */
async function listAll(
  fetcher: Fetcher,
  base: string,
  prefix: string
): Promise<ListedObject[]> {
  const all: ListedObject[] = [];
  let token: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const query = new URLSearchParams({
      'list-type': '2',
      prefix,
      'max-keys': String(LIST_PAGE_SIZE),
      ...(token === null ? {} : { 'continuation-token': token }),
    });
    const response = await fetcher(`${base}?${query.toString()}`, {
      method: 'GET',
    });
    if (!response.ok) throw new ObjectStoreError('list', response.status);
    const parsed = parseListPage(await response.text());
    all.push(...parsed.objects);
    if (parsed.next === null) return all;
    if (parsed.next === token)
      throw new ObjectStoreError('list', 'continuation token did not advance');
    token = parsed.next;
  }
  throw new ObjectStoreError('list', 'too many pages');
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
  const fetchUrl = (target: string, init: RequestInit) =>
    client.fetch(target, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  const send = (key: string, init: RequestInit) => fetchUrl(url(key), init);
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
    list: (prefix) => listAll(fetchUrl, base, prefix),
    async remove(key) {
      const response = await send(key, { method: 'DELETE' });
      if (!response.ok && response.status !== 404)
        throw new ObjectStoreError('delete', response.status);
    },
  };
}
