# Debugging Fleet installer failures

Start with the diagnostic report from **Copy diagnostic report** or **Save
diagnostic report**. When a GitHub issue says log tails were shortened, its
missing logs are not evidence that the helper did nothing. The saved
`fleet-diagnostic.txt` contains the full report and can be attached to the issue.
Reports are redacted but can contain local paths and hardware details; review
them before sharing publicly. Never request an enrollment token, Wi-Fi password,
private key, `request.json` or a Windows staging journal as public evidence.

## Find the boundary that failed

1. Read **Version**, **Attempt**, **Mode**, **State** and **step**. Use that source
   revision when investigating an older downloaded executable; the rolling
   release and current `main` may have changed. **Verified image** identifies
   the downloaded ISO independently of the wizard build. An absent checksum
   means verification had not completed.
2. Read **Checks**. These are snapshots from the review, privileged preflight
   and any check after automatic preparation. Compare stages; a check that
   changes after elevation or preparation points to that boundary. Preserve
   every blocker, its measured detail and its fix. A missing stage means it
   was not recorded, not that its checks passed.
3. Read **Error type**, **Source**, **Context**, `errno` and `winerror`. Source
   locations exclude local variables. Use the matching source revision to
   inspect the invariant or failing operation. Expected refusals and unexpected
   exceptions both carry this evidence when caught by the wizard or helper.
4. Read **Timeline** to identify the last actual phase and elapsed time. Log
   messages do not replace the phase with `log`. The terminal duration freezes
   when the job finishes. Attempts get new IDs on retries.
5. Read **Job steps** and both **Log** sections. The helper's log may belong to
   another OS account; its last lines travel inside its result so the report
   can include them even if the window cannot open that file. If the helper
   dies before writing a result, that evidence may be unavailable. Search the
   logs for `attempt=<id>` to correlate them; an ID is not an authorization token.

An unelevated **System: Administrator: no** describes the browser server, not
the privileged helper. The helper's recorded privilege check describes its own
process. Unknown or unreadable progress means disk changes are possible. Wait
for a running helper to finish; never kill it or erase again just to get logs.

## Reports from the installer screen

Issues titled `Fleet installer screen: …` come from the live image after a
restart (`scripts/live_console.py`, driven by `scripts/fleet-auto.sh` and
`scripts/fleet-install.sh`). The QR code is as large as the console allows
(about 900 bytes on a 1920x1080 screen, 450 on 1024x768) and its report is
ordered most useful first, so a cut report loses only the end. The issue title
holds the `FLEET_*` code, and in brackets the network verdict when the network
was not ready. The compact lines are:

- First line: role, the first 8 characters of the **revision**, where it started
  from (`windows`, `linux` or `usb`), the outcome before or after erasing,
  `exit=`, `step=N/7`, `t=` elapsed and `tries=` (readiness attempts).
- `why` / `lastwait`: the reason, when the network verdict does not already say it.
- `net CODE wifi=SENT,ARRIVED auth= seen= nearby= run=`: the network verdict
  from `wizard/fleet_wifi.py` (`refused`, `not-visible`, `no-settings`,
  `settings-lost`, `no-driver`, `no-adapter`, `adapter-unavailable`,
  `radio-off`, `no-address`, `internet`, `timeout`, `no-connect`). `SENT` is the
  `fleet.wifi=` boot word (`sent`, `none`, or `unknown` for a USB boot or an
  older handoff). `ARRIVED` says whether the settings reached
  `/run/fleet-wifi/wifi.json`. `seen=` is the carried network's signal, band and
  security in the scan, or `no`.
- `try AUTH:RESULT …`: each connection attempt, with NetworkManager's reason.
- `nic`, `nodriver`, `rfkill`: interfaces with driver and PCI/USB id, network
  controllers no driver claimed, and radio blocks.
- `check NAME=STATE`: network checks that did not pass. `klog`: the kernel's last
  complaints about wireless hardware or firmware. `clock`: the live system's UTC
  time, to compare against certificate errors.
- `hw`, then `log`: the last install-log lines, joined with `|`.

