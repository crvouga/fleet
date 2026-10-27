# CI role settings, never per-host configuration or plaintext credentials.
let shared = import ./settings/shared.nix;
in {
  role = "ci";
  flakeAttr = "ci";
  inherit (shared) sshKeys bootGenerationLimit bootTries repo binaryCache capacity drift disk monitoring fleetApi;
  # Set true only in the commit that adds the sops secret age-key-next.
  rotateAgeKey = false;
  reboot = shared.reboot // { drainCommand = "fleet-drain"; resumeCommand = "fleet-resume"; };
  # One data file for bootstrap registration. Runtime repository assignments
  # can override this through the fleet API's Postgres-backed settings.
  github = builtins.fromJSON (builtins.readFile ./settings/github.json);
  containers = false; # opt into rootless per-slot Podman and its Docker-compatible socket
  secretsFile = null; # Set to your own SOPS file after setup.
  cache = {
    maxGiB = 100;
    minFreeGiB = 30;
    # Optional CI scratch store. The shared update cache is binaryCache.
    remote = {
      enable = false;
      url = "s3://TODO?endpoint=TODO&region=auto";
      publicKey = "TODO";
    };
  };
}
