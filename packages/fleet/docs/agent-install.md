# Add or remove a fleet node (agent runbook)

You are an agent on a machine that should join (or leave) the fleet. Do the work yourself. The person should only have to say yes once, to the disk that will be erased. Everything here runs on this machine; you need no checkout, no Nix, and no second computer.

Rules that never bend:

- Never erase a disk without the person's explicit yes that names the disk and the role. A `--yes` flag is not their yes.
- Never print, echo, or log an enrollment token or an age key. Pass tokens with `--token-file`, never as an argument.
- Do not edit configuration, add a hostname, or write per-machine files. The role and the hardware decide everything.
- Do not debug in a loop. Every failure prints one `Next:` line and a `Log:` path. Do what `Next:` says once; if the same check fails again, stop and show the person the `Next:` line, the log path and the `Report:` link.

## Add a node

1. Get the program. It is one file.

   ```sh
   curl -fsSL -o fleet-node.sh https://github.com/crvouga/fleet/releases/download/fleet-installer/fleet-node.sh
   ```

   Windows PowerShell: `curl.exe -fsSL -o fleet-node.sh <same url>`, then use `bash fleet-node.sh`. Python 3 is the only requirement. If it is missing, install Python 3 with the system package manager and continue.

2. Learn the role. It is `ci` or `devbox` (the active roles in `packages/fleet/roles.json`). If the person did not say, ask once. Do not guess.

For `devbox`, collect the public `.pub` SSH key from the computer the person will connect from. Never request or transport the private key. Set `FLEET_DEVBOX_SSH_KEY_FILE` to a root-readable copy of that public file for both doctor and install. A missing key refuses the install. A devbox home persists over reboot but a role conversion wipes it: back up project work first.

3. Check, read-only. Run it with `sudo` on Linux and macOS.

   ```sh
   sudo bash fleet-node.sh doctor ROLE --json
   ```

   It writes nothing. In the JSON, `ok` is true only when nothing stands in the way. For every check with `status` `fail`, `fix` says what to do. Do the fixes you can do yourself (install a package, rerun with `sudo`), then run `doctor` again. A fix that needs the person (a firmware setting, more RAM, a different computer) goes to them as one sentence. `warn` entries do not block; tell the person about them.

4. Enrollment. A node of a role that has encrypted secrets needs that role's key. By default the install asks the repository owner to approve the node: it prints a link (and tries to open it) to a prefilled GitHub issue, and waits up to 15 minutes before anything is erased. You cannot press that button; show the person the link, say "press Submit new issue while signed in as the repository owner", and keep the command running. If the person pasted a line containing `FLEET_ENROLL_TOKEN=...` or gave you a token instead, write the token alone into a file readable only by root (for example `install -m 600 /dev/null tok && printf %s "$TOKEN" > tok`), pass `--token-file tok` from here on, and delete the file afterward; `doctor` checks it without spending it and refuses one made for a different role. If the approval workflow answers with `fleet-error:`, show the person that sentence. Only if the person says the node does not need the role's shared secrets, add `--no-enroll`.

5. Ask. Tell the person, in plain words: the role, `erases` from the JSON (the exact disk, which loses everything on it including Windows or any other OS), that the machine will reboot into the installer and this session will end, and any `warn` entries. Get an explicit yes.

6. Install.

   ```sh
   sudo bash fleet-node.sh ROLE --yes --token-file tok
   ```

   It repeats every check and refuses on its own if the disk changed or anything is wrong; nothing is erased in that case. When it prints `FLEET-WIPE role=ROLE` the machine is rebooting into the installer. On Windows the install first shrinks `C:` and writes the installer into the freed space (`doctor` and `bash fleet-node.sh ROLE --plan` print the exact steps and sizes and change nothing; docs/windows.md has the recovery steps); it needs an elevated shell, UEFI/GPT, and Secure Boot off (`doctor` says so and what to run), and it restores everything if a step fails. The installer erases that disk, installs the role, and reboots into the node. This takes several minutes with no further input. The hostname is `<role>-<4 hex>` and is set from the hardware.

7. After the reboot, on the node (a person or a new session): `fleet-node status`. `Result: healthy.` means the node pulled its configuration and is polling `main`. The first sync can take a few minutes. The install record is `/nix/fleet-state/logs/install.log`.

A machine with no operating system cannot download anything. On any other computer run `bash fleet-node.sh flash`, which writes the installer to a USB disk (it refuses an internal disk), then boot the empty machine from it.

## Remove a node

On the node, run `fleet-node remove`. It withdraws the runner, marks the node so it never registers again (even after a reboot), and powers the machine off by itself once no job is running. It never stops a running job; if one is running it says so, and you run it again later. To reuse the machine, run the add steps again.

## Reading output

| Line      | Meaning                                                                    |
| --------- | -------------------------------------------------------------------------- |
| `Checks:` | One line per check: `ok`, `info`, `WARN`, or `FAIL`, with `fix:` under it. |
| `Why:`    | The underlying cause (for example the HTTP error).                         |
| `Next:`   | The single thing to do now. Exactly one per failure.                       |
| `Log:`    | Timestamped log of this run, secrets redacted. Show it if you get stuck.   |
| `Report:` | A pre-filled GitHub issue for this failure. Give it to the person to open. |

Exit code 0 means done. 2 means a precondition failed and nothing was written. 70 is a bug in the program.

Source and design notes: `packages/fleet` in https://github.com/crvouga/fleet (`AGENTS.md`, `docs/runbook.md`).
