#!/usr/bin/env python3
"""Private, bounded checks before the destructive installation of base.

  bootstrap-readiness.py TOPLEVEL TOKEN_FILE

The installer only sets up the node: it checks the platform configuration of
the base closure (its single `blocked` list), that the closure is available,
and, when an enrollment token is present, that Fleet accepts it (contract C2).
In managed mode it then registers the hardware identity without a role and
waits for approval. Role secrets, SOPS and GitHub runner registration are not
checked here: the node reports those as reconcile issues once Fleet assigns
it a role. Only public error codes are printed, never a credential.
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from bootstrap_report import BootstrapReporter, ApprovalRefused, ReportUnavailable, read_token

TOKEN = re.compile(r'[A-Za-z0-9._-]{8,512}')


class NotReady(Exception):
    pass


class Retryable(NotReady):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def require(condition, message):
    if not condition:
        raise NotReady(message)


def check_api(url, token):
    parsed = urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and
            not parsed.password and not parsed.query and not parsed.fragment,
            'FLEET_API_UNCONFIGURED: the image needs an HTTPS Fleet controller address.')
    if not token:
        return  # Registration and explicit app approval authorize this node.
    request = urllib.request.Request(url.rstrip('/') + '/v1/enrollment/check',
        data=json.dumps({'enrollmentToken': token}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as reply:
            result = json.loads(reply.read(4097))
            # C2: { ok: true, role: string|null }. The role is the controller's
            # decision and is never compared here.
            require(isinstance(result, dict) and result.get('ok') is True,
                    'FLEET_API_PROTOCOL: Fleet did not confirm enrollment readiness.')
    except urllib.error.HTTPError as error:
        if error.code == 404:
            # A rolling deployment may still expose the old controller. The caller
            # must still register the hardware and require actual approval;
            # this read-only probe is never the authorization to erase.
            return
        if error.code in (408, 429) or error.code >= 500:
            raise Retryable('FLEET_API_UNAVAILABLE: Fleet is temporarily unavailable; retrying before disk changes.') from None
        raise NotReady('FLEET_ENROLLMENT_REJECTED: Fleet does not accept this enrollment token. Replace or remove it, then retry. Nothing was erased.') from None
    except (urllib.error.URLError, OSError):
        raise Retryable('FLEET_API_UNAVAILABLE: Fleet could not be reached; retrying before disk changes.') from None


def check(toplevel, token_file, run=subprocess.run, api=check_api):
    path = Path(toplevel) / 'etc/fleet/bootstrap.json'
    require(path.is_file(), 'FLEET_METADATA_MISSING: update the installer; this image cannot prove integration readiness.')
    metadata = json.loads(path.read_text())
    require(metadata.get('version') == 1, 'FLEET_METADATA_INVALID: the installer bootstrap metadata has an unsupported version.')
    blocked = metadata.get('installBlocked', metadata.get('blocked'))
    require(isinstance(blocked, list), 'FLEET_METADATA_INVALID: the installer bootstrap metadata has no readiness list.')
    require(not blocked, 'FLEET_PLATFORM_NOT_READY: ' + '; '.join(blocked))
    token = read_token(token_file)
    local = metadata.get("approvalMode") == "local"
    require(not local or metadata.get("apiUrl") == "",
            "FLEET_APPROVAL_INVALID: local approval cannot name a remote controller.")
    require(not token or TOKEN.fullmatch(token),
            'FLEET_ENROLLMENT_INVALID: the enrollment token is malformed. Replace or remove it. Nothing was erased.')
    if metadata.get('updateMode') == 'local':
        try:
            closure = run(['nix', 'path-info', '--recursive', str(toplevel)],
                          capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise NotReady('FLEET_LOCAL_CLOSURE_UNAVAILABLE: the installer could not validate its bundled base closure. Nothing was erased.') from None
        require(closure.returncode == 0,
                'FLEET_LOCAL_CLOSURE_UNAVAILABLE: this image is missing its base closure. Rebuild the installer before disk changes.')
    else:
        cache_url = metadata.get('cacheUrl')
        parsed_cache = urlparse(cache_url or '')
        require(parsed_cache.scheme == 'https' and parsed_cache.hostname and not parsed_cache.username and
                not parsed_cache.password and not parsed_cache.query and not parsed_cache.fragment,
                'FLEET_CACHE_UNCONFIGURED: a public HTTPS update cache is required.')
        try:
            cached = run(['nix', 'store', 'verify', '--store', cache_url, '--no-contents', '--sigs-needed', '1',
                '--option', 'trusted-public-keys', metadata['cachePublicKey'], str(toplevel)],
                capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise Retryable('FLEET_CACHE_UNAVAILABLE: update-cache readiness timed out; retrying before disk changes.') from None
        if cached.returncode != 0:
            raise Retryable('FLEET_CACHE_UNAVAILABLE: this revision is not readable with its pinned signing key; check cache publication and connectivity. Retrying before disk changes.')
    if not local:
        api(metadata['apiUrl'], token)


if __name__ == '__main__':
    reporter = None
    try:
        toplevel, token_file = sys.argv[1:3]
        metadata = json.loads((Path(toplevel) / "etc/fleet/bootstrap.json").read_text())
        if metadata.get("approvalMode") == "local" and metadata.get("apiUrl") == "":
            check(toplevel, token_file)
        else:
            # Register and wait for approval first, so Fleet shows every later
            # failure on this node's page.
            reporter = BootstrapReporter(toplevel, token_file)
            reporter.begin(check_api)
            check(toplevel, token_file, api=lambda *args: None)
        if reporter:
            reporter.report('FLEET_INSTALLING: preflight passed; awaiting installation and the first installed-system heartbeat.')
    except (Retryable, ReportUnavailable) as error:
        if reporter:
            reporter.report(str(error), failed=True)
        print(str(error), file=sys.stderr)
        sys.exit(75)
    except (NotReady, ApprovalRefused) as error:
        if reporter:
            reporter.report(str(error), failed=True)
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception:
        if reporter:
            reporter.report('FLEET_BOOTSTRAP_INVALID: integration readiness could not be verified. Nothing was erased.', failed=True)
        print('FLEET_BOOTSTRAP_INVALID: integration readiness could not be verified. Nothing was erased. Update the installer or repair its platform configuration.', file=sys.stderr)
        sys.exit(2)
