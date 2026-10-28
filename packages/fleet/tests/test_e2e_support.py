"""Controller readiness must include lines already buffered by the text reader."""
import io
from types import SimpleNamespace
import unittest

from e2e_support import Stack


class StackReadinessTests(unittest.TestCase):
    def test_log_and_readiness_buffered_together_are_both_consumed(self):
        stack = Stack.__new__(Stack)
        stack.output = []
        stack.process = SimpleNamespace(stdout=io.StringIO(
            '{"msg":"listening"}\n{"controllerUrl":"http://127.0.0.1:1234"}\n'))
        self.assertEqual(stack._wait_for_ready(), {"controllerUrl": "http://127.0.0.1:1234"})
        self.assertEqual(len(stack.output), 2)
