interface Hints {
  platform: string;
  architecture?: string;
  bitness?: string;
  wow64?: boolean;
  mobile?: boolean;
}

export interface Profile {
  ua: string;
  platform: string;
  hints?: Hints;
  touch?: number;
  mode?: 'reject' | 'slow' | 'never';
}

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

export const PROFILES: Record<string, Profile> = {
  'Windows x64': {
    ua: WINDOWS,
    platform: 'Win32',
    hints: { platform: 'Windows', architecture: 'x86', bitness: '64' },
  },
  'Windows WOW64': {
    ua: WINDOWS,
    platform: 'Win32',
    hints: {
      platform: 'Windows',
      architecture: 'x86',
      bitness: '32',
      wow64: true,
    },
  },
  'Windows ARM64': {
    ua: WINDOWS,
    platform: 'Win32',
    hints: { platform: 'Windows', architecture: 'arm', bitness: '64' },
  },
  'Windows 32-bit': {
    ua: WINDOWS,
    platform: 'Win32',
    hints: { platform: 'Windows', architecture: 'x86', bitness: '32' },
  },
  'Mac Apple silicon': {
    ua: MAC,
    platform: 'MacIntel',
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64' },
  },
  'Mac Intel': {
    ua: MAC,
    platform: 'MacIntel',
    hints: { platform: 'macOS', architecture: 'x86', bitness: '64' },
  },
  'Mac hidden chip': { ua: MAC, platform: 'MacIntel' },
  'Mac denied hints': {
    ua: MAC,
    platform: 'MacIntel',
    hints: { platform: 'macOS' },
    mode: 'reject',
  },
  'Mac slow hints': {
    ua: MAC,
    platform: 'MacIntel',
    hints: { platform: 'macOS', architecture: 'arm', bitness: '64' },
    mode: 'slow',
  },
  'Mac stuck hints': {
    ua: MAC,
    platform: 'MacIntel',
    hints: { platform: 'macOS' },
    mode: 'never',
  },
  'Linux x64': {
    ua: 'Mozilla/5.0 (X11; Linux x86_64)',
    platform: 'Linux x86_64',
  },
  'Linux ARM64': {
    ua: 'Mozilla/5.0 (X11; Linux aarch64)',
    platform: 'Linux aarch64',
  },
  'Linux unknown': { ua: 'Mozilla/5.0 (X11; Linux)', platform: 'Linux' },
  NixOS: {
    ua: 'Mozilla/5.0 (X11; NixOS; Linux x86_64)',
    platform: 'Linux x86_64',
  },
  iPhone: {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    platform: 'iPhone',
    touch: 5,
  },
  'iPad desktop': { ua: MAC, platform: 'MacIntel', touch: 5 },
  Android: {
    ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    platform: 'Linux aarch64',
    hints: {
      platform: 'Android',
      architecture: 'arm',
      bitness: '64',
      mobile: true,
    },
  },
  ChromeOS: {
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 16093.0.0)',
    platform: 'Linux x86_64',
  },
  Unknown: { ua: 'Private browser', platform: '' },
};
