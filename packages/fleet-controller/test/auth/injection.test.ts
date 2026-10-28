import { describe, expect, test } from 'bun:test';
import { startController } from '../../src/controller';
import { readControllerEnv } from '../../src/env';
import type { AuthContext } from '../../src/auth/contracts';
import { databaseAvailable, useDatabase } from '../support/database';
import { ADMIN_TOKEN, silent } from '../support/controller';

function environment(path: string) {
  return {
    ...readControllerEnv({
      FLEET_ADMIN_TOKEN: ADMIN_TOKEN,
      FLEET_DATABASE_PATH: path,
      FLEET_S3_BUCKET: 'test-bucket',
      AWS_ACCESS_KEY_ID: 'test-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      FLEET_OIDC_ISSUER: 'https://identity.example.test/pool',
      FLEET_OIDC_CLIENT_ID: 'deployment-client',
      FLEET_PUBLIC_ORIGIN: 'http://localhost',
    }),
    port: 0,
  };
}

describe.skipIf(!databaseAvailable)(
  'injected controller authentication',
  () => {
    const database = useDatabase();
    test('the default factory discovers only the configured provider through the injected transport', async () => {
      const env = environment(database().path);
      const issuer = env.oidc!.issuer;
      const requests: string[] = [];
      const running = await startController(env, silent, {
        local: true,
        async fetch(input) {
          requests.push(String(input));
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/keys`,
            response_types_supported: ['code'],
            id_token_signing_alg_values_supported: ['RS256'],
            token_endpoint_auth_methods_supported: ['none'],
            subject_types_supported: ['public'],
          });
        },
      });
      try {
        const response = await fetch(
          `http://127.0.0.1:${running.port}/auth/login`,
          { redirect: 'manual' }
        );
        expect(response.status).toBe(303);
        const destination = new URL(response.headers.get('location')!);
        expect(destination.origin + destination.pathname).toBe(
          `${issuer}/authorize`
        );
        expect(destination.searchParams.get('client_id')).toBe(
          env.oidc!.clientId
        );
        expect(destination.searchParams.get('code_challenge_method')).toBe(
          'S256'
        );
        expect(requests).toEqual([
          `${issuer}/.well-known/openid-configuration`,
        ]);
      } finally {
        await running.stop();
      }
    });

    test('the running server uses injected browser/admin interfaces without constructing the default provider', async () => {
      const contexts: AuthContext[] = [];
      let requests = 0;
      const transport: AuthContext['fetch'] = async () => {
        requests++;
        throw new Error('No upstream auth request is allowed in this test');
      };
      const running = await startController(
        environment(database().path),
        silent,
        {
          local: true,
          fetch: transport,
          authFactory(context) {
            contexts.push(context);
            return {
              auth: {
                async actor(c) {
                  return c.req.header('authorization') ===
                    'Bearer injected-admin'
                    ? 'operator'
                    : null;
                },
                sameOrigin(c) {
                  return c.req.header('origin') === context.oidc?.origin;
                },
                logoutCookie() {
                  return 'test-session=; Path=/; Max-Age=0';
                },
              },
              browserAuth: {
                access: context.access,
                async identity() {
                  return null;
                },
                async begin(c) {
                  return c.text('injected-sign-in');
                },
                async callback(c) {
                  return c.text('injected-callback');
                },
                async logout() {},
              },
            };
          },
        }
      );
      const origin = `http://127.0.0.1:${running.port}`;
      try {
        expect(await (await fetch(origin + '/auth/login')).text()).toBe(
          'injected-sign-in'
        );
        expect(await (await fetch(origin + '/auth/callback')).text()).toBe(
          'injected-callback'
        );
        expect(
          (
            await fetch(origin + '/v1/nodes', {
              headers: { Authorization: 'Bearer injected-admin' },
            })
          ).status
        ).toBe(200);
        expect(
          (
            await fetch(origin + '/v1/nodes', {
              headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
            })
          ).status
        ).toBe(401);
        expect(requests).toBe(0);
        expect(contexts).toHaveLength(1);
        expect(contexts[0]?.oidc?.issuer).toBe(
          'https://identity.example.test/pool'
        );
        expect(contexts[0]?.fetch).toBe(transport);
        expect(await contexts[0]!.access.emails()).toEqual([]);
      } finally {
        await running.stop();
      }
    });

    test('a failed injected factory refuses startup and does not expose upstream errors', async () => {
      await expect(
        startController(environment(database().path), silent, {
          local: true,
          authFactory() {
            throw new Error('sensitive-provider-payload');
          },
        })
      ).rejects.toThrow('Authentication adapter initialization failed');
    });
  }
);
