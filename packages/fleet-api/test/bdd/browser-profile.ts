import type { Page } from '@playwright/test';
import type { Profile } from './profiles';

export async function emulateComputer(page: Page, profile: Profile) {
  await page.addInitScript((computer) => {
    Object.defineProperty(navigator, 'userAgent', { value: computer.ua });
    Object.defineProperty(navigator, 'platform', { value: computer.platform });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      value: computer.touch ?? 0,
    });
    const data = computer.hints
      ? {
          platform: computer.hints.platform,
          mobile: computer.hints.mobile ?? false,
          getHighEntropyValues: () => {
            if (computer.mode === 'reject')
              return Promise.reject(new Error('Unavailable'));
            if (computer.mode === 'never') return new Promise(() => {});
            return new Promise((resolve) => {
              setTimeout(
                () => {
                  document.documentElement.dataset['hintsReady'] = 'yes';
                  resolve(computer.hints);
                },
                computer.mode === 'slow' ? 600 : 0
              );
            });
          },
        }
      : undefined;
    Object.defineProperty(navigator, 'userAgentData', { value: data });
  }, profile);
}
