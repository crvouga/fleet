import { afterAll, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controller, root } from '../../src/local/paths';
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';

type Child = ReturnType<typeof Bun.spawn>;
const directory = await mkdtemp(join(tmpdir(), 'fleet-local-'));
const children: Child[] = [];
const cli = join(controller, 'src/local/cli.ts');

function launch(state: string, action = 'run') {
  const child = Bun.spawn([process.execPath, cli, action, '--no-watch'], {
    cwd: root,
    env: { ...process.env, PORT: undefined, FLEET_LOCAL_STATE_DIR: state },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  children.push(child);
  return child;
}

async function ready(state: string, child: Child) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null)
      throw new Error(
        `Local startup exited ${child.exitCode}: ${await new Response(child.stderr).text()}`
      );
    try {
      const runtime = JSON.parse(
        await readFile(join(state, 'runtime.json'), 'utf8')
      ) as { controlUrl: string; token: string };
      const response = await fetch(
        `${runtime.controlUrl}/__fleet_local/status`,
        {
          headers: { Authorization: `Bearer ${runtime.token}` },
        }
      );
      const status = (await response.json()) as { url: string | null };
      if (status.url) return { ...runtime, url: status.url };
    } catch {
      /* Startup has not published readiness yet. */
    }
    await Bun.sleep(100);
  }
  throw new Error('Local server did not become ready');
}

async function apiHeaders(state: string) {
  const { adminToken } = (await Bun.file(
    join(state, 'credentials.json')
  ).json()) as { adminToken: string };
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };
}

afterAll(async () => {
  for (const child of children) child.kill('SIGTERM');
  await Promise.allSettled(children.map((child) => child.exited));
  await rm(directory, { recursive: true, force: true });
});

test('local CLI prerequisites run in a fresh checkout before dependencies are installed', async () => {
  const checkout = join(directory, 'cold checkout');
  const source = join(checkout, 'packages/fleet-controller/src');
  await cp(join(controller, 'src/local'), join(source, 'local'), {
    recursive: true,
  });
  for (const file of ['preflight.ts', 'startup-error.ts'])
    await cp(join(controller, 'src', file), join(source, file));
  const doctor = Bun.spawn(
    [process.execPath, join(source, 'local/cli.ts'), 'doctor'],
    { cwd: checkout, stdout: 'pipe', stderr: 'pipe' }
  );
  expect(await doctor.exited).toBe(0);
  expect(await new Response(doctor.stdout).text()).toContain('Bun 1.4.4');
  expect(existsSync(join(checkout, 'node_modules'))).toBe(false);
});

test('isolated local runs choose different ports, authenticate cleanup, and stop independently', async () => {
  const firstState = join(directory, 'first');
  const secondState = join(directory, 'second');
  const first = launch(firstState);
  const second = launch(secondState);
  const [a, b] = await Promise.all([
    ready(firstState, first),
    ready(secondState, second),
  ]);
  expect(a.url).not.toBe(b.url);
  expect(new URL(a.url).hostname).toBe('127.0.0.1');
  const login = await fetch(a.url);
  expect(login.headers.get('x-fleet-data-source')).toBe('emulated');
  expect(await login.text()).toContain('Sign in with OpenID Connect');
  expect((await fetch(a.url + '/v1/nodes')).status).toBe(401);
  expect(
    await (
      await fetch(a.url + '/v1/nodes', {
        headers: await apiHeaders(firstState),
      })
    ).json()
  ).toEqual({ nodes: [] });
  const forbidden = await fetch(`${a.controlUrl}/__fleet_local/stop`, {
    method: 'POST',
  });
  expect(forbidden.status).toBe(403);
  const stopFirst = launch(firstState, 'stop');
  expect(await stopFirst.exited).toBe(0);
  expect(await first.exited).toBe(0);
  expect((await fetch(b.url)).status).toBe(200);
  expect(await Bun.file(join(firstState, 'runtime.json')).exists()).toBe(false);
  const stopSecond = launch(secondState, 'stop');
  expect(await stopSecond.exited).toBe(0);
  expect(await second.exited).toBe(0);
}, 60_000);

test('Mockingbird sign-in uses the normal browser session and real owner allowlist', async () => {
  const state = join(directory, 'browser');
  const child = launch(state);
  const running = await ready(state, child);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(running.url);
    await page
      .getByRole('link', { name: 'Sign in with OpenID Connect' })
      .click();
    await page.getByTestId('oauth-mock-account-local-owner').click();
    await page.getByTestId('oauth-mock-allow').click();
    await page.waitForURL(running.url + '/');
    expect((await page.request.get(running.url + '/v1/nodes')).status()).toBe(
      200
    );
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    expect((await page.request.get(running.url + '/v1/nodes')).status()).toBe(
      401
    );
  } finally {
    await browser.close();
    expect(await launch(state, 'stop').exited).toBe(0);
    expect(await child.exited).toBe(0);
  }
}, 60_000);

test('real settings survive a restart and restore from the Mockingbird S3 replica after local database loss', async () => {
  const state = join(directory, 'replica');
  const first = launch(state);
  const initial = await ready(state, first);
  const headers = await apiHeaders(state);
  const settings = { heartbeat: { intervalSeconds: 90 } };
  expect(
    (
      await fetch(initial.url + '/v1/settings/fleet', {
        method: 'PUT',
        headers,
        body: JSON.stringify(settings),
      })
    ).status
  ).toBe(200);
  await Bun.sleep(2200);
  expect(await launch(state, 'stop').exited).toBe(0);
  expect(await first.exited).toBe(0);
  // Only test-owned temporary state: the emulator's portable snapshot is retained.
  await rm(join(state, 'data'), { recursive: true, force: true });
  const second = launch(state);
  const restored = await ready(state, second);
  expect(
    await (await fetch(restored.url + '/v1/settings/fleet', { headers })).json()
  ).toMatchObject({ value: settings });
  expect(await launch(state, 'stop').exited).toBe(0);
  expect(await second.exited).toBe(0);
}, 60_000);

test('a duplicate local run fails without stopping the current server', async () => {
  const state = join(directory, 'duplicate');
  const first = launch(state);
  const running = await ready(state, first);
  const duplicate = launch(state);
  expect(await duplicate.exited).toBe(1);
  expect(await new Response(duplicate.stderr).text()).toContain(
    'owns this checkout'
  );
  expect((await fetch(running.url)).status).toBe(200);
  expect(await launch(state, 'stop').exited).toBe(0);
  expect(await first.exited).toBe(0);
}, 60_000);
