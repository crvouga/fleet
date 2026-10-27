# Remote development role. No runner credentials, units, or per-machine files.
let shared = import ./settings/shared.nix;
in {
  role = "devbox";
  flakeAttr = "devbox";
  inherit (shared) sshKeys bootGenerationLimit bootTries repo binaryCache reboot capacity drift disk monitoring fleetApi;
  rotateAgeKey = false;
  # This role has its own recipient. Never reuse secrets/fleet.yaml.
  secretsFile = null;
}
