import { expect, spyOn, test } from 'bun:test';
import { createLogger } from './logger';
import { operation, logContext } from './context';
import { errorDetails } from './error';
import { observeHttp } from './http';

test('SQL and OAuth failures retain causes and source frames without raw error data', async () => {
  const original = Object.assign(
    new Error('postgres://user:password@db/x?code=private'),
    {
      name: 'PostgresError',
      code: 'ERR_POSTGRES_SERVER_ERROR',
      errno: '53300',
      detail: 'password and email must stay private',
    }
  );
  const error = await operation('cleanup.clients', async () => {
    throw original;
  }).catch((error: unknown) => error);
  const details = errorDetails(error);
  expect(details['operation']).toBe('cleanup.clients');
  expect(details['cause']).toMatchObject({
    sqlstate: '53300',
    reason: 'database_connection_exhausted',
  });
  expect(JSON.stringify(details)).not.toContain('password');
  expect(JSON.stringify(details)).not.toContain('private');
  const oauth = Object.assign(new Error('token-body'), {
    cause: { error: 'invalid_client', error_description: 'client-secret' },
  });
  expect(errorDetails(oauth)['cause']).toMatchObject({
    oauth: 'invalid_client',
  });
  expect(JSON.stringify(errorDetails(oauth))).not.toContain('client-secret');
});

test('the shared sink redacts nested secrets, credentials and query strings and handles cycles', () => {
  const sink = spyOn(console, 'info').mockImplementation(() => {});
  try {
    const log = createLogger({ name: 'test', level: 'info' });
    const cyclic: Record<string, unknown> = { password: 'private-password' };
    cyclic['self'] = cyclic;
    log.info('safe_event', {
      nested: {
        authorization: 'Bearer private-bearer',
        client_secret: 'private-client',
      },
      location:
        'postgres://user:private-db@db.example/test?token=private-query',
      cyclic,
      number: 1n,
    });
    const output = String(sink.mock.calls[0]?.[0]);
    expect(output).not.toContain('private-');
    expect(output).toContain('[REDACTED]');
    expect(JSON.parse(output).number).toBe('1');
  } finally {
    sink.mockRestore();
  }
});

test('concurrent requests have isolated IDs, response references and safe outcomes', async () => {
  const sink = spyOn(console, 'info').mockImplementation(() => {});
  try {
    const log = createLogger({ name: 'test' });
    const requests = await Promise.all(
      [1, 2].map(async (delay) => {
        const response = await observeHttp(
          log,
          new Request('https://auth.example/auth/callback?code=private-code', {
            headers: { 'X-Request-ID': 'forged-id' },
          }),
          async () => {
            const id = logContext()['requestId'];
            await Bun.sleep(delay);
            expect(logContext()['requestId']).toBe(id);
            log.info('inside_request');
            return Response.json({ id });
          },
          () => '/auth/callback'
        );
        expect(response.headers.get('X-Request-ID')).toBe(
          (await response.json()).id
        );
        return response.headers.get('X-Request-ID');
      })
    );
    expect(new Set(requests).size).toBe(2);
    const output = JSON.stringify(sink.mock.calls);
    expect(output).not.toContain('private-code');
    expect(output).not.toContain('forged-id');
    expect(logContext()).toEqual({});
    for (const id of requests) expect(output).toContain(String(id));
  } finally {
    sink.mockRestore();
  }
});
