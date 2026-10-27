{ lib, ... }: let
  # The boot menu lists exactly the installer closures in roles.json.
  roles = import ../roles.nix { inherit lib; };
  default = roles.installerDefault;
in {
  # make-iso9660-image writes $out/iso/${image.baseName}.iso. image.fileName
  # only sets image.filePath, so the built file stayed nixos-<label>-<system>.iso
  # and the Fleet upload found nothing at iso/fleet-installer.iso.
  image.baseName = lib.mkForce "fleet-installer";
  image.fileName = "fleet-installer.iso";
  # Level 19 spends minutes recompressing every offline role on each commit.
  # Keep the same zstd filesystem format with a faster compression level.
  isoImage.squashfsCompression = "zstd -Xcompression-level 3";
  isoImage.makeEfiBootable = true;
  isoImage.makeUsbBootable = true;
  # The shell initrd honors findiso= and copytoram. systemd in the initrd
  # mounts the ISO by label only, so a file on the existing disk cannot boot it.
  boot.initrd.systemd.enable = false;
  # Wait for a deliberate selection: booting a forgotten USB must not turn a
  # computer into a CI runner. UEFI GRUB treats null as an infinite timeout.
  # Legacy BIOS is refused by fleet-install before any disk is touched.
  # iso-image.nix sets this to 10 at the same priority.
  boot.loader.timeout = lib.mkForce null;
  boot.kernelParams = [ "fleet.role=${default}" ];
  isoImage.appendToMenuLabel = lib.mkForce "";
  isoImage.configurationName = "${default} - ERASES internal disk";
  specialisation = lib.genAttrs (builtins.filter (role: role != default) roles.installer) (role: {
    configuration = {
      isoImage.configurationName = lib.mkForce "${role} - ERASES internal disk";
      boot.kernelParams = [ "fleet.role=${role}" ];
    };
  });
}
