/** NixOS needs its native launcher rather than the foreign Linux executable. */
export function NixosInstall() {
  return (
    <details id="nixos-install" class="mt-6 rounded-lg bg-muted p-4 text-sm">
      <summary class="cursor-pointer font-medium">
        Installing or reinstalling NixOS?
      </summary>
      <p class="mt-2 text-fg-2">
        Run the native installer in a terminal, then open the local address it
        prints:
      </p>
      <a href="/installers/nixos">Show the native installer command</a>
      <p class="mt-2 text-fg-2">
        On an existing fleet node, choose its current role and select Hard
        reinstall to replace it. Disk confirmation is required and running CI
        jobs block reinstallation.
      </p>
      <a class="mt-2 inline-block" href="/installers/nixos-guide">
        NixOS installation and hard reinstall guide
      </a>
    </details>
  );
}
