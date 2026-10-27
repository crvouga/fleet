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
    installBlocked = metadata.blocked;
    blocked = (if settings.role == "ci" && (settings.secretsFile == null || (settings.github.appId or "") == "") then [
      "FLEET_RUNNERS_UNCONFIGURED: configure your GitHub App, repositories and encrypted role credentials before installing a CI node."
    ] else [ ]) ++ (if present settings.repo.url then [ ] else [
      "FLEET_REPOSITORY_UNCONFIGURED: the Git source for automatic updates is not configured."
    ]);
  };
in {
  # Public configuration only. Credentials remain in the wrapped document and
  # role-encrypted secrets; both are checked privately before disk erasure.
  environment.etc."fleet/bootstrap.json".text = builtins.toJSON metadata;
}
