export const themeStorageKey = 'workspace-admin-color-scheme';
export type ThemePreference = 'light' | 'dark' | 'auto';

export function readThemePreference(
  read: () => string | null
): ThemePreference {
  try {
    const value = read();
    if (value === 'light' || value === 'dark') return value;
  } catch {
    /* Storage can be blocked by browser privacy settings. */
  }
  return 'auto';
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark: boolean
) {
  return preference === 'auto' ? (prefersDark ? 'dark' : 'light') : preference;
}

export function initializeTheme() {
  const preference = readThemePreference(() =>
    window.localStorage.getItem(themeStorageKey)
  );
  document.documentElement.setAttribute(
    'data-mantine-color-scheme',
    resolveTheme(
      preference,
      window.matchMedia('(prefers-color-scheme: dark)').matches
    )
  );
}
