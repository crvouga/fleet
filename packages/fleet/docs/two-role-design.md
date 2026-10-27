# Roles and deployment boundaries

Fleet ships two active roles: CI runner and development box. Hardware capability
variants compose with roles; individual machines never require host files.
`roles.json` is the registry for role state, settings, secrets and closures.
Run `bun run roles:sync` after changing it.

CI runner credentials are separate from developer sessions and browser state.
CI nodes run trusted private repository jobs in ephemeral slots; development
boxes expose an unprivileged SSH account and persistent project directories.
Both roles share Git pull updates, safe reboot handling and rollback.

Retired role names remain in the registry for compatibility with existing
node records and operator-owned secrets. They cannot be installed or updated
as active roles. Removing a retired name requires reviewing persistent data
and secret mappings in each consuming deployment first.

The optional management API provides data and configuration, never remote code.
Without an API, local-mode installations still validate role closures and any
required secrets before disk work. Configured managed installations retain
remote approval and never fall back to local approval after an API failure.

Cloud infrastructure and runtime hosting are entirely operator supplied. Fleet
contains no provider inventory, cloud reconciliation, deployment credentials or
provisioning controller.
