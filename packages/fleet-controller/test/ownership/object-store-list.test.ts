import { afterEach, describe, expect, test } from 'bun:test';

import {
  ObjectStoreError,
  parseListPage,
  s3ConditionalStore,
} from '../../src/ownership/object-store';

/** A loopback S3 that serves ListObjectsV2 in pages with continuation tokens. */
interface FakeS3 {
  readonly endpoint: string;
  readonly requests: URL[];
  stop(): void;
}

const servers: FakeS3[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function entry(key: string, modified: string): string {
  const escaped = key.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<Contents><Key>${escaped}</Key><LastModified>${modified}</LastModified><ETag>"x"</ETag><Size>1</Size></Contents>`;
}

function serve(
  keys: readonly string[],
  pageSize: number,
  override?: (url: URL) => Response | undefined
): FakeS3 {
  const requests: URL[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      requests.push(url);
      const forced = override?.(url);
      if (forced) return forced;
      const prefix = url.searchParams.get('prefix') ?? '';
      const matching = keys.filter((k) => k.startsWith(prefix));
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = matching.slice(start, start + pageSize);
      const more = start + pageSize < matching.length;
      const xml =
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>${String(more)}</IsTruncated>` +
        page.map((k) => entry(k, '2026-01-02T03:04:05.000Z')).join('') +
        (more
          ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>`
          : '') +
        '</ListBucketResult>';
      return new Response(xml, {
        headers: { 'content-type': 'application/xml' },
      });
    },
  });
  const fake = {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => void server.stop(true),
  };
  servers.push(fake);
  return fake;
}

const storeFor = (endpoint: string) =>
  s3ConditionalStore(
    {
      path: '/unused',
      bucket: 'bucket',
      prefix: 'p',
      endpoint,
      region: 'us-east-1',
      replicated: true,
      startupTimeoutMs: 1000,
    },
    { accessKeyId: 'test', secretAccessKey: 'test' }
  );

describe('conditional store listing', () => {
  test('follows continuation tokens across every page, in order, with server times', async () => {
    const keys = Array.from(
      { length: 25 },
      (_, i) => `p/gen/${String(i).padStart(3, '0')}.ltx`
    );
    const fake = serve([...keys, 'q/other'], 10);
    const listed = await storeFor(fake.endpoint).list('p/');
    expect(listed.map((o) => o.key)).toEqual(keys);
    expect(listed[0]?.lastModified).toBe(
      Date.parse('2026-01-02T03:04:05.000Z')
    );
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[0]?.searchParams.get('list-type')).toBe('2');
    expect(fake.requests[0]?.searchParams.get('prefix')).toBe('p/');
    expect(fake.requests[1]?.searchParams.get('continuation-token')).toBe('10');
    expect(fake.requests[2]?.searchParams.get('continuation-token')).toBe('20');
  });

  test('an empty listing is empty, and XML entities in keys are decoded', async () => {
    const empty = serve([], 10);
    expect(await storeFor(empty.endpoint).list('p/')).toEqual([]);
    const odd = serve(['p/a&b<c>.ltx'], 10);
    expect((await storeFor(odd.endpoint).list('p/')).map((o) => o.key)).toEqual(
      ['p/a&b<c>.ltx']
    );
  });

  test('refuses a token that does not advance, a refused listing and a broken page', async () => {
    const stuck = serve(
      [],
      1,
      () =>
        new Response(
          '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken></ListBucketResult>'
        )
    );
    await expect(storeFor(stuck.endpoint).list('p/')).rejects.toThrow(
      ObjectStoreError
    );
    const denied = serve([], 1, () => new Response('no', { status: 403 }));
    await expect(storeFor(denied.endpoint).list('p/')).rejects.toThrow(
      'list failed (403)'
    );
    expect(() =>
      parseListPage(
        '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'
      )
    ).toThrow('without a token');
    expect(() =>
      parseListPage(
        '<ListBucketResult><Contents><Key>k</Key></Contents></ListBucketResult>'
      )
    ).toThrow('unreadable');
  });
});
