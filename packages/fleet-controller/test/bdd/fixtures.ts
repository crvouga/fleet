import { createBdd, test as base } from 'playwright-bdd';
import type { Page, TestInfo } from '@playwright/test';

interface World {
  path?: string;
  info: TestInfo;
}

async function authorizeLivePage(page: Page) {
  if (process.env['FLEET_DOWNLOAD_LIVE'] !== '1') return;
  const token = process.env['FLEET_ADMIN_TOKEN'];
  if (!token)
    throw new Error(
      'Run live scenarios with vault run --config prd to supply FLEET_ADMIN_TOKEN'
    );
  await page.route('https://fleet.example.com/**', async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        Authorization: `Bearer ${token}`,
      },
    });
  });
}

export const test = base.extend<{ world: World; ownerAuth: void }>({
  ownerAuth: [
    async ({ page }, runScenario) => {
      await authorizeLivePage(page);
      await runScenario();
    },
    { auto: true },
  ],
  world: async ({}, runScenario, info) => {
    await runScenario({ info });
  },
});
export const { Given, When, Then } = createBdd(test);
