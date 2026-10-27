"""Authenticated installation status using the normal node protocol.

The same private node credential is copied into the installed system. Reports
describe installation progress; they never claim that a staged node is ready.
"""
import json
import os
import sys
import time
from pathlib import Path

import agent
import cattle


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


class BootstrapReporter:
    def __init__(self, toplevel, role, token_file, identity=None, http=None):
        metadata = json.loads((Path(toplevel) / 'etc/fleet/bootstrap.json').read_text())
        token_file = Path(token_file)
        self.role = role
        self.token = token_file.read_text().strip() if token_file.is_file() else ''
        self.paths = agent.Paths({'FLEET_AGENT_STATE': str(token_file.parent / (role + '.agent'))})
        self.worker = agent.Agent(self.paths, metadata['apiUrl'], http=http, log=lambda _: None)
        self.identity = identity
        self.started = False

    def begin(self, check_api):
        check_api(self.worker.base, self.role, self.token)
        if self.identity is None:
            digest = cattle.read_machine_digest(attempts=1)
            self.identity = {'id': digest, 'role': self.role, 'hostname': self.role + '-' + digest[:4]}
        self.paths.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        agent.write_private(self.paths.role_token, self.token + '\n')
        self.worker.ensure_secret()
        try:
            registered = self.worker.register(self.identity)
        except agent.NetworkError:
            raise ReportUnavailable('FLEET_API_UNAVAILABLE: enrollment reporting is unavailable; retrying before disk changes.') from None
        if not registered:
            raise ReportUnavailable('FLEET_API_UNAVAILABLE: Fleet registration did not complete; retrying before disk changes.')
        if self.worker.approval != 'approved':
            raise ApprovalRefused('FLEET_APPROVAL_REQUIRED: this hardware identity is not approved. Resolve its state in Fleet before installing. Nothing was erased.')
        self.started = True
        self.report('FLEET_INSTALLING: integration checks are running before any disk changes.')

    def report(self, message, failed=False):
        if not self.started:
            return
        identity = self.identity
        body = {
            'v': 1, 'nodeId': identity['id'], 'role': self.role, 'hostname': identity['hostname'],
            'capabilities': [], 'revision': None, 'bootId': None, 'uptimeSeconds': None,
            'kernel': None, 'arch': None, 'cpu': {'cores': None, 'model': None},
            'memory': {'totalMiB': None, 'availableMiB': None}, 'load1': None,
            'disk': {'nixUsedPercent': None, 'bootUsedPercent': None}, 'addresses': [],
            'sync': {'rolledBack': False, 'healthFailure': None, 'paused': False},
            'failedUnits': [], 'runners': None, 'readiness': {'issues': [message[:500]]},
            'agent': {'version': 'bootstrap-1', 'configRevision': None},
            'events': [{'kind': 'installation', 'severity': 'error' if failed else 'info', 'message': message[:500]}],
        }
        try:
            status, _ = self.worker.api('POST', '/v1/heartbeat', body,
                bearer=identity['id'] + '.' + self.worker.secret, timeout=10)
            if status != 200:
                raise ReportUnavailable()
        except (agent.NetworkError, ReportUnavailable):
            # Reporting outages must not conceal the original failure or change
            # whether a disk operation is safe. The next preflight retries.
            return


def main(args):
    try:
        toplevel, role, token_file, message, *parent = args
        reporter = BootstrapReporter(toplevel, role, token_file)
        current = (agent.read_text(reporter.paths.secret, 256) or '').strip()
        if not agent.HEX64.fullmatch(current):
            return 1
        digest = cattle.read_machine_digest(attempts=1)
        reporter.identity = {'id': digest, 'role': role, 'hostname': role + '-' + digest[:4]}
        reporter.worker.secret = current
        reporter.started = True
        if not parent:
            reporter.report(message, failed=True)
            return 0
        pid = int(parent[0])
        log = Path(os.environ.get('FLEET_INSTALL_LOG', '/run/fleet-install.log'))
        while True:
            os.kill(pid, 0)
            detail = agent.redact(latest_progress(log) or message, [current, reporter.token])
            reporter.report('FLEET_INSTALLING: ' + detail)
            time.sleep(20)
    except Exception:
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
