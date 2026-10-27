{ lib, ... }: {
  # aarch64 is a later architecture variant of these same roles, not a
  # per-machine file and not a board profile. Do not add it here yet.
  #
  # One kernel, the NixOS default. A missing NIC or disk module is added to
  # this list. It is not a reason to add a host file. Both kvm modules are
  # not force-loaded: the wrong one fails on the other CPU, and kvm autoloads.
  boot.initrd.availableKernelModules = [
    "nvme"
    "ahci"
    "sd_mod"
    "usb_storage"
    "uas"
    "xhci_pci"
    "ehci_pci"
    "usbhid"
    "virtio_pci"
    "virtio_blk"
    "virtio_scsi"
    "virtio_net"
    "e1000"
    "e1000e"
    "r8169"
    "igc"
    "igb"
    "ixgbe"
    "i40e"
  ];
  hardware.cpu.intel.updateMicrocode = lib.mkDefault true;
  hardware.cpu.amd.updateMicrocode = lib.mkDefault true;
  hardware.enableRedistributableFirmware = true;
  boot.loader.grub.enable = lib.mkDefault false;
  boot.loader.efi.canTouchEfiVariables = true;
  networking.useNetworkd = true;
  networking.useDHCP = false;
  networking.dhcpcd.setHostname = false;
  systemd.network = {
    wait-online.anyInterface = true;
    networks."40-wired" = {
      matchConfig.Type = "ether";
      networkConfig.DHCP = "yes";
      dhcpV4Config.UseHostname = false;
      dhcpV6Config.UseHostname = false;
    };
  };
}