The network name, MAC addresses, passwords and tokens are never in a report. Read the
reason codes in `scripts/bootstrap-readiness.py` (75 means retried before
erasing; anything else stopped). The **Step** field names the screen step:
1 network, 2 approval, 3 checks, 4 disk, 5 erase, 6 install, 7 restart. The
same `step <name>` lines are in `/run/fleet-install.log`, and in
`/nix/fleet-state/logs/install.log` on an installed node.

A photo of the screen, or `fleet-report --full` copied over SSH, adds every
network check with its detail, the last 40 install-log lines and the last
attempt's output. `/run/fleet-live/network.json` on the machine is the raw
network record (it does contain the network name). When the node had enrolled, Fleet also records each stop as an
installation event. On the machine, `journalctl -u fleet-auto-install` has
everything the installer printed; the screens themselves go straight to the
console because systemd's `journal+console` prefixes each line and breaks the
QR code. Reproduce screens with `tests/test_live_console.py` and the retry and
return decisions with `tests/test_auto.py`; both use stand-ins, never a disk.

## Reports from an installed node's console

Issues titled `Fleet node console: …` come from a node after installation
(`scripts/node_console.py`). The title holds the first problem's code and the
role. Its compact lines:

- `node HOST ROLE rev= state= up=`: `state` is `problem` (something lasting, or
  still not ready after 20 minutes) or `unknown` (the Fleet agent is not
  reporting, so readiness could not be confirmed).
- `why`, then `issue temp|lasting …`: the readiness issues the agent last sent
  to Fleet, plus local findings. `temp` codes usually clear by themselves.
- `slots A/N active`, then one line per unhealthy slot with its systemd state,
  restart count and last registration outcome (`register=CODE exit=78` is a
  refusal from GitHub; see `scripts/runner_control.py` `refusal`).
- `fleet agent= outcome= approval= last= failures= error=`: the agent's last
  report attempt.
- `net`, `sync`, `failed`, `hw`, `installed` (the install log's handoff line:
  wizard build and attempt), and `journal UNIT | …`: the last journal lines of the
  first unhealthy runner or failed unit, with long opaque strings redacted.

Over SSH, `fleet-node-status --report` prints the full report link. Reproduce
with `tests/test_node_console.py`.

## Reproduce without touching hardware

From the repository root:

```sh
python3 -B packages/fleet/tests/test_wizard_evidence.py
python3 -B packages/fleet/tests/test_wizard_diagnostics.py
python3 -B packages/fleet/tests/test_wizard_automation.py
python3 -B packages/fleet/tests/test_wizard.py
python3 -B -m unittest discover -s packages/fleet/tests -p 'test_live_console.py'
python3 -B -m unittest discover -s packages/fleet/tests -p 'test_auto.py'
```

Use the `WizardCase` fixture in `tests/test_wizard.py` for server/helper
regressions. It runs the real HTTP server, local image download and helper
against synthetic disk inventory and a regular file. Test failing checks,
unreadable logs, helper crashes and missing results at their boundaries. Keep
hardware probes mocked or use existing stand-ins. `FLEET_WRITE_TARGET` requires
`FLEET_DISKS_FILE`; neither is a way to point tests at a real disk. Windows raw
writes and firmware have their own regular-file stand-ins described in
[windows.md](windows.md).

CLI-only reports can use the read-only `fleet-node.sh doctor ROLE --json`
command from [agent-install.md](agent-install.md). Do not rerun an installation,
enroll again, change firmware, alter a boot entry or modify a staging journal
to collect evidence. A successful stand-in test proves the software boundary;
it does not prove a physical firmware handoff.

## Keep future failures diagnosable

Use `decide.invariant` with a concrete explanation, measured context and a safe
next step. Record additional preflight stages with `Progress.record_checks`;
only the check name, status, detail and fix enter reports. Do not pass whole
request, plan, environment or credential objects. Add user recovery rules to
`wizard/diagnostics.py` when the response is known, and to `ADVICE` in
`scripts/live_console.py` for a new `FLEET_*` code the installer screen can show. Test that essential evidence
survives the helper result, server cleanup and shortened GitHub issue, with
secrets redacted. Keep the full log for causes that do not fit in a URL.
