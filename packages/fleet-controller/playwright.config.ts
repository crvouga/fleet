import { defineConfig } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const live = process.env['FLEET_DOWNLOAD_LIVE'] === '1';
const liveUrl = process.env['FLEET_BDD_URL'];
if (live && !liveUrl)
  throw new Error('Set FLEET_BDD_URL to your deployed dashboard origin');
const port = process.env['FLEET_DOWNLOAD_TEST_PORT'] ?? '39219';

export default defineConfig({
  testDir: defineBddConfig({
    features: 'test/bdd/features/*.feature',
    steps: [
      'test/bdd/fixtures.ts',
      'test/bdd/steps.ts',
      'test/bdd/console-steps.ts',
      'test/bdd/live-download.ts',
    ],
    outputDir: 'dist/download-bdd-generated',
  }),
  timeout: 30_000,
  workers: 1,
  retries: 0,
  projects: [
    { name: 'browser', grepInvert: live ? /@nojs|@local/ : /@nojs|@live/ },
    { name: 'no-javascript', grep: /@nojs/, use: { javaScriptEnabled: false } },
  ],
  outputDir: 'dist/download-bdd-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'dist/download-bdd-report', open: 'never' }],
    ['json', { outputFile: 'dist/download-bdd-results.json' }],
  ],
  use: {
    baseURL: live ? liveUrl : `http://127.0.0.1:${port}`,
    trace: live ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  ...(live
    ? {}
    : {
        webServer: {
          command: 'bun run test/bdd/server.ts',
          cwd: process.cwd(),
          url: `http://127.0.0.1:${port}/add`,
          reuseExistingServer: false,
        },
      }),
});
