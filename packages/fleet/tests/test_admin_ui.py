"""Portable admin assets ship offline without changing installer authority."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AdminUiTests(unittest.TestCase):
    def test_installer_assets_are_local_and_themed(self):
        page = (ROOT / 'wizard' / 'index.html').read_text()
        self.assertIn('src="/theme.js"', page)
        self.assertIn('href="/admin.css"', page)
        self.assertIn('id="admin-theme"', page)
        self.assertIn('aria-label="Color theme"', page)
        self.assertIn('aria-label="Installation progress"', page)
        self.assertNotIn('https://cdn.', page)
        css = (ROOT / 'wizard' / 'admin.css').read_text()
        self.assertIn('prefers-reduced-motion', css)
        self.assertIn('light-dark(', css)

    def test_setup_screens_escape_titles_and_use_the_same_assets(self):
        spec = importlib.util.spec_from_file_location('setup_admin_ui', ROOT / 'scripts' / 'setup.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        page = module.admin_page('<unsafe>', '<p>Safe content</p>').decode()
        self.assertIn('&lt;unsafe&gt;', page)
        self.assertNotIn('<unsafe>', page)
        self.assertIn('workspace-admin-color-scheme', page)
        self.assertIn('id="admin-theme"', page)
        self.assertIn('Safe content', page)

    def test_every_installer_distribution_includes_styles_and_theme(self):
        for filename in ['wizard/build.py', 'modules/installer-package.nix']:
            source = (ROOT / filename).read_text()
            self.assertIn('admin.css', source)
            self.assertIn('theme.js', source)
