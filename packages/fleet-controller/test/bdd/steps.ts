import { expect } from '@playwright/test';
import { Given, When, Then } from './fixtures';
import { emulateComputer } from './browser-profile';
import { PROFILES } from './profiles';

const DOWNLOAD = '/installers/download/';

Then(
  'the recommendation matches the computer running this browser',
  async ({ page }) => {
    const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[
      process.platform as 'darwin' | 'linux' | 'win32'
    ];
    expect(os).toBeDefined();
    expect(['x64', 'arm64']).toContain(process.arch);
    const suffix =
      os === 'windows' ? '.exe' : os === 'macos' ? '.zip' : '.tar.gz';
    await expect(page.locator('[data-installer-status]')).toContainText(
      'Recommended for this computer:'
    );
    await expect(page.locator('[data-installer-recommended]')).toHaveAttribute(
      'href',
      DOWNLOAD + 'fleet-installer-' + os + '-' + process.arch + suffix
    );
  }
);

Given('I browse Fleet from {string}', async ({ page }, device: string) => {
  const profile = PROFILES[device];
  if (!profile) throw new Error('Unknown browser profile');
  await emulateComputer(page, profile);
});

Given('JavaScript is disabled in my browser', async ({ javaScriptEnabled }) => {
  expect(javaScriptEnabled).toBe(false);
});

When('I open the Add node page', async ({ page }) => {
  const response = await page.goto('/add');
  expect(response?.status()).toBe(200);
});

When('I open the empty fleet overview', async ({ page }) => {
  await page.clock.install();
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
});

When('the dashboard refreshes automatically', async ({ page }) => {
  const refreshed = page.waitForResponse((response) =>
    response.url().includes('/ui/state?')
  );
  await page.clock.fastForward(10_001);
  expect((await refreshed).status()).toBe(200);
});

Then(
  'the recommended installer downloads {string}',
  async ({ page }, file: string) => {
    await expect(page.locator('[data-installer-status]')).toContainText(
      'Recommended for this computer:'
    );
    await expect(page.locator('[data-installer-recommended]')).toBeVisible();
    await expect(page.locator('[data-installer-recommended]')).toHaveAttribute(
      'href',
      DOWNLOAD + file
    );
  }
);

Then('no installer is incorrectly recommended', async ({ page }) => {
  await expect(page.locator('[data-installer-status]')).not.toHaveText(
    'Detecting this computer…'
  );
  await expect(page.locator('[data-installer-recommended]')).toBeHidden();
  await expect(page.getByLabel('Installer for')).toBeVisible();
});

Then('all other installers remain available', async ({ page }) => {
  await page.getByText('All installers', { exact: true }).click();
  const choices = page.locator(
    '#installer-downloads details, [data-installer-choices]'
  );
  for (const name of [
    'Windows — x64',
    'macOS — Apple silicon (ARM64)',
    'macOS — Intel (x64)',
    'Linux — x64',
    'Linux — ARM64',
  ]) {
    await expect(
      choices.getByRole('link', { name, exact: true })
    ).toBeVisible();
  }
  await expect(
    choices.getByRole('link', { name: 'NixOS — native installer' })
  ).toBeVisible();
});

When(
  'I select {string} as the installer platform',
  async ({ page }, platform: string) => {
    await page.getByLabel('Installer for').selectOption(platform);
  }
);

Then(
  'the selected installer downloads {string}',
  async ({ page }, file: string) => {
    await expect(page.locator('[data-installer-status]')).toContainText(
      'Selected installer:'
    );
    await expect(page.locator('[data-installer-recommended]')).toHaveAttribute(
      'href',
      DOWNLOAD + file
    );
  }
);

Then(
  'the selected installer stays {string} after detection finishes',
  async ({ page }, file: string) => {
    await expect(page.locator('html')).toHaveAttribute(
      'data-hints-ready',
      'yes'
    );
    await expect(page.locator('[data-installer-status]')).toContainText(
      'Selected installer:'
    );
    await expect(page.locator('[data-installer-recommended]')).toHaveAttribute(
      'href',
      DOWNLOAD + file
    );
  }
);

Then(
  'the native NixOS installation instructions are recommended',
  async ({ page }) => {
    await expect(page.locator('[data-installer-recommended]')).toBeVisible();
    await expect(page.locator('[data-installer-recommended]')).toHaveAttribute(
      'href',
      '#nixos-install'
    );
    const command = page.getByRole('link', {
      name: 'Show the native installer command',
    });
    await expect(command).toBeVisible();
    await command.click();
    await expect(page.locator('body')).toContainText(
      'packages/fleet#fleet-installer'
    );
  }
);
