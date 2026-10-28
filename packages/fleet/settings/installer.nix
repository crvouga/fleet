# Live installer settings. The ISO and the PXE image share this file.
# The installer installs the role-less base system; nodes create their own age
# identity on first boot, so no key is baked in.
{
  sshKeys = (import ./shared.nix).sshKeys;
}
