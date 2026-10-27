"""The SSH entry point selects native OMP arguments without shell evaluation."""
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("coding_ssh", Path(__file__).parents[1] / "scripts/coding_ssh.py")
coding_ssh = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(coding_ssh)


class OmpEntryTests(unittest.TestCase):
    def test_interactive_connections_share_the_persistent_conversation(self):
        self.assertEqual(coding_ssh.request("", "/nix/store/omp-launcher"),
                         ["tmux", "new-session", "-A", "-s", "coding", "/nix/store/omp-launcher", "--continue"])

    def test_native_omp_automation_arguments_are_preserved(self):
        for name in ("omp", "fleet-code"):
            self.assertEqual(coding_ssh.request(f'{name} --mode rpc --model "openai-codex/example"', "/entry"),
                             ["/entry", "--mode", "rpc", "--model", "openai-codex/example"])

    def test_task_text_is_literal_data_even_when_it_looks_like_a_shell(self):
        self.assertEqual(coding_ssh.request("omp --print 'Explain $(whoami); `id`'", "/entry"),
                         ["/entry", "--print", "Explain $(whoami); `id`"])

    def test_other_commands_and_invalid_quoting_are_refused(self):
        for command in ("pi --print", "sh", "scp -t file", "internal-sftp", "'", " ; whoami"):
            with self.assertRaises(ValueError, msg=command):
                coding_ssh.request(command, "/entry")


if __name__ == "__main__":
    unittest.main()
