# Steps that stay manual

For the normal installation, use the [wizard](installer.md): open it and confirm
the exact disk. The installer only sets up the node; you assign its role in
the Fleet app afterwards. It performs its checks and available
preparation automatically. The CLI commands below are an alternative for
agents, headless machines and troubleshooting; they are not extra steps for
someone already using the wizard.

After a node has booted, the only manual tasks are physical: replace hardware, clean it, and the one-time BIOS setup below. A step that seems to need a person at a running node is a bug. Fix it in code. SSH is read-only emergency access. No changes are ever made over SSH.

These bring-up steps happen once, before the node is polling `main`. They are not how a running node is changed.

Complete the [readiness gates](readiness.md) before using this checklist. A
successful install alone does not prove role assignment, runner registration,
monitoring or cached updates work.

1. Connect power and provide Wi-Fi settings through the installer, or connect Ethernet. Saved personal Wi-Fi is carried over automatically when the source OS permits it. Do not record a name or a MAC into git. Another machine is another install, not a host file.
2. Firmware, once: disable Secure Boot. lanzaboote is not wired up; it is a later option if Secure Boot has to stay on. On a machine that runs Windows, `shutdown /r /fw` opens the firmware screen; the installer's check names this when Secure Boot is on. Enable UEFI USB boot and network boot. Set the boot order to network, then the internal disk. Enable power-on after AC loss when the firmware offers it. Do not change this order per machine later. A reinstall flag in git does not install a node: the netboot host does not serve an image that can finish an install.
3. On the machine itself, download one file and run it. Nix, a git checkout, `just`, and a second computer are not required.

   ```sh
   curl -fsSL -o fleet-node.sh "$FLEET_CONTROLLER_URL/installers/assets/fleet-node.sh"
   bash fleet-node.sh
   ```

   For no prompts at all: `bash fleet-node.sh install --yes`. `--yes` takes the confirmation line as typed; it is not consent, and a USB, removable, hotplug, or ambiguous disk is still refused. Save the file first; piping it into `bash` is not supported. The program names the internal disk. Nothing is erased until you type the line it shows (`install: <disk>`). Do not pass a role; the program refuses one. An empty answer, a wrong line, a timeout, or a USB, removable, hotplug, or ambiguous disk leaves every disk unchanged and prints one next step. A mounted internal disk is allowed when converting the running OS; the RAM installer rechecks the disk before wiping. Run the same command again after a failure or after a finished install. A finished install is not wiped a second time; `--reinstall` erases it deliberately. Do not add a host file, a MAC, a disk path, or a hostname.

   An agent can do this step: `Set this machine up as a fleet node by following the embedded runbook from `bash fleet-node.sh guide``. `sudo bash fleet-node.sh doctor` shows the disk and any blocker first and writes nothing.

4. Approve the computer under **Pending** in your Fleet app, then assign its role there. The live installer registers directly, with no role, and waits up to five minutes before disk changes; rejection or timeout erases nothing. An optional enrollment token (`--token-file`) lets Fleet approve it without a person. No GitHub issue or workflow is involved.
5. A machine with no operating system cannot download. On a computer that already has one, use the wizard or run `bash fleet-node.sh flash` and boot that USB disk from the firmware one-time menu. `flash` refuses an internal disk. The menu has one entry, **Fleet node - ERASES internal disk**; press Enter. For approval without a person, put the token in `enrollment.token` on a separate volume labelled `FLEET-KEY` and plug it in before booting.
6. If the firmware would boot the stick again, pull it when the console says the install finished. The lasting boot order stays network, then the internal disk. The console prints the node's age public key and `ssh-keygen -lf` of `/nix/fleet-state/ssh/ssh_host_ed25519_key.pub`. The node creates that age key itself and reports it to Fleet; the operator adds it to the role's SOPS recipients (`just fleet-keys`) after the role is assigned. `sshKeys` in `settings/shared.nix` stays empty until remote read-only access is wanted. The hostname is `<role>[-gpu][-highmem]-<4 hex>` from the running role and the hardware id.
7. Configure your own repository protections and required checks through your operator workflow. Fleet does not provision or change GitHub settings.

The private cloud cache is retired. Automatic updates build missing closures
locally with upstream Nix substitutes; no private publisher is required.
For a public deployment repository, `repo.auth = "none"` is valid. A private
repository requires a read credential encrypted separately for each role's
secrets file.
