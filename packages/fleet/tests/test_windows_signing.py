"""Exercise the release verifier in real PowerShell with isolated trust fixtures."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import os
import textwrap
import unittest

from test_powershell import NeedsPowerShell, powershell_command

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/windows/verify-release.ps1"
PUBLISHER = "CN=Fixture Publisher, O=Fixture"


class WindowsSigningTests(NeedsPowerShell):
    def verify(self, *, status="Valid", publisher=PUBLISHER, timestamp=True, usage="1.3.6.1.5.5.7.3.3", tool_exit=0, revision="a" * 40):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "fleet-installer-windows-x64.exe"
            binary.write_bytes(b"isolated executable fixture, never executed")
            tool = root / "signtool.ps1"
            tool.write_text(f"$global:LASTEXITCODE = {tool_exit}\n")
            proof = root / "proof.json"
            fixture = {
                "Status": status,
                "SignerCertificate": {"Subject": publisher, "Thumbprint": "fixture-cert", "Extensions": [{"Oid": {"Value": "2.5.29.37"}, "EnhancedKeyUsages": [{"Value": usage}]}]},
                "TimeStamperCertificate": {"Thumbprint": "fixture-timestamp"} if timestamp else None,
            }
            quote = lambda value: "'" + str(value).replace("'", "''") + "'"
            source = (
                "$ErrorActionPreference='Stop'; "
                f"$global:signature = {quote(json.dumps(fixture))} | ConvertFrom-Json; "
                "function Get-AuthenticodeSignature { param($LiteralPath) $global:signature }; "
                f"function Get-ChildItem {{ [pscustomobject]@{{FullName={quote(tool)}}} }}; "
                f"& {quote(SCRIPT)} -Path {quote(binary)} -Publisher {quote(PUBLISHER)} -Revision {quote(revision)} -RunId 123 -Proof {quote(proof)}"
            )
            result = subprocess.run([*powershell_command(), "pwsh", "-NoProfile", "-NonInteractive", "-Command", source], capture_output=True, text=True, timeout=30)
            return result, json.loads(proof.read_text()) if proof.exists() else None, hashlib.sha256(binary.read_bytes()).hexdigest()

    def test_verified_download_proof_binds_actual_bytes_and_revision(self):
        result, proof, digest = self.verify()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(proof["sha256"], digest)
        self.assertEqual(proof["revision"], "a" * 40)
        self.assertEqual(proof["runId"], 123)
        self.assertEqual(proof["publisher"], PUBLISHER)
        self.assertIn("FLEET-SIGNATURE-VERIFIED", result.stdout)

    def test_unsigned_tampered_and_untrusted_downloads_never_get_proofs(self):
        for status in ["NotSigned", "HashMismatch", "NotTrusted", "UnknownError"]:
            with self.subTest(status=status):
                result, proof, _ = self.verify(status=status)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(proof)
                self.assertIn("FLEET-SIGNATURE-INVALID", result.stderr)

    def test_wrong_publisher_missing_timestamp_and_wrong_usage_fail_closed(self):
        for args, code in [({"publisher": "CN=Other"}, "PUBLISHER"), ({"timestamp": False}, "TIMESTAMP"), ({"usage": "1.3.6.1.5.5.7.3.1"}, "USAGE")]:
            with self.subTest(args=args):
                result, proof, _ = self.verify(**args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(proof)
                self.assertIn("FLEET-SIGNATURE-" + code, result.stderr)

    def test_native_trust_failure_and_invalid_revision_cannot_publish(self):
        for args in [{"tool_exit": 1}, {"revision": "main"}]:
            with self.subTest(args=args):
                result, proof, _ = self.verify(**args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(proof)


class WindowsPublicationTests(NeedsPowerShell):
    def test_retries_repair_the_same_run_but_older_runs_never_replace_newer_builds(self):
        workflow = (Path(__file__).resolve().parents[3] / ".github/workflows/fleet-windows-sign.yml").read_text()
        body = textwrap.dedent(workflow.split("      - name: Publish only a current, verified signed Windows installer", 1)[1].split("        run: |\n", 1)[1])
        for published, allowed in [(None, True), (100, True), (123, True), (124, False), (0, False)]:
            with self.subTest(published=published), tempfile.TemporaryDirectory() as directory:
                prefix = """
$ErrorActionPreference = 'Stop'
function gh {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'api') {
        if ([string]::IsNullOrEmpty($env:FIXTURE_RUN)) { '{"assets":[]}' }
        else { '{"assets":[{"name":"fleet-installer-windows-x64.signature.json"}]}' }
    } elseif ($args[1] -eq 'download') {
        @{runId=[long]$env:FIXTURE_RUN} | ConvertTo-Json | Set-Content published-proof/fleet-installer-windows-x64.signature.json
    } elseif ($args[1] -eq 'upload') { Set-Content upload-called 'yes' }
    else { throw 'unexpected gh fixture operation' }
}
"""
                result = subprocess.run([*powershell_command(), "pwsh", "-NoProfile", "-NonInteractive", "-Command", prefix + body],
                                        cwd=directory, env={**os.environ, "SOURCE_RUN": "123", "GITHUB_REPOSITORY": "fixture/repository", "FIXTURE_RUN": "" if published is None else str(published)},
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode == 0, allowed, result.stdout + result.stderr)
                self.assertEqual((Path(directory) / "upload-called").exists(), allowed)
