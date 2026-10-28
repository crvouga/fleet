# Add or remove a fleet node (agent runbook)

You are an agent on a machine that should join (or leave) the fleet. Do the work yourself. The person should only have to say yes once, to the disk that will be erased. The installer runs on this machine without a checkout or Nix. For managed enrollment, the Fleet owner must be able to access the app while the live installer waits for approval.

Rules that never bend:

- Never erase a disk without the person's explicit yes that names the disk. A `--yes` flag is not their yes.
- Never print, echo, or log an enrollment token. Pass it with `--token-file` (or `FLEET_ENROLL_TOKEN`), never as an argument.
- If the fleet follows a private Git repository (`repo.auth` is `ssh` or `token`), the person gives you its read key or token: save it to a private file and pass `--git-credential-file PATH`. Never print it. Without it the live installer refuses before erasing (`FLEET_GIT_CREDENTIAL_MISSING`).
- Do not edit configuration, add a hostname, or write per-machine files. Do not pass a role: the installer sets up the node only, and the role is assigned in the Fleet app.
- Do not debug in a loop. Every failure prints one `Next:` line and a `Log:` path. Do what `Next:` says once; if the same check fails again, stop and show the person the `Next:` line, the log path and the `Report:` link.

## Add a node

1. Get the program. It is one file.

   ```sh
   export FLEET_CONTROLLER_URL=https://fleet.example.org  # operator-supplied app origin
   curl -fsSL -o fleet-node.sh "$FLEET_CONTROLLER_URL/installers/assets/fleet-node.sh"
   ```

   Windows PowerShell: `curl.exe -fsSL -o fleet-node.sh <same url>`, then use `bash fleet-node.sh`. Python 3 is the only requirement. If it is missing, install Python 3 with the system package manager and continue.

2. Check, read-only. Run it with `sudo` on Linux and macOS.

   ```sh
   sudo env FLEET_CONTROLLER_URL="$FLEET_CONTROLLER_URL" bash fleet-node.sh doctor --json
   ```

   It writes nothing. In the JSON, `ok` is true only when nothing stands in the way. For every check with `status` `fail`, `fix` says what to do. Do the fixes you can do yourself (install a package, rerun with `sudo`), then run `doctor` again. A fix that needs the person (a firmware setting, more RAM, a different computer) goes to them as one sentence. `warn` entries do not block; tell the person about them.

3. Approval stays in the Fleet app. After restart, the live installer registers its hardware identity (no role) and private credential directly with the controller configured in the image. Ask the Fleet owner to review this computer under **Pending** and approve it. Disk erasure remains blocked until approval for up to five minutes; rejection or timeout leaves the disk untouched. If the person gave you an optional enrollment token, save it to a private file and pass `--token-file`; Fleet then approves without a person. No GitHub account, issue, workflow or age key is involved.

4. Ask. Tell the person, in plain words: `erases` from the JSON (the exact disk, which loses everything on it including Windows or any other OS), that the machine will reboot into the installer and this session will end, and any `warn` entries. Get an explicit yes.

5. Install.

   ```sh
   sudo env FLEET_CONTROLLER_URL="$FLEET_CONTROLLER_URL" bash fleet-node.sh install --yes --token-file tok
   ```

   It repeats every check and refuses on its own if the disk changed or anything is wrong; nothing is erased in that case. Leave out `--token-file tok` if there is no token. When it prints `FLEET-WIPE install` the machine is rebooting into the installer. On Windows the install first shrinks `C:` and writes the installer into the freed space (`doctor` and `bash fleet-node.sh install --plan` print the exact steps and sizes and change nothing; docs/windows.md has the recovery steps); it needs an elevated shell, UEFI/GPT, and Secure Boot off (`doctor` says so and what to run), and it restores everything if a step fails. The installer erases that disk, installs `base`, and reboots into the node. This takes several minutes with no further input. On an already installed node `install` wipes nothing; `--reinstall` erases it deliberately and needs the same yes.

6. Ask the Fleet owner to assign the node's role in the Fleet app. A later role change is also done there; it never needs a reinstall.

7. After the reboot, on the node (a person or a new session): `fleet-node status`. `Result: healthy.` means the node pulled its configuration and is polling `main`. The first sync after a role is assigned can take a few minutes. The install record is `/nix/fleet-state/logs/install.log`.

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

Source and design notes: `packages/fleet/AGENTS.md` and `packages/fleet/docs/runbook.md` in this application checkout.
