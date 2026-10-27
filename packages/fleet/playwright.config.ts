import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'bdd/features/*.feature',
  steps: ['bdd/fixtures.ts', 'bdd/steps/*.ts'],
  outputDir: 'dist/bdd-generated',
});

export default defineConfig({
  testDir,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 4,
  retries: 0,
  outputDir: process.env['FLEET_BDD_OUTPUT_DIR'] ?? 'dist/bdd-results',
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder:
          process.env['PLAYWRIGHT_HTML_OUTPUT_DIR'] ?? 'dist/bdd-report',
        open: 'never',
      },
    ],
    [
      'json',
      {
        outputFile:
          process.env['PLAYWRIGHT_JSON_OUTPUT_FILE'] ?? 'dist/bdd-results.json',
      },
    ],
  ],
  use: { ...devices['Desktop Chrome'], screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'local',
      fullyParallel: true,
      grep: /@local/,
      ...(process.platform === 'win32' ? { grepInvert: /@posix/ } : {}),
      use: { trace: 'retain-on-failure' },
    },
    // Live authentication must never be written into a trace or video.
    {
      name: 'live',
      workers: 1,
      grep: /@live/,
      use: { trace: 'off', video: 'off' },
    },
  ],
});
