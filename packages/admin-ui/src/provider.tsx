/** @jsxImportSource react */
import {
  createTheme,
  localStorageColorSchemeManager,
  MantineProvider,
} from '@mantine/core';
import { setNonce } from 'get-nonce';
import type { ReactNode } from 'react';
import '@mantine/core/styles.css';
import './style.css';
import { themeStorageKey } from './theme';

const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  respectReducedMotion: true,
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '700',
  },
  components: {
    Button: { defaultProps: { fw: 600 } },
    Paper: { defaultProps: { radius: 'md' } },
  },
});
const manager = localStorageColorSchemeManager({ key: themeStorageKey });
function nonce() {
  return typeof document === 'undefined'
    ? ''
    : (document
        .querySelector('meta[name="csp-nonce"]')
        ?.getAttribute('content') ?? '');
}
export function prepareAdminUi() {
  setNonce(nonce());
}
export function AdminProvider({ children }: { children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      defaultColorScheme="auto"
      colorSchemeManager={manager}
      getStyleNonce={nonce}
      cssVariablesResolver={() => ({
        variables: {},
        light: { '--mantine-color-dimmed': '#626c78' },
        dark: { '--mantine-color-dimmed': '#a6a7ab' },
      })}
    >
      {children}
    </MantineProvider>
  );
}
