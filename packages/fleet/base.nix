# The role-less system every machine installs. The fleet controller assigns a
# role after installation and the node converges to that role's closure (see
# ARCHITECTURE.md). Not a per-machine file and never a registry role.
let shared = import ./settings/shared.nix;
in {
  role = "base";
  flakeAttr = "base";
  inherit (shared) sshKeys bootGenerationLimit bootTries repo binaryCache reboot capacity drift disk monitoring fleetApi;
  # base decrypts nothing. Each role's own file is encrypted to the nodes the
  # controller assigned it.
  secretsFile = null;
}
