"""Optional wrapped-key policies must never permit unwrapped shared keys."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class PolicyTest(unittest.TestCase):
    """An explicit optional key transfer must require response wrapping."""

    def test_policy_demands_a_wrapped_read_of_the_fleet_keys_only(self):
        policy = (ROOT / "examples" / "vault" / "fleet-enroll.hcl").read_text()
        self.assertIn('path "secret/data/fleet/+"', policy)
        self.assertIn('capabilities     = ["read"]', policy)
        self.assertIn("min_wrapping_ttl", policy)
        self.assertNotIn("personal", policy)
        self.assertNotIn('"list"', policy)



if __name__ == "__main__":
    unittest.main()
