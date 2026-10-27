import { expect } from '@playwright/test';
import { When, Then } from './fixtures';

When('I open Fleet settings', async ({ page }) => {
  await page.goto('/settings/fleet');
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true })
  ).toBeVisible();
});
When('I change the heartbeat interval', async ({ page }) => {
  await page.getByLabel('Heartbeat interval', { exact: true }).fill('90');
});
When('I try to leave settings', async ({ page }) => {
  await page.getByRole('link', { name: 'Nodes', exact: true }).click();
});
Then('Fleet asks before discarding my draft', async ({ page }) => {
  await expect(page.getByRole('dialog')).toContainText(
    'Discard unsaved changes?'
  );
  await expect(page).toHaveURL(/\/settings\/fleet$/);
});
When('I keep editing and save settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(
    page.getByLabel('Heartbeat interval', { exact: true })
  ).toHaveValue('90');
  await page
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
});
Then('my settings are saved', async ({ page }) => {
  await expect(page.getByRole('status')).toContainText('settings saved');
  await page.reload();
  await expect(
    page.getByLabel('Heartbeat interval', { exact: true })
  ).toHaveValue('90');
});
When('I submit invalid raw settings', async ({ page }) => {
  await page.getByRole('button', { name: 'Advanced: raw JSON' }).click();
  await page.getByLabel('Settings JSON').fill('{invalid draft');
  await page.getByRole('button', { name: 'Save raw JSON' }).click();
});
Then('the error preserves my raw draft', async ({ page }) => {
  await expect(
    page.getByRole('alert', { name: 'Something needs attention' })
  ).toContainText('not valid JSON');
  await expect(page.getByLabel('Settings JSON')).toHaveValue('{invalid draft');
  await expect(
    page.getByLabel('Heartbeat interval', { exact: true })
  ).toHaveValue('90');
});
Then(
  'light and dark choices persist and system mode follows the operating system',
  async ({ page }) => {
    for (const mode of ['Light', 'Dark', 'System']) {
      await page.getByRole('button', { name: /^Color theme:/ }).click();
      await page
        .getByRole('menuitemradio', { name: mode, exact: true })
        .click();
      await page.reload();
      await expect(
        page.getByRole('button', { name: `Color theme: ${mode}` })
      ).toBeVisible();
      if (mode !== 'System')
        await expect(page.locator('html')).toHaveAttribute(
          'data-mantine-color-scheme',
          mode.toLowerCase()
        );
    }
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute(
      'data-mantine-color-scheme',
      'dark'
    );
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute(
      'data-mantine-color-scheme',
      'light'
    );
  }
);
