"""Exercise the actual release packager and both download clients with split assets."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "wizard"))
import bootstrap  # noqa: E402,F401
import decide  # noqa: E402
import imaging  # noqa: E402
import iso_fixture

spec = importlib.util.spec_from_file_location("release_image", ROOT / "scripts/release-image.py")
release_image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_image)


class ReleaseImageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "source.iso"
        tree = iso_fixture.installer_tree()
        tree['fleet-readiness.json'] = json.dumps({'version': 1, 'roles': {role: {'blocked': []} for role in decide.ROLES}}).encode()
        image = iso_fixture.build(tree).ljust(98304, b'x')
        self.source.write_bytes(image)
        self.release = self.root / "release"
        self.manifest = release_image.package_image(self.source, self.release, 20000)
        self.url = (self.release / "fleet-installer.iso").as_uri()
        self.dest = self.root / "download.iso"

    def test_packaging_boundaries_and_full_checksum(self):
        self.assertEqual([part["size"] for part in self.manifest["parts"]], [20000] * 4 + [18304])
        self.assertEqual(self.manifest["sha256"], decide.file_sha256(self.source))
        self.assertEqual(release_image.PART_SIZE, 1024 ** 3)
        self.assertEqual(json.loads((self.release / 'fleet-installer.readiness.json').read_text())['imageSha256'], self.manifest['sha256'])
        for bad in (0, -1, 2 * 1024 ** 3):
            with self.assertRaises(ValueError):
                release_image.package_image(self.source, self.release, bad)

    def test_unbootable_images_are_refused_before_creating_release_assets(self):
        paths = [
            ('boot', 'nix', 'store', iso_fixture.KERNEL_STORE, 'bzImage'),
            ('boot', 'nix', 'store', iso_fixture.INITRD_STORE, 'initrd'),
            ('EFI', 'BOOT', 'BOOTX64.EFI'),
            ('EFI', 'nixos-installer-image'),
        ]
        for path in paths:
            for replacement in (None, b''):
                # The marker is deliberately an empty file in real NixOS ISOs.
                if path[-1] == 'nixos-installer-image' and replacement == b'':
                    continue
                with self.subTest(path=path, replacement=replacement):
                    tree = iso_fixture.installer_tree()
                    tree['fleet-readiness.json'] = b'{"version":1,"roles":{}}'
                    parent = tree
                    for name in path[:-1]:
                        parent = parent[name]
                    if replacement is None:
                        del parent[path[-1]]
                    else:
                        parent[path[-1]] = replacement
                    self.source.write_bytes(iso_fixture.build(tree))
                    output = self.root / 'invalid-release'
                    with self.assertRaises((decide.Invariant, ValueError)):
                        release_image.package_image(self.source, output, 20000)
                    self.assertFalse(output.exists())

    def test_release_requires_a_boot_entry_for_every_role(self):
        for role in decide.ROLES:
            with self.subTest(role=role):
                tree = iso_fixture.installer_tree()
                tree['fleet-readiness.json'] = b'{"version":1,"roles":{}}'
                config = tree['isolinux']['isolinux.cfg']
                tree['isolinux']['isolinux.cfg'] = config.replace(f'fleet.role={role}'.encode(), b'fleet.role=missing')
                self.source.write_bytes(iso_fixture.build(tree))
                with self.assertRaises(decide.Invariant):
                    release_image.validate_image(self.source)

    def test_both_probes_report_the_whole_size(self):
        with mock.patch.dict(os.environ, {"FLEET_INSTALLER_URL": self.url}):
            self.assertEqual(decide.probe_installer(), (None, self.source.stat().st_size))
        self.assertEqual(imaging.probe(self.url), (None, self.source.stat().st_size))

    def test_cli_download_reassembles_parts_and_checks_full_image(self):
        with mock.patch.dict(os.environ, {"FLEET_INSTALLER_URL": self.url,
                                         "FLEET_INSTALLER_SHA256_URL": self.url + ".sha256"}):
            self.assertEqual(decide.fetch_installer(self.dest), 0)
        self.assertEqual(self.dest.read_bytes(), self.source.read_bytes())

    def test_wizard_reassembles_parts_with_whole_image_progress(self):
        progress = []
        imaging.download(self.url, self.dest, self.manifest["sha256"], lambda done, total: progress.append((done, total)))
        self.assertEqual(self.dest.read_bytes(), self.source.read_bytes())
        self.assertEqual(progress[-1], (98304, 98304))
        self.assertEqual(list(self.root.glob("*.partial")), [])

    def test_missing_corrupt_truncated_and_oversized_parts_preserve_destination(self):
        part = self.release / self.manifest["parts"][1]["name"]
        original = part.read_bytes()
        for replacement in (None, original[:-1], b"z" * len(original), original + b"x"):
            with self.subTest(replacement=None if replacement is None else len(replacement)):
                if replacement is None:
                    part.unlink()
                else:
                    part.write_bytes(replacement)
                self.dest.write_bytes(b"previous verified image")
                with self.assertRaises((RuntimeError, decide.Invariant)):
                    imaging.download(self.url, self.dest, self.manifest["sha256"])
                self.assertEqual(self.dest.read_bytes(), b"previous verified image")
                self.assertEqual(list(self.root.glob("*.partial")), [])
                part.write_bytes(original)

    def test_cancellation_between_parts_cleans_up(self):
        written = []
        with self.assertRaises(imaging.Cancelled):
            imaging.download(self.url, self.dest, self.manifest["sha256"],
                             lambda done, total: written.append(done), cancel=lambda: bool(written))
        self.assertFalse(self.dest.exists())
        self.assertEqual(list(self.root.glob("*.partial")), [])

    def test_manifest_cannot_redirect_to_another_release_or_path(self):
        path = self.release / "fleet-installer.iso.parts.json"
        for name in ("../secret", "https://example.com/image", "fleet-installer.iso.part-999"):
            self.manifest["parts"][0]["name"] = name
            path.write_text(json.dumps(self.manifest))
            with self.assertRaises(decide.Invariant):
                imaging.download(self.url, self.dest, self.manifest["sha256"])
            self.assertFalse(self.dest.exists())
            self.assertEqual(list(self.root.glob("*.partial")), [])

    def test_full_checksum_remains_authoritative_during_release_replacement(self):
        with self.assertRaises(decide.Invariant):
            imaging.download(self.url, self.dest, "0" * 64)
        self.assertFalse(self.dest.exists())


if __name__ == "__main__":
    unittest.main()
