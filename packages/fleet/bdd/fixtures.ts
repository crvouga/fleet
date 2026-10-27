import type { Page, TestInfo } from '@playwright/test';
import { createBdd, test as base } from 'playwright-bdd';
import type { Wizard } from './wizard';

export interface World {
  info: TestInfo;
  cleanup: (() => Promise<void>)[];
  wizard?: Wizard;
  setupUrl?: string;
  setupManifest?: unknown;
  github?: Page;
  releasePage?: Page;
  downloadPath?: string;
  downloadStatus?: number;
  registrationStatus?: number;
  installationToken?: string;
  command?: { code: number; text: string };
  role?: string;
}

export function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('The preceding scenario step did not provide its result');
  return value;
}

export const test = base.extend<{ world: World }>({
  world: async ({}, runScenario, info) => {
    const world: World = { cleanup: [], info };
    try {
      await runScenario(world);
    } finally {
      for (const cleanup of world.cleanup.reverse()) await cleanup();
    }
  },
});

export const { Given, When, Then } = createBdd(test);
