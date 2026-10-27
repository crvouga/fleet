#!/usr/bin/env python3
"""What the person in front of the live installer sees, and how they report it.

fleet-auto.sh calls `step`, `wait`, `stopped`, `stayed` and `done` as the
installation moves, and `tick` redraws the current screen (fleet-wifi-ready
calls it too, as each network check changes). Every screen has the same parts:
the seven steps with the current one marked, a DISK line that says whether the
internal disk has been erased, what is happening now with its own checks, what
the person can do, and the keys. Nothing before step 5 says or implies that the
disk is being erased. `status`, `report`, `wifi`, `retry` and `return` are the
commands the person types at a prompt (fleet-status, fleet-report, fleet-wifi,
fleet-retry, fleet-return).

Screens are written to the console device directly. systemd's journal+console
prefixes every line with the unit name and PID, which made text noisy and a QR
code unscannable. Nothing here reads a token, key or Wi-Fi password; everything
shown or put into an issue link passes through decide.redact, and the Wi-Fi
network name is shown on this screen but never put into a report.
"""
import json
import math
import os
import re
import struct
import subprocess
import sys
import textwrap
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import decide  # noqa: E402

UNIT = "fleet-auto-install.service"
FLEET_NODES = os.environ.get("FLEET_API_URL", "").rstrip("/") + "/nodes"
WIDTH = 78
LABEL = 9  # " ACTIONS " and the indent under it
# What a 1024x768 framebuffer shows with the default 8x16 font, used when the
# console cannot be asked. The Linux console has no scrollback.
FALLBACK_SIZE = (128, 48)
# Bytes a QR code holds at version N with error correction L. A version is
# 17 + 4N modules wide; with a 2-module margin and two modules per text row it
# needs 21 + 4N columns and half as many rows. Above 25 a phone struggles with
# a photo of a screen.
QR_CAPACITY = {10: 271, 11: 321, 12: 367, 13: 425, 14: 458, 15: 520, 16: 586, 17: 644, 18: 718, 19: 792,
               20: 858, 21: 929, 22: 1003, 23: 1091, 24: 1171, 25: 1273}
REPORT_NOTE = "(cut to fit the code; fleet-report --full has the rest)"
# (id, title, what the person does). "{role}" is the role being installed.
STEPS = (
    ("network", "Connect to the network",
     "Nothing to do yet. Keep this computer near the Wi-Fi it used before."),
    ("approval", "Read this node's approval",
     "Nothing to do. This uses the approval from the GitHub enrollment issue."),
    ("checks", "Check Fleet, the update cache and GitHub",
     "Nothing to do. This usually takes less than two minutes."),
    ("disk", "Find the internal disk",
     "Nothing to do. This only looks at the disks."),
    ("erase", "Erase the internal disk",
     "Do not turn the computer off from now on."),
    ("install", "Install the {role} system",
     "Do not turn the computer off. This usually takes 5 to 20 minutes; this screen updates every 30 seconds."),
    ("restart", "Restart into the new {role} node",
     "Nothing to do. Remove any USB stick. The node appears in Fleet a few minutes after it starts."),
)
STEP_IDS = tuple(step[0] for step in STEPS)
REDRAWN_STEPS = ("network", "checks", "erase", "install")
CABLE = "Plug in a network cable, or a phone with USB tethering turned on: either is used at once."
CHOOSE = "Press Alt+F2, type fleet-wifi, choose a Wi-Fi network and type its password. Alt+F1 comes back here."
# fleet-wifi-ready's codes (wizard/fleet_wifi.py): (summary, what the person can do).
NETWORK_ADVICE = {
    "no-settings": ("No Wi-Fi settings came from {origin}.", [CHOOSE, CABLE]),
    "settings-lost": ("Wi-Fi settings were sent from {origin} but did not reach the installer.",
                      [CHOOSE, CABLE, "Report it: this is a bug in the installer."]),
    "refused": ("The Wi-Fi network refused the saved password.",
                ["Press Alt+F2, type fleet-wifi, choose the network and type its current password. "
                 "Alt+F1 comes back here.", CABLE]),
    "not-visible": ("The Wi-Fi network it used before is not in range.",
                    ["Move this computer closer to the Wi-Fi router.", CHOOSE, CABLE]),
    "radio-off": ("Wi-Fi is switched off on this computer.",
                  ["Turn Wi-Fi on with the wireless switch or key (often Fn and a key with an antenna).", CABLE]),
    "adapter-unavailable": ("Linux cannot use this computer's Wi-Fi adapter yet.",
                            [CABLE, "Report it: the report names the adapter so support can be added."]),
    "no-driver": ("Linux has no driver for this computer's Wi-Fi adapter.",
                  [CABLE, "Report it: the report names the adapter so support can be added."]),
    "no-adapter": ("Linux found no Wi-Fi adapter on this computer.",
                   [CABLE, "Report it: the report lists the hardware so support can be added."]),
    "no-address": ("Connected, but the network gave this computer no address.", [CHOOSE, CABLE]),
    "internet": ("Connected, but the internet cannot be reached.",
                 ["A network with a sign-in page (hotel, school, guest) cannot be used. " + CHOOSE, CABLE]),
    "timeout": ("Wi-Fi did not finish connecting.", ["Wait: it tries again by itself.", CHOOSE, CABLE]),
    "no-connect": ("Wi-Fi did not connect.", ["Wait: it tries again by itself.", CHOOSE, CABLE]),
}
NETWORK_CHECKS = (("adapter", "Wi-Fi adapter"), ("settings", "Saved Wi-Fi"), ("visible", "Network in range"),
                  ("connect", "Connect"), ("internet", "Internet"))
