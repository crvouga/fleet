"""Frozen installers trust their shipped roots while rejecting invalid TLS."""
import http.server
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "wizard"))
import fleet_tls
import imaging


class Response(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"verified download")

    def log_message(self, *_args):
        pass


class InstallerTLS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        openssl = shutil.which("openssl")
        if not openssl:
            if os.environ.get("CI"):
                raise RuntimeError("OpenSSL is required for the installer TLS acceptance tests")
            raise unittest.SkipTest("OpenSSL is required for local TLS fixtures")
        cls.work = tempfile.TemporaryDirectory(prefix="fleet-tls-")
        cls.directory = Path(cls.work.name)
        for name in ("server", "other"):
            subprocess.run([
                openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-keyout", str(cls.directory / f"{name}.key"), "-out", str(cls.directory / f"{name}.pem"),
                "-subj", f"/CN={name}", "-addext", "subjectAltName=IP:127.0.0.1",
                "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,digitalSignature,keyCertSign,cRLSign",
                "-addext", "extendedKeyUsage=serverAuth",
            ], check=True, capture_output=True)
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Response)
        trust = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        trust.load_cert_chain(cls.directory / "server.pem", cls.directory / "server.key")
        cls.server.socket = trust.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.work.cleanup()

    def frozen(self, name):
        return mock.patch.dict(sys.modules, {"certifi": types.SimpleNamespace(where=lambda: str(self.directory / name))})

    def fetch(self, hostname="127.0.0.1"):
        with imaging.open_url(f"https://{hostname}:{self.server.server_port}/") as reply:
            return reply.read()

    def test_bundled_root_reaches_the_real_download_client(self):
        with mock.patch.object(sys, "frozen", True, create=True), self.frozen("server.pem"), mock.patch.object(urllib.request, "_opener", None):
            fleet_tls.configure()
            self.assertEqual(self.fetch(), b"verified download")

    def test_untrusted_root_is_still_refused(self):
        with mock.patch.object(sys, "frozen", True, create=True), self.frozen("other.pem"), mock.patch.object(urllib.request, "_opener", None):
            fleet_tls.configure()
            with self.assertRaises(urllib.error.URLError) as caught:
                self.fetch()
            self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)

    def test_wrong_hostname_is_still_refused(self):
        with mock.patch.object(sys, "frozen", True, create=True), self.frozen("server.pem"), mock.patch.object(urllib.request, "_opener", None):
            fleet_tls.configure()
            with self.assertRaises(urllib.error.URLError) as caught:
                self.fetch("localhost")
            self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)

    def test_system_roots_survive_the_additional_bundle(self):
        with mock.patch.dict(os.environ, SSL_CERT_FILE=str(self.directory / "server.pem")), mock.patch.object(sys, "frozen", True, create=True), self.frozen("other.pem"), mock.patch.object(urllib.request, "_opener", None):
            fleet_tls.configure()
            self.assertEqual(self.fetch(), b"verified download")

    def test_missing_packaged_bundle_fails_closed(self):
        with mock.patch.object(sys, "frozen", True, create=True), self.frozen("missing.pem"):
            with self.assertRaises(FileNotFoundError):
                fleet_tls.configure()

    def test_certificate_failure_has_specific_guidance(self):
        advice = fleet_tls.advice("[SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate")
        self.assertIn("Windows Update", advice)
        self.assertIn("Keep certificate verification enabled", advice)
        self.assertNotIn("has not been published", advice)
