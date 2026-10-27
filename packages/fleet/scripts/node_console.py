#!/usr/bin/env python3
"""The installed node's own screen: what it is, whether it is ready, why not, and how to report it.

Nobody logs in at a node's console (root is locked), so tty1 shows this instead
of a login prompt, redrawn every 15 seconds by fleet-node-console.service
(modules/console.nix). Over SSH, `fleet-node-status` prints the same words.

It reads only what the node already knows: the Fleet agent's last report and its
readiness verdict (agent.py, status.json), each runner slot's last registration
(runner_control.py, /run/fleet/register), unit states, the update and
boot-health markers and the network. It never calls GitHub or Fleet itself, so a
slow or failing service cannot freeze the screen. What it cannot tell, it says
it cannot tell. Reports pass through decide.redact; no secret is read.
"""
import calendar
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decide  # noqa: E402
import live_console as screen  # noqa: E402
import recovery  # noqa: E402

FLEET_NODES = os.environ.get("FLEET_API_URL", "").rstrip("/") + "/nodes"
REFRESH = 15
# How long a node may still be starting before the screen offers a report.
PATIENCE = 20 * 60
# Fleet heartbeats are older than this: the node is not reporting.
STALE = 10 * 60
# Codes that clear by themselves while the node starts or a service recovers.
TEMPORARY = re.compile(r"FLEET_(RUNNERS_STARTING|GITHUB_UNAVAILABLE|GITHUB_CHECK_PENDING|GITHUB_RUNNERS_PENDING|"
                       r"UPDATE_CHECK_PENDING|READINESS_FAILED|SERVICE_STATUS_UNKNOWN|BOOT_WAITING)")
# Settings a person chose in Fleet: shown, never a problem.
CHOSEN = re.compile(r"FLEET_(RUNNERS_DISABLED|UPDATES_PAUSED)")
# (code pattern, what the person at the machine does, what the repository owner does).
OWNER = "The repository owner"
ACTIONS = (
    (r"FLEET_SECRET_MISSING|FLEET_ROLE_SECRETS",
     f"{OWNER} re-encrypts this role's secrets for this node's age key (shown below), or reinstalls the node with a fresh approval."),
    (r"FLEET_GITHUB_KEY",
     f"{OWNER} checks the GitHub App ID in settings/github.json and the App private key in the vault OpenTofu root."),
    (r"FLEET_GITHUB_SCOPE",
     f"{OWNER} checks the GitHub App installation: its repository access and its runner permission."),
    (r"FLEET_GITHUB_UNCONFIGURED|FLEET_GITHUB_SCOPE_INVALID",
     f"{OWNER} completes settings/github.json (App ID, installation ID, runner targets)."),
    (r"FLEET_RUNNER_RESTARTING|FLEET_GITHUB_OPERATION_FAILED",
     "Report it with the code: the node's journal has the cause, which this screen cannot see."),
    (r"FLEET_RUNNER_PREREQUISITE_FAILED",
     f"{OWNER} repairs the CI closure through Git. The runner service journal names the failed tool or filesystem check."),
    (r"FLEET_BOOT_HEALTH_FAILED|FLEET_UPDATE",
     "Check that this computer reaches the internet. If it does, report it: updates are not being applied."),
    (r"no-network",
     "Plug in a network cable, or check the Wi-Fi router. The node reconnects by itself."),
    (r"update-quarantined",
     "Nothing to do at this machine. Once the cause is understood, press Retry the update on the node's page in Fleet."),
    (r"gate-manual",
     "Press Reopen runner admission on the node's page in Fleet, or run fleet-resume over SSH."),
    (r"fleet-rejected|FLEET_APPROVAL",
     f"Open {FLEET_NODES} and approve this node under Pending."),
)
UNKNOWN_ACTION = "Report it with the code: the report says what this node could see."


def env_path(name, default):
    return Path(os.environ.get(name) or default)


def paths():
    state = env_path("FLEET_STATE", "/nix/fleet-state")
    return {"state": state, "agent": env_path("FLEET_AGENT_STATE", state / "agent"), "run": env_path("FLEET_RUN", "/run/fleet"),
            "etc": env_path("FLEET_ETC", "/etc/fleet"), "proc": env_path("FLEET_PROC", "/proc"), "sys": env_path("FLEET_SYS", "/sys")}


def read(path, limit=8192):
    return screen.read_text(path, limit).strip()


def read_kv(path):
    values = {}
    for line in read(path).splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def run(args, timeout=5):
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return 127, ""
    return done.returncode, done.stdout


