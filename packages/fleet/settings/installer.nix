# Live installer settings. The ISO and the PXE image share this file.
# Role age keys are generated on the machine by fleet-install. They are not baked in.
{
  sshKeys = (import ./shared.nix).sshKeys;
}
