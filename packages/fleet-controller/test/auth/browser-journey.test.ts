import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { chromium } from '@playwright/test';
import { Hono } from 'hono';
import { FleetBrowserAuth } from '../../src/auth/browser-auth';
import { FleetAdminAuth } from '../../src/auth/admin-auth';
import { SqliteAccessStore } from '../../src/db/access-store';
import { mountUi } from '../../src/routes/ui';
import { localResponse } from '../../src/local-response';
import { createTestDeps } from '../../src/testing/test-deps';
import { databaseAvailable, useDatabase } from '../support/database';
import { mockBrowserRelay } from '../support/relay';
import { silent } from '../support/controller';

describe.skipIf(!databaseAvailable)(
  'Google through relay browser journey',
  () => {
    const database = useDatabase();
    test('denied person signs out, chooses an allowed account and manages Fleet access', async () => {
      const app = new Hono();
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) =>
          localResponse(await app.fetch(request), request),
      });
      const certificate = mkdtempSync(join(tmpdir(), 'fleet-relay-tls-'));
      const key = join(certificate, 'key.pem'),
        cert = join(certificate, 'cert.pem');
      const generated = Bun.spawnSync([
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=mock-relay.example',
      ]);
      expect(generated.exitCode).toBe(0);
      let email = 'denied@example.test';
      const upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        tls: { key: readFileSync(key), cert: readFileSync(cert) },
        fetch(request) {
          return Response.redirect(authorization(new URL(request.url)), 302);
        },
      });
      const config = {
        origin: `http://127.0.0.1:${server.port}`,
        issuer: `https://mock-relay.example:${upstream.port}/realms/test`,
        clientId: 'browser-fixture',
      };
      const relay = mockBrowserRelay(config);
      function authorization(url: URL): string {
        return relay.authorize(url, email);
      }
      const access = new SqliteAccessStore(database().sql);
      await access.allow('admin@example.test', 'test-database-owner');
      const browserAuth = new FleetBrowserAuth(access, config, relay.client);
      const deps = createTestDeps();
      mountUi(app, {
        ...deps,
        browserAuth,
        auth: new FleetAdminAuth({
          env: deps.env,
          now: deps.now,
          fetch,
          log: silent,
          browser: browserAuth,
          publicOrigin: config.origin,
        }),
      });
      const browser = await chromium.launch({
        headless: true,
        args: ['--host-resolver-rules=MAP mock-relay.example 127.0.0.1'],
      });
      try {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        page.setDefaultTimeout(5000);
        page.setDefaultNavigationTimeout(5000);
        await page.goto(`${config.origin}/login`);
        expect(await page.locator('input[type=password]').count()).toBe(0);
        await page.getByRole('link', { name: 'Sign in with OpenID Connect' }).click();
        await page.waitForURL('**/not-allowed');
        // The URL changes before the page renders; count() does not wait, so
        // a slow runner counted 0. Wait for the heading, then assert there is one.
        const notAllowed = page.getByRole('heading', { name: 'Not allowed' });
        await notAllowed.first().waitFor();
        expect(await notAllowed.count()).toBe(1);
        await page.getByRole('button', { name: 'Sign out' }).click();
        await page.waitForURL('**/login');
        email = 'admin@example.test';
        await page.getByRole('link', { name: 'Sign in with OpenID Connect' }).click();
        await page.waitForURL(config.origin + '/');
        await page.getByRole('link', { name: 'Access', exact: true }).click();
        await page
          .getByLabel('Email address')
          .fill('another@example.test');
        await page.getByRole('button', { name: 'Allow access' }).click();
        const row = page
          .getByRole('listitem')
          .filter({ hasText: 'another@example.test' });
        await row.waitFor();
        expect(await access.emails()).toContain('another@example.test');
        await row.getByRole('button', { name: 'Remove access' }).click();
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Remove access', exact: true })
          .click();
        await row.waitFor({ state: 'detached' });
        expect(await access.emails()).not.toContain('another@example.test');
      } finally {
        await browser.close();
        await server.stop(true);
        await upstream.stop(true);
        rmSync(certificate, { recursive: true, force: true });
      }
    }, 30000);
  }
);
