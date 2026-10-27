import { expect, test } from 'bun:test';
import { readThemePreference, resolveTheme } from './theme';
test('explicit and system appearance handle unavailable storage safely', () => {
  expect(readThemePreference(() => 'dark')).toBe('dark');
  expect(
    readThemePreference(() => {
      throw new Error('Blocked');
    })
  ).toBe('auto');
  expect(resolveTheme('auto', true)).toBe('dark');
  expect(resolveTheme('light', true)).toBe('light');
});
test('offline installer design assets match the canonical library', async () => {
  for (const [source, snapshot] of [
    ['standalone.css', 'admin.css'],
    ['standalone-theme.js', 'theme.js'],
  ]) {
    expect(await Bun.file(new URL(`./${source}`, import.meta.url)).text()).toBe(
      await Bun.file(
        new URL(`../../fleet/wizard/${snapshot}`, import.meta.url)
      ).text()
    );
  }
});
