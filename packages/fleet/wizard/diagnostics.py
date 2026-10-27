"""What the wizard says when something goes wrong, and what it hands to whoever fixes it.

`guidance` turns a failure into a plain explanation and recovery steps.
`report` collects the facts an agent or maintainer needs: the failure, this
computer, the job's steps and the tail of each log. `issue_url` pre-fills a
GitHub issue with the report. Everything passes through `decide.redact`; the
issue is public, and the person reviews it in their browser before submitting.
"""
import os
import platform
import re
import sys
import tempfile
import traceback

import bootstrap  # noqa: F401
import decide

LOG_TAIL = 120
TAIL_BYTES = 256 * 1024
ISSUE_URL_MAX = decide.ISSUE_URL_MAX
ISSUE_TAILS = (LOG_TAIL, 60, 30, 10, 0)

BUG = "This looks like a bug in the installer, not a problem with this computer."
REPORT_STEP = "If it happens again, press Copy diagnostic report and paste it to an agent, or press Report on GitHub."

LATEST = "Download the latest Fleet installer from the fleet-installer release page and run it."
# decide.invariant's default fix is for the command line; a wizard user has no such command.
CLI_ONLY_FIXES = ("Run `fleet-node doctor`", "Read the log, then run the wizard again")

# (pattern, summary, steps, retry). The first match wins. Patterns read the message
# only: a fix such as "Check the Wi-Fi network name" must not make a failure look
# like a network one.
RULES = (
    (r"a check failed in the privileged step",
     "This computer is not ready for installation.",
     [], True),
    (r"privileged step ended without a result|did not start the administrator prompt|was refused",
     "Administrator permission was not given.",
     ["Press Try again, then choose Yes when the computer asks for permission.",
      "If no permission prompt appears, close the installer and start it again as an administrator."], True),
    (r"stopped without reporting a result",
     "The administrator step stopped before it could say what it did.",
     ["Read the log named below to see how far it got.", "Then press Try again: the installer checks everything again and takes back an unfinished conversion.",
      REPORT_STEP], True),
    (r"cannot ask for administrator rights",
     "This computer cannot show an administrator prompt from here.",
     ["Close this window and start the installer with administrator rights, as described above."], False),
    (r"boot layout this installer expects",
     "The installer could not read the image's boot files.",
     [LATEST, "If you already have the latest installer, report the diagnostic: the installer or published image needs fixing.", REPORT_STEP], False),
    (r"newer than this installer|older than the release|unsupported (format|version)|different installer version",
     "This installer is older than the published release and cannot read it.",
     [LATEST], False),
    (r"FLEET_PLATFORM_NOT_READY|FLEET_INSTALLER_READINESS_MISSING",
     "The published installer is not ready for this kind of node yet.",
     ["Nothing was erased. The platform administrator must fix what is listed and publish a new installer; then start the latest installer again."], False),
    (r"scheduled restart could not be confirmed cancelled",
     "Windows may still have a restart scheduled; the installer kept its staged boot files for recovery.",
     [REPORT_STEP], True),
    (r"could not be taken back",
     "Some changes from an unfinished conversion are still on this computer.",
     ["Press Try again: the installer tries to take them back before anything else.",
      "If that keeps failing, remove them by hand as docs/windows.md describes ('Remove everything by hand').", REPORT_STEP], True),
    (r"another installer",
     "Another Fleet installer window is using this disk.",
     ["Close the other installer window, or wait for its disk work to finish, then press Try again."], True),
    (r"not approved|nobody approved|approval token",
     "GitHub did not approve this computer in time.",
     ["Press Try again. When the GitHub page opens, sign in as the repository owner and press Submit new issue within 15 minutes.",
      "Or open 'Already have an enrollment token?' on the role page and paste a token from `just enroll`."], True),
    (r"disks? (changed|was plugged)|not the one that was chosen|not present (exactly once|uniquely)|disk changed",
     "The disks changed after you reviewed them.",
     ["Check that the right disk is connected and nothing else was plugged in or removed, then press Try again to review it again."], True),
    (r"kept changing|being published|releasechanging",
     "A new installer release was being published while this one downloaded.",
     ["Wait a few minutes for the publication to finish, then press Try again."], True),
    (r"image changed|checksum|sha256|release is broken",
     "The downloaded installer did not match its published checksum.",
     ["Press Try again to download it afresh.", "If it keeps failing, a new release is probably publishing. Wait a few minutes and try again."], True),
    (r"certificate.verify.failed",
     "This computer could not verify the download server's certificate.",
     ["Check the computer's clock and Windows Update, then press Try again.",
      "If this network inspects HTTPS traffic, ask its administrator to allow GitHub. Keep certificate verification on."], True),
    (r"http error 404|404 not found",
     "The installer release could not be found.",
     ["A new release may be publishing. Wait a few minutes, then press Try again."], True),
    (r"urlerror|urlopen error|nodename|no route to host|timed out|temporary failure in name|name or service|getaddrinfo|connection (reset|refused|aborted)|network is unreachable|could not download",
     "The network connection failed.",
     ["Check this computer's internet connection, then press Try again."], True),
    (r"could not read the administrator step's result",
     "The administrator step finished, but the installer could not read what it did.",
     ["Read the log named below to see how far it got before erasing anything again.", BUG, REPORT_STEP], True),
    (r"permissionerror|access is denied|errno 13|winerror 5\b|permission denied",
     "The operating system refused the installer access to one of its own working files.",
     ["Close every other Fleet installer window, then press Try again.", BUG, REPORT_STEP], True),
    (r"^[A-Z][A-Za-z]+(Error|Exception): ",
     "The installer stopped on an unexpected error.",
     [BUG, "Press Try again; a temporary problem often clears.", REPORT_STEP], True),
)


