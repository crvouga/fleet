{ config, lib, ... }: {
  # One layout for every role. The device is a symlink created at install
  # time. This disko pin has no filesystem label option, so mkfs gets the
  # label and NixOS mounts the label when disko actually installs.
  disko.devices = {
    disk.internal = {
      type = "disk";
      device = "/dev/fleet-install-disk";
      content = { type = "gpt"; partitions = {
        ESP = { size = "1G"; type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
            extraArgs = [ "-n" "SHBOOT" ];
          }; };
        nix = { size = "100%";
          content = {
            type = "filesystem";
            format = "ext4";
            mountpoint = "/nix";
            extraArgs = [ "-L" "sh-nix" ];
          }; };
      }; };
    };
    nodev."/" = { fsType = "tmpfs"; mountOptions = [ "size=50%" "mode=755" ]; };
  };
  fileSystems = lib.mkIf config.disko.enableConfig {
    "/boot".device = lib.mkForce "/dev/disk/by-label/SHBOOT";
    "/nix".device = lib.mkForce "/dev/disk/by-label/sh-nix";
  };
  assertions = [{
    assertion = config.disko.devices.disk.internal.device == "/dev/fleet-install-disk";
    message = "The install disk is the runtime sentinel. Do not set a machine path.";
  }];
}
