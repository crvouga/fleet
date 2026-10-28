export interface BrowserFacts {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}
export interface PlatformHints {
  platform?: string;
  architecture?: string;
  bitness?: string;
  mobile?: boolean;
  wow64?: boolean;
}
function mobile(nav: BrowserFacts, hints: PlatformHints) {
  return (
    !!hints.mobile ||
    /Android|iPhone|iPad|iPod|CrOS/i.test(nav.userAgent) ||
    (/Mac/i.test(nav.platform) && nav.maxTouchPoints > 1)
  );
}
function osName(text: string) {
  if (/NixOS/i.test(text)) return 'nixos';
  if (/Windows|Win32|Win64/i.test(text)) return 'windows';
  if (/macOS|Macintosh|MacIntel/i.test(text)) return 'macos';
  if (/Linux/i.test(text)) return 'linux';
  return '';
}
function architecture(os: string, ua: string, hints: PlatformHints) {
  const architecture = hints.architecture ?? '';
  const arm =
    /^(arm64|aarch64)$/i.test(architecture) ||
    (architecture === 'arm' && hints.bitness === '64') ||
    /aarch64|arm64/i.test(ua);
  if (arm) return 'arm64';
  return x64Architecture(os, ua, hints);
}
function x64Architecture(os: string, ua: string, hints: PlatformHints) {
  const architecture = hints.architecture ?? '';
  const x64 =
    /^(x86_64|amd64)$/i.test(architecture) ||
    (architecture === 'x86' && (hints.bitness === '64' || !!hints.wow64));
  return x64 || (os !== 'macos' && /x86_64|amd64|Win64|WOW64|x64/i.test(ua))
    ? 'x64'
    : '';
}
export function detectedPlatform(
  nav: BrowserFacts,
  hints: PlatformHints = {}
): string {
  if (mobile(nav, hints)) return '';
  const ua = nav.userAgent + nav.platform;
  const os = osName(ua + (hints.platform ?? nav.platform));
  if (os === 'nixos') return 'nixos';
  if (hints.bitness === '32' && !hints.wow64) return '';
  const arch = architecture(os, ua, hints);
  if (!supported(os, arch)) return '';
  return `${os}-${arch}`;
}

function supported(os: string, arch: string) {
  return !!arch && !!os && (os !== 'windows' || arch === 'x64');
}
