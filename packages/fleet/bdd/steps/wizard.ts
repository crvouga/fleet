import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Given, When, Then, required } from '../fixtures';
import { startWizard } from '../wizard';

Then('the wizard reports the expected build revision', async ({ page }) => {
  const version = process.env['FLEET_BDD_EXPECT_VERSION'] ?? 'dev';
  await expect(page.getByText(/Version /)).toContainText('Version ' + version);
});

Given(
  'I open the installer wizard with a published image and a simulated USB disk',
  async ({ page, world }) => {
    world.wizard = await startWizard(true);
    world.cleanup.push(world.wizard.stop);
    await page.goto(world.wizard.url);
    await expect(page.getByText('What do you want to do?')).toBeVisible();
  }
);

Given(
  'I open the installer wizard with an unavailable image',
  async ({ page, world }) => {
    world.wizard = await startWizard(false);
    world.cleanup.push(world.wizard.stop);
    await page.goto(world.wizard.url);
  }
);

When('I choose the USB disk and review the installation', async ({ page }) => {
  await page.getByRole('button', { name: /Make an install USB/ }).click();
  await expect(page.getByText('BDD Test USB')).toBeVisible();
  await page.locator('input[name="usb"]').check();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Erase and install' })
  ).toBeVisible();
});

When('I try to install without confirming the erase', async ({ page }) => {
  const dialog = page.waitForEvent('dialog').then(async (prompt) => {
    const message = prompt.message();
    await prompt.dismiss();
    return message;
  });
  await page.getByRole('button', { name: 'Erase and install' }).click();
  expect(await dialog).toContain('Tick the box');
});

Then('the simulated disk has not changed', async ({ world }) => {
  const wizard = required(world.wizard);
  expect(await readFile(wizard.disk)).toEqual(wizard.original);
});

When('I confirm the erase and install', async ({ page }) => {
  await page.locator('#ack').check();
  await page.getByRole('button', { name: 'Erase and install' }).click();
});

Then('the wizard reports a verified installation', async ({ page }) => {
  const outcome = page.getByRole('heading', {
    name: /^(USB ready|It did not finish)$/,
  });
  await expect(outcome).toBeVisible({ timeout: 60_000 });
  expect(await outcome.innerText()).toBe('USB ready');
  await expect(page.getByText(/start it from the stick/)).toBeVisible();
});

Then('the simulated disk contains the published image', async ({ world }) => {
  const wizard = required(world.wizard);
  expect(
    (await readFile(wizard.disk)).subarray(0, wizard.image.length)
  ).toEqual(wizard.image);
});

Then(
  'the wizard explains that the download cannot be reached',
  async ({ page }) => {
    await expect(page.getByText(/cannot be reached/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Erase and install' })
    ).toHaveCount(0);
  }
);