def guidance(message, fix="", changed=None):
    """{summary, steps, retry, safety} for a failure the person can act on.
    `changed` is whether the privileged helper may have changed this computer;
    None makes no claim either way."""
    summary, steps, retry = "", [], True
    for pattern, rule_summary, rule_steps, rule_retry in RULES:
        if re.search(pattern, str(message or ""), re.IGNORECASE | re.MULTILINE):
            summary, steps, retry = rule_summary, list(rule_steps), rule_retry
            break
    if fix and fix not in steps and not fix.startswith(CLI_ONLY_FIXES):
        steps.insert(0, fix)
    if not steps:
        steps = ["Press Try again.", REPORT_STEP]
    safety = ("" if changed is None else
              "The administrator step had started. Check the log to see how far it got before erasing again."
              if changed else "Nothing on this computer was erased or changed.")
    return {"summary": summary, "steps": steps, "retry": retry, "safety": safety}


def tail(path, lines=LOG_TAIL):
    """The last lines of a log, redacted. Never raises: a report must not fail."""
    if not path or lines <= 0:
        return []
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - TAIL_BYTES))
            data = handle.read().decode("utf-8", "replace")
    except OSError as exc:
        return [f"(could not read {path}: {type(exc).__name__}: {exc})"]
    # The page polls every second; its request lines would crowd out the steps.
    kept = [line for line in data.splitlines() if " INFO http " not in line]
    return [decide.redact(line) for line in kept[-lines:]]


def system_facts(os_name, admin, elevation):
    return [
        f"OS: {os_name} ({platform.platform()})",
        f"Arch: {decide.machine_arch()}",
        f"Python: {platform.python_version()}{' (packaged)' if getattr(sys, 'frozen', False) else ''}",
        f"Administrator: {'yes' if admin else 'no'}; elevation: {elevation}",
        f"Temp folder: {tempfile.gettempdir()}",
    ]


def _line(value):
    return decide.redact(str(value if value not in (None, "") else "unknown"))


def check_snapshot(stage, findings):
    """Copy only diagnostic fields; never serialize a plan, request or Wi-Fi profile."""
    return {"stage": stage, "findings": [
        {key: decide.redact(str(item.get(key, ""))) for key in ("name", "status", "detail", "fix")}
        for item in findings
    ]}


def exception_details(error):
    """Source locations and OS error codes, without traceback locals or request data."""
    frames = traceback.extract_tb(error.__traceback__)
    return {
        "type": type(error).__name__,
        "errno": getattr(error, "errno", None), "winerror": getattr(error, "winerror", None),
        "context": getattr(error, "context", {}),
        "frames": [f"{os.path.basename(frame.filename)}:{frame.lineno} in {frame.name}" for frame in frames[-6:]],
    }


def evidence(job, result, compact=False):
    """Key evidence survives even when the issue URL has no room for log tails."""
    job = job or {}
    out = []
    if job.get("attempt"):
        out += [f"Attempt: {_line(job['attempt'])}; started: {_line(job.get('started_at'))}; elapsed: {job.get('elapsed', 0):.1f}s"]
    if job.get("image"):
        out += [f"Verified image: sha256={_line(job['image'].get('sha256'))}; bytes={_line(job['image'].get('bytes'))}"]
    helper = result.get("helper") or {}
    if helper:
        out += ["Helper: " + "; ".join(f"{key}={_line(value)}" for key, value in helper.items())]
    error = result.get("error") or {}
    if error:
        out += [f"Error type: {_line(error.get('type'))}; errno: {_line(error.get('errno'))}; winerror: {_line(error.get('winerror'))}"]
        out += ["Source: " + " <- ".join(_line(frame) for frame in error.get("frames", []))]
        out += [f"Context {key}: {_line(value)}" for key, value in (error.get("context") or {}).items()]
    checks = [*(job.get("checks") or []), *(result.get("checks") or [])]
    if checks:
        out += ["", "## Checks (recorded during this attempt; not rerun)"]
        for snapshot in checks:
            findings = snapshot.get("findings", [])
            out += [f"Stage: {_line(snapshot.get('stage'))}; {len(findings)} checks"]
            # Put blockers first, including when the final URL fallback needs a prefix.
            for item in sorted(findings, key=lambda row: row.get("status") != "fail"):
                if compact and item.get("status") not in ("fail", "warn"):
                    continue
                out += [f"{_line(item.get('status')).upper()} {_line(item.get('name'))}: {_line(item.get('detail'))}"]
                if item.get("fix"):
                    out += [f"  Fix: {_line(item['fix'])}"]
    if not compact and job.get("timeline"):
        out += ["", "## Timeline (seconds since start)", *[_line(row) for row in job["timeline"]]]
    return out


