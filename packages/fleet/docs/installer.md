# Fleet installer (the wizard)

Download it, open it, choose what to do and confirm the disk. Accept the
operating system's permission prompt. After the live installer starts, approve
the computer under Pending in your Fleet app. Preparation, downloads, verification and installation
then run automatically. The installer only sets up the node: every machine
installs the same `base` system. Assign its role in the Fleet app afterwards. No separate doctor command or manual setup checklist
is required. Windows, macOS and ordinary Linux need no Python or Nix installation.
On an existing fleet node, run `fleet-installer`; on other NixOS machines, use
the native launcher below.

**Before confirming an internal disk:** back up the files you want to keep to
another device, save any BitLocker recovery key there, and connect power and
a working Wi-Fi or Ethernet network. Installation erases the whole disk. A USB operation erases only
the USB disk you review; booting it on a target later erases that target's disk.

## Wi-Fi installation

Wi-Fi works through the download, reboot into the live installer, and the
installed node. The launcher carries the currently connected personal Wi-Fi
profile from Windows or NetworkManager on Linux. A macOS USB creator can read
its saved network from the system Keychain when macOS permits access. If the
OS cannot release a reusable password, expand **Use a different Wi-Fi network**
and enter the network once. This also selects a different target network, a
hidden SSID, or WPA3 Personal. The default remains automatic detection.

The privileged helper reads the saved password; it is never returned by the
plan API, logged, put in shell arguments, or added to a kernel command line or
the Nix store. In-place conversion uses a private supplemental initramfs. USB
creation writes a checksummed, read-back-verified Wi-Fi handoff outside the ISO
filesystem. **Keep a prepared USB private: it contains a reusable network
password.** Creating a new USB without Wi-Fi settings clears an old handoff.

The live installer connects and checks DNS/TLS before consuming an enrollment
token or erasing the internal disk. Internet that already works is used as it
is: a network cable, a phone's USB tethering, or a network chosen at the console
with `fleet-wifi` (the installed node then keeps that network). Otherwise it
waits for the Wi-Fi adapter, turns its radio on, scans, and connects the carried
profile. If the network in range suggests it, it also tries WPA2 for a profile Windows
recorded as WPA3 (or the other way round), or a hidden network. Every
check, the adapter and its driver, the scan and NetworkManager's reason for each
failed attempt go to `/run/fleet-live/network.json`, which the screen and the
problem report read. The report leaves out the network name. A temporary outage makes it wait and retry
automatically. Disk/install failures are not retried automatically. The profile
is stored root-only under `/nix/fleet-state/network`, restored before
NetworkManager starts on every boot, and reconnects automatically when the
access point returns. It is not bound to an interface name or MAC address.
Wired networking remains available as a fallback.

Supported automatic networks use DHCP and open, WPA/WPA2 Personal, or WPA3
Personal authentication. Enterprise/802.1X certificates, WEP, captive portals,
and adapters without a driver/firmware in the pinned Linux system are not
silently guessed or treated as working. A Wi-Fi-only install waits before
wiping if it cannot connect. A Wi-Fi network/password cannot be invented when
neither the source OS nor the person supplies it. PXE firmware/network boot
remains a wired facility; USB and in-place installation support Wi-Fi.

Software tests cover transfer, credential privacy, corruption, readiness and
reboot preparation. The `wifi-vm` check uses simulated radios with real
NetworkManager, hostapd and DHCP/DNS to exercise connection, AP loss and reboot.
This does not certify a particular physical Wi-Fi adapter or Windows firmware.

## What happens automatically

| Platform                           | The installer handles                                                                                                            | What still needs a person                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Windows x64                        | Hardware/storage checks, one free-space consolidation attempt if needed, verified image, boot setup, restart, NixOS installation | OS permission, Fleet app approval, disk confirmation; Secure Boot off if enabled                      |
| Linux x64                          | Checks, missing `kexec-tools` installation through apt/dnf/zypper/pacman, verified image, kexec, NixOS installation              | OS permission, Fleet app approval, disk confirmation; unsupported filesystems or firmware require USB |
| NixOS x64                          | Native dependencies are bundled; checks, verified image, kexec and installation                                                  | OS permission, Fleet app approval and disk confirmation                                               |
| macOS, Linux ARM64 and NixOS ARM64 | USB discovery, image download, unmounting, writing and read-back verification                                                    | Disk confirmation and OS permission; move the USB to a supported x64 target and boot it there         |

