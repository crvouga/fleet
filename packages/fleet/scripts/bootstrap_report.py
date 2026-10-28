"""Authenticated installation status using the normal node protocol.

The live installer registers the hardware identity without a role (contract
C1) and waits for a person, or an enrollment token, to approve it before any
disk is erased. The same private node credential is copied into the installed
system. Reports describe installation progress; they never claim that a
staged node is ready. The installer never compares or chooses a role.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

import agent
import cattle

TOKEN_MAX = 512


class ApprovalRefused(Exception):
    pass


class ReportUnavailable(Exception):
    pass


def latest_progress(path):
    """Read a bounded tail so long-running installs keep reporting new work."""
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            start = max(0, stream.tell() - 65536)
            stream.seek(start)
            tail = stream.read(65536)
        # An offset may start inside UTF-8 or a line. Discard that partial
        # line, retaining complete recent lines and replacement-safe decoding.
        if start:
            tail = tail.partition(b'\n')[2]
        lines = tail.decode('utf-8', 'replace').splitlines()
        return lines[-1] if lines else None
    except OSError:
        return None


PHASES = ('network', 'approval', 'checks', 'disk', 'erase', 'install')
CODED = re.compile(r'^(FLEET_[A-Z_]+): ')
STAMPED = re.compile(r'^\d{4}-\d\d-\d\dT[\d:]+Z ')


def current_phase(path):
    """The installer step last logged (`step <name>`, written by fleet-install.sh), else None."""
    try:
        with Path(path).open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - 65536))
            tail = stream.read().decode('utf-8', 'replace')
    except OSError:
        return None
    found = re.findall(r'^\S+ step (' + '|'.join(PHASES) + r')\s*$', tail, re.M)
    return found[-1] if found else None


def tag(message, phase):
    """`FLEET_X: text` becomes `FLEET_X: phase=checks text`. The controller shows the phase and an
    actionable next step; only the installer ever writes `phase=`. Bounded to 500 characters."""
    phase = phase if phase in PHASES else 'checks'
    match = CODED.match(message)
    if not match:
        message = 'FLEET_INSTALLING: ' + message
        match = CODED.match(message)
    if message[match.end():].startswith('phase='):
        return message[:500]  # the shell already named the step that failed
    return (match.group(0) + 'phase=' + phase + ' ' + message[match.end():])[:500]


def read_token(token_file):
    token_file = Path(token_file)
    return token_file.read_text()[:TOKEN_MAX + 2].strip() if token_file.is_file() else ''


def live_identity():
    """The hardware identity. Until the controller assigns a role the node is base."""
    digest = cattle.read_machine_digest(attempts=1)
    return {'id': digest, 'hostname': 'base-' + digest[:4]}


class BootstrapReporter:
    def __init__(self, toplevel, token_file, identity=None, http=None):
        metadata = json.loads((Path(toplevel) / 'etc/fleet/bootstrap.json').read_text())
        self.token = read_token(token_file)
        # The private node credential of this live boot, beside the token.
        self.paths = agent.Paths({'FLEET_AGENT_STATE': str(Path(token_file).parent / 'agent')})
        self.worker = agent.Agent(self.paths, metadata['apiUrl'], http=http, log=lambda _: None)
        self.identity = identity
        self.started = False
        self.phase = 'checks'  # fleet-install.sh runs the preflight at step "checks"

    def redacted(self, message):
        """Reports are best effort, bounded and never carry a credential."""
        return agent.redact(str(message), [value for value in (self.worker.secret, self.token) if value])

    def bearer(self):
        return self.identity['id'] + '.' + self.worker.secret

    def register(self):
        """POST /v1/nodes/register with no role (C1). Sets worker.approval."""
        body = {'nodeId': self.identity['id'], 'hostname': self.identity['hostname'], 'secret': self.worker.secret}
        if self.token:
            body['enrollmentToken'] = self.token
        status, document = self.worker.api('POST', '/v1/nodes/register', body)
        if status in (200, 201) and isinstance(document, dict) and document.get('status') in ('approved', 'pending', 'rejected'):
            self.worker.approval = document['status']
            return True
        return False

    def begin(self, check_api):
        check_api(self.worker.base, self.token)
        if self.identity is None:
            self.identity = live_identity()
        self.paths.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.worker.ensure_secret()
        try:
            registered = self.register()
        except agent.NetworkError:
            raise ReportUnavailable('FLEET_API_UNAVAILABLE: enrollment reporting is unavailable; retrying before disk changes.') from None
        deadline = time.monotonic() + min(1800, max(0, int(os.environ.get('FLEET_APPROVAL_WAIT_SECONDS', '300'))))
        while registered and self.worker.approval == 'pending':
            if time.monotonic() >= deadline:
                raise ApprovalRefused('FLEET_APPROVAL_REQUIRED: approve this node under Pending in the Fleet app, then retry. Nothing was erased.')
            time.sleep(5)
            try:
                status, document = self.worker.api('GET', '/v1/enrollment/status', None, bearer=self.bearer())
                if status == 403:
                    raise ApprovalRefused('FLEET_APPROVAL_REQUIRED: this node was rejected or retired in Fleet. Nothing was erased.')
                # C3: the role in the answer is the controller's business, never compared here.
                if status != 200 or not isinstance(document, dict) or document.get('nodeId') != self.identity['id']:
                    raise ReportUnavailable('FLEET_API_UNAVAILABLE: Fleet approval could not be verified. Nothing was erased.')
                self.worker.approval = document.get('status')
            except agent.NetworkError:
                raise ReportUnavailable('FLEET_API_UNAVAILABLE: Fleet approval could not be checked. Nothing was erased.') from None
        if not registered:
            raise ReportUnavailable('FLEET_API_UNAVAILABLE: Fleet registration did not complete; retrying before disk changes.')
        if self.worker.approval != 'approved':
            raise ApprovalRefused('FLEET_APPROVAL_REQUIRED: this hardware identity is not approved. Resolve its state in Fleet before installing. Nothing was erased.')
        self.started = True
        self.report('FLEET_INSTALLING: integration checks are running before any disk changes.')

    def report(self, message, failed=False, phase=None):
        if not self.started:
            return
        identity = self.identity
        message = tag(self.redacted(message), phase or self.phase)
        body = {
            'v': 2, 'nodeId': identity['id'], 'role': 'base', 'closure': 'base', 'hostname': identity['hostname'],
            'capabilities': [], 'revision': None, 'bootId': None, 'uptimeSeconds': None,
            'kernel': None, 'arch': None, 'cpu': {'cores': None, 'model': None},
            'memory': {'totalMiB': None, 'availableMiB': None}, 'load1': None,
            'disk': {'nixUsedPercent': None, 'bootUsedPercent': None}, 'addresses': [],
            'sync': {'rolledBack': False, 'healthFailure': None, 'paused': False},
            'failedUnits': [], 'runners': None, 'readiness': {'issues': [message]},
            'agent': {'version': '2', 'desiredRevision': None},
            'reconcile': {'phase': 'blocked' if failed else 'progressing', 'issues': [message]},
            'events': [{'kind': 'installation', 'severity': 'error' if failed else 'info', 'message': message}],
        }
        try:
            status, _ = self.worker.api('POST', '/v1/heartbeat', body, bearer=self.bearer(), timeout=10)
            if status != 200:
                raise ReportUnavailable()
        except (agent.NetworkError, ReportUnavailable):
            # Reporting outages must not conceal the original failure or change
            # whether a disk operation is safe. The next preflight retries.
            return


def main(args):
    try:
        toplevel, token_file, message, *parent = args
        metadata_path = Path(toplevel) / "etc/fleet/bootstrap.json"
        metadata = json.loads(metadata_path.read_text()) if metadata_path.is_file() else {}
        if metadata.get("approvalMode") == "local" and metadata.get("apiUrl") == "":
            return 0
        reporter = BootstrapReporter(toplevel, token_file)
        current = (agent.read_text(reporter.paths.secret, 256) or '').strip()
        if not agent.HEX64.fullmatch(current):
            return 1
        reporter.identity = live_identity()
        reporter.worker.secret = current
        reporter.started = True
        if not parent:
            reporter.report(message, failed=True)
            return 0
        pid = int(parent[0])
        log = Path(os.environ.get('FLEET_INSTALL_LOG', '/run/fleet-install.log'))
        while True:
            os.kill(pid, 0)
            detail = agent.redact(STAMPED.sub('', latest_progress(log) or message), [current, reporter.token])
            reporter.report('FLEET_INSTALLING: ' + detail, phase=current_phase(log))
            time.sleep(20)
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
