import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { When, Then } from './fixtures';

When('I download the recommended installer', async ({ page, world }) => {
  const link = page.getByRole('link', {
    name: 'Download for Windows — x64',
    exact: true,
  });
  await expect(link).toBeVisible();
  const waiting = page.waitForEvent('download');
  await link.click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe('fleet-installer-windows-x64.exe');
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error('No executable was downloaded');
  world.path = path;
});

Then(
  'the executable matches its published size and SHA-256',
  async ({ request, world }) => {
    const path = world.path;
    if (!path) throw new Error('No executable was downloaded');
    const bytes = await readFile(path);
    const response = await request.get(
      'https://api.github.com/repos/crvouga/fleet/releases/tags/fleet-installer'
    );
    expect(response.status()).toBe(200);
    const release = (await response.json()) as {
      assets: { name: string; digest: string; size: number }[];
    };
    const asset = release.assets.find(
      (item) => item.name === 'fleet-installer-windows-x64.exe'
    );
    expect(asset).toBeDefined();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.subarray(0, 2).toString()).toBe('MZ');
    expect(bytes.length).toBe(asset!.size);
    expect('sha256:' + sha256).toBe(asset!.digest);
    await world.info.attach('verified-recommended-download', {
      contentType: 'application/json',
      body: JSON.stringify({ bytes: bytes.length, sha256 }),
    });
  }
);
