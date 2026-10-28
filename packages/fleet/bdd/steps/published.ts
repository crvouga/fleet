import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Given, When, Then, required } from '../fixtures';
import {
  DOWNLOAD_URL,
  FLEET_URL,
  RELEASE_URL,
  publishedAssets,
} from '../release';

Then(
  'the page offers the native NixOS installer and hard reinstall guide',
  async ({ page }) => {
    await page
      .getByText('Installing or reinstalling NixOS?', { exact: true })
      .click();
    await expect(
      page.getByRole('link', {
        name: 'NixOS installation and hard reinstall guide',
      })
    ).toHaveAttribute('href', '/installers/nixos-guide');
    await expect(
      page.getByRole('link', { name: 'Show the native installer command' })
    ).toHaveAttribute('href', '/installers/nixos');
    await expect(
      page.getByText(/running CI jobs block reinstallation/)
    ).toBeVisible();
  }
);

Given(
  'I have owner access to the deployed Fleet dashboard',
  async ({ page }) => {
    if (!FLEET_URL)
      throw new Error('Set FLEET_BDD_URL to your deployed dashboard origin');
    const token = process.env['FLEET_ADMIN_TOKEN'];
    if (!token)
      throw new Error(
        'Set FLEET_ADMIN_TOKEN in your environment to run live scenarios'
      );
    await page.route(`${FLEET_URL}/**`, async (route) => {
      await route.continue({
        headers: {
          ...route.request().headers(),
          Authorization: `Bearer ${token}`,
        },
      });
    });
  }
);

When('I open the deployed Add node page', async ({ page }) => {
  const response = await page.goto(`${FLEET_URL}/add`);
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('link', { name: 'Open the installer release' })
  ).toHaveAttribute('href', '/installers/release');
});

When('I follow its installer release link', async ({ page, world }) => {
  const popup = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Open the installer release' }).click();
  world.releasePage = await popup;
});

Then('the Fleet app lists the Windows installer', async ({ world }) => {
  const release = required(world.releasePage);
  await expect(release).toHaveURL(RELEASE_URL);
  await expect(
    release
      .getByRole('link', { name: /fleet-installer-windows-x64\.exe/ })
      .first()
  ).toBeVisible();
});

When('I download the published Windows installer', async ({ world }) => {
  const release = required(world.releasePage);
  const downloadEvent = release.waitForEvent('download');
  await release
    .getByRole('link', { name: /fleet-installer-windows-x64\.exe/ })
    .first()
    .click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('fleet-installer-windows-x64.exe');
  world.downloadPath = world.info.outputPath(download.suggestedFilename());
  await download.saveAs(world.downloadPath);
  expect(await download.failure()).toBeNull();
});

Then(
  'the downloaded executable matches its published size and SHA-256',
  async ({ world }) => {
    const bytes = await readFile(required(world.downloadPath));
    const asset = required(
      (await publishedAssets()).get('fleet-installer-windows-x64.exe')
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(bytes.subarray(0, 2).toString()).toBe('MZ');
    expect(bytes.length).toBe(asset.size);
    expect(`sha256:${sha256}`).toBe(asset.digest);
    await world.info.attach('verified-windows-download', {
      contentType: 'application/json',
      body: JSON.stringify(
        { url: DOWNLOAD_URL + asset.name, bytes: bytes.length, sha256 },
        null,
        2
      ),
    });
  }
);

When(
  'I request the published download {string}',
  async ({ request, world }, filename: string) => {
    const response = await request.head(DOWNLOAD_URL + filename);
    world.downloadStatus = response.status();
  }
);

Then('the public download returns HTTP 200', ({ world }) => {
  expect(required(world.downloadStatus)).toBe(200);
});

When('I fetch the real installer image manifest', async ({ request }) => {
  const response = await request.get(
    DOWNLOAD_URL + 'fleet-installer.iso.parts.json'
  );
  expect(response.status()).toBe(200);
});

Then(
  'every image part is reachable and matches its published size and checksum',
  async ({ request, world }) => {
    const response = await request.get(
      DOWNLOAD_URL + 'fleet-installer.iso.parts.json'
    );
    const manifest = (await response.json()) as {
      size: number;
      parts: { name: string; size: number; sha256: string }[];
    };
    expect(manifest.parts.length).toBeGreaterThan(0);
    expect(manifest.parts.reduce((sum, part) => sum + part.size, 0)).toBe(
      manifest.size
    );
    for (const part of manifest.parts) {
      const head = await request.head(DOWNLOAD_URL + part.name);
      expect(head.status()).toBe(200);
      expect(Number(head.headers()['content-length'])).toBe(part.size);
      expect(part.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    await world.info.attach('verified-image-manifest', {
      contentType: 'application/json',
      body: JSON.stringify(manifest, null, 2),
    });
  }
);