All platforms retry transient network failures up to three attempts. Reloading
the page reconnects to the existing job. It does not start another write or
reuse an erase confirmation. The only USB is preselected, but its identity must
still be reviewed and confirmed. Failed hard checks, checksum mismatches and
failed writes are never bypassed or retried as destructive operations.

Firmware changes, connecting cables, choosing a backup destination, unsigned-app
approval and booting another computer from USB cannot be performed silently by
this installer. It shows only the relevant problems. The current image supports
x86-64 UEFI targets; Apple silicon and ARM boards make media for other machines.
USB media carries no enrollment token. A person approves the computer in the
Fleet app, or you can add an optional token on a separate volume (see
[Enrollment token](#enrollment-token)).

## 1. Download

Open **Add node → Open the installer release** in your Fleet app and take the file for the computer you are sitting at:

| Computer                 | File                                 |
| ------------------------ | ------------------------------------ |
| Windows (Intel/AMD)      | `fleet-installer-windows-x64.exe`    |
| Mac with Apple silicon   | `fleet-installer-macos-arm64.zip`    |
| Mac with an Intel chip   | `fleet-installer-macos-x64.zip`      |
| Linux (Intel/AMD)        | `fleet-installer-linux-x64.tar.gz`   |
| Linux (ARM, e.g. a Pi 5) | `fleet-installer-linux-arm64.tar.gz` |
| NixOS (x86-64 or ARM64)  | Native Nix command below             |

The computer you run it on does not have to be the computer that becomes the node. To set up a new or blank machine, run the wizard on any other computer and make an install USB.

The wizard downloads the image as verified parts and assembles one ISO locally.
Parts support resumable downloads of the offline image. Do
not write a `.part-*` file to a USB disk; let the wizard finish the download and
verification first.

## 2. Open it

New packaged builds include a public CA bundle in addition to the operating
system's trusted roots. Each packaged build must verify HTTPS against the configured Fleet endpoint or an explicitly selected TLS test origin before publication. A certificate failure stops the
download; verification is never disabled. If an older build reports
`CERTIFICATE_VERIFY_FAILED` / `unable to get local issuer certificate`, download
the latest installer. If it persists, check Windows Update, the computer's clock
and any organization-managed HTTPS inspection. This is separate from publisher
signing and SmartScreen reputation.

Windows release publication requires the verified publisher configuration in
[signing operations](windows-signing.md); local Windows builds and macOS builds
are unsigned by default. Warnings can recur with each release; the installer cannot dismiss a browser or operating
system block before it runs.

**Microsoft Edge: “isn't commonly downloaded.”** This is SmartScreen's download
reputation warning, separate from the Windows launch prompt. It does not mean the
wizard has started or found a problem with your machine. Keep SmartScreen and
antivirus enabled. On a personally managed machine, Edge may offer **Keep** and
**Show more > Keep anyway** after you inspect the exact download source. Only
continue if you trust this repository and intend to run its current unsigned
build. [Verify the downloaded file](#windows-download-verification) before
opening it. An organization can prohibit this entirely; the installer cannot override
that policy. Another permitted Windows, Linux or macOS computer can prepare
installer USB media without running the blocked download on the target.

[Signing operations](windows-signing.md) documents the verified-publisher
prerequisite and automated release path. A signed release still cannot promise no
reputation warnings or compatibility with every managed Windows policy.

Platform launch behavior:

- **Windows:** SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**. A black window opens and stays open; it prints the address of the wizard and the path of the log. Leave it open.
- **macOS:** unzip, then open `fleet-installer`. If it is blocked, open **System Settings > Privacy & Security** and choose **Open Anyway**, then open it again.
- **Linux:** `tar xzf fleet-installer-linux-*.tar.gz && ./fleet-installer`.

A page opens in your browser. If it does not, copy the address the program printed (it starts with `http://127.0.0.1:`) into a browser on the same computer. The page only answers that computer.

### Windows download verification

After keeping the download in Edge, leave it closed. In PowerShell, compare its
SHA-256 with the matching `.sha256` file served by your Fleet app. This reads the
file and does not run or unblock it. Set `$origin` to the app you trust:

```powershell
$ErrorActionPreference = 'Stop'
$origin = 'https://fleet.example.org'
$file = Join-Path $env:USERPROFILE 'Downloads\fleet-installer-windows-x64.exe'
$checksum = Invoke-RestMethod "$origin/installers/assets/fleet-installer-windows-x64.exe.sha256"
$expected = ($checksum.Trim() -split '\s+')[0]
if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'No valid published checksum. Stop.' }
$actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'The file does not match the published installer. Do not run it.' }
Write-Output 'The installer checksum matches. This is integrity checking, not publisher verification.'
```

A matching hash proves only that your file matches the app's published bytes,
not that it is safe or signed. A failed or missing checksum is not a pass.
Do not use the ISO's `.sha256` file to verify the Windows EXE: they are different
downloads.

On Windows, inspect the publisher separately:

```powershell
Get-AuthenticodeSignature -LiteralPath $file | Format-List Status, StatusMessage, SignerCertificate
```

The current unsigned build reports `NotSigned`. A future signed release must
report `Valid` and the expected verified publisher documented in
[signing operations](windows-signing.md). Neither an integrity match nor a valid
signature guarantees SmartScreen reputation. Only proceed with a build you
trust and that your computer's policy permits. If Edge reports malware or a
signature is invalid, stop rather than using the reputation-warning instructions.

## 3. Answer the questions

1. The wizard looks at the computer and says what it can do. If the installer has not been published yet, or there is no internet, it says so here and stops.
2. Choose one:
   - **Make an install USB stick for another computer.** Works from Windows, macOS, and Linux. Plug in a USB stick (at least 8 GB; everything on it is erased), choose it, review, confirm.
   - **Turn THIS computer into a node.** On x86-64 Windows (UEFI, GPT, Secure Boot off) and on x86-64 Linux with `kexec`. Review, confirm. The live installer registers with Fleet; approve the computer under Pending in the app (see Approval below). The computer then restarts into the installer, erases its disk (Windows included), installs, and restarts as the node. macOS cannot do this; the wizard tells you and offers the USB instead.
     Optional: expand **Have an enrollment token?** and paste a token from your Fleet operator. See [Enrollment token](#enrollment-token).
3. **Review** names the exact disk and what will be erased, shows preparation the installer will perform, and surfaces only warnings and checks that need your attention. The full automatic checks are available under a disclosure. Nothing is changed until you tick the box and press **Erase and install**.
4. The operating system asks for permission (Windows: the shield prompt, macOS: your password, Linux: the polkit dialog). Accept it. Declining changes nothing.

## 4. After the USB is made

Plug the stick into the new computer and start it from the stick (usually F12, F11, Esc, or Option at power-on; turn Secure Boot off once in the firmware settings). The menu has one entry, **Fleet node - ERASES internal disk**; press Enter. The installer erases the computer's internal disk, installs, and restarts. Remove the stick when it says so. Then approve the
computer under Pending in your Fleet app and assign its role.

## Changing a node's role

Change it in the Fleet app. The node drains, then reboots into the new role's
system. Nothing is reinstalled and the disk is not erased.

## NixOS

Use the native Nix package rather than the ordinary Linux download. It includes
its own Python and disk/boot tools and works without `nix-ld`. Current fleet
images install both `fleet-installer` and `fleet-node` on every node.

For the browser wizard on this machine:

```sh
nix build ./packages/fleet#fleet-installer
sudo ./result/bin/fleet-installer --no-browser
```

Open the loopback address printed in the terminal in a browser on that same
machine. If it is headless, use the CLI below instead. Root access lets the
wizard stage the image on the node's persistent `/nix` filesystem. The erase
checkbox and disk confirmation still apply. Select **Hard reinstall** to
deliberately erase and replace an existing node.

For a hard reinstall from a terminal, first preview the exact disk and checks:

```sh
sudo fleet-node install --reinstall --plan
sudo fleet-node install --reinstall
```

If the installed command predates this flag, run the latest native CLI:

```sh
sudo nix --extra-experimental-features 'nix-command flakes' run 'github:crvouga/fleet/main?dir=packages/fleet#fleet-node' -- install --reinstall --plan
sudo nix --extra-experimental-features 'nix-command flakes' run 'github:crvouga/fleet/main?dir=packages/fleet#fleet-node' -- install --reinstall
```

The second command asks you to confirm the exact internal disk before anything
is prepared. A hard reinstall wipes the OS and every file on that disk. Without
`--reinstall`, `install` on an installed node wipes nothing. A running CI job
blocks the operation; new job admission is closed before handoff and reopened
if staging fails. The reinstalled machine keeps its hardware identity, so after
approval the Fleet app gives it back its stored role.

NixOS ARM64 can make install USB media. Fleet nodes still require x86-64 UEFI;
the program refuses to convert an ARM64 machine in place.

## Connecting to a remote devbox

Connect as `dev`: `ssh dev@<address>`. The node console shows its hostname, status, network address and host-key fingerprint. Check that fingerprint before accepting the SSH connection. The home directory is `/nix/devbox`; it survives reboot and system updates. Git, Bun, Node, Python, a C/C++ toolchain, Just and tmux are installed. Use `nix develop` for project dependencies. The dev account has no sudo; fleet system configuration comes from Git. A hard reinstall erases project work: back it up first.

Public SSH keys for `dev` are the `devbox.authorizedKeys` setting in the Fleet app. The installer never asks for one. The private SSH key never leaves the computer you connect from.

## Approval

The live installer registers the hardware identity, with no role, and a fresh
private per-node credential directly with the controller configured in the
image. Open **Pending** in Fleet, review the computer and approve it. It waits
up to five minutes before disk changes; rejection and timeout stop without
erasing. A retry reuses the same credential during that live boot, and the
installed system receives that private credential. Then assign its role in the
app. Without a configured controller (local mode) there is no approval step.

The installer never handles age keys. The node creates its own age identity on
first boot and reports its public recipient to Fleet. The operator encrypts
role secrets to it; until then the node reports the missing recipient.

## Enrollment token

A token is optional. It lets Fleet approve the computer without a person; if
the operator's token entry names a role, Fleet also assigns that role. When a
token is present the live installer checks it with Fleet before erasing.
It is never printed and never put on a kernel command line or in arguments.

- **This computer:** paste it under **Have an enrollment token?** in the
  wizard, or pass `--token-file PATH` (or `FLEET_ENROLL_TOKEN`) to
  `fleet-node.sh`. It travels in the same private handoff as the Wi-Fi profile.
- **USB:** put it in a file `enrollment.token` on a separate volume labelled
  `FLEET-KEY` and plug it in before booting. It is mounted read-only. The
  wizard does not write tokens to the USB.

## Private Git repository

A fleet whose `repo.auth` is `ssh` or `token` follows a private repository, and
the role-less `base` system has no secret to fetch it with. Supply its read
credential at install time: an OpenSSH private key (`ssh`) or one token line
(`token`). The live installer refuses before erasing with
`FLEET_GIT_CREDENTIAL_MISSING` when none is supplied, and refuses one of the
wrong kind. With `repo.auth = none` a supplied credential is ignored. It is
installed as `/nix/fleet-state/secrets/git-read-key` or `git-read-token` (root,
0600) and, like the token, never printed or put on a kernel command line.

- **This computer:** paste it under **Does this fleet follow a private Git
  repository?** in the wizard, or pass `--git-credential-file PATH` (or
  `FLEET_GIT_CREDENTIAL_FILE`) to `fleet-node.sh`.
- **USB:** put it in `git-read-key` or `git-read-token` on the `FLEET-KEY`
  volume.

## Windows

The wizard handles partition preparation, image verification, boot setup and
restart. If a shrink check fails, it first attempts free-space consolidation
once, then repeats the check. If a later staging step fails, it attempts to undo
the partition and boot changes; an undo failure is reported with its log.
Secure Boot must be off, the disk must be GPT and the PC must use UEFI. It needs
the current image size plus 2 GiB of RAM. [windows.md](windows.md) has optional
boot details and recovery instructions; they are not prerequisite manual steps.
This conversion has not been qualified on real hardware; use a backed-up spare
for the first run.

## Supported hardware and operating systems

The five downloads are for the computer making the USB, not five node architectures. Nodes currently require x86-64, UEFI, supported Wi-Fi or Ethernet networking and one unambiguous internal disk; Apple silicon and ARM boards can make install media but cannot become fleet nodes. The ordinary Linux downloads require glibc; Alpine/musl and old Linux distributions are not supported. NixOS uses the native Nix package on x86-64 or ARM64; it does not need a foreign ELF loader. macOS installations use a USB and require a physical firmware boot. Windows converts itself but needs Secure Boot turned off once. The wizard cannot automate firmware settings, hardware replacement, or unsigned-app approval. No claim of universal hardware support is made.

An interrupted USB write leaves an incomplete stick. Keep it plugged in, restart the wizard and write the whole image again; it never reports that stick as ready before verification passes. A reinstall erases the old OS and files.

## When something goes wrong

**Report a problem**, at the top of every page, opens a pre-filled GitHub issue
about the step you are on, whether or not anything failed, and copies the full
report to the clipboard. Every issue uses the same form (_Fleet installer
problem_), whether it comes from the wizard, `fleet-node.sh` (every failure ends
with a `Report:` link) or the installer screen after a restart (a QR code).

When this computer is set up in place, the review page and the final page list
what happens after the restart. The installer screen then shows seven numbered
steps with what to do at each, waits with a reason when something is not ready,
and on a stop shows what to do and a QR code for the issue. Before anything is
erased it returns to the original system after two minutes (Enter stays). At
any time Alt+F2 gives a prompt with `fleet-status`, `fleet-wifi`, `fleet-report`,
`fleet-retry` and `fleet-return`. [windows.md](windows.md) describes each screen.

Every failure says what happened and what to do next, and names a log file. The wizard keeps its log in the `.fleet/logs` folder in your home directory, and the installed node keeps `/nix/fleet-state/logs/install.log`. Nothing is erased before the review page's confirmation, and a USB stick is only reported as ready after the wizard reads it back and proves it holds the verified installer.

A failure page lists numbered recovery steps, says whether anything on the computer could have changed, and offers:

- **Try again**, which reviews the same choices again (you confirm the erase again; nothing is reused silently).
- **Copy diagnostic report**, which puts the error, this computer's details, the job's steps and the recent log lines on the clipboard, ready to paste to an agent. Secrets are redacted.
- **Save diagnostic report**, which downloads the same full report as `fleet-diagnostic.txt`. Attach it to the issue or give it to the agent, especially if the pre-filled issue says its logs were shortened.
- **Report on GitHub**, which opens a pre-filled public issue in this repository and also copies the full report. Review the issue before you submit it.

Reports include an attempt ID, timings, the verified image checksum, recorded
review/helper checks, and error source locations and OS error codes when available.
The attempt ID connects the window's log to the administrator helper's log.
Failed checks and error locations remain in shortened issues when space allows;
the saved report keeps the complete recorded checks and recent logs. Collecting
a report reads recorded evidence; it does not rerun checks or disk operations.
Agents should follow the [installer debugging runbook](debugging.md).
The same report controls are available when review checks block installation.

If the administrator step is still running when something goes wrong, the wizard keeps waiting for it rather than reporting a result it cannot know.

**Cancel** works while the installer downloads and while the permission prompt is open: it withdraws the request, so accepting the prompt afterwards does nothing. Once the administrator step has started, it runs to the end; the wizard will not quit in the middle of it. Closing the terminal does not stop it either. Running the wizard again after an interrupted attempt is always safe: a Windows conversion that never finished is taken back first, and a node whose CI job admission was closed by an interrupted reinstall has it reopened if the retry fails too.

| You see                                           | Do this                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "The installer download cannot be reached"        | Check the internet connection. If it is fine, the installer has not been published yet. |
| A `FAIL` on the review page                       | Do what its line says, then press **Check again**.                                      |
| "does not match its checksum"                     | Run the wizard again. If it repeats, the release is broken; re-run the Fleet workflow.  |
| "does not hold the installer after writing"       | The USB stick or its port is faulty. Try another stick or port.                         |
| "The permission prompt was probably declined"     | Run the wizard again and accept the prompt.                                             |
| "Permission denied" on a `fleet-job-…` file       | Download the latest installer (issue #140 fixed this), then press **Try again**.        |
| "Disks were plugged or unplugged since you chose" | Run the wizard again.                                                                   |