def report(version, facts, job, problem=None, lines=LOG_TAIL, wizard_log=None):
    """One plain-text report. `job` is a Job snapshot; `problem` is an error the
    page met outside a job ({message, fix, where})."""
    result = (job or {}).get("result") or {}
    problem = problem or {}
    message = problem.get("message") or result.get("message") or (job or {}).get("message")
    fix = problem.get("fix") or result.get("fix") or ""
    advice = problem.get("guidance") or result.get("guidance") or guidance(message or "", fix)
    out = [
        "Fleet installer diagnostic",
        f"Paste this whole report to an agent working in https://github.com/{decide.REPO}. "
        f"The installer source is packages/fleet/wizard at {_line(version)}.",
        "",
        "## Failure",
        f"Where: {_line(problem.get('where') or 'install job')}",
        f"Mode: {_line((job or {}).get('mode') or problem.get('mode'))}; role: {_line((job or {}).get('role') or problem.get('role'))}",
        f"State: {_line((job or {}).get('state'))}; step: {_line((job or {}).get('step'))}",
        f"Result: {_line(message or 'No final result received')}",
        f"Next: {_line(fix or '-')}",
        f"Explanation: {_line(advice.get('summary') or '-')}",
        *[f"- {_line(step)}" for step in advice.get("steps") or []],
        f"Safety: {_line(advice.get('safety') or '-')}",
        *evidence(job, result, compact=not lines),
        "",
        "## System",
        f"Version: {_line(version)}",
        *[_line(fact) for fact in facts],
    ]
    if lines:
        steps = [_line(row) for row in ((job or {}).get("log") or [])[-lines:]]
        out += ["", "## Job steps", *(steps or ["(none)"])]
    logs = []
    for path in (wizard_log, result.get("log")):
        if path and path not in logs:
            logs.append(path)
    for path in logs:
        out += ["", f"## Log {path}"]
        if not lines:
            out += ["(omitted to fit; attach this file)"]
            continue
        found = tail(path, lines)
        if path == result.get("log") and result.get("log_tail") and (not found or found[0].startswith("(could not read")):
            found = ["(this log belongs to the administrator step; its end, as the step reported it:)",
                     *[decide.redact(line) for line in result["log_tail"][-lines:]]]
        out += found
    return decide.redact("\n".join(out)) + "\n"


def issue_title(message):
    first = str(message or "installer failure").strip().splitlines()[0] if str(message or "").strip() else "installer failure"
    first = decide.redact(first)
    return "Fleet installer: " + (first if len(first) <= 90 else first[:87] + "...")


def issue_step(os_label, job, problem):
    """The form's "Step where it stopped": where in the wizard, in words a person reads."""
    job, problem = job or {}, problem or {}
    mode = {"here": "set up this computer", "usb": "make an install USB"}.get(job.get("mode") or problem.get("mode"), "choosing")
    where = problem.get("where") or job.get("state") or "start"
    detail = job.get("step")
    return _line(f"Wizard on {os_label}: {mode}, {where}" + (f" ({detail})" if detail and detail != where else ""))


def issue_url(title, build, step=""):
    """A new issue on the Fleet installer form that fits GitHub's limit. `build(lines)`
    returns the report with that many log lines; fewer are used until the address fits."""
    step = step or "Wizard"
    for lines in ISSUE_TAILS:
        text = build(lines)
        if lines < LOG_TAIL:
            text = "(Log tails were shortened to fit. The full report is on the reporter's clipboard; Save diagnostic report writes it to a file.)\n" + text
        url = decide.issue_form_url(title, step, text)
        if len(url) <= ISSUE_URL_MAX:
            return url
    return decide.issue_form_url_within(title, step, build(0), ISSUE_URL_MAX,
                                        "(The report was too long for a link. Save diagnostic report and attach fleet-diagnostic.txt.)")
