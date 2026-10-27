import { expect } from '@playwright/test';
import { Given, When, Then } from '../fixtures';
import { startWizard } from '../wizard';

const WIFI_PASSWORD = 'fixture-only-wifi-password';

When(
  'I review a USB with explicit hidden WPA3 Wi-Fi settings',
  async ({ page }) => {
    await page.getByRole('button', { name: /Make an install USB/ }).click();
    await page
      .getByText('Use a different Wi-Fi network', { exact: true })
      .click();
    await page.getByLabel('Wi-Fi network name').fill('Fixture Wi-Fi');
    await page.getByLabel('Wi-Fi security').selectOption('sae');
    await page
      .getByLabel('Wi-Fi password', { exact: true })
      .fill(WIFI_PASSWORD);
    await page.getByLabel('Hidden network').check();
    const response = page.waitForResponse((r) => r.url().endsWith('/api/plan'));
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    const body: unknown = await (await response).json();
    expect(JSON.stringify(body)).not.toContain(WIFI_PASSWORD);
    expect(body).not.toHaveProperty('wifi');
  }
);

Then(
  'the Wi-Fi password stays private and disk consent is still required',
  async ({ page }) => {
    await expect(page.locator('#ack')).not.toBeChecked();
    await expect(page.locator('body')).not.toContainText(WIFI_PASSWORD);
    await expect(page.getByText(/Keep this USB private/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Erase and install' })
    ).toBeVisible();
  }
);

Given(
  'I open the USB wizard on {string} with {string} hardware',
  async ({ page, world }, os: string, arch: string) => {
    world.wizard = await startWizard(true, { os, arch });
    world.cleanup.push(world.wizard.stop);
    await page.goto(world.wizard.url);
  }
);

When('I review the automatically selected USB', async ({ page }) => {
  await page.getByRole('button', { name: /Make an install USB/ }).click();
  await expect(page.locator('input[name="usb"]')).toBeChecked();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('#ack')).not.toBeChecked();
  await expect(page.locator('.erase')).toContainText('BDD Test USB');
});

When('I reload the installer page', async ({ page }) => {
  await page.reload();
});

When('I choose the CI runner role', async ({ page }) => {
  await page.getByRole('button', { name: /Turn THIS computer/ }).click();
  await page.locator('input[name="role"][value="ci"]').check();
});

Then(
  'SSH key and manual enrollment fields stay out of the normal flow',
  async ({ page }) => {
    await expect(page.locator('#ssh-key')).toBeHidden();
    await expect(page.locator('#token')).toBeHidden();
    await expect(page.getByText(/Enrollment is automatic/)).toBeVisible();
  }
);
