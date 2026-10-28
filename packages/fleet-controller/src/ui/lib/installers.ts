export const INSTALLER_RELEASE = '/installers/release';
export const WINDOWS_DOWNLOAD_GUIDE = '/installers/windows-guide';
const DOWNLOAD = '/installers/download/';

export const INSTALLERS = [
  {
    id: 'windows-x64',
    label: 'Windows — x64',
    file: 'fleet-installer-windows-x64.exe',
  },
  {
    id: 'macos-arm64',
    label: 'macOS — Apple silicon (ARM64)',
    file: 'fleet-installer-macos-arm64.zip',
  },
  {
    id: 'macos-x64',
    label: 'macOS — Intel (x64)',
    file: 'fleet-installer-macos-x64.zip',
  },
  {
    id: 'linux-x64',
    label: 'Linux — x64',
    file: 'fleet-installer-linux-x64.tar.gz',
  },
  {
    id: 'linux-arm64',
    label: 'Linux — ARM64',
    file: 'fleet-installer-linux-arm64.tar.gz',
  },
] as const;

export function installerUrl(file: string): string {
  return DOWNLOAD + file;
}
