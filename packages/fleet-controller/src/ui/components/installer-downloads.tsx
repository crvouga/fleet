import {
  INSTALLERS,
  INSTALLER_RELEASE,
  WINDOWS_DOWNLOAD_GUIDE,
  installerUrl,
} from '../lib/installers';

function InstallerChoices() {
  return (
    <div data-installer-controls hidden class="mt-3">
      <label for="installer-platform" class="block text-sm font-medium">
        Installer for
      </label>
      <select
        id="installer-platform"
        class="mt-1 w-full rounded-lg border border-line bg-surface p-2 text-sm"
      >
        <option value="">Auto-detect this computer</option>
        {INSTALLERS.map((installer) => (
          <option
            key={installer.id}
            value={installer.id}
            data-url={installerUrl(installer.file)}
          >
            {installer.label}
          </option>
        ))}
        <option value="nixos" data-url="#nixos-install">
          NixOS — native installer
        </option>
      </select>
      <p class="mt-1 text-sm text-fg-2">
        Change this when preparing an installer for another computer. Using
        NixOS? Select its native installer.
      </p>
    </div>
  );
}

function AllInstallers() {
  return (
    <details class="mt-3 text-sm">
      <summary class="cursor-pointer font-medium">All installers</summary>
      <ul class="mt-2 grid gap-2 sm:grid-cols-2">
        {INSTALLERS.map((installer) => (
          <li key={installer.id}>
            <a href={installerUrl(installer.file)}>{installer.label}</a>
          </li>
        ))}
        <li>
          <a href="#nixos-install" data-installer-nixos>
            NixOS — native installer
          </a>
        </li>
      </ul>
    </details>
  );
}

/** Complete download choices without JS; browser detection adds a primary link. */
export function InstallerDownloads() {
  return (
    <div id="installer-downloads" class="mt-6 rounded-lg bg-muted p-4">
      <p
        data-installer-status
        role="status"
        aria-live="polite"
        class="text-sm text-fg-2"
      >
        Choose the installer for the computer running it from All installers
        below.
      </p>
      <a data-installer-recommended hidden class="btn btn-primary mt-3">
        Download recommended installer
      </a>
      <details class="mt-3 text-sm">
        <summary class="cursor-pointer font-medium">
          Windows: Edge blocks the download
        </summary>
        <p class="mt-2 text-fg-2">
          “Isn’t commonly downloaded” is a Microsoft SmartScreen reputation
          warning. New or unsigned releases may trigger it. Compare the
          download’s SHA-256 with the release before opening it. Keep Windows
          protection enabled; organization policy may prevent running it. You
          can prepare installer USB media on another permitted computer.
        </p>
        <a href={WINDOWS_DOWNLOAD_GUIDE}>
          Windows download and verification guide
        </a>
      </details>
      <InstallerChoices />
      <AllInstallers />
      <a
        class="mt-3 inline-block text-sm"
        href={INSTALLER_RELEASE}
        rel="noopener noreferrer"
        target="_blank"
      >
        Open the installer release
      </a>
    </div>
  );
}