MARKS = {"ok": "[x]", "active": "[~]", "fail": "[!]", "unknown": "[?]"}
# (pattern in the reason, summary, steps). The first match wins.
ADVICE = (
    (r"FLEET_NETWORK_UNAVAILABLE|Waiting for Wi-Fi|network preflight|Wi-Fi setup failed",
     "This computer is not online yet.", [CHOOSE, CABLE]),
    (r"FLEET_CACHE_UNAVAILABLE",
     "The update cache cannot be reached, or does not have this installer's system yet.",
     ["A new release usually reaches the cache within a few minutes; waiting is often enough.",
      "If it keeps failing, report it: the release may be ahead of the cache."]),
    (r"FLEET_API_UNAVAILABLE",
     "Your Fleet controller cannot be reached.",
     ["Wait; the installer tries again by itself.", "Check your Fleet controller on a phone. If it is down, report it."]),
    (r"FLEET_GITHUB_UNAVAILABLE",
     "GitHub cannot be reached or is limiting requests.",
     ["Wait; the installer tries again by itself."]),
    (r"FLEET_GITHUB_REGISTRATION|FLEET_GITHUB_KEY|FLEET_GITHUB_SCOPE",
     "GitHub refused to register this computer as a CI runner.",
     ["The repository owner checks the runner GitHub App installation and its repository access.",
      "Then open the Fleet installer in the original system again."]),
    (r"FLEET_APPROVAL_REQUIRED",
     "Fleet has not approved this computer.",
     [f"Open {FLEET_NODES}, approve this computer under Pending.", "Then open the Fleet installer in the original system again."]),
    (r"enrollment token|FLEET_ENROLLMENT|did not hold an age key",
     "The one-time approval was refused, expired or already used.",
     ["Open the Fleet installer in the original system again; it asks for a fresh approval on GitHub."]),
    (r"FLEET_NETWORK_WAIT_EXPIRED",
     "The checks before erasing were still not ready when the wait ran out.",
     ["Open the Fleet installer in the original system again to retry.", "Report it with the code: it says which check was not ready."]),
    (r"FLEET_ROLE_SECRETS|FLEET_ROLE_KEY|FLEET_PLATFORM_NOT_READY|FLEET_METADATA|FLEET_LOCAL_CLOSURE_UNAVAILABLE|FLEET_BOOTSTRAP_INVALID|FLEET_CACHE_UNCONFIGURED|FLEET_API_UNCONFIGURED|FLEET_GITHUB_UNCONFIGURED",
     "The published installer is not ready for this kind of node. A maintainer has to fix it.",
     ["Report it with the QR code. Nothing on this computer needs to change."]),
    (r"public key|devbox",
     "A devbox needs an SSH public key before anything is erased.",
     ["Use your .pub file in the Fleet installer, or put devbox.pub on a FLEET-KEY USB stick."]),
    (r"UEFI|x86-64",
     "This computer did not start in UEFI mode.",
     ["Turn on UEFI and turn off legacy/CSM boot in the firmware settings."]),
)
UNKNOWN = ("The installer stopped.", ["Report it with the QR code; the report says where it stopped."])


def env_path(name, default):
    return Path(os.environ.get(name) or default)


def state_dir():
    return env_path("FLEET_LIVE_STATE", "/run/fleet-live")


def install_log():
    return env_path("FLEET_INSTALL_LOG", "/run/fleet-install.log")


def erased():
    return Path(str(install_log()) + ".erasing").exists()


def read_text(path, limit=65536):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - limit))
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


