{ config, settings, ... }: let
  cache = settings.binaryCache;
  apiUrl = (settings.fleetApi or { }).url or "";
  present = value: value != null && value != "" && !(builtins.match ".*TODO.*" value != null);
  metadata = {
    version = 1;
    updateMode = "local";
    role = settings.role;
    inherit apiUrl;
    approvalMode = if apiUrl == "" then "local" else "managed";
    cacheUrl = cache.url;
    cachePublicKey = cache.publicKey;
    secretsFile = if settings.secretsFile == null then null else toString settings.secretsFile;
    requiredSecrets = builtins.attrNames config.sops.secrets;
    github = settings.github or null;
    # How the node authenticates to its Git source. For "ssh" or "token" the
    # installer requires the matching read credential at runtime (a flag, the
    # private handoff or a FLEET-KEY volume) and refuses before erasing without it.
    repoAuth = settings.repo.auth or "none";
    # The installer reads installBlocked of the base closure only (the single
    # `blocked` list in /fleet-readiness.json). Role-specific blockers apply to
    # the running node and are reported by it, never checked at install time.
    installBlocked = metadata.blocked;
    # With a fleet controller the GitHub App lives there and a node asks it for
    # registration tokens (modules/runners.nix): no per-machine App or secrets.
    blocked = (if settings.role == "ci" && apiUrl == "" && (settings.secretsFile == null || (settings.github.appId or "") == "") then [
      "FLEET_RUNNERS_UNCONFIGURED: configure your GitHub App, repositories and encrypted role credentials before installing a CI node."
    ] else [ ]) ++ (if present settings.repo.url then [ ] else [
      "FLEET_REPOSITORY_UNCONFIGURED: the Git source for automatic updates is not configured."
    ]);
  };
in {
  # Public configuration only. Role secrets stay encrypted to the nodes Fleet
  # assigned the role; the node checks them, not the installer.
  environment.etc."fleet/bootstrap.json".text = builtins.toJSON metadata;
}
