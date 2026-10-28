# Roles and deployment boundaries

Fleet ships two active roles: CI runner and development box. Hardware capability
variants compose with roles; individual machines never require host files.
`roles.json` is the registry for role state, settings, secrets and closures.
Run `bun run roles:sync` after changing it.

A role is never chosen at installation. Every machine installs the role-less
`base` closure; the fleet controller assigns the role, picks the closure from
the node's reported hardware (`ci-gpu` on NVIDIA hardware) and the node
converges to it. See [ARCHITECTURE.md](../../../ARCHITECTURE.md).

CI runner credentials are separate from developer sessions and browser state.
CI nodes run trusted private repository jobs in ephemeral slots; development
boxes expose an unprivileged SSH account and project directories that survive
reboots as a cache.
Both roles share Git pull updates, safe reboot handling and rollback. Each
role's SOPS file is encrypted only to the nodes assigned that role.

Moving a node between roles is a drained, health-checked reboot into the other
closure, not a reinstall. Nodes are stateless: at the first boot of the new
role `fleet-node-state` wipes every cache the previous role left on `/nix`
(workspaces, CI caches and job records, anything undeclared) and keeps only
the node's identity (`scripts/node_state.py`). No role sees another's data.

Retired role names remain in the registry for compatibility with existing
node records and operator-owned secrets. They cannot be assigned or converged
to. Removing a retired name requires reviewing persistent data and secret
mappings in each consuming deployment first.

The management controller provides data and assignment, never remote code.
Without a controller, local-mode nodes take their target from `fleet-target`
at the console. Configured managed installations retain remote approval and
never fall back to local approval after a controller failure.

Cloud infrastructure and runtime hosting are entirely operator supplied. Fleet
contains no provider inventory, cloud reconciliation, deployment credentials or
provisioning controller.
