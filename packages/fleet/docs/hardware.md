# Hardware qualification notes

MINISFORUM advertises the Ryzen 9 9955HX with 16 cores/32 threads, Realtek RTL8125 and Intel I226-V 2.5-GbE, dual Intel X710 10-GbE SFP+, and up to 96-GiB DDR5. These are product specifications, not a claim that a delivered unit has been tested, and they are not a NixOS profile. Verify PCI IDs, NIC revision, firmware, RAM, disk slot, and thermals on the machine you install. Do not copy a disk path into git.

`modules/hardware/generic.nix` puts `r8169`, `igc`, and `i40e` in the initrd with NVMe, SATA, USB storage, and the other common NIC modules, and it enables both Intel and AMD microcode plus redistributable firmware. It does not pin a kernel, force `kvm-amd`, or install an out-of-tree Realtek driver. The NixOS default kernel is what boots. BIOS revisions and board watchdog exposure remain physical qualification tasks. No watchdog driver is forced without proof; systemd requests hardware watchdog use if a supported device exists. A NIC missing from that list is a change to the generic profile, not a new host file.

Sources inspected:

- [MINISFORUM MS-A2 product specifications](https://store.minisforum.com/en-os/products/minisforum-ms-a2-workstation).
- [Linux v6.12 r8169 PCI IDs and RTL8125 firmware](https://github.com/torvalds/linux/blob/v6.12/drivers/net/ethernet/realtek/r8169_main.c).
- [Linux v6.12 I226 IDs](https://github.com/torvalds/linux/blob/v6.12/drivers/net/ethernet/intel/igc/igc_hw.h).
- [Linux v6.12 i40e device IDs](https://github.com/torvalds/linux/blob/v6.12/drivers/net/ethernet/intel/i40e/i40e_devids.h).
- [NixOS runner options at the locked nixpkgs revision](https://github.com/NixOS/nixpkgs/blob/7c8764b7c7b09b34f632464276218ef9090eaa11/nixos/modules/services/continuous-integration/github-runner/options.nix).
- [NixOS runner service lifecycle at the locked revision](https://github.com/NixOS/nixpkgs/blob/7c8764b7c7b09b34f632464276218ef9090eaa11/nixos/modules/services/continuous-integration/github-runner/service.nix).
- [Runner environment-name support](https://github.com/actions/runner/blob/main/src/Runner.Listener/CommandSettings.cs) and [shutdown cancellation semantics](https://github.com/actions/runner/blob/main/src/Runner.Listener/JobDispatcher.cs).

Verify with `lspci -nnk`, `ethtool -i NIC`, `uname -r`, `journalctl -k`, and `/sys/class/watchdog/*/identity`. systemd asks the firmware watchdog for a 30-second timeout when a device exists. Confirm a generation that fails three boots falls through to the previous systemd-boot entry, and that iPXE `exit 1` returns to the disk instead of powering the board off. A board that does neither is a BIOS qualification failure. Test cold boots and sustained load with your projects before setting the repository URL that starts `fleet-sync`. No hardware burn-in or hard-hang recovery test was performed here.
