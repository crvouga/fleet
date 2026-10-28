"""Static guard for runner resource control (no Nix evaluation happens here).

The `nix flake check` VM tests are the real proof; this keeps the declared
controls from being dropped silently on machines without Nix.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def balanced(text):
    """Braces, brackets and parentheses outside strings and comments nest correctly."""
    text = re.sub(r"''.*?''", "", text, flags=re.S)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '""', text)
    text = re.sub(r"#[^\n]*", "", text)
    stack = []
    pairs = {")": "(", "]": "[", "}": "{"}
    for char in text:
        if char in "([{":
            stack.append(char)
        elif char in pairs:
            if not stack or stack.pop() != pairs[char]:
                return False
    return not stack


class RunnerResourceControlTest(unittest.TestCase):
    def setUp(self):
        self.runners = (ROOT / "modules/runners.nix").read_text()
        self.agent = (ROOT / "modules/agent.nix").read_text()

    def test_every_slot_joins_one_capped_slice(self):
        self.assertIn('Slice = "fleet-ci.slice";', self.runners)
        slice_block = self.runners.split("systemd.slices.fleet-ci", 1)[1].split("systemd.services", 1)[0]
        for key in ("MemoryHigh", "MemoryMax", "MemoryAccounting", "CPUAccounting", "IOAccounting"):
            self.assertIn(key, slice_block)
        high, maximum = (int(n) for n in re.findall(r'Memory(?:High|Max) = "(\d+)%"', slice_block))
        self.assertLess(high, maximum)
        self.assertLess(maximum, 100, "headroom must remain for the agent and the system")

    def test_ci_jobs_are_sacrificed_before_the_agent(self):
        slot = int(re.search(r"OOMScoreAdjust = (-?\d+);", self.runners).group(1))
        agent = int(re.search(r"OOMScoreAdjust = (-?\d+);", self.agent).group(1))
        self.assertGreater(slot, 0)
        self.assertLess(agent, 0)

    def test_fair_sharing_and_task_limit_are_declared(self):
        for key in ("CPUWeight", "IOWeight", "TasksMax"):
            self.assertRegex(self.runners, rf"{key} = \d+;")

    def test_edited_modules_still_nest_correctly(self):
        self.assertTrue(balanced(self.runners))
        self.assertTrue(balanced(self.agent))


if __name__ == "__main__":
    unittest.main()
