import { afterAll, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDeps } from '../../src/testing/test-deps';
import { mountUi } from '../../src/routes/ui';
import { COOKIE } from './helpers';

const directory = await mkdtemp(join(tmpdir(), 'fleet-artifacts-'));
const asset = 'fleet-installer-windows-x64.exe';
await writeFile(join(directory, asset), 'fixture-installer');
const checksum = new Bun.CryptoHasher('sha256')
  .update('fixture-installer')
  .digest('hex');
await writeFile(join(directory, asset + '.sha256'), `${checksum}  ${asset}\n`);
afterAll(() => rm(directory, { recursive: true, force: true }));
function deployment(installerDir: string | undefined = directory) {
  const deps = createTestDeps();
  const app = new Hono();
  mountUi(app, {
    ...deps,
    env: { ...deps.env, installerDir },
  });
  return app;
}

test('Fleet lists and serves its own artifacts without any GitHub repository', async () => {
  const app = deployment();
  const index = await app.request('/installers/release', {
    headers: { cookie: COOKIE },
  });
  expect(index.status).toBe(200);
  expect(await index.text()).toContain(`/installers/assets/${asset}`);
  const download = await app.request(`/installers/download/${asset}`, {
    headers: { cookie: COOKIE },
  });
  expect(download.headers.get('location')).toBe(`/installers/assets/${asset}`);
  const binary = await app.request(`/installers/assets/${asset}`);
  expect(binary.status).toBe(200);
  expect(await binary.text()).toBe('fixture-installer');
  const hashFile = await app.request(`/installers/assets/${asset}.sha256`);
  expect(hashFile.headers.get('content-type')).toContain('text/plain');
  expect(await hashFile.text()).toContain(checksum);
  const range = await app.request(`/installers/assets/${asset}`, {
    headers: { Range: 'bytes=0-6' },
  });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe('fixture');
  const native = await app.request('/installers/nixos', {
    headers: { cookie: COOKIE },
  });
  expect(await native.text()).toContain(
    'nix build ./packages/fleet#fleet-installer'
  );
});

test('missing images fail explicitly and arbitrary files cannot be downloaded', async () => {
  const app = deployment(undefined);
  expect((await app.request('/installers/release')).status).toBe(303);
  expect((await app.request('/installers/assets/deployment.env')).status).toBe(
    404
  );
  expect(
    (await app.request('/installers/assets/fleet-installer.iso')).status
  ).toBe(404);
  const deps = createTestDeps();
  const empty = new Hono();
  mountUi(empty, { ...deps, env: deps.env });
  expect((await empty.request(`/installers/assets/${asset}`)).status).toBe(503);
});

test.skipIf(process.platform === 'win32')(
  'artifact symlinks cannot expose files outside the publication directory',
  async () => {
    const outside = join(
      directory,
      '../fleet-artifact-private-' + crypto.randomUUID()
    );
    await writeFile(outside, 'private');
    try {
      await symlink(outside, join(directory, 'fleet-installer.iso'));
      expect(
        (await deployment().request('/installers/assets/fleet-installer.iso'))
          .status
      ).toBe(404);
    } finally {
      await rm(outside, { force: true });
    }
  }
);
