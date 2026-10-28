import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './support/port';

/**
 * Provider compatibility, at process level: a bucket that cannot enforce
 * conditional writes must make `src/start.ts` fail closed before any restore,
 * replication or listener. The fake S3 below is a loopback server that
 * ignores If-None-Match / If-Match (or some of them, or denies writes), so no
 * real Litestream is needed: a stub binary only satisfies the version
 * preflight and records the commands it is asked to run.
 */
type Behaviour = 'ignores-conditions' | 'ignores-if-match' | 'denies-put';

interface FakeS3 {
  readonly url: string;
  readonly requests: { method: string; key: string }[];
  stop(): void;
}

const etagOf = (body: string) =>
  `"${createHash('md5').update(body).digest('hex')}"`;

function listing(objects: Map<string, string>, prefix: string): string {
  const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
  return `<?xml version="1.0"?><ListBucketResult><Name>drill</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys
    .map((key) => `<Contents><Key>${key}</Key></Contents>`)
    .join('')}</ListBucketResult>`;
}

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(code === 204 ? null : '', { status: code, headers });

async function putObject(
  behaviour: Behaviour,
  objects: Map<string, string>,
  request: Request,
  key: string
): Promise<Response> {
  if (behaviour === 'denies-put') return status(403);
  const body = await request.text();
  const duplicate =
    request.headers.get('if-none-match') === '*' && objects.has(key);
  // 'ignores-if-match' still enforces If-None-Match; the other flaw ignores both.
  if (behaviour === 'ignores-if-match' && duplicate) return status(412);
  objects.set(key, body);
  return status(200, { etag: etagOf(body) });
}

function getObject(
  objects: Map<string, string>,
  request: Request,
  key: string
) {
  const body = objects.get(key);
  if (body === undefined) return status(404);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { etag: etagOf(body), 'content-length': String(body.length) },
  });
}

/** PutObject, GetObject, HeadObject, DeleteObject and ListObjectsV2, with the chosen flaw. */
function fakeS3(behaviour: Behaviour): FakeS3 {
  const objects = new Map<string, string>();
  const requests: FakeS3['requests'] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const key = decodeURIComponent(
        url.pathname.split('/').slice(2).join('/')
      );
      requests.push({ method: request.method, key });
      if (request.method === 'PUT')
        return putObject(behaviour, objects, request, key);
      if (request.method === 'DELETE') {
        objects.delete(key);
        return status(204);
      }
      if (key === '')
        return new Response(
          listing(objects, url.searchParams.get('prefix') ?? ''),
          {
            headers: { 'content-type': 'application/xml' },
          }
        );
      return getObject(objects, request, key);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => void server.stop(true),
  };
}

/** Satisfies the version preflight and records every command; replicates nothing. */
const stub = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const command = process.argv[2];
appendFileSync(process.env.FLEET_TEST_INVOCATIONS, command + '\\n');
if (command === 'version') { console.log('0.5.17'); process.exit(0); }
process.exit(99);
`;

const servers: FakeS3[] = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

async function startWith(behaviour: Behaviour) {
  const s3 = fakeS3(behaviour);
  servers.push(s3);
  const directory = mkdtempSync(join(tmpdir(), 'fleet-provider-'));
  const binary = join(directory, 'litestream');
  writeFileSync(binary, stub, { mode: 0o700 });
  const calls = join(directory, 'calls');
  const port = await freePort();
  const database = join(directory, 'fleet.db');
  const child = Bun.spawn([process.execPath, 'src/start.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      PATH: process.env['PATH'] ?? '',
      FLEET_ADMIN_TOKEN: 'a'.repeat(32),
      AWS_ACCESS_KEY_ID: 'provider-key-id',
      AWS_SECRET_ACCESS_KEY: 'provider-secret',
      FLEET_S3_BUCKET: 'provider-bucket',
      FLEET_S3_ENDPOINT: s3.url,
      FLEET_S3_PREFIX: 'provider-test',
      FLEET_DATABASE_PATH: database,
      FLEET_LITESTREAM_BIN: binary,
      FLEET_TEST_INVOCATIONS: calls,
      PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A listener would answer here while the process lives; none may ever appear.
  let listened = false;
  const watch = setInterval(() => {
    void fetch(`http://127.0.0.1:${port}/health`).then(
      () => (listened = true),
      () => undefined
    );
  }, 50);
  const code = await Promise.race([
    child.exited,
    Bun.sleep(30_000).then(() => 'hung' as const),
  ]);
  clearInterval(watch);
  if (code === 'hung') child.kill('SIGKILL');
  const output =
    (await new Response(child.stdout).text()) +
    (await new Response(child.stderr).text());
  const result = {
    code,
    output,
    listened,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    databaseCreated: existsSync(database),
    keys: s3.requests.map((request) => request.key),
  };
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe('a provider that cannot enforce conditional writes fails startup closed', () => {
  const cases: [Behaviour, string][] = [
    ['ignores-conditions', 'accepts every conditional write'],
    ['ignores-if-match', 'honours If-None-Match but ignores If-Match'],
    ['denies-put', 'denies PUT (403)'],
  ];
  for (const [behaviour, description] of cases)
    test(`provider ${description}`, async () => {
      const result = await startWith(behaviour);
      expect(result.code).toBe(1);
      expect(result.output).toContain('conditional write');
      expect(result.output).toContain('If-None-Match');
      expect(result.output).toContain('If-Match');
      expect(result.output).toContain('did not start listening');
      // No restore, replication or worker, no database, no listener.
      expect(result.calls).toBe('version\n');
      expect(result.databaseCreated).toBe(false);
      expect(result.listened).toBe(false);
      expect(result.output).not.toContain('fleet controller listening');
      // Ownership was never claimed and no replica was written: only the probe object was touched.
      expect(
        result.keys.filter(
          (key) => key !== '' && !key.startsWith('provider-test/probes/')
        )
      ).toEqual([]);
      expect(result.keys).not.toContain('provider-test/fleet-owner.json');
      expect(result.output).not.toContain('provider-secret');
      expect(result.output).not.toContain('provider-key-id');
    }, 60_000);
});