def read_json(path):
    try:
        data = json.loads(Path(path).read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def load_state():
    return read_json(state_dir() / "state.json")


def load_network():
    """What fleet-wifi-ready checked on this boot (wizard/fleet_wifi.py, Facts)."""
    return read_json(state_dir() / "network.json")


def save_state(**changes):
    data = {**load_state(), **changes, "updated": int(time.time())}
    folder = state_dir()
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / "state.json.new"
    temporary.write_text(json.dumps(data))
    temporary.chmod(0o644)  # no secrets: the person's own login reads it
    temporary.replace(folder / "state.json")
    return data


def cmdline():
    return read_text(os.environ.get("FLEET_CMDLINE") or "/proc/cmdline", 8192).split()


def cmdline_value(name):
    values = [word.split("=", 1)[1] for word in cmdline() if word.startswith(name + "=")]
    return values[-1] if values else ""


def role():
    value = cmdline_value("fleet.role")
    return value if value in decide.ROLES else "unknown"


def started_from():
    origin = cmdline_value("fleet.from")
    if origin in ("windows", "linux"):
        return origin
    if cmdline_value("fleet.enroll"):
        return "linux" if cmdline_value("findiso") else "windows"
    return "usb"


def original_system():
    return {"windows": "Windows", "linux": "the original Linux system"}.get(started_from(), "the original system")


def settings_source():
    return {"windows": "Windows", "linux": "the original Linux system"}.get(started_from(), "the USB stick")


def capital(text):
    return text[:1].upper() + text[1:]


def revision():
    manifest = env_path("FLEET_MANIFEST", "/iso/fleet-install-manifest")
    for line in read_text(manifest, 8192).splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == role():
            text = read_text(Path(parts[1]) / "etc/fleet/revision", 128).strip()
            if re.fullmatch(r"[0-9a-f]{7,40}|unknown", text):
                return text
    return "unknown"


def reason():
    """The most specific explanation on record: the installer's own diagnostic,
    else the last line of this attempt that names a code or a next step."""
    diagnostic = read_text(str(install_log()) + ".diagnostic", 2048).strip()
    if diagnostic:
        return decide.redact(diagnostic.splitlines()[0])[:400]
    lines = read_text(state_dir() / "attempt.log", 16384).splitlines()
    for line in reversed(lines):
        if re.search(r"FLEET[_-][A-Z_]+|^Next:|Waiting for|refused|Refusing|failed", line):
            return decide.redact(line.strip())[:400]
    return ""


def code(text):
    found = re.search(r"FLEET[_-][A-Z_]+", text or "")
    return found.group(0) if found else ""


def network_trouble(data, why=""):
    """The network check's own verdict when the network is what is not ready."""
    net = load_network()
    if net.get("code") in (None, "", "ready", "checking"):
        return None
    if data.get("step") == "network" or "NETWORK" in (why or "") or "NETWORK" in (data.get("lastWait") or ""):
        return net
    return None


def advice(text, data=None):
    net = network_trouble(data or {}, text)
    if net and net.get("code") in NETWORK_ADVICE:
        summary, steps = NETWORK_ADVICE[net["code"]]
        return summary.format(origin=settings_source()), steps
    for pattern, summary, steps in ADVICE:
        if re.search(pattern, text or ""):
            return summary, steps
    return UNKNOWN


def step_title(step_id):
    for number, (ident, title, _) in enumerate(STEPS, 1):
        if ident == step_id:
            return number, title.format(role=role())
    return 0, "Starting"


def step_label(data):
    number, title = step_title(data.get("step"))
    return f"step {number} of {len(STEPS)}, {title}" if number else "starting"


def minutes(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60} min {seconds % 60} s" if seconds >= 60 else f"{seconds} s"


def short_time(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60}m{seconds % 60:02d}s"


def labeled(label, text, width=WIDTH):
    """A section line: the label in its own column, the text wrapped beside it."""
    return textwrap.wrap(text, width, initial_indent=f" {label:<{LABEL - 2}} ", subsequent_indent=" " * LABEL,
                         break_on_hyphens=False) or [f" {label}"]


def bullets(items, width=WIDTH):
    lines = []
    for number, text in enumerate(items, 1):
        lines += textwrap.wrap(text, width, initial_indent=" " * LABEL + f"{number}. ", subsequent_indent=" " * (LABEL + 3),
                               break_on_hyphens=False)
    return lines


# ---- screens --------------------------------------------------------------------

def rule(char="=", width=WIDTH):
    return char * width


def header(data, title=None, width=WIDTH):
    title = title or f"FLEET INSTALLER: making this computer a {role()} node"
    started = data.get("started")
    clock = minutes(time.time() - started) if started else ""
    return [rule(width=width), " " + title.ljust(width - len(clock) - 2) + clock, rule(width=width)]


def checklist(data, mark="[>]"):
    current = data.get("step")
    index = STEP_IDS.index(current) if current in STEP_IDS else -1
    done_all = data.get("outcome") == "installed"
    rows = []
    for number, (ident, title, _) in enumerate(STEPS, 1):
        position = STEP_IDS.index(ident)
        box = "[x]" if position < index or done_all else mark if position == index else "[ ]"
        row = f"  {box} {number}. {title.format(role=role())}"
        if ident == "erase" and position > index and not erased():
            row = row.ljust(36) + "<- the first step that changes the disk"
        rows.append(row)
    return rows


def disk_text(data):
    """The one line that says whether anything has been erased. Every screen has it."""
    if data.get("outcome") == "installed":
        return f"Erased, and the new {role()} system is installed on it."
    if data.get("step") == "erase" and not data.get("outcome"):
        return "ERASING NOW. Everything on the internal disk is being removed. Do not turn the computer off."
    if erased():
        gone = f"{capital(original_system())} is no longer on this computer." if started_from() != "usb" else "Its old contents are gone."
        return "Erased. " + gone + ("" if data.get("outcome") else " Do not turn the computer off.")
    kept = (f"{capital(original_system())} is still on this computer." if started_from() != "usb"
            else "Everything on the internal disk is still there.")
    return f"Not erased. {kept} Nothing is erased until steps 1 to 4 have passed."


def network_rows(net, width=WIDTH):
    """The network step's own checks, with the network name: this screen only."""
    if not net:
        return []
    checks = net.get("checks") or {}
    rows = []
    for name, title in NETWORK_CHECKS:
        entry = checks.get(name)
        if entry is None:
            if name == "internet" or net.get("via"):
                continue
            mark, detail = "[ ]", ""
        else:
            mark, detail = MARKS.get(entry.get("state"), "[ ]"), entry.get("detail") or ""
        profile = net.get("profile") or {}
        if name == "settings" and entry and entry.get("state") == "ok" and profile.get("ssid"):
            detail = f"\"{profile['ssid']}\", {detail}, from {settings_source()}"
        elif name == "settings":
            detail = f"{detail}, from {settings_source()}" if detail else ""
        rows.append(f"{' ' * LABEL}{mark} {title:<17} {detail}"[:width])
    return rows


def now_lines(data, net):
    number, title = step_title(data.get("step"))
    since = data.get("stepStarted")
    waiting = data.get("outcome") == "waiting"
    text = f"Step {number} of {len(STEPS)}: {title}" if number else "Starting"
    if since and not waiting:
        text += f" ({minutes(time.time() - since)} so far)"
    lines = labeled("NOW", text)
    if waiting:
        why = data.get("reason") or "A check before erasing is not ready yet."
        summary, _ = advice(why, data)
        lines += labeled("WAITING", f"Attempt {data.get('attempt', 1)} is not ready: {summary}")
        lines += labeled("WHY", re.sub(r"^FLEET_[A-Z_]+:\s*", "", why)[:240])
    if data.get("step") == "network":
        lines += network_rows(net)
    return lines


def actions(data):
    number, _ = step_title(data.get("step"))
    if data.get("outcome") == "waiting" or (data.get("step") == "network" and network_trouble(data)):
        _, steps = advice(data.get("reason") or "", data)
        return [" ACTIONS"] + bullets(steps)
    hint = STEPS[number - 1][2] if number else "Nothing to do."
    if data.get("step") == "network":
        return labeled("ACTIONS", hint) + bullets(["Prefer a cable? " + CABLE, "Another Wi-Fi network? " + CHOOSE])
    return labeled("ACTIONS", hint)


def next_lines(data):
    if erased() or data.get("outcome") == "installed":
        return []
    remaining = math.ceil((data.get("deadline") or 0) - time.time())
    after = (f"restarts into {original_system()} so nothing is left half done"
             if started_from() != "usb" else "stops here and shows what to do")
    if data.get("outcome") == "waiting":
        return labeled("NEXT", f"Tries again in {data.get('retry', 30)} s. If it is still not ready in "
                               f"{minutes(remaining)}, it {after}. Nothing is erased either way.")
    if data.get("deadline") and remaining > 0 and data.get("step") in STEP_IDS[:4]:
        return labeled("NEXT", f"Attempt {data.get('attempt', 1) + 1}. If it is still not ready in {minutes(remaining)}, "
                               f"it {after}. Nothing is erased either way.")
    return []


def key_lines():
    return labeled("KEYS", "Alt+F2 opens a command prompt: fleet-status explains this screen, fleet-wifi chooses a "
                           "Wi-Fi network, fleet-report makes a problem report. Alt+F1 comes back here.")


def screen_step(data, footer=()):
    net = load_network() if data.get("step") == "network" else {}
    mark = "[~]" if data.get("outcome") == "waiting" else "[>]"
    lines = [*header(data), *checklist(data, mark), rule("-"), *labeled("DISK", disk_text(data)), rule("-"),
             *now_lines(data, net), ""]
    lines += actions(data) + next_lines(data) + list(footer) + [rule("-"), *key_lines()]
    return lines


def screen_wait(data):
    return screen_step(data)


def screen_done(data):
    lines = [*header(data), *checklist(data), rule("-"), *labeled("DISK", disk_text(data)), rule("-"),
             *labeled("NOW", f"Installed. Restarting into the new {role()} node now."),
             *labeled("ACTIONS", "Nothing else to do. Remove any USB stick. If the computer starts this installer "
                                 "again, remove the stick and restart."),
             *labeled("NEXT", f"After the restart this screen shows the node's own status: READY once it is "
                              f"{'online with its runners in GitHub' if role() == 'ci' else 'reporting to Fleet'}, or what is "
                              f"wrong and a code to report it. The node appears in Fleet at {FLEET_NODES} a few minutes later.")]
    return lines


def screen_stayed():
    return ["", " Staying in the installer. A command prompt opens next.",
            "   fleet-status  explains what happened",
            "   fleet-wifi    chooses a Wi-Fi network",
            "   fleet-report  GitHub issue link and QR code",
            "   fleet-retry   tries the installation again (only before anything is erased)",
            "   fleet-return  restarts into the original system (only before anything is erased)"]


def stop_text(data, width):
    """The stop screen's words: what happened, whether the disk was touched, what to do."""
    why = data.get("reason") or f"The installer exited with status {data.get('status', '?')}."
    why = re.sub(r"\s*\(?[Rr]etrying (automatically )?before disk changes\.?\)?|;? retrying before disk changes", "", why).strip()
    if erased():
        summary = "Installation failed after the internal disk was erased."
        steps = ["Report it now with the code. Do not try to start the original system: it was erased.",
                 "Then make an install USB with the Fleet installer on another computer, start this computer "
                 f"from it and choose {role()}."]
    else:
        summary, steps = advice(why, data)
    net = network_trouble(data, why)
    detail = net.get("verdict") if net else ""
    if not detail and code(why) == "FLEET_NETWORK_WAIT_EXPIRED" and data.get("lastWait"):
        detail = "Last check not ready: " + re.sub(r"^FLEET_[A-Z_]+:\s*", "", data["lastWait"])
    number, title = step_title(data.get("step"))
    where = f"at step {number} of {len(STEPS)}: {title}" if number else "before its first step"
    lines = [rule(width=width), *textwrap.wrap(f"FLEET INSTALLER STOPPED {where}", width, initial_indent=" ",
                                               subsequent_indent=" "), rule(width=width)]
    lines += labeled("DISK", disk_text(data), width)
    lines += labeled("WHAT", summary, width)
    lines += labeled("WHY", f"{detail} ({why[:200]})" if detail else why[:240], width)
    lines += [" ACTIONS"] + bullets(steps, width)
    returning = int(data.get("returning") or 0)
    if returning and not erased():
        lines += labeled("NEXT", f">>> Restarts into {original_system()} in {minutes(returning)}. Press Enter to stay here "
                                 "instead." + (" Back in Windows, open the Fleet installer again: it cleans up and you "
                                               "can try again." if started_from() == "windows" else ""), width)
    elif not erased():
        lines += labeled("NEXT", "fleet-retry tries again; fleet-return restarts into the original system "
                                 "(remove any USB stick first).", width)
    return lines


def compact_checklist(data):
    current = data.get("step")
    index = STEP_IDS.index(current) if current in STEP_IDS else -1
    rows = []
    for number, (ident, title, _) in enumerate(STEPS, 1):
        position = STEP_IDS.index(ident)
        box = "[x]" if position < index else "[!]" if position == index else "[ ]"
        rows.append(f"  {box} {number}. {title.format(role=role())}")
    return rows


def qr_side(version):
    return 17 + 4 * version + 4


def qr_budget(columns, rows):
    """(version, longest link) whose QR code fits columns x rows character cells."""
    best = (0, 0)
    for version, capacity in QR_CAPACITY.items():
        if qr_side(version) <= columns and math.ceil(qr_side(version) / 2) <= rows:
            best = (version, capacity)
    return best


def visible(line):
    return len(re.sub(r"\033\[[0-9;]*m", "", line))


def fitted_qr(columns, rows, link):
    """The largest report link whose QR code fits, and the code's lines.
    link(budget) returns the report's issue link cut to at most `budget` characters."""
    _, budget = qr_budget(columns, rows)
    while budget >= QR_CAPACITY[10]:
        url = link(budget)
        lines = qr_lines(url)
        if lines and len(lines) <= rows and max(visible(line) for line in lines) <= columns:
            return url, lines
        if not lines:
            return url, []
        budget = int(budget * 0.9)
    return link(QR_CAPACITY[10]), []


REPORT_TEXT = ("Scan the code with a phone camera. It opens a GitHub issue filled in with what this screen "
               "knows (no passwords, tokens or network names). Add a photo of this screen.")


def report_layout(words, link, size, extra=(), no_room="The report code does not fit this screen."):
    """words(width) and the biggest QR code for link(budget) that fit one screen:
    beside the words when the console is wide, under them otherwise. `extra`
    lines are added when there is room. Returns (lines, plain)."""
    columns, rows = size
    side_columns = columns - 50
    if side_columns >= qr_side(10) and qr_budget(side_columns, rows - 1)[0]:
        version, _ = qr_budget(side_columns, rows - 1)
        width = min(WIDTH, columns - qr_side(version) - 2)
        text = words(width) + [""] + labeled("REPORT", REPORT_TEXT, width)
        if extra and len(text) + len(extra) + 1 <= rows - 1:
            text += [""] + list(extra)
        text = text[:rows - 1]
        _, qr = fitted_qr(columns - width - 2, rows - 1, link)
        if qr:
            lines = [left.ljust(width) + "  " + (qr[i] if i < len(qr) else "")
                     for i, left in enumerate(text + [""] * max(0, len(qr) - len(text)))]
            return [line.rstrip() if "\033[" not in line else line for line in lines], text
    width = min(WIDTH, columns - 1)
    text = words(width)
    _, qr = fitted_qr(columns - 1, rows - len(text) - 3, link)
    text += labeled("REPORT", REPORT_TEXT if qr else no_room, width)
    return text + qr, text


def screen_stopped(data, size=None):
    """The stop screen's words and the biggest report code that fits beside or under them."""
    return report_layout(lambda width: stop_text(data, width), lambda budget: issue(False, budget), size or console_size(),
                         compact_checklist(data),
                         "Press Alt+F2 and type fleet-report: the report code does not fit beside this text.")


def console_size(target=None):
    """(columns, rows) of the screen the installer draws on."""
    forced = re.fullmatch(r"(\d+)x(\d+)", os.environ.get("FLEET_CONSOLE_SIZE", ""))
    if forced:
        return int(forced.group(1)), int(forced.group(2))
    try:
        import fcntl
        import termios
        if target is None:
            target = os.environ.get("FLEET_CONSOLE") or "/dev/console"
        descriptor = os.open(target, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK) if isinstance(target, str) else target
        try:
            rows, columns = struct.unpack("hhhh", fcntl.ioctl(descriptor, termios.TIOCGWINSZ, bytes(8)))[:2]
        finally:
            if isinstance(target, str):
                os.close(descriptor)
        if columns >= 60 and rows >= 20:
            return columns, rows
    except (ImportError, OSError):
        pass
    return FALLBACK_SIZE


def qr_lines(url):
    tool = os.environ.get("FLEET_QRENCODE") or "qrencode"
    try:
        done = subprocess.run([tool, "-t", "ANSIUTF8", "-m", "2", "-l", "L", "-o", "-", url],
                              capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return done.stdout.splitlines() if done.returncode == 0 else []


def draw(lines, clear=True, plain=None):
    """Write to the console device; the journal gets a plain copy without the QR code."""
    text = "\n".join(lines) + "\n"
    target = os.environ.get("FLEET_CONSOLE") or "/dev/console"
    try:
        with open(target, "a", encoding="utf-8", errors="replace") as console:
            console.write(("\033[H\033[2J" if clear and target.startswith("/dev/") else "") + text)
    except OSError:
        sys.stderr.write(text)
    if plain is None:
        plain = [line for line in lines if "\033[" not in line]
    print("\n".join(plain), flush=True)


# ---- reports ----------------------------------------------------------------------

def outcome_text(data):
    outcome = data.get("outcome")
    status = data.get("status")
    if outcome == "waiting":
        return f"waiting before erasing (attempt {data.get('attempt', 1)})"
    if outcome in ("stopped", "stayed"):
        return f"stopped {'after' if erased() else 'before'} erasing (exit {status})"
    if outcome == "installed":
        return "installed; restarting"
    return "running" if data else "not started"


def network_report(net, compact):
    """The network check without the network name. Compact keys are listed in docs/debugging.md."""
    if not net:
        return ["net none: no network check recorded on this boot"]
    checks = net.get("checks") or {}
    profile = net.get("profile") or {}
    scan = net.get("scan")
    seen = ("?" if scan is None else
            f"{scan.get('signal')}%,{scan.get('band', '').replace(' ', '')},{scan.get('security')}" if scan.get("visible")
            else "no")
    nearby = scan.get("nearby", 0) if scan else "?"
    details = []
    tries = []
    for item in net.get("attempts") or []:
        tries.append(f"{item.get('auth')}{'/hidden' if item.get('hidden') else ''}:{item.get('result')}")
        if item.get("detail") and item["detail"] not in details:
            details.append(item["detail"])
    nics = [f"{item.get('name')} {item.get('type')} {item.get('driver')} {str(item.get('id')).replace(' ', '')} "
            f"{item.get('link')}{'+carrier' if item.get('carrier') else ''}" for item in net.get("adapters") or []]
    radios = " ".join(f"soft={int(r.get('soft', 0))},hard={int(r.get('hard', 0))}" for r in net.get("radios") or [])
    if compact:
        lines = [f"net {net.get('code', '?')} wifi={net.get('sent', '?')},{'arrived' if net.get('arrived') else 'missing'} "
                 f"auth={profile.get('auth', '-')}{'/hidden' if profile.get('hidden') else ''} seen={seen} nearby={nearby} "
                 f"run={net.get('run', '?')}"]
    else:
        lines = [f"Network verdict: {net.get('code', '?')}: {net.get('verdict') or '-'}",
                 f"Wi-Fi settings: sent={net.get('sent', '?')} arrived={'yes' if net.get('arrived') else 'no'} "
                 f"auth={profile.get('auth', '-')} hidden={'yes' if profile.get('hidden') else 'no'}",
                 f"Scan: seen={seen} nearby={nearby}; readiness run {net.get('run', '?')}"]
    if tries:
        lines.append("try " + " ".join(tries) + (f" ({'; '.join(details)})" if details else ""))
    lines.append("nic " + ("; ".join(nics) if nics else "none"))
    if net.get("driverless"):
        lines.append("nodriver " + "; ".join(str(item).replace(" ", "") for item in net["driverless"]))
    if radios:
        lines.append("rfkill " + radios)
    for name in ("adapter", "visible", "internet") if compact else ("adapter", "settings", "visible", "connect", "internet"):
        entry = checks.get(name)
        if entry and (entry.get("state") != "ok" or not compact):
            lines.append(f"check {name}={entry.get('state')}: {entry.get('detail', '')}")
    if net.get("via"):
        lines.append("via " + " ".join(net["via"]))
    lines += ["klog " + line for line in net.get("kernel") or []]
    lines.append(f"clock {net.get('clock', '?')}")
    return [decide.redact(line) for line in lines]


def machine_report():
    dmi = Path(os.environ.get("FLEET_SYS") or "/sys") / "class/dmi/id"
    machine = " ".join(read_text(dmi / name, 128).strip() for name in ("sys_vendor", "product_name")).strip()
    memory = re.search(r"MemTotal:\s+(\d+)", read_text("/proc/meminfo", 4096))
    ram = f"{int(memory.group(1)) // 1024}MiB" if memory else "?"
    return f"hw {machine or 'unknown'}; ram {ram}; kernel {os.uname().release}; efi {'yes' if Path('/sys/firmware/efi').is_dir() else 'no'}"


def log_tail(count, compact):
    lines = []
    for line in read_text(install_log()).splitlines()[-count:]:
        line = decide.redact(line)
        line = re.sub(r"/nix/store/[a-z0-9]{32}-", "", line)
        if compact:
            line = re.sub(r"^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)Z\s+", r"\1 ", line)
        lines.append(line)
    return lines


def handoff_tags():
    """The wizard attempt and build that sent this boot (decide._boot_command):
    search the wizard's log for attempt=<id>."""
    tags = [f"{name}={cmdline_value('fleet.' + name)}" for name in ("wizard", "attempt") if cmdline_value("fleet." + name)]
    return (" " + " ".join(tags)) if tags else ""


def report_lines(full):
    """The report, most useful first: a link that does not fit is cut from the end."""
    data = load_state()
    started = data.get("started")
    why = reason() or data.get("reason") or "none recorded"
    net = load_network()
    network_first = data.get("step") == "network" or "NETWORK" in why or "NETWORK" in (data.get("lastWait") or "")
    elapsed = short_time(time.time() - started) if started else "?"
    if not full:
        # Every character costs QR modules. The title carries the FLEET_* code.
        number, _ = step_title(data.get("step"))
        where = "after-erase" if erased() else "before-erase"
        summary = [f"{role()} {revision()[:8]} {started_from()} {data.get('outcome') or 'running'}-{where} "
                   f"exit={data.get('status', '-')} step={number}/{len(STEPS)} t={elapsed} tries={data.get('attempt', 1)}"]
        last = data.get("lastWait") or ""
        if not network_trouble(data, why):  # otherwise the net line below says it better
            short = re.sub(r"^FLEET[_-][A-Z_]+:\s*|\s*Nothing (was|has been) erased[^.]*\.", "", why).strip()
            summary.append("why " + short[:200])
            if last and last != why:
                summary.append("lastwait " + re.sub(r"\s*Nothing (was|has been) erased.*$", "", last)[:160])
        logs = ["log " + " | ".join(log_tail(8, True))]
        machine = [machine_report()] + (["handoff" + handoff_tags()] if handoff_tags() else [])
        if network_first:
            return summary + network_report(net, True) + machine + logs
        return summary + logs + machine + network_report(net, True)[:3]
    out = [
        "Source: live installer screen (packages/fleet/scripts/fleet-auto.sh, fleet-install.sh, live_console.py)",
        f"Started from: {started_from()}{handoff_tags()}",
        f"Role: {role()}",
        f"Revision: {revision()}",
        f"Step: {step_label(data)}",
        f"Outcome: {outcome_text(data)}",
        f"Erased: {'yes' if erased() else 'no'}",
        f"Reason: {why}",
        f"Elapsed: {minutes(time.time() - started) if started else 'unknown'}",
        f"Attempts: {data.get('attempt', 1)}",
    ]
    if data.get("lastWait"):
        out.append(f"Last wait: {data['lastWait']}")
    out += [machine_report(), "", "## Network check", *network_report(net, False),
            "", "## Install log (last 40 lines)", *log_tail(40, False),
            "", "## Last attempt output (last 30 lines)",
            *[decide.redact(line) for line in read_text(state_dir() / "attempt.log").splitlines()[-30:]]]
    return out


def issue(full, limit=None):
    data = load_state()
    why = reason() or data.get("reason") or ""
    net = network_trouble(data, why)
    title = "Fleet installer screen: " + (code(why) or advice(why, data)[0].rstrip("."))
    if net and net.get("code"):
        title += f" ({net['code']})"
    step = f"Installer screen: {step_label(data) if full else step_label(data).split(',')[0]}"
    text = "\n".join(report_lines(full))
    if full:
        return decide.issue_form_url_within(title, step, text)
    return decide.issue_form_url_within(title, step, text, limit or QR_CAPACITY[12], REPORT_NOTE)


# ---- commands ---------------------------------------------------------------------

def unit_active():
    tool = os.environ.get("FLEET_SYSTEMCTL") or "systemctl"
    try:
        return subprocess.run([tool, "is-active", "--quiet", UNIT], timeout=10, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def as_root(command):
    return command if os.geteuid() == 0 else ["sudo", "-n", *command]


def cmd_step(args):
    if not args or args[0] not in STEP_IDS:
        print("usage: fleet-live step " + "|".join(STEP_IDS), file=sys.stderr)
        return 2
    now = int(time.time())
    data = load_state()
    data = save_state(step=args[0], stepStarted=now, started=data.get("started") or now, outcome=None, reason="")
    draw(screen_step(data))
    return 0


def cmd_wait(args):
    values = dict(zip(args[::2], args[1::2]))
    remaining = int(values.get("--remaining", 0))
    why = reason()
    data = save_state(outcome="waiting", reason=why, lastWait=why, attempt=int(values.get("--attempt", 1)),
                      remaining=remaining, deadline=int(time.time()) + remaining, retry=int(values.get("--retry", 30)))
    draw(screen_wait(data))
    return 0


def cmd_stopped(args):
    values = dict(zip(args[::2], args[1::2]))
    data = save_state(outcome="stopped", reason=reason(), status=int(values.get("--status", 1)),
                      returning=int(values.get("--returning", 0)))
    lines, plain = screen_stopped(data)
    draw(lines, plain=plain)
    return 0


def cmd_stayed(_):
    save_state(outcome="stayed", returning=0)
    draw(screen_stayed(), clear=False)
    return 0


def cmd_done(_):
    data = save_state(step="restart", outcome="installed", stepStarted=int(time.time()))
    draw(screen_done(data))
    return 0


def cmd_tick(_):
    data = load_state()
    if data.get("outcome") == "waiting":
        draw(screen_wait(data))
        return 0
    if data.get("outcome") or data.get("step") not in REDRAWN_STEPS:
        return 0
    footer = []
    if data.get("step") != "network":
        latest = ""
        for line in reversed(read_text(install_log(), 8192).splitlines()):
            latest = re.sub(r"^\S+Z\s+", "", decide.redact(line)).strip()
            if latest:
                break
        latest = re.sub(r"/nix/store/[a-z0-9]{32}-", "", latest)
        elapsed = minutes(time.time() - (data.get("stepStarted") or time.time()))
        footer = [""] + labeled("WORKING", f"Still working: {elapsed} on this step." + (f" Latest: {latest[:60]}" if latest else ""))
    # Redraw rather than append: the console has no scrollback, and twenty
    # minutes of appended lines would push the steps off the screen.
    draw(screen_step(data, footer))
    return 0


def cmd_status(args):
    data = load_state()
    if not data:
        lines = ["No Fleet installation has started on this boot. Nothing was changed."]
        if not env_path("FLEET_MANIFEST", "/iso/fleet-install-manifest").exists():
            lines.append("This image carries no installer (for example the netboot ramdisk).")
    elif data.get("outcome") in ("stopped", "stayed"):
        lines = stop_text({**data, "returning": 0}, WIDTH) + ["", " Details:", *["   " + line for line in report_lines(True)[1:11]]]
    elif data.get("outcome") == "installed":
        lines = screen_done(data)
    else:
        lines = screen_step(data)
    if unit_active():
        lines += ["", " The installer is still running. Its screens appear on the visible console (Alt+F1)."]
    lines += ["", " Commands:",
              "   fleet-status   show this again",
              "   fleet-wifi     choose a Wi-Fi network and type its password",
              "   fleet-report   GitHub issue link and QR code for a problem (--full for a longer link)",
              "   fleet-retry    try the installation again (only before anything is erased)",
              "   fleet-return   restart into the original system (only before anything is erased)",
              f"   journalctl -u {UNIT}   everything the installer printed"]
    print("\n".join(lines))
    return 0


def cmd_report(args):
    full = "--full" in args
    print("Fleet installer problem report")
    print("Open this link (or scan the code) to create a pre-filled GitHub issue. Review it before submitting.")
    print()
    if full:
        url = issue(True)
    else:
        try:
            columns, rows = console_size(sys.stdout.fileno())
        except (OSError, ValueError):
            columns, rows = FALLBACK_SIZE
        url, qr = fitted_qr(columns - 1, rows - 4, lambda budget: issue(False, budget))
        print("\n".join(qr))
    print(url)
    print()
    print("\n".join(report_lines(True)))
    return 0


def cmd_wifi(_):
    print("Choose the Wi-Fi network, then type its password. The installer uses it on its next try, within a minute,")
    print("and the new node keeps it. Nothing is erased until every check passes.")
    tool = os.environ.get("FLEET_NMTUI") or "nmtui"
    try:
        done = subprocess.run(as_root([tool, "connect"]), check=False)
    except OSError:
        print("Next: the Wi-Fi chooser is not available. Plug in a network cable or a phone with USB tethering.", file=sys.stderr)
        return 1
    print("Press Alt+F1 to watch the installer use it.")
    return done.returncode


def cmd_retry(_):
    if erased():
        print("Next: the disk was already erased, so the installer does not repeat on its own. Report it "
              "(fleet-report), then start this computer from a Fleet install USB.", file=sys.stderr)
        return 2
    if unit_active() and load_state().get("outcome") not in ("stopped", "stayed"):
        print("The installer is already running. Its screens appear on the visible console.")
        return 0
    started = os.environ.get("FLEET_AUTO_STATE") or "/run/fleet-auto-started"
    tool = os.environ.get("FLEET_SYSTEMCTL") or "systemctl"
    subprocess.run(as_root(["rm", "-f", started]), check=False)
    save_state(outcome=None, reason="", step="network", attempt=1, deadline=None)
    done = subprocess.run(as_root([tool, "restart", "--no-block", UNIT]), check=False)
    if done.returncode != 0:
        print("Next: the installer could not be started again. Report it with fleet-report.", file=sys.stderr)
        return 1
    print("Trying again. The installer screens appear on the visible console (Alt+F1).")
    return 0


def cmd_return(_):
    if erased():
        print("Next: the original system was already erased, so there is nothing to return to. Report it "
              "(fleet-report), then start this computer from a Fleet install USB.", file=sys.stderr)
        return 2
    if unit_active() and load_state().get("outcome") not in ("stopped", "stayed"):
        print("Next: the installer is still running. Wait until it stops or finishes.", file=sys.stderr)
        return 2
    print(f"Restarting into {original_system()}. If this installer starts again, remove the USB stick.")
    tool = os.environ.get("FLEET_SYSTEMCTL") or "systemctl"
    return subprocess.run(as_root([tool, "reboot"]), check=False).returncode


COMMANDS = {"step": cmd_step, "wait": cmd_wait, "stopped": cmd_stopped, "stayed": cmd_stayed, "done": cmd_done,
            "tick": cmd_tick, "status": cmd_status, "report": cmd_report, "wifi": cmd_wifi, "retry": cmd_retry,
            "return": cmd_return}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        print("usage: fleet-live " + "|".join(COMMANDS), file=sys.stderr)
        return 2
    try:
        return COMMANDS[argv[0]](argv[1:])
    except Exception as exc:  # the screen must never be what stops an installation
        print(f"fleet-live {argv[0]}: {type(exc).__name__}: {decide.redact(exc)}", file=sys.stderr)
        return 0 if argv[0] in ("step", "wait", "stopped", "stayed", "done", "tick") else 70


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
