import { afterEach, expect, test } from 'bun:test';
import { readControllerEnv } from '../../src/env';
import { s3ConditionalStore } from '../../src/ownership/object-store';

let stop = () => {};
afterEach(() => stop());

function storeFor(fetch: (request: Request) => Response) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch });
  stop = () => server.stop(true);
  const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  const storage = readControllerEnv({
    FLEET_ADMIN_TOKEN: 'a'.repeat(32),
    FLEET_S3_BUCKET: 'test-bucket',
    FLEET_S3_ENDPOINT: server.url.origin,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  }).storage;
  return s3ConditionalStore(storage, credentials);
}

test('ownership updates succeed when the storage endpoint weakens compressed ETags', async () => {
  const encodings: (string | null)[] = [];
  const store = storeFor((request) => {
    const encoding = request.headers.get('accept-encoding');
    encodings.push(encoding);
    if (request.method === 'GET') {
      const compressed = encoding !== 'identity';
      return new Response(
        compressed ? Bun.gzipSync('{"beat":0}') : '{"beat":0}',
        {
          headers: {
            'content-type': 'application/json',
            etag: compressed ? 'W/"version-1"' : '"version-1"',
            ...(compressed ? { 'content-encoding': 'gzip' } : {}),
          },
        }
      );
    }
    if (request.headers.get('if-match') !== '"version-1"')
      return new Response(null, { status: 412 });
    return new Response(null, { headers: { etag: '"version-2"' } });
  });
  const current = await store.get('fleet-owner.json');
  expect(current).not.toBeNull();
  const written = await store.put('fleet-owner.json', '{"beat":1}', {
    ifMatch: current!.etag,
  });
  expect(written).toEqual({ ok: true, etag: '"version-2"' });
  expect(encodings).toEqual(['identity', 'identity']);
});

test('a proxy that still supplies a weak read ETag fails closed', async () => {
  const store = storeFor(
    () => new Response('{}', { headers: { etag: 'W/"version-1"' } })
  );
  await expect(store.get('fleet-owner.json')).rejects.toThrow('weak ETag');
});

test('a weak write ETag cannot establish usable ownership', async () => {
  const store = storeFor(
    () => new Response(null, { headers: { etag: 'W/"version-1"' } })
  );
  await expect(
    store.put('fleet-owner.json', '{}', { ifNoneMatch: '*' })
  ).rejects.toThrow('weak ETag');
});
