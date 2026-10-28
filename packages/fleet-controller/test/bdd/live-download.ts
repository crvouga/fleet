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
    const origin = process.env['FLEET_BDD_URL'];
    const filename = 'fleet-installer-windows-x64.exe';
    const checksum = await request.get(
      `${origin}/installers/assets/${filename}.sha256`
    );
    expect(checksum.status()).toBe(200);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.subarray(0, 2).toString()).toBe('MZ');
    expect((await checksum.text()).trim().split(/\s+/)[0]).toBe(sha256);
    await world.info.attach('verified-recommended-download', {
      contentType: 'application/json',
      body: JSON.stringify({ bytes: bytes.length, sha256 }),
    });
  }
);
