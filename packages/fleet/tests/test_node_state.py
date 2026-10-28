#!/usr/bin/env python3
"""A role change wipes every cache and keeps only the node's identity."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import node_state  # noqa: E402

IDENTITY_FILES = {
    "nix/fleet-state/agent/node.secret": "secret\n",
    "nix/fleet-state/secrets/age.key": "AGE-SECRET-KEY-1\n",
    "nix/fleet-state/secrets/git-read-token": "token\n",
    "nix/fleet-state/ssh/ssh_host_ed25519_key": "key\n",
    "nix/fleet-state/sync/pending-boot": "boot_id=x\n",
    "nix/fleet-state/recovery/outbox/.keep": "",
    "nix/fleet-state/target": "role=devbox\nclosure=devbox\n",
}
CACHE_FILES = {
    "nix/devbox/project/main.c": "int main;\n",
    "nix/ci-cache/slot-1/blob": "x",
    "nix/ci-state/slot-1/job.json": "{}",
    "nix/fleet-code/notes": "x",
    "nix/fleet-state/devbox/authorized_keys": "ssh-ed25519 AAAA\n",
    "nix/fleet-state/config.json": "{}",
    "nix/something-new/data": "undeclared data is cache too",
}


class EpochTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for directory in ("nix/store/abc-system", "nix/var/nix/profiles", "etc/fleet"):
            (self.root / directory).mkdir(parents=True)
        for name, text in {**IDENTITY_FILES, **CACHE_FILES}.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.events = []

    def tearDown(self):
        self.tmp.cleanup()

    def boot(self, role):
        (self.root / "etc/fleet/node.conf").write_text(f"role={role}\nflake_attr={role}\n")
        return node_state.epoch(str(self.root), queue=lambda *args: self.events.append(args))

    def present(self, names):
        return {name for name in names if (self.root / name).exists()}

    def test_the_first_boot_records_the_role_and_wipes_nothing(self):
        self.assertEqual(self.boot("base"), 0)
        self.assertEqual((self.root / "nix/fleet-state/role-epoch").read_text(), "role=base\n")
        self.assertEqual(self.present(CACHE_FILES), set(CACHE_FILES))
        self.assertEqual(self.events, [])

    def test_the_same_role_keeps_its_cache_across_reboots(self):
        self.boot("ci")
        self.assertEqual(self.boot("ci"), 0)
        self.assertEqual(self.present(CACHE_FILES), set(CACHE_FILES))

    def test_another_role_wipes_every_cache_and_keeps_identity_and_the_system(self):
        self.boot("devbox")
        self.assertEqual(self.boot("ci"), 0)
        self.assertEqual(self.present(CACHE_FILES), set())
        self.assertEqual(self.present(IDENTITY_FILES), set(IDENTITY_FILES))
        self.assertTrue((self.root / "nix/store/abc-system").is_dir())
        self.assertTrue((self.root / "nix/var/nix/profiles").is_dir())
        self.assertEqual((self.root / "nix/fleet-state/role-epoch").read_text(), "role=ci\n")
        [(kind, severity, key, message, data)] = self.events
        self.assertEqual((kind, severity, data["from"], data["to"]), ("state-wiped", "info", "devbox", "ci"))
        self.assertTrue(key.startswith("state-wiped:devbox:ci:"))
        self.assertIn("wiped 7 cache entries", message)

    def test_a_link_is_removed_and_never_followed(self):
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "keep").write_text("not the node's")
        os.symlink(outside, self.root / "nix/linked")
        self.boot("devbox")
        self.boot("ci")
        self.assertFalse(os.path.lexists(self.root / "nix/linked"))
        self.assertEqual((outside / "keep").read_text(), "not the node's")

    def test_a_failed_wipe_keeps_the_old_record_so_the_next_boot_retries(self):
        self.boot("devbox")
        real = node_state.remove

        def flaky(path):
            if path.name == "devbox":
                raise OSError(16, "Device or resource busy")
            real(path)

        node_state.remove = flaky
        try:
            self.assertEqual(self.boot("ci"), 1)
        finally:
            node_state.remove = real
        self.assertEqual((self.root / "nix/fleet-state/role-epoch").read_text(), "role=devbox\n")
        self.assertEqual(self.boot("ci"), 0)
        self.assertEqual(self.present(CACHE_FILES), set())

    def test_a_root_without_a_nix_store_is_never_touched(self):
        for directory in ("nix/store/abc-system", "nix/store"):
            (self.root / directory).rmdir()
        (self.root / "nix/fleet-state/role-epoch").write_text("role=devbox\n")
        with self.assertRaises(SystemExit):
            self.boot("ci")
        self.assertEqual(self.present(CACHE_FILES), set(CACHE_FILES))

    def test_show_lists_what_a_role_change_would_wipe(self):
        self.assertEqual(node_state.show(str(self.root)), 0)

    def test_cache_is_everything_not_declared(self):
        names = {str(path.relative_to(self.root)) for path in node_state.cache_entries(self.root / "nix")}
        self.assertEqual(names, {"nix/devbox", "nix/ci-cache", "nix/ci-state", "nix/fleet-code", "nix/something-new",
                                 "nix/fleet-state/devbox", "nix/fleet-state/config.json"})


if __name__ == "__main__":
    unittest.main()
