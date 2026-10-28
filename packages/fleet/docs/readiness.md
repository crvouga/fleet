# Deployment readiness

Readiness belongs to each operator deployment. Results from another fleet,
repository, host, or historical infrastructure are not proof that yours works.
Fleet does not include cloud provisioning, a Vault/OpenBao deployment, a GitHub
App, DNS, an identity provider, or credentials.

Before publishing an installer:

- Use Bun 1.4.4 and `bun install --frozen-lockfile`, then run `bun run check`.
- On x86_64 Linux with Nix and KVM, run `bun run check:nix`. Other platforms
  cannot establish Linux build or VM acceptance.
- Configure your Git update source in `settings/shared.nix`, or use the
  [operator deployment flake](../../../examples/deployment/flake.nix). Commit
  the deployment's `flake.lock`. The default source is deliberately unconfigured;
  installation is blocked until you provide it.
- Set your emergency SSH public keys. For CI, configure your GitHub App,
  repositories, and encrypted role credentials. Each role needs its own age key.
- Build the installer from that exact configured revision. Publish the image,
  matching checksums, readiness sidecar, and parts with `scripts/release-image.py`.
  Set `FLEET_CONTROLLER_URL` on installer clients to your Fleet app;
  use `FLEET_INSTALLER_URL` for an image hosted elsewhere.
- If using the optional controller, follow [CONFIGURATION.md](../../../CONFIGURATION.md),
  validate startup, browser sign-in, owner-managed access, and node approval.
- If using shared-key enrollment, configure your own Vault/OpenBao, role documents,
  wrapping policy and your operator-owned trust configuration.
  A standalone role without shared encrypted secrets can use `--no-enroll`.

Before relying on a physical node:

- Back up data and recovery keys. Obtain explicit human approval identifying the
  disk before installation. CI and VM success never authorize physical erasure.
- Qualify firmware, network and installed Wi-Fi on a backed-up spare. Windows
  conversion needs x86_64 UEFI/GPT and Secure Boot off. macOS/ARM supports media
  creation, not unattended conversion into an ARM NixOS node.
- Check installed role, revision, service health and SSH host-key fingerprints
  from the local console. For managed nodes, require approved fresh heartbeats.
- For CI, require actual online GitHub runner registrations and a successful
  trusted project job. Follow [project onboarding](onboard-project.md); downloaded
  Ubuntu tools and browsers are not automatically compatible with NixOS.
- Verify a reboot preserves access, a Git pull update succeeds, a failed update
  leaves the current system running, and rollback works. Updates use upstream
  Nix substitutes and local builds; a private cache is optional.
- For the controller, verify recovery into a disposable replacement from your
  own S3 replica. Stop the current writer first; replication can lose recent
  unreplicated writes on abrupt host loss.

Keep deployment evidence with the operator's infrastructure. Record the exact
source revision, configuration, platform, checks run, and remaining failures.
Never substitute fixture results for live acceptance or claim reproducible
byte-for-byte signed executables without comparing actual artifacts.
