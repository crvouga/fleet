# Shared admin interface

`@pkgs/admin-ui` owns the visual foundation for custom administration tools:
React/Mantine provider, application shell, navigation, page headings, notices,
copy controls, and Light/Dark/System appearance. Relay and Fleet import these
components directly so changes reach both consoles. Portfolio and vendor-owned
consoles do not use this package.

The default appearance follows the operating system. An early, same-origin
script applies the saved `workspace-admin-color-scheme` preference before CSS
paints. Preferences synchronize between tabs on the same origin. Storage failure
falls back to System. Applications provide the CSP nonce in `meta[name=csp-nonce]`;
`prepareAdminUi` passes it to the scroll-lock helper and the provider passes it
to Mantine's generated styles.

The portable installer cannot require Node, a network connection, or a CDN.
Its standalone HTML components use `standalone.css` and `standalone-theme.js`.
Run `bun run --cwd packages/admin-ui sync` after changing them to refresh the
small first-party snapshots shipped in `packages/fleet/wizard`. Package tests
reject snapshot drift. Both PyInstaller and the native Nix launcher include
them. The setup tool embeds those same assets for its one-time browser flow.

Checks: `bun run --cwd packages/admin-ui tc`, `lint`, and `test`.
