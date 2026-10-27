#!/usr/bin/env python3
"""Private, bounded integration checks before any destructive installation.

Only public error codes are printed. No exception, OAuth response, decrypted
document or credential is ever included in the diagnostic.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from bootstrap_report import BootstrapReporter, ApprovalRefused, ReportUnavailable


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


def check_api(url, role, token):
    parsed = urlparse(url)
    require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and
            not parsed.password and not parsed.query and not parsed.fragment,
            'FLEET_API_UNCONFIGURED: the image needs an HTTPS Fleet API address.')
    request = urllib.request.Request(url.rstrip('/') + '/v1/enrollment/check',
        data=json.dumps({'role': role, 'roleToken': token}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as reply:
            result = json.loads(reply.read(4097))
            require(result == {'ok': True, 'role': role}, 'FLEET_API_PROTOCOL: Fleet did not confirm enrollment readiness.')
    except urllib.error.HTTPError as error:
        if error.code == 404:
            # A rolling deployment may still expose the old API. The caller
            # must still register the hardware and require actual approval;
            # this read-only probe is never the authorization to erase.
            return
        if error.code in (408, 429) or error.code >= 500:
            raise Retryable('FLEET_API_UNAVAILABLE: Fleet is temporarily unavailable; retrying before disk changes.') from None
        raise NotReady('FLEET_ENROLLMENT_REJECTED: Fleet cannot approve this credential. Repair the role credential or update the Fleet API before installing.') from None
    except (urllib.error.URLError, OSError):
        raise Retryable('FLEET_API_UNAVAILABLE: Fleet could not be reached; retrying before disk changes.') from None


def check(toplevel, role, age_file, token_file, run=subprocess.run, api=check_api):
    path = Path(toplevel) / 'etc/fleet/bootstrap.json'
    require(path.is_file(), 'FLEET_METADATA_MISSING: update the installer; this image cannot prove integration readiness.')
    metadata = json.loads(path.read_text())
    require(metadata.get('version') == 1 and metadata.get('role') == role,
            'FLEET_METADATA_INVALID: the installed role does not match its bootstrap metadata.')
    blocked = metadata.get('installBlocked', metadata['blocked'])
    require(not blocked, 'FLEET_PLATFORM_NOT_READY: ' + '; '.join(blocked))
    token = Path(token_file).read_text().strip() if Path(token_file).is_file() else ''
    require(re.fullmatch(r'[A-Za-z0-9._-]{8,512}', token),
            'FLEET_ENROLLMENT_MISSING: automatic Fleet approval requires an enrolled installer with an API role credential. Nothing was erased.')
    require(Path(age_file).is_file(), 'FLEET_ROLE_KEY_MISSING: the enrolled role key is required before installation.')
    source = metadata.get('secretsFile')
    if metadata.get('updateMode') == 'local':
        try:
            closure = run(['nix', 'path-info', '--recursive', str(toplevel)],
                          capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise NotReady('FLEET_LOCAL_CLOSURE_UNAVAILABLE: the installer could not validate its bundled role closure. Nothing was erased.') from None
        require(closure.returncode == 0,
                'FLEET_LOCAL_CLOSURE_UNAVAILABLE: this image is missing its role closure. Rebuild the installer before disk changes.')
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
    github = metadata.get('github')
    if source:
        try:
            done = run(['sops', '--decrypt', '--output-type', 'json', source],
                env={**os.environ, 'SOPS_AGE_KEY_FILE': str(age_file)},
                capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise NotReady('FLEET_ROLE_SECRETS: role secrets could not be checked. Nothing was erased.') from None
        require(done.returncode == 0, 'FLEET_ROLE_SECRETS: the enrolled key cannot decrypt this role. Repair its encrypted secrets before installing.')
        values = json.loads(done.stdout)
        require(all(name in values for name in metadata['requiredSecrets']),
                'FLEET_ROLE_SECRETS: a required role secret is missing from the encrypted document.')
        if github:
            require(isinstance(values.get('github-app-key'), str), 'FLEET_GITHUB_KEY: the GitHub App credential is missing.')
            with tempfile.TemporaryDirectory(prefix='fleet-bootstrap-') as directory:
                key = Path(directory) / 'app.pem'
                key.write_text(values['github-app-key'])
                key.chmod(0o600)
                targets = github['repositories'] if github['scope'] == 'repository' else [github['organization']]
                require(bool(targets), 'FLEET_GITHUB_SCOPE: no runner repository or organization is configured.')
                for target in targets:
                    try:
                        result = run([sys.executable, str(Path(__file__).with_name('runner_control.py')), 'register',
                            github['scope'], target, github['appId'], github['installationId'], str(key),
                            str(Path(directory) / 'registration')], capture_output=True, timeout=75, check=False)
                    except (OSError, subprocess.TimeoutExpired):
                        raise Retryable('FLEET_GITHUB_UNAVAILABLE: retrying GitHub registration readiness before disk changes.') from None
                    if result.returncode == 75:
                        raise Retryable('FLEET_GITHUB_UNAVAILABLE: GitHub transport, throttling or server failure; retrying before disk changes.')
                    # runner_control prints one public line: CODE: what GitHub refused.
                    said = getattr(result, 'stderr', b'') if result.returncode else b''
                    said = (said.decode('utf-8', 'replace') if isinstance(said, bytes) else str(said or '')).strip().splitlines()
                    said = said[-1][:300] if said and said[-1].startswith('FLEET_') else ''
                    require(result.returncode == 0, (said + f' (target {target}). Nothing was erased.') if said else
                            'FLEET_GITHUB_REGISTRATION: GitHub rejected runner registration. Check the App installation and repository access before installing.')
    api(metadata['apiUrl'], role, token)


if __name__ == '__main__':
    reporter = None
    try:
        reporter = BootstrapReporter(sys.argv[1], sys.argv[2], sys.argv[4])
        reporter.begin(check_api)
        check(*sys.argv[1:], api=lambda *args: None)
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