def ago(seconds):
    return "just now" if seconds < 5 else screen.minutes(seconds) + " ago"


def parse_time(text):
    try:
        return calendar.timegm(time.strptime(str(text)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


# ---- what the node knows -----------------------------------------------------------

def network(where):
    """Addresses and the interface the default route uses."""
    _, routes = run(["ip", "route", "show", "default"])
    via = re.search(r"\bdev\s+(\S+)", routes)
    _, brief = run(["ip", "-brief", "-4", "address", "show", "scope", "global"])
    addresses = []
    for line in brief.splitlines():
        parts = line.split()
        if len(parts) >= 3:
            addresses.append((parts[0], parts[2].split("/")[0]))
    device = via.group(1) if via else ""
    return {"device": device, "wifi": bool(device) and (where["sys"] / "class/net" / device / "wireless").exists(),
            "addresses": addresses}


def slots(where):
    """Each runner slot: its unit state, restarts and last registration."""
    try:
        count = int(read(where["run"] / "slot-count"))
    except ValueError:
        return None
    units = [f"github-runner-slot-{n}.service" for n in range(1, count + 1)]
    _, shown = run(["systemctl", "show", "--property", "Id,ActiveState,NRestarts", *units])
    states = {}
    for block in shown.split("\n\n"):
        fields = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if fields.get("Id"):
            states[fields["Id"]] = fields
    result = []
    for n, unit in enumerate(units, 1):
        fields = states.get(unit, {})
        registered = screen.read_json(where["run"] / "register" / f"slot-{n}.json")
        result.append({"slot": f"slot-{n}", "state": fields.get("ActiveState", "unknown"),
                       "restarts": int(fields["NRestarts"]) if fields.get("NRestarts", "").isdigit() else 0,
                       "register": registered or None})
    return result


def gather():
    where = paths()
    node = read_kv(where["run"] / "node")
    uptime = read(where["proc"] / "uptime", 128).split()
    agent = screen.read_json(where["agent"] / "status.json")
    _, failed = run(["systemctl", "list-units", "--failed", "--plain", "--no-legend", "--no-pager"])
    _, agent_state = run(["systemctl", "is-active", "fleet-agent.service"])
    bootstrap = screen.read_json(where["etc"] / "bootstrap.json")
    return {
        "role": node.get("role") or read_kv(where["etc"] / "role").get("role") or "unknown",
        "hostname": node.get("hostname") or os.uname().nodename,
        "revision": read(where["etc"] / "revision", 128) or "unknown",
        "uptime": float(uptime[0]) if uptime and re.fullmatch(r"[0-9.]+", uptime[0]) else None,
        "network": network(where),
        "agent": agent,
        "agentActive": agent_state.strip(),
        "runners": bool(bootstrap.get("github")),
        "slots": slots(where) if bootstrap.get("github") else None,
        "sync": {"lastSuccess": read(where["state"] / "sync/last-success", 128),
                 "failure": read(where["state"] / "sync/health-failure", 2048)},
        "failed": [line.split()[0] for line in failed.splitlines() if line.split()][:8],
        "agePublic": read(where["state"] / "secrets/age.pub", 256),
        "recovery": recovery_facts(where),
        "ssh": run(["ssh-keygen", "-lf", str(where["state"] / "ssh/ssh_host_ed25519_key.pub")])[1].strip(),
    }


# ---- the verdict -------------------------------------------------------------------

def recovery_facts(where):
    """What the node remembers across power loss (recovery.py); None when unreadable."""
    try:
        return recovery.status(where["state"] / "recovery", run=where["run"], sync=where["state"] / "sync")
    except (OSError, ValueError):
        return None


def problems(facts):
    """(code, sentence, temporary) for everything not ready, most important first."""
    found = []
    kept = facts.get("recovery") or {}
    if kept.get("quarantine"):
        found.append(("update-quarantined", "A kernel update did not boot healthily, so this node fell back to its "
                      "previous kernel and keeps working on it. It will not reboot into that kernel again until a "
                      "newer one is published or the update is retried in Fleet.", False))
    if "manual" in (kept.get("gate") or {}).get("reasons", []):
        found.append(("gate-manual", "Runner admission was closed by hand on this node; it stays closed until "
                      "it is reopened in Fleet or with fleet-resume.", False))
    net = facts["network"]
    if not net["device"]:
        found.append(("no-network", "This node has no network connection (no default route).", True))
    if facts["sync"]["failure"]:
        line = next((l for l in facts["sync"]["failure"].splitlines() if l.startswith("FLEET_")), facts["sync"]["failure"].splitlines()[-1])
        found.append((screen.code(line) or "FLEET_UPDATE_FAILED", line[:240], False))
    for item in facts["slots"] or []:
        last = item["register"] or {}
        if last.get("exit") == 78:
            found.append((last.get("code") or "FLEET_GITHUB_REGISTRATION",
                          f"Runner {item['slot']} cannot register with GitHub: {last.get('message', '')}."[:300], False))
            break
    agent = facts["agent"]
    readiness = agent.get("readiness")
    if agent.get("outcome") == "rejected":
        found.append(("fleet-rejected", "Fleet refused this node's reports: " + str(agent.get("lastError") or "no reason given"), False))
    for issue in readiness or []:
        code = screen.code(issue)
        if CHOSEN.search(code) or any(code == existing[0] for existing in found):
            continue
        found.append((code or "FLEET_NOT_READY", issue[:300], bool(TEMPORARY.search(code))))
    for unit in facts["failed"]:
        found.append(("unit-failed", f"The service {unit} has failed.", False))
    return found


def verdict(facts):
    """(state, headline). The state is ready, starting, problem or unknown."""
    found = [(code, human(sentence), temporary) for code, sentence, temporary in problems(facts)]
    agent = facts["agent"]
    readiness = agent.get("readiness")
    reported = parse_time(agent.get("lastSuccessAt"))
    fresh = reported is not None and time.time() - reported < STALE
    patient = facts["uptime"] is not None and facts["uptime"] < PATIENCE
    lasting = [item for item in found if not item[2]]
    if lasting:
        return "problem", lasting[0][1]
    if found:
        if patient:
            return "starting", found[0][1]
        return "problem", f"Still not ready after {screen.minutes(facts['uptime'] or 0)}. " + found[0][1] + \
            " It may still clear by itself; this screen cannot tell whether it will."
    if not agent:
        if facts["agentActive"] in ("active", "activating"):
            return ("starting" if patient else "unknown"), "The Fleet agent has not reported yet, so readiness is not confirmed."
        return "unknown", "The Fleet agent is not running here, so readiness cannot be confirmed from this node."
    if not fresh:
        if patient:
            return "starting", "Waiting for the first report to Fleet."
        last = ago(time.time() - reported) if reported else "never"
        return "problem", f"This node has not reported to Fleet ({last}): {agent.get('lastError') or 'no error recorded'}."
    if readiness is None:
        return "unknown", "Fleet was reached, but this node's readiness was not recorded."
    if facts["runners"]:
        count = len(facts["slots"] or [])
        return "ready", f"{count} runner{'s' if count != 1 else ''} online in GitHub. Nothing to do."
    return "ready", "Nothing to do."


def human(sentence):
    """A sentence for the screen: the FLEET_* code goes to the report, not the headline."""
    text = re.sub(r"^FLEET_[A-Z_]+:\s*", "", sentence).strip()
    return text[:1].upper() + text[1:]


def action(code):
    for pattern, text in ACTIONS:
        if re.search(pattern, code or ""):
            return text
    return UNKNOWN_ACTION


# ---- the screen --------------------------------------------------------------------

MARK = {"ok": "[x]", "wait": "[~]", "fail": "[!]", "unknown": "[?]", "off": "[-]"}


def rows(facts):
    """(mark, title, detail) for each check, in the order the node needs them."""
    out = []
    net = facts["network"]
    if net["device"]:
        address = next((ip for name, ip in net["addresses"] if name == net["device"]), "")
        out.append(("ok", "Network", f"{address} on {net['device']} ({'Wi-Fi' if net['wifi'] else 'wired'})".strip()))
    else:
        out.append(("fail", "Network", "no connection"))
    agent = facts["agent"]
    reported = parse_time(agent.get("lastSuccessAt"))
    if reported and time.time() - reported < STALE:
        out.append(("ok", "Fleet", f"reported {ago(time.time() - reported)}" + (f", {agent['approval']}" if agent.get("approval") else "")))
    elif agent.get("lastError"):
        out.append(("fail", "Fleet", f"last report failed: {agent['lastError']}"[:70]))
    elif facts["agentActive"] in ("active", "activating"):
        out.append(("wait", "Fleet", "not reported yet"))
    else:
        out.append(("unknown", "Fleet", "the Fleet agent is not running"))
    sync = facts["sync"]
    if sync["failure"]:
        out.append(("fail", "Updates", (screen.code(sync["failure"]) or "update check failed")))
    elif sync["lastSuccess"] and sync["lastSuccess"] == facts["revision"]:
        out.append(("ok", "Updates", f"revision {facts['revision'][:8]} checked"))
    else:
        out.append(("wait", "Updates", "waiting for the first update check"))
    if facts["runners"]:
        items = facts["slots"]
        issues = " ".join(agent.get("readiness") or [])
        if items is None:
            out.append(("wait", "GitHub runners", "runner capacity not decided yet"))
        else:
            active = sum(item["state"] == "active" for item in items)
            refused = next((item for item in items if (item["register"] or {}).get("exit") == 78), None)
            if CHOSEN.search(issues):
                out.append(("off", "GitHub runners", "disabled or cordoned in Fleet settings"))
            elif refused:
                out.append(("fail", "GitHub runners", f"{refused['slot']}: {refused['register'].get('code')}"))
            elif active == len(items) and agent.get("readiness") == [] and reported and time.time() - reported < STALE:
                out.append(("ok", "GitHub runners", f"{active} of {len(items)} online in GitHub"))
            elif active == len(items):
                out.append(("wait", "GitHub runners", f"{active} of {len(items)} running here; GitHub not confirmed yet"))
            else:
                out.append(("wait", "GitHub runners", f"{active} of {len(items)} running here; registering"))
    if facts["failed"]:
        out.append(("fail", "Services", "failed: " + ", ".join(facts["failed"][:3])))
    out.append(recovery_row(facts.get("recovery")))
    return out


def recovery_row(kept):
    """One line on what the node recovered from (docs/resilience.md)."""
    if not kept:
        return ("unknown", "Recovery", "not recorded")
    gate = kept.get("gate") or {}
    if kept.get("quarantine"):
        return ("fail", "Recovery", "a kernel update is quarantined")
    if gate.get("closed"):
        return ("wait", "Recovery", "runner admission closed: " + (", ".join(gate.get("reasons") or []) or "no reason recorded"))
    if (kept.get("boot") or {}).get("previousClean") is False:
        return ("wait", "Recovery", "the last shutdown was not clean")
    if kept.get("outbox"):
        return ("wait", "Recovery", f"{kept['outbox']} event(s) not yet sent to Fleet")
    return ("ok", "Recovery", "nothing to recover from")


def words(facts, state, headline, width=screen.WIDTH):
    label = {"ready": "READY", "starting": "STARTING", "problem": "PROBLEM", "unknown": "UNKNOWN"}[state]
    uptime = facts["uptime"]
    title = f"FLEET NODE {facts['hostname']}: a {facts['role']} node, revision {facts['revision'][:8]}"
    lines = [screen.rule(width=width), " " + title, screen.rule(width=width)]
    lines += screen.labeled("STATUS", f"{label}. {headline}", width)
    lines.append(screen.rule("-", width))
    for mark, title, detail in rows(facts):
        lines.append(f"{' ' * screen.LABEL}{MARK[mark]} {title:<15} {detail}"[:width])
    lines.append(screen.rule("-", width))
    if state == "ready":
        lines += screen.labeled("ACTIONS", "Nothing to do. This node updates itself from Git and picks up CI jobs."
                                if facts["runners"] else "Nothing to do. This node updates itself from Git.", width)
    elif state == "starting":
        lines += screen.labeled("ACTIONS", f"Nothing to do yet. A new node is usually ready within a few minutes. "
                                           f"If it is not ready after {PATIENCE // 60} minutes, this screen offers a report.", width)
    else:
        found = problems(facts)
        steps = list(dict.fromkeys(action(code) for code, _, _ in found[:3])) or [UNKNOWN_ACTION]
        lines += [" ACTIONS"] + screen.bullets(steps, width)
    lines += screen.labeled("NEXT", f"This screen updates every {REFRESH} seconds. Up {screen.minutes(uptime) if uptime else 'unknown'}. "
                                    f"Over SSH: fleet-node-status.", width)
    lines.append(screen.rule("-", width))
    if facts["ssh"]:
        lines += screen.labeled("SSH", facts["ssh"], width)
    if facts["agePublic"]:
        lines += screen.labeled("AGE KEY", facts["agePublic"], width)
    return lines


# ---- the report --------------------------------------------------------------------

def report_lines(facts, state, headline):
    """Most useful first: a link that does not fit is cut from the end."""
    agent = facts["agent"]
    lines = [f"node {facts['hostname']} {facts['role']} rev={facts['revision'][:8]} state={state} "
             f"up={screen.short_time(facts['uptime'] or 0)}",
             "why " + headline]
    for code, sentence, temporary in problems(facts)[:6]:
        if human(sentence) not in headline:
            lines.append(f"issue {'temp' if temporary else 'lasting'} {sentence}")
    items = facts["slots"] or []
    if items:
        lines.append(f"slots {sum(item['state'] == 'active' for item in items)}/{len(items)} active")
    for item in items:
        last = item["register"] or {}
        if item["state"] != "active" or item["restarts"] or last.get("exit"):
            lines.append(f"{item['slot']} {item['state']} restarts={item['restarts']} register={last.get('code', '-')}"
                         f" exit={last.get('exit', '-')}")
    lines.append(f"fleet agent={facts['agentActive'] or '?'} outcome={agent.get('outcome', '-')} approval={agent.get('approval', '-')} "
                 f"last={agent.get('lastSuccessAt', '-')} failures={agent.get('failures', '-')} error={agent.get('lastError') or '-'}")
    net = facts["network"]
    lines.append(f"net route={net['device'] or 'none'} {'wifi' if net['wifi'] else 'wired'} "
                 f"interfaces={','.join(name for name, _ in net['addresses']) or '-'}")
    lines.append(f"sync last={facts['sync']['lastSuccess'][:8] or '-'} failure={facts['sync']['failure'][:200] or '-'}")
    if facts["failed"]:
        lines.append("failed " + " ".join(facts["failed"]))
    lines.append(screen.machine_report())
    installed = next((line for line in read(paths()["state"] / "logs/install.log", 65536).splitlines() if " handoff " in line), "")
    if installed:
        lines.append("installed " + installed[:200])
    unit = next((f"github-runner-{item['slot']}.service" for item in facts["slots"] or [] if item["state"] != "active"),
                facts["failed"][0] if facts["failed"] else "")
    if unit:
        _, journal = run(["journalctl", "--unit", unit, "--lines", "8", "--output", "cat", "--no-pager", "--quiet"])
        lines += [f"journal {unit} | " + " | ".join(clean(line) for line in journal.splitlines()[-8:])]
    return [decide.redact(line) for line in lines]


def clean(line):
    """Journal text for a public report: long opaque strings could be credentials."""
    return re.sub(r"[A-Za-z0-9+/=_-]{32,}", "[redacted]", line.strip())[:160]


def link(facts, state, headline, budget):
    code = next((item[0] for item in problems(facts)), "") or state
    title = f"Fleet node console: {code} ({facts['role']})"
    return decide.issue_form_url_within(title, f"Node console: {state}", "\n".join(report_lines(facts, state, headline)),
                                        budget, "(cut to fit the code; over SSH, fleet-node-status --report has the rest)")


def render(size=None):
    """(lines for the console, plain lines) for the node as it is now."""
    facts = gather()
    state, headline = verdict(facts)
    size = size or screen.console_size(os.environ.get("FLEET_CONSOLE") or "/dev/tty1")
    if state in ("ready", "starting"):
        text = words(facts, state, headline, min(screen.WIDTH, size[0] - 1))
        return text, text
    return screen.report_layout(lambda width: words(facts, state, headline, width),
                                lambda budget: link(facts, state, headline, budget), size,
                                no_room="Over SSH, fleet-node-status --report prints the report link.")


def draw(lines, plain):
    target = os.environ.get("FLEET_CONSOLE") or "/dev/tty1"
    try:
        with open(target, "a", encoding="utf-8", errors="replace") as console:
            console.write(("\033[H\033[2J" if target.startswith("/dev/") else "") + "\n".join(lines) + "\n")
    except OSError:
        print("\n".join(plain))


def main(argv):
    command = argv[0] if argv else "status"
    if command == "watch":
        drawn = None
        while True:
            try:
                lines, plain = render()
                if lines != drawn:  # an unchanged screen is not redrawn: no flicker
                    draw(lines, plain)
                    drawn = lines
            except Exception as exc:  # the screen must outlive any surprise
                print(f"fleet-node-console: {type(exc).__name__}: {decide.redact(exc)}", file=sys.stderr, flush=True)
            time.sleep(REFRESH)
    if command == "once":
        draw(*render())
        return 0
    if command == "status":
        facts = gather()
        state, headline = verdict(facts)
        print("\n".join(words(facts, state, headline)))
        if "--report" in argv[1:] or state in ("problem", "unknown"):
            print()
            print("Report: " + link(facts, state, headline, decide.ISSUE_URL_MAX))
        return 0 if state == "ready" else 1
    print("usage: fleet-node-console watch|once|status [--report]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
